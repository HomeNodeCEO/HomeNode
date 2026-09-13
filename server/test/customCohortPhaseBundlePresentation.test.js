import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { buildCachedSourceCaptures } from '../src/services/neighborhoodAssessment/cachedSourceCaptures.js';
import { mapCadEvidenceParcelRow, mapCadEvidenceAccountRow, mapCadEvidenceSaleRow,
  mapCadEvidenceSaleLinkRow } from '../src/services/neighborhoodAssessment/cachedRowMappingsV4.js';
import { buildCustomCohortIndexedObservationPreviewBatched as preview,
  customCohortObservationMembers as members } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { presentCustomCohortPreview as present, inspectCustomCohortPreviewMembers as inspect,
  CUSTOM_COHORT_PREVIEW_PRESENTATION_LIMITS } from '../src/services/neighborhoodAssessment/customCohortPreviewPresentation.js';
import { contextFixture } from './fixtures/customCohortContextFixture.js';

const NOW = '2026-09-06T08:00:00.123Z';
const id = n => `A${String(n).padStart(6, '0')}`;
const expected = view => ({ context_ref: view.context_ref, selection_revision: view.selection_revision });

// Actual mapping4/source builders, then the same indexed preview/presentation
// functions used by owner.present. This fixture is numeric-consumer evidence,
// not a database, source authorization, retained-load, or native geometry test.
function fixture(accountCount = 360) {
  const accounts = Array.from({ length: accountCount }, (_, i) => id(i));
  const target = { ...contextFixture().target, account_id: accounts[0], assignment_file_id: '17' };
  const scope = Object.fromEntries(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id'].map(key => [key, target[key]]));
  const context_ref = { context_id: contextFixture().context_id, context_revision: '1', context_sha256: 'e'.repeat(64) };
  const phases = Array.from({ length: 6 }, (_, i) => ({ id: `recorded-phase-${i + 1}`, label: `Recorded phase ${i + 1}`,
    account_ids: accounts.slice(i * 50, (i + 1) * 50) }));
  const parcels = accounts.map((account, i) => ({ object_id: String(9007199254740993n + BigInt(i)), account_id: account,
    residential_year_built: i % 11 ? 2000 : null, residential_area_sqft: i % 13 ? '1800.125' : 'unknown',
    parcel_area_sqft: '6000.00', current_market_value: '330000.00', land_use_category: 'one_unit',
    classification_confidence: 'high', class_code: 'A11', class_description: null,
    use_description: null, structure_type: null, built_up: true }));
  parcels.push({ ...parcels[1], object_id: '9223372036854775000', residential_year_built: 1980 });
  const sale = (n, account, extra = {}) => ({ source_record_id: String(n), sale_id: String(n + 1000),
    primary_account_id: account, sale_account_id: account, record_type: 'closed_sale',
    sale_closing_date: '2024-03-01', source_close_date: '2024-03-01', sale_price: '330000.00',
    source_current_price: '335000', source_living_area: '1800.125', source_year_built: 2001, ...extra });
  const sales = phases.flatMap((p, i) => [sale(100 + i * 10, p.account_ids[0]),
    sale(101 + i * 10, p.account_ids[1], { sale_closing_date: '2022-01-01', source_living_area: null }),
    sale(102 + i * 10, p.account_ids[2], { sale_closing_date: null, source_year_built: null }),
    sale(103 + i * 10, p.account_ids[3], { sale_id: null, record_type: 'listing', sale_closing_date: null })]);
  sales.push(sale(700, accounts[0]), sale(800, accounts[4], { source_record_id: null }), sale(900, accounts[350]));
  const links = [phases[1].account_ids[0], 'OUTSIDE-LINK', null].map((account, i) => ({
    parcel_link_id: String(i + 1), source_record_id: '700', source_position: 1, parcel_sequence: i + 1,
    account_id: account, is_resolved: account !== null, match_method: account === null ? 'unmatched' : 'exact' }));
  const wrap = (rows, mapper, prefix) => rows.map(row => { const mapped = mapper(row);
    return { record_id: `${prefix}:${mapped.record_id}`, data: mapped }; });
  const roles = { selection: accounts.map(account_id => ({ record_id: `selected:${account_id}`, data: { account_id } })),
    parcels: wrap(parcels, mapCadEvidenceParcelRow, 'parcel'),
    accounts: wrap(accounts.map(account_id => ({ account_id, county: 'Dallas', subdivision: 'Recorded phase evidence' })), mapCadEvidenceAccountRow, 'account'),
    transactions: wrap(sales, mapCadEvidenceSaleRow, 'sale'), sale_links: wrap(links, mapCadEvidenceSaleLinkRow, 'link'), gis_sync: [] };
  const capture = buildCachedSourceCaptures({ scope, captures: Object.entries(roles).map(([role, records]) => ({
    upstream: { id: `local-cache:${role}`, key: role, state: records.length ? 'populated' : 'present_empty', complete: true,
      revision: 'synthetic-phase-v1', content_sha256: 'a'.repeat(64), captured_at: NOW, visibility: 'assignment_private', scope, row_count: records.length },
    metadata: { id: `phase-fixture-${role}`, provider: 'Synthetic retained phase consumer', revision: 'synthetic-phase-v1',
      valid_from: null, valid_to: null, observed_at: NOW, historical_availability: 'unknown' },
    projection: { id: `cache-${role}`, revision: 'synthetic-phase-v1', definition: { role, mapping_version: 4 }, complete: true,
      input_row_count: records.length, output_record_count: records.length }, records })) });
  assert.equal(capture.status, 'ready');
  return { phases, context_ref, retained_inputs: { subject: { target, effective_date: '2024-06-30' },
    study: { observation_period: { start_date: '2023-07-01', end_date: '2024-06-30' } },
    spatial: { query_complete: true, account_ids: accounts, parcels: parcels.map(row => ({ object_id: row.object_id, account_id: row.account_id })) },
    acquisition: { captured_query_request: { scope, account_ids: accounts },
      compact_metadata_json: JSON.stringify({ reader_version: 'local-capture-v3', mapping_version: 4, limits: { records: 200_000 } }),
      capture_result: { query_complete: true, captured_at: NOW, source_capture: capture } } } };
}

async function summarize(f, pockets, revision = 7) {
  const started = performance.now(), view = await preview({ context_ref: f.context_ref,
    retained_inputs: f.retained_inputs, selection: { revision, pockets } });
  const summary = present({ preview: view, expected: expected(view) });
  return { view, summary, elapsed_ms: performance.now() - started };
}
const parentPocket = f => ({ id: 'parent-union', label: 'Complete retained parent', account_ids: f.phases.flatMap(p => p.account_ids) });

async function assertBundleParity(f) {
  const singles = [];
  for (const phase of f.phases) singles.push(await summarize(f, [phase]));
  const bundle = await summarize(f, f.phases), parent = await summarize(f, [parentPocket(f)]);
  assert.deepEqual(bundle.summary.selected, parent.summary.selected);
  assert.deepEqual(bundle.summary.all, parent.summary.all);
  assert.equal(bundle.summary.selected.stock.member_count, 300);
  const accountIds = [];
  for (let i = 0; i < f.phases.length; i++) {
    assert.deepEqual(bundle.summary.pockets[i], singles[i].summary.pockets[0]);
    assert.equal(bundle.summary.pockets[i].overlap_account_count, 0);
    assert.equal(bundle.summary.pockets[i].result.stock.member_count, 50);
    accountIds.push(...members(bundle.view, bundle.view.pockets[i].result, 'stock').map(row => row.account_id));
    for (const kind of ['stock', 'transactions', 'omitted_transactions', 'source_reported']) {
      assert.deepEqual(members(bundle.view, bundle.view.pockets[i].result, kind),
        members(singles[i].view, singles[i].view.pockets[0].result, kind));
    }
  }
  assert.equal(new Set(accountIds).size, 300); assert.deepEqual(accountIds, parentPocket(f).account_ids);
  assert.ok(Buffer.byteLength(JSON.stringify(bundle.summary)) <= CUSTOM_COHORT_PREVIEW_PRESENTATION_LIMITS.summary_utf8_bytes);
  return { singles, bundle, parent };
}

test('one phase bundle has exact standalone full-pocket results and parent union/all, including omissions and package associations', async () => {
  const f = fixture(), before = JSON.stringify(f), { bundle } = await assertBundleParity(f);
  assert.equal(bundle.summary.all.stock.member_count, 360);
  assert.equal(bundle.summary.selected.transactions.member_count, 8);
  assert.equal(bundle.summary.all.transactions.member_count, 9);
  assert.equal(bundle.summary.selected.transactions.omitted_count, 12);
  assert.equal(bundle.summary.selected.source_reported.member_count, 25);
  assert.equal(bundle.summary.all.source_reported.member_count, 26);
  assert.equal(bundle.summary.selected.source_reported.without_canonical_transaction_count, 6);
  assert.equal(bundle.summary.selected.stock.metrics.year_built.conflicting_count, 1);
  assert.ok(bundle.summary.selected.stock.metrics.year_built.absent_count > 0);
  assert.ok(bundle.summary.selected.stock.metrics.gla_sqft.invalid_count > 0);
  assert.ok(bundle.summary.selected.source_reported.metrics.living_area.absent_count > 0);
  const packageRows = members(bundle.view, bundle.view.selected, 'transactions').filter(row => row.multiple_parcel_evidence);
  assert.equal(packageRows.length, 1); assert.equal(packageRows[0].unresolved_link_count, 1);
  assert.deepEqual(packageRows[0].associated_account_ids, [id(0), id(50), 'OUTSIDE-LINK']);
  assert.equal(packageRows[0].recorded_total_price.exact_value, '330000');
  assert.equal(JSON.stringify(f), before); assert.ok(Object.isFrozen(bundle.summary));
});

test('bundle binding includes every original phase descriptor; phase member pages require that exact selection and population', async () => {
  const f = fixture(), bundle = await summarize(f, f.phases), single = await summarize(f, [f.phases[0]]);
  const preimage = { pockets: f.phases.map(p => ({ account_ids: p.account_ids, id: p.id, label: p.label })), revision: 7 };
  assert.equal(bundle.summary.binding.selection_sha256, createHash('sha256').update(JSON.stringify(preimage)).digest('hex'));
  assert.notEqual(bundle.summary.binding.selection_sha256, single.summary.binding.selection_sha256);
  const population = { group: 'pocket', pocket_id: f.phases[0].id, kind: 'stock' };
  const page = (view, requested = population, cursor = null) => inspect({ preview: view, expected: expected(view),
    population: requested, page: { limit: 1, after_member_id: cursor } });
  const first = page(bundle.view), cursor = first.next_after_member_id;
  assert.equal(first.total_count, 50); assert.equal(first.members[0].account_id, id(0));
  assert.equal(page(bundle.view, population, cursor).members[0].account_id, id(1));
  assert.throws(() => page(single.view, population, cursor), /cursor_mismatch/);
  assert.throws(() => page(bundle.view, { group: 'selected', kind: 'stock' }, cursor), /cursor_mismatch/);
  assert.throws(() => page(bundle.view, { ...population, pocket_id: f.phases[1].id }, cursor), /cursor_mismatch/);
  assert.throws(() => present({ preview: bundle.view, expected: { ...expected(bundle.view), selection_revision: 8 } }), /selection_mismatch/);
  assert.throws(() => present({ preview: bundle.view, expected: { ...expected(bundle.view),
    context_ref: { ...f.context_ref, context_sha256: 'f'.repeat(64) } } }), /context_mismatch/);
  const renamed = await summarize(f, f.phases.map((p, i) => i ? p : { ...p, label: 'Changed phase label' }));
  assert.notEqual(renamed.summary.binding.selection_sha256, bundle.summary.binding.selection_sha256);
  assert.throws(() => page(renamed.view, population, cursor), /cursor_mismatch/);
  const empty = await summarize(f, []);
  assert.equal(empty.summary.selected.stock.member_count, 0); assert.deepEqual(empty.summary.pockets, []);
  assert.deepEqual(empty.summary.all, bundle.summary.all);
});

test('phase bundle timing (opt-in, 10,000-account pure synthetic consumer; no database or hard timing threshold)', {
  skip: process.env.HOMENODE_PHASE_BUNDLE_BENCHMARK !== '1', timeout: 60_000,
}, async t => {
  const f = fixture(10_000);
  await summarize(f, [f.phases[0]]); // Exclude one JIT warmup; do not assert a speed ratio.
  const { singles, bundle, parent } = await assertBundleParity(f);
  t.diagnostic(JSON.stringify({ fixture_accounts: 10_000, phase_count: 6, phase_accounts: 50,
    independent_pure_summary_ms: singles.map(item => item.elapsed_ms),
    six_independent_total_ms: singles.reduce((sum, item) => sum + item.elapsed_ms, 0),
    one_bundle_ms: bundle.elapsed_ms, one_parent_ms: parent.elapsed_ms,
    work: bundle.view.work, bundle_bytes: Buffer.byteLength(JSON.stringify(bundle.summary)),
    exact_full_phase_and_parent_results: true, database_or_retained_load_measured: false }));
});
