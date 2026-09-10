import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { checkCustomCohortMemberPage as check, createCustomCohortMemberContinuation as continuation,
  CUSTOM_COHORT_MEMBER_PAGE_LIMITS as LIMITS } from '../src/features/neighborhood/customCohortMemberPage.ts';
import { buildCustomCohortObservationPreview } from '../../server/src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { inspectCustomCohortPreviewMembers, presentCustomCohortPreview } from '../../server/src/services/neighborhoodAssessment/customCohortPreviewPresentation.js';
import { buildCachedSourceCaptures } from '../../server/src/services/neighborhoodAssessment/cachedSourceCaptures.js';
import { mapCachedParcelRow, mapCachedAccountRow, mapCachedSaleRow, mapCachedSaleLinkRow } from '../../server/src/services/neighborhoodAssessment/cachedRowMappings.js';
import { contextFixture } from '../../server/test/fixtures/customCohortContextFixture.js';
import { decisionEvidenceFixture } from '../../server/test/fixtures/customCohortDecisionEvidenceFixture.js';
import { saleWitnessMeaningFixture } from '../../server/test/fixtures/customCohortSaleWitnessMeaningFixture.js';
import { cadEvidenceFixture } from '../../server/test/fixtures/customCohortCadEvidenceFixture.js';
import { prepareAssignmentSalesCsv } from '../../server/src/services/assignmentSalesCsv/prepare.js';
import { digestPreparedSalesParts } from '../../server/src/services/assignmentSalesCsv/receiptIntegrity.js';
import { validateAssignmentSalesReviewCommand } from '../../server/src/services/assignmentSalesCsv/review.js';
import { buildCustomCohortPrivateSalesObservations, presentCustomCohortPrivateSalesObservations } from '../../server/src/services/neighborhoodAssessment/customCohortPrivateSales.js';

const copy = v => structuredClone(v), hash = v => createHash('sha256').update(v).digest('hex');
const uuid = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const NOW = '2026-09-06T08:00:00.123Z', period = { start_date: '2023-07-01', end_date: '2024-06-30' };
const parcel = (n, account_id, extra = {}) => ({ object_id: String(n), account_id, residential_year_built: 2000,
  residential_area_sqft: '1800.125', parcel_area_sqft: '6000', current_market_value: '330000.00', ...extra });
const sale = (n, account, extra = {}) => ({ source_record_id: String(n), sale_id: String(n), primary_account_id: account,
  sale_account_id: account, record_type: 'closed_sale', sale_closing_date: '2024-03-01', source_close_date: '2024-03-01',
  sale_price: '330000.12345678901', source_current_price: '335000', source_living_area: '1800.125', source_days_on_market: 0,
  source_name: 'PRIVATE_SOURCE_NAME', source_housing_type: 'PRIVATE_LABEL', ...extra });

