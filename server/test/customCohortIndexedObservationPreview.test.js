import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCustomCohortObservationPreview as expanded,
  buildCustomCohortIndexedObservationPreview as indexed, buildCustomCohortIndexedObservationPreviewBatched as batched,
  customCohortObservationMembers as members, isCustomCohortObservationPreview as supported,
  CUSTOM_COHORT_OBSERVATION_PREVIEW_LIMITS as L } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
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
const link = (id, source, account) => ({ parcel_link_id: String(id), source_record_id: String(source),
  source_position: 1, parcel_sequence: id, account_id: account, is_resolved: account !== null, match_method: 'exact' });

// Pure synthetic inputs through the actual mappers/source chunker. These test
// consumer representation, not original acquisition, database or authority.
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

const populations = view => [view.all, view.selected, ...view.pockets.map(pocket => pocket.result)];
const kinds = ['stock', 'transactions', 'omitted_transactions', 'source_reported'];
function expandedPopulation(view, population) {
  const result = { ...population };
  for (const kind of ['stock', 'transactions', 'source_reported']) {
    const { member_indices, omitted_indices, ...fields } = population[kind];
    result[kind] = { ...fields, members: members(view, population, kind),
      ...(kind === 'transactions' ? { omitted: members(view, population, 'omitted_transactions') } : {}) };
  }
  return result;
}
function assertParity(args) {
  const old = expanded(args), next = indexed(args);
  const { preview_version, representation, member_tables, work, ...nextFields } = next;
  const { work: oldWork, ...oldFields } = old;
  assert.deepEqual({ ...nextFields, preview_version: 1, all: expandedPopulation(next, next.all),
    selected: expandedPopulation(next, next.selected), pockets: next.pockets.map(pocket => ({ ...pocket,
      result: expandedPopulation(next, pocket.result) })) }, oldFields);
  for (const key of ['source_records', 'measurement_values', 'member_work']) assert.equal(work[key], oldWork[key]);
  assert.ok(Buffer.byteLength(JSON.stringify(next)) <= work.output_utf8_bytes_bound);
  assert.ok(work.output_utf8_bytes_bound <= L.output_utf8_bytes);
  for (let i = 0; i < populations(old).length; i++) for (const kind of kinds) {
    assert.deepEqual(members(next, populations(next)[i], kind), members(old, populations(old)[i], kind));
  }
  return next;
}

test('both representations share exact observations, metrics, provenance and work except serialized bytes', () => {
  const args = fixture(), before = JSON.stringify(args), next = assertParity(args);
  assert.equal(next.preview_version, 2); assert.equal(next.representation, 'indexed_members_v1');
  assert.equal(JSON.stringify(args), before);
  assert.deepEqual(Object.keys(next.member_tables), ['stock', 'transactions', 'source_reported']);
  assert.ok(supported(next)); assert.ok(supported(expanded(args)));
});

test('cell reuse preserves exact raw types and formatting instead of merging equal numeric values', () => {
  const next = assertParity(fixture({ accounts: ['A', 'B', 'C', 'D'], parcels: [
    parcel(1), parcel(2, 'B'), parcel(3, 'C', { residential_area_sqft: '1800.1250' }),
    parcel(4, 'D', { residential_area_sqft: 1800.125 }),
  ] }));
  const [a, b, c, d] = next.member_tables.stock.map(row => row.observations.gla_sqft);
  assert.equal(a, b); assert.ok(Object.isFrozen(a)); assert.ok(Object.isFrozen(a.raw_values));
  assert.notEqual(a, c); assert.notEqual(a, d);
  assert.equal(a.value, c.value); assert.equal(a.value, d.value);
  assert.deepEqual(a.raw_values, ['1800.125']); assert.deepEqual(c.raw_values, ['1800.1250']);
  assert.deepEqual(d.raw_values, [1800.125]);
  assert.notDeepEqual(next.member_tables.stock[0].source_references, next.member_tables.stock[1].source_references);
});

test('cooperative preview seals shallow-frozen input, yields, preserves every result and cancels without a partial return', async () => {
  const args = fixture(), expected = indexed(args); Object.freeze(args);
  let yielded = false; setImmediate(() => { yielded = true; });
  const pending = batched(args);
  assert.throws(() => { args.selection.revision = 100; }, TypeError);
  const actual = await pending; assert.equal(yielded, true); assert.deepEqual(actual, expected);
  assert.ok(Buffer.byteLength(JSON.stringify(actual)) <= actual.work.output_utf8_bytes_bound);
  let cancelled = false; setImmediate(() => { cancelled = true; });
  await assert.rejects(batched(fixture(), { check() { if (cancelled) throw new Error('synthetic_cancel'); } }), /synthetic_cancel/);
});

