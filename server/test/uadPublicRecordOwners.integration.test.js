import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import { createUadWorkfile } from "../src/modules/uad/workfiles.js";

const databaseUrl = process.env.DATABASE_URL;

async function cleanup(pool, accountId) {
  await pool.query(
    `UPDATE app.report_files
        SET subject_snapshot_id = NULL, previous_report_file_id = NULL
      WHERE account_id = $1`,
    [accountId],
  );
  await pool.query(
    `DELETE FROM app.appraisal_subject_snapshots
      WHERE appraisal_case_id IN (SELECT id FROM app.appraisal_cases WHERE account_id = $1)`,
    [accountId],
  );
  await pool.query("DELETE FROM app.report_files WHERE account_id = $1", [accountId]);
  await pool.query("DELETE FROM app.appraisal_cases WHERE account_id = $1", [accountId]);
  await pool.query("DELETE FROM appraisal.uad_workfiles WHERE account_id = $1", [accountId]);
  await pool.query("DELETE FROM core.owner_parties WHERE account_id = $1", [accountId]);
  await pool.query("DELETE FROM core.owner_summary WHERE account_id = $1", [accountId]);
  await pool.query("DELETE FROM core.primary_improvements WHERE account_id = $1", [accountId]);
  await pool.query("DELETE FROM core.accounts WHERE account_id = $1", [accountId]);
}

test("new UAD workfiles snapshot and prefill current public-record owners", {
  skip: !databaseUrl,
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const accountId = `97${String(Date.now()).slice(-15)}`;
  try {
    await pool.query(
      `INSERT INTO core.accounts (account_id, county, address, city, postal_code, legal_description)
       VALUES ($1, 'Test County', '1909 Owner Test Lane', 'Garland', '75044', 'LOT 1 BLOCK A')`,
      [accountId],
    );
    await pool.query(
      `INSERT INTO core.primary_improvements (
         account_id, year_built, living_area_sqft, bedroom_count, bath_count, number_units
       ) VALUES ($1, 2001, 1800, 3, 2, 1)`,
      [accountId],
    );
    await pool.query(
      `INSERT INTO core.owner_summary (account_id, tax_year, owner_name, mailing_address)
       VALUES ($1, 2026, 'PATTERSON GREGORY SCOTT & GINA R PATTERSON', '1909 Owner Test Lane')`,
      [accountId],
    );
    await pool.query(
      `INSERT INTO core.owner_parties (account_id, tax_year, owner_name, ownership_pct)
       VALUES ($1, 2026, 'PATTERSON GREGORY SCOTT', 50),
              ($1, 2026, 'GINA R PATTERSON', 50)`,
      [accountId],
    );

    const workfile = await createUadWorkfile(pool, accountId, {
      file_number: `UAD-OWNER-INT-${Date.now()}`,
    });
    const snapshot = await pool.query(
      `SELECT subject_data
         FROM appraisal.uad_subject_snapshots
        WHERE workfile_id = $1
        ORDER BY snapshot_version DESC
        LIMIT 1`,
      [workfile.id],
    );
    assert.equal(snapshot.rows[0].subject_data.owner_summary.owner_name, "PATTERSON GREGORY SCOTT & GINA R PATTERSON");
    assert.equal(snapshot.rows[0].subject_data.owner_parties.length, 2);

    const owners = await pool.query(
      `SELECT entity.id, entity.label, entity.ordinal, value.uad_uid, value.value,
              value.source_type, value.is_appraiser_confirmed
         FROM appraisal.uad_entities entity
         JOIN appraisal.uad_field_values value ON value.entity_id = entity.id
        WHERE entity.workfile_id = $1
          AND entity.entity_type = 'assignment_owner'
        ORDER BY entity.ordinal, value.uad_uid`,
      [workfile.id],
    );
    assert.equal(new Set(owners.rows.map((row) => row.id)).size, 2);
    assert.ok(owners.rows.every((row) => row.source_type === "public_record"));
    assert.ok(owners.rows.every((row) => row.is_appraiser_confirmed === false));
    assert.equal(
      owners.rows.find((row) => row.ordinal === 1 && row.uad_uid === "1000.0023")?.value,
      "PATTERSON",
    );
    assert.equal(
      owners.rows.find((row) => row.ordinal === 2 && row.uad_uid === "1000.0022")?.value,
      "GINA",
    );
  } finally {
    await cleanup(pool, accountId).catch(() => {});
    await pool.end();
  }
});

