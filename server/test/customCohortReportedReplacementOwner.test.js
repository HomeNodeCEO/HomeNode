import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { assessmentEvidenceDigest } from '../src/services/neighborhoodAssessment/contract.js';
import { reportedReplacementOwnerFixture } from './fixtures/customCohortReportedReplacementOwnerFixture.js';

const writes = calls => calls.filter(call => /\bINSERT INTO app\.custom_|\bUPDATE app\./.test(call.text));
async function proposed() {
  const f = await reportedReplacementOwnerFixture(), first = await f.acceptFirst(), request = f.replacementInput();
  const proposal = await f.service.prepareReportedObservations(request), apply = f.applyInput(request, proposal);
  return { ...f, first, request, proposal, apply };
}

test('actual owner proposal binds current accepted predecessor without section writes; replacement keeps both histories', async () => {
  const f = await reportedReplacementOwnerFixture(), first = await f.acceptFirst();
  assert.equal(Object.hasOwn(first.proposal, 'replacement'), false); assert.equal(Object.hasOwn(first.accepted, 'replacement'), false);
  const original = structuredClone(f.state.db), request = f.replacementInput(), before = f.state.calls.length;
  const proposal = await f.service.prepareReportedObservations(request);
  assert.equal(proposal.status, 'proposed'); assert.equal(proposal.editor_revision, 1);
  const prior = original.acceptances.get(first.apply.operationId), descriptor = proposal.replacement.predecessor;
  assert.deepEqual(proposal.replacement, { kind: 'accepted_custom_reported_group', predecessor: {
    acceptance_id: prior.id, operation_id: first.apply.operationId, accepted_editor_revision: 1,
    section_value_sha256: assessmentEvidenceDigest(original.section) } });
  assert.notEqual(descriptor.section_value_sha256, original.editor.value_sha256, 'Canonical snapshot hash is not the SQL JSONB byte fence');
  assert.deepEqual(f.state.db.section, original.section); assert.deepEqual(f.state.db.histories, original.histories);
  assert.equal(writes(f.state.calls.slice(before)).filter(c => /custom_appraisal_workfile/.test(c.text)).length, 0);
  const job = f.state.db.jobs.get(f.state.db.operations.get(request.operationId).job_id);
  assert.equal(job.request_payload.proposal_version, 2); assert.deepEqual(job.request_payload.request.replacement, request.replacement);
  assert.deepEqual(job.request_payload.fences.replacement.predecessor, descriptor);
  assert.equal(job.request_payload.fences.replacement.section_history_id, prior.section_history_id);
  assert.equal(job.request_payload.fences.editor.value_sha256, original.editor.value_sha256);
  const apply = f.applyInput(request, proposal), accepted = await f.service.applyReportedObservations(apply);
  assert.equal(accepted.status, 'accepted'); assert.equal(accepted.accepted_editor_revision, 2);
  assert.deepEqual(accepted.replacement, proposal.replacement); assert.equal(accepted.reused, false);
  assert.equal(f.state.db.acceptances.size, 2); assert.equal(f.state.db.histories.size, 2);
  assert.deepEqual(f.state.db.acceptances.get(first.apply.operationId), prior);
  assert.deepEqual(f.state.db.histories.get(1), original.histories.get(1)); assert.deepEqual(f.state.db.unrelated, original.unrelated);
  assert.equal(Object.keys(f.state.db.section.mapped_values).length, 5);
  assert.equal(Object.keys(f.state.db.section.decision.applied).length, 5); assert.deepEqual(f.state.db.section.decision.reused, {});
  assert.equal(f.state.db.section.mapped_values['custom-neighborhood-report:geography'].value.cardinal_summaries.north, 'Recorded north revised');
});

test('exact proposal replay preserves immutable predecessor and emits no additional publication', async () => {
  const f = await proposed(), count = f.state.calls.length, replay = await f.service.prepareReportedObservations(f.request);
  assert.deepEqual({ ...replay, reused: false }, f.proposal); assert.equal(replay.reused, true);
  assert.equal(writes(f.state.calls.slice(count)).length, 0); assert.equal(f.state.db.jobs.size, 2);
});

test('lost replacement COMMIT ACK replays successor before any predecessor-current lookup', async () => {
  const f = await proposed(); let lost = false;
  f.state.afterCommit = () => { if (!lost) { lost = true; throw new Error('synthetic lost COMMIT acknowledgement'); } };
  await assert.rejects(f.service.applyReportedObservations(f.apply), error => error.outcome_unknown === true);
  assert.equal(f.state.db.histories.size, 2); const count = f.state.calls.length;
  const replay = await f.service.applyReportedObservations(f.apply);
  assert.equal(replay.reused, true); assert.equal(replay.accepted_editor_revision, 2); assert.deepEqual(replay.replacement, f.proposal.replacement);
  assert.equal(writes(f.state.calls.slice(count)).length, 0);
  assert.ok(!f.state.calls.slice(count).some(c => c.text.includes('reported-predecessor')));
  assert.equal(f.state.db.acceptances.size, 2); assert.equal(f.state.db.histories.size, 2);
});

