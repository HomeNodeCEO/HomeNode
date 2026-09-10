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
import { cadEvidenceFixture } from '../../server/test/fixtures/customCohortCadEvidenceFixture.js';
import { decisionEvidenceFixture } from '../../server/test/fixtures/customCohortDecisionEvidenceFixture.js';
import { recordedProximityFixture } from '../../server/test/fixtures/customCohortRecordedProximityFixture.js';
import { deriveCustomCohortRecordedProximity } from '../../server/src/services/neighborhoodAssessment/customCohortRecordedProximity.js';
import { CUSTOM_COHORT_RECORDED_HOUSING_PROFILE, CUSTOM_COHORT_RECORDED_HOUSING_CATEGORIES } from '../../server/src/services/neighborhoodAssessment/customCohortRecordedHousing.js';
import { buildCustomCohortPocketRecommendation as build } from '../../server/src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { presentCustomCohortPocketRecommendation as present } from '../../server/src/services/neighborhoodAssessment/customCohortPocketRecommendationPresentation.js';
import { presentCustomCohortPocketCatalog } from '../../server/src/services/neighborhoodAssessment/customCohortPocketCatalog.js';

const fixtures = new Map(), sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields = { class_code: null, class_description: null, use_description: null, structure_type: null, built_up: null };
async function fixture({ code = 'A11', overrides = {}, proximity = false, legacy = false } = {}) {
  const key = JSON.stringify({ code, overrides, proximity, legacy });
  if (fixtures.has(key)) return fixtures.get(key);
  const promise = (async () => {
    const f = legacy ? await (proximity ? recordedProximityFixture() : decisionEvidenceFixture())
      : await cadEvidenceFixture({ parcelOverrides: { ...fields, class_code: code, ...overrides } });
    const context_ref = f.input.expected.context_ref, retained_inputs = f.input.retained_inputs, expected = { context_ref, selection_revision: 7 };
    // Original mapping4 evidence uses the real capture/persist/reopen fixture.
    // Only native measurements are faked (when valid retained EWKB is present).
    // The usual mapping4 fixture has old invalid EWKB: it stays unavailable.
    const measured = proximity ? await deriveCustomCohortRecordedProximity(async (_sql, values) => {
      const rows = JSON.parse(values[0]).map((row, i) => ({ object_id: row.object_id, valid: true,
        location_count: 1, minimum_metres: i * 1609.344, maximum_metres: i * 1609.344 }));
      return { rowCount: rows.length, rows };
    }, { context_ref, retained_inputs }) : null;
    const catalog = presentCustomCohortPocketCatalog({ catalog: f.catalog, preview: f.preview, expected });
    const kernel = build({ context_ref, retained_inputs, selection: { revision: 7, included_recorded_group_ids: [] },
      ...(measured ? { recorded_proximity: measured } : {}) });
    const recommendation = present({ recommendation: kernel, catalog, expected });
    const input = { accountId: f.input.expected.target.account_id, assignmentFileId: f.input.expected.target.assignment_file_id,
      contextRef: context_ref, selection: { revision: 7, pockets: [] } };
    const response = { status: 'catalog', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
      context_ref, selection_revision: 7, subject_freshness: 'matched', catalog, recommendation, apply: { status: 'blocked' } };
    return { f, kernel, measured, input, response, checked: catalogHelpers.checkCustomCohortPocketCatalog(response, input) };
  })();
  fixtures.set(key, promise); return promise;
}
const accept = (r, f) => check(r, f.checked, f.response.catalog.binding.selection_sha256);

