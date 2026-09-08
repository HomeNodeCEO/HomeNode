import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareNeighborhoodCohortBlob as blob } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { prepareCustomCohortContextHeader as prepare, prepareCustomCohortContextScope as scope,
  prepareCustomCohortContextReference as reference } from '../src/services/neighborhoodAssessment/customCohortContextContract.js';

import { contextFixture } from './fixtures/customCohortContextFixture.js';
test('header retains exact identities and distinguishes domain-separated context digest from header blob', () => {
  const body = contextFixture(), text = json(body), result = prepare(text);
  assert.deepEqual(result.body, body);
  assert.equal(result.authority, 'not_established');
  assert.deepEqual(result.header_blob, { ref: blob(text), canonical_json: text });
  const expected = createHash('sha256').update(json({ body, domain: 'cohort-issuer-context-v1', version: 1 }), 'utf8').digest('hex');
  assert.equal(result.context_ref.context_sha256, expected);
  assert.notEqual(expected, result.header_blob.ref.content_sha256);
  assert.deepEqual(reference(json(result.context_ref)), result.context_ref);
  assert.ok(Object.isFrozen(result.body.target));
  assert.ok(Object.isFrozen(result.body.study_input));
  assert.throws(() => { result.body.target.account_id = 'changed'; }, TypeError);
});
test('every consumed header dimension changes the immutable context identity', () => {
  const original = contextFixture(), expected = prepare(json(original)).context_ref.context_sha256;
  for (const change of [b => { b.effective_date = '2024-03-01'; }, b => { b.target.snapshot_version = 2; },
    b => { b.target.workflow_target_id = '1'; }, b => { b.selection_input = blob('{"selection":2}'); },
    b => { b.study_input = blob('{"study":2}'); }, b => { b.subject_dependencies = blob('{"physical":2}'); },
    b => { b.snapshot_evidence = blob('{"snapshot":2}'); }]) {
    const body = structuredClone(original); change(body);
    assert.notEqual(prepare(json(body)).context_ref.context_sha256, expected);
  }
});
test('Custom int64 and real UUID fields reject coercion and invalid identity forms', () => {
  for (const value of ['0', '-1', '+1', '01', '1e3', 1, '9223372036854775808', contextFixture().context_id]) {
    const body = contextFixture(); body.target.workflow_target_id = value;
    assert.throws(() => prepare(json(body)), /invalid_identity/);
  }
  for (const key of ['organization_id', 'report_file_id', 'appraisal_case_id', 'subject_snapshot_id']) {
    for (const value of ['1', '10000000-0000-0000-8000-000000000001', '10000000-0000-4000-7000-000000000001',
      'ABCDEFAB-0000-4000-8000-000000000001']) {
      const body = contextFixture(); body.target[key] = value;
      assert.throws(() => prepare(json(body)), /invalid_identity/);
    }
  }
});
test('header schemas are closed and preserve exact Date, revision and byte representations', () => {
  for (const change of [b => { b.extra = true; }, b => { b.target.unknown = true; },
    b => { b.context_revision = 1; }, b => { b.context_version = 2; },
    b => { b.target.workflow_type = 'uad_3_6'; }, b => { b.target.snapshot_version = 2147483648; },
    b => { b.target.snapshot_version = '1'; }, b => { b.effective_date = '2024-02-30'; },
    b => { b.effective_date = '2024-2-29'; }, b => { b.study_input.canonical_utf8_bytes = '01'; },
    b => { b.study_input.canonical_utf8_bytes = 18; }, b => { b.study_input.content_sha256 = 'A'.repeat(64); },
    b => { b.target.account_id = ' 0000123-R'; }, b => { b.target.account_id = '\u0000'; }]) {
    const body = contextFixture(); change(body); assert.throws(() => prepare(json(body)));
  }
});
test('original primitive canonical JSON is required before header parsing', () => {
  const text = json(contextFixture());
  for (const input of [contextFixture(), ` ${text}`, '{"context_version":1,"context_version":1}',
    text.replace('"snapshot_version":1', '"snapshot_version":1.0'), ' '.repeat(128001),
    text.replace('"context_version":1', '"context_version":1e0')]) assert.throws(() => prepare(input));
});
test('scope and reference validators are exact, bounded and frozen', () => {
  const body = contextFixture(), target = body.target;
  const value = { organization_id: target.organization_id, report_file_id: target.report_file_id,
    assignment_file_id: target.workflow_target_id, account_id: target.account_id };
  assert.deepEqual(scope(json(value)), value); assert.ok(Object.isFrozen(scope(json(value))));
  for (const input of [{ ...value, extra: null }, { ...value, assignment_file_id: 1 }, { ...value, account_id: '' }]) {
    assert.throws(() => scope(json(input)));
  }
  const ref = prepare(json(body)).context_ref;
  for (const input of [{ ...ref, context_revision: '2' }, { ...ref, context_sha256: 'g'.repeat(64) }, { ...ref, extra: null }]) {
    assert.throws(() => reference(json(input)));
  }
});
