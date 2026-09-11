import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCustomCohortPocketCatalog as checkCatalog } from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import { checkCustomCohortPocketRecommendation as check } from '../src/features/neighborhood/customCohortPocketRecommendation.ts';
import { decisionEvidenceFixture } from '../../server/test/fixtures/customCohortDecisionEvidenceFixture.js';
import { buildCustomCohortPocketRecommendation } from '../../server/src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { presentCustomCohortPocketRecommendation } from '../../server/src/services/neighborhoodAssessment/customCohortPocketRecommendationPresentation.js';
import { presentCustomCohortPocketCatalog } from '../../server/src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { buildCustomCohortPocketCatalog } from '../../server/src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { buildCustomCohortIndexedObservationPreview } from '../../server/src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { recommendationFixture } from '../../server/test/fixtures/customCohortDenseRecommendationFixture.js';

test('all 887 ranked groups cross the real server/browser boundary; corrupt dense responses fail closed', () => {
  const accounts = Array.from({ length: 887 }, (_, i) => `A${String(i).padStart(5, '0')}`);
  const f = recommendationFixture({ accounts, subject: accounts[0], mapping4: true });
  const expected = { context_ref: f.context_ref, selection_revision: 1 };
  const preview = buildCustomCohortIndexedObservationPreview({ ...f, selection: { revision: 1, pockets: [] } });
  const catalog = presentCustomCohortPocketCatalog({ preview, expected,
    catalog: buildCustomCohortPocketCatalog({ retained_inputs: f.retained_inputs, preview, catalog_version: 2 }) });
  const recommendation = presentCustomCohortPocketRecommendation({ catalog, expected,
    recommendation: buildCustomCohortPocketRecommendation({ ...f, catalog_version: 2, observation_preview: preview }) });
  const target = f.retained_inputs.subject.target;
  const input = { accountId: target.account_id, assignmentFileId: target.assignment_file_id,
    contextRef: f.context_ref, selection: { revision: 1, pockets: [] } };
  const response = { status: 'catalog', target: { account_id: target.account_id, assignment_file_id: target.assignment_file_id },
    context_ref: f.context_ref, selection_revision: 1, subject_freshness: 'matched', catalog, recommendation, apply: { status: 'blocked' } };
  const checked = checkCatalog(response, input);
  assert.equal(checked.recommendation.pockets.length, 887);
  assert.equal(checked.recommendation.all.member_count, 887);
  assert.deepEqual(checked.recommendation.recommended_recorded_group_ids, recommendation.recommended_recorded_group_ids);
  for (const mutate of [r => r.recommendation.pockets.pop(), r => r.recommendation.pockets.reverse(),
    r => { r.recommendation.pockets[886].member_count++; }, r => { r.catalog.catalog_version = 1; },
    r => { r.recommendation.presentation_version = 1; }, r => { r.recommendation.recommendation_version = 1; },
    r => { r.recommendation.binding.selection_revision++; }]) {
    const bad = structuredClone(response); mutate(bad); assert.throws(() => checkCatalog(bad, input));
  }
  assert.deepEqual(input.selection, { revision: 1, pockets: [] });
});

const original = decisionEvidenceFixture();
async function fixture() {
  const f = await original, context = f.input.expected.context_ref;
  const expected = { context_ref: context, selection_revision: 7 };
  const catalog = presentCustomCohortPocketCatalog({ catalog: f.catalog, preview: f.preview, expected });
  const recommendation = presentCustomCohortPocketRecommendation({ expected, catalog,
    recommendation: buildCustomCohortPocketRecommendation({ context_ref: context, retained_inputs: f.input.retained_inputs,
      selection: { revision: 7, included_recorded_group_ids: [] } }) });
  const input = { accountId: f.input.expected.target.account_id, assignmentFileId: f.input.expected.target.assignment_file_id,
    contextRef: context, selection: { revision: 7, pockets: [] } };
  const response = { status: 'catalog', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
    context_ref: context, selection_revision: 7, subject_freshness: 'matched', catalog, recommendation, apply: { status: 'blocked' } };
  return { input, response, checked: checkCatalog(response, input) };
}

test('actual capture -> kernel -> compact server presenter -> browser admission preserves full catalog-bound recommendation', async () => {
  const { response, checked } = await fixture(), value = checked.recommendation;
  assert.ok(value); assert.equal(value.pockets.length, checked.pockets.length);
  assert.equal(value.all.member_count, checked.coverage.discovery_member_count);
  assert.deepEqual(value.recommended_recorded_group_ids, response.recommendation.recommended_recorded_group_ids);
  assert.ok(Object.isFrozen(value.pockets[0].factor_coverage));
  const json = JSON.stringify(value);
  for (const forbidden of ['raw_projection', 'retained_inputs', 'material_input', 'source_ref', 'organization_id', 'assignment_file_id', 'selected']) {
    assert.ok(!json.includes(`"${forbidden}"`), forbidden);
  }
});

