import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildCustomCohortReportedAssessment } from '../src/services/neighborhoodAssessment/customCohortReportedAssessment.js';
import { customCohortReportedAssessmentFixture } from './fixtures/customCohortReportedAssessmentFixture.js';

// Captured from the unchanged expanded-v1 implementation at c567341c1e.
// Each original synthetic fixture was built twice to prove deterministic output.
// These cover the COMPLETE result: assessment, evidence/publication members,
// candidate five-part suggestions and bindings, not just rounded statistics.
const cases = [
  ['all-shared', {}, '31354cad0e202c0003cb7622be5c4d67a60f51abb445214a7a52c3235f1dfc09'],
  ['empty', { emptySelection: true, privateRows: [{}] }, '05af6f7f9a886e9ce5def3aa25316a30292aec53604dc685f83c511d9330e99e'],
  ['private-decimals', { privateRows: [
    { ClosePrice: '9007199254740993.123456789012' }, { ClosePrice: '9007199254740993.123456789013' },
  ] }, '2cf97bb510a75c5589ca529c5959ac9bc5feea7ab6c5a3a6dcb22aa054043147'],
  ['private-dates', { privateRows: [{}, { CloseDate: '2027-01-01' }, { CloseDate: '' },
    { MlsStatus: 'Active' }, { CloseDate: '2020-01-01' }] }, '312eed13f5870ff8108778774aa751707b86d61c65ebb3796070cb38bbaf6a3b'],
  ['128-plus-unassigned', { recordedLabels: [
    ...Array.from({ length: 128 }, (_, i) => `Recorded Group ${String(i).padStart(3, '0')}`), null,
  ] }, '157a7e76d1279d1d200de068966dbda7c8ae95ae4932823bcd2d2b36a4c16a11'],
];
for (const [name, options, expected] of cases) test(`indexed report preserves expanded-v1 complete result: ${name}`, async () => {
  const { input } = await customCohortReportedAssessmentFixture(options);
  const before = JSON.stringify(input.retained_inputs);
  const result = buildCustomCohortReportedAssessment(input);
  assert.equal(result.status, 'ready');
  assert.equal(createHash('sha256').update(JSON.stringify(result)).digest('hex'), expected);
  assert.equal(JSON.stringify(input.retained_inputs), before, 'retained observations are not edited');
});