// Actual mapping/source chunks -> numeric consumer -> public formatter. This
// fixture is synthetic; native authority/MVCC is not part of browser decoding.
function fixture({ size = 4, parcels, sales, links = [], pockets } = {}) {
  const accounts = Array.from({ length: size }, (_, n) => `000${String(n).padStart(5, '0')}_é`);
  parcels ??= accounts.map((account, n) => parcel(n + 1, account));
  sales ??= accounts.map((account, n) => sale(n + 1, account));
  const target = { ...contextFixture().target, account_id: accounts[0], assignment_file_id: '9223372036854775807' };
  const scope = Object.fromEntries(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id'].map(key => [key, target[key]]));
  const wrap = (rows, mapper, prefix) => rows.map(row => { const mapped = mapper(row); return { record_id: `${prefix}:${mapped.record_id}`, data: mapped }; });
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
  const input = { accountId: target.account_id, assignmentFileId: target.assignment_file_id,
    contextRef: { context_id: contextFixture().context_id, context_revision: '1', context_sha256: 'e'.repeat(64) },
    selection: { revision: 1, pockets: pockets ?? [{ id: 'chosen', label: 'Chosen exact accounts', account_ids: accounts.slice(0, 2) }] } };
  const preview = buildCustomCohortObservationPreview({ context_ref: input.contextRef, selection: input.selection,
    retained_inputs: { subject: { target, effective_date: '2026-09-06' }, study: { observation_period: period },
      spatial: { query_complete: true, account_ids: accounts, parcels: parcels.map(row => ({ object_id: row.object_id, account_id: row.account_id })) },
      acquisition: { captured_query_request: { scope, account_ids: accounts },
        capture_result: { query_complete: true, captured_at: NOW, source_capture: capture } } } });
  return fromPreview(preview, input);
}
function fromPreview(preview, input) {
  const expected = { context_ref: input.contextRef, selection_revision: input.selection.revision }, summary = presentCustomCohortPreview({ preview, expected });
  return { input, preview, summary, hash: summary.binding.selection_sha256, response(population = { group: 'all', kind: 'stock' }, request = { limit: 50, after_member_id: null }) {
    return { status: 'members', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId }, context_ref: copy(input.contextRef),
      selection_revision: input.selection.revision, subject_freshness: 'matched',
      page: inspectCustomCohortPreviewMembers({ preview, expected, population, page: request }), apply: { status: 'blocked', reasons: ['observation_preview_only'] } };
  }, expectation(population = { group: 'all', kind: 'stock' }) {
    const p = population.group === 'pocket' ? summary.pockets.find(p => p.id === population.pocket_id).result : summary[population.group];
    return { ...population, total_count: population.kind === 'omitted_transactions' ? p.transactions.omitted_inspection.total_count : p[population.kind].inspection.total_count };
  } };
}
const all = kind => ({ group: 'all', kind });
function run(f, { population = all('stock'), request = { limit: 50, after_member_id: null }, response, previous } = {}) {
  return check(response ?? f.response(population, request), f.input, f.hash, f.expectation(population), request, previous);
}
function frozen(value) { if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozen); } }

