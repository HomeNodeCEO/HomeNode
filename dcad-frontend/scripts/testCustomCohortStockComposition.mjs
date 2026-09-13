import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkCustomCohortPocketCatalog as checkCatalog } from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import { checkCustomCohortStockComposition as check, unionCustomCohortStockComposition as union,
  stockCompositionOverlap as overlap } from '../src/features/neighborhood/customCohortStockComposition.ts';
import { STOCK_COMPOSITION_DEFINITION as DEFINITION, STOCK_COMPOSITION_PROFILE as PROFILE } from '../src/features/neighborhood/customCohortStockCompositionDefinition.ts';
import { getCustomCohortStockCompositionDefinition, CUSTOM_COHORT_STOCK_COMPOSITION_PROFILE } from '../../server/src/services/neighborhoodAssessment/customCohortStockComposition.js';
import { canonicalAssessmentJson as json } from '../../server/src/services/neighborhoodAssessment/contract.js';
import { cadEvidenceFixture } from '../../server/test/fixtures/customCohortCadEvidenceFixture.js';
import { buildCustomCohortPocketRecommendation } from '../../server/src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { presentCustomCohortPocketRecommendation } from '../../server/src/services/neighborhoodAssessment/customCohortPocketRecommendationPresentation.js';
import { presentCustomCohortPocketCatalog } from '../../server/src/services/neighborhoodAssessment/customCohortPocketCatalog.js';

const fixtures = new Map();
function fixture(mappingVersion = 4) {
  if (!fixtures.has(mappingVersion)) fixtures.set(mappingVersion, (async () => {
    const f = await cadEvidenceFixture({ mappingVersion, parcelCount: 4, parcelOverrides: { class_code: 'A11' } });
    const expected = { context_ref: f.input.expected.context_ref, selection_revision: f.preview.selection_revision };
    const catalog = presentCustomCohortPocketCatalog({ catalog: f.catalog, preview: f.preview, expected });
    const args = { context_ref: expected.context_ref, retained_inputs: f.input.retained_inputs,
      selection: { revision: expected.selection_revision, included_recorded_group_ids: [] } };
    const old = buildCustomCohortPocketRecommendation(args);
    const recommendation = buildCustomCohortPocketRecommendation({ ...args, include_stock_composition: true });
    const presented = presentCustomCohortPocketRecommendation({ catalog, expected, recommendation });
    const input = { accountId: f.input.expected.target.account_id, assignmentFileId: f.input.expected.target.assignment_file_id,
      contextRef: expected.context_ref, selection: { revision: expected.selection_revision, pockets: [] } };
    const response = { status: 'catalog', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
      context_ref: input.contextRef, selection_revision: input.selection.revision, subject_freshness: 'matched', catalog,
      recommendation: presented, apply: { status: 'blocked' } };
    return { f, old, recommendation, presented, catalog, expected, input, response, checked: checkCatalog(response, input) };
  })());
  return fixtures.get(mappingVersion);
}

test('browser fixed definition exactly matches the installed server hash and array grammar', () => {
  assert.deepEqual(DEFINITION, getCustomCohortStockCompositionDefinition());
  assert.deepEqual(PROFILE, CUSTOM_COHORT_STOCK_COMPOSITION_PROFILE);
  assert.equal(createHash('sha256').update(json(DEFINITION)).digest('hex'), PROFILE.content_sha256);
});

for (const version of [4, 5]) test(`actual mapping${version} source originals reach the checked catalog with exact full counts and unchanged scores`, async () => {
  const { old, recommendation, checked, input, response } = await fixture(version);
  const { stock_composition_v1: sidecar, ...same } = recommendation;
  assert.deepEqual(same, old); assert.equal(sidecar.all[0], 2);
  const actual = checked.recommendation.stock_composition_v1;
  assert.equal(actual.status, 'available'); assert.equal(actual.mapping_version, version);
  assert.deepEqual(actual.all, sidecar.all); assert.deepEqual(actual.pockets, sidecar.pockets);
  assert.deepEqual(union(actual, actual.pockets.map(p => p[0])), actual.all);
  assert.equal(union(actual, [])[0], 0);
  assert.ok(Object.isFrozen(actual.pockets[0][2][0][0]));
  const older = structuredClone(response); delete older.recommendation.stock_composition_v1;
  assert.equal(checkCatalog(older, input).recommendation.stock_composition_v1, undefined);
});

