import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createNeighborhoodCachedSourceReader, createNeighborhoodSaleWitnessSourceReader,
  createNeighborhoodCadEvidenceSourceReader, createNeighborhoodCombinedEvidenceSourceReader,
  createNeighborhoodDenseCombinedEvidenceSourceReader, consumeNeighborhoodCachedAcquisition }
  from '../../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { createNeighborhoodSaleWitnessReadAccess, createNeighborhoodCadEvidenceReadAccess,
  createNeighborhoodCombinedEvidenceReadAccess, describeNeighborhoodCombinedEvidenceMarketDataPurpose }
  from '../../src/services/neighborhoodAssessment/cachedReadAccess.js';
import { resolveNeighborhoodCachedTransactionClosure, CACHED_TRANSACTION_SNAPSHOT_SQL }
  from '../../src/services/neighborhoodAssessment/cachedTransactionClosureReader.js';
import { CACHED_CAD_EVIDENCE_FIELDS } from '../../src/services/neighborhoodAssessment/cachedRowMappingsV4.js';
import { CACHED_SALE_WITNESS_V2_VERSION, CACHED_SALE_WITNESS_V2_FIELDS, CACHED_SALE_WITNESS_V2_SQL,
  prepareCachedSaleWitnessV2 } from '../../src/services/neighborhoodAssessment/cachedSaleWitnessV2.js';
import { assessmentEvidenceDigest, canonicalAssessmentJson }
  from '../../src/services/neighborhoodAssessment/contract.js';
import { buildCohortLocalQueryEvidenceV1 } from '../../src/services/neighborhoodAssessment/cohortQueryEvidence.js';
import { prepareCohortLocalQueryEvidenceV1 } from '../../src/services/neighborhoodAssessment/cohortEvidenceContract.js';
import { DENSE_CAD_CACHE_READER_LIMITS, DENSE_CAD_SQL_PAGE_BYTES }
  from '../../src/services/neighborhoodAssessment/denseCadCapturePolicy.js';
import { createTestCachedReadAccess } from '../fixtures/neighborhoodCachedReadAccessFixture.js';
import { checkedNeighborhoodDatabaseUrl, NEIGHBORHOOD_CI_IDENTITY_SQL, verifyNeighborhoodCiConnection }
  from './neighborhoodCiDatabase.js';

const ACCOUNT = 'CAPTURE-COORD-SUBJECT', OTHER = 'CAPTURE-COORD-OTHER', LINKED = 'CAPTURE-COORD-LINKED';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const originalRequired = { code: 'NEIGHBORHOOD_ORIGINAL_CAPTURE_REQUIRED' };
const profileMismatch = { code: 'NEIGHBORHOOD_CACHED_READ_ACCESS_DENIED', reason: 'mapping_profile_mismatch' };
const foreignGrants = { code: 'NEIGHBORHOOD_CACHED_READ_ACCESS_DENIED', reason: 'original_matching_grants_required' };
const recordsOf = (result, role) => result.source_capture.sources
  .filter(source => source.payload.projection.definition.role === role).flatMap(source => source.payload.records);
const plainData = mapped => Object.fromEntries(Object.entries(mapped.data)
  .filter(([key]) => !['cached_mapping_version', 'cached_projection_sha256'].includes(key)));

