import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildNeighborhoodAssessment } from '../../server/src/services/neighborhoodAssessment/contract.js';
import { neighborhoodAssessmentFixture } from '../../server/test/fixtures/neighborhoodAssessmentFixture.js';

// Compile only the new component in memory; use the installed React SSR runtime.
// Core builders below normalize synthetic test evidence, not authorize it.
const requireRuntime = createRequire(new URL('../package.json', import.meta.url));
const ts = requireRuntime('typescript'), React = requireRuntime('react');
const { renderToStaticMarkup } = requireRuntime('react-dom/server');
const componentFile = fileURLToPath(new URL('../src/features/neighborhood/components/CustomNeighborhoodAcceptedSummary.tsx', import.meta.url));
const compiled = ts.transpileModule(readFileSync(componentFile, 'utf8'), {
  fileName: componentFile, reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
});
assert.deepEqual((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
const module = { exports: {} };
new Script(`(function(require,module,exports){\n${compiled.outputText}\n})`, { filename: componentFile })
  .runInThisContext()(name => {
    assert.ok(['react', 'react/jsx-runtime'].includes(name), `Unexpected component dependency: ${name}`);
    return requireRuntime(name);
  }, module, module.exports);
const Component = module.exports.default;
const render = assessment => renderToStaticMarkup(React.createElement(Component, { assessment }));
const copy = value => JSON.parse(JSON.stringify(value));
const fixture = change => {
  const raw = neighborhoodAssessmentFixture();
  change?.(raw);
  return copy(buildNeighborhoodAssessment(raw));
};
const rowFor = (html, id) => (html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) ?? []).find(row => row.includes(`ID: ${id}</span>`));
const statistic = (raw, patch) => ({ ...copy(raw.statistics[0]), ...patch });

function comprehensiveFixture() {
  return fixture(raw => {
    raw.statistics.push(
      statistic(raw, { id: 'cad-median', population_id: 'stock-a', measurement: 'assessed_market_value', value: 410000,
        observed_count: 4, denominator_count: 4, assessment_tax_year: 2024 }),
      statistic(raw, { id: 'cad-per-sf', population_id: 'stock-a', measurement: 'assessed_value_per_square_foot', unit: 'USD/ft2', value: 205,
        observed_count: 4, denominator_count: 4, assessment_tax_year: 2024 }),
      statistic(raw, { id: 'stock-age', population_id: 'stock-a', measurement: 'age_at_effective_date', unit: 'years', value: 20,
        observed_count: 4, denominator_count: 4 }),
      statistic(raw, { id: 'sale-age', measurement: 'age_at_sale', unit: 'years', value: 18 }),
      statistic(raw, { id: 'sale-cod', measurement: 'cod_percent', unit: 'percent', estimator: 'coefficient_of_dispersion', value: 12.75 }),
      statistic(raw, { id: 'sale-quantile', estimator: 'exact_quantile', estimator_parameters: { convention: 'type_7', probability: 0.25 }, value: 315000 }),
      statistic(raw, { id: 'unique-sale-properties', measurement: 'unique_property_count', unit: 'properties', estimator: 'count',
        value: 2, observed_count: 2, denominator_count: 2, denominator_basis: 'unique_properties' }),
    );
    raw.statistics[1] = statistic(raw, { id: 'predominant-sale-price', measurement: 'predominant_sale_price', estimator: 'modal_interval',
      estimator_parameters: { method: 'fixed_width_histogram', lower_bound: 300000, upper_bound: 350000, bin_width: 50000 }, value: 335000 });
    raw.populations.push({ ...copy(raw.populations[1]), id: 'allocated-a', member_unit: 'allocated_property_sale',
      definition: 'Two allocated property sales from a package transaction', member_count: 2, unique_property_count: 2, property_link_count: 2 });
    raw.statistics.push(statistic(raw, { id: 'package-price', population_id: 'allocated-a', measurement: 'allocated_sale_price',
      observed_count: 2, denominator_count: 2, value: 120000 }));
    raw.statistics.push(statistic(raw, { id: 'package-per-sf', population_id: 'allocated-a', measurement: 'sale_price_per_square_foot',
      unit: 'USD/ft2', observed_count: 2, denominator_count: 2, value: 60 }));
    raw.populations.push({ ...copy(raw.populations[1]), id: 'listings-a', kind: 'listings', member_unit: 'listing',
      definition: 'Thirty-three listings linked to thirty-one properties', member_count: 33, unique_property_count: 31, property_link_count: 33,
      observation_period: { ...raw.observation_period, date_basis: 'status_as_of' } });
    raw.statistics.push(statistic(raw, { id: 'listing-count', population_id: 'listings-a', measurement: 'listing_count', unit: 'listings',
      estimator: 'count', value: 33, observed_count: 33, denominator_count: 33 }));
  });
}

test('geographic cardinal boundaries and selected competitive pocket IDs remain distinct', () => {
  const html = render(fixture());
  assert.match(html, /aria-label="Descriptive geographic boundaries"/);
  assert.match(html, /aria-label="Selected competitive pocket IDs"/);
  for (const side of ['North', 'East', 'South', 'West']) assert.ok(html.includes(`${side} Road`));
  const geographic = html.split('aria-label="Descriptive geographic boundaries"')[1].split('</section>')[0];
  const selection = html.split('aria-label="Selected competitive pocket IDs"')[1].split('</section>')[0];
  assert.equal(geographic.includes('pocket-a'), false);
  assert.equal(selection.includes('North Road'), false);
  assert.ok(selection.includes('pocket-a'));
});

test('all supplied populations and statistics render with definitions, counts, periods and sources', () => {
  const assessment = comprehensiveFixture(), html = render(assessment);
  for (const population of assessment.populations) {
    assert.ok(html.includes(population.definition), population.id);
    assert.ok(html.includes(`Statistics for ${population.id}`), population.id);
  }
  for (const stat of assessment.statistics) {
    const row = rowFor(html, stat.id); assert.ok(row, stat.id);
    for (const [label, value] of [['Observed', stat.observed_count], ['Missing', stat.missing_count], ['Denominator', stat.denominator_count]]) {
      assert.ok(row.includes(`${label}: </dt><dd class="inline">${value}</dd>`), `${stat.id}: ${label}`);
    }
    assert.ok(row.includes('fixture-source — synthetic-replay'));
    assert.ok(row.includes(stat.observation_period.start_date));
    assert.ok(row.includes(stat.observation_period.end_date));
  }
  assert.match(html, /Member count<\/dt><dd>3 — Canonical transactions/);
  assert.match(html, /Unique property count<\/dt><dd>2<\/dd>/);
  assert.match(html, /Member count<\/dt><dd>33 — Listings/);
  assert.match(html, /Unique property count<\/dt><dd>31<\/dd>/);
  assert.match(rowFor(html, 'listing-count'), /Date basis: Status as of/);
  assert.match(rowFor(html, 'median-sale-price'), /Date basis: Closing date/);
  assert.match(rowFor(html, 'cad-median'), /Date basis: Effective date/);
  assert.match(rowFor(html, 'unique-sale-properties'), /Denominator basis: <\/dt><dd class="inline">Unique properties/);
  assert.match(rowFor(html, 'unique-sale-properties'), />2 properties<\/td>/);
  assert.ok(html.includes('Reconstructed'));
  assert.ok(html.includes(assessment.source_snapshots[0].content_sha256));
});

test('sale prices, CAD tax-year values, median, predominant, age bases and allocated prices are explicit', () => {
  const html = render(comprehensiveFixture());
  assert.match(rowFor(html, 'median-sale-price'), /Recorded sale price[\s\S]*Median[\s\S]*\$330,000 USD/);
  assert.match(rowFor(html, 'cad-median'), /CAD assessed market value \(not a sale price\) — tax year: 2024[\s\S]*\$410,000 USD/);
  assert.match(rowFor(html, 'cad-per-sf'), /CAD assessed value per square foot \(not a sale price\) — tax year: 2024[\s\S]*\$205.00 USD\/ft2/);
  assert.match(rowFor(html, 'predominant-sale-price'), /Predominant modal interval \[lower, upper\)[\s\S]*\[\$300,000, \$350,000\); supplied value \$335,000 USD/);
  assert.doesNotMatch(rowFor(html, 'predominant-sale-price'), /Median/);
  assert.match(rowFor(html, 'sale-quantile'), /Quantile \(type 7\); probability 0.25/);
  assert.match(rowFor(html, 'stock-age'), /Age at effective date[\s\S]*20 years/);
  assert.match(rowFor(html, 'sale-age'), /Age at sale[\s\S]*18 years/);
  assert.match(rowFor(html, 'package-price'), /Package-allocated property sale price \(not a recorded transaction price\)[\s\S]*\$120,000 USD/);
  assert.match(rowFor(html, 'package-per-sf'), /Package-allocated sale price per square foot[\s\S]*\$60.00 USD\/ft2/);
  assert.match(rowFor(html, 'sale-cod'), /Coefficient of dispersion \(COD\)[\s\S]*12.75 percent/);
  assert.ok(html.includes('COD describes dispersion, not reliability'));
  assert.doesNotMatch(html, /reliability score|reliability:|reliable sample/i);
});

test('known zero members and counts stay zero; unknown denominators and values are not converted to zero', () => {
  const assessment = fixture(raw => {
    raw.populations.push({ ...copy(raw.populations[0]), id: 'zero-stock', member_count: 0, unique_property_count: 0, property_link_count: 0, pocket_ids: [] });
    raw.statistics.push(statistic(raw, { id: 'zero-count', population_id: 'zero-stock', measurement: 'property_count', unit: 'properties',
      estimator: 'count', value: 0, observed_count: 0, denominator_count: 0 }));
    raw.statistics.push(statistic(raw, { id: 'zero-denominator', population_id: 'zero-stock', measurement: 'data_coverage_percent', unit: 'percent',
      estimator: 'ratio', estimator_parameters: { numerator_count: 0 }, value: null, status: 'incomplete', reason: 'denominator_unavailable', observed_count: 0, denominator_count: 0 }));
    raw.statistics.push(statistic(raw, { id: 'known-zero-coverage', population_id: 'stock-a', measurement: 'data_coverage_percent', unit: 'percent',
      estimator: 'ratio', estimator_parameters: { numerator_count: 0 }, value: 0, observed_count: 0, missing_count: 4, denominator_count: 4 }));
    raw.populations.push({ ...copy(raw.populations[0]), id: 'unknown-stock', completeness: 'unknown', reasons: ['membership_not_loaded'],
      member_count: null, unique_property_count: null, property_link_count: null, member_set_sha256: null });
  });
  const html = render(assessment);
  assert.match(rowFor(html, 'zero-count'), />0 properties<\/td>/);
  assert.match(rowFor(html, 'zero-count'), /Observed: <\/dt><dd class="inline">0<\/dd>/);
  assert.match(rowFor(html, 'zero-denominator'), /Unavailable — denominator_unavailable/);
  assert.doesNotMatch(rowFor(html, 'zero-denominator'), /0 percent/);
  assert.match(rowFor(html, 'known-zero-coverage'), />0 percent<\/td>/);
  assert.match(rowFor(html, 'known-zero-coverage'), /Ratio; numerator 0/);
  assert.match(rowFor(html, 'known-zero-coverage'), /Missing: <\/dt><dd class="inline">4<\/dd>/);
  assert.match(html, /Member count<\/dt><dd>0 — Properties/);
  assert.match(html, /Member count<\/dt><dd>Unavailable — Properties/);
  assert.match(html, /Unavailable — membership_not_loaded/);
});

test('display-only en-US formatting groups money/counts, caps percent and money decimals, and fixes per-SF at two decimals', () => {
  const assessment = fixture(raw => {
    Object.assign(raw.populations[1], { member_count: 3456, unique_property_count: 1234, property_link_count: 3456 });
    for (const stat of raw.statistics) Object.assign(stat, { observed_count: 3456, denominator_count: 3456 });
    raw.statistics[0].value = 1234567.891;
    raw.statistics.push(statistic(raw, { id: 'formatted-per-sf', measurement: 'sale_price_per_square_foot', unit: 'USD/ft2', value: 1234.56789 }));
    raw.statistics.push(statistic(raw, { id: 'formatted-percent', measurement: 'cod_percent', unit: 'percent', estimator: 'coefficient_of_dispersion', value: 12.34567 }));
  });
  const before = structuredClone(assessment), html = render(assessment);
  assert.match(rowFor(html, 'median-sale-price'), /\$1,234,567.89 USD/);
  assert.match(rowFor(html, 'formatted-per-sf'), /\$1,234.57 USD\/ft2/);
  assert.match(rowFor(html, 'formatted-percent'), /12.35 percent/);
  assert.match(html, /Member count<\/dt><dd>3,456 — Canonical transactions/);
  assert.match(html, /Unique property count<\/dt><dd>1,234<\/dd>/);
  assert.match(rowFor(html, 'median-sale-price'), /Observed: <\/dt><dd class="inline">3,456<\/dd>/);
  assert.match(rowFor(html, 'median-sale-price'), /Denominator: <\/dt><dd class="inline">3,456<\/dd>/);
  assert.deepEqual(assessment, before);
  assert.equal(assessment.statistics.find(stat => stat.id === 'formatted-per-sf').value, 1234.56789);
});

test('unsupported or incomplete metrics retain reasons but never display even a supplied partial numeric value', () => {
  const assessment = fixture(raw => {
    raw.statistics[0].status = 'incomplete'; raw.statistics[0].reason = 'missing_price_observations';
  });
  const html = render(assessment);
  assert.match(rowFor(html, 'median-sale-price'), /Unavailable — missing_price_observations/);
  assert.doesNotMatch(rowFor(html, 'median-sale-price'), /\$330,000 USD/);
  assert.match(rowFor(html, 'predominant-sale-price'), /Unavailable — no_supported_modal_estimator/);
});

test('every supplied statistic beyond thirty and every population is retained without aggregation or truncation', () => {
  const assessment = fixture(raw => {
    for (let i = 0; i < 45; i++) raw.statistics.push(statistic(raw, { id: `retained-stat-${i}`, value: 500000 + i }));
  });
  const html = render(assessment);
  for (let i = 0; i < 45; i++) assert.ok(rowFor(html, `retained-stat-${i}`));
  assert.equal((html.match(/<th scope="row"/g) ?? []).length, assessment.statistics.length);
});

test('hostile text is escaped everywhere and produces no links, images, scripts or active controls', () => {
  const assessment = fixture(), hostile = '<script>alert("x")</script><img src=x onerror=alert(1)>javascript:malicious';
  assessment.geographic_neighborhood.cardinal_summaries.north = hostile;
  assessment.selection.pocket_ids = [hostile];
  assessment.populations[0].definition = hostile;
  assessment.source_snapshots[0].provider = hostile;
  assessment.statistics[1].reason = hostile;
  const html = render(assessment);
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
  assert.doesNotMatch(html, /<script|<img|<a\b|href=|<button|<form|<input|<select|<textarea/i);
  assert.doesNotMatch(html, /<[^>]+\sonerror=/);
});

for (const value of [null, undefined, '', 'unknown', '<script>alert(1)</script>', [], 0, {}, { contract_version: 2 }]) {
  test(`unsupported top-level input ${JSON.stringify(value)} shows only a fixed unavailable explanation`, () => {
    const html = render(value);
    assert.ok(html.includes('Neighborhood summary unavailable'));
    assert.doesNotMatch(html, /<table|North Road|pocket-a|330000|<script/);
  });
}

for (const [name, patch] of [
  ['unknown measurement', { measurement: '__proto__' }], ['unknown estimator', { estimator: 'constructor' }],
  ['unknown unit', { unit: 'market reliability' }], ['numeric string', { value: '330000' }],
  ['non-finite number', { value: Infinity }], ['missing count', { observed_count: null }],
  ['unknown status', { status: 'probably_ready' }], ['unknown denominator', { denominator_basis: 'sample_guess' }],
  ['malformed object in string field', { estimator: { toString: null } }],
  ['unsupported estimator with a number', { estimator: 'unsupported' }],
  ['missing observation period', { observation_period: null }],
  ['missing referenced source', { source_refs: ['missing-source'] }],
]) test(`${name} makes that statistic unavailable without losing the other rows`, () => {
  const assessment = fixture(); Object.assign(assessment.statistics[0], patch);
  const html = render(assessment), row = rowFor(html, 'median-sale-price');
  assert.ok(row.includes('Unavailable —'));
  assert.doesNotMatch(row, /\$330,000 USD|Infinity USD/);
  assert.ok(rowFor(html, 'predominant-sale-price'));
});

test('missing CAD tax year and missing modal parameters are unavailable, never relabeled as sale price or median', () => {
  const assessment = comprehensiveFixture();
  assessment.statistics.find(stat => stat.id === 'cad-median').assessment_tax_year = null;
  assessment.statistics.find(stat => stat.id === 'predominant-sale-price').estimator_parameters = {};
  const html = render(assessment);
  assert.match(rowFor(html, 'cad-median'), /tax year: Unavailable[\s\S]*Unavailable — assessment tax year is unavailable/);
  assert.doesNotMatch(rowFor(html, 'cad-median'), /\$410,000 USD/);
  assert.match(rowFor(html, 'predominant-sale-price'), /Unavailable — predominant interval parameters are unavailable/);
  assert.doesNotMatch(rowFor(html, 'predominant-sale-price'), /\$335,000 USD|Median/);
});

test('missing geography, selection, sources, statistics and unmatched references have visible unavailable states', () => {
  const assessment = fixture();
  assessment.geographic_neighborhood = { status: 'incomplete', reasons: ['perimeter_unverified'], cardinal_summaries: { north: 'STALE NORTH' } };
  assessment.selection = null;
  assessment.source_snapshots = [];
  assessment.statistics[0].population_id = 'missing-population';
  assessment.statistics[0].observation_period = null;
  const html = render(assessment);
  assert.ok(html.includes('Unavailable — perimeter_unverified'));
  assert.equal(html.includes('STALE NORTH'), false);
  assert.ok(html.includes('Unavailable — selected pocket IDs were not supplied'));
  assert.ok(html.includes('Unavailable — no source snapshots supplied'));
  assert.ok(html.includes('unavailable source snapshot'));
  assert.ok(html.includes('Unavailable — no statistics supplied for this population'));
  assert.ok(html.includes('Statistics without a supplied population'));
  assert.match(rowFor(html, 'median-sale-price'), /Unavailable — population definition is unavailable or unsupported/);
  assert.match(rowFor(html, 'median-sale-price'), /Unavailable — observation period or date basis/);
});

test('empty supplied selection is distinct from missing selection', () => {
  const assessment = fixture(); assessment.selection.pocket_ids = [];
  assert.match(render(assessment), /No competitive pockets selected \(0 supplied IDs\)/);
});

test('SSR is read-only, immutable and uses labeled responsive tables and disclosures', () => {
  const assessment = comprehensiveFixture(), before = JSON.stringify(assessment);
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } };
  freeze(assessment);
  const html = render(assessment);
  assert.equal(JSON.stringify(assessment), before);
  for (const markup of ['<h3', '<h4', '<h5', '<table', '<caption', '<thead', '<th scope="col"', '<th scope="row"', '<details', '<summary', '<time dateTime=', 'overflow-x-auto', 'role="region"', 'tabindex="0"', 'hn-subtle-panel']) assert.ok(html.includes(markup), markup);
  assert.doesNotMatch(html, /<button|<form|<input|<select|<textarea|>Apply<|>Save</);
  assert.ok(html.includes('does not verify sources or authorize report changes'));
});
