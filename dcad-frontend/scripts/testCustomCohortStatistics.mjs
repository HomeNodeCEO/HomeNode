import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildCustomCohortObservationPreview } from '../../server/src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { presentCustomCohortPreview } from '../../server/src/services/neighborhoodAssessment/customCohortPreviewPresentation.js';
import { buildCachedSourceCaptures } from '../../server/src/services/neighborhoodAssessment/cachedSourceCaptures.js';
import { mapCachedParcelRow, mapCachedAccountRow, mapCachedSaleRow } from '../../server/src/services/neighborhoodAssessment/cachedRowMappings.js';
import { contextFixture } from '../../server/test/fixtures/customCohortContextFixture.js';

const requireRuntime = createRequire(new URL('../package.json', import.meta.url));
const ts = requireRuntime('typescript'), React = requireRuntime('react');
const { renderToStaticMarkup } = requireRuntime('react-dom/server');
const file = fileURLToPath(new URL('../src/features/neighborhood/components/CustomCohortStatistics.tsx', import.meta.url));
const code = ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const module = { exports: {} };
new Script(`(function(require,module,exports){${code}\n})`, { filename: file }).runInThisContext()(name => {
  assert.equal(name, 'react/jsx-runtime', 'the statistics component has no side-effect dependency'); return requireRuntime(name);
}, module, module.exports);
const Component = module.exports.default;
const render = (group, props = {}) => renderToStaticMarkup(React.createElement(Component, { group, freshness: 'current', ...props }));

// Real v2 source mappings, observation calculator and public formatter feed the
// renderer. Synthetic evidence tests representation, not live provider coverage.
function fixture({ empty = false, count = 80 } = {}) {
  const contextRef = { context_id: contextFixture().context_id, context_revision: '1', context_sha256: 'a'.repeat(64) };
  const target = { ...contextFixture().target, account_id: 'A', assignment_file_id: '17' };
  const scope = Object.fromEntries(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id'].map(key => [key, target[key]]));
  const parcels = ['A', 'B'].map((account_id, i) => ({ object_id: String(i + 1), account_id,
    residential_year_built: 1990 + i * 10, residential_area_sqft: i === 0 ? '1800.1234' : null,
    parcel_area_sqft: '6000.00', current_market_value: '330000.00' }));
  const sales = Array.from({ length: count }, (_, i) => ({ source_record_id: String(i + 1), sale_id: String(i + 1), primary_account_id: i % 2 ? 'B' : 'A',
    sale_account_id: i % 2 ? 'B' : 'A', record_type: 'closed_sale', sale_closing_date: '2024-03-01', source_close_date: '2024-03-01',
    sale_price: 300000 + i * 1000, source_current_price: 350000, source_days_on_market: 0 }));
  const rows = (items, mapper, role) => items.map((row, i) => ({ record_id: `${role}:${i}`, data: mapper(row) }));
  const groups = { selection: ['A', 'B'].map(account_id => ({ record_id: `selected:${account_id}`, data: { account_id } })),
    parcels: rows(parcels, mapCachedParcelRow, 'parcel'), accounts: rows(['A', 'B'].map(account_id => ({ account_id })), mapCachedAccountRow, 'account'),
    transactions: rows(sales, mapCachedSaleRow, 'sale'), sale_links: [], gis_sync: [] };
  const captured_at = '2026-09-09T12:00:00.000Z';
  const source_capture = buildCachedSourceCaptures({ scope, captures: Object.entries(groups).map(([role, records]) => ({
    upstream: { id: `test:${role}`, key: role, state: records.length ? 'populated' : 'present_empty', complete: true,
      revision: 'fixture-v2', content_sha256: 'b'.repeat(64), captured_at, visibility: 'assignment_private', scope, row_count: records.length },
    metadata: { id: `test-${role}`, provider: 'Synthetic mirror', revision: 'fixture-v2', valid_from: null, valid_to: null,
      observed_at: captured_at, historical_availability: 'unknown' },
    projection: { id: `test-${role}`, revision: 'fixture-v2', definition: { role }, complete: true, input_row_count: records.length, output_record_count: records.length }, records })) });
  const preview = buildCustomCohortObservationPreview({ context_ref: contextRef,
    retained_inputs: { subject: { target, effective_date: '2024-06-30' }, study: { observation_period: { start_date: '2024-01-01', end_date: '2024-06-30' } },
      spatial: { query_complete: true, account_ids: ['A', 'B'], parcels: parcels.map(p => ({ object_id: p.object_id, account_id: p.account_id })) },
      acquisition: { captured_query_request: { scope, account_ids: ['A', 'B'] }, capture_result: { query_complete: true, captured_at, source_capture } } },
    selection: { revision: 7, pockets: empty ? [] : [{ id: 'alpha', label: 'Alpha recorded group', account_ids: ['A'] }] } });
  const summary = presentCustomCohortPreview({ preview, expected: { context_ref: contextRef, selection_revision: 7 } });
  return { binding: { accountId: 'A', assignmentFileId: '17', contextRef, selectionRevision: 7, selectionFingerprint: summary.binding.selection_sha256 }, summary };
}
const rows = html => html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) ?? [];
const metricRows = (html, metric) => rows(html).filter(row => row.includes(`data-metric="${metric}"`));

