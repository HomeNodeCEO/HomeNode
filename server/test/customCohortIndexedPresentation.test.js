import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildCustomCohortObservationPreview as legacyPreview,
  buildCustomCohortIndexedObservationPreview as indexedPreview } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { presentCustomCohortPreview as present, inspectCustomCohortPreviewMembers as inspect } from '../src/services/neighborhoodAssessment/customCohortPreviewPresentation.js';
import { buildCustomCohortPocketCatalog as catalog, presentCustomCohortPocketCatalog as presentCatalog } from '../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { buildCachedSourceCaptures } from '../src/services/neighborhoodAssessment/cachedSourceCaptures.js';
import { mapCachedParcelRow, mapCachedAccountRow, mapCachedSaleRow, mapCachedSaleLinkRow } from '../src/services/neighborhoodAssessment/cachedRowMappings.js';
import { contextFixture } from './fixtures/customCohortContextFixture.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';
import { saleWitnessMeaningFixture } from './fixtures/customCohortSaleWitnessMeaningFixture.js';
import { cadEvidenceFixture } from './fixtures/customCohortCadEvidenceFixture.js';

const NOW = '2026-09-06T08:00:00.123Z';
const KIND = ['stock', 'transactions', 'omitted_transactions', 'source_reported'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const expected = preview => ({ context_ref: preview.context_ref, selection_revision: preview.selection_revision });
const parcel = (id, account = 'A', extra = {}) => ({ object_id: String(id), account_id: account,
  residential_year_built: 2000, residential_area_sqft: '1800.125', parcel_area_sqft: '6000.00',
  current_market_value: '330000.00', subdivision_name: `Recorded ${account}`, ...extra });
const sale = (id, account = 'A', extra = {}) => ({ source_record_id: String(id), sale_id: String(id),
  primary_account_id: account, sale_account_id: account, record_type: 'closed_sale', sale_closing_date: '2024-03-01',
  source_close_date: '2024-03-01', sale_price: '330000.00', source_current_price: '335000',
  source_living_area: '1800.125', source_lot_size_area: '.2', source_year_built: 2001, source_days_on_market: 0, ...extra });
const link = (id, source, account) => ({ parcel_link_id: String(id), source_record_id: String(source),
  source_position: 1, parcel_sequence: id, account_id: account, is_resolved: account !== null, match_method: 'exact' });

// Pure consumer edge cases through the actual mapping2/chunk builders. These
// synthetic source projections are NOT SQL/MVCC/original-acquisition evidence;
// the separate real-reader fixtures below cover mapping2/3/4 retained origins.
function fixture({ accounts = ['A', 'B'], parcels = [parcel(1), parcel(2, 'B')], sales = [sale(1)],
  links = [], pockets = [{ id: 'a', label: 'Selected A', account_ids: ['A'] }] } = {}) {
  const target = { ...contextFixture().target, account_id: accounts[0], assignment_file_id: '17' };
  const scope = Object.fromEntries(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id'].map(key => [key, target[key]]));
  const wrap = (rows, mapper, prefix) => rows.map(row => { const mapped = mapper(row);
    return { record_id: `${prefix}:${mapped.record_id}`, data: mapped }; });
  const roles = { selection: accounts.map(account_id => ({ record_id: `selected:${account_id}`, data: { account_id } })),
    parcels: wrap(parcels, mapCachedParcelRow, 'parcel'),
    accounts: wrap(accounts.map(account_id => ({ account_id, county: 'Dallas', subdivision: `Recorded ${account_id}` })), mapCachedAccountRow, 'account'),
    transactions: wrap(sales, mapCachedSaleRow, 'sale'), sale_links: wrap(links, mapCachedSaleLinkRow, 'link'), gis_sync: [] };
  const source_capture = buildCachedSourceCaptures({ scope, captures: Object.entries(roles).map(([role, records]) => ({
    upstream: { id: `local-cache:${role}`, key: role, state: records.length ? 'populated' : 'present_empty', complete: true,
      revision: 'fixture-v2', content_sha256: 'a'.repeat(64), captured_at: NOW, visibility: 'assignment_private', scope, row_count: records.length },
    metadata: { id: `local-cache-${role}`, provider: 'Synthetic local mirror', revision: 'fixture-v2', valid_from: null,
      valid_to: null, observed_at: NOW, historical_availability: 'unknown' },
    projection: { id: `cache-${role}`, revision: 'fixture-v2', definition: { role }, complete: true,
      input_row_count: records.length, output_record_count: records.length }, records })) });
  assert.equal(source_capture.status, 'ready');
  return { context_ref: { context_id: contextFixture().context_id, context_revision: '1', context_sha256: 'e'.repeat(64) },
    retained_inputs: { subject: { target, effective_date: '2024-06-30' },
      study: { observation_period: { start_date: '2023-07-01', end_date: '2024-06-30' } },
      spatial: { query_complete: true, account_ids: accounts, parcels: parcels.map(row => ({ object_id: row.object_id, account_id: row.account_id })) },
      acquisition: { captured_query_request: { scope, account_ids: accounts }, capture_result: { query_complete: true, captured_at: NOW, source_capture } } },
    selection: { revision: 9, pockets } };
}

const populations = preview => [{ group: 'all' }, { group: 'selected' },
  ...preview.pockets.map(p => ({ group: 'pocket', pocket_id: p.id }))].flatMap(population => KIND.map(kind => ({ ...population, kind })));
function memberPage(preview, population, cursor = null, limit = 1) {
  return inspect({ preview, expected: expected(preview), population, page: { limit, after_member_id: cursor } });
}
function allPages(preview, limit = 1) {
  const pages = [];
  for (const population of populations(preview)) {
    let cursor = null, requests = 0;
    do {
      assert.ok(++requests <= 200, 'bounded differential fixture');
      const page = memberPage(preview, population, cursor, limit); pages.push(page); cursor = page.next_after_member_id;
    } while (cursor);
  }
  return pages;
}
function publicArtifacts(args, preview, limit = 1) {
  const c = catalog({ retained_inputs: args.retained_inputs, preview });
  return { summary: present({ preview, expected: expected(preview) }),
    catalog: presentCatalog({ catalog: c, preview, expected: expected(preview) }), pages: allPages(preview, limit) };
}
function differential(args, verify = () => {}) {
  const original = JSON.stringify(args), old = legacyPreview(args), indexed = indexedPreview(args);
  assert.equal(old.preview_version, 1); assert.equal(indexed.preview_version, 2);
  assert.equal(indexed.representation, 'indexed_members_v1');
  for (const limit of [1, 2, 50]) {
    const a = publicArtifacts(args, old, limit), b = publicArtifacts(args, indexed, limit);
    assert.equal(JSON.stringify(b), JSON.stringify(a), `all public bytes and every cursor/page at limit ${limit}`);
    assert.equal(a.summary.preview_version, 1); assert.equal(b.summary.preview_version, 1);
    for (const page of b.pages) for (const key of ['source_record_id', 'canonical_transaction_id', 'source_names', 'source_references', 'raw_values'])
      assert.ok(!JSON.stringify(page).includes(`"${key}":`), `private projection ${key}`);
  }
  for (const population of populations(old)) {
    const first = memberPage(old, population, null, 50), last = first.members.at(-1);
    if (first.is_full_population && last) assert.equal(JSON.stringify(memberPage(indexed, population, last.member_id, 1)),
      JSON.stringify(memberPage(old, population, last.member_id, 1)), 'terminal cursor uses original exact member identity');
  }
  verify(old, indexed);
  assert.equal(JSON.stringify(args), original, 'neither preview mutates retained input bytes');
  return { old, indexed };
}

// Captured from frozen Y BEFORE any indexed builder/consumer changes. Full old
// preview and public summary/catalog/every one-row page are pinned, not only
// selected metrics. Actual installed readers persist/reopen original versions.
const GOLDENS = [
  [2, decisionEvidenceFixture, 'b35eb0cf73a25d826fce3a20f73fa885df1e74e46c8e8c37ce19079bfdd34f75', 'ae398daea5a04743a114f3d8a6a8945c5cd0d3ae45e09817c71e36b372d1ca8b'],
  [3, saleWitnessMeaningFixture, '723067aac13cc2be6599377eaed1c194146d118fe8ae1f780f50e3c68b29256e', '506e14e93ac4734a257578017bed0c9a0c2fc56b7c11805b660b6af48aec700f'],
  [4, cadEvidenceFixture, 'b26e233de8cbf61cef6fb7a0b469e8ada38b5e17e0ea3acb733ad23aea8aeed5', '14ba25119630a7aa1f68e7f315c6efd38b180dbdad54dda79128b6edfcb46153'],
];
for (const [version, factory, oldHash, publicHash] of GOLDENS) test(`original mapping${version}: full v1 golden and indexed public bytes/cursors stay exact`, async () => {
  const f = await factory(), ids = [...f.input.retained_inputs.spatial.account_ids];
  const args = { context_ref: f.input.expected.context_ref, retained_inputs: f.input.retained_inputs,
    selection: { revision: 9, pockets: [{ id: 'all-recorded', label: 'All retained accounts', account_ids: ids }] } };
  const { old, indexed } = differential(args);
  assert.equal(hash(old), oldHash); assert.equal(hash(publicArtifacts(args, old)), publicHash);
  assert.equal(hash(publicArtifacts(args, indexed)), publicHash);
});

for (const [version, factory] of GOLDENS) for (const mode of ['empty', 'overlap']) {
  test(`original mapping${version} ${mode} preserves complete public population identities`, async () => {
    const f = await factory(), ids = [...f.input.retained_inputs.spatial.account_ids];
    differential({ context_ref: f.input.expected.context_ref, retained_inputs: f.input.retained_inputs,
      selection: { revision: 11, pockets: mode === 'empty' ? [] : [
        { id: 'all', label: 'All retained accounts', account_ids: ids },
        { id: 'subject', label: 'Subject subset', account_ids: [ids[0]] }] } }, old => {
      assert.equal(old.selected.stock.member_count, mode === 'empty' ? 0 : ids.length);
    });
  });
}

for (const [name, pockets] of [
  ['empty', []], ['all', [{ id: 'all', label: 'All', account_ids: ['A', 'B'] }]],
  ['overlap', [{ id: 'a', label: 'A', account_ids: ['A'] }, { id: 'all', label: 'Both', account_ids: ['B', 'A'] }]],
]) test(`${name} selection: complete summary/catalog/every page parity`, () => {
  differential(fixture({ pockets, sales: [sale(1), sale(2, 'B')] }), old => {
    assert.equal(old.all.stock.member_count, 2); assert.equal(old.selected.stock.member_count, pockets.length ? 2 : 0);
    if (name === 'overlap') assert.deepEqual(old.pockets.map(p => p.overlap_account_count), [1, 1]);
  });
});

test('source-only/legacy/repeat sales, outside association and unresolved links remain distinct', () => {
  differential(fixture({ sales: [sale(1), sale(2), sale(3, 'B', { sale_id: null, sale_account_id: null,
    sale_closing_date: null, source_close_date: null, record_type: 'listing' }),
    { source_record_id: null, sale_id: '4', sale_account_id: 'B', sale_closing_date: '2024-04-01', sale_price: '150000' }],
  links: [link(1, 1, 'B'), link(2, 1, 'OUTSIDE'), link(3, 1, null)] }), old => {
    assert.equal(old.all.transactions.member_count, 3); assert.equal(old.all.source_reported.member_count, 3);
    assert.equal(old.selected.transactions.member_count, 2);
    const row = old.selected.transactions.members[0];
    assert.deepEqual(row.associated_account_ids, ['A', 'B', 'OUTSIDE']); assert.equal(row.unresolved_link_count, 1);
    assert.equal(row.recorded_total_price.value, 330000); assert.equal(row.multiple_parcel_evidence, true);
  });
});

test('missing/conflicting/outside closing dates retain the separately bound omitted population', () => {
  differential(fixture({ sales: [sale(1), sale(2, 'A', { sale_closing_date: null }),
    sale(3, 'A', { sale_closing_date: '2023-06-30' }), sale(4, 'A', { sale_closing_date: '2024-07-01' }),
    sale(5, 'A', { sale_id: '9' }), sale(6, 'A', { sale_id: '9', sale_closing_date: '2024-04-01' })] }), old => {
    assert.equal(old.all.transactions.member_count, 1);
    assert.deepEqual(old.all.transactions.omitted.map(r => r.disposition), ['missing_date', 'outside_period', 'outside_period', 'conflicting_date']);
    assert.equal(old.all.source_reported.member_count, 6);
  });
});

test('exact decimal conflicts, zero, absent, partial and invalid values do not change categories or display', () => {
  differential(fixture({ accounts: ['A', 'B', 'C', 'D', 'E'], parcels: [
    parcel(1, 'A', { current_market_value: '9007199254740992.00' }), parcel(2, 'A', { current_market_value: '9007199254740993.00' }),
    parcel(3, 'B', { residential_area_sqft: '0', current_market_value: '0' }),
    parcel(4, 'C'), parcel(5, 'C', { residential_area_sqft: null }),
    parcel(6, 'D', { residential_area_sqft: null })], sales: [sale(1, 'A', { sale_price: null }),
    sale(2, 'A', { sale_price: '0', source_days_on_market: 0 }), sale(3, 'A', { source_living_area: 'not a number' })] }), old => {
      assert.equal(old.all.stock.members[0].observations.assessed_value.state, 'conflicting');
      assert.deepEqual(old.all.stock.members[0].observations.assessed_value.raw_values, ['9007199254740992.00', '9007199254740993.00']);
      assert.equal(old.all.stock.metrics.gla_sqft.partially_observed_count, 1);
      assert.equal(old.all.transactions.metrics.recorded_total_price.low, 0);
    });
});

test('all 101 transactions are paged exactly once, never silently truncated or restarted', () => {
  const { old, indexed } = differential(fixture({ sales: Array.from({ length: 101 }, (_, i) => sale(i + 1)) }));
  const population = { group: 'all', kind: 'transactions' }, seen = new Set(); let cursor = null, requests = 0;
  do {
    const page = memberPage(indexed, population, cursor, 50); requests++;
    assert.equal(page.total_count, 101); for (const row of page.members) { assert.ok(!seen.has(row.member_id)); seen.add(row.member_id); }
    cursor = page.next_after_member_id;
  } while (cursor);
  assert.equal(seen.size, old.all.transactions.member_count); assert.equal(requests, 3);
});

test('private source/canonical IDs cannot become encoded cursor inputs in the indexed path', () => {
  // Intentional pure synthetic context reuse mirrors the existing privacy test:
  // safe visible projections are identical, not a retained context relabeling.
  const a = indexedPreview(fixture({ sales: [sale(1)] }));
  const b = indexedPreview(fixture({ sales: [sale('9223372036854775000')] }));
  assert.equal(JSON.stringify(memberPage(a, { group: 'all', kind: 'source_reported' })),
    JSON.stringify(memberPage(b, { group: 'all', kind: 'source_reported' })));
});

test('indexed pages preserve wrong-kind/selection/visible-observation cursor rejection', () => {
  const args = fixture({ sales: [sale(1), sale(2)] }), a = indexedPreview(args);
  const cursor = memberPage(a, { group: 'all', kind: 'transactions' }, null, 1).next_after_member_id;
  for (const population of [{ group: 'selected', kind: 'transactions' }, { group: 'all', kind: 'omitted_transactions' },
    { group: 'all', kind: 'stock' }]) assert.throws(() => memberPage(a, population, cursor, 1), /cursor_mismatch/);
  const changed = indexedPreview(fixture({ sales: [sale(1, 'A', { sale_price: '450000' }), sale(2)] }));
  assert.throws(() => memberPage(changed, { group: 'all', kind: 'transactions' }, cursor, 1), /cursor_mismatch/);
  assert.throws(() => present({ preview: a, expected: { ...expected(a), selection_revision: 10 } }), /selection_mismatch/);
  assert.throws(() => inspect({ preview: a, expected: { ...expected(a), context_ref: { ...a.context_ref, context_sha256: 'f'.repeat(64) } },
    population: { group: 'all', kind: 'stock' }, page: { limit: 1, after_member_id: null } }), /context_mismatch/);
});

test('member-consuming public entrypoints require an original issued indexed preview, not relabeled JSON', () => {
  const args = fixture(), indexed = indexedPreview(args);
  for (const forged of [JSON.parse(JSON.stringify(indexed)), structuredClone(indexed), { ...indexed },
    { ...legacyPreview(args), preview_version: 2, representation: 'indexed_members_v1' }]) {
    assert.throws(() => present({ preview: forged, expected: expected(indexed) }));
    assert.throws(() => memberPage(forged, { group: 'all', kind: 'stock' }));
    assert.throws(() => catalog({ retained_inputs: args.retained_inputs, preview: forged }));
  }
});
