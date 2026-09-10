import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { checkReportedObservationAssessment, formatReportedObservationDecimal } from '../src/features/neighborhood/customReportedObservationPresentation.ts';
import { matchCustomNeighborhoodAcceptedResponse, customNeighborhoodLegacyAllowed } from '../src/features/neighborhood/customNeighborhoodAcceptedState.ts';
import { reportedObservationReportFixture } from '../../server/test/fixtures/reportedObservationReportFixture.js';
import { neighborhoodAssessmentFixture } from '../../server/test/fixtures/neighborhoodAssessmentFixture.js';
import { buildNeighborhoodAssessment } from '../../server/src/services/neighborhoodAssessment/contract.js';

const runtime = createRequire(new URL('../package.json', import.meta.url)), ts = runtime('typescript'), React = runtime('react');
const { renderToStaticMarkup } = runtime('react-dom/server');
const loaded = new Map();
function load(url) {
  const path = fileURLToPath(url); if (loaded.has(path)) return loaded.get(path);
  const module = { exports: {} };
  const output = ts.transpileModule(readFileSync(url, 'utf8'), { fileName: path,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } });
  new Script(`(function(require,module,exports){${output.outputText}\n})`, { filename: path }).runInThisContext()(name => {
    if (name.startsWith('.')) return load(new URL(/\.[jt]sx?$/.test(name) ? name : `${name}.tsx`, url));
    assert.ok(['react', 'react/jsx-runtime'].includes(name)); return runtime(name);
  }, module, module.exports);
  loaded.set(path, module.exports); return module.exports;
}
const Summary = load(new URL('../src/features/neighborhood/components/CustomNeighborhoodAcceptedSummary.tsx', import.meta.url)).default;
const render = value => renderToStaticMarkup(React.createElement(Summary, { assessment: value }));
const fixture = reportedObservationReportFixture;

test('actual v2 five-part acceptance reopens exact current scope and renders distinct units', () => {
  const f = fixture(), before = structuredClone(f), state = matchCustomNeighborhoodAcceptedResponse(f.match);
  assert.equal(state.status, 'accepted'); assert.equal(customNeighborhoodLegacyAllowed(state, f.match.accountId, f.match.assignmentFileId), false);
  const checked = checkReportedObservationAssessment(state.assessment), html = render(checked);
  assert.ok(Object.isFrozen(checked) && Object.isFrozen(checked.statistics));
  assert.match(html, /2 accounts/); assert.match(html, /1 source records/);
  assert.match(html, /Unique account count/); assert.match(html, /Account link count/);
  assert.doesNotMatch(html, /Unique property count|Canonical transactions -|verified sale|Predominant sale price/);
  assert.match(html, /Reported ClosePrice/); assert.match(html, /\$282,500\.01 USD/);
  assert.match(html, /Reported days on market[\s\S]*>0 days<\/td>/);
  assert.match(html, /not verified market facts/); assert.match(html, /historical housing stock/);
  assert.match(html, /full parcel containment/); assert.match(html, /not a legal subdivision/);
  assert.deepEqual(f, before);
});

for (const [value, output] of [
  ['0', '0'], ['1234567.891', '1,234,567.89'], ['1234567.895', '1,234,567.9'],
  ['9007199254740993.0199999999999', '9,007,199,254,740,993.02'],
  ['9999999999999999999999999999999', '9,999,999,999,999,999,999,999,999,999,999'],
  ['0.0049999999999', '0'], ['0.005', '0.01'], ['1999.5', '1,999.5'],
]) test(`exact decimal display ${value}`, () => assert.equal(formatReportedObservationDecimal(value), output));
for (const value of [1, '1e3', '-1', '1.0', '00', '0.12345678901234', '1'.repeat(32), null, 'NaN']) {
  test(`invalid decimal is unavailable: ${value}`, () => assert.throws(() => formatReportedObservationDecimal(value)));
}