test('full tables occur once in real JSON; populations contain only ordered indices', () => {
  const next = indexed(fixture({ pockets: [{ id: 'both', label: 'Both', account_ids: ['B', 'A'] },
    { id: 'one', label: 'One', account_ids: ['A'] }] }));
  for (const population of populations(next)) for (const kind of ['stock', 'transactions', 'source_reported']) {
    assert.equal(Object.hasOwn(population[kind], 'members'), false);
    assert.equal(Object.hasOwn(population[kind], 'omitted'), false);
    const indices = population[kind].member_indices;
    assert.equal(new Set(indices).size, indices.length);
    assert.deepEqual([...indices].sort((a, b) => a - b), indices);
  }
  const encoded = JSON.stringify(next), plain = JSON.parse(encoded);
  assert.equal((encoded.match(/"parcel_object_ids":/g) ?? []).length, 2);
  assert.deepEqual(plain.member_tables, next.member_tables);
  const returned = members(next, next.selected, 'stock');
  assert.strictEqual(returned[0], next.member_tables.stock[0]);
  assert.ok(Object.isFrozen(returned)); assert.equal(JSON.stringify(next), encoded);
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    assert.ok(Object.isFrozen(value)); assert.equal(Object.getOwnPropertySymbols(value).length, 0);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      assert.ok(Object.hasOwn(descriptor, 'value')); assert.notEqual(typeof descriptor.value, 'function');
      visit(descriptor.value);
    }
  }
  visit(next);
});

test('empty selection, overlapping pockets and package/outside links preserve every denominator', () => {
  assertParity(fixture({ pockets: [] }));
  const next = assertParity(fixture({ sales: [sale(1), sale(2, 'B')],
    links: [link(1, 1, 'B'), link(2, 1, 'OUTSIDE'), link(3, 1, null)],
    pockets: [{ id: 'a', label: 'A', account_ids: ['A'] }, { id: 'both', label: 'Both', account_ids: ['A', 'B'] }] }));
  assert.equal(next.selected.stock.member_count, 2); assert.equal(next.selected.transactions.member_count, 2);
  assert.deepEqual(members(next, next.pockets[0].result, 'transactions')[0].associated_account_ids, ['A', 'B', 'OUTSIDE']);
  assert.equal(members(next, next.pockets[0].result, 'transactions')[0].unresolved_link_count, 1);
  assert.deepEqual(next.pockets.map(p => p.overlap_account_count), [1, 1]);
});

test('all retains unassociated/source-only rows and separate omitted canonical date dispositions', () => {
  const next = assertParity(fixture({ sales: [sale(1), sale(2, null), sale(3, 'A', { sale_id: null, record_type: 'listing' }),
    sale(4, 'A', { sale_closing_date: '2023-06-30' }), sale(5, 'A', { sale_closing_date: null }),
    sale(6, 'A', { sale_id: '9' }), sale(7, 'A', { sale_id: '9', sale_closing_date: '2024-04-01' })] }));
  assert.deepEqual(members(next, next.all, 'omitted_transactions').map(row => row.disposition),
    ['outside_period', 'missing_date', 'conflicting_date']);
  assert.equal(next.all.transactions.member_count, 2); assert.equal(next.selected.transactions.member_count, 1);
  assert.equal(next.all.source_reported.member_count, 7); assert.equal(next.selected.source_reported.member_count, 6);
  assert.equal(next.member_tables.transactions.length, 5);
});

test('partial/missing/invalid/conflicting numeric rows preserve exact strings and copied raw values', () => {
  const args = fixture({ accounts: ['A', 'B', 'C'], parcels: [parcel(1, 'A', { current_market_value: '9007199254740992.00' }),
    parcel(2, 'A', { current_market_value: '9007199254740993.00' }), parcel(3, 'B'), parcel(4, 'B', { residential_area_sqft: null })],
  sales: [sale(1, 'A', { source_living_area: { unknown: ['literal'] } })] });
  const next = assertParity(args);
  assert.equal(next.member_tables.stock[0].observations.assessed_value.state, 'conflicting');
  assert.equal(next.all.stock.metrics.gla_sqft.partially_observed_count, 1);
  assert.equal(next.member_tables.stock[2].observations.gla_sqft.state, 'missing');
  const row = args.retained_inputs.acquisition.capture_result.source_capture.sources
    .find(source => source.payload.projection.definition.role === 'transactions').payload.records[0];
  assert.equal(Object.isFrozen(row.data.raw_projection.source_living_area), true, 'source chunker owns its frozen copy');
  assert.deepEqual(next.member_tables.source_reported[0].observations.living_area.raw_values, [{ unknown: ['literal'] }]);
});

test('serialized clones, counterfeit tags and cross-preview populations cannot become issued compact views', () => {
  const first = indexed(fixture()), second = indexed(fixture());
  for (const value of [null, {}, { preview_version: 2, representation: 'indexed_members_v1' },
    JSON.parse(JSON.stringify(first)), structuredClone(first), { ...first }]) {
    assert.equal(supported(value), false);
    assert.throws(() => members(value, value?.all, 'stock'), /unsupported_representation/);
  }
  for (const population of [null, {}, structuredClone(first.all), second.all, first.all.stock]) {
    assert.throws(() => members(first, population, 'stock'), /population_ownership/);
  }
  for (const kind of [null, undefined, 'account', 'constructor', '__proto__']) {
    assert.throws(() => members(first, first.all, kind), /member_kind/);
  }
});

