import assert from 'node:assert/strict';
import test from 'node:test';

import { customWorkspaceDefaultObservationPeriod } from '../src/features/neighborhood/customWorkspaceDefaultPeriod.ts';

test('defaults the neighborhood capture to an inclusive 24-month effective-date window', () => {
  assert.deepEqual(customWorkspaceDefaultObservationPeriod('2026-08-31'), {
    start_date: '2024-09-01',
    end_date: '2026-08-31',
  });
});

test('clamps leap-day subtraction before advancing to the inclusive first day', () => {
  assert.deepEqual(customWorkspaceDefaultObservationPeriod('2024-02-29', 12), {
    start_date: '2023-03-01',
    end_date: '2024-02-29',
  });
});

test('refuses malformed dates and unsafe periods', () => {
  assert.equal(customWorkspaceDefaultObservationPeriod('2026-02-30'), null);
  assert.equal(customWorkspaceDefaultObservationPeriod('', 24), null);
  assert.equal(customWorkspaceDefaultObservationPeriod('2026-08-31', 0), null);
});
