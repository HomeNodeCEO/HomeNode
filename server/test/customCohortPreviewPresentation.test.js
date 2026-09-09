import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildCustomCohortObservationPreview as preview } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { presentCustomCohortPreview as present, inspectCustomCohortPreviewMembers as inspect,
  CUSTOM_COHORT_PREVIEW_PRESENTATION_LIMITS as LIMITS } from '../src/services/neighborhoodAssessment/customCohortPreviewPresentation.js';
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
// original-acquisition authority; the numeric consumer has its own real loader round-trip regression.
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

const built = options => preview(fixture(options));
const expected = source => ({ context_ref: source.context_ref, selection_revision: source.selection_revision });
const summary = source => present({ preview: source, expected: expected(source) });
const page = (source, population = { group: 'all', kind: 'stock' }, after_member_id = null, limit = 50) =>
  inspect({ preview: source, expected: expected(source), population, page: { limit, after_member_id } });
const groups = source => [source.all, source.selected, ...source.pockets.map(p => p.result)];

test('actual numeric summaries preserve every metric, denominator, unit and caveat without recomputation', () => {
  const source = built({ sales: [sale(1, 'A', { sale_price: '330000.1234' })] }), result = summary(source);
  assert.equal(result.presentation_version, 1); assert.equal(result.preview_version, 1);
  assert.equal(result.status, 'observations_only'); assert.equal(result.provider_coverage, 'not_established');
  assert.equal(result.members_included, false); assert.equal(result.apply.status, 'blocked');
  assert.deepEqual(result.support_gaps, source.support_gaps); assert.deepEqual(result.unavailable_metrics, source.unavailable_metrics);
  assert.deepEqual(result.apply, source.apply);
  for (const [index, group] of groups(source).entries()) {
    const output = groups(result)[index];
    assert.equal(output.account_count, group.account_ids.length);
    for (const kind of ['stock', 'transactions', 'source_reported']) {
      assert.equal(output[kind].member_count, group[kind].member_count);
      for (const [key, metric] of Object.entries(group[kind].metrics)) {
        const { display, ...copy } = output[kind].metrics[key]; assert.deepEqual(copy, metric);
        assert.ok(display); assert.equal(output[kind].inspection.total_count, group[kind].members.length);
      }
    }
  }
  const price = result.all.transactions.metrics.recorded_total_price;
  assert.equal(price.median, 330000.1234); assert.equal(price.display.median, '330,000.12'); assert.equal(price.currency, null);
  assert.equal(result.all.stock.metrics.year_built.display.median, '2000');
  assert.equal(result.all.source_reported.metrics.days_on_market.display.median, '0');
  assert.equal(result.all.source_reported.metrics.lot_size_area.unit, null);
});

test('summary never carries raw source data, member/account arrays, private keys or authorization extensions', () => {
  const source = structuredClone(built({ sales: [sale(1, 'A', { source_name: 'PRIVATE_PROVIDER_KEY', source_housing_type: 'PRIVATE_REMARKS' })] }));
  source.authorization = { token: 'SECRET_AUTH_TOKEN' }; source.selection_grant = 'SECRET_AUTH_GRANT';
  source.source_snapshots[0].provider = 'PRIVATE_PROVIDER_NAME';
  const result = summary(source), json = JSON.stringify(result);
  for (const forbidden of ['PRIVATE_', 'SECRET_', '"members":', '"account_ids":', '"raw_values":', '"source_references":',
    '"source_snapshots":', '"source_record_id":', '"canonical_transaction_id":', '"source_names":', '"target":', '"authorization":']) {
    assert.ok(!json.includes(forbidden), forbidden);
  }
});

test('zero is zero; absent/conflicting/invalid data remains unavailable with the original missing denominator', () => {
  const result = summary(built({ accounts: ['A', 'B', 'C'], parcels: [parcel(1, 'A', { current_market_value: '0', residential_area_sqft: null }),
    parcel(2, 'B', { residential_area_sqft: '0' })], sales: [sale(1, 'A', { sale_price: null })] }));
  assert.equal(result.all.stock.metrics.assessed_value.low, 0); assert.equal(result.all.stock.metrics.assessed_value.display.low, '0');
  const gla = result.all.stock.metrics.gla_sqft;
  assert.equal(gla.member_count, 3); assert.equal(gla.count, 0); assert.equal(gla.missing_count, 3);
  assert.equal(gla.invalid_count, 1); assert.equal(gla.absent_count, 2); assert.equal(gla.coverage_percent, 0);
  assert.equal(gla.display.coverage_percent, '0%'); assert.equal(gla.median, null); assert.equal(gla.display.median, 'Unavailable');
  assert.equal(result.all.transactions.metrics.recorded_total_price.display.median, 'Unavailable');
});

