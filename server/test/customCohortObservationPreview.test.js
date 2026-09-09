import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareCustomCohortCaptureInputs, persistCustomCohortCaptureInputs, loadCustomCohortCaptureInputs } from '../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { createNeighborhoodCohortBlobRepository } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { captureNeighborhoodSpatialMembership } from '../src/services/neighborhoodAssessment/cachedSpatialMembership.js';
import { createNeighborhoodCachedSourceReader, consumeNeighborhoodCachedAcquisition } from '../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { prepareNeighborhoodSelectorInputV1 } from '../src/services/neighborhoodAssessment/selectorInputProfile.js';
import { customCohortRepositoryFixture, customCohortScopeOf } from './fixtures/customCohortRepositoryFixture.js';
import { createTestCachedReadAccess } from './fixtures/neighborhoodCachedReadAccessFixture.js';
import { setPublic } from './fixtures/neighborhoodCustomMaterialInputsFixture.js';
import { buildCustomCohortObservationPreview as preview } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCachedSourceCaptures } from '../src/services/neighborhoodAssessment/cachedSourceCaptures.js';
import { mapCachedParcelRow, mapCachedAccountRow, mapCachedSaleRow, mapCachedSaleLinkRow } from '../src/services/neighborhoodAssessment/cachedRowMappings.js';
import { contextFixture } from './fixtures/customCohortContextFixture.js';

const NOW = '2026-09-06T08:00:00.123Z';
const context_ref = { context_id: contextFixture().context_id, context_revision: '1', context_sha256: 'e'.repeat(64) };
const parcel = (id, account = 'A', extra = {}) => ({ object_id: String(id), account_id: account,
  residential_year_built: 2000, residential_area_sqft: '1800.125', parcel_area_sqft: '6000.00', current_market_value: '330000.00', ...extra });
const sale = (id, account = 'A', extra = {}) => ({ source_record_id: String(id), sale_id: String(id),
  primary_account_id: account, sale_account_id: account, record_type: 'closed_sale', sale_closing_date: '2024-03-01',
  source_close_date: '2024-03-01', sale_price: '330000.00', source_current_price: '335000', source_living_area: '1800.125',
  source_lot_size_area: '.2', source_year_built: 2001, source_days_on_market: 0, ...extra });
const link = (id, source, account, extra = {}) => ({ parcel_link_id: String(id), source_record_id: String(source),
  source_position: 1, parcel_sequence: id, account_id: account, is_resolved: account !== null, match_method: 'exact', ...extra });

