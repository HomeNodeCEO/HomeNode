import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json, assessmentEvidenceDigest } from '../src/services/neighborhoodAssessment/contract.js';
import { CACHED_CAD_EVIDENCE_FIELDS as FIELDS, CACHED_CAD_EVIDENCE_LIMITS as LIMITS,
  CACHED_CAD_EVIDENCE_MAPPING_VERSION, mapCadEvidenceParcelRow, mapCadEvidenceAccountRow,
  mapCadEvidenceSaleRow, mapCadEvidenceSaleLinkRow } from '../src/services/neighborhoodAssessment/cachedRowMappingsV4.js';
import { mapCachedParcelRow, mapCachedAccountRow, mapCachedSaleRow, mapCachedSaleLinkRow } from '../src/services/neighborhoodAssessment/cachedRowMappings.js';
import { createNeighborhoodCachedReadAccess, createNeighborhoodSaleWitnessReadAccess,
  createNeighborhoodCadEvidenceReadAccess, consumeNeighborhoodCachedReadAccess,
  describeNeighborhoodCachedMarketDataPurpose, describeNeighborhoodSaleWitnessMarketDataPurpose } from '../src/services/neighborhoodAssessment/cachedReadAccess.js';
import { createNeighborhoodCachedSourceReader, createNeighborhoodSaleWitnessSourceReader,
  createNeighborhoodCadEvidenceSourceReader, consumeNeighborhoodCachedAcquisition } from '../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { createTestCachedReadAccess } from './fixtures/neighborhoodCachedReadAccessFixture.js';
import { ASSESSMENT_SCOPE } from './fixtures/neighborhoodAssessmentFixture.js';

const sha = text => createHash('sha256').update(text).digest('hex');
const directory = new URL('../src/services/neighborhoodAssessment/', import.meta.url);
const readerText = readFileSync(new URL('cachedSourceReader.js', directory), 'utf8');
const baseCatalog = [...readerText.slice(readerText.indexOf('const TABLES'), readerText.indexOf('const SQL'))
  .matchAll(/\['([a-z_]+\.[a-z_]+)', '([^']+)'\]/g)].flatMap(([, relation, columns]) => columns.split(' ').map(column => ({ relation, column })));
const A = ASSESSMENT_SCOPE.account_id, RUN = '60000000-0000-4000-8000-000000000001';
const NOW = '2026-09-05T12:00:00.000Z', PRECISE = '2026-09-05T12:00:00.000000Z';
const extras = () => ({ class_code: ' 01 ', class_description: 'Single family residence',
  use_description: '', structure_type: null, built_up: false });
const baseParcel = () => ({ object_id: '9007199254740993', account_id: A, low_parcel_id: '000001',
  residential_year_built: 2001, residential_area_sqft: '1800.125', current_market_value: '300000',
  parcel_area_sqft: '8000', land_use_category: 'one_unit', source_record_hash: 'a'.repeat(64),
  sync_run_id: RUN, synced_at: NOW, source_updated_at: null, stored_geometry_ewkb: '010203' });
const parcel = () => ({ ...baseParcel(), ...extras() });
const account = () => ({ account_id: A, county: 'Dallas', subdivision: '  Recorded plat  ', legal_description: null });
const sale = () => ({ source_record_id: '10', sale_id: '20', primary_account_id: A, sale_account_id: A,
  source_record_hash: 'b'.repeat(64), record_type: 'closed_sale', sale_closing_date: '2020-03-01', source_close_date: '2020-03-01',
  sale_price: '300000.00', source_current_price: '325000.00', source_living_area: '1800.125', source_days_on_market: 0,
  source_garage_yn: false, source_housing_type: 'Single family' });
const link = () => ({ parcel_link_id: '100', source_record_id: '10', source_position: 1, parcel_sequence: 1,
  account_id: 'R-OUTSIDE', is_resolved: true, match_method: 'exact' });
const request = () => ({ scope: { ...ASSESSMENT_SCOPE }, effective_date: '2024-06-30',
  observation_period: { start_date: '2023-07-01', end_date: '2024-06-30' }, account_ids: [A], knowledge_cutoff: null });
const normal = result => Object.fromEntries(Object.entries(result.data).filter(([key]) => !['cached_mapping_version', 'cached_projection_sha256'].includes(key)));
const error = reason => e => e.code === 'NEIGHBORHOOD_CACHED_CAD_EVIDENCE_ROW_INVALID' && e.reason === reason;
const frozenTree = value => { if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozenTree); } };