test('selection fingerprint has the exact shared browser preimage and stable code-unit ordering', () => {
  const source = built({ pockets: [{ id: 'z', label: 'Z', account_ids: ['B', 'A'] }, { id: 'a', label: 'é', account_ids: ['A'] }] });
  const preimage = JSON.stringify({ pockets: [
    { account_ids: ['A'], id: 'a', label: 'é' }, { account_ids: ['A', 'B'], id: 'z', label: 'Z' }], revision: 1 });
  const digest = createHash('sha256').update(preimage, 'utf8').digest('hex');
  assert.equal(summary(source).binding.selection_sha256, digest);
  const shuffled = structuredClone(source); shuffled.pockets.reverse(); shuffled.pockets[0].account_ids.reverse();
  assert.deepEqual(summary(shuffled), summary(source));
});

test('overlap counts and selected-union summaries do not imply disjoint pocket membership', () => {
  const result = summary(built({ pockets: [{ id: 'one', label: 'One', account_ids: ['A'] }, { id: 'two', label: 'Two', account_ids: ['A', 'B'] }] }));
  assert.equal(result.selected.stock.member_count, 2);
  assert.deepEqual(result.pockets.map(p => p.overlap_account_count), [1, 1]);
  assert.equal(result.pockets[0].disposition, 'needs_review');
});

test('summary and inspection are pure frozen projections of the same original preview', () => {
  const source = built(), original = JSON.stringify(source), result = summary(source), members = page(source);
  assert.equal(JSON.stringify(source), original); assert.ok(Object.isFrozen(result.all.stock.metrics));
  assert.ok(Object.isFrozen(members.members[0].observations));
  assert.deepEqual(result.binding, members.binding);
});

for (const [name, change, pattern] of [
  ['foreign context', e => { e.context_ref.context_sha256 = 'f'.repeat(64); }, /context_mismatch/],
  ['stale selection', e => { e.selection_revision++; }, /selection_mismatch/],
  ['unknown context', e => { e.context_ref.context_id = 'unknown'; }, /invalid_identity/],
]) test(`both entrypoints reject ${name} before returning a page or summary`, () => {
  const source = built(), guard = structuredClone(expected(source)); change(guard);
  assert.throws(() => present({ preview: source, expected: guard }), pattern);
  assert.throws(() => inspect({ preview: source, expected: guard, population: { group: 'all', kind: 'stock' },
    page: { limit: 1, after_member_id: null } }), pattern);
});

test('all 1001 canonical transactions can be inspected exactly once without exposing their original IDs', () => {
  const source = built({ sales: Array.from({ length: 1001 }, (_, i) => sale(i + 1)) });
  const population = { group: 'all', kind: 'transactions' }, seen = new Set(); let after = null, pages = 0, identity;
  do {
    const result = page(source, population, after, 50); pages++;
    assert.equal(result.total_count, 1001); assert.equal(result.returned_count, result.members.length);
    assert.equal(result.is_full_population, false); assert.equal(result.start_index, seen.size);
    if (identity) assert.equal(result.population_id, identity); identity = result.population_id;
    for (const member of result.members) {
      assert.match(member.member_id, /^member:[a-f0-9]{64}$/); assert.ok(!seen.has(member.member_id)); seen.add(member.member_id);
      assert.equal(Object.hasOwn(member, 'canonical_transaction_id'), false);
      assert.equal(member.amount_semantics, 'stored_canonical_total_not_verified_property_price_or_consideration');
    }
    assert.equal(result.end_index_exclusive, seen.size);
    assert.equal(result.has_more, seen.size < 1001); after = result.next_after_member_id;
  } while (after);
  assert.equal(seen.size, 1001); assert.equal(pages, 21);
});

