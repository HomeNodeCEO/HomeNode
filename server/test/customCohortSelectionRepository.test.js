import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortSelectionRepository } from '../src/services/neighborhoodAssessment/customCohortSelectionRepository.js';
import { createNeighborhoodCohortBlobRepository } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { canonicalAssessmentJson as canonical } from '../src/services/neighborhoodAssessment/contract.js';
import { customCohortRepositoryFixture, customCohortScopeOf, customCohortQueryFixture } from './fixtures/customCohortRepositoryFixture.js';
import { setSection } from './fixtures/neighborhoodCustomMaterialInputsFixture.js';

async function fixture(options) {
  const base = customCohortRepositoryFixture(), scope = customCohortScopeOf(base.state.input);
  const subjectRef = await base.repo.capture(), subject = await base.repo.load(subjectRef);
  const query = customCohortQueryFixture(subject, options);
  const repo = createCustomCohortSelectionRepository(base.client, JSON.stringify(scope));
  const blobs = createNeighborhoodCohortBlobRepository(base.client, scope.organization_id);
  base.state.calls.length = 0;
  return { ...base, subjectRepo: base.repo, repo, scope, subjectRef, subject, query, blobs };
}

for (const count of [3, 1001, 50000]) test(`retains and reloads all ${count} original accounts with both original hashes`, async () => {
  const ids = ['0000123456789', ...Array.from({ length: count - 1 }, (_, i) => `R-${String(i).padStart(6, '0')}`)];
  const f = await fixture({ accountIds: ids });
  const ref = await f.repo.retain(f.subjectRef, f.query.inputJson);
  const result = await f.repo.load(ref);
  assert.equal(result.status, 'retained'); assert.equal(result.authority, 'not_established');
  assert.deepEqual(result.query.evidence, f.query.bundle);
  assert.deepEqual(result.subject, f.subject);
  assert.deepEqual(result.subject_inputs, f.subjectRef);
  assert.equal(result.query.authority, 'not_established');
  assert.deepEqual(await f.repo.retain(f.subjectRef, f.query.inputJson), ref);
  assert.equal(f.state.db.size, 5 + f.query.bundle.blobs.length + 1);
  assert.ok(f.state.calls.every(c => ['read', 'insert', 'transaction', 'history-target'].includes(c.tag)));
});

test('historical selection and period survive current subject, physical inputs and lifecycle changes', async () => {
  const f = await fixture(), ref = await f.repo.retain(f.subjectRef, f.query.inputJson), original = await f.repo.load(ref);
  f.state.input.target.subject_snapshot_id = '10000000-0000-4000-8000-000000000099';
  f.state.input.snapshot.id = f.state.input.target.subject_snapshot_id;
  f.state.input.snapshot.effective_date = f.state.caseDate = '2026-09-07';
  setSection(f.state.input, 1, '{"main_improvement":{"living_area_sqft":5000}}');
  f.state.status = 'signed';
  assert.deepEqual(await f.repo.load(ref), original);
  const metadataBlob = original.query.evidence.blobs.find(blob => blob.ref.content_sha256 === f.query.refs.metadata.content_sha256);
  assert.deepEqual(JSON.parse(metadataBlob.canonical_json).observation_period, f.query.metadata.observation_period);
});

for (const field of ['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id',
  'report_file_id', 'workflow_type', 'workflow_target_id', 'effective_date']) test(`self-consistent query with wrong ${field} cannot be paired with subject`, async () => {
  const f = await fixture();
  const query = customCohortQueryFixture(f.subject, { mutateMetadata(metadata) {
    if (field === 'effective_date') metadata.effective_date = '2026-09-05';
    else if (Object.hasOwn(metadata.scope, field)) metadata.scope[field] = field === 'account_id' ? 'R-001' : '90000000-0000-4000-8000-000000000009';
    else metadata.authorization.target[field] = field === 'workflow_type' ? 'uad_3_6'
      : field === 'workflow_target_id' ? '43' : '90000000-0000-4000-8000-000000000009';
  } });
  await assert.rejects(f.repo.retain(f.subjectRef, query.inputJson), /subject_mismatch|invalid_evidence/);
  assert.equal(f.state.db.size, 5);
});

