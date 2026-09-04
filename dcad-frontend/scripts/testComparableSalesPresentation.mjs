import assert from 'node:assert/strict';
import test from 'node:test';

import {
  booleanValue,
  calculateLivingAreaGroupedAdjustment,
  calculatePoolGroupedAdjustment,
  compactComparableSlots,
  finiteNumber,
  garageSpacesFromArea,
  monthsBeforeDate,
  normalizeConstructionType,
  swapArrayItems,
} from '../src/lib/comparableSalesPresentation.ts';

test('array helpers preserve the established comparable-slot behavior', () => {
  assert.deepEqual(swapArrayItems(['a', 'b', 'c'], 0, 2), ['c', 'b', 'a']);
  assert.deepEqual(
    compactComparableSlots(['a', 'b', 'c', 'd', 'e', 'f'], [1, 4], () => ''),
    ['b', 'e', '', '', '', ''],
  );
});

test('date periods clamp safely at the end of shorter months', () => {
  assert.equal(monthsBeforeDate('2026-03-31', 12), '2025-03-31');
  assert.equal(monthsBeforeDate('2026-03-31', 24), '2024-03-31');
  assert.equal(monthsBeforeDate('not-a-date', 12), '');
});

test('property value normalization retains existing grid semantics', () => {
  assert.equal(finiteNumber('$1,234.50'), 1234.5);
  assert.equal(finiteNumber(''), null);
  assert.equal(booleanValue('YES'), true);
  assert.equal(booleanValue('none'), false);
  assert.equal(booleanValue('unknown'), null);
  assert.equal(garageSpacesFromArea(450), 2);
  assert.equal(garageSpacesFromArea(0), null);
  assert.equal(normalizeConstructionType('1.5', ''), '1 Story');
  assert.equal(normalizeConstructionType('ONE AND ONE HALF STORIES', ''), '2 Story');
  assert.equal(normalizeConstructionType('', 'Two Story Traditional'), '2 Story');
  assert.equal(normalizeConstructionType(null, null), '');
});

test('grouped adjustment direction and rounding remain unchanged', () => {
  const adjustments = [
    { dimensionKey: 'pool', amount: 15_000 },
    { dimensionKey: 'living_area', amount: 62 },
  ];
  assert.equal(calculatePoolGroupedAdjustment(adjustments, true, false), 15_000);
  assert.equal(calculatePoolGroupedAdjustment(adjustments, false, true), -15_000);
  assert.equal(calculatePoolGroupedAdjustment(adjustments, true, true), 0);
  assert.equal(calculateLivingAreaGroupedAdjustment(adjustments, 1_500, 1_183), 19_700);
  assert.equal(calculateLivingAreaGroupedAdjustment(adjustments, 1_183, 1_500), -19_700);
});
