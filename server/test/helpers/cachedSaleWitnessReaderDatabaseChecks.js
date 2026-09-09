import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createNeighborhoodCachedSourceReader, createNeighborhoodSaleWitnessSourceReader,
  consumeNeighborhoodCachedAcquisition } from '../../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { createNeighborhoodSaleWitnessReadAccess, describeNeighborhoodSaleWitnessMarketDataPurpose }
  from '../../src/services/neighborhoodAssessment/cachedReadAccess.js';
import { resolveNeighborhoodCachedTransactionClosure, CACHED_TRANSACTION_SNAPSHOT_SQL }
  from '../../src/services/neighborhoodAssessment/cachedTransactionClosureReader.js';
import { CACHED_SALE_WITNESS_FIELDS, CACHED_SALE_WITNESS_SQL, prepareCachedSaleWitness }
  from '../../src/services/neighborhoodAssessment/cachedSaleWitness.js';
import { assessmentEvidenceDigest, canonicalAssessmentJson } from '../../src/services/neighborhoodAssessment/contract.js';
import { buildCohortLocalQueryEvidenceV1 } from '../../src/services/neighborhoodAssessment/cohortQueryEvidence.js';
import { prepareCohortLocalQueryEvidenceV1 } from '../../src/services/neighborhoodAssessment/cohortEvidenceContract.js';
import { createTestCachedReadAccess } from '../fixtures/neighborhoodCachedReadAccessFixture.js';
import { checkedNeighborhoodDatabaseUrl, NEIGHBORHOOD_CI_IDENTITY_SQL, verifyNeighborhoodCiConnection }
  from './neighborhoodCiDatabase.js';

const ACCOUNT = 'CAPTURE-COORD-SUBJECT', OTHER = 'CAPTURE-COORD-OTHER', LINKED = 'CAPTURE-COORD-LINKED';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const originalRequired = { code: 'NEIGHBORHOOD_ORIGINAL_CAPTURE_REQUIRED' };
const profileMismatch = { code: 'NEIGHBORHOOD_CACHED_READ_ACCESS_DENIED', reason: 'mapping_profile_mismatch' };

/** Read-only continuation of the exact synthetic coordinator fixture in the
 * caller's already migrated, isolated test database. No new database, schema,
 * source rows, persisted grant or retention writes. The synthetic callback is
 * deliberately NOT the existing production policy, which denies this purpose.
 */