for (const [name, change] of [
  ['negative index', view => { view.all.stock.member_indices = [-1]; }],
  ['out-of-range index', view => { view.all.stock.member_indices = [50000]; }],
  ['duplicate index', view => { view.all.stock.member_indices = [0, 0]; }],
  ['unordered index', view => { view.all.stock.member_indices = [1, 0]; }],
  ['wrong table', view => { view.member_tables.stock = view.member_tables.transactions; }],
  ['wrong count', view => { view.all.stock.member_count = 99; }],
  ['changed row', view => { view.member_tables.stock[0].account_id = 'FOREIGN'; }],
]) test(`compact ${name} cannot enter via reconstructed JSON`, () => {
  const view = structuredClone(indexed(fixture())); change(view);
  assert.throws(() => members(view, view.all, 'stock'), /unsupported_representation/);
});

test('issued rows/indices cannot be mutated and version relabeling cannot manufacture legacy members', () => {
  const view = indexed(fixture());
  assert.throws(() => view.all.stock.member_indices.push(0), TypeError);
  assert.throws(() => { view.member_tables.stock[0].account_id = 'FOREIGN'; }, TypeError);
  const relabeled = { ...view, preview_version: 1 };
  assert.throws(() => members(relabeled, relabeled.all, 'stock'), /population_members_limit/);
});

test('compaction removes actual repeated JSON, not existing member-work protection', () => {
  const args = fixture({ sales: [sale(1, 'A', { source_living_area: 'x'.repeat(300000) })],
    pockets: Array.from({ length: 128 }, (_, i) => ({ id: `p-${i}`, label: `Pocket ${i}`, account_ids: ['A'] })) });
  assert.throws(() => expanded(args), /output_bytes_limit/);
  const view = indexed(args), encoded = JSON.stringify(view);
  assert.ok(Buffer.byteLength(encoded) < 4000000); assert.equal(view.pockets.length, 128);
  assert.equal((encoded.match(/x{300000}/g) ?? []).length, 1);
  assert.equal(members(view, view.pockets[127].result, 'source_reported').length, 1);
  const busy = fixture({ sales: Array.from({ length: 2000 }, (_, i) => sale(i + 1)),
    pockets: Array.from({ length: 128 }, (_, i) => ({ id: `p-${i}`, label: 'Same full population', account_ids: ['A', 'B'] })) });
  assert.throws(() => indexed(busy), /work_limit/);
});

test('ten thousand all-selected accounts serialize once, with complete ordered membership and no v1 cap raise', () => {
  const accounts = Array.from({ length: 10000 }, (_, i) => String(10000000000000000n + BigInt(i)));
  const args = fixture({ accounts, parcels: accounts.map((id, i) => parcel(i + 1, id)), sales: [],
    pockets: [{ id: 'union', label: 'Exact selected union', account_ids: accounts }] });
  assert.throws(() => expanded(args), /output_bytes_limit/);
  const view = indexed(args), encoded = JSON.stringify(view);
  assert.ok(Buffer.byteLength(encoded) <= view.work.output_utf8_bytes_bound);
  assert.ok(view.work.output_utf8_bytes_bound <= 32000000);
  assert.equal(view.member_tables.stock.length, 10000);
  for (const population of populations(view)) {
    assert.equal(population.stock.member_count, 10000);
    assert.deepEqual(members(view, population, 'stock').map(row => row.account_id), accounts);
    assert.deepEqual(population.stock.metrics, view.all.stock.metrics);
  }
  assert.equal(view.work.source_records, 30000);
  assert.equal(L.output_utf8_bytes, 32000000);
});

test('a unique table over the unchanged ceiling still refuses the entire result', () => {
  // Deliberately malformed pure input, not an asserted valid retained capture:
  // the trusted consumer must still bound serialized observations it creates.
  const args = structuredClone(fixture());
  const row = args.retained_inputs.acquisition.capture_result.source_capture.sources
    .find(source => source.payload.projection.definition.role === 'transactions').payload.records[0];
  row.data.raw_projection.source_living_area = 'x'.repeat(L.output_utf8_bytes);
  assert.throws(() => indexed(args), /output_bytes_limit/);
});

for (const [name, change, reason] of [
  ['foreign account', args => args.selection.pockets[0].account_ids.push('FOREIGN'), 'pocket_membership'],
  ['duplicate membership', args => args.selection.pockets[0].account_ids.push('A'), 'pocket_membership'],
  ['missing routing', args => { args.retained_inputs.acquisition.capture_result.source_capture.references = []; }, 'source_routing'],
  ['wrong scope', args => { args.retained_inputs.subject.target.organization_id = 'foreign'; }, 'scope_mismatch'],
  ['incomplete source', args => { args.retained_inputs.acquisition.capture_result.query_complete = false; }, 'retained_capture_required'],
]) test(`indexed builder preserves ${name} admission refusal`, () => {
  const args = structuredClone(fixture()); change(args);
  assert.throws(() => indexed(args), new RegExp(reason));
});
