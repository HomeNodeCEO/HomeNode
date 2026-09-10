import assert from 'node:assert/strict';
import test from 'node:test';
import { assessmentEvidenceDigest } from '../src/services/neighborhoodAssessment/contract.js';
import { buildCustomCohortReportedAssessment as build } from '../src/services/neighborhoodAssessment/customCohortReportedAssessment.js';
import { customCohortReportedAssessmentFixture } from './fixtures/customCohortReportedAssessmentFixture.js';
const uuid = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000001`;

test('omitting proposal binding retains the complete pre-change pure output hash', async () => {
  const { input } = await customCohortReportedAssessmentFixture();
  assert.equal(assessmentEvidenceDigest(build(input)), '49116493fa700f79d8d9370331ebe4b06db7b533c02654a01b19a5e9086b33cc');
});

test('same clock/content with distinct authenticated proposal identities has distinct evidence, unchanged measurements', async () => {
  const { input } = await customCohortReportedAssessmentFixture();
  const value = { operation_id: uuid(1), actor_user_id: uuid(2), expected_editor_revision: input.target.editor_revision };
  const original = build(input), first = build({ ...input, proposal_binding: value });
  assert.equal(first.status, 'ready'); assert.deepEqual(first.binding.proposal_binding, value);
  assert.notEqual(first.assessment.input_signature_sha256, original.assessment.input_signature_sha256);
  assert.deepEqual(first.assessment.statistics, original.assessment.statistics);
  assert.deepEqual(first.publication_bundle.members, original.publication_bundle.members);
  assert.deepEqual(first.assessment.methodology, original.assessment.methodology);
  assert.equal(first.assessment.generated_at, original.assessment.generated_at);
  for (const patch of [{ operation_id: uuid(3) }, { actor_user_id: uuid(4) }]) {
    const next = build({ ...input, proposal_binding: { ...value, ...patch } });
    assert.notEqual(first.assessment.input_signature_sha256, next.assessment.input_signature_sha256);
    assert.deepEqual(first.assessment.statistics, next.assessment.statistics);
    assert.equal(first.binding.derived_at, next.binding.derived_at);
  }
  assert.equal(assessmentEvidenceDigest(first), assessmentEvidenceDigest(build({ ...input, proposal_binding: { ...value } })));
  value.operation_id = uuid(9); assert.equal(first.binding.proposal_binding.operation_id, uuid(1));
  assert.ok(Object.isFrozen(first.binding.proposal_binding));
  assert.ok(first.assessment.source_snapshots.every(s => s.valid_from === null && s.historical_availability === 'unknown'));
});

test('server proposal binding is closed, bounded, exact-editor and data-only', async () => {
  const { input } = await customCohortReportedAssessmentFixture();
  const binding = { operation_id: uuid(1), actor_user_id: uuid(2), expected_editor_revision: input.target.editor_revision };
  for (const bad of [null, {}, { ...binding, authority: true }, { ...binding, operation_id: 'not-a-uuid' },
    { ...binding, actor_user_id: '' }, { ...binding, expected_editor_revision: input.target.editor_revision + 1 },
    { ...binding, expected_editor_revision: String(input.target.editor_revision) },
    new Proxy(binding, { getPrototypeOf() { assert.fail('proxy trap'); } })]) {
    assert.throws(() => build({ ...input, proposal_binding: bad }), /proposal_binding/);
  }
  const getter = { ...binding }; let invoked = false;
  Object.defineProperty(getter, 'actor_user_id', { enumerable: true, get() { invoked = true; return uuid(2); } });
  assert.throws(() => build({ ...input, proposal_binding: getter }), /proposal_binding/); assert.equal(invoked, false);
});
