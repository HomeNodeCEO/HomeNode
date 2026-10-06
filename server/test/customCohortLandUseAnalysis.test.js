import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExplorationLandUse, createCustomCohortLandUseAnalysis, EXPLORATION_LAND_USE_SQL } from '../src/services/neighborhoodAssessment/customCohortLandUseAnalysis.js';

const binding = { context_ref: { context_id: 'context' }, selection_revision: 3, selection_sha256: 'a'.repeat(64) };
const body = { context_ref: binding.context_ref, selection: {}, selection_sha256: binding.selection_sha256 };
const options = { signal: new AbortController().signal };
const pool = query => ({ connect: async () => ({ release() {}, query: async (sql, values) => values ? query(sql, values) : { rows: [] } }) });
const row = () => ({ selected_parcel_count: 2, selected_mapped_account_count: 2, neighbor_parcel_count: 1,
  parcel_count: 3, area_sqm: 1000, built_up_sqm: 800, source_updated_at: '2026-10-01',
  categories: [{ category: 'one_unit', area_sqm: 700, parcel_count: 2, review_count: 0 }, { category: 'commercial', area_sqm: 300, parcel_count: 1, review_count: 0 }] });

test('stored parcel land use uses indexed one-ring edge adjacency, excludes personal-property records, and never requests remote GIS', async () => {
  let queries = 0;
  const result = await buildExplorationLandUse(pool(async (sql, values) => {
    queries++; assert.equal(sql, EXPLORATION_LAND_USE_SQL); assert.deepEqual(values[0], ['A', 'B']);
    assert.match(sql, /neighbor.geom && selected.geom/); assert.match(sql, /ST_Relate\(neighbor.geom, selected.geom, 'F\*\*\*1\*\*\*\*'\)/);
    assert.match(sql, /other_vacant' AND classification_confidence IS DISTINCT FROM 'high'[\s\S]*THEN NULL/);
    assert.doesNotMatch(sql, /WITH RECURSIVE|ST_Buffer|INSERT|UPDATE|DELETE/);
    return { rows: [row()] };
  }), ['A', 'B']);
  assert.equal(queries, 1); assert.equal(result.categories[0].percent, 70); assert.equal(result.categories[3].percent, 30);
  assert.equal(result.neighbor_parcel_count, 1); assert.equal(result.built_up_band, 'over_75');
});
test('unknown classifications and missing geometry are flagged rather than filled with invented Other', async () => {
  const data = row(); data.selected_mapped_account_count = 1; data.categories[1].category = null;
  const result = await buildExplorationLandUse(pool(async () => ({ rows: [data] })), ['A', 'B']);
  assert.equal(result.unknown_percent, 30); assert.equal(result.categories[4].percent, 0);
  assert.equal(result.missing_selected_accounts, 1); assert.equal(result.warnings.length, 3);
});
test('empty, oversized, overlapping or absent land-use sources cannot become complete output', async () => {
  for (const change of [{ selected_parcel_count: 0 }, { parcel_count: 100001 }, { area_sqm: null }, { area_sqm: 500 }]) {
    await assert.rejects(buildExplorationLandUse(pool(async () => ({ rows: [{ ...row(), ...change }] })), ['A', 'B']), /source_incomplete/);
  }
  await assert.rejects(buildExplorationLandUse(null, []), /invalid_selection/);
});
test('authorization is rechecked even when the numeric execution gate returns a cached result', async () => {
  let checks = 0, builds = 0;
  const service = createCustomCohortLandUseAnalysis({ pool: {}, cohortService: { authorizeMarketSelection: async () => {
    checks++; return { target: { file: 7 }, binding, accountIds: ['A', 'B'] };
  } }, build: async () => { builds++; return { result: 'fixture' }; }, run: async (_key, work) => work() });
  const result = await service({}, body, options);
  assert.equal(checks, 2); assert.equal(builds, 1); assert.deepEqual(result.exploration_binding, binding);
  await assert.rejects(service({}, { ...body, selection_sha256: 'b'.repeat(64) }, options), /operation_conflict/);
});
test('selection changes during calculation are rejected before publishing', async () => {
  let checks = 0;
  const service = createCustomCohortLandUseAnalysis({ pool: {}, cohortService: { authorizeMarketSelection: async () => ({
    binding: ++checks === 1 ? binding : { ...binding, selection_revision: 4 }, accountIds: ['A'], target: {},
  }) }, build: async () => ({}), run: async (_key, work) => work() });
  await assert.rejects(service({}, body, options), /operation_conflict/);
});

test('geometry calculation uses a read-only server deadline and releases its connection after a timeout', async () => {
  const calls = []; let released = false;
  const client = { release() { released = true; }, async query(sql) {
    calls.push(sql); if (sql === EXPLORATION_LAND_USE_SQL) throw Object.assign(new Error('cancelled fixture'), { code: '57014' });
    return { rows: [] };
  } };
  await assert.rejects(buildExplorationLandUse({ connect: async () => client }, ['A']), error => error.code === '57014');
  assert.equal(calls[0], 'BEGIN READ ONLY'); assert.match(calls[1], /statement_timeout='50000ms'/);
  assert.equal(calls.at(-1), 'ROLLBACK'); assert.equal(released, true);
});
