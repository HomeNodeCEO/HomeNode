import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendationFixture } from './fixtures/customCohortDenseRecommendationFixture.js';
import { cadEvidenceFixture } from './fixtures/customCohortCadEvidenceFixture.js';
import { buildCustomCohortPocketRecommendation as build, buildCustomCohortPocketRecommendationBatched as batched } from '../src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { buildCustomCohortIndexedObservationPreview as indexed } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCustomCohortPocketCatalog, presentCustomCohortPocketCatalog } from '../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { buildCustomCohortPocketRecommendationPresentation as compose, buildCustomCohortPocketRecommendationPresentationBatched as composeBatched } from '../src/services/neighborhoodAssessment/customCohortPocketRecommendationPresentation.js';

function denseFixture(groups, members = groups) {
  const accounts = Array.from({ length: members }, (_, i) => `A${String(i).padStart(5, '0')}`);
  return recommendationFixture({ accounts, subject: accounts[0], names: Object.fromEntries(accounts.map((id, i) => [id, `Synthetic ${i % groups}`])) });
}
function composition(args) {
  const preview = indexed({ ...args, selection: { revision: args.selection.revision, pockets: [] } });
  const expected = { context_ref: args.context_ref, selection_revision: args.selection.revision };
  const catalog = presentCustomCohortPocketCatalog({ preview, expected,
    catalog: buildCustomCohortPocketCatalog({ retained_inputs: args.retained_inputs, preview, catalog_version: 2 }) });
  return { catalog, expected, retained_inputs: args.retained_inputs, observation_preview: preview };
}

test('indexed dense kernel preserves every legacy score, rank, missing factor and selected union', () => {
  const f = denseFixture(3, 8), before = JSON.stringify(f);
  const old = build(f), dense = build({ ...f, catalog_version: 2 });
  assert.deepEqual({ ...dense, recommendation_version: 1 }, old);
  assert.equal(JSON.stringify(f), before);
  const ids = dense.pockets.map(p => p.id);
  for (const selected of [[], ids, [ids.at(-1)]]) {
    const choice = { revision: 2, included_recorded_group_ids: selected };
    assert.deepEqual({ ...build({ ...f, selection: choice, catalog_version: 2 }), recommendation_version: 1 }, build({ ...f, selection: choice }));
  }
});

for (const groups of [887, 1024]) test(`all ${groups} groups are scored, projected and bound without a prefix`, async () => {
  const f = denseFixture(groups, groups * 2 + 1), before = JSON.stringify(f);
  const args = composition(f), result = await composeBatched(args);
  assert.equal(result.presentation_version, 2); assert.equal(result.recommendation_version, 2);
  assert.equal(result.pockets.length, groups);
  assert.equal(result.all.member_count, groups * 2 + 1);
  assert.equal(result.pockets.reduce((n, p) => n + p.member_count, 0), result.all.member_count);
  assert.deepEqual([...result.pockets.map(p => p.id)].sort(), args.catalog.pockets.map(p => p.id).sort());
  assert.equal(result.recommended_recorded_group_ids.length, groups);
  assert.equal(new Set(result.pockets.map(p => p.review_rank)).size, groups);
  assert.deepEqual(result.binding, args.catalog.binding);
  assert.equal(result.apply.status, 'blocked'); assert.equal(result.authority, 'not_established');
  assert.deepEqual(result, compose(args));
  assert.equal(JSON.stringify(f), before);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 2_500_000);
  assert.equal(JSON.stringify(result).includes('"account_ids"'), false);
});

test('catalog overflow and byte exhaustion omit the entire recommendation, not groups or observations', () => {
  const f = denseFixture(1025), args = composition(f);
  assert.equal(args.catalog.catalog_complete, false); assert.equal(args.catalog.unassigned.member_count, 1025);
  assert.equal(compose(args), null);
  const valid = composition(denseFixture(887));
  assert.equal(compose({ ...valid, maximumBytes: 100 }), null);
  assert.equal(valid.catalog.pockets.length, 887);
  assert.equal(valid.observation_preview.all.stock.member_count, 887);
});

