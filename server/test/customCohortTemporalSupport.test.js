import test from 'node:test';
import assert from 'node:assert/strict';
import { customCohortCurrentStockSupport as support } from '../src/services/neighborhoodAssessment/customCohortTemporalSupport.js';

test('later current stock cannot establish the retrospective neighborhood', () => {
  assert.deepEqual(support({ effective_date: '2024-06-30', retained_capture_at: '2026-09-06T08:00:00.123Z' }), {
    status: 'historical_stock_evidence_required', effective_date: '2024-06-30',
    retained_capture_at: '2026-09-06T08:00:00.123Z', stock_basis: 'current_mirror', historical_coverage: 'not_established',
  });
});

test('capture-day comparison uses explicit UTC, including midnight and leap day', () => {
  for (const [effective_date, retained_capture_at, status] of [
    ['2024-02-29', '2024-02-29T23:59:59.999Z', 'not_established'],
    ['2024-02-29', '2024-03-01T00:00:00.000Z', 'historical_stock_evidence_required'],
    ['2026-09-05', '2026-09-06T00:00:00.000Z', 'historical_stock_evidence_required'],
    ['2026-09-06', '2026-09-06T00:00:00.000Z', 'not_established'],
  ]) assert.equal(support({ effective_date, retained_capture_at }).status, status);
});

test('earlier/same-day capture never asserts historical validity or report readiness', () => {
  for (const effective_date of ['2024-06-30', '2026-09-06']) {
    const result = support({ effective_date, retained_capture_at: '2024-06-30T08:00:00.123Z' });
    assert.equal(result.status, 'not_established');
    assert.equal(result.historical_coverage, 'not_established');
    assert.equal(Object.hasOwn(result, 'valid_from'), false);
    assert.equal(Object.hasOwn(result, 'apply'), false);
    assert.ok(Object.isFrozen(result));
  }
});

test('reopen uses the retained instant, not wall clock or import/review dates', () => {
  const input = { effective_date: '2024-06-30', retained_capture_at: '2024-06-30T08:00:00.123Z' };
  const originalNow = Date.now;
  try {
    Date.now = () => { throw new Error('must not use wall clock'); };
    assert.deepEqual(support(input), support({ ...input, csv_imported_at: '2026-09-09', reviewed_at: '2026-09-09' }));
  } finally { Date.now = originalNow; }
});

test('invalid or ambiguous dates fail closed, without local-time coercion', () => {
  for (const retained_capture_at of [null, '', '2026-09-06', '2026-09-06T08:00:00.123',
    '2026-09-06T08:00:00.123-05:00', '2026-02-30T08:00:00.123Z', '2026-09-06T24:00:00.000Z']) {
    assert.throws(() => support({ effective_date: '2024-06-30', retained_capture_at }), /invalid_capture_time/);
  }
  for (const effective_date of [null, '', '2023-02-29', '2024-06-30T00:00:00Z']) {
    assert.throws(() => support({ effective_date, retained_capture_at: '2026-09-06T08:00:00.123Z' }));
  }
});
