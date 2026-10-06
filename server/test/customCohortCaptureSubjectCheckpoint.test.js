import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAssessmentJson as json, assessmentEvidenceDigest }
  from '../src/services/neighborhoodAssessment/contract.js';
import { resumeCustomCohortSubjectCheckpoint }
  from '../src/services/neighborhoodAssessment/customCohortCaptureSubjectCheckpoint.js';

// These read-only doubles test checkpoint bindings. Original hash/byte and
// subject-row validation remain covered by the real repositories and DB test.
function fixture({ reported = false, privateSales = false } = {}) {
  const calls = [];
  const input = { operationId: '11111111-1111-4111-8111-111111111111',
    auth: { userId: '22222222-2222-4222-8222-222222222222' },
    ...(privateSales ? { privateSalesImport: { batch_id: '33333333-3333-4333-8333-333333333333',
      expected_review_revision: '1' } } : {}) };
  const study = { profile_id: 'synthetic-checkpoint-binding', knowledge_cutoff: null,
    observation_period: { start_date: '2024-01-01', end_date: '2024-06-30' } };
  const reportedProfile = reported ? { profile: 'synthetic-reported' } : null;
  const housingProfile = { profile: 'synthetic-housing' };
  const subjectReference = { content_sha256: 'a'.repeat(64), canonical_utf8_bytes: '100' };
  const subject = { target: { organization_id: '44444444-4444-4444-8444-444444444444' },
    effective_date: '2024-06-30' };
  const point = { status: 'represented', geometry_input: { kind: 'synthetic-original-point' } };
  const body = { intent_version: 5 + (reported ? 2 : 0) + (privateSales ? 1 : 0),
    operation_id: input.operationId, actor_user_id: input.auth.userId,
    subject_inputs: subjectReference, target: subject.target, effective_date: subject.effective_date,
    study, created_at: '2026-10-06T03:00:00.000000Z', recorded_housing_interpretation: housingProfile,
    ...(reported ? { reported_sale_interpretation: reportedProfile } : {}),
    ...(privateSales ? { private_sales_import: input.privateSalesImport } : {}) };
  const reference = { content_sha256: assessmentEvidenceDigest(body),
    canonical_utf8_bytes: String(Buffer.byteLength(json(body))) };
  const checkpoint = { phase: 'subject', evidence_refs: [reference] };
  const options = { checkpoint, input, study, reportedProfile, housingProfile,
    blobs: { async get(sha, bytes) {
      calls.push('intent'); assert.equal(sha, reference.content_sha256);
      assert.equal(bytes, reference.canonical_utf8_bytes); return json(body);
    } }, subjects: {
      async load(ref) { calls.push('subject'); assert.deepEqual(ref, subjectReference); return subject; },
      async compareCurrent(ref) { calls.push('current'); assert.deepEqual(ref, subjectReference); return { status: 'matched' }; },
      async loadRecordedPoint(ref) { calls.push('point'); assert.deepEqual(ref, subjectReference); return point; },
    } };
  return { options, body, calls, subject, point, reference };
}

test('resume retains the exact original subject, intent and recorded point for all admitted source modes', async () => {
  for (const reported of [false, true]) for (const privateSales of [false, true]) {
    const f = fixture({ reported, privateSales });
    const result = await resumeCustomCohortSubjectCheckpoint(f.options);
    assert.deepEqual(result, { subject: f.subject, subjectReference: f.body.subject_inputs,
      point: f.point, intent: { reference: f.reference, body: f.body } });
    assert.deepEqual(f.calls, ['intent', 'subject', 'current', 'point']);
    assert.equal(Object.isFrozen(result.intent.body.study.observation_period), true);
    assert.equal(Object.isFrozen(result.point), true);
  }
});

test('changed operation, actor, dates, profiles and private review cannot reuse an old checkpoint', async () => {
  const changes = [
    body => { body.operation_id = '55555555-5555-4555-8555-555555555555'; },
    body => { body.actor_user_id = '55555555-5555-4555-8555-555555555555'; },
    body => { body.intent_version = 1; },
    body => { body.created_at = 'not a timestamp'; },
    body => { body.study = { ...body.study, knowledge_cutoff: '2024-01-01' }; },
    body => { body.recorded_housing_interpretation = { profile: 'changed' }; },
    body => { body.reported_sale_interpretation = { profile: 'changed' }; },
    body => { body.private_sales_import = { ...body.private_sales_import, expected_review_revision: '2' }; },
    body => { body.extra = 'not admitted'; },
  ];
  for (const change of changes) {
    const f = fixture({ reported: true, privateSales: true }); change(f.body);
    await assert.rejects(resumeCustomCohortSubjectCheckpoint(f.options), /checkpoint_conflict/);
    assert.deepEqual(f.calls, ['intent'], 'binding conflicts are refused before loading the subject');
  }
});

test('an incomplete phase, missing original or changed subject refuses instead of recapturing', async () => {
  for (const checkpoint of [null, { phase: 'source', evidence_refs: [] },
    { phase: 'subject', evidence_refs: [] }, { phase: 'subject', evidence_refs: [{ bad: true }] }]) {
    const f = fixture(); f.options.checkpoint = checkpoint;
    await assert.rejects(resumeCustomCohortSubjectCheckpoint(f.options), /checkpoint_conflict/);
    assert.deepEqual(f.calls, []);
  }
  let f = fixture(); f.options.blobs.get = async () => null;
  await assert.rejects(resumeCustomCohortSubjectCheckpoint(f.options), /checkpoint_conflict/);
  assert.deepEqual(f.calls, []);
  f = fixture(); f.options.subjects.compareCurrent = async () => ({ status: 'changed' });
  await assert.rejects(resumeCustomCohortSubjectCheckpoint(f.options), /subject_changed/);
  assert.deepEqual(f.calls, ['intent', 'subject']);
  f = fixture(); f.options.subjects.loadRecordedPoint = async () => ({ status: 'unrepresented' });
  await assert.rejects(resumeCustomCohortSubjectCheckpoint(f.options), /recorded_point_required/);
  assert.deepEqual(f.calls, ['intent', 'subject', 'current']);
});

test('original target and effective date must still match the checkpoint study', async () => {
  for (const change of [body => { body.target = { organization_id: 'different' }; },
    body => { body.effective_date = '2024-06-29'; }]) {
    const f = fixture(); change(f.body);
    await assert.rejects(resumeCustomCohortSubjectCheckpoint(f.options), /checkpoint_conflict/);
    assert.deepEqual(f.calls, ['intent', 'subject']);
  }
  const f = fixture(); f.body.effective_date = f.subject.effective_date = '2024-06-29';
  await assert.rejects(resumeCustomCohortSubjectCheckpoint(f.options), /checkpoint_conflict/);
  assert.deepEqual(f.calls, ['intent', 'subject']);
});
