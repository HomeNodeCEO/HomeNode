import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import * as catalogHelpers from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import * as controller from '../src/features/neighborhood/customCohortPreviewController.ts';
import { checkCustomCohortPocketRecommendation as check } from '../src/features/neighborhood/customCohortPocketRecommendation.ts';
import { decisionEvidenceFixture } from '../../server/test/fixtures/customCohortDecisionEvidenceFixture.js';
import { recordedProximityFixture, proximityPolygon } from '../../server/test/fixtures/customCohortRecordedProximityFixture.js';
import { deriveCustomCohortRecordedProximity, CUSTOM_COHORT_RECORDED_PROXIMITY_REASONS } from '../../server/src/services/neighborhoodAssessment/customCohortRecordedProximity.js';
import { buildCustomCohortPocketRecommendation as build } from '../../server/src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { presentCustomCohortPocketRecommendation as present } from '../../server/src/services/neighborhoodAssessment/customCohortPocketRecommendationPresentation.js';
import { presentCustomCohortPocketCatalog } from '../../server/src/services/neighborhoodAssessment/customCohortPocketCatalog.js';

const legacy = decisionEvidenceFixture(), fixtures = new Map();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rounds = n => Math.round(n * 10000) / 10000;
function original(options = {}) {
  const key = JSON.stringify(options);
  if (!fixtures.has(key)) fixtures.set(key, recordedProximityFixture(options));
  return fixtures.get(key);
}
async function fixture({ radius, parcels, invalid = [], invalidResult = false, old = false, v1 = false } = {}) {
  const f = await (old || v1 ? legacy : original({ ...(radius ? { radius } : {}), ...(parcels ? { parcels } : {}) }));
  const context_ref = f.input.expected.context_ref, retained_inputs = f.input.retained_inputs;
  const calls = [];
  // Only the later native measurement result is synthetic. Subject, original
  // spatial/source capture, retained hashes and reopen all use the real fixture.
  // This tests contract composition, not PostgreSQL distance correctness.
  const proximity = v1 ? null : await deriveCustomCohortRecordedProximity(async (sql, values) => {
    calls.push({ sql, values }); assert.match(sql, /custom-cohort-recorded-proximity:distances/);
    const requested = JSON.parse(values[0]);
    const rows = invalidResult ? [] : requested.map(row => {
      const index = f.parcels.findIndex(parcel => parcel.object_id === row.object_id), parcel = f.parcels[index];
      assert.ok(parcel); const bad = invalid.includes(index), locations = parcel.geometry.type === 'MultiPolygon' ? parcel.geometry.coordinates.length : 1;
      return { object_id: row.object_id, valid: !bad, location_count: bad ? 0 : locations,
        minimum_metres: bad ? null : index * 1609.344,
        maximum_metres: bad ? null : (index + locations - 1) * 1609.344 };
    });
    return { rowCount: rows.length, rows };
  }, { context_ref, retained_inputs });
  const expected = { context_ref, selection_revision: 7 };
  const catalog = presentCustomCohortPocketCatalog({ catalog: f.catalog, preview: f.preview, expected });
  const kernel = build({ context_ref, retained_inputs, selection: { revision: 7, included_recorded_group_ids: [] },
    ...(proximity ? { recorded_proximity: proximity } : {}) });
  const recommendation = present({ recommendation: kernel, catalog, expected });
  const input = { accountId: f.input.expected.target.account_id, assignmentFileId: f.input.expected.target.assignment_file_id,
    contextRef: context_ref, selection: { revision: 7, pockets: [] } };
  const response = { status: 'catalog', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
    context_ref, selection_revision: 7, subject_freshness: 'matched', catalog, recommendation, apply: { status: 'blocked' } };
  return { f, calls, kernel, proximity, input, response, checked: catalogHelpers.checkCustomCohortPocketCatalog(response, input) };
}
const accept = (r, f) => check(r, f.checked, f.response.catalog.binding.selection_sha256);

test('v1 original checked DTO hash is unchanged and does not invent recorded proximity', async () => {
  const f = await fixture({ v1: true }), value = f.checked.recommendation;
  // Pinned against the pre-v2 U decoder, not regenerated from this implementation.
  assert.equal(hash(value), '6f7147fbe8d5d160f1f545f8f0cf0ba6542445b4b08a67e7e03a6fc69d95da90');
  assert.equal(value.policy.revision, 1); assert.equal(Object.hasOwn(value, 'recorded_proximity'), false);
  assert.deepEqual(Object.keys(f.response.recommendation.unavailable_factors), ['housing_type', 'proximity', 'sale_price']);
});

