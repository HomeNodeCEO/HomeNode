import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CACHED_ROW_MAPPING_VERSION, CACHED_ROW_PROJECTION_FIELDS, mapCachedSaleRow } from '../src/services/neighborhoodAssessment/cachedRowMappings.js';
import { createNeighborhoodCachedSourceReader } from '../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { prepareCohortLocalQueryEvidenceV1 } from '../src/services/neighborhoodAssessment/cohortEvidenceContract.js';
import { canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { ASSESSMENT_SCOPE } from './fixtures/neighborhoodAssessmentFixture.js';
import { createTestCachedReadAccess } from './fixtures/neighborhoodCachedReadAccessFixture.js';
import { createCohortLocalQueryEvidenceFixture, makeCohortLocalQueryMetadata, cohortFixtureSha256 } from './fixtures/neighborhoodCohortLocalQueryEvidenceFixture.js';

// Fixed existing schema vocabulary, independently checked against migration SQL.
// Values are synthetic source observations, not verified property-at-date facts.
const FIELDS = Object.freeze({
  lot_size_area: ['numeric', '8123.4500000000000001'],
  year_built: ['integer', 2004],
  bedrooms_total: ['integer', 4],
  bathrooms_total_integer: ['integer', 3],
  bathrooms_full: ['integer', 2],
  bathrooms_half: ['integer', 1],
  structural_style: ['text', 'Single Detached'],
  housing_type: ['text', 'single_family'],
  attachment_type: ['text', 'detached'],
  architectural_style: ['text', '  Traditional  '],
  garage_spaces: ['numeric', '2.000'],
  garage_yn: ['boolean', true],
  pool_yn: ['boolean', false],
  days_on_market: ['integer', 0],
});
const physical = () => Object.fromEntries(Object.entries(FIELDS).map(([column, [, value]]) => ['source_' + column, value]));
const NOW = '2026-09-05T12:00:00.000Z';
const RUN = '60000000-0000-4000-8000-000000000001';
const ACCOUNT = ASSESSMENT_SCOPE.account_id;
const sale = () => ({
  source_record_id: '10', sale_id: '20', primary_account_id: ACCOUNT, sale_account_id: ACCOUNT,
  source_name: 'Synthetic source', source_filename: 'synthetic.csv', source_sha256: 'a'.repeat(64),
  source_record_hash: 'b'.repeat(64), transaction_fingerprint: 'synthetic-transaction',
  record_type: 'closed_sale', source_close_date: '2024-03-01', sale_closing_date: '2024-03-01',
  source_current_price: '300000', sale_price: '300000', source_living_area: '2200.000',
  source_loaded_at: NOW, source_updated_at: NOW, ...physical(),
});
const source = readFileSync(new URL('../src/services/neighborhoodAssessment/cachedSourceReader.js', import.meta.url), 'utf8');
const tableDeclaration = source.slice(source.indexOf('const TABLES'), source.indexOf('const SQL'));
const catalog = [...tableDeclaration.matchAll(/\['([a-z_]+\.[a-z_]+)', '([^']+)'\]/g)]
  .flatMap(([, relation, columns]) => columns.split(' ').map(column => ({ relation, column })));
const transactionSql = source.slice(source.indexOf('  transactions: '), source.indexOf('  sale_links: ', source.indexOf('  transactions: ')));

test('mapping v2 retains exact source-attributed physical/housing/DOM evidence only', () => {
  assert.equal(CACHED_ROW_MAPPING_VERSION, 2);
  const row = sale(), mapped = mapCachedSaleRow(row);
  assert.equal(mapped.data.cached_mapping_version, 2);
  for (const key of Object.keys(physical())) {
    assert.ok(CACHED_ROW_PROJECTION_FIELDS.sale.includes(key));
    assert.equal(mapped.raw_projection[key], row[key]);
    assert.equal(Object.hasOwn(mapped.data, key), false, 'Do not promote raw source fields into normalized facts');
  }
  assert.equal(mapped.raw_projection.source_pool_yn, false);
  assert.equal(mapped.raw_projection.source_days_on_market, 0);
  assert.equal(mapped.raw_projection.source_lot_size_area, '8123.4500000000000001');
  assert.equal(mapped.raw_projection.source_architectural_style, '  Traditional  ');
  for (const key of ['source_record_id', 'source_name', 'source_filename', 'source_sha256', 'source_record_hash']) {
    assert.equal(mapped.raw_projection[key], row[key]);
  }
  for (const key of ['market_eligible', 'primary_account_verified', 'parcel_links_complete', 'parcel_count', 'gla_sqft_at_sale']) {
    assert.equal(mapped.data[key], null);
  }
  assert.equal(Object.hasOwn(mapped.data, 'housing_type'), false);
  assert.equal(Object.hasOwn(mapped.data, 'year_built'), false);
  assert.equal(mapped.data.historical_support, 'unknown');
  assert.equal(mapped.data.valid_from, null); assert.equal(mapped.data.valid_to, null);
  for (const gap of ['historical_validity_unavailable', 'transaction_equivalence_unverified',
    'market_eligibility_unavailable', 'transaction_membership_completeness_unavailable', 'gla_at_sale_unavailable']) {
    assert.ok(mapped.capability_gaps.includes(gap));
  }
  row.source_housing_type = 'changed';
  assert.equal(mapped.raw_projection.source_housing_type, 'single_family');
  assert.ok(Object.isFrozen(mapped.raw_projection));
});

test('every added source field participates in deterministic evidence hashing', () => {
  const row = sale(), original = mapCachedSaleRow(row);
  assert.deepEqual(mapCachedSaleRow(Object.fromEntries(Object.entries(row).reverse())), original);
  for (const key of Object.keys(physical())) {
    const changed = mapCachedSaleRow({ ...row, [key]: null });
    assert.notEqual(changed.data.cached_projection_sha256, original.data.cached_projection_sha256, key);
    assert.equal(changed.raw_projection.source_record_hash, original.raw_projection.source_record_hash);
  }
});

test('absent, NULL, blank, zero and false source values stay distinct; malformed observations are not repaired', () => {
  const hashes = new Set();
  for (const value of [undefined, null, '', 0, false]) {
    const row = sale(); delete row.source_days_on_market;
    if (value !== undefined) row.source_days_on_market = value;
    const mapped = mapCachedSaleRow(row);
    hashes.add(mapped.data.cached_projection_sha256);
    assert.equal(Object.hasOwn(mapped.raw_projection, 'source_days_on_market'), value !== undefined);
    if (value !== undefined) assert.equal(mapped.raw_projection.source_days_on_market, value);
  }
  assert.equal(hashes.size, 5);
  const malformed = mapCachedSaleRow({ ...sale(), source_year_built: -1, source_housing_type: 'unrecognized label',
    source_lot_size_area: '8,123', source_days_on_market: -5 });
  assert.equal(malformed.raw_projection.source_year_built, -1);
  assert.equal(malformed.raw_projection.source_days_on_market, -5);
  assert.equal(malformed.raw_projection.source_housing_type, 'unrecognized label');
  assert.equal(malformed.raw_projection.source_lot_size_area, '8,123');
  assert.equal(malformed.data.market_eligible, null);
  assert.equal(malformed.data.historical_support, 'unknown');
  for (const key of Object.keys(physical())) {
    assert.throws(() => mapCachedSaleRow({ ...sale(), [key]: undefined }), /invalid_neighborhood_cached_row:projection/);
    const getter = sale();
    Object.defineProperty(getter, key, { enumerable: true, get() { assert.fail('Getter must not run'); } });
    assert.throws(() => mapCachedSaleRow(getter), /invalid_neighborhood_cached_row:projection/);
  }
});

test('new projection does not admit private payloads, manufactured authority or legacy source fallbacks', () => {
  const mapped = mapCachedSaleRow({ ...sale(), raw_payload: { PrivateRemarks: 'private-not-retained' },
    housing_type: 'verified', market_eligible: true, historical_support: 'reconstructed', provider_coverage: 'complete' });
  assert.ok(mapped.capability_gaps.includes('projection_fields_not_retained'));
  assert.equal(JSON.stringify(mapped).includes('private-not-retained'), false);
  for (const key of ['raw_payload', 'housing_type', 'market_eligible', 'historical_support', 'provider_coverage']) {
    assert.equal(Object.hasOwn(mapped.raw_projection, key), false);
  }
  const legacy = mapCachedSaleRow({ sale_id: '20', source_record_id: null, sale_account_id: ACCOUNT });
  for (const key of Object.keys(physical())) assert.equal(Object.hasOwn(legacy.raw_projection, key), false);
  const sourceOnly = mapCachedSaleRow({ ...sale(), sale_id: null, sale_price: null, sale_closing_date: null, sale_account_id: null });
  assert.equal(sourceOnly.raw_projection.source_housing_type, 'single_family');
  assert.equal(sourceOnly.data.canonical_transaction_id, null);
  assert.equal(sourceOnly.data.sale_price, null);
});

test('SQL projects the existing source columns directly and both native fixture schemas retain them', () => {
  const files = [
    new URL('../../dcad-scraper-with-api/migrations/004_sales_ingestion.sql', import.meta.url),
    new URL('./fixtures/neighborhoodCachedSourceSchemaFixture.js', import.meta.url),
    new URL('./neighborhoodCachedSourceReaderSnapshot.integration.test.js', import.meta.url),
  ];
  const schemas = files.map(file => {
    const text = readFileSync(file, 'utf8');
    const start = text.search(/CREATE TABLE (?:IF NOT EXISTS )?core\.sales_source_records\s*\(/);
    assert.ok(start >= 0, 'Expected an explicit source-record CREATE TABLE fixture');
    return text.slice(start, text.indexOf(');', start));
  });
  for (const [column, [type]] of Object.entries(FIELDS)) {
    for (const schema of schemas) assert.match(schema, new RegExp('\\b' + column + '\\s+' + type + '\\b'));
    assert.ok(catalog.some(row => row.relation === 'core.sales_source_records' && row.column === column));
    assert.ok(transactionSql.includes('src.' + column + (type === 'numeric' ? '::text' : '') + ' AS source_' + column));
  }
  assert.doesNotMatch(transactionSql, /COALESCE|v_sales_enriched|account_housing_profiles|raw_payload|PrivateRemarks/);
});

// A tiny query-boundary fake exercises the actual reader and evidence builder.
// It is not PostgreSQL/ingestion/permission verification; grants remain explicitly synthetic.
async function capture(missingColumn = null) {
  const row = sale(), calls = [];
  const identity = Object.fromEntries(['source_record_id', 'sale_id', 'primary_account_id', 'sale_account_id', 'source_record_hash']
    .map(key => [key, row[key]]));
  const request = { scope: ASSESSMENT_SCOPE, effective_date: '2024-06-30', account_ids: [ACCOUNT],
    observation_period: { start_date: '2023-07-01', end_date: '2024-06-30' } };
  const grant = createTestCachedReadAccess(request, { transactionClosure: {
    source_revision: 'synthetic-physical-v2', transactions: [identity], links: [], legacy: [],
  } });
  const client = { release() {}, async query(config) {
    const tag = config.text.match(/neighborhood-cache:([\w-]+)/)?.[1];
    calls.push(tag);
    if (['begin', 'settings', 'commit', 'rollback'].includes(tag)) return { rows: [] };
    if (tag === 'scope') return { rows: [{ case_date: '2024-06-30', snapshot_date: '2024-06-30',
      effective_date: '2024-06-30', captured_at: NOW, captured_at_precise: '2026-09-05T12:00:00.000000Z' }] };
    if (tag === 'capabilities') return { rows: catalog.filter(item => !(item.relation === 'core.sales_source_records' && item.column === missingColumn)) };
    const rows = {
      parcels: [{ object_id: '1', account_id: ACCOUNT, source_record_hash: 'c'.repeat(64),
        sync_run_id: RUN, synced_at: NOW, source_updated_at: null, stored_geometry_ewkb: '010203' }],
      accounts: [{ account_id: ACCOUNT }],
      'sync-state': [{ source_key: 'dcad_parcels', status: 'current', row_count: '1', last_run_id: RUN, last_success_at: NOW }],
      'sync-runs': [{ id: RUN, source_key: 'dcad_parcels', status: 'complete',
        started_at: '2026-09-05T11:00:00.000Z', completed_at: NOW }],
      'source-ids': [{ source_record_id: '10' }],
      'transaction-identities': [identity], 'link-identities': [], 'legacy-identities': [],
      transactions: [row], 'sale-links': [], legacy: [],
    }[tag];
    assert.ok(rows, 'Unexpected SQL tag: ' + tag);
    return { rows: rows.map(payload => ({ payload: structuredClone(payload), row_bytes: Buffer.byteLength(JSON.stringify(payload)) })) };
  } };
  const issued = await grant.prepare();
  const result = await createNeighborhoodCachedSourceReader({ async connect() { return client; } }, { access: grant.access })
    .capture({ ...issued.request, auth: grant.auth, selection_grant: issued.selection_grant, market_grant: issued.market_grant });
  return { result, calls };
}

test('actual reader output binds mapping v2 into source records, source envelopes and original query evidence', async () => {
  const { result } = await capture();
  assert.equal(result.status, 'captured', JSON.stringify(result.incomplete_reasons));
  const sources = result.source_capture.sources;
  for (const entry of sources) assert.equal(entry.payload.projection.definition.mapping_version, 2);
  const records = sources.filter(entry => entry.payload.projection.definition.role === 'transactions')
    .flatMap(entry => entry.payload.records);
  assert.equal(records.length, 1);
  assert.equal(records[0].data.data.cached_mapping_version, 2);
  for (const [key, value] of Object.entries(physical())) assert.equal(records[0].data.raw_projection[key], value);
  const metadata = result.query_evidence.blobs.map(blob => JSON.parse(blob.canonical_json))
    .find(blob => blob.reader_version === 'local-capture-v3');
  assert.equal(metadata.mapping_version, 2, 'Read from actual output; never rewrite retained v1 metadata');
  assert.equal(prepareCohortLocalQueryEvidenceV1(JSON.stringify(result.query_evidence)).status, 'syntax_valid');
  assert.equal(result.query_evidence.captured_query_selection_sha256, result.selection_sha256);
});

for (const column of Object.keys(FIELDS)) test('missing source schema column stays fail-closed: ' + column, async () => {
  const { result, calls } = await capture(column);
  assert.equal(result.status, 'incomplete'); assert.equal(result.source_capture, null);
  assert.ok(result.incomplete_reasons.includes('source_records:unsupported_schema'));
  assert.deepEqual(result.capabilities.source_records.missing_columns, [column]);
  assert.equal(calls.includes('transactions'), false);
});

test('pinned mapping-v1 query evidence remains byte-identical and replays as v1', () => {
  const fixture = createCohortLocalQueryEvidenceFixture();
  assert.equal(cohortFixtureSha256(fixture.inputJson), 'b0e8534f0f2c93e8b18a8a4a4e518d099740a53c49f59da67430a5d875249e71');
  assert.equal(fixture.bundle.captured_query_selection_sha256, 'ccb0070e9127b9337c19d507d8b79b0e541dc0bf1f487136d171cd2e6c93f94f');
  const result = prepareCohortLocalQueryEvidenceV1(fixture.inputJson);
  assert.equal(result.status, 'syntax_valid');
  assert.equal(JSON.stringify(result.evidence), fixture.inputJson);
  const original = result.evidence.blobs.find(blob => blob.ref.content_sha256 === fixture.refs.metadata.content_sha256);
  assert.equal(JSON.parse(original.canonical_json).mapping_version, 1);
  assert.equal(original.canonical_json, canonicalAssessmentJson(fixture.metadata));
  const v2 = createCohortLocalQueryEvidenceFixture({ metadata: { ...fixture.metadata, mapping_version: 2 } });
  assert.equal(prepareCohortLocalQueryEvidenceV1(v2.inputJson).status, 'syntax_valid');
  assert.notEqual(v2.bundle.captured_query_selection_sha256, fixture.bundle.captured_query_selection_sha256);
});

test('mapping version admission rejects strings, unknown versions and otherwise valid rehashed metadata', () => {
  for (const mapping_version of [0, 4, -1, 1.5, '1', '2', '3', null]) {
    const fixture = createCohortLocalQueryEvidenceFixture({ metadata: { ...makeCohortLocalQueryMetadata(), mapping_version } });
    assert.deepEqual(prepareCohortLocalQueryEvidenceV1(fixture.inputJson), { status: 'invalid', reason: 'invalid_value' });
  }
});

test('mapping3 envelope admission is byte consistency only, not an acquisition or permission grant', () => {
  const fixture = createCohortLocalQueryEvidenceFixture({ metadata: { ...makeCohortLocalQueryMetadata(), mapping_version: 3 } });
  const result = prepareCohortLocalQueryEvidenceV1(fixture.inputJson);
  assert.equal(result.status, 'syntax_valid');
  assert.equal(result.authority, 'not_established');
  assert.equal(result.validation_scope, 'retained_bytes_and_query_hashes_only');
});
