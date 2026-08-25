import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import pg from "pg";

import { applyUadCompletionSuggestions } from "../src/modules/uad/completionApply.js";
import { loadUadCompletionSuggestions } from "../src/modules/uad/completionSuggestions.js";
import { createUadWorkfile } from "../src/modules/uad/workfiles.js";
import { customAppraisalReportFixture } from "./fixtures/customAppraisalReportFixture.js";

const databaseUrl = process.env.DATABASE_URL;

test("reviewed Custom Appraisal suggestions apply atomically to a real UAD database", {
  skip: !databaseUrl,
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
  const accountId = `99${String(Date.now()).slice(-15)}`;
  try {
    await pool.query(
      `INSERT INTO core.accounts (
         account_id, county, address, city, postal_code, neighborhood_code,
         subdivision, legal_description
       ) VALUES ($1, 'Test County', '100 Integration Way', 'Garland', '75044',
         'TEST-1', 'Integration Addition', 'LOT 1 BLOCK A')`,
      [accountId],
    );
    await pool.query(
      `INSERT INTO core.primary_improvements (
         account_id, year_built, living_area_sqft, bedroom_count, bath_count, number_units
       ) VALUES ($1, 2001, 1800, 3, 2, 1)`,
      [accountId],
    );

    const workfile = await createUadWorkfile(pool, accountId, {
      file_number: `UAD-INT-${Date.now()}`,
      assignment_purpose: "Purchase",
    });
    const uadReport = await pool.query(
      `SELECT id, appraisal_case_id, subject_snapshot_id
         FROM app.report_files
        WHERE uad_workfile_id = $1`,
      [workfile.id],
    );
    assert.ok(uadReport.rows[0]?.appraisal_case_id);
    assert.ok(uadReport.rows[0]?.subject_snapshot_id);

    const assignment = await pool.query(
      `INSERT INTO app.assignment_files (account_id, file_number, assignment_details)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id`,
      [
        accountId,
        `CUSTOM-INT-${Date.now()}`,
        JSON.stringify({ assignment_types: ["purchase_transaction"] }),
      ],
    );
    const assignmentId = assignment.rows[0].id;
    await pool.query(
      `INSERT INTO app.custom_appraisal_workfiles (assignment_file_id, canonical_file_name)
       VALUES ($1, $2)`,
      [assignmentId, `integration-${assignmentId}.homenode-appraisal.json`],
    );

    const customReportId = randomUUID();
    await pool.query(
      `INSERT INTO app.report_files (
         id, account_id, workflow_type, file_number, custom_assignment_file_id,
         is_current, registry_revision, appraisal_case_id, subject_snapshot_id
       ) VALUES ($1, $2, 'custom_appraisal', $3, $4, true, 1, $5, $6)`,
      [
        customReportId,
        accountId,
        `CUSTOM-INT-${assignmentId}`,
        assignmentId,
        uadReport.rows[0].appraisal_case_id,
        uadReport.rows[0].subject_snapshot_id,
      ],
    );

    const fixture = customAppraisalReportFixture();
    for (const [sectionKey, section] of Object.entries(fixture.snapshot.sections)) {
      await pool.query(
        `INSERT INTO app.custom_appraisal_workfile_sections (
           assignment_file_id, section_key, section_value, revision
         ) VALUES ($1, $2, $3::jsonb, $4)`,
        [assignmentId, sectionKey, JSON.stringify(section.value), section.revision],
      );
    }

    const suggestions = await loadUadCompletionSuggestions(pool, workfile.id);
    const selected = suggestions.suggestions.sales_comparison_fields.find((item) => (
      item.field_key === "sales_comparison_summary:1300.0006"
    ));
    assert.ok(selected);
    const result = await applyUadCompletionSuggestions(pool, workfile.id, {
      selected_suggestion_ids: [selected.suggestion_id],
      expected_source_digest_sha256: suggestions.source_completion.source_digest_sha256,
      expected_adapter_version: suggestions.adapter_version,
      expected_revision: 1,
      preserve_existing: true,
      confirmed: true,
    });

    assert.equal(result.current_revision, 2);
    assert.equal(result.applied_suggestion_count, 1);
    const saved = await pool.query(
      `SELECT value, source_type, is_appraiser_confirmed
         FROM appraisal.uad_field_values
        WHERE workfile_id = $1
          AND field_context = 'sales_comparison_summary'
          AND uad_uid = '1300.0006'`,
      [workfile.id],
    );
    assert.deepEqual(saved.rows[0], {
      value: 302000,
      source_type: "homenode",
      is_appraiser_confirmed: true,
    });
    const audit = await pool.query(
      `SELECT count(*)::integer AS count
         FROM appraisal.uad_audit_events
        WHERE workfile_id = $1
          AND event_type = 'uad_completion_suggestions.applied'`,
      [workfile.id],
    );
    assert.equal(audit.rows[0].count, 1);
  } finally {
    await pool.end();
  }
});