// Exercise the actual executed transport suffix against bounded, generated
// PostGIS geometry. No tables/fixtures are written, and no application sources
// are read. This checks native SQL, not a substitute for complete-reader tests.
async function checkDenseParcelTransport(client, legacySql, denseSql) {
  const suffix = sql => {
    const parts = sql.split('), encoded AS (');
    assert.equal(parts.length, 2, 'the checked reader transport anchor must be unique');
    return `), encoded AS (${parts[1]}`;
  };
  const generated = sql => `WITH projected AS MATERIALIZED (
    WITH geometry AS MATERIALIZED (SELECT encode(ST_AsEWKB(ST_Multi(ST_Buffer(
      ST_SetSRID(ST_MakePoint(-96.8,32.8),4326),0.002,$1::int))),'hex') AS stored_geometry_ewkb)
    SELECT id::text AS object_id,stored_geometry_ewkb FROM geometry CROSS JOIN generate_series(1,$2::int) id
    ${suffix(sql)}`;
  const dense = generated(denseSql), legacy = generated(legacySql);
  const single = (await client.query(dense, [600, 1])).rows;
  assert.equal(single.length, 1); assert.ok(single[0].payload);
  assert.ok(single[0].row_bytes > 64000 && single[0].row_bytes <= DENSE_CAD_CACHE_READER_LIMITS.row_bytes);
  const geometry = single[0].payload.stored_geometry_ewkb;
  const checked = (await client.query(`SELECT ST_IsValid(geom) AS valid,
    encode(ST_AsEWKB(geom),'hex') AS exact FROM (SELECT ST_GeomFromEWKB(decode($1,'hex')) AS geom) source`, [geometry])).rows[0];
  assert.equal(checked.valid, true); assert.equal(checked.exact, geometry);
  const old = (await client.query(legacy, [600, 1])).rows;
  assert.equal(old[0].row_bytes, single[0].row_bytes); assert.equal(old[0].payload, null);
  const excessiveRow = (await client.query(dense, [1100, 1])).rows;
  assert.ok(excessiveRow[0].row_bytes > DENSE_CAD_CACHE_READER_LIMITS.row_bytes);
  assert.equal(excessiveRow[0].payload, null);
  const excessivePage = (await client.query(dense, [600, 251])).rows;
  assert.equal(excessivePage.length, 251);
  assert.ok(excessivePage.every(row => row.row_bytes <= DENSE_CAD_CACHE_READER_LIMITS.row_bytes));
  assert.ok(excessivePage.reduce((sum, row) => sum + row.row_bytes, 0) > DENSE_CAD_SQL_PAGE_BYTES);
  assert.ok(excessivePage.every(row => row.payload === null), 'the entire oversized page, including lookahead, is withheld');
}

/** Read-only continuation of the exact preceding synthetic coordinator fixture.
 * No database/schema/row/privilege/retention writes or source-policy activation.
 * The explicit synthetic authorizer is NOT the production policy, which still
 * denies the expanded projection. The fixture has a SQL-null raw source payload;
 * non-null scalar SQL parity belongs to cachedSaleWitnessV2DatabaseChecks.
 */
