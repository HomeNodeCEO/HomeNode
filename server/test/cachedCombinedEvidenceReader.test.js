import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json, assessmentEvidenceDigest } from '../src/services/neighborhoodAssessment/contract.js';
import { ASSESSMENT_SCOPE } from './fixtures/neighborhoodAssessmentFixture.js';
import { createTestCachedReadAccess } from './fixtures/neighborhoodCachedReadAccessFixture.js';
import { createCustomNeighborhoodSourcePolicy } from '../src/security/customNeighborhoodSourcePolicy.js';
import { createCustomCohortContextCapture } from '../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { CACHED_SALE_WITNESS_FIELDS } from '../src/services/neighborhoodAssessment/cachedSaleWitness.js';
import { CACHED_SALE_WITNESS_V2_FIELDS, CACHED_SALE_WITNESS_V2_SQL } from '../src/services/neighborhoodAssessment/cachedSaleWitnessV2.js';
import { CACHED_CAD_EVIDENCE_FIELDS } from '../src/services/neighborhoodAssessment/cachedRowMappingsV4.js';
import { DENSE_CAD_CACHE_READER_LIMITS } from '../src/services/neighborhoodAssessment/denseCadCapturePolicy.js';
import { createNeighborhoodCachedReadAccess, createNeighborhoodSaleWitnessReadAccess, createNeighborhoodCadEvidenceReadAccess,
  createNeighborhoodCombinedEvidenceReadAccess, assertNeighborhoodCachedReadAccess, consumeNeighborhoodCachedReadAccess,
  describeNeighborhoodCachedMarketDataPurpose, describeNeighborhoodSaleWitnessMarketDataPurpose,
  describeNeighborhoodCombinedEvidenceMarketDataPurpose } from '../src/services/neighborhoodAssessment/cachedReadAccess.js';
import { createNeighborhoodCachedSourceReader, createNeighborhoodSaleWitnessSourceReader, createNeighborhoodCadEvidenceSourceReader,
  createNeighborhoodDenseCadEvidenceSourceReader, createNeighborhoodCombinedEvidenceSourceReader,
  createNeighborhoodDenseCombinedEvidenceSourceReader, consumeNeighborhoodCachedAcquisition,
  NEIGHBORHOOD_CACHE_READER_LIMITS } from '../src/services/neighborhoodAssessment/cachedSourceReader.js';

const copy = value => structuredClone(value), sha = value => createHash('sha256').update(value).digest('hex');
const A = ASSESSMENT_SCOPE.account_id, OUTSIDE = 'SYNTHETIC-OUTSIDE', RUN = '60000000-0000-4000-8000-000000000001';
const NOW = '2026-09-05T12:00:00.000Z', PRECISE = '2026-09-05T12:00:00.000000Z';
const FIELDS = [...CACHED_SALE_WITNESS_FIELDS, 'PriceCurrency', 'CurrentPriceCurrency', 'ClosePriceCurrency'];
const PROJECTION = { id: 'cached-combined-evidence-v1', mapping_version: 5, witness_version: 2, fields: FIELDS };
const permit = () => ({ allowed: true, decision_id: 'synthetic-combined-only', policy_revision: 'synthetic-combined-v1' });
const denied = reason => error => error.code === 'NEIGHBORHOOD_CACHED_READ_ACCESS_DENIED' && error.reason === reason;
const accessFactories = { 2: createNeighborhoodCachedReadAccess, 3: createNeighborhoodSaleWitnessReadAccess,
  4: createNeighborhoodCadEvidenceReadAccess, 5: createNeighborhoodCombinedEvidenceReadAccess };
const readerFactories = { 2: createNeighborhoodCachedSourceReader, 3: createNeighborhoodSaleWitnessSourceReader,
  4: createNeighborhoodCadEvidenceSourceReader, 5: createNeighborhoodCombinedEvidenceSourceReader };
const request = (account_ids = [A]) => ({ scope: { ...ASSESSMENT_SCOPE }, effective_date: '2024-06-30',
  observation_period: { start_date: '2023-07-01', end_date: '2024-06-30' }, account_ids, knowledge_cutoff: null });