test('all statistics, exact money titles, year fractions, unsupported optional and all unavailable counts remain visible', () => {
  const f = fixture(raw => {
    const price = raw.statistics.find(s => s.id === 'reported-price-median'); price.value = '9007199254740993.0199999999999';
    for (let i = 0; i < 35; i++) raw.statistics.push({ ...structuredClone(price), id: `reported-extra-${i}` });
    raw.statistics.push({ ...structuredClone(price), id: 'current-price', measurement: 'reported_current_price', value: '275000' });
    raw.statistics.push({ ...structuredClone(price), id: 'year', measurement: 'reported_year_built', unit: 'year', value: '1999.5' });
    raw.statistics.push({ ...structuredClone(price), id: 'unknown-area', measurement: 'reported_living_area', unit: null,
      value: null, status: 'unsupported', estimator: 'unsupported', observed_count: 0, unsupported_count: 1, reason: 'unit_not_reviewed' });
  });
  const html = render(f.assessment);
  for (const s of f.assessment.statistics) assert.ok(html.includes(`ID: ${s.id}`));
  assert.match(html, /title="Exact retained value: 9007199254740993\.0199999999999"/);
  assert.match(html, /\$9,007,199,254,740,993\.02 USD/); assert.match(html, /1999\.5 year/);
  assert.match(html, /Reported CurrentPrice \(not ClosePrice\)/); assert.match(html, /Unavailable - unit_not_reviewed/);
  for (const count of ['missing', 'invalid', 'conflicting', 'unsupported', 'denominator']) assert.ok(html.includes(`${count}: `));
});

test('later CSV capture retains exact nanosecond observation without claiming historical availability', () => {
  const f = fixture(raw => {
    const captured = '2026-09-11T00:00:00.000000001Z'; raw.generated_at = '2026-09-11T00:00:00.000000002Z';
    raw.source_snapshots.push({ ...structuredClone(raw.source_snapshots[0]), id: 'later-upload', observed_at: captured });
    const population = raw.populations[1]; population.captured_at = captured; population.capture_source_ref = 'later-upload';
    population.source_refs = ['later-upload', 'members-records'];
    for (const stat of raw.statistics.filter(s => s.population_id === population.id)) stat.source_refs = [...population.source_refs];
  });
  assert.equal(matchCustomNeighborhoodAcceptedResponse(f.match).status, 'accepted');
  const html = render(f.assessment); assert.match(html, /2026-09-11T00:00:00\.000000001Z/);
  assert.match(html, /Historical availability: unknown/); assert.match(html, /2026-01-01 through 2026-09-10; reported closing date/);
});

test('zero retained source records stay zero while optional price remains explicitly unavailable', () => {
  const f = fixture(raw => {
    Object.assign(raw.populations[1], { member_count: 0, unique_account_count: 0, account_link_count: 0 });
    for (const s of raw.statistics.filter(s => s.population_id === 'records')) {
      Object.assign(s, { observed_count: 0, denominator_count: 0 });
      if (s.estimator === 'count') s.value = 0;
      else Object.assign(s, { value: null, status: 'incomplete', reason: 'no_observations' });
    }
  });
  const html = render(f.assessment); assert.match(html, /0 source records/); assert.match(html, /Unavailable - no_observations/);
  assert.equal(matchCustomNeighborhoodAcceptedResponse(f.match).status, 'accepted');
});

test('retained shared-source account associations retain a complete large set without labeling it appraiser-reviewed identity', () => {
  const f = fixture(raw => Object.assign(raw.populations[1], { membership_basis: 'retained_source_account_associations', unique_account_count: 1000, account_link_count: 1000,
    definition: 'Synthetic one source record with 1000 retained account associations; no economic identity claim' }));
  assert.equal(matchCustomNeighborhoodAcceptedResponse(f.match).status, 'accepted');
  const html = render(f.assessment); assert.match(html, /1,000/); assert.match(html, /1 source records/);
  const bad = structuredClone(f.assessment); bad.populations[1].account_link_count = 1001; assert.throws(() => checkReportedObservationAssessment(bad));
});

test('display admission bounds bytes/depth/nodes and rejects accessors without evaluating them', () => {
  const base = fixture().assessment;
  for (const change of [x => { x.diagnostics.limitations = ['x'.repeat(1500001)]; }, x => { x.extra = new Array(100001).fill(null); },
    x => { x.extra = x; }, x => { x.diagnostics.limitations = ['\ud800']; }, x => { x.statistics = new Array(3); }]) {
    const raw = structuredClone(base); change(raw); assert.throws(() => checkReportedObservationAssessment(raw));
  }
  const raw = structuredClone(base); let invoked = false;
  Object.defineProperty(raw, 'statistics', { enumerable: true, get() { invoked = true; throw new Error('must not invoke'); } });
  assert.throws(() => checkReportedObservationAssessment(raw)); assert.equal(invoked, false);
});

