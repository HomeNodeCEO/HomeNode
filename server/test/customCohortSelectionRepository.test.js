import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortSelectionRepository } from '../src/services/neighborhoodAssessment/customCohortSelectionRepository.js';
import { createNeighborhoodCohortBlobRepository, NEIGHBORHOOD_COHORT_BLOB_BATCH_LIMITS,
  NEIGHBORHOOD_COHORT_BLOB_READ_BATCH_LIMITS } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { canonicalAssessmentJson as canonical } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareCohortLocalQueryEvidenceV1 } from '../src/services/neighborhoodAssessment/cohortEvidenceContract.js';
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
  assert.ok(f.state.calls.every(c => ['read', 'insert-batch', 'read-batch', 'transaction', 'history-target'].includes(c.tag)));
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
  f.state.error = { tag: 'insert-batch', value: error };
  await assert.rejects(f.repo.retain(f.subjectRef, f.query.inputJson), actual => actual === error);
  assert.equal(f.state.calls.filter(c => c.tag === 'insert-batch').length, 1);
});

function legacyHeaderJson(f) {
  const evidence = f.query.bundle;
  return canonical({ selection_input_version: 1, usage: 'retained_selection_inputs_only', subject_inputs: f.subjectRef,
    query_bundle: { version: evidence.version, producer_profile: evidence.producer_profile,
      query_preimage: evidence.query_preimage, captured_query_selection_sha256: evidence.captured_query_selection_sha256,
      blob_refs: evidence.blobs.map(blob => blob.ref) } });
}

function interceptQueries(f, transform) {
  const query = f.client.query.bind(f.client);
  f.client.query = async (sql, params) => transform(await query(sql, params), sql, params);
  f.repo = createCustomCohortSelectionRepository(f.client, JSON.stringify(f.scope));
}

test('38,106-account retention preserves sequential bytes while reducing fresh/replay write round trips', async () => {
  const accountIds = ['0000123456789', ...Array.from({ length: 38105 }, (_, i) => `R-${String(i).padStart(6, '0')}`)];
  const legacy = await fixture({ accountIds }), batched = await fixture({ accountIds });
  assert.equal(legacy.query.bundle.blobs.length, 42);
  // Execute the former write path, rather than estimate its round trips. The
  // separate subject/transaction admission reads are unchanged by batching.
  const retainSequential = async () => {
    for (const blob of legacy.query.bundle.blobs) await legacy.blobs.put(blob.canonical_json);
    return legacy.blobs.put(legacyHeaderJson(legacy));
  };
  for (const replay of [false, true]) {
    legacy.state.calls.length = 0; batched.state.calls.length = 0;
    const expected = await retainSequential(), actual = await batched.repo.retain(batched.subjectRef, batched.query.inputJson);
    assert.deepEqual(actual, expected);
    assert.deepEqual(batched.state.db, legacy.state.db, 'every stored hash, byte count and canonical string remains identical');
    assert.equal(legacy.state.calls.filter(c => c.tag === 'insert').length, 43);
    assert.equal(legacy.state.calls.filter(c => c.tag === 'read').length, replay ? 43 : 0);
    const batches = batched.state.calls.filter(c => c.tag === 'insert-batch');
    assert.equal(batches.length, 2);
    assert.equal(batched.state.calls.filter(c => c.tag === 'read-batch').length, replay ? 2 : 0);
    assert.equal(batched.state.calls.filter(c => c.tag === 'read').length, 5);
    assert.equal(batched.state.calls.filter(c => c.tag === 'transaction').length, 2);
    assert.equal(batched.state.calls.filter(c => c.tag === 'history-target').length, 1);
    assert.equal(batched.state.calls.filter(c => c.tag === 'insert').length, 0);
    assert.equal(batched.state.calls.length, replay ? 12 : 10);
    for (const batch of batches) {
      assert.ok(batch.params[1].length > 0 && batch.params[1].length <= NEIGHBORHOOD_COHORT_BLOB_BATCH_LIMITS.records);
      assert.ok(batch.params[2].reduce((sum, bytes) => sum + bytes, 0) <= NEIGHBORHOOD_COHORT_BLOB_BATCH_LIMITS.bytes);
      assert.deepEqual(batch.params[2], batch.params[3].map(text => Buffer.byteLength(text, 'utf8')));
    }
    assert.equal(batches.at(-1).params[1].at(-1), actual.content_sha256, 'header stays last');
  }
});