export async function runCachedSaleWitnessReaderDatabaseChecks(connectionString) {
  const database = checkedNeighborhoodDatabaseUrl(connectionString, process.env.NODE_ENV);
  const require = createRequire(import.meta.url), pg = require('pg');
  const pool = new pg.Pool({ connectionString: database.connectionString, max: 1,
    connectionTimeoutMillis: 3000, statement_timeout: 5000, query_timeout: 6000,
    application_name: 'cached_sale_witness_reader_native_test' });
  const checks = [];
  let client, began = false, discard;
  try {
    client = await pool.connect();
    verifyNeighborhoodCiConnection((await client.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0],
      client.connection?.stream?.remoteAddress, database.databaseName);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); began = true;
    await client.query("SET LOCAL TimeZone='UTC'; SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='1000ms'; SET LOCAL idle_in_transaction_session_timeout='10000ms'");
    const deadline = performance.now() + 30_000;
    const identity = await client.query(`SELECT a.id::text AS assignment_file_id, a.account_id, a.organization_id,
      a.assigned_appraiser_user_id AS actor_id, r.id AS report_file_id, r.appraisal_case_id, r.subject_snapshot_id,
      c.effective_date::text, s.effective_date::text AS snapshot_date
      FROM app.assignment_files a
      JOIN app.report_files r ON r.custom_assignment_file_id=a.id AND r.account_id=a.account_id AND r.organization_id=a.organization_id
        AND r.workflow_type='custom_appraisal' AND r.uad_workfile_id IS NULL AND r.tax_protest_file_id IS NULL
      JOIN app.custom_appraisal_workfiles w ON w.assignment_file_id=a.id
      JOIN app.appraisal_cases c ON c.id=r.appraisal_case_id AND c.account_id=a.account_id AND c.organization_id=a.organization_id
      JOIN app.appraisal_subject_snapshots s ON s.id=r.subject_snapshot_id AND s.appraisal_case_id=c.id
      JOIN app_auth.organizations o ON o.id=a.organization_id
      JOIN app_auth.users u ON u.id=a.created_by_user_id AND u.id=a.assigned_appraiser_user_id
      WHERE a.account_id=$1 AND o.legal_name=$2 AND o.display_name=$2 AND u.display_name=$3 LIMIT 2`,
    [ACCOUNT, 'Synthetic Custom capture', 'Synthetic capture actor']);
    assert.equal(identity.rowCount, 1, 'requires one exact preceding synthetic coordinator scope, never a latest/arbitrary target');
    const owner = identity.rows[0];
    assert.equal(owner.effective_date, '2024-06-30'); assert.equal(owner.snapshot_date, owner.effective_date);
    const roster = await client.query(`SELECT account_id FROM core.accounts
      WHERE account_id=ANY($1::text[]) AND county='Dallas' AND address='Synthetic only' AND city='Synthetic'
      ORDER BY account_id`, [[ACCOUNT, OTHER, LINKED]]);
    assert.deepEqual(roster.rows.map(row => row.account_id), [ACCOUNT, OTHER, LINKED].sort(compare));
    const auth = { userId: owner.actor_id, organizations: [{ organizationId: owner.organization_id, roles: ['appraiser'] }] };
    const request = { target: { report_file_id: owner.report_file_id, workflow_type: 'custom_appraisal', workflow_target_id: owner.assignment_file_id },
      scope: { organization_id: owner.organization_id, appraisal_case_id: owner.appraisal_case_id,
        subject_snapshot_id: owner.subject_snapshot_id, account_id: ACCOUNT },
      account_ids: [ACCOUNT, OTHER].sort(compare), effective_date: owner.effective_date,
      observation_period: { start_date: '2023-07-01', end_date: owner.effective_date }, knowledge_cutoff: null };
    const calls = []; let releases = 0, connects = 0, policyCalls = 0, closure;
    const observed = {
      query(statement, values) { calls.push(typeof statement === 'string' ? statement : statement.text); return client.query(statement, values); },
      release() { releases++; assert.fail('reader or closure must not release its caller-owned client'); },
    };
    const forbiddenPool = { async connect() { connects++; assert.fail('caller-owned capture must not connect'); } };
    const access = createTestCachedReadAccess(request, { auth, accessFactory: createNeighborhoodSaleWitnessReadAccess,
      authorizeMarketData: async (principal, context, purpose) => {
        policyCalls++;
        assert.equal(principal.userId, owner.actor_id); assert.deepEqual(context.scope, request.scope);
        assert.deepEqual(context.target, request.target);
        assert.deepEqual(purpose.source_projection, { id: 'cached-sale-scalar-witness-v1', mapping_version: 3,
          witness_version: 1, fields: [...CACHED_SALE_WITNESS_FIELDS] });
        assert.equal(purpose.source_projection.fields.length, 28);
        assert.equal(Object.isFrozen(purpose.source_projection.fields), true);
        assert.equal(purpose.event_date_scope, 'all_available_dates_for_seeded_transactions');
        assert.equal(purpose.association_metadata, 'all_transaction_parcel_links');
        return { allowed: true, decision_id: 'synthetic_native_witness_reader_only', policy_revision: 'synthetic-witness-reader-v1' };
      },
      resolveTransactionClosure: async (_principal, _context, selection, purpose) => {
        assert.equal(policyCalls, 1, 'explicit witness-purpose approval precedes even identity-only market queries');
        assert.equal(purpose.source_projection.mapping_version, 3);
        closure = await resolveNeighborhoodCachedTransactionClosure(observed, {
          selected_account_ids: selection.account_ids, source_revision: 'synthetic-witness-native-closure-v1',
        }, { deadline });
        assert.equal(closure.status, 'captured', JSON.stringify(closure)); assert.equal(closure.query_complete, true);
        assert.deepEqual(closure.transaction_closure.transactions.map(row => row.source_record_id), ['10']);
        return closure.transaction_closure;
      },
    });
    const ordinary = createTestCachedReadAccess(request, { auth });
    assert.throws(() => createNeighborhoodSaleWitnessSourceReader(forbiddenPool, { access: ordinary.access }), profileMismatch);
    assert.throws(() => createNeighborhoodCachedSourceReader(forbiddenPool, { access: access.access }), profileMismatch);
    assert.equal(connects, 0); assert.equal(calls.length, 0); assert.equal(policyCalls, 0);
    checks.push('foreign installed profile refused before connection, source reads or grant preparation');

    const prepared = await access.prepare();
    const reader = createNeighborhoodSaleWitnessSourceReader(forbiddenPool, { access: access.access, limits: { page_size: 1 } });
    const result = await reader.captureInSnapshot(observed, { ...prepared.request, auth,
      selection_grant: prepared.selection_grant, market_grant: prepared.market_grant }, { deadline });
    assert.equal(result.status, 'captured', JSON.stringify(result.incomplete_reasons)); assert.equal(result.query_complete, true);
    assert.equal(result.reader_version, 'local-capture-v3'); assert.equal(result.source_capture.status, 'ready');
    assert.deepEqual(result.snapshot, closure.snapshot);
    assert.equal(connects, 0); assert.equal(releases, 0);
    assert.ok(calls.some(sql => sql.includes('/* neighborhood-cache:transactions */') && sql.includes(CACHED_SALE_WITNESS_SQL)
      && sql.includes('src.mls_status AS source_mls_status') && sql.includes('src.source_row_number')),
    'the actual extended source SELECT, not only a literal SQL witness, must execute on PostgreSQL');
    assert.ok(calls.every(sql => !/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|BEGIN|COMMIT|ROLLBACK|SET)\b/i.test(sql)));
    const state = (await client.query(CACHED_TRANSACTION_SNAPSHOT_SQL)).rows[0];
    assert.equal(state.isolation, 'repeatable read'); assert.equal(state.read_only, 'on');
    assert.equal(state.snapshot, result.snapshot.snapshot); assert.equal(state.backend_pid, result.snapshot.backend_pid);
    checks.push('actual extended source SELECT and one-hop resolver share the verified caller-owned RR/RO snapshot');

    const sources = result.source_capture.sources;
    const records = role => sources.filter(source => source.payload.projection.definition.role === role).flatMap(source => source.payload.records);
    assert.deepEqual(records('selection').map(row => row.data.account_id).sort(compare), request.account_ids);
    assert.deepEqual(records('accounts').map(row => row.data.raw_projection.account_id).sort(compare), request.account_ids);
    assert.ok(records('sale_links').some(row => row.data.raw_projection.account_id === LINKED));
    const sales = records('transactions');
    assert.equal(sales.length, 1); assert.equal(sales[0].data.raw_projection.source_record_id, '10');
    for (const role of ['parcels', 'accounts', 'transactions', 'sale_links']) {
      const rows = records(role); assert.ok(rows.length > 0);
      for (const record of rows) {
        const mapped = record.data;
        assert.equal(mapped.data.cached_mapping_version, 3);
        assert.equal(mapped.data.cached_projection_sha256, assessmentEvidenceDigest({ mapping_version: 3,
          projection_kind: mapped.data.cached_projection_kind, raw_projection: mapped.raw_projection }));
      }
    }
    const sourceCells = (await client.query(`SELECT mls_status,source_row_number,raw_payload IS NULL AS payload_sql_null,
      current_price::text AS current_price FROM core.sales_source_records WHERE id=10 AND primary_account_id=$1`, [ACCOUNT])).rows;
    assert.deepEqual(sourceCells, [{ mls_status: null, source_row_number: null, payload_sql_null: true, current_price: '300000' }]);
    for (const { data: mapped } of sales) {
      const raw = mapped.raw_projection, witness = prepareCachedSaleWitness(raw.source_raw_witness);
      assert.equal(raw.source_mls_status, null); assert.equal(raw.source_row_number, null);
      assert.equal(witness.root_state, 'sql_null'); assert.equal(witness.root_json_type, null);
      for (const field of Object.values(witness.fields)) assert.deepEqual(field,
        { state: 'payload_unavailable', json_type: null, value_text: null, utf8_bytes: null });
      assert.equal(raw.source_current_price, '300000'); assert.equal(raw.sale_price, '400000');
      assert.equal(raw.source_close_date, '2024-03-01'); assert.equal(mapped.data.market_eligible, null);
      assert.equal(mapped.data.gla_sqft_at_sale, null); assert.equal(mapped.data.historical_support, 'unknown');
      assert.ok(mapped.capability_gaps.includes('canonical_source_price_conflict'));
      assert.ok(mapped.capability_gaps.includes('sale_price_meaning_unverified'));
    }
    assert.ok(result.unsupported_capabilities.includes('verified_market_eligibility'));
    assert.ok(result.unsupported_capabilities.includes('historical_characteristics'));
    checks.push('all retained mapped rows are v3; SQL-null source witnesses do not invent raw values, eligibility or history');

    assert.throws(() => consumeNeighborhoodCachedAcquisition(reader, structuredClone(result)), originalRequired);
    assert.throws(() => consumeNeighborhoodCachedAcquisition({}, result), originalRequired);
    const acquisition = consumeNeighborhoodCachedAcquisition(reader, result);
    assert.equal(acquisition.capture_result, result); assert.deepEqual(acquisition.captured_query_request, prepared.request);
    assert.equal(acquisition.provenance, 'original_cached_reader_invocation'); assert.equal(acquisition.authority, 'not_established');
    assert.equal(Object.isFrozen(acquisition), true);
    assert.throws(() => consumeNeighborhoodCachedAcquisition(reader, result), originalRequired);
    const compact = JSON.parse(acquisition.compact_metadata_json);
    assert.equal(compact.mapping_version, 3); assert.equal(compact.reader_version, 'local-capture-v3');
    assert.deepEqual(describeNeighborhoodSaleWitnessMarketDataPurpose(acquisition.captured_query_request).source_projection,
      { id: 'cached-sale-scalar-witness-v1', mapping_version: 3, witness_version: 1, fields: [...CACHED_SALE_WITNESS_FIELDS] });
    const rebuilt = buildCohortLocalQueryEvidenceV1(acquisition.compact_metadata_json, JSON.stringify(request.account_ids), result.selection_sha256);
    assert.equal(rebuilt.status, 'syntax_valid'); assert.deepEqual(rebuilt.evidence, result.query_evidence);
    assert.equal(prepareCohortLocalQueryEvidenceV1(JSON.stringify(result.query_evidence)).status, 'syntax_valid');
    const manifest = createHash('sha256').update(acquisition.compact_metadata_json);
    for (const account of request.account_ids) manifest.update(canonicalAssessmentJson(account)).update('\n');
    assert.equal(manifest.digest('hex'), result.selection_sha256);
    const snapshots = new Map(result.source_capture.source_snapshots.map(value => [value.id, value]));
    const augmented = { ...compact, selection_sha256: result.selection_sha256, selected_account_count: request.account_ids.length };
    for (const source of sources) {
      const { role, source_gaps, ...retainedMetadata } = source.payload.projection.definition;
      assert.deepEqual(retainedMetadata, augmented); assert.deepEqual(source_gaps, []);
      const digest = sha256(canonicalAssessmentJson(source.payload));
      assert.equal(snapshots.get(source.id)?.content_sha256, digest);
      assert.equal(source.id, `${source.payload.metadata.id}:${digest}`);
      const upstream = createHash('sha256').update(canonicalAssessmentJson(augmented));
      for (const row of records(role).toSorted((a, b) => compare(a.record_id, b.record_id))) upstream.update(canonicalAssessmentJson(row)).update('\n');
      assert.equal(source.payload.upstream.upstream_content_sha256, upstream.digest('hex'));
    }
    checks.push('one-use original handoff and mapping3 query, chunk and mapped-row hashes remain exact; no durable retention claimed');
    await client.query('ROLLBACK'); began = false;
    return { checks };
  } finally {
    if (client) {
      if (began) try { await client.query('ROLLBACK'); } catch (error) { discard = error; }
      client.release(discard);
    }
    await pool.end();
  }
}