test('actual formatter values reach both population columns with no numeric recomputation or thirty-sale cap', () => {
  const group = fixture(), before = JSON.stringify(group), html = render(group);
  assert.match(html, /All captured observations/); assert.match(html, /Selected observations/);
  assert.match(html, /80 recorded transactions/); assert.match(html, /40 recorded transactions/);
  const gla = metricRows(html, 'gla_sqft'); assert.equal(gla.length, 2);
  assert.ok(gla[0].includes(group.summary.all.stock.metrics.gla_sqft.display.median));
  assert.ok(gla[1].includes(group.summary.selected.stock.metrics.gla_sqft.display.median));
  assert.match(gla[0], /1,800\.12/); assert.doesNotMatch(gla[0], /1800\.1234/);
  assert.match(gla[0], /1 missing/); assert.match(gla[1], /0 missing/);
  assert.match(html, /data-selection-revision="7"/); assert.equal(JSON.stringify(group), before);
});
test('unknown currency, temporal applicability and descriptive COD are not turned into appraisal conclusions', () => {
  const html = render(fixture());
  assert.doesNotMatch(html, /\$|USD/); assert.match(html, /Currency not established/);
  assert.match(html, /not a property-level sale price/); assert.match(html, /Median is a descriptive midpoint, not a supported predominant value/);
  assert.match(html, /COD describes dispersion, not reliability/); assert.match(html, /historical applicability are not established/);
  assert.match(html, /This preview cannot be applied to the report/);
  assert.match(html, /2024-01-01 through 2024-06-30/);
});
test('empty selected population remains empty and null metrics display unavailable rather than zero', () => {
  const group = fixture({ empty: true }), html = render(group);
  assert.match(html, /0 accounts · 0 CAD members · 0 recorded transactions/);
  const selected = metricRows(html, 'gla_sqft')[1];
  assert.match(selected, /Unavailable/); assert.equal((selected.match(/>Unavailable<\/td>/g) ?? []).length, 4);
});
test('stale summaries retain their actual revision and explicitly still match the prior map', () => {
  const group = fixture(), html = render(group, { freshness: 'stale' });
  assert.match(html, /Previous coherent results/); assert.match(html, /These numbers still match the displayed map/);
  assert.match(html, /data-selection-revision="7"/); assert.match(html, /data-freshness="stale"/);
});
test('summary-only inspector renders selected observations without requiring geometry or a second all column', () => {
  const group = fixture(), html = render(group, { selectedOnly: true });
  assert.match(html, /Selected observations/); assert.doesNotMatch(html, /All captured observations/);
  assert.equal(metricRows(html, 'gla_sqft').length, 1); assert.match(html, /40 recorded transactions/);
});
test('selected pocket detail is exact; absent pocket stats are never borrowed from another group', () => {
  const group = fixture(), html = render(group, { pocketId: 'alpha' });
  assert.match(html, /Inspected group: Alpha recorded group/);
  assert.equal(metricRows(html, 'gla_sqft').length, 3);
  const missing = render(group, { pocketId: 'excluded-other' }); assert.match(missing, /statistics are not part of the displayed result/);
  assert.match(missing, /inclusion has not been changed/); assert.equal(metricRows(missing, 'gla_sqft').length, 2);
});
test('source-reported records stay in their own expandable population and preserve zero marketing days', () => {
  const group = fixture(), html = render(group); assert.match(html, /<details/); assert.match(html, /separate population, not additional canonical sales/);
  const marketing = metricRows(html, 'days_on_market'); assert.equal(marketing.length, 2);
  assert.ok(marketing[0].includes(`>${group.summary.all.source_reported.metrics.days_on_market.display.median}</td>`));
  assert.ok(marketing[0].includes('>0</td>'));
});
test('labels and all server display strings remain escaped React text, never HTML', () => {
  for (const [label, value] of [
    ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>'],
    ['<IMG SRC=x ONERROR=alert(1)>', '<SCRIPT>alert(1)</SCRIPT>'],
    ['<ImG src=x onerror=alert(1)>', '<ScRiPt data-x=y>alert(1)</ScRiPt>'],
  ]) {
    const group = structuredClone(fixture()); group.summary.pockets[0].label = label;
    group.summary.selected.stock.metrics.gla_sqft.display.median = value;
    const html = render(group, { pocketId: 'alpha' });
    // Assert each exact input's escaped output, not an incomplete HTML-filter
    // regexp. React owns escaping; this test never implements a sanitizer.
    for (const input of [label, value]) {
      assert.equal(html.includes(input), false);
      assert.ok(html.includes(input.replaceAll('<', '&lt;').replaceAll('>', '&gt;')));
    }
  }
});
test('null summary presents an explicit empty state without reporting fabricated values', () => {
  const html = render(null); assert.match(html, /No captured statistics are available yet/); assert.doesNotMatch(html, /<table/);
});
test('observation statistics, including their empty state, are excluded from report printing', () => {
  for (const group of [fixture(), null]) {
    const html = render(group), root = html.match(/^<(?:section|p)\b[^>]+>/)?.[0];
    assert.match(root, /class="[^"]*print:hidden/);
  }
});