const accessFixture = (version = 5, options = {}) => createTestCachedReadAccess(request(), {
  accessFactory: accessFactories[version], authorizeMarketData: async (_auth, _context, purpose) => {
    if (version === 5) assert.deepEqual(purpose.source_projection, PROJECTION);
    return permit();
  }, ...options });
const tokens = issued => ({ selection_grant: issued.selection_grant, market_grant: issued.market_grant });
const inputFor = (access, issued) => ({ ...issued.request, auth: access.auth, ...tokens(issued) });
const consume = (access, issued, version = 5) => consumeNeighborhoodCachedReadAccess(access.access, access.auth, issued.request, tokens(issued), version);

test('combined access pins mapping5, witness2 and all 31 literal fields without changing older purposes', async () => {
  const f = accessFixture(), issued = await f.prepare();
  assert.equal(assertNeighborhoodCachedReadAccess(f.access, 5), f.access);
  const base = describeNeighborhoodCachedMarketDataPurpose(issued.request);
  const old = describeNeighborhoodSaleWitnessMarketDataPurpose(issued.request);
  const combined = describeNeighborhoodCombinedEvidenceMarketDataPurpose(issued.request);
  assert.deepEqual(combined, { ...base, source_projection: PROJECTION });
  assert.deepEqual(CACHED_SALE_WITNESS_V2_FIELDS, FIELDS); assert.equal(FIELDS.length, 31);
  assert.equal(old.source_projection.mapping_version, 3); assert.equal(old.source_projection.witness_version, 1);
  assert.deepEqual(old.source_projection.fields, CACHED_SALE_WITNESS_FIELDS);
  assert.equal(Object.hasOwn(base, 'source_projection'), false);
  for (const value of [combined, combined.source_projection, combined.source_projection.fields]) assert.ok(Object.isFrozen(value));
  assert.throws(() => combined.source_projection.fields.push('PrivateRemarks'), TypeError);
  assert.deepEqual(consume(f, issued), issued.request);
  assert.throws(() => consume(f, issued), denied('original_matching_grants_required'));
});

for (const version of [2, 3, 4]) test(`mapping${version} and combined capabilities cannot authorize each other's readers`, async () => {
  const old = accessFixture(version), combined = accessFixture(), oldGrant = await old.prepare(), next = await combined.prepare();
  let connects = 0; const pool = { async connect() { connects++; assert.fail('wrong capability reached pool'); } };
  assert.throws(() => createNeighborhoodCombinedEvidenceSourceReader(pool, { access: old.access }), denied('mapping_profile_mismatch'));
  assert.throws(() => createNeighborhoodDenseCombinedEvidenceSourceReader(pool, { access: old.access }), denied('mapping_profile_mismatch'));
  assert.throws(() => readerFactories[version](pool, { access: combined.access }), denied('mapping_profile_mismatch'));
  if (version === 4) assert.throws(() => createNeighborhoodDenseCadEvidenceSourceReader(pool, { access: combined.access }), denied('mapping_profile_mismatch'));
  let inspected = false; const hostile = { get scope() { inspected = true; assert.fail('wrong mapping inspected request'); } };
  assert.throws(() => consumeNeighborhoodCachedReadAccess(combined.access, combined.auth, hostile, tokens(next), version), denied('mapping_profile_mismatch'));
  assert.equal(inspected, false); assert.equal(connects, 0);
  assert.deepEqual(consume(old, oldGrant, version), oldGrant.request); assert.deepEqual(consume(combined, next), next.request);
});

test('mapping5 tokens cannot cross issuers, mix pairs, survive copying, or use omitted/unsupported versions', async () => {
  const a = accessFixture(), b = accessFixture(), pa = await a.prepare(), pb = await b.prepare();
  let connects = 0; const reader = createNeighborhoodCombinedEvidenceSourceReader({ async connect() { connects++; assert.fail('unauthorized read'); } }, { access: a.access });
  for (const grants of [tokens(pb), copy(tokens(pa)), { selection_grant: pa.selection_grant, market_grant: pb.market_grant }]) {
    await assert.rejects(reader.capture({ ...pa.request, auth: a.auth, ...grants }), denied('original_matching_grants_required'));
  }
  for (const version of [undefined, 1, 6, null, '5']) {
    assert.throws(() => assertNeighborhoodCachedReadAccess(a.access, version), denied('mapping_profile_mismatch'));
    assert.throws(() => consumeNeighborhoodCachedReadAccess(a.access, a.auth, pa.request, tokens(pa), version), denied('mapping_profile_mismatch'));
  }
  assert.throws(() => createNeighborhoodCombinedEvidenceSourceReader({ connect() {} }, { access: { ...a.access } }), denied('authority_required'));
  assert.equal(connects, 0); consume(a, pa); consume(b, pb);
});