test('dense kernel keeps explicit empty intent and rejects foreign context, unknown IDs and unowned indexed copies', () => {
  const f = denseFixture(887), args = composition(f);
  const input = { ...f, catalog_version: 2, observation_preview: args.observation_preview };
  assert.equal(build(input).selected.member_count, 0);
  assert.throws(() => build({ ...input, selection: { revision: 1, included_recorded_group_ids: [`recorded-cad:${'d'.repeat(64)}`] } }), /unknown_group_id/);
  assert.throws(() => build({ ...input, context_ref: { ...f.context_ref, context_sha256: 'd'.repeat(64) } }), /preview_binding/);
  assert.throws(() => build({ ...input, observation_preview: structuredClone(args.observation_preview) }), /preview_binding/);
  assert.throws(() => build({ ...input, selection: { revision: 2, included_recorded_group_ids: [] } }), /preview_binding/);
});

test('cooperative scoring yields to ordinary event-loop work and honors cancellation without partial output', async () => {
  const f = denseFixture(887, 4000), args = { ...f, catalog_version: 2, observation_preview: composition(f).observation_preview };
  let ordinaryWork = 0, checks = 0;
  const timer = setInterval(() => ordinaryWork++, 1);
  try {
    assert.deepEqual(await batched(args, { checkBudget: () => checks++ }), build(args));
    assert.ok(checks > 30); assert.ok(ordinaryWork > 0);
    let cancelled = 0;
    await assert.rejects(batched(args, { checkBudget() { if (++cancelled === 5) throw new Error('synthetic_cancel'); } }), /synthetic_cancel/);
    assert.equal(cancelled, 5);
  } finally { clearInterval(timer); }
});

test('mapping4 housing and CAD literal baselines have exact indexed/legacy result parity', async () => {
  const f = await cadEvidenceFixture(), input = { context_ref: f.input.expected.context_ref,
    retained_inputs: f.input.retained_inputs, selection: { revision: 7, included_recorded_group_ids: [] } };
  const old = build(input), dense = await batched({ ...input, catalog_version: 2 });
  assert.ok(dense.recorded_housing); assert.ok(dense.cad_recorded_evidence);
  assert.deepEqual({ ...dense, recommendation_version: 1 }, old);
});

test('large current captures cannot become retrospective recommendations', async () => {
  const f = denseFixture(887); f.retained_inputs.subject.effective_date = '2026-09-05';
  const args = composition(f);
  assert.equal(await composeBatched(args), null);
  assert.equal(args.catalog.pockets.length, 887);
});

test('dense mapping4 housing and literal evidence include unknown accounts without redistributing their weights', async () => {
  const accounts = Array.from({ length: 1774 }, (_, i) => `A${String(i).padStart(5, '0')}`);
  const f = recommendationFixture({ accounts, subject: accounts[0], mapping4: true,
    names: Object.fromEntries(accounts.map((id, i) => [id, `Group ${i % 887}`])),
    parcels: accounts.map((account_id, i) => ({ object_id: String(i + 1), account_id,
      residential_area_sqft: i % 2 ? null : '1800', residential_year_built: 2000, parcel_area_sqft: '6000',
      class_code: i % 3 ? 'A11' : null })) });
  const args = composition(f), result = await composeBatched(args);
  assert.equal(result.pockets.length, 887);
  assert.equal(result.recorded_housing.coverage.account_count, 1774);
  assert.equal(result.recorded_housing.coverage.unknown_count, 592);
  assert.equal(result.all.factor_coverage.gla.unknown_count, 887);
  assert.equal(result.all.factor_coverage.housing_type.unknown_count, 1774, 'unknown subject is not replaced by the neighborhood majority');
  assert.equal(result.cad_recorded_evidence.status, 'details_unavailable');
  assert.equal(result.cad_recorded_evidence.pocket_count, 887);
  assert.equal(result.cad_recorded_evidence.member_count, 1774);
  assert.equal(result.recommended_recorded_group_ids.length, 0);
});