test('original mapping4 capture -> kernel -> presenter -> browser admits observed housing-only v3', async () => {
  const f = await fixture(), r = f.checked.recommendation;
  assert.equal(r.policy.id, 'custom-current-observation-review-v3'); assert.equal(r.policy.revision, 3);
  assert.equal(r.evidence_mode, 'recorded_housing_only'); assert.equal(Object.hasOwn(r, 'recorded_proximity'), false);
  assert.deepEqual(r.recorded_housing.profile, CUSTOM_COHORT_RECORDED_HOUSING_PROFILE);
  assert.equal(r.recorded_housing.subject.state, 'observed'); assert.equal(r.recorded_housing.subject.category, 'detached_single_family');
  assert.equal(r.recorded_housing.subject.origin, 'current_subject_cad');
  assert.deepEqual(r.recorded_housing.coverage, { account_count: 2, observed_count: 2, unknown_count: 0,
    states: { observed: 2, missing: 0, unknown: 0, partial: 0, conflicting: 0 } });
  assert.equal(r.all.factor_coverage.housing_type.observed_count, 2);
  assert.equal(r.all.similarity.known_weight_percent, 93.3333);
  assert.deepEqual(Object.keys(f.response.recommendation.unavailable_factors), ['proximity', 'sale_price']);
  assert.equal(f.response.recommendation.presentation_version, 1); assert.equal(f.response.recommendation.recommendation_version, 1);
  assert.equal(f.response.recommendation.apply.status, 'blocked');
  assert.ok(Object.isFrozen(r.recorded_housing.coverage.states));
  const raw = structuredClone(f.response.recommendation), before = JSON.stringify(raw), checked = accept(raw, f);
  assert.equal(JSON.stringify(raw), before); assert.equal(Object.isFrozen(raw.recorded_housing.subject), false);
  assert.notEqual(checked.recorded_housing.subject, raw.recorded_housing.subject);
});

test('v3 combined mode retains unavailable geometry without dropping otherwise usable housing', async () => {
  const f = await fixture({ proximity: true }), r = f.checked.recommendation;
  assert.equal(r.evidence_mode, 'recorded_housing_and_proximity'); assert.equal(r.recorded_proximity.status, 'unavailable');
  assert.equal(r.recorded_proximity.reason, 'retained_map_unavailable');
  assert.equal(r.all.factor_coverage.housing_type.observed_count, 2); assert.equal(r.all.factor_coverage.proximity.observed_count, 0);
  assert.deepEqual(Object.keys(f.response.recommendation.unavailable_factors), ['sale_price']);
});

for (const [name, options, state] of [
  ['missing', { code: null }, 'missing'], ['unknown numeric', { code: '101' }, 'unknown'],
  ['conflicting', { code: 'A11', overrides: { structure_type: 'CONDOMINIUM' } }, 'conflicting'],
]) test(`actual ${name} retained observations stay unknown and unscored`, async () => {
  const f = await fixture(options), r = f.checked.recommendation;
  assert.equal(r.recorded_housing.subject.state, state); assert.equal(r.recorded_housing.subject.category, null);
  assert.equal(r.recorded_housing.coverage.states[state], 2); assert.equal(r.recorded_housing.coverage.unknown_count, 2);
  assert.equal(r.all.factor_coverage.housing_type.observed_count, 0);
  assert.deepEqual(r.all.factor_coverage.housing_type.states, { [`subject_${state}`]: 2 });
  assert.equal(r.all.similarity.known_weight_percent, 73.3333);
});

for (const [code, category] of [['A11', 'detached_single_family'], ['A12', 'townhouse'], ['A13', 'condominium'],
  ['B12', 'duplex'], ['B11', 'apartment'], ['A20', 'mobile_home']]) test(`actual recorded ${code} admits only ${category}`, async () => {
  assert.equal((await fixture({ code })).checked.recommendation.recorded_housing.subject.category, category);
});
test('literal manufactured-home observation remains distinct from mobile-home classification', async () => {
  const f = await fixture({ code: null, overrides: { structure_type: 'MANUFACTURED HOME' } });
  assert.equal(f.checked.recommendation.recorded_housing.subject.category, 'manufactured_home');
});

test('mapping2 v1 and v2 remain unchanged and omit housing and evidence_mode', async () => {
  for (const proximity of [false, true]) {
    const f = await fixture({ legacy: true, proximity }), r = f.checked.recommendation;
    assert.equal(r.policy.revision, proximity ? 2 : 1);
    assert.equal(Object.hasOwn(r, 'recorded_housing'), false); assert.equal(Object.hasOwn(r, 'evidence_mode'), false);
    if (!proximity) assert.equal(sha(r), '6f7147fbe8d5d160f1f545f8f0cf0ba6542445b4b08a67e7e03a6fc69d95da90');
    // Independently read from V's unchanged decoder using this original v2 fixture.
    else assert.equal(sha(r), '19a3cd277fe1d17622f3afb4cd30e15bff81b910015aa3fe2f0dd825415e3c9f');
  }
});

