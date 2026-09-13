import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCustomCohortReportedAssessment as legacy,
  buildCustomCohortReportedAssessmentBatched as legacyBatched,
  buildCustomCohortReportedAssessmentWitnessV2 as witness,
  buildCustomCohortReportedAssessmentWitnessV2Batched as witnessBatched } from '../src/services/neighborhoodAssessment/customCohortReportedAssessment.js';
import { buildCustomCohortIndexedObservationPreview as preview,
  customCohortIndexedObservationPreviewBatches as previewBatches } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { assessmentEvidenceDigest as digest } from '../src/services/neighborhoodAssessment/contract.js';
import { customCohortSelectionCatalogBatches } from '../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { customCohortReportedAssessmentFixture } from './fixtures/customCohortReportedAssessmentFixture.js';
import { cadEvidenceFixture } from './fixtures/customCohortCadEvidenceFixture.js';

// Both branches acquire real synthetic originals. The mapping5 branch reuses
// only the base fixture's admitted geography after proving the exact retained
// subject is identical; no saved source graph or interpretation is relabeled.
async function fixture(useWitness, options = {}) {
  const base = await customCohortReportedAssessmentFixture({ effectiveDate: '2026-09-06', ...options });
  if (!useWitness) return base.input;
  const capture = await cadEvidenceFixture({ assignmentFileId: '41', mappingVersion: 5,
    effectiveDate: options.effectiveDate ?? '2026-09-06', rawPayload: { MlsStatus: 'Closed', CloseDate: '2024-03-01',
      ClosePrice: '280000', ClosePriceCurrency: 'USD', LivingArea: '1800', LivingAreaUnits: 'Square Feet',
      LotSizeArea: '0.25', LotSizeUnits: 'Acres' } });
  assert.deepEqual(capture.input.retained_inputs.subject, base.input.retained_inputs.subject);
  return { ...base.input, context_ref: capture.input.expected.context_ref, retained_inputs: capture.input.retained_inputs,
    selection: { revision: 1, included_recorded_group_ids: options.emptySelection ? [] : [
      ...capture.catalog.pockets.map(p => p.id), ...(capture.catalog.unassigned.member_count ? ['discovery:unassigned'] : [])] } };
}
function drain(iterator) {
  let yields = 0;
  while (true) {
    const step = iterator.next();
    if (step.done) return { result: step.value, yields };
    assert.equal(step.value, undefined, 'No partially built result escapes a nested kernel');
    yields++;
  }
}
function mutableInput(input) {
  return { ...structuredClone(input), report_geography: input.report_geography };
}