test('composition cannot evict the established complete recommendation when transport space is tight', async () => {
  const { old, recommendation, catalog, expected } = await fixture();
  const baseline = presentCustomCohortPocketRecommendation({ recommendation: old, catalog, expected });
  const bytes = Buffer.byteLength(JSON.stringify(baseline));
  assert.deepEqual(presentCustomCohortPocketRecommendation({ recommendation, catalog, expected, maximumBytes: bytes }), baseline);
  const diagnostic = presentCustomCohortPocketRecommendation({ recommendation, catalog, expected, maximumBytes: bytes + 600 });
  const { stock_composition_v1: sidecar, ...same } = diagnostic;
  assert.deepEqual(same, baseline); assert.equal(sidecar.status, 'unavailable'); assert.equal(sidecar.reason, 'output_byte_limit');
  assert.equal(Object.hasOwn(sidecar, 'all'), false);
});

for (const [label, mutate] of [
  ['wrong profile', r => { r.profile.content_sha256 = 'f'.repeat(64); }],
  ['altered bin algorithm', r => { r.definition.binning.method = 'median_only'; }],
  ['foreign context', r => { r.binding.context_ref.context_sha256 = 'f'.repeat(64); }],
  ['unknown mapping', r => { r.mapping_version = 6; }],
  ['crossed housing profile', r => { r.housing_profile = DEFINITION.housing_profiles[1]; }],
  ['missing leaf', r => { r.pockets.pop(); }],
  ['duplicate leaf', r => { r.pockets[1] = r.pockets[0]; }],
  ['reordered leaf list', r => { r.pockets.reverse(); }],
  ['lying complete count', r => { r.all[0]++; }],
  ['negative state', r => { r.all[1][0][0][0] = -1; }],
  ['fractional count', r => { r.all[1][0][0][0] = .5; }],
  ['dropped missing denominator', r => { r.pockets[0][2][0][0][2]++; }],
  ['lying histogram', r => { r.pockets[0][2][0][1][0]++; }],
  ['lying housing category', r => { r.all[2][1][0]++; }],
  ['unknown subject reference', r => { r.subject.recorded_group_id = 'unknown'; }],
  ['subject fallback through null', r => { r.subject.numeric[0] = ['json_null', 123, 'saved_subject']; }],
  ['invented origin', r => { r.subject.numeric[0][2] = 'inferred'; }],
  ['invalid date', r => { r.binding.captured_at = '2026-02-30T00:00:00.000Z'; }],
  ['nonfinite cuts', r => { r.bin_cuts[0][0] = Infinity; }],
  ['unavailable hiding data', r => { r.status = 'unavailable'; r.reason = 'output_byte_limit'; }],
  ['extra score authority', r => { r.reliability = 100; }],
]) test(`composition rejects ${label}`, async () => {
  const f = await fixture(), copy = structuredClone(f.presented.stock_composition_v1); mutate(copy);
  assert.throws(() => check(copy, f.checked));
});

test('catalog admission binds the sidecar timestamp to the existing captured CAD evidence', async () => {
  const f = await fixture(), copy = structuredClone(f.response);
  copy.recommendation.stock_composition_v1.binding.captured_at = '2026-09-07T08:00:00.123Z';
  assert.throws(() => checkCatalog(copy, f.input));
});

test('accessors and sparse arrays are rejected without invoking them', async () => {
  const f = await fixture(), original = f.presented.stock_composition_v1; let called = false;
  const bad = structuredClone(original); Object.defineProperty(bad, 'all', { enumerable: true, get() { called = true; return original.all; } });
  assert.throws(() => check(bad, f.checked)); assert.equal(called, false);
  const sparse = structuredClone(original); delete sparse.pockets[0]; assert.throws(() => check(sparse, f.checked));
});

test('union rejects duplicate or unknown original IDs without changing checked originals', async () => {
  const f = await fixture(), composition = f.checked.recommendation.stock_composition_v1;
  const before = JSON.stringify(composition), id = composition.pockets[0][0];
  assert.throws(() => union(composition, [id, id])); assert.throws(() => union(composition, ['missing']));
  assert.equal(JSON.stringify(composition), before);
});

test('binned overlap keeps missing coverage separate and is unavailable for empty observations', () => {
  assert.equal(overlap([1, 0, 0, 1], [0, 1, 1, 0]), 0);
  assert.equal(overlap([1, 1, 1, 1], [2, 2, 2, 2]), 100);
  assert.equal(overlap([1, 1, 0, 0], [0, 1, 1, 0]), 50);
  assert.equal(overlap([0, 0, 0, 0], [1, 1, 1, 1]), null);
  assert.throws(() => overlap([1], [-1]));
});