test('standalone retention accepts unordered insert and replay acknowledgements without changing the reference', async () => {
  const f = await fixture({ accountIds: ['0000123456789', ...Array.from({ length: 8000 }, (_, i) => `R-${String(i).padStart(6, '0')}`)] });
  interceptQueries(f, (result, sql) => /neighborhood-cohort-blob:(?:insert|read)-batch/.test(sql)
    ? { ...result, rows: [...result.rows].reverse() } : result);
  const ref = await f.repo.retain(f.subjectRef, f.query.inputJson);
  assert.deepEqual(await f.repo.retain(f.subjectRef, f.query.inputJson), ref);
  assert.deepEqual((await f.repo.load(ref)).query.evidence, f.query.bundle);
});

for (const [name, change] of [
  ['duplicate', result => ({ rowCount: result.rowCount + 1, rows: [...result.rows, result.rows[0]] })],
  ['unknown', result => ({ ...result, rows: [{ ...result.rows[0], content_sha256: '0'.repeat(64) }, ...result.rows.slice(1)] })],
  ['wrong bytes', result => ({ ...result, rows: [{ ...result.rows[0], canonical_utf8_bytes: '1' }, ...result.rows.slice(1)] })],
  ['changed text', result => ({ ...result, rows: [{ ...result.rows[0], exact_original: false }, ...result.rows.slice(1)] })],
  ['inconsistent count', result => ({ ...result, rowCount: result.rowCount + 1 })],
]) test(`standalone retention rejects ${name} batch acknowledgements`, async () => {
  const f = await fixture();
  interceptQueries(f, (result, sql) => /neighborhood-cohort-blob:insert-batch/.test(sql) ? change(result) : result);
  await assert.rejects(f.repo.retain(f.subjectRef, f.query.inputJson), /storage_conflict/);
  assert.equal(f.state.calls.filter(c => c.tag === 'insert-batch').length, 1);
  assert.equal(f.state.calls.filter(c => c.tag === 'read-batch').length, 0);
});

test('missing replay acknowledgement refuses the complete selection instead of returning a partial receipt', async () => {
  const f = await fixture();
  await f.repo.retain(f.subjectRef, f.query.inputJson);
  f.state.calls.length = 0;
  interceptQueries(f, (result, sql) => /neighborhood-cohort-blob:read-batch/.test(sql)
    ? { rowCount: result.rowCount - 1, rows: result.rows.slice(1) } : result);
  await assert.rejects(f.repo.retain(f.subjectRef, f.query.inputJson), /storage_conflict/);
  assert.equal(f.state.calls.filter(c => c.tag === 'insert-batch').length, 1);
  assert.equal(f.state.calls.filter(c => c.tag === 'read-batch').length, 1);
});

test('a later batch timeout stops retention without retries or a header receipt; rollback stays caller-owned', async () => {
  const f = await fixture({ accountIds: ['0000123456789', ...Array.from({ length: 38105 }, (_, i) => `R-${String(i).padStart(6, '0')}`)] });
  const query = f.client.query.bind(f.client), error = Object.assign(new Error('synthetic timeout'), { code: '57014' });
  let inserts = 0;
  f.client.query = async (sql, params) => {
    if (/neighborhood-cohort-blob:insert-batch/.test(sql) && ++inserts === 2) throw error;
    return query(sql, params);
  };
  f.repo = createCustomCohortSelectionRepository(f.client, JSON.stringify(f.scope));
  await assert.rejects(f.repo.retain(f.subjectRef, f.query.inputJson), actual => actual === error);
  assert.equal(inserts, 2);
  assert.equal(f.state.calls.filter(c => c.tag === 'insert-batch').length, 1);
  assert.ok([...f.state.db.values()].every(row => row.canonical_utf8 !== legacyHeaderJson(f)));
  assert.equal(f.state.db.size, 5 + NEIGHBORHOOD_COHORT_BLOB_BATCH_LIMITS.records);
});

