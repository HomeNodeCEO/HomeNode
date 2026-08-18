import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import {
  createInspectionSession,
  createReportFile,
  listReportFiles,
} from "../src/modules/mobile/reportFiles.js";
import { getMobileProperty, searchMobileProperties } from "../src/modules/mobile/properties.js";

const databaseUrl = process.env.DATABASE_URL;

test("mobile report files preserve prior versions and allocate separate workflow sequences", {
  skip: !databaseUrl,
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const organizationId = randomUUID();
  const userId = randomUUID();
  const accountId = `mobile-${randomUUID()}`;
  const auth = {
    userId,
    organizations: [{ organizationId, roles: ["appraiser"] }],
  };
  try {
    await pool.query(
      `INSERT INTO app_auth.organizations (id, legal_name, display_name)
       VALUES ($1, 'HomeNode Mobile Test', 'HomeNode Mobile Test')`,
      [organizationId],
    );
    await pool.query(
      `INSERT INTO app_auth.users (id, email, display_name)
       VALUES ($1, $2, 'Mobile Test Appraiser')`,
      [userId, `${userId}@example.test`],
    );
    await pool.query(
      `INSERT INTO app_auth.organization_memberships (organization_id, user_id, status)
       VALUES ($1, $2, 'active')`,
      [organizationId, userId],
    );
    await pool.query(
      `INSERT INTO app_auth.membership_roles (organization_id, user_id, role_code)
       VALUES ($1, $2, 'appraiser')`,
      [organizationId, userId],
    );
    await pool.query(
      `INSERT INTO core.accounts (account_id, address, city, postal_code)
       VALUES ($1, '100 Test Street', 'Dallas', '75201')`,
      [accountId],
    );
    const legacyAssignment = await pool.query(
      `INSERT INTO app.assignment_files (account_id, file_number, assignment_details)
       VALUES ($1, $2, '{"client_name":"Legacy preserved client"}'::jsonb)
       RETURNING id`,
      [accountId, `LEGACY-${userId.slice(0, 8)}`],
    );
    const legacyReportFileId = randomUUID();
    await pool.query(
      `INSERT INTO app.report_files (
         id, account_id, workflow_type, file_number, custom_assignment_file_id, is_current
       ) VALUES ($1, $2, 'custom_appraisal', $3, $4, true)`,
      [legacyReportFileId, accountId, `LEGACY-${userId.slice(0, 8)}`, legacyAssignment.rows[0].id],
    );

    const firstCustomRequest = randomUUID();
    const firstCustom = await createReportFile(pool, auth, {
      organization_id: organizationId,
      account_id: accountId,
      workflow_type: "custom_appraisal",
      client_request_id: firstCustomRequest,
    });
    assert.equal(firstCustom.created, true);
    assert.match(firstCustom.reportFile.file_number, /^HN-CA-\d{4}-000001$/);
    assert.equal(firstCustom.reportFile.previous_report_file_id, legacyReportFileId);

    const retried = await createReportFile(pool, auth, {
      organization_id: organizationId,
      account_id: accountId,
      workflow_type: "custom_appraisal",
      client_request_id: firstCustomRequest,
    });
    assert.equal(retried.created, false);
    assert.equal(retried.reportFile.id, firstCustom.reportFile.id);

    await pool.query(
      `UPDATE app.assignment_files
          SET assignment_details = '{"client_name":"Preserved client"}'::jsonb,
              revision = 2,
              updated_at = now()
        WHERE id = $1`,
      [firstCustom.reportFile.target_id],
    );

    const secondCustom = await createReportFile(pool, auth, {
      organization_id: organizationId,
      account_id: accountId,
      workflow_type: "custom_appraisal",
      client_request_id: randomUUID(),
      previous_report_file_id: firstCustom.reportFile.id,
    });
    assert.match(secondCustom.reportFile.file_number, /^HN-CA-\d{4}-000002$/);
    assert.equal(secondCustom.reportFile.previous_report_file_id, firstCustom.reportFile.id);

    const uad = await createReportFile(pool, auth, {
      organization_id: organizationId,
      account_id: accountId,
      workflow_type: "uad_3_6",
      client_request_id: randomUUID(),
    });
    const tax = await createReportFile(pool, auth, {
      organization_id: organizationId,
      account_id: accountId,
      workflow_type: "property_tax_protest",
      client_request_id: randomUUID(),
    });
    assert.match(uad.reportFile.file_number, /^HN-UAD-\d{4}-000001$/);
    assert.match(tax.reportFile.file_number, /^HN-PTP-\d{4}-000001$/);

    const uadFoundation = await pool.query(
      `SELECT
         (SELECT count(*) FROM appraisal.uad_subject_snapshots WHERE workfile_id = $1) AS snapshots,
         (SELECT count(*) FROM appraisal.uad_entities WHERE workfile_id = $1) AS entities,
         (SELECT count(*) FROM appraisal.uad_revisions WHERE workfile_id = $1) AS revisions,
         (SELECT count(*) FROM appraisal.uad_audit_events WHERE workfile_id = $1) AS events`,
      [uad.reportFile.target_id],
    );
    assert.equal(Number(uadFoundation.rows[0].snapshots), 1);
    assert.ok(Number(uadFoundation.rows[0].entities) >= 4);
    assert.equal(Number(uadFoundation.rows[0].revisions), 1);
    assert.ok(Number(uadFoundation.rows[0].events) >= 1);

    const discovery = await listReportFiles(pool, auth, { accountId });
    assert.equal(discovery.files.length, 5);
    assert.equal(discovery.recentlyCreated, true);
    assert.ok(discovery.files.some((file) => file.id === firstCustom.reportFile.id && !file.is_current));
    assert.ok(discovery.files.some((file) => file.id === secondCustom.reportFile.id && file.is_current));

    const search = await searchMobileProperties(pool, auth, { query: "100 Test" });
    assert.equal(search.results.length, 1);
    assert.equal(search.results[0].account_id, accountId);
    assert.equal(search.results[0].workflows.custom_appraisal.count, 3);
    assert.equal(search.results[0].workflows.uad_3_6.count, 1);
    assert.equal(search.results[0].workflows.property_tax_protest.count, 1);

    const selected = await getMobileProperty(pool, auth, accountId);
    assert.equal(selected.property.address, "100 Test Street");
    assert.equal(selected.files.length, 5);

    const session = await createInspectionSession(pool, auth, {
      report_file_id: secondCustom.reportFile.id,
    });
    const retriedSession = await createInspectionSession(pool, auth, {
      report_file_id: secondCustom.reportFile.id,
    });
    assert.equal(session.created, true);
    assert.equal(retriedSession.created, false);
    assert.equal(retriedSession.session.id, session.session.id);

    const lineage = await pool.query(
      `SELECT prior.is_current AS prior_current,
              current.previous_report_file_id,
              assignment.inherited_from_file_id,
              assignment.assignment_details,
              prior_assignment.assignment_details AS prior_assignment_details
         FROM app.report_files current
         JOIN app.report_files prior ON prior.id = current.previous_report_file_id
         JOIN app.assignment_files assignment ON assignment.id = current.custom_assignment_file_id
         JOIN app.assignment_files prior_assignment ON prior_assignment.id = prior.custom_assignment_file_id
        WHERE current.id = $1`,
      [secondCustom.reportFile.id],
    );
    assert.equal(lineage.rows[0].prior_current, false);
    assert.equal(lineage.rows[0].previous_report_file_id, firstCustom.reportFile.id);
    assert.equal(String(lineage.rows[0].inherited_from_file_id), firstCustom.reportFile.target_id);
    assert.equal(lineage.rows[0].assignment_details.client_name, "Preserved client");
    assert.equal(lineage.rows[0].prior_assignment_details.client_name, "Preserved client");
  } finally {
    await pool.end();
  }
});