test('callers cannot choose the combined version/purpose/field list in preparation or capture input', async () => {
  const f = accessFixture();
  for (const injected of [{ mapping_version: 5 }, { source_projection: PROJECTION }, { fields: ['Currency'] }]) {
    await assert.rejects(f.access.prepare(f.auth, { ...f.prepareInput, ...injected }), denied('prepare.unknown_key'));
  }
  const issued = await f.prepare(); let connects = 0;
  const reader = createNeighborhoodCombinedEvidenceSourceReader({ async connect() { connects++; assert.fail('invalid request reached pool'); } }, { access: f.access });
  await assert.rejects(reader.capture({ ...inputFor(f, issued), source_projection: { ...PROJECTION, fields: ['Currency'] } }), denied('request.unknown_key'));
  assert.equal(connects, 0); consume(f, issued);
});

for (const wrong of [{ ...PROJECTION, mapping_version: 4 }, { ...PROJECTION, witness_version: 1 },
  { ...PROJECTION, fields: CACHED_SALE_WITNESS_FIELDS }]) test(`only exact combined purpose can pass synthetic policy ${JSON.stringify(wrong).slice(0, 95)}`, async () => {
  let closureReads = 0;
  const f = accessFixture(5, { authorizeMarketData: async (_auth, _context, purpose) => ({ ...permit(),
    allowed: json(purpose.source_projection) === json(wrong) }), resolveTransactionClosure: async () => { closureReads++; assert.fail('wrong-purpose approval'); } });
  await assert.rejects(f.prepare(), denied('market_data_access_denied')); assert.equal(closureReads, 0);
});

test('current production policy denies the combined purpose before policy SQL or transaction closure reads', async () => {
  const policy = createCustomNeighborhoodSourcePolicy({ datasetRevision: 'synthetic-current-dataset',
    providerRevisions: [{ provider_id: 'synthetic-provider', revision: 'synthetic-terms' }] });
  let sql = 0, closure = 0;
  const client = { async query() { sql++; assert.fail('expanded purpose must fail before policy queries'); } };
  const f = accessFixture(5, { authorizeMarketData: async (auth, context, purpose) => {
    for (const exposure of ['none', 'report_observation_summary', 'report_observation_members', 'report_observation_catalog']) {
      assert.deepEqual(await policy(client, auth, context, purpose, { retention: true, exposure }), { allowed: false });
    }
    return { allowed: false };
  }, resolveTransactionClosure: async () => { closure++; assert.fail('production denial must precede closure'); } });
  await assert.rejects(f.prepare(), denied('market_data_access_denied')); assert.equal(sql, 0); assert.equal(closure, 0);
});

test('owner source mode is trusted configuration, never a browser capture override', async () => {
  // Actual issuance/replay is covered by the native owner suite and the
  // Witness2 reported-owner tests; no source-text pattern stands in for it.
  let connections = 0;
  const dependencies = { pool: { connect() { connections++; assert.fail('no checkout'); } },
    authorizeMarketData() { assert.fail('no policy call'); } };
  for (const sourceMode of [undefined, 'cad4', 'combined-witness2-v1']) {
    const owner = createCustomCohortContextCapture({ ...dependencies, ...(sourceMode ? { sourceMode } : {}) });
    for (const key of ['sourceMode', 'source_mode', 'reported_sale_interpretation']) {
      await assert.rejects(owner.capture({ auth: { userId: 'synthetic', organizations: [] }, accountId: A,
        assignmentFileId: '10', operationId: RUN, observationPeriod: { start_date: '2024-01-01', end_date: '2024-12-31' },
        [key]: 'combined-witness2-v1' }), /invalid_input/);
    }
  }
  for (const sourceMode of [null, '', 5, 'combined', 'cad3', {}, []]) {
    assert.throws(() => createCustomCohortContextCapture({ ...dependencies, sourceMode }), /source_mode_invalid/);
  }
  assert.equal(connections, 0);
});