for (const radius of [undefined, '4828.032', '8046.72', '16093.44']) test(`original ${radius ?? 'legacy 3-mile'} capture -> real derivation/kernel/presenter -> checked v2`, async () => {
  const f = await fixture({ radius }), value = f.checked.recommendation;
  assert.equal(f.calls.length, 1); assert.equal(value.policy.id, 'custom-current-observation-review-v2'); assert.equal(value.policy.revision, 2);
  assert.equal(value.recorded_proximity.radius_metres, radius ?? '4828.032');
  assert.deepEqual(value.recorded_proximity.counts, { accounts: 2, parcels: 2, observed_accounts: 2, unknown_accounts: 0 });
  assert.deepEqual(value.recorded_proximity, f.response.recommendation.recorded_proximity);
  assert.equal(value.all.factor_coverage.proximity.observed_count, 2); assert.ok(Object.isFrozen(value.recorded_proximity.counts));
  assert.deepEqual(f.input.selection.pockets, []); assert.equal(f.response.recommendation.apply.status, 'blocked');
  assert.equal(f.response.recommendation.recommendation_version, 1); assert.equal(f.response.recommendation.presentation_version, 1);
  assert.deepEqual(Object.keys(f.response.recommendation.unavailable_factors), ['housing_type', 'sale_price']);
});

test('multiple retained parcels for one account remain one unknown account in the full denominator', async () => {
  const f = await fixture({ parcels: [{ account_id: 'subject', geometry: proximityPolygon() },
    { account_id: 'subject', geometry: proximityPolygon(-96.64) }, { account_id: 'R-001', geometry: proximityPolygon(-96.63) }] });
  const value = f.checked.recommendation;
  assert.deepEqual(value.recorded_proximity.counts, { accounts: 2, parcels: 3, observed_accounts: 1, unknown_accounts: 1 });
  assert.deepEqual(value.all.factor_coverage.proximity.states, { candidate_multiple_locations: 1, observed: 1 });
  assert.equal(value.all.member_count, 2); assert.equal(value.pockets.reduce((n, p) => n + p.member_count, 0), 2);
});

test('disconnected MultiPolygon remains multiple locations, while native-invalid geometry remains unknown', async () => {
  const f = await fixture({ parcels: [{ account_id: 'subject', geometry: { type: 'MultiPolygon',
    coordinates: [proximityPolygon().coordinates, proximityPolygon(-96.64).coordinates] } },
  { account_id: 'R-001', geometry: proximityPolygon(-96.63) }], invalid: [1] });
  assert.deepEqual(f.checked.recommendation.recorded_proximity.counts, { accounts: 2, parcels: 2, observed_accounts: 0, unknown_accounts: 2 });
  assert.deepEqual(f.checked.recommendation.all.factor_coverage.proximity.states,
    { candidate_multiple_locations: 1, candidate_invalid_geometry: 1 });
});

test('genuine old malformed EWKB is wholly unavailable with no native call or partial coverage', async () => {
  const f = await fixture({ old: true }), value = f.checked.recommendation;
  assert.equal(f.calls.length, 0); assert.equal(value.recorded_proximity.status, 'unavailable');
  assert.equal(value.recorded_proximity.reason, 'retained_map_unavailable');
  assert.deepEqual(value.recorded_proximity.counts, { accounts: 2, parcels: 2, observed_accounts: 0, unknown_accounts: 2 });
  assert.deepEqual(value.all.factor_coverage.proximity.states, { proximity_unavailable: 2 });
});

test('invalid native result fails the complete proximity observation, not the legacy factors', async () => {
  const f = await fixture({ invalidResult: true });
  assert.equal(f.checked.recommendation.recorded_proximity.reason, 'native_result_invalid');
  assert.equal(f.checked.recommendation.all.factor_coverage.proximity.unknown_count, 2);
  assert.equal(f.checked.recommendation.all.factor_coverage.gla.observed_count, 2);
});

for (const reason of CUSTOM_COHORT_RECORDED_PROXIMITY_REASONS) test(`admits only the fixed unavailable reason ${reason}`, async () => {
  const f = await fixture({ old: true }), raw = structuredClone(f.response.recommendation);
  raw.recorded_proximity.reason = reason;
  assert.equal(accept(raw, f).recorded_proximity.reason, reason);
});

test('defensive curve unavailability keeps native observed distances separate from scored coverage', async () => {
  const f = await fixture({ old: true }), raw = structuredClone(f.response.recommendation);
  raw.recorded_proximity.status = 'available'; raw.recorded_proximity.reason = null;
  raw.recorded_proximity.counts.observed_accounts = 2; raw.recorded_proximity.counts.unknown_accounts = 0;
  for (const pop of [raw.all, ...raw.pockets]) pop.factor_coverage.proximity.states = { calculation_unavailable: pop.member_count };
  const checked = accept(raw, f);
  assert.equal(checked.recorded_proximity.counts.observed_accounts, 2);
  assert.equal(checked.all.factor_coverage.proximity.observed_count, 0);
  assert.equal(checked.all.factor_coverage.proximity.unknown_count, 2);
});