test('fixed original v2/v3 mapper source and original SQL block stay unchanged apart from checkout line endings', () => {
  // Source-text regression only. Retained capture digests are never normalized.
  const sourceHash = text => sha(text.replace(/\r\n/g, '\n'));
  assert.equal(sourceHash(readFileSync(new URL('cachedRowMappings.js', directory), 'utf8')), '484eb6caa1cbee21fd91b7765701e810a3db0fd3d8dcf1c670303a5cf213fa98');
  assert.equal(sourceHash(readFileSync(new URL('cachedRowMappingsV3.js', directory), 'utf8')), '9eef4ec1d2cc40715ab13736c787b40f9cf42533837261599b58ca1a77776a61');
  assert.equal(sourceHash(readerText.slice(readerText.indexOf('const SQL'), readerText.indexOf('const ORDER'))), 'eaf5679948e6269e35d559dce4c9be501899d8e68b0e9cb3302b2f01a547d192');
});

test('v4 parcel adds exactly five literal observations and versions only the mapping digest', () => {
  const original = mapCachedParcelRow(baseParcel()), input = parcel(), result = mapCadEvidenceParcelRow(input);
  assert.equal(CACHED_CAD_EVIDENCE_MAPPING_VERSION, 4); assert.equal(result.record_id, original.record_id);
  assert.deepEqual(normal(result), normal(original)); assert.deepEqual(result.capability_gaps, original.capability_gaps);
  assert.deepEqual(Object.keys(result.raw_projection).sort(), [...Object.keys(original.raw_projection), ...FIELDS].sort());
  for (const field of FIELDS) assert.equal(result.raw_projection[field], input[field]);
  assert.equal(result.data.cached_mapping_version, 4);
  assert.equal(result.data.cached_projection_sha256, assessmentEvidenceDigest({ mapping_version: 4, projection_kind: 'parcel', raw_projection: result.raw_projection }));
  assert.equal(result.data.historical_support, 'unknown'); assert.equal(result.data.housing_type, null);
  assert.equal(result.data.assessment_tax_year, null); assert.ok(result.capability_gaps.includes('housing_classification_unverified'));
  input.class_code = 'changed'; assert.equal(result.raw_projection.class_code, ' 01 '); frozenTree(result);
});