test('stock page order is deterministic and only its bounded public account IDs are returned', () => {
  const source = built(), first = page(source, undefined, null, 1), second = page(source, undefined, first.next_after_member_id, 1);
  assert.deepEqual(first.members.map(m => m.account_id), ['A']); assert.deepEqual(second.members.map(m => m.account_id), ['B']);
  assert.equal(first.is_full_population, false); assert.equal(second.is_full_population, false); assert.equal(second.has_more, false);
  const end = page(source, undefined, second.members[0].member_id, 1);
  assert.equal(end.returned_count, 0); assert.equal(end.has_more, false); assert.equal(end.is_full_population, false);
  assert.equal(end.start_index, 2);
});

test('unknown, wrong-population, wrong-kind and stale cursors fail instead of silently restarting', () => {
  const source = built(), cursor = page(source, { group: 'all', kind: 'stock' }, null, 1).members[0].member_id;
  assert.throws(() => page(source, { group: 'selected', kind: 'stock' }, cursor, 1), /cursor_mismatch/);
  assert.throws(() => page(source, { group: 'all', kind: 'transactions' }, cursor, 1), /cursor_mismatch/);
  assert.throws(() => page(source, undefined, `member:${'0'.repeat(64)}`, 1), /cursor_mismatch/);
  assert.throws(() => page(source, undefined, 'A', 1), /invalid_cursor/);
  const changed = fixture(); changed.selection.revision = 2;
  assert.throws(() => page(preview(changed), undefined, cursor, 1), /cursor_mismatch/);
  const relabeled = fixture(); relabeled.selection.pockets[0].label = 'A different selection at an improperly reused revision';
  assert.throws(() => page(preview(relabeled), undefined, cursor, 1), /cursor_mismatch/);
});

test('membership change under a reused population/context/selection also invalidates its cursor', () => {
  const source = built(), cursor = page(source, undefined, null, 1).members[0].member_id;
  const changed = structuredClone(source); changed.all.stock.members.pop(); changed.all.stock.member_count--;
  assert.throws(() => page(changed, undefined, cursor, 1), /cursor_mismatch/);
});

test('source inspection omits provider/private IDs, source names and raw projections', () => {
  const privateId = '9223372036854775000', source = built({ sales: [sale(privateId, 'A', {
    source_name: 'PRIVATE_SOURCE_NAME', source_living_area: 'PRIVATE_RAW_VALUE', source_housing_type: 'PRIVATE_HOUSING_LABEL' })] });
  const result = page(source, { group: 'all', kind: 'source_reported' }), json = JSON.stringify(result);
  for (const forbidden of [privateId, 'PRIVATE_', '"source_record_id":', '"canonical_transaction_ids":', '"source_names":', '"raw_values":',
    '"source_references":', '"associated_account_ids":']) assert.ok(!json.includes(forbidden), forbidden);
  assert.equal(result.members[0].canonical_transaction_count, 1);
  assert.equal(result.members[0].observations.living_area.state, 'invalid');
  assert.equal(result.members[0].observations.living_area.display_value, 'Unavailable');
});

test('opaque source-page IDs do not encode enumerable original private IDs', () => {
  // Deliberately reuse a synthetic context: the safe projections are identical
  // despite different private source/canonical IDs. Real retained contexts bind
  // their original graph separately; this proves IDs are not hashed into pages.
  const first = page(built({ sales: [sale(1)] }), { group: 'all', kind: 'source_reported' });
  const second = page(built({ sales: [sale('9223372036854775000')] }), { group: 'all', kind: 'source_reported' });
  assert.deepEqual(first, second);
});

test('visible observation changes invalidate a cursor even when IDs/count/context/revision are unchanged', () => {
  const first = built({ sales: [sale(1), sale(2)] });
  const cursor = page(first, { group: 'all', kind: 'transactions' }, null, 1).next_after_member_id;
  const second = built({ sales: [sale(1, 'A', { sale_price: '450000' }), sale(2)] });
  assert.throws(() => page(second, { group: 'all', kind: 'transactions' }, cursor, 1), /cursor_mismatch/);
});

test('omitted-date inspection is a separately bound population, not part of the sales denominator', () => {
  const source = built({ sales: [sale(1), sale(2, 'A', { sale_closing_date: null }), sale(3, 'A', { sale_closing_date: '2024-07-01' })] });
  const output = summary(source);
  assert.equal(output.all.transactions.member_count, 1); assert.equal(output.all.transactions.omitted_count, 2);
  const first = page(source, { group: 'all', kind: 'omitted_transactions' }, null, 1);
  assert.equal(first.total_count, 2); assert.equal(first.members[0].disposition, 'missing_date');
  assert.throws(() => page(source, { group: 'all', kind: 'transactions' }, first.next_after_member_id, 1), /cursor_mismatch/);
});

