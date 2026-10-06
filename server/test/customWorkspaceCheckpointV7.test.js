import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareCustomNeighborhoodWorkspaceCheckpoint as prepare, readCustomNeighborhoodWorkspaceCheckpoint as read,
  customWorkspaceCatalogVersion, customWorkspaceVersionForCatalog } from '../src/services/neighborhoodAssessment/customWorkspaceCheckpoint.js';
import { saveCustomAppraisalWorkfileSection, saveCustomAppraisalWorkfileSectionInTransaction,
  saveCustomNeighborhoodGroupWorkspaceInTransaction } from '../src/services/customAppraisalWorkfiles.js';

const context = { context_id: '10000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const period = { start_date: '2024-01-01', end_date: '2024-12-31' };
const ref = { selection_version: 1, selection_revision: 9, selection_sha256: 'b'.repeat(64),
  manifest_ref: { content_sha256: 'c'.repeat(64), canonical_utf8_bytes: '1200' } };
const value = () => ({ workspace_version: 7, active: { context_ref: structuredClone(context),
  observation_period: structuredClone(period), selection_ref: structuredClone(ref) }, pending_capture: null });
const input = () => ({ accountId: 'synthetic', assignmentFileId: '41', sectionKey: 'neighborhood_workspace',
  sectionValue: value(), expectedRevision: 3, saveReason: 'manual_save', reviewer: 'Synthetic reviewer' });

test('v7 stores only a bounded exact selection identity, not analytical members or grant; old catalog defaults remain v6', () => {
  const original = value(), prepared = prepare(original);
  assert.deepEqual(prepared, original); assert.ok(Object.isFrozen(prepared.active.selection_ref.manifest_ref));
  assert.equal(json(prepared).includes('account_ids'), false); assert.equal(customWorkspaceCatalogVersion(prepared), 3);
  assert.equal(customWorkspaceVersionForCatalog(3), 6, 'no automatic conversion of existing browser intent');
  original.active.selection_ref.manifest_ref.content_sha256 = 'd'.repeat(64);
  assert.deepEqual(prepared, value());
  assert.deepEqual(read({ revision: 11, value: JSON.parse(json(prepared)) }),
    { status: 'restored', section_revision: 11, checkpoint: prepared });
});

for (const [name, change] of [
  ['inline choices', v => { v.active.selection = { revision: 9, included_recorded_group_ids: [] }; }],
  ['members', v => { v.active.account_ids = []; }],
  ['missing ref', v => { delete v.active.selection_ref; }],
  ['null ref', v => { v.active.selection_ref = null; }],
  ['zero ref revision', v => { v.active.selection_ref.selection_revision = 0; }],
  ['wrong ref version', v => { v.active.selection_ref.selection_version = 2; }],
  ['oversize manifest', v => { v.active.selection_ref.manifest_ref.canonical_utf8_bytes = '10000000'; }],
  ['extra ref grant', v => { v.active.selection_ref.allowed = true; }],
  ['changed context', v => { v.active.context_ref.context_revision = '2'; }],
]) test(`v7 refuses ${name} without coercing or broadening`, () => {
  const v = value(); change(v); assert.throws(() => prepare(v), /invalid_custom_neighborhood_workspace_checkpoint/);
  assert.equal(read({ revision: 1, value: v }).status, 'invalid');
});

test('v7 refuses nested proxies/accessors without executing them', () => {
  let invoked = 0;
  for (const key of ['selection_ref', 'manifest_ref']) {
    const v = value(), parent = key === 'selection_ref' ? v.active : v.active.selection_ref;
    parent[key] = new Proxy(parent[key], { getPrototypeOf() { invoked++; return Object.prototype; } });
    assert.throws(() => prepare(v), /invalid_custom_neighborhood_workspace_checkpoint/);
  }
  const v = value(); Object.defineProperty(v.active.selection_ref, 'selection_revision',
    { enumerable: true, get() { invoked++; return 1; } });
  assert.throws(() => prepare(v), /invalid_custom_neighborhood_workspace_checkpoint/); assert.equal(invoked, 0);
});

test('v1-v6 inline intent is not silently upgraded or reinterpreted as a selection head', () => {
  for (const version of [1, 2, 3, 4, 5, 6]) {
    const v = { ...value(), workspace_version: version };
    assert.throws(() => prepare(v), /invalid_custom_neighborhood_workspace_checkpoint/);
    v.active = { context_ref: context, observation_period: period, selection: { revision: 9, included_recorded_group_ids: [] } };
    assert.deepEqual(prepare(v), v);
  }
});

test('v7 cannot be saved through either ordinary entry point or a disguised generic transaction request', async () => {
  const db = { async query() { assert.fail('must refuse before transaction work'); }, async connect() { assert.fail('must not connect'); } };
  for (const sectionKey of ['neighborhood_workspace', ' NEIGHBORHOOD_WORKSPACE ']) {
    const v = { ...input(), sectionKey, groupWorkspaceOwner: true };
    await assert.rejects(saveCustomAppraisalWorkfileSection(db, v), /selection_workspace_workflow_required/);
    await assert.rejects(saveCustomAppraisalWorkfileSectionInTransaction(db, v), /selection_workspace_workflow_required/);
  }
  await assert.rejects(saveCustomNeighborhoodGroupWorkspaceInTransaction(db,
    { ...input(), sectionKey: 'neighborhood' }), /selection_workspace_workflow_required/);
});