for (const [label, mutate] of [
  ['missing housing', r => { delete r.recorded_housing; }], ['null housing', r => { r.recorded_housing = null; }],
  ['missing evidence mode', r => { delete r.evidence_mode; }], ['unknown mode', r => { r.evidence_mode = 'automatic_verified'; }],
  ['combined mode without proximity', r => { r.evidence_mode = 'recorded_housing_and_proximity'; }],
  ['old policy with new summary', r => { r.policy.id = 'custom-current-observation-review-v1'; r.policy.revision = 1; }],
  ['changed policy revision', r => { r.policy.revision = 2; }], ['changed curve', r => { r.policy.curve_methodology_version = 7; }],
  ['changed housing weight', r => { r.policy.weights.housing_type = .5; }],
  ['changed review threshold', r => { r.policy.minimum_mean_known_weight_percent = 69; }],
  ['invented version', r => { r.recorded_housing.housing_version = 2; }], ['relabelled mapping2', r => { r.recorded_housing.mapping_version = 2; }],
  ['wrong profile ID', r => { r.recorded_housing.profile.id = 'provider_verified'; }],
  ['wrong profile revision', r => { r.recorded_housing.profile.revision = 2; }],
  ['wrong profile digest', r => { r.recorded_housing.profile.content_sha256 = 'a'.repeat(64); }],
  ['wrong basis', r => { r.recorded_housing.basis = 'verified_taxonomy'; }],
  ['claimed authority', r => { r.recorded_housing.authority = 'verified'; }],
  ['unknown category', r => { r.recorded_housing.subject.category = 'one_unit'; }],
  ['observed without category', r => { r.recorded_housing.subject.category = null; }],
  ['unknown with category', r => { r.recorded_housing.subject.state = 'unknown'; }],
  ['null origin', r => { r.recorded_housing.subject.origin = null; }],
  ['candidate origin on subject', r => { r.recorded_housing.subject.origin = 'retained_current_cad'; }],
  ['dropped account', r => { r.recorded_housing.coverage.account_count--; }],
  ['unknown count string', r => { r.recorded_housing.coverage.unknown_count = '0'; }],
  ['over-capacity accounts', r => { r.recorded_housing.coverage.account_count = 50001; }],
  ['missing zero state', r => { delete r.recorded_housing.coverage.states.partial; }],
  ['extra state', r => { r.recorded_housing.coverage.states.verified = 0; }],
  ['candidate summary inconsistency', r => { r.recorded_housing.coverage.states.observed--; r.recorded_housing.coverage.states.unknown++; }],
  ['housing marked unavailable', r => { r.unavailable_factors.housing_type = 'comparable_current_housing_taxonomy_not_retained'; }],
  ['omitted sale unavailability', r => { delete r.unavailable_factors.sale_price; }],
  ['wrong unavailable distance', r => { r.unavailable_factors.proximity = 'driving_distance'; }],
  ['raw source accounts', r => { r.recorded_housing.accounts = [{ account_id: 'private' }]; }],
  ['raw source pockets', r => { r.recorded_housing.pockets = []; }],
  ['raw subject material', r => { r.recorded_housing.subject.profile_source = 'private'; }],
  ['source confidence', r => { r.recorded_housing.subject.confidence = 1; }],
  ['extra source binding', r => { r.recorded_housing.binding = {}; }],
  ['wrong context', r => { r.binding.context_ref.context_sha256 = 'f'.repeat(64); }],
  ['wrong selection', r => { r.binding.selection_revision++; }],
  ['claimed Apply', r => { r.apply.status = 'ready'; }],
  ['claim confidence state', r => { r.all.factor_coverage.housing_type.states = { verified: 2 }; }],
]) test(`v3 rejects ${label} without dropping the invalid addon`, async () => {
  const f = await fixture(), raw = structuredClone(f.response.recommendation); mutate(raw);
  assert.throws(() => accept(raw, f), /Invalid pocket recommendation/);
});

