import assert from 'node:assert/strict';
import test from 'node:test';
import { customCaptureDiagnostic } from '../src/services/neighborhoodAssessment/customCaptureDiagnostics.js';

const failure = (detail, extra = {}) => Object.assign(new Error('private SQL and source text'), {
  code: 'CUSTOM_COHORT_CAPTURE_FAILED', reason: 'source_incomplete', detail, ...extra,
});
test('capture diagnostics retain only enumerated phases/checks and nonnegative integer counters', () => {
  assert.deepEqual(customCaptureDiagnostic(failure(['byte_limit'], { capture_counts: {
    records: 123, bytes: 30000001, queries: 15, accounts: -1, parcels: NaN,
    source_records: 1.5, identity_records: Infinity, account_id: 'PRIVATE', filename: 'PRIVATE',
  } })), { stage: 'source', category: 'capacity', checks: ['byte_limit'],
    counts: { queries: 15, records: 123, bytes: 30000001 } });
});
for (const [reason, stage] of [['spatial_incomplete', 'spatial'], ['selector_incomplete', 'selector'],
  ['transaction_identity_incomplete', 'transaction_identity'], ['source_incomplete', 'source']]) {
  test(`capture diagnostics classify ${stage} without exposing its input`, () => {
    assert.deepEqual(customCaptureDiagnostic(failure('duration_limit', { reason })), {
      stage, category: 'interrupted', checks: ['duration_limit'], counts: {},
    });
  });
}
test('mixed, unknown and overlong check lists cannot be relabeled as capacity-only failures', () => {
  for (const detail of [['byte_limit', 'PRIVATE'], [], Array(17).fill('byte_limit'), { private: 'data' }]) {
    const diagnostic = customCaptureDiagnostic(failure(detail));
    assert.equal(diagnostic.category, 'unavailable');
    assert.ok(!JSON.stringify(diagnostic).includes('PRIVATE'));
    assert.ok(JSON.stringify(diagnostic).length < 600);
  }
});
test('unknown errors and non-capture owner failures do not produce diagnostics', () => {
  for (const error of [null, new Error('password'), { reason: 'source_incomplete' },
    failure('byte_limit', { reason: 'market_data_access_denied' })]) {
    assert.equal(customCaptureDiagnostic(error), null);
  }
});