for (const kind of ['stock', 'transactions', 'omitted_transactions', 'source_reported']) {
  for (const group of ['all', 'selected', 'pocket']) test(`actual public ${group}/${kind} projection is admitted without raw identifiers`, () => {
    const f = fixture(), population = { group, kind, ...(group === 'pocket' ? { pocket_id: 'chosen' } : {}) }, response = f.response(population);
    const before = JSON.stringify(response), result = run(f, { population, response });
    assert.deepEqual(result.page, response.page); assert.equal(result.binding.assignmentFileId, '9223372036854775807');
    assert.equal(JSON.stringify(response), before); frozen(result);
    const json = JSON.stringify(result);
    for (const key of ['source_record_id', 'canonical_transaction_id', 'parcel_object_ids', 'source_references', 'raw_values', 'PRIVATE_SOURCE_NAME', 'PRIVATE_LABEL'])
      assert.equal(json.includes(key), false, key);
  });
}
for (const [name, builder] of [['v2', decisionEvidenceFixture], ['v3', saleWitnessMeaningFixture], ['v4', cadEvidenceFixture]]) {
  test(`genuine ${name} captured, persisted and reopened graph feeds the decoder`, async () => {
    const f = await builder(), preview = f.preview;
    const input = { accountId: preview.target.account_id, assignmentFileId: preview.target.assignment_file_id,
      contextRef: preview.context_ref, selection: { revision: preview.selection_revision, pockets: preview.pockets.map(({ id, label, account_ids }) => ({ id, label, account_ids })) } };
    const actual = fromPreview(preview, input);
    for (const kind of ['stock', 'transactions', 'source_reported', 'omitted_transactions']) run(actual, { population: all(kind) });
  });
}
test('101 members traverse exact pages, compact continuations and refetched Back without omissions', () => {
  const f = fixture({ size: 101 }), first = run(f), firstToken = continuation(first);
  assert.deepEqual(Object.keys(firstToken).sort(), ['end_index_exclusive', 'next_after_member_id', 'population_id', 'total_count']);
  assert.ok(JSON.stringify(firstToken).length < 300); frozen(firstToken);
  const secondRequest = { limit: 50, after_member_id: first.page.next_after_member_id };
  const second = run(f, { request: secondRequest, previous: firstToken }), secondToken = continuation(second);
  const third = run(f, { request: { limit: 50, after_member_id: second.page.next_after_member_id }, previous: secondToken });
  assert.deepEqual([first, second, third].map(p => [p.page.start_index, p.page.end_index_exclusive, p.page.returned_count]), [[0, 50, 50], [50, 100, 50], [100, 101, 1]]);
  assert.equal(new Set([first, second, third].flatMap(p => p.page.members.map(m => m.member_id))).size, 101);
  assert.equal(third.page.has_more, false); assert.equal(third.page.next_after_member_id, null); assert.equal(third.page.is_full_population, false);
  assert.deepEqual(run(f, { request: secondRequest, previous: firstToken }), second);
  assert.throws(() => run(f, { request: secondRequest, previous: copy(firstToken) }));
  assert.throws(() => continuation(copy(first)));
});
test('page-size changes retain cursor continuity; terminal pages cannot be continued', () => {
  const f = fixture(), first = run(f, { request: { limit: 1, after_member_id: null } });
  const second = run(f, { request: { limit: 3, after_member_id: first.page.next_after_member_id }, previous: first });
  assert.equal(second.page.returned_count, 3);
  assert.throws(() => run(f, { request: { limit: 1, after_member_id: second.page.members.at(-1).member_id }, previous: second }));
});
test('opaque source IDs cannot repeat from a nonadjacent earlier page', () => {
  const f = fixture({ size: 5 }), population = all('source_reported'), first = run(f, { population, request: { limit: 2, after_member_id: null } });
  const second = run(f, { population, request: { limit: 2, after_member_id: first.page.next_after_member_id }, previous: continuation(first) });
  const request = { limit: 2, after_member_id: second.page.next_after_member_id }, response = copy(f.response(population, request));
  response.page.members[0].member_id = first.page.members[0].member_id;
  assert.throws(() => run(f, { population, request, response, previous: continuation(second) }));
});
test('explicit empty selection returns an empty complete page, not an all-population restart', () => {
  const f = fixture({ pockets: [] }), result = run(f, { population: { group: 'selected', kind: 'stock' } });
  assert.equal(result.page.total_count, 0); assert.equal(result.page.is_full_population, true); assert.equal(result.page.has_more, false);
  assert.deepEqual(result.page.members, []);
});
test('observed precision and zeros stay literal; partial, conflicting, invalid and missing stay distinct', () => {
  const accounts = ['00000000_é', '00000001_é', '00000002_é', '00000003_é'];
  const f = fixture({ parcels: [parcel(1, accounts[0], { current_market_value: '0' }), parcel(2, accounts[0], { current_market_value: null }),
    parcel(3, accounts[1]), parcel(4, accounts[1], { residential_area_sqft: '1900' }),
    parcel(5, accounts[2], { residential_area_sqft: '-1' })] });
  const stock = run(f).page.members;
  assert.equal(stock[0].observations.assessed_value.display_value, '0'); assert.equal(stock[0].observations.assessed_value.missing_record_count, 1);
  assert.equal(stock[1].observations.gla_sqft.state, 'conflicting'); assert.equal(stock[2].observations.gla_sqft.state, 'invalid');
  assert.equal(stock[3].observations.gla_sqft.state, 'missing');
  const price = run(f, { population: all('transactions') }).page.members[0].observations.recorded_total_price;
  assert.equal(price.exact_value, '330000.12345678901'); assert.equal(price.display_value, '330,000.12'); assert.equal(price.currency, null);
  assert.equal(run(f, { population: all('source_reported') }).page.members[0].observations.days_on_market.display_value, '0');
});
test('outside/missing/conflicting canonical dates stay omitted; source rows remain all-date observations', () => {
  const account = '00000000_é';
  const f = fixture({ sales: [sale(1, account, { sale_closing_date: '2020-01-01', source_close_date: '2020-01-01' }),
    sale(2, account, { sale_closing_date: null, source_close_date: null }),
    sale(3, account), sale(4, account, { sale_id: '3', sale_closing_date: '2024-03-02', source_close_date: '2024-03-02' })] });
  const omitted = run(f, { population: all('omitted_transactions') });
  assert.deepEqual(omitted.page.members.map(row => row.disposition), ['outside_period', 'missing_date', 'conflicting_date']);
  assert.equal(run(f, { population: all('transactions') }).page.total_count, 0);
  assert.equal(run(f, { population: all('source_reported') }).page.total_count, 4);
});