// Captured from the unchanged synchronous implementation before scheduling
// edits. This pins the complete assessment, publication evidence and candidate,
// rather than merely comparing two newly changed execution paths to each other.
for (const [name, useWitness, build, batched, readyHash, emptyHash] of [
  ['legacy', false, legacy, legacyBatched,
    '65b4101eac35ff3ec88174c7f1e35260fb35e661011d64811ff9cd2561aed18c',
    'b1731ce762f4b83180a727b58269607615c2c7d1e567ad9d3ac50c582b7c0b74'],
  ['witness2', true, witness, witnessBatched,
    'caea9449fca2b70dfec5adfaf035ff2c43535ad07bd986f48ac839c59ae4eac5',
    '1bb6c4ff71c2e6a75070770d5162ae45817803c567c7af044fa78782127d861a'],
]) {
  test(`${name} nested scheduling preserves pre-change complete report hashes including explicit empty selection`, async () => {
    for (const [emptySelection, expectedHash] of [[false, readyHash], [true, emptyHash]]) {
      const input = await fixture(useWitness, { emptySelection }), before = JSON.stringify(input);
      const sync = build(input), cooperative = await batched(input);
      assert.equal(sync.status, 'ready'); assert.equal(digest(sync), expectedHash);
      assert.equal(digest(cooperative), expectedHash); assert.deepEqual(cooperative, sync);
      assert.equal(JSON.stringify(input), before);
    }
  });

  test(`${name} budget cancellation is serviced inside each delegated preview and leaves no reusable partial report`, async () => {
    const input = await fixture(useWitness), before = JSON.stringify(input), expected = build(input);
    const args = { context_ref: input.context_ref, retained_inputs: input.retained_inputs,
      selection: { revision: input.selection.revision, pockets: [] } };
    const discovery = drain(previewBatches(args));
    const catalog = drain(customCohortSelectionCatalogBatches({ retained_inputs: input.retained_inputs,
      preview: discovery.result, catalog_version: input.catalog_version ?? 1 }));
    assert.ok(discovery.yields >= 2);
    // Two initial seal checks; each yielded report step has pre/post checks.
    // Discovery contributes N steps and its existing explicit yield; the
    // catalog contributes its exact checkpoints plus the new startup boundary.
    // These post-next checks therefore suspend inside the FIRST and SECOND
    // preview respectively, without production hooks or kernel replacements.
    for (const stop of [4, 2 * (discovery.yields + catalog.yields + 1) + 6]) {
      const controller = new AbortController(), cancelled = new Error(`cancel-${name}-${stop}`);
      let checks = 0, serviced = false;
      await assert.rejects(batched(input, { check() {
        checks++;
        controller.signal.throwIfAborted();
        if (checks === stop) setImmediate(() => { serviced = true; controller.abort(cancelled); });
      } }), error => error === cancelled);
      assert.equal(serviced, true); assert.equal(checks, stop + 1);
      assert.equal(JSON.stringify(input), before);
    }
    assert.deepEqual(await batched(input), expected);
  });

  test(`${name} deep sealing precedes the first nested suspension even for a shallow-frozen caller`, async () => {
    const input = await fixture(useWitness), owned = mutableInput(input), expected = build(input);
    Object.freeze(owned);
    const pending = batched(owned);
    assert.ok(Object.isFrozen(owned.retained_inputs.subject.target));
    assert.ok(Object.isFrozen(owned.selection.included_recorded_group_ids));
    assert.throws(() => owned.selection.included_recorded_group_ids.pop(), TypeError);
    assert.throws(() => { owned.retained_inputs.subject.target.account_id = 'foreign'; }, TypeError);
    assert.deepEqual(await pending, expected);
  });

  test(`${name} historical and malformed-input outcomes retain synchronous/cooperative parity`, async () => {
    const historical = await fixture(useWitness, { effectiveDate: '2024-07-01' });
    const expected = build(historical);
    assert.equal(expected.status, 'incomplete');
    assert.deepEqual(expected.issues, [{ code: 'historical_stock_evidence_required' }]);
    assert.deepEqual(await batched(historical), expected);
    const input = await fixture(useWitness);
    for (const mutate of [
      value => { value.selection.included_recorded_group_ids = ['missing-pocket']; },
      value => { value.selection.included_recorded_group_ids.push(value.selection.included_recorded_group_ids[0]); },
      value => { value.retained_inputs.acquisition.capture_result.query_complete = false; },
      value => { value.target.scope.account_id = 'foreign'; },
    ]) {
      const malformed = mutableInput(input); mutate(malformed);
      let error;
      assert.throws(() => build(malformed), value => { error = value; return true; });
      await assert.rejects(batched(malformed), value => value.constructor === error.constructor
        && value.message === error.message && value.code === error.code && value.reason === error.reason);
    }
  });
}

test('the indexed bridge retains complete 260-account observations and closes without yielding a partial result', async () => {
  const input = await fixture(false, { catalogVersion: 2,
    recordedLabels: Array.from({ length: 260 }, (_, i) => `Scheduling original ${i}`) });
  const args = { context_ref: input.context_ref, retained_inputs: input.retained_inputs,
    selection: { revision: input.selection.revision, pockets: [] } }, before = JSON.stringify(args);
  const expected = preview(args), completed = drain(previewBatches(args));
  assert.deepEqual(completed.result, expected); assert.equal(completed.result.all.stock.member_count, 260);
  assert.ok(completed.yields >= 8, 'Per-record batches remain visible to the owner');
  const cancelled = previewBatches(args);
  assert.deepEqual(cancelled.next(), { value: undefined, done: false });
  assert.deepEqual(cancelled.return(), { value: undefined, done: true });
  assert.deepEqual(cancelled.next(), { value: undefined, done: true });
  assert.equal(JSON.stringify(args), before);
});