export async function runCachedCombinedEvidenceReaderDatabaseChecks(connectionString) {
  const database = checkedNeighborhoodDatabaseUrl(connectionString, process.env.NODE_ENV);
  const { Pool } = createRequire(import.meta.url)('pg');
  const pool = new Pool({ connectionString: database.connectionString, max: 1,
    connectionTimeoutMillis: 3000, statement_timeout: 5000, query_timeout: 6000,
    application_name: 'cached_combined_evidence_reader_native_test' });
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
    assert.equal(identity.rowCount, 1, 'requires the exact preceding synthetic coordinator scope, never a latest/arbitrary file');
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
    const calls = []; let connects = 0, releases = 0;
    const observed = { query(statement, values) {
      calls.push({ sql: typeof statement === 'string' ? statement : statement.text,
        values: structuredClone((typeof statement === 'string' ? values : statement.values) ?? []) });
      return client.query(statement, values);
    }, release() { releases++; assert.fail('reader/closure must not release the caller-owned client'); } };
    const forbiddenPool = { async connect() { connects++; assert.fail('caller-owned capture must not connect'); } };
    const projection = { id: 'cached-combined-evidence-v1', mapping_version: 5,
      witness_version: CACHED_SALE_WITNESS_V2_VERSION, fields: [...CACHED_SALE_WITNESS_V2_FIELDS] };
    function accessFor(combined) {
      let policyCalls = 0, closure;
      const access = createTestCachedReadAccess(request, { auth,
        accessFactory: combined ? createNeighborhoodCombinedEvidenceReadAccess : createNeighborhoodCadEvidenceReadAccess,
        authorizeMarketData: async (principal, context, purpose) => {
          policyCalls++;
          assert.equal(principal.userId, owner.actor_id); assert.deepEqual(context.scope, request.scope);
          assert.deepEqual(context.target, request.target);
          if (combined) {
            assert.deepEqual(purpose.source_projection, projection);
            assert.ok(Object.isFrozen(purpose.source_projection)); assert.ok(Object.isFrozen(purpose.source_projection.fields));
          } else assert.equal(Object.hasOwn(purpose, 'source_projection'), false);
          assert.equal(purpose.event_date_scope, 'all_available_dates_for_seeded_transactions');
          assert.equal(purpose.association_metadata, 'all_transaction_parcel_links');
          assert.equal(purpose.additional_cadastral_accounts, false); assert.equal(purpose.private_assignment_overlays, false);
          return { allowed: true, decision_id: 'synthetic_native_combined_reader_only', policy_revision: 'synthetic-combined-reader-v1' };
        },
        resolveTransactionClosure: async (_principal, _context, selection, purpose) => {
          assert.equal(policyCalls, 1, 'explicit matching-purpose approval precedes identity-only market reads');
          if (combined) assert.deepEqual(purpose.source_projection, projection);
          assert.deepEqual(selection.account_ids, request.account_ids);
          closure = await resolveNeighborhoodCachedTransactionClosure(observed, {
            selected_account_ids: selection.account_ids, source_revision: 'synthetic-combined-native-closure-v1',
          }, { deadline });
          assert.equal(closure.status, 'captured', JSON.stringify(closure)); assert.equal(closure.query_complete, true);
          assert.deepEqual(closure.transaction_closure.transactions.map(row => row.source_record_id), ['10']);
          return closure.transaction_closure;
        },
      });
      return { ...access, closure: () => closure };
    }
    const initial = accessFor(true);
    for (const accessFactory of [createNeighborhoodSaleWitnessReadAccess, createNeighborhoodCadEvidenceReadAccess]) {
      const foreign = createTestCachedReadAccess(request, { auth, accessFactory });
      assert.throws(() => createNeighborhoodCombinedEvidenceSourceReader(forbiddenPool, { access: foreign.access }), profileMismatch);
      assert.throws(() => createNeighborhoodDenseCombinedEvidenceSourceReader(forbiddenPool, { access: foreign.access }), profileMismatch);
    }
    for (const readerFactory of [createNeighborhoodCachedSourceReader, createNeighborhoodSaleWitnessSourceReader, createNeighborhoodCadEvidenceSourceReader]) {
      assert.throws(() => readerFactory(forbiddenPool, { access: initial.access }), profileMismatch);
    }
    assert.equal(calls.length, 0); assert.equal(connects, 0);
    checks.push('v3/v4 issuers cannot create a combined reader; combined issuer cannot create an older reader before native queries');

    let baseline, baselineTrace, baselineParcelSql, denseParcelSql;
    for (const mode of ['cad4', 'combined5', 'dense5']) {
      const from = calls.length, access = mode === 'combined5' ? initial : accessFor(mode !== 'cad4');
      const prepared = await access.prepare();
      const factory = mode === 'cad4' ? createNeighborhoodCadEvidenceSourceReader
        : mode === 'dense5' ? createNeighborhoodDenseCombinedEvidenceSourceReader : createNeighborhoodCombinedEvidenceSourceReader;
      const reader = factory(forbiddenPool, { access: access.access, limits: { page_size: 1 } });
      if (mode === 'combined5') for (const accessFactory of [createNeighborhoodSaleWitnessReadAccess, createNeighborhoodCadEvidenceReadAccess]) {
        const foreign = createTestCachedReadAccess(request, { auth, accessFactory, transactionClosure: access.closure().transaction_closure });
        const issued = await foreign.prepare(), before = calls.length;
        await assert.rejects(reader.captureInSnapshot(observed, { ...prepared.request, auth,
          selection_grant: issued.selection_grant, market_grant: issued.market_grant }, { deadline }), foreignGrants);
        assert.equal(calls.length, before, 'foreign minted tokens cannot execute even the first snapshot query');
      }
      const result = await reader.captureInSnapshot(observed, { ...prepared.request, auth,
        selection_grant: prepared.selection_grant, market_grant: prepared.market_grant }, { deadline });
      assert.equal(result.status, 'captured', JSON.stringify(result.incomplete_reasons)); assert.equal(result.query_complete, true);
      assert.equal(result.source_capture.status, 'ready'); assert.deepEqual(result.snapshot, access.closure().snapshot);
      assert.equal(connects, 0); assert.equal(releases, 0);
      const trace = calls.slice(from), keys = trace.map(({ sql, values }) => ({
        tag: sql.match(/neighborhood-(?:cache|closure):([\w-]+)/)?.[0], values }));
      assert.ok(trace.filter(({ sql }) => sql.includes('/* neighborhood-cache:parcels */')).length > 1);
      assert.ok(trace.filter(({ sql }) => sql.includes('/* neighborhood-cache:accounts */')).length > 1);
      assert.deepEqual(recordsOf(result, 'selection').map(row => row.data.account_id).sort(compare), request.account_ids);
      assert.deepEqual(recordsOf(result, 'accounts').map(row => row.data.raw_projection.account_id).sort(compare), request.account_ids);
      assert.ok(recordsOf(result, 'sale_links').some(row => row.data.raw_projection.account_id === LINKED));
      assert.equal(recordsOf(result, 'transactions').length, 1);
      const parcelSql = trace.find(({ sql }) => sql.includes('/* neighborhood-cache:parcels */')).sql;
      if (mode === 'cad4') {
        assert.ok(parcelSql.includes('CASE WHEN octet_length(payload::text)<=64000 THEN payload ELSE NULL END'));
        baseline = result; baselineTrace = keys; baselineParcelSql = parcelSql; continue;
      }
      assert.deepEqual(keys, baselineTrace, 'combined projection preserves every authorized query tag, parameter, cursor and page boundary');
      const legacyGuard = 'CASE WHEN octet_length(payload::text)<=64000 THEN payload ELSE NULL END';
      const denseGuard = `CASE WHEN octet_length(payload::text)<=${DENSE_CAD_CACHE_READER_LIMITS.row_bytes}`
        + ` AND sum(octet_length(payload::text)) OVER ()<=${DENSE_CAD_SQL_PAGE_BYTES} THEN payload ELSE NULL END`;
      assert.equal(parcelSql, mode === 'dense5' ? baselineParcelSql.replace(legacyGuard, denseGuard) : baselineParcelSql,
        'exact CAD4 projection, membership and ordering remain unchanged; only dense parcel transport has extra headroom');
      if (mode === 'dense5') {
        denseParcelSql = parcelSql;
        const nonparcel = trace.filter(({ sql }) => sql.includes('/* neighborhood-cache:')
          && sql.includes('), encoded AS (') && !sql.includes('/* neighborhood-cache:parcels */'));
        assert.ok(nonparcel.length > 0);
        for (const { sql } of nonparcel) {
          assert.ok(sql.includes(`CASE WHEN octet_length(payload::text)<=64000 AND sum(octet_length(payload::text)) OVER ()<=${DENSE_CAD_SQL_PAGE_BYTES}`),
            'dense nonparcel projections retain their original 64KB row ceiling');
        }
      }
      assert.ok(trace.some(({ sql }) => sql.includes('/* neighborhood-cache:transactions */')
        && sql.includes(CACHED_SALE_WITNESS_V2_SQL) && sql.includes('src.mls_status AS source_mls_status') && sql.includes('src.source_row_number')));
      for (const role of ['parcels', 'accounts', 'transactions', 'sale_links']) {
        const originalRows = recordsOf(baseline, role), rows = recordsOf(result, role);
        assert.deepEqual(rows.map(row => row.record_id), originalRows.map(row => row.record_id));
        for (let index = 0; index < rows.length; index++) {
          const mapped = rows[index].data, original = originalRows[index].data;
          assert.deepEqual(plainData(mapped), plainData(original)); assert.deepEqual(mapped.capability_gaps, original.capability_gaps);
          assert.equal(mapped.data.cached_mapping_version, 5);
          assert.equal(mapped.data.cached_projection_sha256, assessmentEvidenceDigest({ mapping_version: 5,
            projection_kind: mapped.data.cached_projection_kind, raw_projection: mapped.raw_projection }));
          const withoutWitness = Object.fromEntries(Object.entries(mapped.raw_projection)
            .filter(([key]) => !['source_mls_status', 'source_row_number', 'source_raw_witness'].includes(key)));
          assert.deepEqual(withoutWitness, original.raw_projection);
          if (role === 'parcels') for (const key of CACHED_CAD_EVIDENCE_FIELDS) assert.ok(Object.hasOwn(mapped.raw_projection, key));
        }
      }
      const nativeWitness = (await client.query(`SELECT src.mls_status, src.source_row_number,
        ${CACHED_SALE_WITNESS_V2_SQL} AS witness FROM core.sales_source_records src
        WHERE src.id=10 AND src.primary_account_id=$1`, [ACCOUNT])).rows;
      assert.equal(nativeWitness.length, 1);
      const sale = recordsOf(result, 'transactions')[0].data, raw = sale.raw_projection;
      assert.equal(raw.source_record_id, '10'); assert.equal(raw.source_mls_status, nativeWitness[0].mls_status);
      assert.equal(raw.source_row_number, nativeWitness[0].source_row_number);
      assert.deepEqual(raw.source_raw_witness, prepareCachedSaleWitnessV2(nativeWitness[0].witness));
      assert.equal(raw.source_raw_witness.root_state, 'sql_null');
      for (const field of Object.values(raw.source_raw_witness.fields)) assert.deepEqual(field,
        { state: 'payload_unavailable', json_type: null, value_text: null, utf8_bytes: null });
      assert.equal(raw.source_current_price, '300000'); assert.equal(raw.sale_price, '400000');
      assert.equal(raw.source_close_date, '2024-03-01'); assert.equal(sale.data.market_eligible, null);
      assert.equal(sale.data.gla_sqft_at_sale, null); assert.equal(sale.data.historical_support, 'unknown');
      assert.ok(sale.capability_gaps.includes('canonical_source_price_conflict'));
      assert.ok(sale.capability_gaps.includes('sale_price_meaning_unverified'));
      assert.ok(result.unsupported_capabilities.includes('verified_market_eligibility'));
      assert.throws(() => consumeNeighborhoodCachedAcquisition(reader, structuredClone(result)), originalRequired);
      assert.throws(() => consumeNeighborhoodCachedAcquisition({}, result), originalRequired);
      const acquisition = consumeNeighborhoodCachedAcquisition(reader, result);
      assert.equal(acquisition.capture_result, result); assert.deepEqual(acquisition.captured_query_request, prepared.request);
      assert.equal(acquisition.provenance, 'original_cached_reader_invocation'); assert.equal(acquisition.authority, 'not_established');
      assert.ok(Object.isFrozen(acquisition)); assert.throws(() => consumeNeighborhoodCachedAcquisition(reader, result), originalRequired);
      const compact = JSON.parse(acquisition.compact_metadata_json);
      assert.equal(compact.mapping_version, 5); assert.equal(compact.reader_version, 'local-capture-v3');
      if (mode === 'dense5') assert.deepEqual(compact.limits, { ...DENSE_CAD_CACHE_READER_LIMITS, page_size: 1 });
      assert.deepEqual(describeNeighborhoodCombinedEvidenceMarketDataPurpose(acquisition.captured_query_request).source_projection, projection);
      const rebuilt = buildCohortLocalQueryEvidenceV1(acquisition.compact_metadata_json, JSON.stringify(request.account_ids), result.selection_sha256);
      assert.equal(rebuilt.status, 'syntax_valid'); assert.deepEqual(rebuilt.evidence, result.query_evidence);
      assert.equal(prepareCohortLocalQueryEvidenceV1(JSON.stringify(result.query_evidence)).status, 'syntax_valid');
      const manifest = createHash('sha256').update(acquisition.compact_metadata_json);
      for (const account of request.account_ids) manifest.update(canonicalAssessmentJson(account)).update('\n');
      assert.equal(manifest.digest('hex'), result.selection_sha256);
      const snapshots = new Map(result.source_capture.source_snapshots.map(value => [value.id, value]));
      const augmented = { ...compact, selection_sha256: result.selection_sha256, selected_account_count: request.account_ids.length };
      for (const source of result.source_capture.sources) {
        const { role, source_gaps, ...retainedMetadata } = source.payload.projection.definition;
        assert.deepEqual(retainedMetadata, augmented); assert.deepEqual(source_gaps, []);
        const digest = sha256(canonicalAssessmentJson(source.payload));
        assert.equal(snapshots.get(source.id)?.content_sha256, digest);
        assert.equal(source.id, `${source.payload.metadata.id}:${digest}`);
        const upstream = createHash('sha256').update(canonicalAssessmentJson(augmented));
        for (const row of recordsOf(result, role).toSorted((a, b) => compare(a.record_id, b.record_id))) upstream.update(canonicalAssessmentJson(row)).update('\n');
        assert.equal(source.payload.upstream.upstream_content_sha256, upstream.digest('hex'));
      }
    }
    await checkDenseParcelTransport(client, baselineParcelSql, denseParcelSql);
    const state = (await client.query(CACHED_TRANSACTION_SNAPSHOT_SQL)).rows[0];
    assert.equal(state.isolation, 'repeatable read'); assert.equal(state.read_only, 'on');
    assert.equal(state.snapshot, baseline.snapshot.snapshot); assert.equal(state.backend_pid, baseline.snapshot.backend_pid);
    assert.ok(calls.every(({ sql }) => !/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|BEGIN|COMMIT|ROLLBACK|SET)\b/i.test(sql)));
    assert.equal(connects, 0); assert.equal(releases, 0);
    checks.push('standard combined reader retains exact CAD4 SQL; dense reader changes only the bounded transport guard with exact authorized keysets in one RR/RO snapshot');
    checks.push('native dense transport preserves a valid >64KB exact geometry, retains legacy refusal, and withholds oversized rows and complete oversized pages');
    checks.push('native combined rows preserve every CAD4 typed/raw field and no-source currency/unit/price gaps; original source witness remains SQL-null');
    checks.push('foreign v3/v4 minted grants fail before queries; V5 original-only handoff and query/chunk/row hashes verify without retention or activation');
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