for (const [name, replacement] of [
  ['null', null], ['empty', {}], ['wrong kind', { kind: 'overwrite' }],
  ['extra flag', { kind: 'accepted_custom_reported_group', overwrite: true }],
  ['proposal cannot choose predecessor', { kind: 'accepted_custom_reported_group', predecessor: {} }],
]) test(`malformed proposal replacement ${name} fails before any connection`, async () => {
  const f = await reportedReplacementOwnerFixture();
  await assert.rejects(f.service.prepareReportedObservations({ ...f.input, replacement }), { reason: 'invalid_reported_input' });
  assert.equal(f.state.phases, 0);
});

test('malformed Apply descriptor and hostile replacement are refused before DB', async () => {
  const f = await proposed(), count = f.state.phases;
  for (const replacement of [{ kind: 'accepted_custom_reported_group' }, { ...f.proposal.replacement, predecessor: null },
    { ...f.proposal.replacement, predecessor: { ...f.proposal.replacement.predecessor, accepted_editor_revision: '1' } },
    { ...f.proposal.replacement, predecessor: { ...f.proposal.replacement.predecessor, extra: true } }]) {
    await assert.rejects(f.service.applyReportedObservations({ ...f.apply, replacement }), { reason: 'invalid_reported_input' });
  }
  let invoked = false; const hostile = Object.defineProperty({}, 'kind', { enumerable: true, get() { invoked = true; return 'accepted_custom_reported_group'; } });
  await assert.rejects(f.service.prepareReportedObservations({ ...f.request, replacement: hostile }), { reason: 'invalid_reported_input' });
  assert.equal(invoked, false); assert.equal(f.state.phases, count);
});

for (const field of ['acceptance_id', 'operation_id', 'accepted_editor_revision', 'section_value_sha256']) {
  test(`Apply must echo exact proposal predecessor ${field}, including on committed replay`, async () => {
    const f = await proposed(); const bad = { ...f.apply, replacement: structuredClone(f.proposal.replacement) };
    bad.replacement.predecessor[field] = field === 'accepted_editor_revision' ? 2 : field === 'section_value_sha256' ? 'a'.repeat(64) : randomUUID();
    await assert.rejects(f.service.applyReportedObservations(bad), { reason: 'report_replacement_conflict' });
    assert.equal(f.state.db.histories.size, 1); await f.service.applyReportedObservations(f.apply);
    await assert.rejects(f.service.applyReportedObservations(bad), { reason: 'report_replacement_conflict' });
    assert.equal(f.state.db.histories.size, 2);
  });
}

test('missing current section/acceptance and changed partial current group cannot establish a predecessor', async () => {
  for (const change of [d => { d.section = null; }, d => { d.acceptances.clear(); },
    d => { delete d.section.mapped_values['custom-neighborhood-report:statistics']; },
    d => { d.section.operation_id = randomUUID(); }]) {
    const f = await reportedReplacementOwnerFixture(); await f.acceptFirst(); const request = f.replacementInput(); change(f.state.db);
    await assert.rejects(f.service.prepareReportedObservations(request), { reason: 'report_replacement_conflict' });
    assert.equal(f.state.db.jobs.size, 1);
  }
});

test('removing replacement does not turn an occupied section into implicit first Apply', async () => {
  const f = await proposed(), { replacement: _replacement, ...without } = f.apply;
  await assert.rejects(f.service.applyReportedObservations(without), { reason: 'operation_conflict' });
  const { replacement: _intent, ...request } = f.replacementInput();
  const ordinary = await f.service.prepareReportedObservations(request);
  assert.equal(Object.hasOwn(ordinary, 'replacement'), false);
  await assert.rejects(f.service.applyReportedObservations(f.applyInput(request, ordinary)), { reason: 'report_group_conflict' });
  assert.equal(f.state.db.histories.size, 1);
});

for (const [name, change, reason] of [
  ['same-revision editor bytes', d => { d.editor.value_sha256 = 'b'.repeat(64); }, 'report_editor_changed'],
  ['workspace', d => { d.workspace.revision++; }, 'workspace_changed'],
  ['geography', d => { d.boundary.assignment_revision++; }, 'report_geography_changed'],
  ['assignment', d => { d.assignment.assigned_appraiser_user_id = randomUUID(); }, 'assignment_access_denied'],
  ['predecessor receipt identity', d => { [...d.acceptances.values()][0].id = randomUUID(); }, 'report_replacement_conflict'],
]) test(`second proposal transaction fences ${name}`, async () => {
  const f = await reportedReplacementOwnerFixture(); await f.acceptFirst(); const request = f.replacementInput();
  let changed = false; f.state.afterCommit = () => { if (!changed) { changed = true; change(f.state.db); } };
  await assert.rejects(f.service.prepareReportedObservations(request), { reason });
  assert.equal(f.state.db.jobs.size, 1); assert.equal(f.state.db.histories.size, 1);
});

