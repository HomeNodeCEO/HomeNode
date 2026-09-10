import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { captureAssignmentSalesCsv, recheckAssignmentSalesCsvCapture }
  from '../../src/services/assignmentSalesCsv/capture.js';
import { commitAssignmentSalesImport, getAssignmentSalesImportMatchProposals }
  from '../../src/services/assignmentSalesCsv/storage.js';
import { appendAssignmentSalesImportReview }
  from '../../src/services/assignmentSalesCsv/reviewStorage.js';
import { prepareAssignmentSalesCsv } from '../../src/services/assignmentSalesCsv/prepare.js';
import { digestPreparedSalesParts } from '../../src/services/assignmentSalesCsv/receiptIntegrity.js';
import { authorizeCustomNeighborhoodPrivateSales, CUSTOM_NEIGHBORHOOD_PRIVATE_SALES_RIGHTS_KEY,
  CUSTOM_NEIGHBORHOOD_PRIVATE_SALES_PURPOSE } from '../../src/security/customNeighborhoodPrivateSalesPolicy.js';
import { createCustomCohortContextCapture }
  from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { createCustomCohortContextRepository }
  from '../../src/services/neighborhoodAssessment/customCohortContextRepository.js';
import { loadCustomCohortCaptureInputs }
  from '../../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { saveCustomAppraisalWorkfileSectionInTransaction }
  from '../../src/services/customAppraisalWorkfiles.js';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';
import { prepareAssignmentSalesMatchCandidatesFixture }
  from './assignmentSalesMatchCandidatesDatabaseChecks.js';
import { NEIGHBORHOOD_CI_IDENTITY_SQL, verifyNeighborhoodCiConnection } from './neighborhoodCiDatabase.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const errorCode = code => error => { assert.equal(error.code, code); return true; };
const reason = value => error => { assert.equal(error.reason, value); return true; };
const quote = text => /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
const command = (revision, source = null, rows = []) => ({ review_version: 1, expected_revision: revision,
  source_interpretation: source, row_decisions: rows });
const decision = (row, value, accounts = []) => ({ receipt_id: row.receipt_id, source_row_number: row.source_row_number,
  decision: value, account_ids: accounts, note: 'Synthetic native identity review only; no sale eligibility or source rights.' });

/** Root-run only in the existing, identity-checked disposable migrated database.
 * This adds a separate synthetic assignment and private CSV batch. Existing CAD
 * parcel geometry and shared sales are never edited. The matching schema setup
 * is the existing guarded synthetic helper, not a production initializer.
 * No database creation, DROP, cleanup, external provider or service control.
 */