test('combined mode cannot omit or silently add a proximity result', async () => {
  const f = await fixture({ proximity: true }), raw = structuredClone(f.response.recommendation);
  raw.evidence_mode = 'recorded_housing_only'; assert.throws(() => accept(raw, f));
  delete raw.recorded_proximity; assert.doesNotThrow(() => accept({ ...raw,
    unavailable_factors: { proximity: 'comparable_property_distance_not_retained', sale_price: raw.unavailable_factors.sale_price },
    all: { ...raw.all, factor_coverage: { ...raw.all.factor_coverage, proximity: { observed_count: 0, unknown_count: 2, states: { not_established: 2 } } } },
    pockets: raw.pockets.map(p => ({ ...p, factor_coverage: { ...p.factor_coverage,
      proximity: { observed_count: 0, unknown_count: p.member_count, states: { not_established: p.member_count } } } })),
  }, f));
});

test('unknown subject keeps candidate observations separate from scored housing coverage', async () => {
  const f = await fixture({ code: null }), raw = structuredClone(f.response.recommendation);
  // This synthetic PUBLIC DTO isolates admission accounting, not graph/source interpretation.
  raw.recorded_housing.coverage = { account_count: 2, observed_count: 2, unknown_count: 0,
    states: { observed: 2, missing: 0, unknown: 0, partial: 0, conflicting: 0 } };
  const checked = accept(raw, f); assert.equal(checked.recorded_housing.coverage.observed_count, 2);
  assert.equal(checked.all.factor_coverage.housing_type.observed_count, 0);
});

for (const state of ['missing', 'unknown', 'partial', 'conflicting']) test(`admission preserves complete ${state} candidate denominator when subject is observed`, async () => {
  const f = await fixture({ code: null }), raw = structuredClone(f.response.recommendation);
  // Synthetic public-envelope accounting case, not an assertion about the
  // retained fixture's subject/category interpretation or native acquisition.
  raw.recorded_housing.subject = { state: 'observed', category: 'townhouse', origin: 'saved_subject' };
  raw.recorded_housing.coverage.states = { observed: 0, missing: 0, unknown: 0, partial: 0, conflicting: 0, [state]: 2 };
  for (const pop of [raw.all, ...raw.pockets]) pop.factor_coverage.housing_type.states = { [`candidate_${state}`]: pop.member_count };
  const checked = accept(raw, f); assert.equal(checked.recorded_housing.coverage.states[state], 2);
  assert.equal(checked.all.factor_coverage.housing_type.observed_count, 0); assert.equal(checked.all.factor_coverage.housing_type.unknown_count, 2);
  raw.recorded_housing.coverage.states[state]--; raw.recorded_housing.coverage.states.observed++;
  assert.throws(() => accept(raw, f));
});

for (const origin of ['saved_subject', 'retained_subject_public', 'current_subject_cad']) test(`admission preserves ${origin} provenance without converting it to verification`, async () => {
  const f = await fixture(), raw = structuredClone(f.response.recommendation); raw.recorded_housing.subject.origin = origin;
  const checked = accept(raw, f); assert.equal(checked.recorded_housing.subject.origin, origin);
  assert.equal(checked.recorded_housing.authority, 'not_established');
});

test('all/pocket housing classes and means must reconcile, even when denominators match', async () => {
  const f = await fixture({ code: null }), raw = structuredClone(f.response.recommendation);
  raw.pockets[0].factor_coverage.housing_type.states = { candidate_missing: raw.pockets[0].member_count };
  assert.throws(() => accept(raw, f));
  const observed = await fixture(), mixed = structuredClone(observed.response.recommendation);
  mixed.all.similarity.lower -= .1; mixed.all.similarity.upper -= .1; mixed.all.member_lower_bound_range.low = 0;
  assert.throws(() => accept(mixed, observed));
});

test('v3 housing states cannot widen other factors or older recommendation profiles', async () => {
  for (const legacy of [false, true]) {
    const f = await fixture({ legacy });
    for (const factor of legacy ? ['housing_type', 'gla'] : ['gla', 'age', 'site_size', 'proximity', 'sale_price']) {
      const raw = structuredClone(f.response.recommendation); raw.all.factor_coverage[factor].states = { candidate_partial: 2 };
      assert.throws(() => accept(raw, f));
    }
  }
});