for (const [label, change] of [
  ['missing v2 summary', r => { delete r.recorded_proximity; }],
  ['null summary', r => { r.recorded_proximity = null; }],
  ['unknown policy', r => { r.policy.id = 'custom-current-observation-review-v3'; }],
  ['revision mismatch', r => { r.policy.revision = 1; }],
  ['changed curve', r => { r.policy.curve_methodology_version = 7; }],
  ['changed weights', r => { r.policy.weights.proximity = .2; }],
  ['changed threshold', r => { r.policy.minimum_mean_lower_bound = 54; }],
  ['new recommendation version', r => { r.recommendation_version = 2; }],
  ['new presentation version', r => { r.presentation_version = 2; }],
  ['legacy unavailable proximity', r => { r.unavailable_factors.proximity = 'comparable_property_distance_not_retained'; }],
  ['invented housing basis', r => { r.unavailable_factors.housing_type = 'verified'; }],
  ['wrong basis', r => { r.recorded_proximity.basis = 'driving_distance'; }],
  ['claimed authority', r => { r.recorded_proximity.authority = 'verified'; }],
  ['unknown reason', r => { r.recorded_proximity.reason = 'arbitrary_server_text'; }],
  ['available reason', r => { r.recorded_proximity.reason = 'native_query_failed'; }],
  ['unavailable with observed accounts', r => { r.recorded_proximity.status = 'unavailable'; r.recorded_proximity.reason = 'subject_point_unavailable'; }],
  ['numeric radius', r => { r.recorded_proximity.radius_metres = 4828.032; }],
  ['unsupported radius', r => { r.recorded_proximity.radius_metres = '8046.720'; }],
  ['dropped account', r => { r.recorded_proximity.counts.accounts--; }],
  ['unknown treated as observed', r => { r.recorded_proximity.counts.observed_accounts--; r.recorded_proximity.counts.unknown_accounts++; }],
  ['fractional parcel count', r => { r.recorded_proximity.counts.parcels = 2.5; }],
  ['too few parcels', r => { r.recorded_proximity.counts.parcels = 1; }],
  ['over-capacity parcels', r => { r.recorded_proximity.counts.parcels = 100001; }],
  ['unknown count type', r => { r.recorded_proximity.counts.unknown_accounts = '0'; }],
  ['extra private account roster', r => { r.recorded_proximity.account_ids = ['private']; }],
  ['extra geometry', r => { r.recorded_proximity.geometry = proximityPolygon(); }],
  ['extra source reference', r => { r.recorded_proximity.counts.source_sha256 = 'a'.repeat(64); }],
  ['foreign context', r => { r.binding.context_ref.context_sha256 = 'f'.repeat(64); }],
  ['wrong selection binding', r => { r.binding.selection_revision++; }],
  ['selected scope', r => { r.selection_scope = 'selected_union'; }],
  ['enabled Apply', r => { r.apply.status = 'ready'; }],
  ['unknown proximity state', r => { r.all.factor_coverage.proximity.states = { verified: 2 }; }],
]) test(`rejects ${label} without partial v2 admission`, async () => {
  const f = await fixture(), raw = structuredClone(f.response.recommendation); change(raw);
  assert.throws(() => accept(raw, f), /Invalid pocket recommendation/);
});

test('v1 rejects a v2 addon and new proximity states, including when copied onto another factor', async () => {
  const f = await fixture({ v1: true }), expanded = await fixture();
  assert.throws(() => accept({ ...f.response.recommendation, recorded_proximity: expanded.response.recommendation.recorded_proximity }, f));
  for (const factor of ['proximity', 'gla']) for (const state of ['candidate_multiple_locations', 'candidate_invalid_geometry', 'proximity_unavailable']) {
    const raw = structuredClone(f.response.recommendation); raw.all.factor_coverage[factor].states = { [state]: raw.all.member_count };
    assert.throws(() => accept(raw, f));
  }
});

test('v2-specific proximity states cannot widen another factor vocabulary', async () => {
  const f = await fixture({ old: true });
  for (const factor of ['gla', 'age', 'housing_type', 'site_size', 'sale_price']) {
    const raw = structuredClone(f.response.recommendation);
    raw.all.factor_coverage[factor].states = { candidate_invalid_geometry: 2 };
    assert.throws(() => accept(raw, f));
  }
});

test('global means cannot contradict individually valid group means and ranges', async () => {
  const f = await fixture(), raw = structuredClone(f.response.recommendation);
  const before = raw.all.similarity.lower;
  raw.all.similarity.lower = rounds(before - .1); raw.all.similarity.upper = rounds(raw.all.similarity.upper - .1);
  raw.all.member_lower_bound_range = { low: 0, high: 100 };
  assert.throws(() => accept(raw, f), /Invalid pocket recommendation/);
});