export async function runCustomCohortPrivateSalesDatabaseChecks({ pool, databaseName, account,
  sourceSnapshot, observationPeriod }) {
  assert.match(databaseName, /^[a-z0-9_]+_test$/);
  const checks = [], organization = randomUUID(), actor = randomUUID(), appraisalCase = randomUUID();
  const snapshot = randomUUID(), report = randomUUID(), effectiveDate = observationPeriod.end_date;
  const probe = await pool.connect();
  let canonical, aliasAccountId;
  try {
    assert.equal(probe.getTransactionStatus(), 'I');
    verifyNeighborhoodCiConnection((await probe.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0],
      probe.connection?.stream?.remoteAddress, databaseName);
    assert.equal((await probe.query(`SELECT to_regclass('app.assignment_sales_import_reviews') IS NOT NULL AS installed`)).rows[0].installed, true);
    await probe.query('BEGIN');
    const matching = await prepareAssignmentSalesMatchCandidatesFixture(probe.query.bind(probe), {
      databaseName, remoteAddress: probe.connection?.stream?.remoteAddress });
    aliasAccountId = matching.aliasAccountId;
    canonical = (await probe.query('SELECT account_id,address,city,county FROM core.accounts WHERE account_id=$1', [account])).rows[0];
    assert.deepEqual(canonical, { account_id: account, address: 'Synthetic only', city: 'Synthetic', county: 'Dallas' });
    // The original fixture's literal address is deliberately not a numbered
    // street. Use this NEW synthetic numeric alias's real one-hop canonical
    // field instead; do not relax the kernel or rewrite the original account.
    assert.equal((await probe.query(`UPDATE core.accounts SET canonical_account_id=$1
      WHERE account_id=$2 AND canonical_account_id=$3`, [account, aliasAccountId, matching.accountId])).rowCount, 1);
    await probe.query(`INSERT INTO app_auth.organizations(id,legal_name,display_name)
      VALUES($1,'Synthetic private context only','Synthetic private context only')`, [organization]);
    await probe.query(`INSERT INTO app_auth.users(id,email,display_name)
      VALUES($1,$2,'Synthetic private context actor')`, [actor, `${actor}@example.test`]);
    await probe.query(`INSERT INTO app.appraisal_cases(id,organization_id,account_id,effective_date)
      VALUES($1,$2,$3,$4::date)`, [appraisalCase, organization, account, effectiveDate]);
    await probe.query(`INSERT INTO app.appraisal_subject_snapshots(id,appraisal_case_id,snapshot_version,effective_date,subject_data)
      SELECT $1,$2,1,$4::date,subject_data FROM app.appraisal_subject_snapshots WHERE id=$3`,
    [snapshot, appraisalCase, sourceSnapshot, effectiveDate]);
    await probe.query('COMMIT');
  } catch (error) { await probe.query('ROLLBACK'); throw error; }
  finally { probe.release(); }

  const transaction = async (mode, work, { rollback = false } = {}) => {
    const client = await pool.connect(); let problem;
    try {
      assert.equal(client.getTransactionStatus(), 'I');
      await client.query(`BEGIN ISOLATION LEVEL ${mode}`);
      await client.query("SET LOCAL statement_timeout='10000ms'; SET LOCAL lock_timeout='250ms'; SET LOCAL timezone='UTC'");
      const value = await work(client);
      await client.query(rollback ? 'ROLLBACK' : 'COMMIT');
      return value;
    } catch (error) {
      problem = error;
      try { if (['T', 'E'].includes(client.getTransactionStatus())) await client.query('ROLLBACK'); }
      catch { /* Discard the actual failed connection below. */ }
      throw error;
    } finally { client.release(problem); }
  };
  const assignment = (await pool.query(`INSERT INTO app.assignment_files
    (organization_id,account_id,file_number,created_by_user_id,assigned_appraiser_user_id)
    VALUES($1,$2,$3,$4,$4) RETURNING id::text`, [organization, account, `PRIVATE-${randomUUID()}`, actor])).rows[0].id;
  await pool.query(`INSERT INTO app.report_files
    (id,organization_id,account_id,workflow_type,file_number,custom_assignment_file_id,appraisal_case_id,subject_snapshot_id)
    VALUES($1,$2,$3,'custom_appraisal',$4,$5,$6,$7)`, [report, organization, account, `PRIVATE-${randomUUID()}`,
  assignment, appraisalCase, snapshot]);
  await pool.query('INSERT INTO app.custom_appraisal_workfiles(assignment_file_id,canonical_file_name) VALUES($1,$2)',
    [assignment, `private-context-${randomUUID()}`]);
  const auth = { userId: actor, organizations: [{ organizationId: organization, roles: ['appraiser'] }] };
  const target = { organization_id: organization, report_file_id: report, assignment_file_id: assignment, account_id: account };
  const scope = { auth, accountId: account, assignmentFileId: assignment, reportFileId: report };
  const nextDay = (await pool.query('SELECT ($1::date+1)::text AS value', [effectiveDate])).rows[0].value;
  const records = [
    ['private-old', '2024-03-01', '275000.000', '295000', 'Closed', aliasAccountId, canonical.city, canonical.county],
    ['private-clear', '2024-04-01', '285000', '305000', 'Closed', aliasAccountId, canonical.city, canonical.county],
    ['private-future', nextDay, '999000', '1000000', 'Closed', aliasAccountId, canonical.city, canonical.county],
    ['', '', '', '', '', '', '', ''], ['ragged'],
  ];
  const content = Buffer.from([['ListingKey', 'CloseDate', 'ClosePrice', 'CurrentPrice', 'MlsStatus', 'ParcelNumber', 'City', 'County'],
    ...records].map(row => row.map(quote).join(',')).join('\r\n'));
  const prepared = prepareAssignmentSalesCsv(content), { rows: preparedRows, ...preparedHeader } = prepared;
  assert.equal(preparedRows.length, 5);
  const imported = await commitAssignmentSalesImport(pool, { ...scope, operationId: randomUUID(),
    fileName: 'synthetic-private-context.csv', content });
  assert.equal(imported.integrity_status, 'verified');
  assert.equal(imported.source_sha256, sha(content));
  assert.equal(imported.preparation_sha256, digestPreparedSalesParts(preparedHeader, preparedRows));
  const batchId = imported.batch_id;
  const original = (await pool.query(`SELECT receipt_id,source_row_number,record_data FROM app.assignment_sales_import_rows
    WHERE batch_id=$1 ORDER BY source_row_number`, [batchId])).rows;
  assert.deepEqual(original.map(row => row.record_data), preparedRows);
  const source = { source_name: 'Synthetic privately supplied CSV', provenance_note: 'Test evidence only, not a real provider license.',
    currency: 'USD', living_area_unit: null, site_area_unit: null, consideration_field: 'close_price',
    marketing_time_field: null, source_use_confirmed: true };
  let revision = 0;
  const append = async (interpretation, decisions = []) => {
    const receipt = await appendAssignmentSalesImportReview(pool, { ...scope, batchId, operationId: randomUUID(),
      command: command(revision, interpretation, decisions) });
    assert.equal(receipt.revision, revision + 1); revision = receipt.revision; return receipt;
  };
  const rawCapture = expectedReviewRevision => transaction('REPEATABLE READ READ ONLY', client =>
    captureAssignmentSalesCsv(client.query.bind(client), { target, batchId, expectedReviewRevision }));
  await assert.rejects(rawCapture(1), errorCode('assignment_sales_import_source_not_reviewed'));
  await append({ ...source, source_use_confirmed: false });
  await assert.rejects(rawCapture(1), errorCode('assignment_sales_import_source_use_not_confirmed'));
  const proposed = await getAssignmentSalesImportMatchProposals(pool, { ...scope, batchId, afterRow: 0, limit: 50 });
  const confirmed = [2, 4].map(ordinal => {
    const row = proposed.rows.find(item => item.source_row_number === ordinal);
    assert.equal(row.proposal_status, 'proposed', JSON.stringify(row));
    assert.deepEqual(row.proposed_account_ids, [account]);
    return decision(row, 'confirm_proposed_match', row.proposed_account_ids);
  });
  const sourceReview = await append(source, confirmed);
  await append(null, [decision(original[1], 'exclude')]);
  const clearReview = await append(null, [decision(original[1], 'clear')]);
  const direct = await rawCapture(revision);
  for (const wrong of [{ organization_id: randomUUID() }, { report_file_id: randomUUID() },
    { assignment_file_id: String(BigInt(assignment) + 1000000n) }, { account_id: `${account}-not-this-batch` }]) {
    await assert.rejects(transaction('REPEATABLE READ READ ONLY', client => captureAssignmentSalesCsv(client.query.bind(client),
      { target: { ...target, ...wrong }, batchId, expectedReviewRevision: revision })), errorCode('assignment_sales_import_not_found'));
  }
  assert.equal(direct.review.revision, 4); assert.equal(direct.review.head_review_id, clearReview.review_id);
  assert.equal(direct.review.source_review_id, sourceReview.review_id);
  assert.deepEqual(direct.rows.map(row => row.record_data), preparedRows);
  assert.deepEqual(direct.rows.map(row => row.review?.decision ?? null), ['confirm_proposed_match', 'clear', 'confirm_proposed_match', null, null]);
  assert.match(direct.captured_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
  assert.ok(direct.captured_at.slice(0, 10) > effectiveDate);
  checks.push('native private import/reviews feed exact RR/RO capture; unreviewed and unconfirmed source refused; all original and cleared rows retained');

  await transaction('READ COMMITTED', async client => {
    await client.query('SELECT assignment_file_id FROM app.custom_appraisal_workfiles WHERE assignment_file_id=$1 FOR UPDATE', [assignment]);
    assert.equal(await recheckAssignmentSalesCsvCapture(client.query.bind(client), direct), true);
    await assert.rejects(transaction('READ COMMITTED', contender => contender.query(
      'SELECT batch_id FROM app.assignment_sales_import_batches WHERE batch_id=$1 FOR UPDATE NOWAIT', [batchId])), errorCode('55P03'));
    assert.equal(client.getTransactionStatus(), 'T', 'recheck releases only its savepoint, not the owner transaction/lock');
  }, { rollback: true });
  await assert.rejects(transaction('REPEATABLE READ READ ONLY', client =>
    recheckAssignmentSalesCsvCapture(client.query.bind(client), direct)), errorCode('assignment_sales_import_transaction_state'));
  checks.push('native registration recheck requires caller RC/write transaction and retains exact batch SHARE lock until caller rollback');

  const times = (await pool.query(`SELECT
    to_char((clock_timestamp()-interval '1 hour') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS past,
    to_char((clock_timestamp()+interval '1 hour') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS future,
    to_char((clock_timestamp()+interval '2 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS later`)).rows[0];
  const rights = { policy_version: 1, organization_id: organization, grant_id: 'synthetic-private-capture-only',
    purpose: CUSTOM_NEIGHBORHOOD_PRIVATE_SALES_PURPOSE,
    rights_basis: { owner_id: 'synthetic-fixture-owner', basis_reference: 'Synthetic test grant; no real provider terms or rights.',
      approved_by: 'synthetic-fixture', approved_at: times.past },
    valid_from: times.past, expires_at: times.future, revoked_at: null,
    retention: 'immutable_originals_without_automated_deletion',
    exposures: { none: true, report_observation_summary: true, report_observation_members: true, report_observation_catalog: true } };
  const writeRights = async value => pool.query(`UPDATE app_auth.organizations SET metadata=jsonb_set(
    coalesce(metadata,'{}'::jsonb),ARRAY[$2::text],$3::jsonb,true) WHERE id=$1::uuid`,
  [organization, CUSTOM_NEIGHBORHOOD_PRIVATE_SALES_RIGHTS_KEY, JSON.stringify(value)]);
  const sharedGrant = { allowed: true, decision_id: 'synthetic-private-context-shared-mirror', policy_revision: 'synthetic-private-context-shared-v1' };
  const sharedPolicy = async (_client, principal, context) => {
    assert.equal(principal.userId, actor); assert.equal(context.scope.organization_id, organization); return sharedGrant;
  };
  const makeOwner = ({ after, privatePolicy = authorizeCustomNeighborhoodPrivateSales } = {}) => {
    const calls = [];
    const observedPool = { async connect() {
      const client = await pool.connect();
      return { getTransactionStatus: () => client.getTransactionStatus(), release: error => client.release(error),
        async query(statement, values) {
          const text = typeof statement === 'string' ? statement : statement.text;
          calls.push(text);
          const value = await client.query(statement, values);
          await after?.({ text, client, result: value }); return value;
        } };
    } };
    return { calls, owner: createCustomCohortContextCapture({ pool: observedPool,
      authorizeMarketData: sharedPolicy, authorizePrivateSales: privatePolicy }) };
  };
  const captureInput = () => ({ auth, accountId: account, assignmentFileId: assignment, operationId: randomUUID(),
    observationPeriod, privateSalesImport: { batch_id: batchId, expected_review_revision: revision } });
  const countContext = async operationId => (await pool.query(`SELECT count(*)::int AS n
    FROM app.neighborhood_custom_cohort_contexts WHERE organization_id=$1 AND context_id=$2`, [organization, operationId])).rows[0].n;
  const protectedState = async () => {
    const result = {};
    // All names are a fixed test allowlist in the already guarded synthetic DB.
    for (const [table, order] of [['core.accounts', 'account_id'], ['core.sales', 'id'], ['core.sales_source_records', 'id'],
      ['core.sale_parcels', 'id'], ['gis.dcad_parcels', 'object_id'], ['app.assignment_files', 'id'], ['app.report_files', 'id'],
      ['app.custom_appraisal_workfiles', 'assignment_file_id'], ['app.custom_appraisal_workfile_sections', 'assignment_file_id,section_key'],
      ['app.custom_appraisal_workfile_section_history', 'id'], ['app.custom_appraisal_signed_snapshots', 'id'],
      ['app.custom_neighborhood_acceptances', 'id']]) {
      const values = (await pool.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY ${order}`)).rows;
      result[table] = sha(JSON.stringify(values));
    }
    result.originalBatch = sha(JSON.stringify((await pool.query(
      'SELECT to_jsonb(b) AS value FROM app.assignment_sales_import_batches b WHERE batch_id=$1', [batchId])).rows));
    result.originalRows = sha(JSON.stringify((await pool.query(`SELECT to_jsonb(r) AS value FROM app.assignment_sales_import_rows r
      WHERE batch_id=$1 ORDER BY source_row_number`, [batchId])).rows));
    return result;
  };
  const baseline = await protectedState();
  const deniedInitial = makeOwner(), noRights = captureInput();
  await assert.rejects(deniedInitial.owner.capture(noRights), reason('market_data_access_denied'));
  assert.equal(await countContext(noRights.operationId), 0);
  assert.ok(!deniedInitial.calls.some(sql => sql.includes('assignment-sales-capture:batch')),
    'missing private rights must be refused before original CSV rows are opened');
  await writeRights(rights);
  const { owner, calls } = makeOwner(), request = captureInput();
  const registered = await owner.capture(request);
  assert.equal(registered.status, 'registered'); assert.equal(registered.reused, false);
  assert.deepEqual(registered.private_sales_import, request.privateSalesImport);
  assert.equal(await countContext(request.operationId), 1);
  assert.deepEqual(await protectedState(), baseline);
  const retained = await transaction('REPEATABLE READ READ ONLY', async client => {
    const context = await createCustomCohortContextRepository(client, json(target)).get(json(registered.context_ref));
    const refs = Object.fromEntries(['snapshot_evidence', 'subject_dependencies', 'selection_input', 'study_input'].map(key => [key, context.body[key]]));
    return loadCustomCohortCaptureInputs(client, json(target), refs);
  });
  const reopened = retained.retained_inputs.private_sales.capture;
  assert.deepEqual(reopened.rows, direct.rows); assert.deepEqual(reopened.batch, direct.batch);
  assert.deepEqual(reopened.review, direct.review); assert.deepEqual(reopened.source_interpretation, source);
  assert.equal(retained.acquisition_intent.body.intent_version, 2);
  assert.deepEqual(retained.acquisition_intent.body.private_sales_import, request.privateSalesImport);
  assert.equal(retained.study.observation_period.end_date, effectiveDate);
  assert.equal(reopened.rows[0].record_data.values.close_date, '2024-03-01');
  checks.push('actual private policy and three-phase context capture persist/reopen immutable v2 intent and all private rows without shared-sales/report mutation');

  const previewInput = { auth, accountId: account, assignmentFileId: assignment, contextRef: registered.context_ref,
    selection: { revision: 1, pockets: [{ id: 'synthetic-subject', label: 'Synthetic subject', account_ids: [account] }] } };
  const from = calls.length;
  const presented = await owner.present(previewInput, { includeMap: false });
  const summary = presented.private_sales;
  assert.equal(summary.status, 'observations_only'); assert.equal(summary.authority, 'not_established');
  assert.deepEqual(summary.binding.context_ref, registered.context_ref);
  assert.equal(summary.binding.selection_sha256, presented.summary.binding.selection_sha256);
  assert.equal(summary.selected.retained_row_count, 5); assert.equal(summary.selected.included_source_record_count, 1);
  assert.equal(summary.selected.metrics.reported_transaction_price.median, '275000');
  assert.equal(summary.selected.metrics.current_price.median, '295000');
  assert.equal(summary.selected.metrics.reported_living_area.status, 'unavailable');
  assert.equal(summary.selected.disposition_counts.future_closing_date, 1);
  assert.equal(summary.selected.disposition_counts.cleared, 1);
  assert.equal(summary.selected.disposition_counts.empty, 1);
  assert.equal(summary.selected.disposition_counts.rejected, 1);
  assert.equal(summary.effective_date, effectiveDate);
  assert.deepEqual(summary.observation_period, observationPeriod);
  assert.equal(summary.rows, undefined); assert.equal(summary.source_interpretation.provenance_note, undefined);
  assert.equal(summary.source_interpretation.source_use_confirmed, undefined);
  assert.deepEqual(summary.apply, { status: 'blocked', reasons: ['private_source_observations_only'] });
  assert.ok(!calls.slice(from).some(sql => /assignment-sales-capture:|neighborhood-(cache|membership|closure):/.test(sql)),
    'reopen/present never reacquires current CSV review rows, CAD or shared sales');
  assert.deepEqual(await protectedState(), baseline);
  checks.push('native retained private summary preserves historical closing prices and separate CurrentPrice; future/unreviewed/empty/rejected rows excluded explicitly; no fresh source read');

  await transaction('READ COMMITTED', client => saveCustomAppraisalWorkfileSectionInTransaction(client, {
    accountId: account, assignmentFileId: Number(assignment), sectionKey: 'neighborhood_workspace', expectedRevision: 0,
    sectionValue: { workspace_version: 2, active: { context_ref: registered.context_ref,
      observation_period: observationPeriod, selection: { revision: 1, included_recorded_group_ids: [] } }, pending_capture: null },
    saveReason: 'manual_save', reviewer: actor }));
  const afterCheckpoint = await protectedState();
  const preparedReport = await owner.prepareReviewedInputs({ auth, accountId: account, assignmentFileId: assignment,
    contextRef: registered.context_ref, expectedWorkspaceRevision: 1, expectedReviewGeneration: '0' });
  assert.equal(preparedReport.status, 'prepared_reviewed_inputs'); assert.equal(preparedReport.supported_inputs, null);
  assert.equal(preparedReport.report_preparation.status, 'incomplete');
  for (const key of ['assessment', 'publication_bundle', 'candidate']) assert.equal(preparedReport.report_preparation[key], null);
  assert.equal(preparedReport.report_preparation.temporal_support.status, 'historical_stock_evidence_required');
  assert.deepEqual(preparedReport.apply, { status: 'blocked', reason: 'historical_stock_evidence_required' });
  assert.deepEqual(await protectedState(), afterCheckpoint);
  checks.push('later-imported private historical sale remains inspectable while actual reviewed-input owner still blocks current-mirror historical stock and report candidate/Apply');

  await append({ ...source, source_use_confirmed: false });
  const unconfirmedRequest = captureInput();
  await assert.rejects(owner.capture(unconfirmedRequest), errorCode('assignment_sales_import_source_use_not_confirmed'));
  assert.equal(await countContext(unconfirmedRequest.operationId), 0);
  const changedSource = await append({ ...source, currency: null, consideration_field: null });
  const next = await rawCapture(revision);
  assert.equal(next.review.source_review_id, changedSource.review_id); assert.equal(next.source_interpretation.currency, null);
  await assert.rejects(transaction('READ COMMITTED', client => recheckAssignmentSalesCsvCapture(client.query.bind(client), direct)),
    errorCode('assignment_sales_import_capture_changed'));
  const unchanged = await owner.present(previewInput, { includeMap: false });
  assert.deepEqual(unchanged.private_sales, summary, 'old context uses original reviewed source, not current review heads');
  assert.deepEqual(unchanged.summary, presented.summary);
  let commits = 0;
  const raced = makeOwner({ after: async ({ text }) => {
    if (text === 'COMMIT' && ++commits === 2) await append(null, [decision(original[0], 'exclude')]);
  } });
  const racingRequest = captureInput();
  await assert.rejects(raced.owner.capture(racingRequest), errorCode('assignment_sales_import_capture_changed'));
  assert.equal(await countContext(racingRequest.operationId), 0);
  assert.ok(raced.calls.some(sql => sql.includes('assignment-sales-capture:recheck-lock')));
  assert.ok(raced.calls.includes('ROLLBACK'), 'stale review admission rolls back registration');
  assert.deepEqual(await protectedState(), afterCheckpoint);
  checks.push('native review revision/source correction masks new captures but not retained originals; review committed between acquisition and registration forces rollback with no context');

  for (const deniedRights of [{ ...rights, revoked_at: times.past },
    { ...rights, valid_from: times.future, expires_at: times.later }]) {
    await writeRights(deniedRights);
    const denied = captureInput();
    await assert.rejects(owner.capture(denied), reason('market_data_access_denied'));
    assert.equal(await countContext(denied.operationId), 0);
    await assert.rejects(owner.present(previewInput), reason('market_data_access_denied'));
  }
  await writeRights(rights);
  const exposureCalls = [
    ['report_observation_summary', () => owner.present(previewInput, { includeMap: false })],
    ['report_observation_catalog', () => owner.catalog(previewInput)],
    ['report_observation_members', () => owner.inspect(previewInput,
      { population: { group: 'all', kind: 'stock' }, page: { limit: 10, after_member_id: null } })],
  ];
  for (const [exposure, invoke] of exposureCalls) {
    await writeRights({ ...rights, exposures: { ...rights.exposures, [exposure]: false } });
    await assert.rejects(invoke(), reason('market_data_access_denied'));
    await writeRights(rights);
  }
  // Capture under the SAME summary-disabled policy so denial cannot be merely
  // incidental policy-hash drift. Catalog/members remain expressly permitted.
  await writeRights({ ...rights, exposures: { ...rights.exposures, report_observation_summary: false } });
  const noSummaryRequest = captureInput(), noSummary = await owner.capture(noSummaryRequest);
  const noSummaryPreview = { ...previewInput, contextRef: noSummary.context_ref };
  await assert.rejects(owner.catalog(noSummaryPreview), reason('market_data_access_denied'));
  await assert.rejects(owner.inspect(noSummaryPreview, { population: { group: 'all', kind: 'stock' },
    page: { limit: 10, after_member_id: null } }), reason('market_data_access_denied'));
  await writeRights(rights);
  let privateCalls = 0;
  const finalDenied = makeOwner({ privatePolicy: async (...args) => {
    if (++privateCalls === 2) await writeRights({ ...rights, revoked_at: times.past });
    return authorizeCustomNeighborhoodPrivateSales(...args);
  } });
  const revokedDuringCapture = captureInput();
  await assert.rejects(finalDenied.owner.capture(revokedDuringCapture), reason('market_data_access_denied'));
  assert.equal(privateCalls, 2); assert.equal(await countContext(revokedDuringCapture.operationId), 0);
  await writeRights(rights);
  let publicCalls = 0;
  const finalSummaryDenied = makeOwner({ privatePolicy: async (...args) => {
    if (++publicCalls === 2) await writeRights({ ...rights, exposures: { ...rights.exposures, report_observation_summary: false } });
    return authorizeCustomNeighborhoodPrivateSales(...args);
  } });
  await assert.rejects(finalSummaryDenied.owner.present(previewInput), reason('market_data_access_denied'));
  assert.equal(publicCalls, 2);
  await writeRights(rights);
  checks.push('actual synthetic private rights independently enforce active/future/revoked grants and summary/catalog/member exposures before read and after load/registration');

  const futurePeriod = { ...captureInput(), observationPeriod: { ...observationPeriod, end_date: nextDay } };
  await assert.rejects(owner.capture(futurePeriod), reason('period_after_effective_date'));
  assert.equal(await countContext(futurePeriod.operationId), 0);
  const workfileBefore = (await pool.query(`SELECT status,signed_at::text,updated_at::text
    FROM app.custom_appraisal_workfiles WHERE assignment_file_id=$1`, [assignment])).rows[0];
  try {
    await pool.query("UPDATE app.custom_appraisal_workfiles SET status='signed',signed_at=clock_timestamp() WHERE assignment_file_id=$1", [assignment]);
    const signedRequest = captureInput();
    await assert.rejects(owner.capture(signedRequest), reason('private_source_read_only'));
    assert.equal(await countContext(signedRequest.operationId), 0);
    await assert.rejects(owner.capture(request), errorCode('custom_cohort_subject_protected_workfile'));
    assert.equal(await countContext(request.operationId), 1, 'existing subject protection also gates replay; original evidence stays retained');
  } finally {
    await pool.query('UPDATE app.custom_appraisal_workfiles SET status=$2,signed_at=$3,updated_at=$4 WHERE assignment_file_id=$1',
      [assignment, workfileBefore.status, workfileBefore.signed_at, workfileBefore.updated_at]);
  }
  const readOnlyAuth = { ...auth, organizations: [{ organizationId: organization, roles: ['read_only'] }] };
  const forbidden = { ...captureInput(), auth: readOnlyAuth };
  await assert.rejects(owner.capture(forbidden), reason('assignment_access_denied'));
  assert.equal(await countContext(forbidden.operationId), 0);
  checks.push('future requested period, signed file and read-only actor cannot create new private context; existing signed-subject replay protection remains unchanged');

  let committed = 0;
  const lost = makeOwner({ after: async ({ text }) => {
    if (text === 'COMMIT' && ++committed === 3) throw new Error('synthetic_private_context_lost_commit_ack');
  } });
  const unknown = captureInput();
  await assert.rejects(lost.owner.capture(unknown), error => error.message === 'synthetic_private_context_lost_commit_ack'
    && error.outcome_unknown === true);
  assert.equal(await countContext(unknown.operationId), 1);
  const replayFrom = calls.length;
  const recovered = await owner.capture(unknown);
  assert.equal(recovered.status, 'registered'); assert.equal(recovered.reused, true);
  assert.equal(recovered.context_ref.context_id, unknown.operationId);
  assert.deepEqual(recovered.private_sales_import, unknown.privateSalesImport);
  assert.ok(!calls.slice(replayFrom).some(sql => /assignment-sales-capture:|neighborhood-(cache|membership|closure):/.test(sql)));
  await assert.rejects(owner.capture({ ...unknown, privateSalesImport: { ...unknown.privateSalesImport,
    expected_review_revision: unknown.privateSalesImport.expected_review_revision - 1 } }), reason('operation_conflict'));
  assert.equal(await countContext(unknown.operationId), 1);
  assert.deepEqual(await protectedState(), afterCheckpoint);
  assert.equal(pool.waitingCount, 0);
  checks.push('actual durable context COMMIT with lost acknowledgment recovers once by exact batch/review operation; original CSV/shared sales/report/accepted/signing rows remain unchanged');
  return { checks };
}
