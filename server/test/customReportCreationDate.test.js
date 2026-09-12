import assert from 'node:assert/strict';
import test from 'node:test';
import { createReportFile } from '../src/modules/mobile/reportFiles.js';
import { normalizeOptionalAppraisalDate } from '../src/services/appraisalHistory.js';

const organizationId = '11111111-1111-4111-8111-111111111111';
const auth = { userId: '22222222-2222-4222-8222-222222222222',
  organizations: [{ organizationId, roles: ['appraiser'] }] };
const input = { organization_id: organizationId, account_id: 'SYNTHETIC',
  workflow_type: 'custom_appraisal', client_request_id: '33333333-3333-4333-8333-333333333333' };

test('Custom creation rejects malformed or impossible effective dates before a database connection', async () => {
  const pool = { connect() { assert.fail('invalid dates must not allocate or mutate a file'); } };
  for (const effective_date of ['2026-02-29', '2026-13-01', '09/12/2026', '2026-09-12T00:00:00Z', {}, 'not a date']) {
    await assert.rejects(createReportFile(pool, auth, { ...input, effective_date }), /invalid_effective_date/);
  }
});

test('optional dates preserve explicit retrospective days and do not infer today', () => {
  for (const empty of [undefined, null, '']) assert.equal(normalizeOptionalAppraisalDate(empty, 'invalid'), null);
  assert.equal(normalizeOptionalAppraisalDate('2024-02-29', 'invalid'), '2024-02-29');
});

test('legacy Custom and other workflow callers retain their existing creation path', async () => {
  const stop = new Error('synthetic connection boundary');
  const pool = { connect() { throw stop; } };
  for (const extra of [{}, { effective_date: '2026-09-12' },
    { workflow_type: 'uad_3_6', effective_date: 'ignored as before' },
    { workflow_type: 'property_tax_protest', effective_date: 'ignored as before' }]) {
    await assert.rejects(createReportFile(pool, auth, { ...input, ...extra }), error => error === stop);
  }
});
