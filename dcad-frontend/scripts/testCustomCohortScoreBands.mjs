import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';

const { customCohortScoreBands } = loadTrustedRepositoryCommonJs(
  new URL('../src/features/neighborhood/customCohortScoreBands.ts', import.meta.url),
  name => {
    assert.match(name, /customCohortPocketCatalog(?:\.ts)?$/);
    return { CUSTOM_COHORT_UNASSIGNED_GROUP: 'discovery:unassigned' };
  },
);
const pocket = (id, lower, member_count = 1) => ({ id, member_count, similarity: { lower } });
const recommendation = pockets => ({ status: 'recommendation_for_review', pockets });

test('nonoverlapping bands partition checked conservative group lower bounds, including endpoints', () => {
  const bands = customCohortScoreBands(recommendation([
    pocket('100', 100, 2), pocket('90', 90, 3), pocket('89.9', 89.9, 5),
    pocket('80', 80, 7), pocket('0', 0, 11), pocket('unknown', null, 13),
    pocket('negative', -1), pocket('overflow', 100.1), pocket('nan', Number.NaN),
    pocket('discovery:unassigned', 95, 17), pocket('empty', 96, 0),
  ]));
  assert.equal(bands.length, 10);
  assert.equal(bands[0].label, '90–100');
  assert.deepEqual(bands[0].recorded_group_ids, ['100', '90']);
  assert.equal(bands[0].account_count, 5);
  assert.equal(bands[1].label, '80–<90');
  assert.deepEqual(bands[1].recorded_group_ids, ['89.9', '80']);
  assert.equal(bands[1].account_count, 12);
  assert.deepEqual(bands[9].recorded_group_ids, ['0']);
  assert.equal(bands[9].account_count, 11);
  assert.equal(bands.reduce((count, band) => count + band.recorded_group_ids.length, 0), 5);
});

test('missing or insufficient recommendation does not invent score ranges', () => {
  assert.deepEqual(customCohortScoreBands(null), []);
  assert.deepEqual(customCohortScoreBands({ status: 'insufficient_observations', pockets: [pocket('a', 95)] }), []);
});

test('manual bands use the same retained display scores as the map without enabling auto ranking', () => {
  const map = { version: 2, groups: [
    { id: 'a', member_count: 12, supported_member_count: 12, lower: 85 },
    { id: 'unknown', member_count: 3, supported_member_count: 0, lower: 0 },
    { id: 'discovery:unassigned', member_count: 1, supported_member_count: 1, lower: 95 },
  ] };
  const bands = customCohortScoreBands(null, map);
  assert.deepEqual(bands[1].recorded_group_ids, ['a']);
  assert.equal(bands[1].account_count, 12);
  assert.equal(bands.reduce((n, b) => n + b.recorded_group_ids.length, 0), 1);
  assert.deepEqual(customCohortScoreBands(null, { ...map, version: 1 }), []);
  const overlay = { version: 1, groups: [{ id: 'a', member_count: 12, supported_member_count: 12, lower: 75 }] };
  assert.deepEqual(customCohortScoreBands(recommendation([pocket('a', 85, 12)]), overlay)[2].recorded_group_ids, ['a']);
});