// Actual mapping-v2 and source-chunk builders, using the graph shape returned by
// the retained loader. These are observation tests, not claims of SQL/MVCC or
// original-acquisition authority; the real loader round trip is tested below.
function fixture({ accounts = ['A', 'B'], parcels = [parcel(1), parcel(2, 'B')], sales = [sale(1)], links = [], pockets,
  start = '2023-07-01', end = '2024-06-30' } = {}) {
  const target = { ...contextFixture().target, account_id: accounts[0] ?? 'A', assignment_file_id: '17' };
  const scope = Object.fromEntries(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id'].map(key => [key, target[key]]));
  const wrap = (rows, mapper, prefix) => rows.map(row => {
    const mapped = mapper(row); return { record_id: `${prefix}:${mapped.record_id}`, data: mapped };
  });
  const groups = { selection: accounts.map(account_id => ({ record_id: `selected:${account_id}`, data: { account_id } })),
    parcels: wrap(parcels, mapCachedParcelRow, 'parcel'), accounts: wrap(accounts.map(account_id => ({ account_id })), mapCachedAccountRow, 'account'),
    transactions: wrap(sales, mapCachedSaleRow, 'sale'), sale_links: wrap(links, mapCachedSaleLinkRow, 'link'), gis_sync: [] };
  const capture = buildCachedSourceCaptures({ scope, captures: Object.entries(groups).map(([role, records]) => ({
    upstream: { id: `local-cache:${role}`, key: role, state: records.length ? 'populated' : 'present_empty', complete: true,
      revision: 'fixture-v2', content_sha256: 'a'.repeat(64), captured_at: NOW, visibility: 'assignment_private', scope, row_count: records.length },
    metadata: { id: `local-cache-${role}`, provider: 'Synthetic local mirror', revision: 'fixture-v2', valid_from: null, valid_to: null,
      observed_at: NOW, historical_availability: 'unknown' },
    projection: { id: `cache-${role}`, revision: 'fixture-v2', definition: { role }, complete: true,
      input_row_count: records.length, output_record_count: records.length }, records })) });
  assert.equal(capture.status, 'ready');
  return { context_ref, retained_inputs: { subject: { target, effective_date: '2024-06-30' },
    study: { observation_period: { start_date: start, end_date: end } }, spatial: { query_complete: true, account_ids: accounts,
      parcels: parcels.map(row => ({ object_id: row.object_id, account_id: row.account_id })) },
    acquisition: { captured_query_request: { scope, account_ids: accounts },
      capture_result: { query_complete: true, captured_at: NOW, source_capture: capture } } },
  selection: { revision: 1, pockets: pockets ?? [{ id: 'pocket-a', label: 'Appraiser-selected A', account_ids: ['A'] }] } };
}

test('all current stock and distinct canonical/source populations have exact denominators and unknown authority', () => {
  const input = fixture(), original = JSON.stringify(input), result = preview(input);
  assert.equal(result.status, 'observations_only'); assert.equal(result.authority, 'not_established');
  assert.equal(result.all.stock.member_count, 2); assert.equal(result.selected.stock.member_count, 1);
  assert.equal(result.all.stock.metrics.gla_sqft.median, 1800.125);
  assert.equal(result.all.stock.metrics.assessed_value.median, 330000);
  assert.equal(result.all.stock.assessment_tax_year, null);
  assert.equal(result.all.transactions.metrics.recorded_total_price.median, 330000);
  assert.equal(result.all.source_reported.metrics.current_price.median, 335000);
  assert.equal(result.all.source_reported.metrics.days_on_market.median, 0);
  assert.equal(result.all.source_reported.metrics.lot_size_area.unit, null, 'source lot units are not captured');
  assert.equal(result.all.transactions.metrics.recorded_total_price.currency, null);
  assert.equal(result.all.transactions.market_eligible_count, null);
  assert.equal(result.all.transactions.members[0].membership_complete, null);
  assert.equal(result.apply.status, 'blocked'); assert.ok(result.unavailable_metrics.reliability);
  assert.ok(result.unavailable_metrics.sale_price_per_square_foot);
  assert.match(result.unavailable_metrics.predominant_value, /median_is_not_predominant/);
  assert.equal(result.all.stock.metrics.gla_sqft.cod_interpretation, 'descriptive_dispersion_not_reliability');
  assert.equal(JSON.stringify(input), original); assert.ok(Object.isFrozen(result.all.stock.members));
});

test('more than 30 sale events and more than one source chunk are used, not sampled', () => {
  const sales = Array.from({ length: 1001 }, (_, i) => sale(i + 1, 'A', { sale_price: String(i + 1) }));
  const input = fixture({ sales }), result = preview(input);
  assert.ok(input.retained_inputs.acquisition.capture_result.source_capture.sources.filter(s => s.payload.projection.definition.role === 'transactions').length > 1);
  assert.equal(result.all.transactions.member_count, 1001);
  assert.equal(result.all.transactions.metrics.recorded_total_price.median, 501);
  assert.equal(result.all.transactions.metrics.recorded_total_price.high, 1001);
  assert.equal(result.all.transactions.unique_selected_associated_account_count, 1);
  assert.equal(result.all.source_reported.member_count, 1001);
});

test('repeat sales and package totals remain transactions, with outside-pocket links retained', () => {
  const result = preview(fixture({ sales: [sale(1), sale(2)], links: [link(1, 1, 'B'), link(2, 1, 'OUTSIDE'), link(3, 1, null)] }));
  assert.equal(result.selected.transactions.member_count, 2);
  assert.equal(result.selected.transactions.unique_selected_associated_account_count, 1);
  assert.equal(result.selected.transactions.unique_associated_account_count, 3);
  const row = result.selected.transactions.members[0];
  assert.deepEqual(row.associated_account_ids, ['A', 'B', 'OUTSIDE']); assert.equal(row.unresolved_link_count, 1);
  assert.equal(row.recorded_total_price.value, 330000); assert.equal(row.multiple_parcel_evidence, true);
  assert.equal(result.selected.transactions.package_evidence_transaction_count, 1);
  assert.ok(row.source_references.some(ref => ref.record_id.includes('sale_parcels:3')));
});

test('overlapping pockets are compared separately; selected union never double-counts members/events', () => {
  const result = preview(fixture({ pockets: [{ id: 'one', label: 'One', account_ids: ['A'] },
    { id: 'two', label: 'Two', account_ids: ['A', 'B'] }], sales: [sale(1), sale(2, 'B')] }));
  assert.equal(result.selected.stock.member_count, 2); assert.equal(result.selected.transactions.member_count, 2);
  assert.deepEqual(result.pockets.map(p => p.overlap_account_count), [1, 1]);
  assert.deepEqual({ ...result.selected, id: result.all.id }, result.all);
  assert.deepEqual({ ...result.pockets[1].result, id: result.all.id }, result.all);
  assert.ok(result.pockets.every(p => p.disposition === 'needs_review'));
});

test('empty selection remains empty rather than falling back to the full cohort', () => {
  const result = preview(fixture({ pockets: [] }));
  assert.equal(result.all.stock.member_count, 2); assert.equal(result.selected.stock.member_count, 0);
  assert.equal(result.selected.transactions.member_count, 0); assert.equal(result.selected.source_reported.member_count, 0);
  const metric = result.selected.stock.metrics.gla_sqft;
  assert.equal(metric.median, null); assert.equal(metric.coverage_percent, null); assert.equal(metric.reason, 'no_observations');
});

test('unavailable, zero, invalid, partial and conflicting account measurements keep separate counts', () => {
  const result = preview(fixture({ accounts: ['A', 'B', 'C', 'D', 'E'], parcels: [
    parcel(1, 'A', { residential_area_sqft: null }), parcel(2, 'B', { residential_area_sqft: '0', current_market_value: '0', parcel_area_sqft: '0' }),
    parcel(3, 'C'), parcel(4, 'C', { residential_area_sqft: '1900' }),
    parcel(5, 'D'), parcel(6, 'D', { residential_area_sqft: null })] }));
  const metric = result.all.stock.metrics.gla_sqft;
  assert.equal(metric.member_count, 5); assert.equal(metric.count, 1); assert.equal(metric.missing_count, 4);
  assert.equal(metric.conflicting_count, 1); assert.equal(metric.invalid_count, 1); assert.equal(metric.absent_count, 2);
  assert.equal(metric.partially_observed_count, 1); assert.equal(metric.coverage_percent, 20);
  assert.equal(result.all.stock.parcel_object_count, 6);
  assert.equal(result.all.stock.metrics.assessed_value.low, 0); assert.equal(result.all.stock.metrics.site_area_sqft.low, 0);
  assert.equal(result.all.stock.members.find(row => row.account_id === 'E').observations.gla_sqft.state, 'missing');
});

test('exact retained decimal conflicts cannot disappear through floating-point equality', () => {
  const result = preview(fixture({ parcels: [parcel(1, 'A', { current_market_value: '9007199254740992.00' }),
    parcel(2, 'A', { current_market_value: '9007199254740993.00' }), parcel(3, 'B', { current_market_value: '330000.0000' })] }));
  const a = result.all.stock.members[0].observations.assessed_value;
  assert.equal(a.state, 'conflicting'); assert.equal(a.value, null);
  assert.deepEqual(a.raw_values, ['9007199254740992.00', '9007199254740993.00']);
  assert.equal(result.all.stock.members[1].observations.assessed_value.exact_value, '330000');
});

test('identical decimal representations agree, and account CAD observations are never summed across parcels', () => {
  const result = preview(fixture({ parcels: [parcel(1, 'A', { residential_area_sqft: '01800.1250' }), parcel(2, 'A')], sales: [] }));
  assert.equal(result.all.stock.members[0].observations.gla_sqft.value, 1800.125);
  assert.equal(result.all.stock.member_count, 2); assert.equal(result.all.stock.metrics.gla_sqft.count, 1);
  assert.equal(result.all.stock.metrics.gla_sqft.median, 1800.125);
});

test('out-of-period and unknown/conflicting dates do not enter the sale-price denominator', () => {
  const result = preview(fixture({ sales: [sale(1), sale(2, 'A', { sale_closing_date: '2023-06-30' }),
    sale(3, 'A', { sale_closing_date: '2024-07-01' }), sale(4, 'A', { sale_closing_date: null }),
    sale(5, 'A', { sale_id: '9' }), sale(6, 'A', { sale_id: '9', sale_closing_date: '2024-04-01' })] }));
  assert.equal(result.all.transactions.member_count, 1);
  assert.deepEqual(result.all.transactions.omitted.map(row => row.disposition), ['outside_period', 'outside_period', 'missing_date', 'conflicting_date']);
  assert.equal(result.all.source_reported.member_count, 6, 'all-date source population is explicitly separate');
});

test('canonical price disagreements stay missing, not merged, and source prices do not override canonical consideration', () => {
  const result = preview(fixture({ sales: [sale(1, 'A', { sale_id: '9', sale_price: '100' }), sale(2, 'A', { sale_id: '9', sale_price: '200' }),
    sale(3, 'A', { sale_price: null, source_current_price: '600000' }), sale(4, 'A', { sale_price: '0' })] }));
  const price = result.all.transactions.metrics.recorded_total_price;
  assert.equal(price.member_count, 3); assert.equal(price.count, 1); assert.equal(price.missing_count, 2);
  assert.equal(price.conflicting_count, 1); assert.equal(price.median, 0);
  assert.equal(result.all.transactions.members.find(row => row.canonical_transaction_id === '3').recorded_total_price.value, null);
});

test('a source-only listing is not promoted to a canonical transaction or a completed sale', () => {
  const result = preview(fixture({ sales: [sale(1, 'A', { sale_id: null, sale_account_id: null, sale_closing_date: null, record_type: 'listing' })] }));
  assert.equal(result.all.transactions.member_count, 0);
  assert.equal(result.all.source_reported.member_count, 1); assert.equal(result.all.source_reported.without_canonical_transaction_count, 1);
  assert.equal(result.selected.source_reported.member_count, 1);
  assert.deepEqual(result.all.source_reported.members[0].record_types, ['listing']);
});

test('every returned member reference resolves to the retained routing without source data mutation', () => {
  const input = fixture({ links: [link(1, 1, 'B')] }), result = preview(input);
  const sources = input.retained_inputs.acquisition.capture_result.source_capture.sources;
  const available = new Set(sources.flatMap(source => source.payload.records.map(row => `${source.id}:${row.record_id}`)));
  for (const population of [result.all, result.selected, ...result.pockets.map(p => p.result)]) {
    for (const member of [...population.stock.members, ...population.transactions.members, ...population.source_reported.members]) {
      assert.ok(member.source_references.length); assert.ok(member.source_references.every(ref => available.has(`${ref.source_ref}:${ref.record_id}`)));
    }
  }
});

for (const [name, change, pattern] of [
  ['foreign pocket account', i => { i.selection.pockets[0].account_ids.push('OUTSIDE'); }, /pocket_membership/],
  ['duplicate pocket account', i => { i.selection.pockets[0].account_ids.push('A'); }, /pocket_membership/],
  ['duplicate pocket id', i => { i.selection.pockets.push({ ...i.selection.pockets[0] }); }, /duplicate_pocket/],
  ['invalid selection revision', i => { i.selection.revision = 0; }, /selection_revision/],
  ['missing retained capture', i => { i.retained_inputs = null; }, /retained_capture_required/],
  ['incomplete capture', i => { i.retained_inputs.acquisition.capture_result.query_complete = false; }, /retained_capture_required/],
  ['changed subject scope', i => { i.retained_inputs.subject.target.account_id = 'FOREIGN'; }, /scope_mismatch/],
  ['changed roster', i => { i.retained_inputs.spatial.account_ids = ['A']; }, /roster_mismatch/],
  ['unknown mapping', i => { const s = i.retained_inputs.acquisition.capture_result.source_capture.sources.find(s => s.payload.projection.definition.role === 'parcels');
    s.payload.records[0].data.data.cached_mapping_version = 999; }, /mapping_v2_required/],
  ['missing source role', i => { i.retained_inputs.acquisition.capture_result.source_capture.sources.pop(); }, /source_roles_missing/],
  ['missing source routing', i => { i.retained_inputs.acquisition.capture_result.source_capture.references[0].record_sources.length = 0; }, /source_routing/],
]) test(`fails closed on ${name}, without a partial preview`, () => {
  const input = structuredClone(fixture()); change(input); assert.throws(() => preview(input), pattern);
});

test('hostile and unknown numeric strings are unavailable, not evaluated or coerced to zero', () => {
  const result = preview(fixture({ parcels: [parcel(1, 'A', { residential_area_sqft: '<script>alert(1)</script>', current_market_value: 'unknown' })],
    sales: [sale(1, 'A', { source_days_on_market: '1e6', source_living_area: null, sale_price: 'N/A' })],
    pockets: [{ id: 'a', label: '<img src=x onerror=alert(1)>', account_ids: ['A'] }] }));
  assert.equal(result.all.stock.metrics.gla_sqft.median, null); assert.equal(result.all.stock.metrics.gla_sqft.invalid_count, 1);
  assert.equal(result.all.source_reported.metrics.days_on_market.median, null);
  assert.equal(result.all.transactions.metrics.recorded_total_price.median, null);
  assert.equal(result.pockets[0].label, '<img src=x onerror=alert(1)>', 'plain data; the host must use escaped text rendering');
});

test('work budgets reject a complete oversized computation, never a sampled prefix', () => {
  const input = fixture({ sales: Array.from({ length: 1500 }, (_, i) => sale(i + 1)),
    pockets: Array.from({ length: 128 }, (_, i) => ({ id: `p-${i}`, label: `Pocket ${i}`, account_ids: ['A'] })) });
  assert.throws(() => preview(input), /work_limit|output_bytes_limit/);
});

test('serialized output budget charges repeated member observations in overlapping pockets', () => {
  const input = fixture({ sales: [sale(1, 'A', { source_living_area: 'x'.repeat(300000) })],
    pockets: Array.from({ length: 128 }, (_, i) => ({ id: `p-${i}`, label: `Pocket ${i}`, account_ids: ['A'] })) });
  assert.throws(() => preview(input), /output_bytes_limit/);
});

test('reported output byte bound covers the whole serialized result', () => {
  const result = preview(fixture());
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= result.work.output_utf8_bytes_bound);
});