test('older catalog response without recommendation remains usable without inventing suggestions', async () => {
  const { response, input } = await fixture(), older = structuredClone(response); delete older.recommendation;
  assert.equal(checkCatalog(older, input).recommendation, null);
});

test('an incomplete public catalog without recommendation preserves every unresolved member and saved empty intent', async () => {
  const { response, input } = await fixture(), altered = structuredClone(response); delete altered.recommendation;
  const c = altered.catalog, members = c.pockets.flatMap(group => group.account_ids);
  c.status = 'incomplete'; c.pockets = []; c.unassigned = { account_ids: members, member_count: members.length, reason_counts: [] };
  c.coverage.assigned_account_count = 0; c.coverage.unassigned_account_count = members.length;
  c.subject_membership.assigned_pocket_id = null; c.subject_membership.status = 'catalog_incomplete';
  const result = checkCatalog(altered, input);
  assert.equal(result.status, 'incomplete'); assert.equal(result.recommendation, null);
  assert.deepEqual(result.unassigned.account_ids, members); assert.deepEqual(input.selection.pockets, []);
});

for (const [label, mutate] of [
  ['foreign context', r => { r.binding.context_ref.context_sha256 = 'f'.repeat(64); }],
  ['wrong selection revision', r => { r.binding.selection_revision++; }],
  ['wrong selection fingerprint', r => { r.binding.selection_sha256 = 'f'.repeat(64); }],
  ['renormalized fake confidence', r => { r.confidence = 100; }],
  ['selected scope', r => { r.selection_scope = 'selected_union'; }],
  ['enabled Apply', r => { r.apply.status = 'ready'; }],
  ['unsupported version', r => { r.recommendation_version = 2; }],
  ['hidden new policy', r => { r.policy.revision = 2; }],
  ['changed weights', r => { r.policy.weights.gla = .9; }],
  ['changed threshold', r => { r.policy.minimum_mean_lower_bound = 1; }],
  ['dropped group', r => { r.pockets.pop(); }],
  ['duplicate group', r => { r.pockets[1] = structuredClone(r.pockets[0]); }],
  ['foreign group', r => { r.pockets[0].id = `recorded-cad:${'f'.repeat(64)}`; }],
  ['lying roster count', r => { r.all.member_count++; }],
  ['lying pocket count', r => { r.pockets[0].member_count++; }],
  ['wrong rank', r => { r.pockets[0].review_rank = 99; }],
  ['extra suggested group', r => { r.recommended_recorded_group_ids.push('discovery:unassigned'); }],
  ['duplicate suggestion', r => { r.recommended_recorded_group_ids.push(r.recommended_recorded_group_ids[0]); }],
  ['invalid upper bound', r => { r.pockets[0].similarity.upper = 101; }],
  ['nonfinite bound', r => { r.pockets[0].similarity.lower = Infinity; }],
  ['unknown treated as known', r => { r.pockets[0].similarity.known_weight_percent = 100; }],
  ['false complete housing coverage', r => { r.pockets[0].factor_coverage.housing_type.observed_count = 1; }],
  ['wrong subject membership', r => { r.subject.in_discovery = false; }],
  ['subject forced into another group', r => { r.subject.recorded_group_review_ids = [r.pockets.find(p => !p.contains_subject).id]; }],
  ['unbounded text', r => { r.limitations[0] = 'x'.repeat(512001); }],
  ['raw property leak', r => { r.properties = [{ account_id: 'private' }]; }],
]) test(`rejects ${label} without a partial recommendation or replacement selection`, async () => {
  const { input, response } = await fixture(), altered = structuredClone(response); mutate(altered.recommendation);
  assert.throws(() => checkCatalog(altered, input), /Invalid pocket recommendation/);
});

test('explicit null/malformed recommendation is not treated as a successful empty recommendation', async () => {
  const { input, response } = await fixture();
  for (const recommendation of [null, false, [], {}]) assert.throws(() => checkCatalog({ ...response, recommendation }, input));
});

test('the recommendation checker rejects accessors before invoking values', async () => {
  const { response, checked } = await fixture(), rec = structuredClone(response.recommendation);
  let calls = 0; Object.defineProperty(rec, 'policy', { enumerable: true, get() { calls++; throw new Error('must not run'); } });
  assert.throws(() => check(rec, checked, response.catalog.binding.selection_sha256), /Invalid pocket recommendation/);
  assert.equal(calls, 0);
});

test('hidden array serialization hooks cannot execute while checking the final byte bound', async () => {
  const { response, checked } = await fixture(), rec = structuredClone(response.recommendation);
  let calls = 0; Object.defineProperty(rec.pockets, 'toJSON', { enumerable: false, value() { calls++; return []; } });
  assert.throws(() => check(rec, checked, response.catalog.binding.selection_sha256), /Invalid pocket recommendation/);
  assert.equal(calls, 0);
});