test('final report-rights denial after actual save machinery rolls back successor and leaves predecessor intact', async () => {
  const f = await proposed(), before = structuredClone(f.state.db); let deny = false;
  f.state.afterQuery = text => { if (text.includes('custom-neighborhood-acceptance:insert')) deny = true; };
  f.state.reportPolicy = () => deny ? { allowed: false } : { allowed: true, decision_id: 'synthetic-report', policy_revision: 'v1' };
  await assert.rejects(f.service.applyReportedObservations(f.apply), { reason: 'report_observation_access_denied' });
  assert.deepEqual(f.state.db, before); assert.equal(f.state.calls.at(-1).text, 'ROLLBACK');
});

test('history/acceptance SQL faults discard/rollback without a partial successor', async () => {
  for (const tag of ['INSERT INTO app.custom_appraisal_workfile_section_history', 'custom-neighborhood-acceptance:insert']) {
    const f = await proposed(), before = structuredClone(f.state.db);
    f.state.beforeQuery = text => { if (text.includes(tag)) throw Object.assign(new Error('synthetic SQL fault'), { code: '23514' }); };
    await assert.rejects(f.service.applyReportedObservations(f.apply)); assert.deepEqual(f.state.db, before);
    assert.ok(f.state.releases.at(-1));
  }
});

test('new actor may explicitly replace old actor, but changed-actor replay and signed new replacement fail', async () => {
  const f = await reportedReplacementOwnerFixture(), first = await f.acceptFirst(), candidateRequest = f.replacementInput();
  const prior = f.state.db.acceptances.get(first.apply.operationId), actor = randomUUID();
  f.state.db.assignment.assigned_appraiser_user_id = actor;
  const request = { ...candidateRequest, auth: { ...candidateRequest.auth, userId: actor } };
  const proposal = await f.service.prepareReportedObservations(request), apply = f.applyInput(request, proposal);
  await f.service.applyReportedObservations(apply);
  assert.deepEqual(f.state.db.acceptances.get(first.apply.operationId), prior);
  assert.equal(f.state.db.section.actor_user_id, actor);
  f.state.db.workfile = { status: 'signed', signed_at: '2026-09-10T17:00:00Z', has_signed_snapshot: true };
  assert.equal((await f.service.applyReportedObservations(apply)).reused, true);
  await assert.rejects(f.service.applyReportedObservations({ ...apply, operationId: randomUUID() }), { reason: 'private_source_read_only' });
  f.state.db.assignment.assigned_appraiser_user_id = f.input.auth.userId;
  await assert.rejects(f.service.applyReportedObservations({ ...apply, auth: f.input.auth }), { reason: 'operation_conflict' });
  assert.equal(f.state.db.histories.size, 2);
});

test('old Apply operation cannot replay over successor or produce another history', async () => {
  const f = await proposed(); await f.service.applyReportedObservations(f.apply); const before = structuredClone(f.state.db);
  await assert.rejects(f.service.applyReportedObservations(f.first.apply));
  assert.deepEqual(f.state.db, before); assert.equal(f.state.db.histories.size, 2);
});

test('constant-clock cancel/reprepare creates distinct proposals and only one can replace the same predecessor', async () => {
  const f = await proposed(), nextRequest = { ...f.request, operationId: randomUUID() };
  const next = await f.service.prepareReportedObservations(nextRequest);
  assert.equal(next.status, 'proposed'); assert.notEqual(next.attachment_ref.attachment_id, f.proposal.attachment_ref.attachment_id);
  assert.deepEqual(next.replacement, f.proposal.replacement); assert.equal(f.state.db.jobs.size, 3);
  const jobs = [...f.state.db.jobs.values()].slice(1);
  assert.notEqual(jobs[0].input_signature_sha256, jobs[1].input_signature_sha256);
  assert.deepEqual(f.state.db.assessments.get(2).statistics, f.state.db.assessments.get(3).statistics);
  await f.service.applyReportedObservations(f.applyInput(nextRequest, next));
  await assert.rejects(f.service.applyReportedObservations(f.apply), { reason: 'report_editor_changed' });
  assert.equal(f.state.db.histories.size, 2); assert.equal(f.state.db.acceptances.size, 2);
});

test('constant-clock different actor may prepare unchanged content after a canceled proposal', async () => {
  const f = await proposed(), actor = randomUUID(); f.state.db.assignment.assigned_appraiser_user_id = actor;
  const request = { ...f.request, operationId: randomUUID(), auth: { ...f.request.auth, userId: actor } };
  const next = await f.service.prepareReportedObservations(request), accepted = await f.service.applyReportedObservations(f.applyInput(request, next));
  assert.equal(accepted.status, 'accepted'); assert.deepEqual(next.replacement, f.proposal.replacement);
  assert.equal(f.state.db.section.actor_user_id, actor); assert.equal(f.state.db.jobs.size, 3);
  assert.deepEqual(f.state.db.assessments.get(2).statistics, f.state.db.assessments.get(3).statistics);
});