test('invalid structured numeric observations are copied without freezing caller objects', () => {
  const input = structuredClone(fixture({ sales: [sale(1, 'A', { source_living_area: { unknown: ['literal'] } })] }));
  const source = input.retained_inputs.acquisition.capture_result.source_capture.sources.find(s => s.payload.projection.definition.role === 'transactions');
  const original = source.payload.records[0].data.raw_projection.source_living_area;
  assert.equal(Object.isFrozen(original), false);
  const result = preview(input);
  assert.equal(result.all.source_reported.metrics.living_area.invalid_count, 1);
  assert.equal(Object.isFrozen(original), false);
  original.unknown.push('still mutable');
  assert.deepEqual(result.all.source_reported.members[0].observations.living_area.raw_values, [{ unknown: ['literal'] }]);
});

const RETENTION_NOW = '2026-09-06T08:00:00.123456Z', RETENTION_MS = '2026-09-06T08:00:00.123Z';
const RETENTION_RUN = '60000000-0000-4000-8000-000000000001';
const RETENTION_SNAPSHOT = { backend_pid: 1234, snapshot: '100:100:', transaction_started_at: '2026-09-06T08:00:00.000000Z' };
const RETENTION_GEOMETRY = '010203', RETENTION_GEOMETRY_HASH = createHash('sha256').update(Buffer.from(RETENTION_GEOMETRY, 'hex')).digest('hex');
const retentionReaderSource = readFileSync(new URL('../src/services/neighborhoodAssessment/cachedSourceReader.js', import.meta.url), 'utf8');
const retentionTableText = retentionReaderSource.match(/const TABLES = Object.freeze\(\{([\s\S]*?)\n\}\);/)[1];
const RETENTION_CATALOG = [...retentionTableText.matchAll(/\['([a-z_]+\.[a-z_]+)', '([^']+)'\]/g)]
  .flatMap(([, relation, columns]) => columns.split(' ').map(column => ({ relation, column })));

// Actual repository, spatial reader, access factory, source reader and consumed
// handoff over bounded query fakes. This is NOT native PostgreSQL/MVCC evidence.
async function retainedFixture({ parcelCount = 2, linkCount = 1, accountCount = 2, omitAccountRows = false, qualityFlags = [] } = {}) {
  const f = customCohortRepositoryFixture(), t = f.state.input.target;
  const originalProperty = JSON.parse(f.state.input.snapshot.subject_data.pg_text).custom_property_snapshot;
  setPublic(f.state.input, { ...originalProperty, location: { account_id: t.account_id, longitude: -96.65, latitude: 32.91,
    source: 'dcad_parcel_query', precision: 'parcel_centroid', status: 'matched', confidence: 'high',
    review_required: false, review_reason: null, match_method: 'parcel_id', source_parcel_id: t.account_id,
    feature_count: 1, metadata: { address_agreement: true }, geocoded_at: '2023-12-31T00:00:00.000Z', source_updated_at: null } });
  const subjectRef = await f.repo.capture(), subject = await f.repo.load(subjectRef), point = await f.repo.loadRecordedPoint(subjectRef);
  assert.equal(point.status, 'represented');
  const accountIds = accountCount === 2 ? [t.account_id, 'R-001']
    : [t.account_id, ...Array.from({ length: accountCount - 1 }, (_, i) => `R-${String(i).padStart(62, '0')}`)];
  const parcels = Array.from({ length: parcelCount }, (_, i) => ({ object_id: String(9007199254740993n + BigInt(i)),
    account_id: accountIds[i % accountIds.length], source_record_hash: 'a'.repeat(64), sync_run_id: RETENTION_RUN,
    synced_at: RETENTION_NOW, source_updated_at: null, geometry_sha256: RETENTION_GEOMETRY_HASH }));
  const transaction = { source_record_id: '10', sale_id: '20', primary_account_id: t.account_id,
    sale_account_id: t.account_id, source_record_hash: 'b'.repeat(64) };
  const links = Array.from({ length: linkCount }, (_, i) => ({ parcel_link_id: String(100 + i), source_record_id: '10',
    source_position: 1, parcel_sequence: i + 1, account_id: i % 2 ? null : 'R-LINKED-ONLY', is_resolved: i % 2 ? false : true }));
  const cacheClient = { release() { assert.fail('caller owns release'); }, async query(config) {
    const values = config.values ?? [], tag = config.text.match(/neighborhood-(?:cache|membership):([\w-]+)/)?.[1];
    if (['snapshot', 'snapshot-end', 'caller-snapshot'].includes(tag)) return { rows: [{ ...RETENTION_SNAPSHOT,
      isolation: 'repeatable read', read_only: 'on', timezone: 'UTC', explicit_transaction: true,
      statement_ms: 5000, lock_ms: 1000, idle_ms: 10000 }] };
    if (tag === 'geometry-eligibility') return { rows: [] };
    if (config.text.includes('neighborhood-membership:parcels')) return { rows: parcels
      .filter(p => values[2] === null || BigInt(p.object_id) > BigInt(values[2])).slice(0, values[3]).map(payload => ({ payload })) };
    if (tag === 'scope') return { rows: [{ case_date: subject.effective_date, snapshot_date: subject.effective_date,
      effective_date: subject.effective_date, captured_at: RETENTION_MS, captured_at_precise: RETENTION_NOW }] };
    if (tag === 'capabilities') return { rows: RETENTION_CATALOG };
    let rows;
    switch (tag) {
      case 'parcels': rows = parcels.filter(p => BigInt(p.object_id) > BigInt(values[1])).slice(0, values[2]).map(p => ({
        ...p, stored_geometry_ewkb: RETENTION_GEOMETRY, residential_year_built: 2000, residential_area_sqft: '1800.125',
        parcel_area_sqft: '6000.00', current_market_value: '350000', land_use_category: 'one_unit', classification_confidence: 'high' })); break;
      case 'accounts': rows = omitAccountRows ? [] : accountIds.filter(id => id > values[1]).slice(0, values[2]).map(account_id => ({ account_id, subdivision: 'Recorded fixture plat' })); break;
      case 'sync-state': rows = [{ source_key: 'dcad_parcels', status: 'current', row_count: String(parcelCount), last_run_id: RETENTION_RUN, last_success_at: RETENTION_MS }]; break;
      case 'sync-runs': rows = [{ id: RETENTION_RUN, source_key: 'dcad_parcels', status: 'complete', mode: 'full', started_at: '2026-09-05T00:00:00.000Z', completed_at: RETENTION_MS }]; break;
      case 'source-ids': rows = values[1] === '0' ? [{ source_record_id: '10' }] : []; break;
      case 'transaction-identities': rows = [transaction]; break;
      case 'transactions': rows = [{ ...transaction, record_type: 'closed_sale', sale_closing_date: '2024-03-01',
        source_close_date: '2024-03-01', sale_price: '275000.00', source_current_price: '275000.00', source_living_area: '1850.125',
        source_year_built: 2001, source_garage_yn: false, source_housing_type: 'Recorded label, not an eligibility decision',
        source_days_on_market: 0, data_quality_flags: qualityFlags }]; break;
      case 'link-identities': case 'sale-links': rows = links.filter(p => p.parcel_sequence > values[3]).slice(0, values[4]); break;
      case 'legacy-identities': case 'legacy': rows = []; break;
      default: assert.fail(`Unexpected source query ${tag}`);
    }
    return { rows: rows.map(payload => ({ payload, row_bytes: Buffer.byteLength(JSON.stringify(payload)) })) };
  } };
  const spatial = await captureNeighborhoodSpatialMembership(cacheClient, point.geometry_input);
  assert.equal(spatial.status, 'captured');
  const scope = customCohortScopeOf(f.state.input), scopeJson = json(scope);
  const target = { report_file_id: t.report_file_id, workflow_type: 'custom_appraisal', workflow_target_id: t.assignment_file_id };
  const readScope = { organization_id: t.organization_id, appraisal_case_id: t.appraisal_case_id, subject_snapshot_id: t.subject_snapshot_id, account_id: t.account_id };
  const selector = prepareNeighborhoodSelectorInputV1({ profile_id: 'custom-simple-suburban-radius-v1', target, scope: readScope,
    effective_date: subject.effective_date, selection: { id: 'original-fixture-selection', revision: 1, source_sha256: spatial.membership_sha256 },
    geometry_input: point.geometry_input, discovery: { radius_metres: '4828.032', distance_semantics: 'postgis_geography_spheroid_v1', parcel_predicate: 'all_intersecting_parcels' },
    roster: { complete: true, account_count: accountIds.length, account_ids: accountIds } });
  assert.equal(selector.status, 'prepared');
  const study = { profile_id: selector.query_input.definition.profile_id,
    observation_period: { start_date: '2023-07-01', end_date: '2024-06-30' }, knowledge_cutoff: null };
  const access = createTestCachedReadAccess({ target, scope: readScope, effective_date: subject.effective_date,
    selection: selector.selection, account_ids: accountIds, ...study }, { transactionClosure: {
    source_revision: 'original-fixture-closure-v1', transactions: [transaction], links, legacy: [] } });
  const issued = await access.prepare(), reader = createNeighborhoodCachedSourceReader({ connect() { assert.fail('must use owner'); } }, { access: access.access });
  const result = await reader.captureInSnapshot(cacheClient, { ...issued.request, auth: access.auth,
    selection_grant: issued.selection_grant, market_grant: issued.market_grant });
  assert.equal(result.status, 'captured', JSON.stringify(result.incomplete_reasons));
  const acquisition = consumeNeighborhoodCachedAcquisition(reader, result);
  const store = createNeighborhoodCohortBlobRepository(f.client, scope.organization_id);
  const intentBody = { intent_version: 1, operation_id: '30000000-0000-4000-8000-000000000001', actor_user_id: access.auth.userId,
    subject_inputs: subjectRef, target: subject.target, effective_date: subject.effective_date, study, created_at: '2026-09-06T07:59:59.000000Z' };
  const intentRef = await store.put(json(intentBody));
  const input = { acquisition, spatial, subject, subject_reference: subjectRef, selector, study,
    acquisition_intent: { reference: intentRef, body: intentBody }, started_at: '2026-09-06T08:00:00.010000Z', completed_at: '2026-09-06T08:00:01.000000Z' };
  const query = f.client.query.bind(f.client);
  f.client.query = (sql, values) => query(sql.replace('custom-cohort-capture:transaction', 'custom-cohort-selection:transaction'), values);
  f.state.calls.length = 0;
  return { ...f, input, scope, scopeJson, store, reader };
}

test('consumes the actual persisted/reopened original graph without requiring a new query or original handle', async () => {
  const f = await retainedFixture({ linkCount: 251 });
  const refs = await persistCustomCohortCaptureInputs(f.client, f.scopeJson, prepareCustomCohortCaptureInputs(f.input));
  const retained = await loadCustomCohortCaptureInputs(f.client, f.scopeJson, refs);
  const before = f.state.calls.length, original = JSON.stringify(retained);
  const result = preview({ context_ref, retained_inputs: retained.retained_inputs,
    selection: { revision: 3, pockets: [{ id: 'subject-pocket', label: 'Subject pocket', account_ids: [f.input.subject.target.account_id] }] } });
  assert.equal(f.state.calls.length, before, 'the numeric consumer performs no SQL');
  assert.equal(JSON.stringify(retained), original);
  assert.equal(result.all.stock.member_count, 2);
  assert.equal(result.all.stock.metrics.gla_sqft.median, 1800.125);
  assert.equal(result.all.transactions.member_count, 1);
  assert.equal(result.all.transactions.metrics.recorded_total_price.median, 275000);
  assert.equal(result.all.source_reported.metrics.living_area.median, 1850.125);
  assert.equal(result.selected.stock.member_count, 1);
  assert.equal(result.selected.transactions.members[0].unresolved_link_count, 125);
  assert.ok(result.selected.transactions.members[0].associated_account_ids.includes('R-LINKED-ONLY'));
  assert.equal(result.selection_revision, 3);
  assert.equal(result.apply.status, 'blocked');
});