// Execute the former read transport on these known valid fixtures. Admission
// and subject loading use the real unchanged contracts, not a JSON-only oracle.
async function loadSequential(f, selectionRef) {
  const header = JSON.parse(await f.blobs.get(selectionRef.content_sha256, selectionRef.canonical_utf8_bytes));
  const subject = await f.subjectRepo.load(header.subject_inputs), queryBlobs = [];
  for (const ref of header.query_bundle.blob_refs) queryBlobs.push({ ref,
    canonical_json: await f.blobs.get(ref.content_sha256, ref.canonical_utf8_bytes) });
  const stored = header.query_bundle, query = prepareCohortLocalQueryEvidenceV1(JSON.stringify({
    version: stored.version, producer_profile: stored.producer_profile, query_preimage: stored.query_preimage,
    captured_query_selection_sha256: stored.captured_query_selection_sha256, blobs: queryBlobs }));
  assert.equal(query.status, 'syntax_valid');
  return Object.freeze({ status: 'retained', authority: 'not_established', selection_reference: selectionRef,
    subject_inputs: header.subject_inputs, subject, query });
}

for (const [count, expectedBlobs, expectedBatches] of [[3, 4, 1], [38106, 42, 6], [50000, 53, 7]]) {
  test(`${count}-account read batching preserves every original byte/order and exact sequential result`, async t => {
    const accountIds = ['0000123456789', ...Array.from({ length: count - 1 }, (_, i) => `R-${String(i).padStart(6, '0')}`)];
    const f = await fixture({ accountIds }), ref = await f.repo.retain(f.subjectRef, f.query.inputJson);
    assert.equal(f.query.bundle.blobs.length, expectedBlobs);
    f.state.calls.length = 0;
    const before = await loadSequential(f, ref);
    assert.equal(f.state.calls.length, expectedBlobs + 7);
    assert.ok(f.state.calls.every(c => ['read', 'history-target'].includes(c.tag)));
    interceptQueries(f, (result, sql) => /neighborhood-cohort-blob:read-batch/.test(sql)
      ? { ...result, rows: [...result.rows].reverse() } : result);
    for (let reopened = 0; reopened < 2; reopened++) {
      f.state.calls.length = 0;
      const actual = await f.repo.load(ref);
      assert.deepEqual(actual, before); assert.equal(JSON.stringify(actual), JSON.stringify(before));
      assert.deepEqual(actual.query.evidence, f.query.bundle);
      const reads = f.state.calls.filter(c => c.tag === 'read-batch');
      assert.equal(reads.length, expectedBatches); assert.equal(f.state.calls.length, expectedBatches + 7);
      assert.deepEqual(f.state.calls.slice(0, 7).map(c => c.tag), ['read', 'history-target', ...Array(5).fill('read')]);
      assert.ok(f.state.calls.slice(7).every(c => c.tag === 'read-batch'));
      assert.deepEqual(reads.flatMap(c => c.params[1]), f.query.bundle.blobs.map(b => b.ref.content_sha256));
      assert.deepEqual(reads.flatMap(c => c.params[2]), f.query.bundle.blobs.map(b => Number(b.ref.canonical_utf8_bytes)));
      for (const read of reads) {
        assert.equal(read.params[0], f.scope.organization_id); assert.equal(read.params.length, 3);
        assert.ok(read.params[1].length > 0 && read.params[1].length <= NEIGHBORHOOD_COHORT_BLOB_READ_BATCH_LIMITS.records);
        assert.ok(read.params[2].reduce((sum, n) => sum + n, 0) <= NEIGHBORHOOD_COHORT_BLOB_READ_BATCH_LIMITS.bytes);
      }
    }
    t.diagnostic(`${expectedBlobs} sequential query reads -> ${expectedBatches} bounded batches; total load statements ${expectedBlobs + 7} -> ${expectedBatches + 7}; independent rereads retain exact evidence`);
  });
}