const readerText = readFileSync(new URL('../src/services/neighborhoodAssessment/cachedSourceReader.js', import.meta.url), 'utf8');
const catalog = [...readerText.slice(readerText.indexOf('const TABLES'), readerText.indexOf('const SQL'))
  .matchAll(/\['([a-z_]+\.[a-z_]+)', '([^']+)'\]/g)].flatMap(([, relation, columns]) => columns.split(' ').map(column => ({ relation, column })));
const cad = () => ({ class_code: ' 01 ', class_description: 'Résidence', use_description: '', structure_type: null, built_up: false });
const rawFacts = () => ({ ClosePrice: '280000.0000', CurrentPrice: '990000.0100', Currency: 'USD', PriceCurrency: 'CAD',
  CurrentPriceCurrency: 'EUR', ClosePriceCurrency: '', LivingArea: '166.45', LivingAreaUnits: 'm²', LotSizeUnits: 'Acres' });
// Literal query-result witness, not a database/JSONB lexical fidelity claim.
function witness(version, raw) {
  return { witness_version: version, root_state: 'object', root_json_type: 'object',
    fields: Object.fromEntries((version === 2 ? FIELDS : CACHED_SALE_WITNESS_FIELDS).map(key => [key, !Object.hasOwn(raw, key)
      ? { state: 'absent', json_type: null, value_text: null, utf8_bytes: null }
      : raw[key] === null ? { state: 'json_null', json_type: 'null', value_text: null, utf8_bytes: null }
        : { state: 'scalar', json_type: typeof raw[key], value_text: String(raw[key]), utf8_bytes: Buffer.byteLength(String(raw[key])) }])) };
}
async function captureFixture({ version = 5, dense = false, owner = false, limits = {}, missingColumn,
  raw = rawFacts(), mutateSale = () => {}, drift = false, accountCount = 1, oversizedRow = false } = {}) {
  const accounts = [A, ...Array.from({ length: accountCount - 1 }, (_, i) => `DENSE-${String(i).padStart(6, '0')}`)].sort();
  const parcels = accounts.map((account_id, index) => ({ object_id: String(9007199254740993n + BigInt(index)), account_id,
    residential_year_built: 2001, residential_area_sqft: '1800.125', parcel_area_sqft: '8000', current_market_value: '300000',
    source_record_hash: 'a'.repeat(64), sync_run_id: RUN, synced_at: NOW, source_updated_at: null,
    stored_geometry_ewkb: '010203', ...(version >= 4 ? cad() : {}) }));
  const transaction = { source_record_id: '10', sale_id: '20', primary_account_id: A, sale_account_id: A, source_record_hash: 'b'.repeat(64) };
  const association = { parcel_link_id: '100', source_record_id: '10', source_position: 1, parcel_sequence: 1, account_id: OUTSIDE, is_resolved: true };
  const legacyIdentity = { sale_id: '22', sale_account_id: A };
  const closure = { selected_account_ids: accounts, source_revision: 'synthetic-same-snapshot', transactions: [transaction], links: [association], legacy: [legacyIdentity] };
  const sale = { ...transaction, source_name: 'synthetic-csv', source_filename: 'new-evidence.csv', source_sha256: 'c'.repeat(64),
    record_type: 'closed_sale', sale_closing_date: '2020-03-01', source_close_date: '2020-03-01',
    sale_price: '300000.00', source_current_price: '325000.00', source_living_area: '1800.125', source_lot_size_area: '8000',
    ...(version === 3 || version === 5 ? { source_mls_status: 'Closed', source_row_number: 0,
      source_raw_witness: witness(version === 5 ? 2 : 1, raw) } : {}) };
  mutateSale(sale);
  const legacy = { ...legacyIdentity, source_record_id: null, sale_price: '290000.00', sale_closing_date: '2019-01-01' };
  const originalRows = { parcels, sale, legacy }, originalJson = JSON.stringify(originalRows);
  const access = createTestCachedReadAccess(request(accounts), { accessFactory: accessFactories[version], transactionClosure: closure,
    authorizeMarketData: async (_auth, _context, purpose) => { if (version === 5) assert.deepEqual(purpose.source_projection, PROJECTION); return permit(); } });
  const issued = await access.prepare(), calls = [], releases = []; let connects = 0;
  const client = { release(error) { releases.push(error); }, async query(config) {
    const text = typeof config === 'string' ? config : config.text, v = config.values ?? [];
    const tag = text.match(/neighborhood-cache:([\w-]+)/)?.[1] ?? (text === 'ROLLBACK' ? 'rollback' : null);
    calls.push({ tag, text, values: copy(v) });
    if (['begin', 'settings', 'commit', 'rollback'].includes(tag)) return { rows: [] };
    if (tag === 'caller-snapshot') return { rows: [{ backend_pid: 123, snapshot: '100:100:',
      transaction_started_at: '2026-09-05T11:59:59.000000Z', isolation: 'repeatable read', read_only: 'on', explicit_transaction: true,
      timezone: 'UTC', statement_ms: 5000, lock_ms: 1000, idle_ms: 10000 }] };
    if (tag === 'scope') return { rows: [{ case_date: '2024-06-30', snapshot_date: '2024-06-30', effective_date: '2024-06-30',
      captured_at: NOW, captured_at_precise: PRECISE }] };
    if (tag === 'capabilities') return { rows: [...catalog,
      ...(version >= 4 ? CACHED_CAD_EVIDENCE_FIELDS.map(column => ({ relation: 'gis.dcad_parcels', column })) : []),
      ...(version === 3 || version === 5 ? ['mls_status', 'source_row_number', 'raw_payload'].map(column => ({ relation: 'core.sales_source_records', column })) : [])]
      .filter(row => row.column !== missingColumn) };
    let rows;
    if (tag === 'parcels') rows = parcels.filter(p => v[0].includes(p.account_id) && BigInt(p.object_id) > BigInt(v[1])).slice(0, v[2]);
    else if (tag === 'accounts') rows = accounts.filter(id => v[0].includes(id) && id > v[1]).slice(0, v[2])
      .map(account_id => ({ account_id, county: 'Dallas', subdivision: '  Synthetic plat  ' }));
    else if (tag === 'sync-state') rows = [{ source_key: 'dcad_parcels', status: 'current', row_count: String(accountCount), last_run_id: RUN, last_success_at: NOW }];
    else if (tag === 'sync-runs') rows = [{ id: RUN, source_key: 'dcad_parcels', status: 'complete', mode: 'full', started_at: '2026-09-05T11:00:00.000Z', completed_at: NOW }];
    else if (tag === 'source-ids') rows = v[1] === '0' ? [{ source_record_id: '10' }] : [];
    else if (tag === 'transaction-identities') rows = [transaction];
    else if (tag === 'link-identities') rows = v[1] === '0' ? [{ ...association, ...(drift ? { account_id: 'DRIFT-OUTSIDE' } : {}) }] : [];
    else if (tag === 'legacy-identities') rows = v[1] === '0' ? [legacyIdentity] : [];
    else if (tag === 'transactions') rows = [sale];
    else if (tag === 'sale-links') rows = v[1] === '0' ? [association] : [];
    else if (tag === 'legacy') rows = v[1] === '0' ? [legacy] : [];
    else assert.fail(`Unexpected synthetic query ${tag}`);
    return { rows: rows.map(payload => ({ payload: oversizedRow && tag === 'transactions' ? null : payload,
      row_bytes: oversizedRow && tag === 'transactions' ? 64_001 : Buffer.byteLength(JSON.stringify(payload)) })) };
  } };
  const factory = dense ? createNeighborhoodDenseCombinedEvidenceSourceReader : readerFactories[version];
  const reader = factory({ async connect() { connects++; return client; } }, { access: access.access, limits });
  const result = owner ? await reader.captureInSnapshot(client, inputFor(access, issued)) : await reader.capture(inputFor(access, issued));
  assert.equal(JSON.stringify(originalRows), originalJson, 'mapping/chunk finalization must not rewrite supplied rows');
  return { result, reader, calls, releases, connects, originalRows, accounts };
}
const records = (result, role) => result.source_capture.sources.filter(s => s.payload.projection.definition.role === role).flatMap(s => s.payload.records);
const normal = wrapper => Object.fromEntries(Object.entries(wrapper.data).filter(([key]) => !['cached_mapping_version', 'cached_projection_sha256'].includes(key)));

for (const dense of [false, true]) test(`opt-in ${dense ? 'dense' : 'ordinary'} mapping5 retains CAD, raw metadata and exact whole-source bindings`, async () => {
  const f = await captureFixture({ dense }); assert.equal(f.result.status, 'captured', JSON.stringify(f.result.incomplete_reasons));
  assert.equal(f.result.source_capture.status, 'ready'); assert.equal(f.result.query_complete, true);
  for (const [role, kind] of [['parcels', 'parcel'], ['accounts', 'account'], ['transactions', 'sale'], ['sale_links', 'sale_link']]) {
    for (const row of records(f.result, role)) {
      assert.equal(row.data.data.cached_mapping_version, 5);
      assert.equal(row.data.data.cached_projection_sha256, assessmentEvidenceDigest({ mapping_version: 5, projection_kind: kind, raw_projection: row.data.raw_projection }));
    }
  }
  const parcel = records(f.result, 'parcels')[0].data, sale = records(f.result, 'transactions').find(r => r.record_id === 'source:10').data;
  for (const key of CACHED_CAD_EVIDENCE_FIELDS) assert.equal(parcel.raw_projection[key], cad()[key]);
  for (const [key, value] of Object.entries(rawFacts())) assert.equal(sale.raw_projection.source_raw_witness.fields[key].value_text, value);
  assert.equal(sale.raw_projection.source_filename, 'new-evidence.csv'); assert.equal(sale.raw_projection.source_sha256, 'c'.repeat(64));
  assert.equal(sale.raw_projection.source_row_number, 0); assert.equal(sale.raw_projection.source_mls_status, 'Closed');
  assert.equal(sale.raw_projection.source_raw_witness.fields.CloseDate.state, 'absent');
  assert.equal(sale.raw_projection.sale_closing_date, '2020-03-01', 'analytic period is not a source read filter');
  const legacy = records(f.result, 'transactions').find(r => r.record_id === 'legacy:22').data;
  for (const key of ['source_raw_witness', 'source_row_number', 'source_mls_status']) assert.equal(Object.hasOwn(legacy.raw_projection, key), false);
  assert.ok(legacy.capability_gaps.includes('source_record_unavailable'));
  assert.equal(records(f.result, 'sale_links')[0].data.raw_projection.account_id, OUTSIDE);
  for (const call of f.calls.filter(c => ['parcels', 'accounts', 'source-ids', 'legacy'].includes(c.tag))) assert.deepEqual(call.values[0], [A]);
  for (const source of f.result.source_capture.sources) assert.equal(source.id.split(':').at(-1), sha(json(source.payload)));
  const acquisition = consumeNeighborhoodCachedAcquisition(f.reader, f.result), compact = JSON.parse(acquisition.compact_metadata_json);
  assert.equal(compact.mapping_version, 5); assert.deepEqual(compact.limits, dense ? DENSE_CAD_CACHE_READER_LIMITS : NEIGHBORHOOD_CACHE_READER_LIMITS);
  assert.deepEqual(acquisition.captured_query_request.transaction_closure.closure_account_ids, [OUTSIDE, A].sort());
  assert.throws(() => consumeNeighborhoodCachedAcquisition(f.reader, f.result));
  assert.ok(Object.isFrozen(f.result) && Object.isFrozen(sale.raw_projection.source_raw_witness.fields));
  f.originalRows.sale.source_raw_witness.fields.Currency.value_text = 'mutated-after-capture';
  assert.equal(sale.raw_projection.source_raw_witness.fields.Currency.value_text, 'USD');
  assert.equal(f.connects, 1); assert.equal(f.releases.length, 1); assert.ok(f.calls.some(c => c.tag === 'commit'));
});

test('combined SQL preserves the CAD4 parcel projection, witness sale join, keysets and all older default observations', async () => {
  const runs = new Map(); for (const version of [2, 3, 4, 5]) runs.set(version, await captureFixture({ version }));
  for (const f of runs.values()) assert.equal(f.result.status, 'captured', JSON.stringify(f.result.incomplete_reasons));
  const next = runs.get(5), saleSql = next.calls.find(c => c.tag === 'transactions').text;
  assert.equal(next.calls.find(c => c.tag === 'parcels').text, runs.get(4).calls.find(c => c.tag === 'parcels').text);
  assert.ok(saleSql.includes(CACHED_SALE_WITNESS_V2_SQL));
  assert.match(saleSql, /FROM core\.sales_source_records src LEFT JOIN core\.sales sale ON sale\.source_record_id=src\.id/);
  assert.match(saleSql, /WHERE src\.id=ANY\(\$1::bigint\[\]\) ORDER BY src\.id,sale\.id LIMIT \$2/);
  assert.doesNotMatch(saleSql, /src\.raw_payload\s+AS\s+(?:raw_payload|source_raw_payload)/);
  for (const version of [2, 3, 4]) {
    const old = runs.get(version);
    for (const role of ['parcels', 'accounts', 'transactions', 'sale_links']) {
      assert.deepEqual(records(next.result, role).map(r => normal(r.data)), records(old.result, role).map(r => normal(r.data)));
      assert.deepEqual(records(next.result, role).map(r => r.data.capability_gaps), records(old.result, role).map(r => r.data.capability_gaps));
    }
    assert.equal(old.calls.some(c => c.tag === 'transactions' && c.text.includes(CACHED_SALE_WITNESS_V2_SQL)), false);
  }
  assert.equal(runs.get(2).calls.find(c => c.tag === 'transactions').text, runs.get(4).calls.find(c => c.tag === 'transactions').text);
});

test('newer raw units/currency/ClosePrice do not change surviving typed values or fill missing same-payload facts', async () => {
  const first = await captureFixture(), raw = { CurrentPrice: '', Currency: null, LivingAreaUnits: 'SquareMeters', ClosePriceCurrency: 'JPY' };
  const second = await captureFixture({ raw });
  const sale = f => records(f.result, 'transactions').find(r => r.record_id === 'source:10').data;
  assert.deepEqual(normal(sale(first)), normal(sale(second))); assert.deepEqual(sale(first).capability_gaps, sale(second).capability_gaps);
  assert.equal(sale(second).raw_projection.source_current_price, '325000.00'); assert.equal(sale(second).raw_projection.source_living_area, '1800.125');
  const fields = sale(second).raw_projection.source_raw_witness.fields;
  assert.equal(fields.ClosePrice.state, 'absent'); assert.equal(fields.CurrentPrice.value_text, '');
  assert.equal(fields.Currency.state, 'json_null'); assert.equal(fields.LivingArea.state, 'absent'); assert.equal(fields.CloseDate.state, 'absent');
  assert.notEqual(sale(first).data.cached_projection_sha256, sale(second).data.cached_projection_sha256);
  assert.equal(first.result.selection_sha256, second.result.selection_sha256, 'unchanged query/selection metadata must not be relabeled');
  assert.notDeepEqual(first.result.source_capture.sources.filter(s => s.payload.projection.definition.role === 'transactions').map(s => s.id),
    second.result.source_capture.sources.filter(s => s.payload.projection.definition.role === 'transactions').map(s => s.id), 'changed original evidence must change complete source hashes');
});

for (const column of [...CACHED_CAD_EVIDENCE_FIELDS, 'mls_status', 'source_row_number', 'raw_payload']) {
  test(`combined missing required ${column} refuses the complete capture`, async () => {
    const f = await captureFixture({ missingColumn: column });
    assert.equal(f.result.status, 'incomplete'); assert.equal(f.result.source_capture, null);
    assert.ok(f.result.incomplete_reasons.some(r => r.endsWith(':unsupported_schema')));
    const role = CACHED_CAD_EVIDENCE_FIELDS.includes(column) ? 'parcels' : 'transactions';
    assert.equal(f.calls.some(c => c.tag === role), false); assert.throws(() => consumeNeighborhoodCachedAcquisition(f.reader, f.result));
  });
}

for (const [label, mutateSale] of [['old witness', sale => { sale.source_raw_witness = witness(1, rawFacts()); }],
  ['overflow sentinel', sale => { sale.source_raw_witness = null; }], ['missing witness', sale => { delete sale.source_raw_witness; }]]) {
  test(`combined ${label} cannot return a partial source capture`, async () => {
    const f = await captureFixture({ mutateSale }); assert.equal(f.result.status, 'incomplete'); assert.equal(f.result.source_capture, null);
    assert.deepEqual(f.result.incomplete_reasons, ['source_query_unavailable']); assert.ok(f.calls.some(c => c.tag === 'rollback'));
    assert.equal(f.releases.length, 1); assert.throws(() => consumeNeighborhoodCachedAcquisition(f.reader, f.result));
  });
}

test('combined independent association drift refuses before any MLS/price projection', async () => {
  const f = await captureFixture({ drift: true }); assert.equal(f.result.status, 'incomplete'); assert.equal(f.result.source_capture, null);
  assert.deepEqual(f.result.incomplete_reasons, ['transaction_association_drift']);
  assert.equal(f.calls.some(c => ['transactions', 'sale-links', 'legacy'].includes(c.tag)), false);
});

for (const dense of [false, true]) test(`combined ${dense ? 'dense' : 'ordinary'} retains exact row/record bounds and whole-result refusal`, async () => {
  for (const options of [{ limits: { records: 1 } }, { oversizedRow: true }]) {
    const f = await captureFixture({ dense, ...options }); assert.equal(f.result.status, 'incomplete'); assert.equal(f.result.source_capture, null);
    assert.deepEqual(f.result.incomplete_reasons, [options.oversizedRow ? 'row_bytes_limit' : 'record_limit']);
  }
  const access = accessFixture(), factory = dense ? createNeighborhoodDenseCombinedEvidenceSourceReader : createNeighborhoodCombinedEvidenceSourceReader;
  const maximum = dense ? DENSE_CAD_CACHE_READER_LIMITS : NEIGHBORHOOD_CACHE_READER_LIMITS;
  for (const [key, value] of Object.entries(maximum)) assert.throws(() => factory({ connect() { assert.fail('limit setup cannot query'); } },
    { access: access.access, limits: { [key]: value + 1 } }), /invalid_neighborhood_cache_reader:limits/);
});

test('caller-owned combined dense read preserves all RR/RO probes without owning transaction cleanup', async () => {
  const f = await captureFixture({ dense: true, owner: true }); assert.equal(f.result.status, 'captured', JSON.stringify(f.result.incomplete_reasons));
  assert.equal(f.connects, 0); assert.equal(f.releases.length, 0);
  assert.equal(f.calls.some(c => ['begin', 'settings', 'commit', 'rollback'].includes(c.tag)), false);
  assert.equal(f.calls.filter(c => c.tag === 'caller-snapshot').length, 3);
});

test('dense combined reader retains the existing 1000-account batches without adding linked-only CAD accounts', async () => {
  const f = await captureFixture({ dense: true, accountCount: 1001 }); assert.equal(f.result.status, 'captured', JSON.stringify(f.result.incomplete_reasons));
  for (const tag of ['parcels', 'accounts']) {
    const batches = f.calls.filter(c => c.tag === tag && c.values[1] === (tag === 'parcels' ? '-1' : ''));
    assert.deepEqual(batches.map(c => c.values[0].length), [1000, 1]);
    assert.deepEqual(batches.flatMap(c => c.values[0]), f.accounts); assert.ok(batches.every(c => !c.values[0].includes(OUTSIDE)));
  }
  assert.equal(records(f.result, 'selection').length, 1001); assert.equal(records(f.result, 'parcels').length, 1001);
  assert.equal(records(f.result, 'accounts').length, 1001);
});