for (const [kind, make, previous, next] of [
  ['account', account, mapCachedAccountRow, mapCadEvidenceAccountRow],
  ['sale', sale, mapCachedSaleRow, mapCadEvidenceSaleRow],
  ['sale_link', link, mapCachedSaleLinkRow, mapCadEvidenceSaleLinkRow],
]) test(`${kind} keeps v2 raw values, normalized semantics and gaps without MLS witnesses`, () => {
  const raw = make(), old = previous(raw), result = next(raw);
  assert.deepEqual(result.raw_projection, old.raw_projection); assert.deepEqual(normal(result), normal(old));
  assert.deepEqual(result.capability_gaps, old.capability_gaps);
  assert.equal(result.data.cached_projection_sha256, assessmentEvidenceDigest({ mapping_version: 4, projection_kind: kind, raw_projection: result.raw_projection }));
  assert.deepEqual(previous(raw), old); frozenTree(result);
});
test('canonical legacy sale stays explicitly source-unavailable, without fabricated null MLS witness cells', () => {
  const result = mapCadEvidenceSaleRow({ source_record_id: null, sale_id: '22', sale_account_id: A, sale_price: '300000', sale_closing_date: '2020-03-01' });
  assert.equal(result.data.source_record_id, null); assert.ok(result.capability_gaps.includes('source_record_unavailable'));
  for (const key of ['source_raw_witness', 'source_row_number', 'source_mls_status']) assert.equal(Object.hasOwn(result.raw_projection, key), false);
});
test('explicit blank/null/false/true remain distinct, content-bound observations', () => {
  const results = ['', ' ', null, '0'].map(class_code => mapCadEvidenceParcelRow({ ...parcel(), class_code }));
  assert.equal(new Set(results.map(r => r.data.cached_projection_sha256)).size, results.length);
  assert.equal(new Set([false, true, null].map(built_up => mapCadEvidenceParcelRow({ ...parcel(), built_up }).data.cached_projection_sha256)).size, 3);
  for (const field of FIELDS) assert.equal(mapCadEvidenceParcelRow({ ...parcel(), [field]: null }).raw_projection[field], null);
});
for (const field of FIELDS) test(`own ${field} is mandatory and never manufactured from absence`, () => {
  const input = parcel(); delete input[field]; assert.throws(() => mapCadEvidenceParcelRow(input), error('cad_fields_required'));
  input[field] = undefined; assert.throws(() => mapCadEvidenceParcelRow(input), error('data_properties_required'));
});
for (const [field, value] of [['class_code', 1], ['structure_type', false], ['use_description', []],
  ['class_description', {}], ['built_up', 'false'], ['built_up', 0], ['built_up', 1], ['class_code', '\u0000'], ['class_code', '\ud800']]) {
  test(`rejects type/Unicode coercion for ${field}: ${JSON.stringify(value)}`, () => {
    assert.throws(() => mapCadEvidenceParcelRow({ ...parcel(), [field]: value }), error(field));
  });
}
test('CAD text bound meters UTF8, accepts exact bound and rejects overflow without truncation', () => {
  const text = 'é'.repeat(LIMITS.text_utf8_bytes / 2);
  assert.equal(mapCadEvidenceParcelRow({ ...parcel(), class_description: text }).raw_projection.class_description, text);
  assert.throws(() => mapCadEvidenceParcelRow({ ...parcel(), class_description: `${text}x` }), error('class_description'));
});
test('ignored private fields/getters are not retained or executed; selected getters/proxies fail before execution', () => {
  let calls = 0; const hostile = new Proxy({}, { getPrototypeOf() { calls++; throw Error('trap'); } });
  const input = { ...parcel(), source_attributes: hostile, raw_payload: hostile, source_raw_witness: hostile };
  Object.defineProperty(input, 'private_note', { enumerable: true, get() { calls++; throw Error('getter'); } });
  const expected = mapCadEvidenceParcelRow(parcel()), result = mapCadEvidenceParcelRow(input);
  assert.deepEqual(result.raw_projection, expected.raw_projection); assert.deepEqual(normal(result), normal(expected));
  assert.ok(result.capability_gaps.includes('projection_fields_not_retained')); assert.equal(calls, 0);
  Object.defineProperty(input, 'class_code', { enumerable: true, get() { calls++; throw Error('selected'); } });
  assert.throws(() => mapCadEvidenceParcelRow(input), error('data_properties_required'));
  assert.throws(() => mapCadEvidenceParcelRow(hostile), error('projection_object'));
  assert.throws(() => mapCadEvidenceParcelRow({ ...parcel(), stored_geometry_geojson: hostile }), error('plain_data_required'));
  assert.equal(calls, 0);
});

const factories = { 2: [createNeighborhoodCachedReadAccess, createNeighborhoodCachedSourceReader],
  3: [createNeighborhoodSaleWitnessReadAccess, createNeighborhoodSaleWitnessSourceReader],
  4: [createNeighborhoodCadEvidenceReadAccess, createNeighborhoodCadEvidenceSourceReader] };
test('mapping4 independently binds capabilities while requesting exactly v2 licensed-market scope', async () => {
  const purposes = [];
  for (const version of [2, 3, 4]) {
    const granted = createTestCachedReadAccess(request(), { accessFactory: factories[version][0],
      authorizeMarketData: async (_auth, _context, purpose) => { purposes.push({ version, purpose });
        return { allowed: true, decision_id: 'same-existing-scope', policy_revision: 'existing-v1' }; } });
    const issued = await granted.prepare(), tokens = { selection_grant: issued.selection_grant, market_grant: issued.market_grant };
    const accepted = consumeNeighborhoodCachedReadAccess(granted.access, granted.auth, issued.request, tokens, version);
    const expected = version === 3 ? describeNeighborhoodSaleWitnessMarketDataPurpose(accepted) : describeNeighborhoodCachedMarketDataPurpose(accepted);
    assert.deepEqual(purposes.at(-1).purpose, expected);
    for (const other of [2, 3, 4].filter(v => v !== version)) {
      assert.throws(() => factories[other][1]({ connect() { assert.fail('no connection'); } }, { access: granted.access }), /mapping_profile_mismatch/);
      assert.throws(() => consumeNeighborhoodCachedReadAccess(granted.access, granted.auth, issued.request, tokens, other), /mapping_profile_mismatch/);
    }
  }
  assert.deepEqual(purposes[0].purpose, purposes[2].purpose);
  assert.equal(Object.hasOwn(purposes[2].purpose, 'source_projection'), false);
  assert.equal(purposes[2].purpose.additional_cadastral_accounts, false);
});
test('new CAD capability still requires real source permission and does not admit witness projection by default', async () => {
  let closure = 0;
  const granted = createTestCachedReadAccess(request(), { accessFactory: createNeighborhoodCadEvidenceReadAccess,
    authorizeMarketData: async () => ({ allowed: false }), resolveTransactionClosure: async () => { closure++; throw Error('no'); } });
  await assert.rejects(granted.prepare()); assert.equal(closure, 0);
});