const mutations = {
  'wrong account': r => { r.target.account_id = 'other'; }, 'numeric file alias': r => { r.target.assignment_file_id = 17; },
  'wrong file': r => { r.target.assignment_file_id = '17'; }, 'wrong context': r => { r.page.binding.context_ref.context_sha256 = 'b'.repeat(64); },
  'outer context': r => { r.context_ref.context_id = uuid(8); }, 'selection revision': r => { r.selection_revision++; },
  'selection hash': r => { r.page.binding.selection_sha256 = 'b'.repeat(64); }, 'changed subject': r => { r.subject_freshness = 'changed'; },
  'raw source field': r => { r.page.members[0].source_record_id = 'SECRET'; }, 'unexpected geometry': r => { r.parcel_map = {}; },
  'extra target': r => { r.target.organization_id = uuid(9); }, 'extra page': r => { r.page.facts_verified = true; },
  'wrong unit': r => { r.page.member_unit = 'property'; }, 'total mismatch': r => { r.page.total_count++; },
  'clipped page': r => { r.page.members.pop(); r.page.returned_count--; r.page.end_index_exclusive--; r.page.has_more = true; r.page.is_full_population = false; r.page.next_after_member_id = r.page.members.at(-1).member_id; },
  'start skip': r => { r.page.start_index++; }, 'returned count': r => { r.page.returned_count++; },
  'full-population label': r => { r.page.is_full_population = false; }, 'phantom continuation': r => { r.page.has_more = true; },
  'unexpected cursor': r => { r.page.next_after_member_id = r.page.members[0].member_id; },
  'duplicate member': r => { r.page.members[1].member_id = r.page.members[0].member_id; },
  'duplicate account': r => { r.page.members[1].account_id = r.page.members[0].account_id; },
  'out of order': r => { r.page.members.reverse(); }, 'authority': r => { r.page.authority = 'verified'; },
  'eligible': r => { r.page.members[0].market_eligible = true; }, 'temporal support': r => { r.page.members[0].temporal_support = 'historical'; },
  'currency inference': r => { r.page.members[0].observations.assessed_value.currency = 'USD'; },
  'area inference': r => { r.page.members[0].observations.gla_sqft.unit = 'sqm'; },
  'display mismatch': r => { r.page.members[0].observations.assessed_value.display_value = '$330,000'; },
  'numeric disagreement': r => { r.page.members[0].observations.assessed_value.exact_value = '340000'; },
  'false missing': r => { r.page.members[0].observations.assessed_value.state = 'missing'; },
  'nonfinite number': r => { r.page.members[0].observations.assessed_value.value = Infinity; },
  'negative count': r => { r.page.members[0].provenance.reference_count = -1; },
  'bad period': r => { r.page.observation_period.end_date = '2024-02-30'; },
  'future period': r => { r.page.observation_period.end_date = '2027-01-01'; },
  'bad capture time': r => { r.page.captured_at = '2026-09-06T25:00:00.000Z'; },
  'control label': r => { r.page.members[0].observations.assessed_value.label = 'unsafe\nlabel'; },
  'long UTF8 label': r => { r.page.members[0].observations.assessed_value.label = 'é'.repeat(513); },
  'raw omitted metric': r => { r.page.members[0].observations.property_sale_price = {}; },
  'apply promotion': r => { r.apply.status = 'ready'; }, 'page apply promotion': r => { r.page.apply.status = 'ready'; },
};
for (const [name, mutate] of Object.entries(mutations)) test(`rejects ${name} with fixed non-data error`, () => {
  const f = fixture(), response = copy(f.response()); mutate(response);
  assert.throws(() => run(f, { response }), { name: 'TypeError', message: 'invalid_custom_cohort_member_page' });
});
test('hostile non-JSON shapes never invoke getters/toJSON or retain unknown own keys', () => {
  const f = fixture(); let invoked = 0;
  for (const modify of [r => Object.defineProperty(r.page, 'members', { enumerable: true, get() { invoked++; throw Error('SECRET'); } }),
    r => Object.defineProperty(r.page, 'toJSON', { value() { invoked++; return {}; } }),
    r => { r.page.extra = r.page; }, r => { r.page.extra = 1n; }, r => { r.page.extra = undefined; },
    r => { r.page.members.extra = 'SECRET'; }, r => { delete r.page.members[0]; }, r => { r.page[Symbol('secret')] = 'SECRET'; },
    r => Object.setPrototypeOf(r.page, { inherited: 'SECRET' })]) {
    const response = copy(f.response()); modify(response); assert.throws(() => run(f, { response }));
  }
  assert.equal(invoked, 0);
});
test('request and trusted summary expectations are closed and bounded before response admission', () => {
  const f = fixture(), response = f.response(), expectation = f.expectation(), page = { limit: 50, after_member_id: null };
  for (const bad of [{ ...expectation, total_count: 0 }, { ...expectation, total_count: 100001 }, { ...expectation, scope: 'all' },
    { group: 'all', kind: 'stock' }, { ...expectation, pocket_id: null }, { group: 'pocket', kind: 'stock', pocket_id: 'absent', total_count: 4 }])
    assert.throws(() => check(response, f.input, f.hash, bad, page));
  for (const bad of [{ ...page, limit: 0 }, { ...page, limit: 51 }, { ...page, limit: 1.5 }, { ...page, after_member_id: 'raw-id' }, { ...page, extra: true }])
    assert.throws(() => check(response, f.input, f.hash, expectation, bad));
  assert.throws(() => check(response, { ...f.input, assignmentFileId: '9223372036854775808' }, f.hash, expectation, page));
  assert.throws(() => check(response, f.input, 'not-a-hash', expectation, page));
});
test('changed population, totals, header, scope, cursor and replayed prior rows cannot continue a checked page', () => {
  const f = fixture(), request = { limit: 2, after_member_id: null }, first = run(f, { request });
  const next = { limit: 2, after_member_id: first.page.next_after_member_id }, source = f.response(all('stock'), next);
  assert.throws(() => run(f, { request: next }));
  for (const modify of [r => { r.page.population_id = `population:${'f'.repeat(64)}`; },
    r => { r.page.total_count = 5; }, r => { r.page.captured_at = '2026-09-06T09:00:00.123Z'; },
    r => { r.page.support_gaps.pop(); }, r => { r.page.effective_date = '2026-09-05'; },
    r => { r.page.population.group = 'selected'; }, r => { r.page.members[0].member_id = first.page.members[0].member_id; },
    r => { r.page.start_index = 0; r.page.end_index_exclusive = 2; r.page.has_more = true; r.page.next_after_member_id = r.page.members.at(-1).member_id; }]) {
    const response = copy(source); modify(response); assert.throws(() => run(f, { request: next, previous: first, response }));
  }
  assert.throws(() => run(f, { request, previous: first }));
  assert.throws(() => run(f, { request: { ...next, after_member_id: first.page.members[0].member_id }, previous: first, response: source }));
});
test('JSON property-order changes do not invalidate the same checked context continuation', () => {
  const f = fixture(), request = { limit: 2, after_member_id: null }, first = run(f, { request }), next = { limit: 2, after_member_id: first.page.next_after_member_id };
  const reorder = v => Array.isArray(v) ? v.map(reorder) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, child]) => [k, reorder(child)])) : v;
  run(f, { request: next, previous: first, response: reorder(f.response(all('stock'), next)) });
});
test('complete UTF8 page envelope enforces the actual256000-byte cap without silently dropping rows', () => {
  const f = fixture({ size: 50 }), response = copy(f.response(all('source_reported')));
  for (const member of response.page.members) for (const metric of Object.values(member.observations)) metric.label = 'é'.repeat(512);
  assert.ok(Buffer.byteLength(JSON.stringify(response.page)) > LIMITS.pageBytes);
  assert.throws(() => run(f, { population: all('source_reported'), response }));
  assert.equal(response.page.members.length, 50);
});

