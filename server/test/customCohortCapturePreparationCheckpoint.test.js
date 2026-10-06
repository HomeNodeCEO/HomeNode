import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareNeighborhoodCohortBlob as blob } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { resumeCustomCohortPreparationCheckpoint } from '../src/services/neighborhoodAssessment/customCohortCapturePreparationCheckpoint.js';

// Read-only binding doubles, not source validity or authorization substitutes.
// Real graph, current policy and transaction checks run in disposable PG CI.
function fixture({ reported = false, privateSales = false } = {}) {
  const calls = [], texts = new Map();
  const input = { operationId: '11111111-1111-4111-8111-111111111111',
    auth: { userId: '22222222-2222-4222-8222-222222222222' },
    ...(privateSales ? { privateSalesImport: { batch_id: '33333333-3333-4333-8333-333333333333', expected_review_revision: '1' } } : {}) };
  const ref = { content_sha256: 'a'.repeat(64), canonical_utf8_bytes: '100' };
  const target = { organization_id: '44444444-4444-4444-8444-444444444444',
    report_file_id: '55555555-5555-4555-8555-555555555555',
    appraisal_case_id: '66666666-6666-4666-8666-666666666666',
    subject_snapshot_id: '77777777-7777-4777-8777-777777777777',
    assignment_file_id: '1', workflow_type: 'custom_appraisal', account_id: 'SYNTHETIC', snapshot_version: 1 };
  const subject = { target, effective_date: '2024-06-30', snapshot_evidence: ref };
  const study = { profile_id: 'synthetic-checkpoint', knowledge_cutoff: null,
    observation_period: { start_date: '2024-01-01', end_date: '2024-06-30' } };
  const housingProfile = { profile: 'synthetic-housing' }, reportedProfile = reported ? { profile: 'synthetic-reported' } : null;
  const intent = { intent_version: 5 + (reported ? 2 : 0) + (privateSales ? 1 : 0),
    operation_id: input.operationId, actor_user_id: input.auth.userId, subject_inputs: ref,
    target, effective_date: subject.effective_date, study, created_at: '2026-10-06T03:00:00.000000Z',
    recorded_housing_interpretation: housingProfile,
    ...(reported ? { reported_sale_interpretation: reportedProfile } : {}),
    ...(privateSales ? { private_sales_import: input.privateSalesImport } : {}) };
  const store = value => { const text = json(value), reference = blob(text); texts.set(reference.content_sha256, text); return reference; };
  const header = { context_version: 1, context_id: input.operationId, context_revision: '1',
    target: { ...target, workflow_target_id: target.assignment_file_id }, effective_date: subject.effective_date,
    snapshot_evidence: ref, subject_dependencies: ref, selection_input: ref, study_input: ref };
  delete header.target.assignment_file_id;
  const checkpoint = { phase: 'preparation', evidence_refs: [store(intent), store(header)] };
  const options = { checkpoint, input, study, housingProfile, reportedProfile,
    blobs: { async get(hash, bytes) {
      calls.push(hash); const text = texts.get(hash) ?? null;
      if (text !== null) assert.equal(String(Buffer.byteLength(text)), bytes); return text;
    } }, subjects: {
      async load(reference) { calls.push('subject'); assert.deepEqual(reference, ref); return subject; },
      async compareCurrent() { calls.push('current'); return { status: 'matched' }; },
      async loadRecordedPoint() { calls.push('point'); return { status: 'represented' }; },
    } };
  return { options, calls, header, subject, store, texts };
}

test('prepared checkpoint binds its original header to the original subject in every source mode', async () => {
  for (const reported of [false, true]) for (const privateSales of [false, true]) {
    const f = fixture({ reported, privateSales }), result = await resumeCustomCohortPreparationCheckpoint(f.options);
    assert.deepEqual(result.subject, f.subject);
    assert.deepEqual(result.stagedHeader.body, f.header);
    assert.equal(result.stagedHeader.authority, 'not_established');
    assert.equal(Object.isFrozen(result.stagedHeader.body.target), true);
    assert.deepEqual(f.calls, [f.options.checkpoint.evidence_refs[0].content_sha256, 'subject', 'current', 'point',
      f.options.checkpoint.evidence_refs[1].content_sha256]);
  }
});

test('a staged header cannot change operation, tenant, file, snapshot, date or subject evidence', async () => {
  const other = '88888888-8888-4888-8888-888888888888';
  const changes = [header => { header.context_id = other; },
    ...['organization_id', 'report_file_id', 'appraisal_case_id', 'subject_snapshot_id'].map(key =>
      header => { header.target[key] = other; }),
    header => { header.target.workflow_target_id = '2'; },
    header => { header.target.account_id = 'OTHER'; },
    header => { header.target.snapshot_version = 2; },
    header => { header.effective_date = '2024-06-29'; },
    header => { header.snapshot_evidence = { ...header.snapshot_evidence, content_sha256: 'b'.repeat(64) }; }];
  for (const change of changes) {
    const f = fixture(); change(f.header); f.options.checkpoint.evidence_refs[1] = f.store(f.header);
    await assert.rejects(resumeCustomCohortPreparationCheckpoint(f.options), /checkpoint_conflict/);
  }
});

test('partial checkpoints and missing staged headers cannot be treated as a complete capture', async () => {
  for (const checkpoint of [null, { phase: 'source', evidence_refs: [] },
    { phase: 'preparation', evidence_refs: [] }, { phase: 'preparation', evidence_refs: [{ bad: true }] },
    { phase: 'preparation', evidence_refs: [null, null, null] }]) {
    const f = fixture(); f.options.checkpoint = checkpoint;
    await assert.rejects(resumeCustomCohortPreparationCheckpoint(f.options), /checkpoint_conflict/);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture(); f.texts.delete(f.options.checkpoint.evidence_refs[1].content_sha256);
  await assert.rejects(resumeCustomCohortPreparationCheckpoint(f.options), /checkpoint_conflict/);
});

test('changed subject inputs refuse before even reading a staged graph header', async () => {
  const f = fixture(); f.options.subjects.compareCurrent = async () => { f.calls.push('current'); return { status: 'changed' }; };
  await assert.rejects(resumeCustomCohortPreparationCheckpoint(f.options), /subject_changed/);
  assert.deepEqual(f.calls, [f.options.checkpoint.evidence_refs[0].content_sha256, 'subject', 'current']);
});

test('even an otherwise matching header cannot replace the checkpoint original hash', async () => {
  const f = fixture(), originalGet = f.options.blobs.get;
  f.options.checkpoint.evidence_refs[1] = { ...f.options.checkpoint.evidence_refs[1], content_sha256: 'b'.repeat(64) };
  f.options.blobs.get = async (hash, bytes) => hash === 'b'.repeat(64) ? json(f.header) : originalGet(hash, bytes);
  await assert.rejects(resumeCustomCohortPreparationCheckpoint(f.options), /checkpoint_conflict/);
});