for (const [name, change, pattern] of [
  ['missing', result => ({ rowCount: result.rowCount - 1, rows: result.rows.slice(1) }), /missing_evidence/],
  ['duplicate', result => ({ rowCount: result.rowCount + 1, rows: [...result.rows, result.rows[0]] }), /storage_conflict/],
  ['unknown', result => ({ ...result, rows: [{ ...result.rows[0], content_sha256: '0'.repeat(64) }, ...result.rows.slice(1)] }), /storage_conflict/],
  ['wrong declared bytes', result => ({ ...result, rows: [{ ...result.rows[0], canonical_utf8_bytes: '1' }, ...result.rows.slice(1)] }), /storage_conflict/],
  ['same-length corruption', result => ({ ...result, rows: [{ ...result.rows[0],
    canonical_utf8: result.rows[0].canonical_utf8.replace(/[a-z]/, char => char === 'z' ? 'y' : 'z') }, ...result.rows.slice(1)] }), /storage_conflict/],
  ['null text', result => ({ ...result, rows: [{ ...result.rows[0], canonical_utf8: null }, ...result.rows.slice(1)] }), /storage_conflict/],
  ['inconsistent count', result => ({ ...result, rowCount: result.rowCount + 1 }), /storage_conflict/],
  ['malformed rows', result => ({ ...result, rows: null }), /storage_conflict/],
]) test(`read batching rejects ${name} originals without any later batch or write`, async () => {
  const f = await fixture({ accountIds: ['0000123456789', ...Array.from({ length: 16000 }, (_, i) => `R-${String(i).padStart(6, '0')}`)] });
  const ref = await f.repo.retain(f.subjectRef, f.query.inputJson); f.state.calls.length = 0;
  interceptQueries(f, (result, sql) => /neighborhood-cohort-blob:read-batch/.test(sql) ? change(result) : result);
  await assert.rejects(f.repo.load(ref), pattern);
  assert.equal(f.state.calls.filter(c => c.tag === 'read-batch').length, 1);
  assert.ok(f.state.calls.every(c => ['read', 'history-target', 'read-batch'].includes(c.tag)));
});

test('a missing later batch and a driver timeout stop independent reads without retry or partial result', async () => {
  for (const missing of [true, false]) {
    const f = await fixture({ accountIds: ['0000123456789', ...Array.from({ length: 38105 }, (_, i) => `R-${String(i).padStart(6, '0')}`)] });
    const ref = await f.repo.retain(f.subjectRef, f.query.inputJson), driverError = Object.assign(new Error('synthetic read timeout'), { code: '57014' });
    let batches = 0; f.state.calls.length = 0;
    interceptQueries(f, (result, sql) => {
      if (/neighborhood-cohort-blob:read-batch/.test(sql) && ++batches === 2) {
        if (!missing) throw driverError;
        return { rowCount: result.rowCount - 1, rows: result.rows.slice(1) };
      }
      return result;
    });
    await assert.rejects(f.repo.load(ref), error => missing ? /missing_evidence/.test(error.message) : error === driverError);
    assert.equal(batches, 2); assert.equal(f.state.calls.filter(c => c.tag === 'read-batch').length, 2);
  }
});

test('subject integrity remains ahead of every query batch and success never caches the next independent read', async () => {
  const f = await fixture(), ref = await f.repo.retain(f.subjectRef, f.query.inputJson);
  const original = await f.repo.load(ref);
  f.state.calls.length = 0; f.state.missing = 'history-target';
  await assert.rejects(f.repo.load(ref), /not_found/);
  assert.deepEqual(f.state.calls.map(c => c.tag), ['read', 'history-target']);
  f.state.missing = null;
  const sourceKey = `${f.scope.organization_id}:${f.query.refs.pages[0].content_sha256}`;
  const source = f.state.db.get(sourceKey); f.state.db.delete(sourceKey);
  await assert.rejects(f.repo.load(ref), /missing_evidence/);
  f.state.db.set(sourceKey, { ...source, canonical_utf8: '{}' });
  await assert.rejects(f.repo.load(ref), /storage_conflict/);
  f.state.db.set(sourceKey, source);
  assert.deepEqual(await f.repo.load(ref), original);
  const subjectKey = `${f.scope.organization_id}:${f.subject.original_snapshot_row.content_sha256}`;
  f.state.db.delete(subjectKey); f.state.calls.length = 0;
  await assert.rejects(f.repo.load(ref), /missing_evidence/);
  assert.equal(f.state.calls.filter(c => c.tag === 'read-batch').length, 0);
});