test('summary getters and hidden serialization hooks are rejected without executing them', async () => {
  const f = await fixture(); let calls = 0;
  for (const mutate of [r => Object.defineProperty(r.recorded_housing, 'subject', { enumerable: true, get() { calls++; return {}; } }),
    r => Object.defineProperty(r.recorded_housing.coverage.states, 'toJSON', { value() { calls++; return {}; } })]) {
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

test('actual React displays recorded observation and comparison coverage without verification claims', async () => {
  const f = await fixture(), before = sha(f.checked), html = render(f);
  assert.ok(html.includes('Recorded housing observations: 2 observed / 2 captured accounts; 0 unknown.'));
  assert.ok(html.includes('Subject category: Detached single-family (current retained subject CAD).'));
  assert.ok(html.includes('Housing comparison: 2 observed / 2 captured accounts; 0 unknown.'));
  assert.match(html, /not verified property classifications/); assert.match(html, /fixed 20% housing weight/);
  assert.match(html, /Missing, unknown, partial and conflicting observations stay unscored/);
  assert.doesNotMatch(html, /Housing taxonomy and verified sale consideration are not established here/);
  assert.equal(html, render(f)); assert.equal(sha(f.checked), before); assert.equal(requests, 0); assert.equal(intents, 0);
  assert.doesNotMatch(html, /checked=""/);
});

test('actual unknown housing display does not imply missing is a match or verified zero', async () => {
  const html = render(await fixture({ code: null }));
  assert.ok(html.includes('Recorded housing observations: 0 observed / 2 captured accounts; 2 unknown.'));
  assert.match(html, /Subject category: Unknown/); assert.ok(html.includes('Housing comparison: 0 observed / 2 captured accounts; 2 unknown.'));
  assert.match(html, /not verified housing classifications or historical stock evidence/);
});

test('seven human labels retain mobile/manufactured distinction without underscore codes', async () => {
  const f = await fixture();
  for (const category of CUSTOM_COHORT_RECORDED_HOUSING_CATEGORIES) {
    const next = structuredClone(f.checked); next.recommendation.recorded_housing.subject.category = category;
    const html = render({ ...f, checked: next });
    assert.doesNotMatch(html, new RegExp(`Subject category: ${category}(?: |\\()`));
  }
  assert.match(render(await fixture({ code: 'A20' })), /Subject category: Mobile home/);
  assert.match(render(await fixture({ code: null, overrides: { structure_type: 'MANUFACTURED HOME' } })), /Subject category: Manufactured home/);
});

test('pocket buttons explicitly stack label, counts and scores despite the global inline-flex button base', async () => {
  const f = await fixture(), checked = structuredClone(f.checked);
  const long = 'Recorded subdivision with a long, precise name and phase identifier '.repeat(3);
  checked.pockets[0].label = long;
  const html = render({ ...f, checked }), cards = [...html.matchAll(/<button[^>]*class="[^"]*custom-cohort-pocket-card[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]);
  assert.equal(cards.length, f.checked.pockets.length);
  for (const card of cards) {
    assert.match(card, /display:grid/); assert.match(card, /grid-template-columns:minmax\(0, 1fr\)/);
    assert.match(card, /justify-items:stretch/); assert.match(card, /white-space:normal/); assert.match(card, /overflow-wrap:anywhere/);
    assert.match(card, /aria-pressed="false"/); assert.doesNotMatch(card, /type="checkbox"/);
    assert.match(card, /Review rank/); assert.match(card, /Observed factor coverage/); assert.match(card, /Recorded housing comparison/);
  }
  assert.ok(cards.some(card => card.includes(long))); assert.equal(requests, 0); assert.equal(intents, 0);
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  assert.match(css, /:where\(\.app-action-button, button:not\(\[aria-label\]\)[\s\S]*?display: inline-flex/);
  // This is real React markup + exact scoped CSS precedence, not a claim of
  // browser layout at a particular viewport. Parent performs that visual QA.
});
