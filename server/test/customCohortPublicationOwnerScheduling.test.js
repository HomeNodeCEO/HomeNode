import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { assessmentEvidenceDigest as digest } from '../src/services/neighborhoodAssessment/contract.js';
import { getCustomCohortReportedSaleWitnessV2Profile } from '../src/services/neighborhoodAssessment/customCohortReportedSaleWitnessV2.js';
import { cadEvidenceFixture } from './fixtures/customCohortCadEvidenceFixture.js';
import { reportedReplacementOwnerFixture } from './fixtures/customCohortReportedReplacementOwnerFixture.js';

const PROFILE = getCustomCohortReportedSaleWitnessV2Profile();
// Existing genuine acquisition/replay/owner/repository fixtures; SQL-result
// doubles do not establish native transaction behavior or source authority.
async function fixture(marked = false) {
  const captureFixture = await cadEvidenceFixture({ assignmentFileId: '41', effectiveDate: '2026-09-06',
    mappingVersion: marked ? 5 : 4,
    ...(marked ? { reportedSaleInterpretation: structuredClone(PROFILE.profile_ref),
      rawPayload: { MlsStatus: 'Closed', CloseDate: '2024-03-01', ClosePrice: '312345.125', ClosePriceCurrency: 'USD',
        LivingArea: '180.5', LivingAreaUnits: 'Square Meters', LotSizeArea: '0.25', LotSizeUnits: 'Acres' } } : {}) });
  return reportedReplacementOwnerFixture({ captureFixture });
}
function assertNoSavedPublication(f) {
  for (const key of ['jobs', 'operations', 'assessments', 'attachments', 'acceptances', 'histories']) assert.equal(f.state.db[key].size, 0);
  assert.equal(f.state.db.section, null);
}
function afterClaimOnNextTurn(f, action) {
  let claimed = false, scheduled = false, completed = false;
  f.state.beforeQuery = text => {
    if (text.includes('neighborhood:exact-claim')) claimed = true;
    if (claimed && !scheduled && text === 'RELEASE SAVEPOINT neighborhood_repository_owner') {
      scheduled = true;
      setImmediate().then(() => { completed = true; action(); });
    }
  };
  return () => { assert.equal(scheduled, true); assert.equal(completed, true); };
}

function phaseLogs(t) {
  const events = [];
  t.mock.method(console, 'info', (...args) => {
    assert.equal(args.length, 1); assert.equal(typeof args[0], 'string');
    const prefix = '[neighborhood] report-phase ';
    assert.ok(args[0].startsWith(prefix));
    const event = JSON.parse(args[0].slice(prefix.length));
    assert.deepEqual(Object.keys(event).sort(), ['duration_ms', 'elapsed_ms', 'outcome', 'phase']);
    for (const key of ['duration_ms', 'elapsed_ms']) assert.ok(Number.isSafeInteger(event[key]) && event[key] >= 0);
    events.push(event);
  });
  return events;
}

for (const marked of [false, true]) test(`${marked ? 'Witness2' : 'CAD4'} actual owner yields before publication, preserves profile and exact stored proposal replay`, async t => {
  const f = await fixture(marked), events = phaseLogs(t);
  const observed = afterClaimOnNextTurn(f, () => {
    assert.equal(f.state.calls.some(call => call.text.includes('neighborhood:job-head')), false,
      'an event-loop task is serviced during independent verification, before publication SQL');
  });
  const proposed = await f.service.prepareReportedObservations(f.input); observed();
  assert.equal(proposed.status, 'proposed'); assert.equal(proposed.reused, false);
  assert.deepEqual(events.map(event => [event.phase, event.outcome]),
    ['load', 'assembly', 'repository', 'publication'].map(phase => [phase, 'completed']));
  const sources = f.state.calls.filter(call => call.text.includes('/* neighborhood:source */'));
  const shared = sources.find(call => call.values[2] === 'selected-shared-source-records:observations');
  const payload = JSON.parse(shared.values[6]); assert.equal(shared.values[4], digest(payload));
  assert.equal(Object.hasOwn(payload, 'interpretation'), marked);
  if (marked) assert.deepEqual(payload.interpretation, PROFILE);
  const stored = f.state.db.assessments.get(f.state.db.head.current_revision);
  assert.equal(stored.contract_version, 2); assert.equal(stored.diagnostics.authority, 'not_established');
  const price = stored.statistics.find(statistic => statistic.id === 'selected-shared-source-records:reported_close_price:median');
  if (marked) { assert.equal(price.value, '312345.125'); assert.equal(price.unit, 'USD'); }
  else { assert.equal(price.value, null); assert.equal(price.unit, null); }
  assert.equal(f.state.reportCalls.length, 4); assert.equal(f.state.marketCalls.length, 4);
  assert.equal(f.state.commits, 2); assert.equal(f.state.db.acceptances.size, 0); assert.equal(f.state.db.histories.size, 0);
  f.state.beforeQuery = null; const start = f.state.calls.length;
  const replayed = await f.service.prepareReportedObservations(f.input);
  assert.deepEqual({ ...replayed, reused: false }, proposed);
  assert.equal(replayed.reused, true);
  assert.deepEqual(events.slice(4).map(event => [event.phase, event.outcome]), [['load', 'completed']]);
  assert.equal(f.state.calls.slice(start).some(call => /neighborhood:(enqueue|exact-claim|revision|source|members|publish) \*/.test(call.text)), false);
});

