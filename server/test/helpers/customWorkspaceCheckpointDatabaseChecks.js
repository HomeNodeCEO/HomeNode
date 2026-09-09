import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { getCustomAppraisalWorkfile, saveCustomAppraisalWorkfileSection,
  saveCustomAppraisalWorkfileSectionInTransaction } from '../../src/services/customAppraisalWorkfiles.js';
import { createCustomCohortContextCapture } from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION, readCustomNeighborhoodWorkspaceCheckpoint }
  from '../../src/services/neighborhoodAssessment/customWorkspaceCheckpoint.js';
import { checkedNeighborhoodDatabaseUrl, NEIGHBORHOOD_CI_IDENTITY_SQL, verifyNeighborhoodCiConnection }
  from './neighborhoodCiDatabase.js';

/** Run only after the real context-capture helper in its newly created migrated
 * disposable test database. Reuses that exact synthetic assignment, never a
 * latest-account/context fallback. This helper does not create/drop databases,
 * change schemas, grant production policy, sign a PDF or control any service.
 * The normal generic writer's existing schema preparation is left intact.
 */
export async function runCustomWorkspaceCheckpointDatabaseChecks(connectionString) {
  const database = checkedNeighborhoodDatabaseUrl(connectionString, process.env.NODE_ENV);
  const require = createRequire(import.meta.url), pg = require('pg');
  const pool = new pg.Pool({ connectionString: database.connectionString, max: 4, connectionTimeoutMillis: 3000,
    statement_timeout: 8000, application_name: 'custom_workspace_checkpoint_native_test' });
  const checks = [], calls = [];
  const record = statement => calls.push(typeof statement === 'string' ? statement : statement.text);
  const observed = {
    query(statement, values) { record(statement); return pool.query(statement, values); },
    async connect() {
      const client = await pool.connect();
      return { query(statement, values) { record(statement); return client.query(statement, values); },
        release(error) { client.release(error); } };
    },
  };
  try {
    const probe = await pool.connect();
    try {
      verifyNeighborhoodCiConnection((await probe.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0],
        probe.connection?.stream?.remoteAddress, database.databaseName);
    } finally { probe.release(); }
    const identity = await pool.query(`SELECT a.id::text AS assignment_file_id, a.account_id, a.organization_id,
      a.assigned_appraiser_user_id AS actor_id, r.id AS report_file_id, r.appraisal_case_id, r.subject_snapshot_id,
      c.effective_date::text, w.status, w.signed_at::text
      FROM app.assignment_files a
      JOIN app.report_files r ON r.custom_assignment_file_id=a.id AND r.account_id=a.account_id AND r.organization_id=a.organization_id
        AND r.workflow_type='custom_appraisal' AND r.uad_workfile_id IS NULL AND r.tax_protest_file_id IS NULL
      JOIN app.custom_appraisal_workfiles w ON w.assignment_file_id=a.id
      JOIN app.appraisal_cases c ON c.id=r.appraisal_case_id AND c.account_id=a.account_id AND c.organization_id=a.organization_id
      JOIN app_auth.organizations o ON o.id=a.organization_id
      JOIN app_auth.users u ON u.id=a.created_by_user_id AND u.id=a.assigned_appraiser_user_id
      WHERE a.account_id=$1 AND o.legal_name=$2 AND u.display_name=$3`,
    ['CAPTURE-COORD-SUBJECT', 'Synthetic Custom capture', 'Synthetic capture actor']);
    assert.equal(identity.rowCount, 1, 'requires the exact preceding native synthetic fixture, not arbitrary/latest data');
    const fixture = identity.rows[0];
    assert.equal(fixture.status, 'draft'); assert.equal(fixture.signed_at, null);
    assert.equal(fixture.effective_date, '2024-06-30');
    const target = { accountId: fixture.account_id, assignmentFileId: fixture.assignment_file_id };
    const auth = { userId: fixture.actor_id, organizations: [{ organizationId: fixture.organization_id, roles: ['appraiser'] }] };
    const period = { start_date: '2023-07-01', end_date: fixture.effective_date };
    const operationId = randomUUID();
    const writerInput = (value, expectedRevision, saveReason = 'autosave') => ({ ...target,
      sectionKey: CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION, sectionValue: value,
      expectedRevision, saveReason, reviewer: 'Synthetic native checkpoint reviewer' });
    const save = (value, revision, reason) => saveCustomAppraisalWorkfileSection(observed, writerInput(value, revision, reason));
    // The real route serializes PG Date instances to ISO strings. Rehearse that
    // existing JSON wire envelope rather than mislabel raw driver rows as HTTP.
    const reopen = async () => JSON.parse(JSON.stringify(await getCustomAppraisalWorkfile(observed, target)));
    const section = async () => (await reopen()).sections[CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION];
    const history = async () => (await pool.query(`SELECT revision, section_value, event_type, changed_by
      FROM app.custom_appraisal_workfile_section_history WHERE assignment_file_id=$1 AND section_key=$2 ORDER BY revision`,
    [target.assignmentFileId, CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION])).rows;
    const protectedState = async () => {
      const [sections, histories, acceptances, signatures, report] = await Promise.all([
        pool.query(`SELECT to_jsonb(s) AS value FROM app.custom_appraisal_workfile_sections s
          WHERE assignment_file_id=$1 AND section_key<>$2 ORDER BY section_key`, [target.assignmentFileId, CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION]),
        pool.query(`SELECT to_jsonb(h) AS value FROM app.custom_appraisal_workfile_section_history h
          WHERE assignment_file_id=$1 AND section_key<>$2 ORDER BY id`, [target.assignmentFileId, CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION]),
        pool.query('SELECT to_jsonb(a) AS value FROM app.custom_neighborhood_acceptances a WHERE assignment_file_id=$1 ORDER BY id', [target.assignmentFileId]),
        pool.query('SELECT to_jsonb(s) AS value FROM app.custom_appraisal_signed_snapshots s WHERE assignment_file_id=$1 ORDER BY id', [target.assignmentFileId]),
        pool.query('SELECT to_jsonb(r) AS value FROM app.report_files r WHERE id=$1', [fixture.report_file_id]),
      ]);
      return { sections: sections.rows, histories: histories.rows, acceptances: acceptances.rows,
        signatures: signatures.rows, report: report.rows };
    };
    const before = await protectedState();
    assert.equal(before.acceptances.length, 0, 'preceding synthetic fixture intentionally has no report acceptance');
    assert.equal(before.signatures.length, 0);
    assert.equal(await section(), undefined, 'checkpoint must not preexist in a fresh native fixture');
    const pending = { workspace_version: 1, active: null, pending_capture: { operation_id: operationId, observation_period: period } };
    const pendingSaved = await save(pending, 0, 'manual_save');
    assert.equal(pendingSaved.revision, 1);
    const restoredPending = readCustomNeighborhoodWorkspaceCheckpoint(await section());
    assert.equal(restoredPending.status, 'restored'); assert.equal(restoredPending.section_revision, 1);
    assert.deepEqual(restoredPending.checkpoint, pending);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM app.neighborhood_custom_cohort_contexts WHERE context_id=$1', [operationId])).rows[0].count, 0,
      'pending intent committed and reopened before any capture registration');
    checks.push('actual generic COMMIT and separate workfile reopen retain pending UUID/period before capture');

    const policyExposures = [];
    const owner = createCustomCohortContextCapture({ pool: observed,
      authorizeMarketData: async (_client, principal, context, _purpose, options) => {
        assert.equal(principal.userId, fixture.actor_id);
        assert.equal(context.scope.organization_id, fixture.organization_id);
        assert.equal(options.retention, true); policyExposures.push(options.exposure);
        return { allowed: true, decision_id: 'synthetic_native_checkpoint_only', policy_revision: 'synthetic-checkpoint-v1' };
      } });
    const captured = await owner.capture({ ...target, auth, operationId, observationPeriod: period });
    assert.equal(captured.status, 'registered'); assert.equal(captured.reused, false);
    assert.equal(captured.context_ref.context_id, operationId);
    const retry = await owner.capture({ ...target, auth, operationId, observationPeriod: period });
    assert.equal(retry.reused, true); assert.deepEqual(retry.context_ref, captured.context_ref);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM app.neighborhood_custom_cohort_contexts WHERE context_id=$1', [operationId])).rows[0].count, 1);
    const readInput = { ...target, auth, contextRef: captured.context_ref, selection: { revision: 5, pockets: [] } };
    const catalog = await owner.catalog(readInput);
    const groupIds = catalog.catalog.pockets.map(pocket => pocket.id);
    if (catalog.catalog.unassigned.member_count) groupIds.push('discovery:unassigned');
    assert.ok(groupIds.length > 0);
    const active = { workspace_version: 1, pending_capture: null, active: { context_ref: captured.context_ref,
      observation_period: period, selection: { revision: 5, included_recorded_group_ids: groupIds } } };
    assert.equal((await save(active, 1)).revision, 2);
    const restoredActive = readCustomNeighborhoodWorkspaceCheckpoint(await section());
    assert.equal(restoredActive.status, 'restored'); assert.equal(restoredActive.section_revision, 2);
    assert.deepEqual(restoredActive.checkpoint, active);
    assert.equal(restoredActive.checkpoint.active.selection.revision, 5, 'UI selection and DB section revisions are distinct');
    checks.push('real captured operation replays once and exact context/period/catalog group intent reopens from section revision two');

    const baseline = await owner.present(readInput, { includeMap: false });
    const empty = structuredClone(active);
    empty.active.selection = { revision: 6, included_recorded_group_ids: [] };
    // Fixed old metadata makes the writer's timestamp bump deterministic even
    // on a fast database. These timestamps are not retained material inputs.
    await pool.query("UPDATE app.assignment_files SET updated_at='2001-01-01T00:00:00Z' WHERE id=$1", [target.assignmentFileId]);
    await pool.query("UPDATE app.custom_appraisal_workfiles SET updated_at='2001-01-01T00:00:00Z' WHERE assignment_file_id=$1", [target.assignmentFileId]);
    assert.equal((await save(empty, 2)).revision, 3);
    const restoredEmpty = readCustomNeighborhoodWorkspaceCheckpoint(await section());
    assert.equal(restoredEmpty.status, 'restored'); assert.equal(restoredEmpty.section_revision, 3);
    assert.deepEqual(restoredEmpty.checkpoint.active.selection.included_recorded_group_ids, []);
    const touched = (await pool.query(`SELECT a.updated_at>'2001-01-01T00:00:00Z'::timestamptz AS assignment_touched,
      w.updated_at>'2001-01-01T00:00:00Z'::timestamptz AS workfile_touched FROM app.assignment_files a
      JOIN app.custom_appraisal_workfiles w ON w.assignment_file_id=a.id WHERE a.id=$1`, [target.assignmentFileId])).rows[0];
    assert.deepEqual(touched, { assignment_touched: true, workfile_touched: true });
    const freshFrom = calls.length;
    const afterEmpty = await owner.present({ ...readInput, selection: { revision: 6, pockets: [] } }, { includeMap: false });
    assert.equal(afterEmpty.subject_freshness, 'matched'); assert.equal(afterEmpty.summary.selected.stock.member_count, 0);
    assert.equal(afterEmpty.summary.selected.transactions.member_count, 0);
    assert.deepEqual(afterEmpty.summary.all, baseline.summary.all);
    assert.ok(calls.slice(freshFrom).some(sql => sql.includes('custom-cohort-subject:sections')),
      'the real compareCurrent material read must execute after checkpoint commit');
    assert.ok(!calls.slice(freshFrom).some(sql => /neighborhood-(cache|membership|closure):/.test(sql)),
      'freshness check must not reacquire mutable CAD/MLS observations');
    checks.push('committed empty selection stays empty; assignment/workfile timestamp updates preserve real compareCurrent matched and retained statistics');

    const contenders = [structuredClone(active), structuredClone(empty)];
    contenders[0].active.selection.revision = 7; contenders[1].active.selection.revision = 8;
    const outcomes = await Promise.allSettled(contenders.map(value => save(value, 3)));
    const winning = outcomes.findIndex(result => result.status === 'fulfilled');
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    const losing = outcomes.find(result => result.status === 'rejected').reason;
    assert.equal(losing.message, 'custom_appraisal_section_revision_conflict'); assert.equal(losing.currentRevision, 4);
    const current = await section(); assert.equal(current.revision, 4);
    assert.deepEqual(current.value, contenders[winning]);
    const records = await history();
    assert.deepEqual(records.map(row => row.revision), [1, 2, 3, 4]);
    assert.deepEqual(records.map(row => row.section_value), [pending, active, empty, contenders[winning]]);
    assert.deepEqual(records.map(row => row.event_type), ['manual_save', 'autosave', 'autosave', 'autosave']);
    assert.ok(records.every(row => row.changed_by === 'Synthetic native checkpoint reviewer'));
    checks.push('two actual concurrent generic saves at the same revision yield one COMMIT and one CAS conflict with exact consecutive history');

    const transaction = await observed.connect();
    try {
      await transaction.query('BEGIN');
      const tentative = await saveCustomAppraisalWorkfileSectionInTransaction(transaction, writerInput(empty, 4));
      assert.equal(tentative.revision, 5);
      await transaction.query('ROLLBACK');
    } catch (error) { await transaction.query('ROLLBACK'); throw error; }
    finally { transaction.release(); }
    assert.deepEqual(await section(), current); assert.deepEqual(await history(), records);
    await assert.rejects(saveCustomAppraisalWorkfileSection(observed, { ...writerInput(empty, 4), accountId: 'NOT-THE-SYNTHETIC-ACCOUNT' }), /assignment_file_not_found/);
    await assert.rejects(save({ ...empty, statistics: { median: 1 } }, 4), /invalid_custom_neighborhood_workspace_checkpoint/);
    assert.deepEqual(await section(), current); assert.deepEqual(await history(), records);
    checks.push('caller-owned rollback removes tentative section and history; wrong account and malformed checkpoint produce no durable change');

    assert.deepEqual(await protectedState(), before, 'checkpoint capture/saves cannot create accepted output or alter unrelated report sections/history');
    // Persist a real locked signed workfile state to test the generic writer's
    // existing guard. This is NOT a newly signed snapshot/artifact/HMAC test.
    await pool.query(`UPDATE app.custom_appraisal_workfiles SET status='signed', signed_at=now(),
      signed_by='Synthetic native signed-state guard' WHERE assignment_file_id=$1`, [target.assignmentFileId]);
    await assert.rejects(save(empty, 4), /custom_appraisal_workfile_signed/);
    assert.deepEqual(await section(), current); assert.deepEqual(await history(), records);
    assert.deepEqual(await protectedState(), before);
    assert.equal((await reopen()).status, 'signed');
    assert.ok(policyExposures.includes('report_observation_catalog') && policyExposures.includes('report_observation_summary'));
    checks.push('persisted signed-state guard rejects checkpoint save without history/acceptance/report mutation; no signature artifact was fabricated');
    assert.equal(pool.waitingCount, 0);
    return { checks, fixture: { account_id: target.accountId, assignment_file_id: target.assignmentFileId,
      organization_id: fixture.organization_id, report_file_id: fixture.report_file_id, context_ref: captured.context_ref },
    limitations: ['synthetic source policy only', 'signed state guard only, not signing/artifact generation',
      'acceptance remains absent; does not exercise mutation of an existing accepted group'] };
  } finally { await pool.end(); }
}