test('wrong original hash, missing pages and decorated evidence refuse before DB activity', async () => {
  const f = await fixture();
  for (const change of [b => { b.captured_query_selection_sha256 = '0'.repeat(64); },
    b => { b.blobs.pop(); }, b => { b.ready = true; }, b => { b.producer_profile = 'not-installed'; }]) {
    const bundle = structuredClone(f.query.bundle); change(bundle);
    f.state.calls.length = 0;
    await assert.rejects(f.repo.retain(f.subjectRef, JSON.stringify(bundle)), /invalid_evidence/);
    assert.equal(f.state.calls.length, 0); assert.equal(f.state.db.size, 5);
  }
});

test('missing stored page is an explicit failure, never a reduced or empty population', async () => {
  const f = await fixture(), ref = await f.repo.retain(f.subjectRef, f.query.inputJson);
  f.state.db.delete(`${f.scope.organization_id}:${f.query.refs.pages[0].content_sha256}`);
  await assert.rejects(f.repo.load(ref), /missing_evidence/);
});

test('byte corruption is not accepted even when the reference columns were preserved', async () => {
  const f = await fixture(), ref = await f.repo.retain(f.subjectRef, f.query.inputJson);
  f.state.db.get(`${f.scope.organization_id}:${f.query.refs.pages[0].content_sha256}`).canonical_utf8 = '{}';
  await assert.rejects(f.repo.load(ref), /storage_conflict/);
});

test('content-valid substituted headers reject duplicate refs, query digests, wrong lengths and extra authority flags', async () => {
  const f = await fixture(), ref = await f.repo.retain(f.subjectRef, f.query.inputJson);
  const original = JSON.parse(await f.blobs.get(ref.content_sha256, ref.canonical_utf8_bytes));
  for (const mutate of [h => { h.ready = true; }, h => { h.usage = 'approved'; },
    h => { h.query_bundle.blob_refs.push(h.query_bundle.blob_refs[0]); },
    h => { h.query_bundle.captured_query_selection_sha256 = '0'.repeat(64); },
    h => { h.query_bundle.blob_refs[0].canonical_utf8_bytes = '1'; },
    h => { h.query_bundle.blob_refs = []; }]) {
    const header = structuredClone(original); mutate(header);
    const altered = await f.blobs.put(canonical(header));
    await assert.rejects(f.repo.load(altered), /custom_cohort_selection_|storage_conflict/);
  }
});

test('cross-organization and cross-file loads fail; current read access remains caller-owned', async () => {
  const f = await fixture(), ref = await f.repo.retain(f.subjectRef, f.query.inputJson);
  for (const field of ['organization_id', 'report_file_id']) {
    const scope = { ...f.scope, [field]: '90000000-0000-4000-8000-000000000009' };
    await assert.rejects(createCustomCohortSelectionRepository(f.client, JSON.stringify(scope)).load(ref), /missing_evidence|target_mismatch/);
  }
  f.state.missing = 'history-target';
  await assert.rejects(f.repo.load(ref), /not_found/);
});

test('autocommit and database failures propagate without retries or partial success receipts', async () => {
  const f = await fixture(); let tx = 1;
  f.state.transforms.transaction = () => ({ transaction_id: String(tx++) });
  await assert.rejects(f.repo.retain(f.subjectRef, f.query.inputJson), /caller_transaction_required/);
  assert.equal(f.state.db.size, 5);
  delete f.state.transforms.transaction;
  const error = Object.assign(new Error('synthetic failure'), { code: '57014' });
  f.state.error = { tag: 'insert', value: error };
  await assert.rejects(f.repo.retain(f.subjectRef, f.query.inputJson), actual => actual === error);
  assert.equal(f.state.calls.filter(c => c.tag === 'insert').length, 1);
});