for (const reason of ['cancelled', 'deadline_exceeded']) test(`${reason} during owner publication validation rolls back the outer claim and safely retries the same unpublished operation`, async t => {
  const f = await fixture(), controller = new AbortController(), events = phaseLogs(t); let clock = 1000;
  t.mock.method(performance, 'now', () => clock);
  const observed = afterClaimOnNextTurn(f, () => {
    if (reason === 'cancelled') controller.abort(); else clock += 60_000;
  });
  await assert.rejects(f.service.prepareReportedObservations(f.input, { signal: controller.signal }),
    error => error.code === 'CUSTOM_COHORT_CAPTURE_FAILED' && error.reason === reason);
  observed(); assertNoSavedPublication(f);
  assert.deepEqual(events.map(event => [event.phase, event.outcome]),
    [['load', 'completed'], ['assembly', 'completed'], ['repository', 'failed'], ['publication', 'failed']]);
  assert.equal(f.state.commits, 1);
  assert.equal(f.state.calls.some(call => call.text.includes('neighborhood:publication-fence')), false);
  assert.equal(f.state.calls.filter(call => call.text.startsWith('SAVEPOINT ')).length, 2, 'enqueue and claim only; no publication savepoint');
  assert.equal(f.state.calls.at(-1).text, 'ROLLBACK');
  f.state.beforeQuery = null;
  const retried = await f.service.prepareReportedObservations(f.input);
  assert.equal(retried.status, 'proposed'); assert.equal(retried.reused, false);
  assert.equal(f.state.db.assessments.size, 1); assert.equal(f.state.db.acceptances.size, 0);
});

test('final source/report fences remain active after publication revalidation suspension and roll back all proposal writes', async t => {
  const f = await fixture(), events = phaseLogs(t);
  const observed = afterClaimOnNextTurn(f, () => { f.state.reportPolicy = () => ({ allowed: false }); });
  await assert.rejects(f.service.prepareReportedObservations(f.input), { reason: 'report_observation_access_denied' });
  observed(); assertNoSavedPublication(f);
  assert.ok(f.state.calls.some(call => call.text.includes('neighborhood:finish')), 'actual publication ran before final policy refusal');
  assert.equal(f.state.commits, 1); assert.equal(f.state.calls.at(-1).text, 'ROLLBACK');
  assert.deepEqual(events.map(event => [event.phase, event.outcome]),
    [['load', 'completed'], ['assembly', 'completed'], ['repository', 'completed'], ['publication', 'failed']]);
});

test('deadline after the inner publication RELEASE still belongs to outer rollback, not an invented inner cleanup', async t => {
  const f = await fixture(); phaseLogs(t); let published = false, armed = false, remaining = null, clock = 1000;
  t.mock.method(performance, 'now', () => {
    if (remaining !== null && remaining-- === 0) clock += 60_000;
    return clock;
  });
  f.state.beforeQuery = text => {
    if (text.includes('neighborhood:finish')) published = true;
    if (published && !armed && text === 'RELEASE SAVEPOINT neighborhood_repository_owner') {
      // Permit the query wrapper's post-result check, then expire at the
      // cooperative method's final check, after savepoint opened=false.
      armed = true; remaining = 1;
    }
  };
  await assert.rejects(f.service.prepareReportedObservations(f.input), { reason: 'deadline_exceeded' });
  assert.equal(armed, true); assertNoSavedPublication(f); assert.equal(f.state.commits, 1);
  assert.equal(f.state.calls.some(call => call.text.startsWith('ROLLBACK TO SAVEPOINT')), false);
  assert.equal(f.state.calls.at(-1).text, 'ROLLBACK');
});