test('empty population page explicitly reports zero total and no more pages', () => {
  const source = built({ pockets: [] }), result = page(source, { group: 'selected', kind: 'stock' });
  assert.equal(result.total_count, 0); assert.equal(result.returned_count, 0); assert.equal(result.has_more, false);
  assert.equal(result.next_after_member_id, null); assert.equal(result.is_full_population, true);
  assert.equal(summary(source).selected.stock.metrics.gla_sqft.display.coverage_percent, 'Unavailable');
});

test('unknown pockets/kinds, duplicate members and unsafe page limits are rejected', () => {
  const source = built();
  assert.throws(() => page(source, { group: 'pocket', pocket_id: 'foreign', kind: 'stock' }), /population_not_found/);
  assert.throws(() => page(source, { group: 'all', kind: 'private_raw' }), /unsupported_value/);
  for (const limit of [0, -1, 51, '1', 1.5, Infinity]) assert.throws(() => page(source, undefined, null, limit), /page_limit/);
  const duplicate = structuredClone(source); duplicate.all.stock.members.push(duplicate.all.stock.members[0]); duplicate.all.stock.member_count++;
  assert.throws(() => page(duplicate), /duplicate_member/);
});

test('markup stays plain text; overlong/control text fails the whole presentation', () => {
  const source = built({ pockets: [{ id: 'a', label: '<script>alert(1)</script>', account_ids: ['A'] }] });
  assert.equal(summary(source).pockets[0].label, '<script>alert(1)</script>');
  for (const label of ['x'.repeat(LIMITS.text_utf8_bytes + 1), 'bad\nlabel', '😀'.repeat(300)]) {
    const changed = structuredClone(source); changed.pockets[0].label = label;
    assert.throws(() => summary(changed), /text_limit/);
  }
});

test('unknown metrics and inconsistent/NaN counters cannot appear as zero or be silently omitted', () => {
  const source = built();
  for (const [change, error] of [
    [p => { p.all.stock.metrics.secret_metric = {}; }, /unsupported_metrics/],
    [p => { p.all.stock.metrics.gla_sqft.missing_count = 99; }, /denominator_mismatch/],
    [p => { p.all.stock.metrics.gla_sqft.median = NaN; }, /invalid_number/],
    [p => { p.all.stock.metrics.assessed_value.currency = 'USD'; }, /unsupported_semantics/],
    [p => { p.all.stock.metrics.gla_sqft.state = 'reliable'; }, /unsupported_value/],
  ]) { const changed = structuredClone(source); change(changed); assert.throws(() => summary(changed), error); }
});

test('128 ordinary pocket summaries stay bounded and omit every full member list', () => {
  const source = built({ pockets: Array.from({ length: 128 }, (_, i) => ({ id: `p-${i}`, label: `Pocket ${i}`, account_ids: ['A'] })) });
  const result = summary(source);
  assert.equal(result.pockets.length, 128); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= LIMITS.summary_utf8_bytes);
  assert.ok(!JSON.stringify(result).includes('"members":'));
});

test('summary and page output budgets reject whole oversized results without truncation', () => {
  const source = structuredClone(built({ pockets: Array.from({ length: 128 }, (_, i) => ({ id: `p-${i}`, label: `Pocket ${i}`, account_ids: ['A'] })) }));
  for (const group of groups(source)) for (const kind of ['stock', 'transactions', 'source_reported']) {
    for (const metric of Object.values(group[kind].metrics)) metric.label = 'x'.repeat(LIMITS.text_utf8_bytes);
  }
  assert.throws(() => summary(source), /output_bytes_limit/);
  const many = structuredClone(built({ sales: Array.from({ length: 50 }, (_, i) => sale(i + 1)) }));
  for (const metric of Object.values(many.all.source_reported.metrics)) metric.label = 'x'.repeat(LIMITS.text_utf8_bytes);
  assert.throws(() => page(many, { group: 'all', kind: 'source_reported' }), /output_bytes_limit/);
});