test('global unknown classes must equal the complete pocket classes, not only their total', async () => {
  const f = await fixture({ parcels: [{ account_id: 'subject', geometry: proximityPolygon() },
    { account_id: 'subject', geometry: proximityPolygon(-96.64) }, { account_id: 'R-001', geometry: proximityPolygon(-96.63) }] });
  const raw = structuredClone(f.response.recommendation);
  delete raw.all.factor_coverage.proximity.states.candidate_multiple_locations;
  raw.all.factor_coverage.proximity.states.candidate_invalid_geometry = 1;
  assert.throws(() => accept(raw, f));
});

test('summary accessors and hidden serialization hooks are rejected without execution', async () => {
  const f = await fixture(); let calls = 0;
  for (const mutate of [r => Object.defineProperty(r.recorded_proximity, 'counts', { enumerable: true, get() { calls++; return {}; } }),
    r => Object.defineProperty(r.recorded_proximity.counts, 'toJSON', { value() { calls++; return {}; } })]) {
    const raw = structuredClone(f.response.recommendation); mutate(raw); assert.throws(() => accept(raw, f));
  }
  assert.equal(calls, 0);
});

const runtime = createRequire(new URL('../package.json', import.meta.url)), React = runtime('react');
const { renderToStaticMarkup } = runtime('react-dom/server'), ts = runtime('typescript');
const file = fileURLToPath(new URL('../src/features/neighborhood/components/CustomCohortWorkspace.tsx', import.meta.url));
const compiled = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText, module = { exports: {} };
let requests = 0, intents = 0;
new Script(`(function(require,module,exports){${compiled}\n})`, { filename: file }).runInThisContext()(key => {
  if (key === 'react' || key === 'react/jsx-runtime') return runtime(key);
  if (key === '../customCohortPocketCatalog') return catalogHelpers;
  if (key === '../customCohortPreviewController') return controller;
  if (key === '../customCohortPreviewApi') return { requestCustomCohortOperation() { requests++; assert.fail('No render-time request'); },
    requestCustomCohortObservationPreview() { requests++; assert.fail('No render-time request'); } };
  assert.ok(['./CustomCohortParcelMap', './CustomCohortStatistics', './CustomCohortPocketInspector'].includes(key));
  return { __esModule: true, default: () => null };
}, module, module.exports);
function render(f) {
  return renderToStaticMarkup(React.createElement(module.exports.default, { ...f.input, enabled: true, subjectLabel: 'Synthetic subject', sessionKey: 'test',
    workspace: { catalog: f.checked, selection: { revision: 7, included_recorded_group_ids: [] }, saving: false,
      previewTransport() { requests++; assert.fail('No render-time request'); }, onSelectionIntent() { intents++; } } }));
}

test('actual React rendering preserves the exact v1 disclosure without v2 prose', async () => {
  const f = await fixture({ v1: true }), html = render(f);
  assert.ok(html.includes('The fixed initial review policy uses GLA 40%, year-built similarity 30%, housing type 20%, and the remaining factors 10%. Housing, comparable distance and verified sale consideration are not established here. The map still shows your current inclusion choices.'));
  assert.doesNotMatch(html, /Recorded point proximity:/); assert.equal(html, render(f));
});

test('actual React renders global and pocket point coverage, not full-property or reliability claims', async () => {
  const f = await fixture(), before = hash(f.checked), html = render(f);
  assert.ok(html.includes('Recorded point proximity: 2 observed / 2 captured accounts; 0 unknown.'));
  assert.equal((html.match(/Recorded point proximity: 1 observed \/ 1 accounts; 0 unknown\./g) ?? []).length, 2);
  assert.match(html, /recorded subject centroid with a point on each retained parcel surface, not an entrance, route or full-property distance/);
  assert.match(html, /not confidence or reliability scores/); assert.doesNotMatch(html, /Housing, comparable distance and verified/);
  assert.equal(html, render(f)); assert.equal(hash(f.checked), before);
  assert.equal(requests, 0); assert.equal(intents, 0); assert.doesNotMatch(html, /checked=""/);
});

test('unavailable proximity remains visibly unknown, never a zero-distance or hidden denominator', async () => {
  const f = await fixture({ old: true }), html = render(f);
  assert.ok(html.includes('Recorded point proximity: 0 observed / 2 captured accounts; 2 unknown.'));
  assert.match(html, /Recorded point proximity is unavailable for this captured study/);
  assert.match(html, /Multiple locations and invalid parcel geometry stay unknown/);
  assert.equal(requests, 0); assert.equal(intents, 0);
});
