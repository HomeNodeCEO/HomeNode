import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomCohortPocketRecommendation } from '../src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { buildCustomCohortObservationPreview } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { presentCustomCohortPocketCatalog } from '../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { presentCustomCohortPocketRecommendation as present, buildCustomCohortPocketRecommendationPresentation as compose,
  CUSTOM_COHORT_POCKET_RECOMMENDATION_PRESENTATION_LIMITS as LIMITS }
  from '../src/services/neighborhoodAssessment/customCohortPocketRecommendationPresentation.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';
import { saleWitnessMeaningFixture } from './fixtures/customCohortSaleWitnessMeaningFixture.js';

const base = decisionEvidenceFixture();
test('incomplete dense catalog does not rank an arbitrary128-group prefix', () => {
  const catalog = { catalog_version: 2, catalog_complete: false, authority: 'not_established', apply: { status: 'blocked' },
    pockets: Array.from({ length: 887 }, (_, i) => ({ id: `recorded-cad:${i}` })) };
  assert.equal(compose({ catalog }), null, 'dense ranking returns before requiring source/native observations');
});
function inputs(fixture, selection = { revision: 7, pockets: [] }) {
  const retained_inputs = fixture.input.retained_inputs, context_ref = fixture.input.expected.context_ref;
  const preview = buildCustomCohortObservationPreview({ retained_inputs, context_ref, selection });
  const expected = { context_ref, selection_revision: selection.revision };
  const catalog = presentCustomCohortPocketCatalog({ catalog: { ...fixture.catalog,
    binding: { context_ref, selection_revision: selection.revision } }, preview, expected });
  const recommendation = buildCustomCohortPocketRecommendation({ retained_inputs, context_ref,
    selection: { revision: selection.revision, included_recorded_group_ids: [] } });
  return { catalog, recommendation, expected };
}

for (const [version, fixture] of [[2, base], [3, saleWitnessMeaningFixture()]]) {
  test(`actual mapping${version} baseline retains group counts/bounds but excludes private/member/selected data`, async () => {
    const input = inputs(await fixture), result = present(input);
    assert.deepEqual(result.binding, input.catalog.binding);
    assert.equal(result.selection_scope, 'all_retained_discovery_accounts_independent_of_included_groups');
    assert.equal(result.authority, 'not_established'); assert.equal(result.apply.status, 'blocked');
    assert.deepEqual(result.all, input.recommendation.all);
    assert.deepEqual(result.recommended_recorded_group_ids, input.recommendation.recommended_recorded_group_ids);
    for (const pocket of result.pockets) {
      const original = input.recommendation.pockets.find(row => row.id === pocket.id);
      assert.deepEqual(pocket.similarity, original.result.similarity);
      assert.deepEqual(pocket.factor_coverage, original.result.factor_coverage);
      assert.equal(pocket.member_count, original.result.member_count);
      assert.equal(pocket.suggested_for_review, original.suggested_for_review);
    }
    const serialized = JSON.stringify(result);
    for (const name of ['account_ids', 'account_id', 'properties', 'selected', 'observations', 'material', 'source_refs',
      'source_raw_witness', 'organization_id', 'report_file_id', 'assignment_file_id', 'output_utf8_bytes']) {
      assert.equal(serialized.includes(`"${name}":`), false, name);
    }
    assert.ok(Buffer.byteLength(serialized) <= LIMITS.output_utf8_bytes);
    assert.ok(Object.isFrozen(result.pockets[0].factor_coverage.gla.states));
    assert.throws(() => { result.recommended_recorded_group_ids.push('invented'); }, TypeError);
  });
}

test('a changed requested union changes only binding, never baseline scores, ranks or recommendations', async () => {
  const f = await base, first = present(inputs(f));
  const second = present(inputs(f, { revision: 8, pockets: [{ id: 'selected', label: 'Manual selection', account_ids: [...f.accountIds] }] }));
  assert.notEqual(first.binding.selection_sha256, second.binding.selection_sha256);
  assert.equal(second.binding.selection_revision, 8);
  assert.deepEqual({ ...first, binding: null }, { ...second, binding: null });
});

test('unassigned records retain complete denominator and no suggested group', async () => {
  const input = inputs(await decisionEvidenceFixture({ missingCounty: true })), result = present(input);
  assert.equal(result.pockets.length, 1); assert.equal(result.pockets[0].id, 'discovery:unassigned');
  assert.equal(result.pockets[0].member_count, input.catalog.unassigned.member_count);
  assert.equal(result.all.member_count, input.catalog.coverage.stock_member_count);
  assert.deepEqual(result.recommended_recorded_group_ids, []);
  assert.equal(result.all.factor_coverage.housing_type.observed_count, 0);
  assert.equal(result.all.factor_coverage.housing_type.unknown_count, result.all.member_count);
});

test('wrong context/revision, selected-union kernel and altered policy are rejected', async () => {
  const input = inputs(await base);
  for (const change of [value => { value.expected.context_ref.context_sha256 = 'f'.repeat(64); },
    value => { value.catalog.binding.selection_revision++; },
    value => { value.catalog.binding.selection_sha256 = 'bad'; },
    value => { value.recommendation.binding.selection_revision++; },
    value => { value.recommendation.selection.included_recorded_group_ids = [value.catalog.pockets[0].id]; },
    value => { value.recommendation.policy.weights.gla = 1; }]) {
    const copy = structuredClone(input); change(copy); assert.throws(() => present(copy));
  }
});