for (const [name, mutate] of [
  ['v1 relabel', x => { x.contract_version = 1; }],
  ['wrong profile', x => { x.methodology.configuration.profile_id = 'other'; }],
  ['legacy property count', x => { x.populations[0].unique_property_count = 2; }],
  ['transaction unit', x => { x.populations[1].member_unit = 'canonical_transaction'; }],
  ['missing population count', x => { delete x.populations[0].account_link_count; }],
  ['contradictory account links', x => { x.populations[0].account_link_count++; }],
  ['incomplete as ready', x => { x.populations[1].completeness = 'incomplete'; x.populations[1].reasons = ['missing']; }],
  ['number money', x => { x.statistics[2].value = 282500.01; }],
  ['v1 measurement', x => { x.statistics[2].measurement = 'recorded_sale_price'; }],
  ['foreign population', x => { x.statistics[2].population_id = 'foreign'; }],
  ['unknown source', x => { x.statistics[2].source_refs = ['foreign']; }],
  ['missing exact capture ref', x => { x.statistics[2].source_refs = ['members-records']; }],
  ['denominator conflict', x => { x.statistics[2].missing_count = 1; }],
  ['unknown estimator', x => { x.statistics[2].estimator = 'modal_interval'; }],
  ['null ready price', x => { x.statistics[2].value = null; }],
  ['unit promotion', x => { x.statistics[2].unit = 'USD/ft2'; }],
  ['unknown status', x => { x.statistics[2].status = 'unknown'; x.statistics[2].value = null; x.statistics[2].reason = 'missing'; }],
  ['period conflict', x => { x.statistics[2].observation_period = { ...x.statistics[2].observation_period, end_date: '2026-09-09' }; }],
  ['historical source claim', x => { x.source_snapshots[0].historical_availability = 'contemporaneous'; }],
  ['nanosecond future source', x => { x.source_snapshots[0].observed_at = '2026-09-10T13:00:00.000000001Z'; }],
  ['future CAD capture day', x => { x.populations[0].captured_at = '2026-09-11T00:00:00Z'; }],
  ['wrong account source scope', x => { x.source_snapshots[0].scope.account_id = 'other'; }],
  ['partial geometry relation', x => { x.geographic_neighborhood.validation.covers_recorded_subject_point = null; }],
  ['forged source authority', x => { x.diagnostics.authority = 'verified'; }],
  ['excess members', x => { x.populations[0].member_count = 100001; }],
  ['extra field', x => { x.secret = 'not displayed'; }],
]) test(`v2 malformed display rejected: ${name}`, () => {
  const f = fixture(), assessment = structuredClone(f.assessment); mutate(assessment);
  assert.throws(() => checkReportedObservationAssessment(assessment));
  if (assessment.contract_version === 2) assert.match(render(assessment), /summary unavailable/);
});

for (const [name, mutate] of [
  ['wrong mapper', x => { x.response.neighborhood.report_projection.mapper_version = 'custom-neighborhood-report-v1'; }],
  ['extra evidence field', x => { x.section.value.mapped_values['custom-neighborhood-report:evidence'].value.secret = 'no extra evidence'; x.response.neighborhood.acceptance.snapshot.section_value = structuredClone(x.section.value); }],
  ['missing part', x => { delete x.section.value.mapped_values['custom-neighborhood-report:statistics']; }],
  ['changed mapped statistic', x => { x.section.value.mapped_values['custom-neighborhood-report:statistics'].value[2].value = '1'; }],
  ['changed projection statistic', x => { x.response.neighborhood.report_projection.assessment = structuredClone(x.response.neighborhood.report_projection.assessment); x.response.neighborhood.report_projection.assessment.statistics[2].value = '1'; }],
  ['foreign evidence target', x => { x.section.value.mapped_values['custom-neighborhood-report:evidence'].value.target.report_file_id = '00000000-0000-4000-8000-000000000001'; }],
  ['stale revision', x => { x.section.revision++; }],
  ['foreign scope', x => { x.response.neighborhood.acceptance.organizationId = 'other'; }],
  ['unknown version', x => { x.response.neighborhood.report_projection.assessment = { ...x.response.neighborhood.report_projection.assessment, contract_version: 3 }; }],
]) test(`exact v2 accepted group refuses ${name} without legacy fallback`, () => {
  const input = structuredClone(fixture().match); mutate(input);
  const state = matchCustomNeighborhoodAcceptedResponse(input); assert.equal(state.status, 'unavailable');
  assert.equal(customNeighborhoodLegacyAllowed(state, input.accountId, input.assignmentFileId), false);
});

test('v1 rendering golden remains unchanged by explicit v2 dispatch', () => {
  const html = render(buildNeighborhoodAssessment(neighborhoodAssessmentFixture()));
  assert.match(html, /Recorded sale price/); assert.doesNotMatch(html, /Accepted reported neighborhood observations/);
  assert.equal(createHash('sha256').update(html).digest('hex'), 'f78b21b3f2010a3fa1cd108feda1fe62618550c293b89f6bb97215c0659efefb');
});
