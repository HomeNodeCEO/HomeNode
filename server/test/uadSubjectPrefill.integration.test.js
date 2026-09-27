import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { createUadWorkfile } from "../src/modules/uad/workfiles.js";
import { prefillUadSubject } from "../src/modules/uad/subjectPrefill.js";

test("native subject prefill: creation, retained sources, concurrent idempotency, and appraiser ownership", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  const accountId = `UAD-PREFILL-${randomUUID()}`;
  let workfileId;
  try {
    const identity = await pool.query("SELECT current_database() AS name");
    assert.match(identity.rows[0].name, /_test$/, "Use an isolated synthetic database only");
    await pool.query(`INSERT INTO core.accounts (account_id, county, address, city, postal_code, legal_description)
      VALUES ($1, 'Dallas', '100 Test Lane', 'Garland', '75044', 'LOT 1 BLOCK A')`, [accountId]);
    await pool.query(`INSERT INTO core.primary_improvements
      (account_id, year_built, living_area_sqft, bedroom_count, bath_count, number_units)
      VALUES ($1, 2001, 1850, 3, 2.1, 1)`, [accountId]);
    await pool.query(`INSERT INTO core.land_detail (account_id, tax_year, line_number, area_sqft)
      VALUES ($1, 2025, 1, 99999), ($1, 2026, 1, 7000), ($1, 2026, 2, 500)`, [accountId]);
    const workfile = await createUadWorkfile(pool, accountId, { file_number: accountId });
    workfileId = workfile.id;
    const fields = () => pool.query("SELECT * FROM appraisal.uad_field_values WHERE workfile_id = $1", [workfileId]);
    let saved = (await fields()).rows;
    assert.equal(saved.find((r) => r.field_context === "unit" && r.uad_uid === "0700.0118").value, 3);
    assert.deepEqual(saved.find((r) => r.field_context === "site" && r.uad_uid === "1500.0093").value, { amount: 7500, unit: "SquareFeet" });
    assert.equal(saved.filter((r) => r.field_context === "site_parcel" && r.uad_uid === "1500.0027").length, 1);
    assert.ok(saved.every((r) => r.is_appraiser_confirmed === false));
    assert.equal(saved.some((r) => r.uad_uid === "0700.0140"), false, "CAD area is not ANSI above-grade area");

    // Emulate a pre-feature draft by removing only the synthetic room field.
    await pool.query("DELETE FROM appraisal.uad_field_values WHERE workfile_id = $1 AND field_context = 'unit' AND uad_uid = '0700.0118'", [workfileId]);
    await pool.query("UPDATE core.primary_improvements SET bedroom_count = 9 WHERE account_id = $1", [accountId]);
    const results = await Promise.all(Array.from({ length: 5 }, () => prefillUadSubject(pool, workfileId, null)));
    assert.equal(results.reduce((n, result) => n + result.changed_field_count, 0), 1);
    assert.ok(results.every((result) => result.current_revision === 2));
    saved = (await fields()).rows;
    const bedrooms = saved.find((r) => r.field_context === "unit" && r.uad_uid === "0700.0118");
    assert.equal(bedrooms.value, 3, "Retained snapshot wins over today's changed public record");
    assert.equal(bedrooms.is_appraiser_confirmed, false);
    assert.equal(bedrooms.source_reference, "subject_snapshot.primary_improvements.bedroom_count");
    const audit = await pool.query("SELECT * FROM appraisal.uad_audit_events WHERE workfile_id = $1 AND event_type = 'uad_subject.prefilled'", [workfileId]);
    assert.equal(audit.rows.length, 1);
    const revisions = await pool.query("SELECT document FROM appraisal.uad_revisions WHERE workfile_id = $1 ORDER BY revision_number", [workfileId]);
    assert.equal(revisions.rows.length, 2);
    assert.ok(revisions.rows[1].document.field_values.some((value) => value.uid === "0700.0118" && value.value === 3));

    const writer = await pool.connect();
    let pending;
    try {
      await writer.query("BEGIN");
      await writer.query("SELECT id FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE", [workfileId]);
      pending = prefillUadSubject(pool, workfileId, null);
      // Attach a handler immediately even if the test's writer fails.
      pending.catch(() => {});
      await writer.query(`UPDATE appraisal.uad_field_values SET value = 'null'::jsonb,
        source_type = 'appraiser', is_appraiser_confirmed = true WHERE id = $1`, [bedrooms.id]);
      await writer.query("COMMIT");
    } catch (error) {
      await writer.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      writer.release();
    }
    assert.equal((await pending).changed_field_count, 0);
    const preserved = (await fields()).rows.find((r) => r.id === bedrooms.id);
    assert.equal(preserved.value, null);
    assert.equal(preserved.source_type, "appraiser");
    assert.equal(preserved.is_appraiser_confirmed, true);
  } finally {
    try {
      const history = await pool.query("SELECT to_regclass('app.report_files') AS table_name");
      if (workfileId && history.rows[0].table_name) {
        await pool.query("UPDATE app.report_files SET subject_snapshot_id = NULL, previous_report_file_id = NULL WHERE account_id = $1", [accountId]);
        await pool.query("DELETE FROM app.appraisal_subject_snapshots WHERE appraisal_case_id IN (SELECT id FROM app.appraisal_cases WHERE account_id = $1)", [accountId]);
        await pool.query("DELETE FROM app.report_files WHERE account_id = $1", [accountId]);
        await pool.query("DELETE FROM app.appraisal_cases WHERE account_id = $1", [accountId]);
      }
      if (workfileId) await pool.query("DELETE FROM appraisal.uad_workfiles WHERE id = $1", [workfileId]);
      await pool.query("DELETE FROM core.land_detail WHERE account_id = $1", [accountId]);
      await pool.query("DELETE FROM core.primary_improvements WHERE account_id = $1", [accountId]);
      await pool.query("DELETE FROM core.accounts WHERE account_id = $1", [accountId]);
    } finally { await pool.end(); }
  }
});