test('duplicate/missing groups, wrong ranks, mismatched denominator and impossible bounds are rejected', async () => {
  const input = inputs(await base);
  for (const change of [value => { value.recommendation.pockets.pop(); },
    value => { value.recommendation.pockets[1].id = value.recommendation.pockets[0].id; },
    value => { value.recommendation.pockets[0].review_rank = 0; },
    value => { value.recommendation.pockets[0].result.member_count++; },
    value => { value.recommendation.pockets[0].result.factor_coverage.gla.unknown_count++; },
    value => { value.recommendation.pockets[0].result.similarity.lower = 101; },
    value => { value.recommendation.pockets[0].result.similarity.upper = null; },
    value => { value.recommendation.recommended_recorded_group_ids = ['not-in-catalog']; }]) {
    const copy = structuredClone(input); change(copy); assert.throws(() => present(copy));
  }
});

test('whitelist ignores private extras and result is detached from the kernel/catalog', async () => {
  const input = structuredClone(inputs(await base));
  input.recommendation.secret = 'provider-private';
  input.recommendation.pockets[0].raw_values = ['provider-private'];
  const result = present(input), before = JSON.stringify(result);
  input.recommendation.pockets.length = 0; input.catalog.binding.selection_sha256 = 'f'.repeat(64);
  assert.equal(JSON.stringify(result), before); assert.equal(before.includes('provider-private'), false);
});

test('presentation disclosure text remains bounded rather than clipped', async () => {
  const input = structuredClone(inputs(await base));
  input.recommendation.limitations.push('é'.repeat(513)); assert.throws(() => present(input), /text/);
});

for (const effectiveDate of ['2026-09-06', '2026-09-07']) {
  test(`capture no later than effective date ${effectiveDate} preserves diagnostic-only composition`, async () => {
    const f = await decisionEvidenceFixture({ effectiveDate }), input = inputs(f);
    const result = compose({ catalog: input.catalog, expected: input.expected, retained_inputs: f.input.retained_inputs });
    assert.deepEqual(result, present(input));
    assert.equal(result.authority, 'not_established'); assert.equal(result.apply.status, 'blocked');
    assert.equal(f.input.retained_inputs.subject.effective_date, effectiveDate);
    assert.equal(f.input.retained_inputs.acquisition.capture_result.captured_at, '2026-09-06T08:00:00.123Z');
  });
}

for (const [version, fixture] of [[2, decisionEvidenceFixture], [3, saleWitnessMeaningFixture]]) {
  test(`retrospective mapping${version} composer omits recommendation without altering current observation inspection`, async () => {
    const f = await fixture({ effectiveDate: '2026-09-05' }), input = inputs(f);
    const before = JSON.stringify({ retained: f.input.retained_inputs, ...input });
    const observation = present(input);
    assert.equal(compose({ catalog: input.catalog, expected: input.expected, retained_inputs: f.input.retained_inputs }), null);
    assert.equal(JSON.stringify({ retained: f.input.retained_inputs, ...input }), before);
    assert.deepEqual(present(input), observation);
    assert.equal(observation.authority, 'not_established'); assert.equal(observation.apply.status, 'blocked');
    assert.equal(input.catalog.catalog_complete, true);
  });
}

test('catalog admission still precedes retrospective omission and missing retained dates cannot enable recommendations', async () => {
  const f = await base, input = inputs(f);
  assert.throws(() => compose({ ...input, catalog: { ...input.catalog, authority: 'established' },
    retained_inputs: f.input.retained_inputs }), /catalog/);
  assert.throws(() => compose({ catalog: input.catalog, expected: input.expected, retained_inputs: null }));
});

test('actual public-only byte collapse preserves the entire synthetic roster and skips rebuilding named recommendations', async () => {
  // Capacity-only synthetic catalog based on real builder output, NOT a claim
  // that the query fixture/native PostgreSQL captured these 37,500 accounts.
  const f = await base, internal = structuredClone(f.catalog), template = internal.pockets[0];
  const roster = Array.from({ length: 37_500 }, (_, i) => `${String(i).padStart(6, '0')}${'a'.repeat(94)}`);
  internal.pockets = Array.from({ length: 128 }, (_, i) => {
    const account_ids = roster.filter((_id, index) => index % 128 === i);
    return { ...template, id: `recorded-cad:${String(i).padStart(64, '0')}`, label: 'L'.repeat(512), county: 'C'.repeat(512),
      account_ids, member_count: account_ids.length };
  });
  internal.discovered_group_count = 128;
  Object.assign(internal.coverage, { discovery_member_count: roster.length, stock_member_count: roster.length, assigned_account_count: roster.length });
  internal.subject_membership.account_id = roster[0];
  assert.equal(internal.catalog_complete, true);
  const expected = { context_ref: f.input.expected.context_ref, selection_revision: f.preview.selection_revision };
  const catalog = presentCustomCohortPocketCatalog({ catalog: internal, preview: f.preview, expected });
  assert.equal(catalog.catalog_complete, false); assert.deepEqual(catalog.reasons, ['catalog_response_byte_limit']);
  assert.deepEqual(catalog.unassigned.account_ids, roster); assert.equal(catalog.unassigned.member_count, roster.length);
  assert.deepEqual(catalog.pockets, []); assert.equal(catalog.presentation.membership_complete, true);
  // Null retained input would fail immediately if the production helper tried
  // to run the kernel despite the public catalog's incomplete disposition.
  assert.equal(compose({ catalog, expected, retained_inputs: null }), null);
  assert.ok(Buffer.byteLength(JSON.stringify(catalog)) <= 3_990_000);
});