test('duplicate, reversed and over-limit header references fail before query read-ahead', async () => {
  const f = await fixture(), ref = await f.repo.retain(f.subjectRef, f.query.inputJson);
  const original = JSON.parse(await f.blobs.get(ref.content_sha256, ref.canonical_utf8_bytes));
  for (const mutate of [h => h.query_bundle.blob_refs.reverse(), h => h.query_bundle.blob_refs.push(h.query_bundle.blob_refs[0]),
    h => { h.query_bundle.blob_refs = Array(1004).fill(h.query_bundle.blob_refs[0]); },
    h => { h.query_bundle.blob_refs[0].canonical_utf8_bytes = '1500001'; },
    h => { h.query_bundle.blob_refs = Array.from({ length: 6 }, (_, i) => ({ content_sha256: String(i).padStart(64, '0'), canonical_utf8_bytes: '1500000' })); }]) {
    const header = structuredClone(original); mutate(header); const changed = await f.blobs.put(canonical(header));
    f.state.calls.length = 0;
    await assert.rejects(f.repo.load(changed), /invalid_evidence|input_limit|invalid_reference/);
    assert.deepEqual(f.state.calls.map(c => c.tag), ['read']);
  }
});

test('large canonical originals exercise the exact 2MB read boundary without becoming admitted query evidence', async () => {
  const f = await fixture(), valid = await f.repo.retain(f.subjectRef, f.query.inputJson);
  const original = JSON.parse(await f.blobs.get(valid.content_sha256, valid.canonical_utf8_bytes));
  const refs = [];
  // Real query pages are too small to reach this boundary. These are genuine
  // stored canonical arrays behind a structurally valid header, NOT a valid
  // query bundle; final semantic admission must still refuse the whole graph.
  for (let i = 0; i < 4; i++) {
    const entries = Array(1000).fill('x'.repeat(997)); entries[999] = String(i) + 'x'.repeat(995);
    const text = canonical(entries); assert.equal(Buffer.byteLength(text), 1_000_000);
    refs.push(await f.blobs.put(text));
  }
  refs.sort((a, b) => a.content_sha256 < b.content_sha256 ? -1 : 1);
  const header = { ...original, query_bundle: { ...original.query_bundle, blob_refs: refs, query_preimage: refs[0] } };
  const changed = await f.blobs.put(canonical(header)); f.state.calls.length = 0;
  await assert.rejects(f.repo.load(changed), /invalid_evidence|input_limit/);
  const batches = f.state.calls.filter(c => c.tag === 'read-batch');
  assert.deepEqual(batches.map(c => c.params[1].length), [2, 2]);
  assert.deepEqual(batches.map(c => c.params[2].reduce((sum, n) => sum + n, 0)), [2_000_000, 2_000_000]);
  assert.deepEqual(batches.flatMap(c => c.params[1]), refs.map(ref => ref.content_sha256));
});

test('mixed missing and corrupt originals fail closed without promising legacy simultaneous-fault priority', async () => {
  const f = await fixture(), ref = await f.repo.retain(f.subjectRef, f.query.inputJson);
  const ordered = f.query.bundle.blobs;
  f.state.db.delete(`${f.scope.organization_id}:${ordered[0].ref.content_sha256}`);
  f.state.db.get(`${f.scope.organization_id}:${ordered[1].ref.content_sha256}`).canonical_utf8 = '{}';
  // The batch validates returned originals before exposing missing slots. The
  // old sequential path saw the missing first ref; neither returns any graph.
  await assert.rejects(f.repo.load(ref), /storage_conflict/);
});