async function captureFixture({ version = 4, missingColumn = null, changes = {}, owner = false } = {}) {
  const transaction = sale(), association = link();
  const closure = { source_revision: 'cad-evidence-test-closure', transactions: [Object.fromEntries(
    ['source_record_id', 'sale_id', 'primary_account_id', 'sale_account_id', 'source_record_hash'].map(k => [k, transaction[k]]))],
  links: [Object.fromEntries(['parcel_link_id', 'source_record_id', 'source_position', 'parcel_sequence', 'account_id', 'is_resolved'].map(k => [k, association[k]]))], legacy: [] };
  const access = createTestCachedReadAccess(request(), { accessFactory: factories[version][0], transactionClosure: closure });
  const granted = await access.prepare(), calls = [], releases = []; let connections = 0;
  const client = { release(error) { releases.push(error); }, async query(config) {
    const text = typeof config === 'string' ? config : config.text, v = config.values ?? [];
    const tag = text.match(/neighborhood-cache:([\w-]+)/)?.[1]; calls.push({ tag, text, values: v });
    if (['begin', 'settings', 'commit', 'rollback'].includes(tag)) return { rows: [] };
    if (['snapshot', 'snapshot-end', 'caller-snapshot'].includes(tag)) return { rows: [{ backend_pid: 1234, snapshot: '100:100:',
      transaction_started_at: '2026-09-05T11:59:59.000000Z', isolation: 'repeatable read', read_only: 'on', timezone: 'UTC',
      explicit_transaction: true, statement_ms: 5000, lock_ms: 1000, idle_ms: 10000 }] };
    if (tag === 'scope') return { rows: [{ case_date: '2024-06-30', snapshot_date: '2024-06-30', effective_date: '2024-06-30', captured_at: NOW, captured_at_precise: PRECISE }] };
    if (tag === 'capabilities') return { rows: [...baseCatalog, ...FIELDS.map(column => ({ relation: 'gis.dcad_parcels', column }))]
      .filter(row => row.column !== missingColumn) };
    let rows;
    if (tag === 'parcels') rows = v[1] === '-1' ? [{ ...baseParcel(), ...(version === 4 ? { ...extras(), ...changes } : {}) }] : [];
    else if (tag === 'accounts') rows = v[1] === '' ? [account()] : [];
    else if (tag === 'sync-state') rows = [{ source_key: 'dcad_parcels', status: 'current', row_count: '1', last_run_id: RUN, last_success_at: NOW }];
    else if (tag === 'sync-runs') rows = [{ id: RUN, source_key: 'dcad_parcels', status: 'complete', mode: 'full', started_at: '2026-09-05T11:00:00.000Z', completed_at: NOW }];
    else if (tag === 'source-ids') rows = v[1] === '0' ? [{ source_record_id: '10' }] : [];
    else if (tag === 'transaction-identities') rows = closure.transactions;
    else if (tag === 'transactions') rows = [transaction];
    else if (tag === 'link-identities' || tag === 'sale-links') rows = v[1] === '0' ? [tag === 'link-identities' ? closure.links[0] : association] : [];
    else if (tag === 'legacy' || tag === 'legacy-identities') rows = [];
    else assert.fail(tag);
    return { rows: rows.map(payload => ({ payload, row_bytes: Buffer.byteLength(JSON.stringify(payload)) })) };
  } };
  const reader = factories[version][1]({ async connect() { connections++; return client; } }, { access: access.access });
  const input = { ...granted.request, auth: access.auth, selection_grant: granted.selection_grant, market_grant: granted.market_grant };
  const result = owner ? await reader.captureInSnapshot(client, input) : await reader.capture(input);
  return { result, reader, calls, releases, connections };
}
const records = (result, role) => result.source_capture.sources.filter(s => s.payload.projection.definition.role === role).flatMap(s => s.payload.records);
test('actual opt-in capture retains v4 five-field evidence, base sales and full all-date one-hop closure', async () => {
  const f = await captureFixture(); assert.equal(f.result.status, 'captured', JSON.stringify(f.result.incomplete_reasons));
  assert.equal(f.result.reader_version, 'local-capture-v3');
  for (const role of ['parcels', 'accounts', 'transactions', 'sale_links']) for (const record of records(f.result, role)) assert.equal(record.data.data.cached_mapping_version, 4);
  const p = records(f.result, 'parcels')[0].data;
  for (const key of FIELDS) assert.equal(p.raw_projection[key], extras()[key]);
  assert.equal(records(f.result, 'transactions')[0].data.raw_projection.sale_closing_date, '2020-03-01', 'no analytic period read filter');
  assert.equal(records(f.result, 'sale_links')[0].data.raw_projection.account_id, 'R-OUTSIDE');
  assert.deepEqual(f.calls.find(c => c.tag === 'accounts').values[0], [A]);
  const sql = f.calls.find(c => c.tag === 'parcels').text;
  for (const key of FIELDS) assert.ok(sql.includes(`parcel.${key}`));
  assert.doesNotMatch(f.calls.map(c => c.text).join('\n'), /source_attributes|raw_payload|source_mls_status|source_row_number/);
  assert.match(sql, /account_id=ANY\(\$1::text\[\]\)/); assert.match(sql, /ORDER BY parcel.object_id LIMIT \$3/);
  const handoff = consumeNeighborhoodCachedAcquisition(f.reader, f.result);
  assert.equal(JSON.parse(handoff.compact_metadata_json).mapping_version, 4);
  assert.equal(handoff.captured_query_request.transaction_closure.links[0].account_id, 'R-OUTSIDE');
  assert.throws(() => consumeNeighborhoodCachedAcquisition(f.reader, f.result));
  assert.equal(f.connections, 1); assert.equal(f.releases.length, 1); assert.ok(f.calls.some(c => c.tag === 'commit'));
});
test('caller-owned v4 capture does not acquire, commit, roll back or release the owner transaction', async () => {
  const f = await captureFixture({ owner: true }); assert.equal(f.result.status, 'captured', JSON.stringify(f.result.incomplete_reasons));
  assert.equal(f.connections, 0); assert.equal(f.releases.length, 0);
  assert.equal(f.calls.some(c => ['begin', 'settings', 'commit', 'rollback'].includes(c.tag)), false);
  assert.equal(f.calls.filter(c => c.tag === 'caller-snapshot').length, 3, 'existing admission/start/end caller snapshot checks remain intact');
});
for (const missingColumn of FIELDS) test(`missing ${missingColumn} refuses complete capture before a parcel read`, async () => {
  const f = await captureFixture({ missingColumn });
  assert.equal(f.result.status, 'incomplete'); assert.ok(f.result.incomplete_reasons.some(reason => reason.startsWith('parcels:')));
  assert.equal(f.calls.some(c => c.tag === 'parcels'), false); assert.equal(f.releases.length, 1);
});
test('changing one retained CAD field changes genuine capture hashes, never housing eligibility', async () => {
  const a = await captureFixture(), b = await captureFixture({ changes: { structure_type: '  Detached  ' } });
  assert.equal(a.result.status, 'captured'); assert.equal(b.result.status, 'captured');
  const first = records(a.result, 'parcels')[0].data, second = records(b.result, 'parcels')[0].data;
  assert.notEqual(first.data.cached_projection_sha256, second.data.cached_projection_sha256);
  assert.deepEqual(normal(first), normal(second)); assert.equal(second.data.housing_type, null);
});
test('existing mapping2 default does not select/retain any CAD additions and its sale SQL matches v4', async () => {
  const a = await captureFixture({ version: 2 }), b = await captureFixture();
  assert.equal(a.result.status, 'captured'); assert.equal(records(a.result, 'parcels')[0].data.data.cached_mapping_version, 2);
  for (const key of FIELDS) assert.equal(Object.hasOwn(records(a.result, 'parcels')[0].data.raw_projection, key), false);
  assert.doesNotMatch(a.calls.find(c => c.tag === 'parcels').text, /parcel\.(?:class_code|class_description|use_description|structure_type|built_up)/);
  assert.equal(a.calls.find(c => c.tag === 'transactions').text, b.calls.find(c => c.tag === 'transactions').text);
  assert.deepEqual(records(a.result, 'transactions')[0].data.raw_projection, records(b.result, 'transactions')[0].data.raw_projection);
});