function privateSummary(f) {
  const account = f.input.accountId, { rows, ...header } = prepareAssignmentSalesCsv(Buffer.from('ListingId,CloseDate,ClosePrice,CurrentPrice,MlsStatus\nS1,2024-03-01,275000,295000,Closed'));
  const source_interpretation = validateAssignmentSalesReviewCommand({ review_version: 1, expected_revision: 0, row_decisions: [], source_interpretation: {
    source_name: 'Synthetic private CSV', provenance_note: 'PRIVATE NOTE', currency: 'USD', living_area_unit: null, site_area_unit: null,
    consideration_field: 'close_price', marketing_time_field: null, source_use_confirmed: true } }).source_interpretation;
  const supplement = { private_sales_capture_version: 1, profile_id: 'assignment-private-reviewed-sales-v1',
    target: { organization_id: uuid(2), report_file_id: uuid(3), account_id: account, assignment_file_id: f.input.assignmentFileId },
    batch: { batch_id: uuid(4), source_sha256: header.source_sha256, preparation_sha256: digestPreparedSalesParts(header, rows) },
    review: { revision: 1, head_review_id: uuid(5), source_review_id: uuid(5) }, source_interpretation, captured_at: '2026-09-06T08:00:00.123456Z',
    rows: rows.map((record_data, i) => ({ receipt_id: uuid(i + 100), source_row_number: i + 2, record_data,
      review: { review_id: uuid(5), revision: 1, decision: 'confirm_proposed_match', account_ids: [account], note: '' } })) };
  const observations = buildCustomCohortPrivateSalesObservations({ supplement, context_ref: f.input.contextRef, effective_date: f.preview.effective_date,
    observation_period: f.preview.observation_period, selection: { revision: 1, account_ids: f.input.selection.pockets.flatMap(p => p.account_ids) } });
  return presentCustomCohortPrivateSalesObservations({ observations, binding: { context_ref: f.input.contextRef, selection_revision: 1, selection_sha256: f.hash } });
}
test('optional actual private summary is separately bound; it never becomes a private member list', () => {
  const f = fixture(), response = copy(f.response()), privateSales = privateSummary(f); response.private_sales = privateSales;
  const result = run(f, { response }); assert.equal(result.private_sales.selected.metrics.reported_transaction_price.median, '275000');
  assert.equal(result.private_sales.selected.metrics.current_price.median, '295000'); assert.equal(JSON.stringify(result).includes('PRIVATE NOTE'), false);
  assert.equal(result.page.members.length, 4); frozen(result);
  response.private_sales = copy(privateSales); response.private_sales.binding.selection_sha256 = hash('wrong'); assert.throws(() => run(f, { response }));
  response.private_sales = copy(privateSales); response.private_sales.source_interpretation.raw_payload = {}; assert.throws(() => run(f, { response }));
});
test('a private summary cannot disappear or switch batches halfway through member navigation', () => {
  const f = fixture(), request = { limit: 2, after_member_id: null }, response = copy(f.response(all('stock'), request)); response.private_sales = privateSummary(f);
  const first = run(f, { request, response }), next = { limit: 2, after_member_id: first.page.next_after_member_id };
  assert.throws(() => run(f, { request: next, previous: continuation(first) }));
  const second = copy(f.response(all('stock'), next)); second.private_sales = copy(response.private_sales); run(f, { request: next, previous: first, response: second });
  second.private_sales.binding.batch.batch_id = uuid(999); assert.throws(() => run(f, { request: next, previous: first, response: second }));
});
