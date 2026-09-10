import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as catalogHelpers from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import { prepareCustomNeighborhoodWorkspaceCheckpoint as serverPrepare,
  readCustomNeighborhoodWorkspaceCheckpoint as serverRead,
  CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION as serverSection,
  CUSTOM_NEIGHBORHOOD_WORKSPACE_CHECKPOINT_LIMITS as serverLimits } from '../../server/src/services/neighborhoodAssessment/customWorkspaceCheckpoint.js';

const requireRuntime = createRequire(new URL('../package.json', import.meta.url)), ts = requireRuntime('typescript');
const file = fileURLToPath(new URL('../src/features/neighborhood/customWorkspaceCheckpoint.ts', import.meta.url));
const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true,
});
assert.equal((compiled.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
const module = { exports: {} };
new Script(`(function(require,module,exports){${compiled.outputText}\n})`, { filename: file }).runInThisContext()(name => {
  assert.equal(name, './customCohortPocketCatalog', 'checkpoint helpers cannot import persistence or authentication');
  return catalogHelpers;
}, module, module.exports);
const { prepareCustomWorkspaceCheckpoint: prepare, readCustomWorkspaceCheckpoint: read,
  restoreCustomWorkspaceSelection: restore, CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION: sectionKey,
  CUSTOM_NEIGHBORHOOD_WORKSPACE_CHECKPOINT_LIMITS: limits } = module.exports;
const UUID = '10000000-0000-4000-8000-000000000001', OTHER_UUID = '10000000-0000-4000-8000-000000000002';
const groupId = n => `recorded-cad:${n.toString(16).padStart(64, '0')}`;
const UNASSIGNED = 'discovery:unassigned';
const period = () => ({ start_date: '2023-01-01', end_date: '2024-02-29' });
function fixture() {
  return { workspace_version: 1, active: { context_ref: { context_id: UUID, context_revision: '1', context_sha256: 'a'.repeat(64) },
    observation_period: period(), selection: { revision: 7, included_recorded_group_ids: [groupId(2), UNASSIGNED, groupId(1)] } },
  pending_capture: { operation_id: OTHER_UUID, observation_period: { start_date: '2022-01-01', end_date: '2024-02-29' } } };
}
const section = (value = fixture()) => ({ key: sectionKey, value, revision: 13, updated_by: 'reviewer', updated_at: '2026-09-09T12:00:00Z' });
function catalog() {
  return { status: 'review_only', binding: { context_ref: fixture().active.context_ref, selection_revision: 1 },
    pockets: [{ id: groupId(1), label: 'Alpha', county: 'Dallas', account_ids: ['R-1'], member_count: 1 },
      { id: groupId(2), label: 'Beta', county: 'Dallas', account_ids: ['00002'], member_count: 1 }],
    unassigned: { account_ids: ['unknown-account'], member_count: 1, reason_counts: [] },
    subject_membership: { account_id: 'R-1', assigned_pocket_id: groupId(1), status: 'recorded_label_matched', recorded_label_match_only: true },
    coverage: { discovery_member_count: 3, assigned_account_count: 2, unassigned_account_count: 1 }, limitations: [] };
}
const validValues = () => {
  const activeOnly = fixture(); activeOnly.pending_capture = null;
  const pendingOnly = fixture(); pendingOnly.active = null;
  const empty = fixture(); empty.active.selection.included_recorded_group_ids = [];
  const sameOperation = fixture(); sameOperation.pending_capture = { operation_id: UUID, observation_period: period() };
  const largest = fixture(); largest.active.selection = { revision: Number.MAX_SAFE_INTEGER,
    included_recorded_group_ids: [...Array.from({ length: 128 }, (_, i) => groupId(i)), UNASSIGNED] };
  return [fixture(), activeOnly, pendingOnly, empty, sameOperation, largest, { workspace_version: 1, active: null, pending_capture: null }];
};

test('browser contract constants and actual backend validator remain identical', () => {
  assert.equal(sectionKey, serverSection); assert.deepEqual(limits, serverLimits);
  for (const raw of validValues()) {
    const actualBackendValue = serverPrepare(raw);
    assert.deepEqual(prepare(actualBackendValue), actualBackendValue);
    assert.deepEqual(read(section(actualBackendValue)), serverRead(section(actualBackendValue)));
  }
});

test('v2 private capture intent has exact frontend/backend parity and leaves v1 unchanged', () => {
  const legacy = fixture(), legacyJson = JSON.stringify(prepare(legacy));
  const value = { ...fixture(), workspace_version: 2 };
  value.pending_capture.private_sales_import = { batch_id: OTHER_UUID, expected_review_revision: 7 };
  const before = structuredClone(value), actual = prepare(value);
  assert.deepEqual(actual, serverPrepare(value)); assert.deepEqual(actual, before);
  assert.deepEqual(read(section(actual)), serverRead(section(actual)));
  assert.equal(Object.isFrozen(actual.pending_capture.private_sales_import), true);
  assert.notEqual(actual.pending_capture.private_sales_import, value.pending_capture.private_sales_import);
  assert.deepEqual(actual.active, legacy.active); assert.equal(JSON.stringify(prepare(legacy)), legacyJson);
  assert.equal(Object.hasOwn(prepare(legacy).pending_capture, 'private_sales_import'), false);
  const complete = { ...value, pending_capture: null };
  assert.deepEqual(prepare(complete), serverPrepare(complete));
  assert.equal(restore(section(complete), catalog()).status, 'restored');
});

for (const selected of [undefined, null, {}, { batch_id: OTHER_UUID, expected_review_revision: 0 },
  { batch_id: OTHER_UUID, expected_review_revision: '1' }, { batch_id: OTHER_UUID, expected_review_revision: 1.5 },
  { batch_id: OTHER_UUID, expected_review_revision: 2147483648 }, { batch_id: 'latest', expected_review_revision: 1 },
  { batch_id: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', expected_review_revision: 1 },
  { batch_id: OTHER_UUID, expected_review_revision: 1, source_use_confirmed: true }])
  test(`private checkpoint selector ${JSON.stringify(selected)} rejects identically without repair`, () => {
    const value = { ...fixture(), workspace_version: 2 };
    if (selected !== undefined) value.pending_capture.private_sales_import = selected;
    assert.throws(() => prepare(value)); assert.throws(() => serverPrepare(value));
    assert.deepEqual(read(section(value)), serverRead(section(value)));
  });

test('private review revision maximum and empty group selection survive exact section round-trip', () => {
  const value = { ...fixture(), workspace_version: 2 };
  value.pending_capture.private_sales_import = { batch_id: OTHER_UUID, expected_review_revision: 2147483647 };
  value.active.selection.included_recorded_group_ids = [];
  const checked = prepare(value), restored = restore(section(checked), catalog());
  assert.deepEqual(restored.active.selection.included_recorded_group_ids, []);
  assert.equal(restored.checkpoint.pending_capture.private_sales_import.expected_review_revision, 2147483647);
  assert.deepEqual(checked, serverPrepare(value));
  assert.throws(() => prepare({ ...value, workspace_version: 1 }));
});
test('only an absent section is absent; null, malformed and intentionally empty are distinct', () => {
  assert.deepEqual(read(undefined), { status: 'absent', section_revision: 0, checkpoint: null });
  for (const raw of [null, false, {}, [], fixture(), { revision: 1, value: null }, { value: fixture() }]) {
    assert.equal(read(raw).status, 'invalid'); assert.deepEqual(read(raw), serverRead(raw));
  }
  const empty = { workspace_version: 1, active: null, pending_capture: null };
  assert.equal(read(section(empty)).status, 'restored'); assert.equal(restore(section(empty), null).status, 'no_active');
});
test('admission copies and deeply freezes intent without sorting or removing selected group IDs', () => {
  const raw = fixture(), ready = prepare(raw);
  assert.deepEqual(ready.active.selection.included_recorded_group_ids, [groupId(2), UNASSIGNED, groupId(1)]);
  assert.ok(Object.isFrozen(ready)); assert.ok(Object.isFrozen(ready.active.context_ref));
  assert.ok(Object.isFrozen(ready.active.selection.included_recorded_group_ids)); assert.ok(Object.isFrozen(ready.pending_capture.observation_period));
  raw.active.selection.included_recorded_group_ids.length = 0; raw.pending_capture.operation_id = UUID;
  assert.equal(ready.active.selection.included_recorded_group_ids.length, 3); assert.equal(ready.pending_capture.operation_id, OTHER_UUID);
});
for (const [name, mutate] of [
  ['unsupported version', v => { v.workspace_version = 4; }],
  ['string version', v => { v.workspace_version = '1'; }],
  ['missing pending field', v => { delete v.pending_capture; }],
  ['root geometry injection', v => { v.geometry = { type: 'Polygon' }; }],
  ['stored summary injection', v => { v.active.summary = { reliability: 99 }; }],
  ['raw member injection', v => { v.active.selection.account_ids = ['wrong-account']; }],
  ['receipt injection', v => { v.pending_capture.receipt = 'not-authority'; }],
  ['context account injection', v => { v.active.context_ref.account_id = 'wrong'; }],
  ['period extra field', v => { v.active.observation_period.effective_date = '2024-01-01'; }],
  ['uppercase context', v => { v.active.context_ref.context_id = 'AAAA0000-0000-4000-8000-000000000001'; }],
  ['invalid UUID variant', v => { v.active.context_ref.context_id = '10000000-0000-4000-1000-000000000001'; }],
  ['numeric context revision', v => { v.active.context_ref.context_revision = 1; }],
  ['uppercase digest', v => { v.active.context_ref.context_sha256 = 'A'.repeat(64); }],
  ['invalid pending UUID', v => { v.pending_capture.operation_id = 'not-a-uuid'; }],
  ['invalid date', v => { v.active.observation_period.end_date = '2023-02-29'; }],
  ['date-time instead of date', v => { v.active.observation_period.end_date = '2024-02-29T00:00:00Z'; }],
  ['reversed period', v => { v.pending_capture.observation_period.start_date = '2025-01-01'; }],
  ['same UUID different study', v => { v.pending_capture.operation_id = UUID; }],
  ['zero selection revision', v => { v.active.selection.revision = 0; }],
  ['string selection revision', v => { v.active.selection.revision = '1'; }],
  ['fractional selection revision', v => { v.active.selection.revision = 1.1; }],
  ['unsafe selection revision', v => { v.active.selection.revision = Number.MAX_SAFE_INTEGER + 1; }],
  ['nonfinite selection revision', v => { v.active.selection.revision = Infinity; }],
  ['malformed group', v => { v.active.selection.included_recorded_group_ids = ['recorded-cad:short']; }],
  ['uppercase group digest', v => { v.active.selection.included_recorded_group_ids = [`recorded-cad:${'A'.repeat(64)}`]; }],
  ['unknown group namespace', v => { v.active.selection.included_recorded_group_ids = ['custom:other']; }],
  ['duplicate group', v => { v.active.selection.included_recorded_group_ids = [groupId(1), groupId(1)]; }],
  ['duplicate unresolved group', v => { v.active.selection.included_recorded_group_ids = [UNASSIGNED, UNASSIGNED]; }],
  ['129 recorded groups', v => { v.active.selection.included_recorded_group_ids = Array.from({ length: 129 }, (_, i) => groupId(i)); }],
  ['130 total groups', v => { v.active.selection.included_recorded_group_ids = Array.from({ length: 130 }, (_, i) => groupId(i)); }],
  ['sparse group array', v => { v.active.selection.included_recorded_group_ids = Array(1); }],
  ['extra array property', v => { v.active.selection.included_recorded_group_ids.note = true; }],
]) test(`frontend/backend reject ${name} without repair`, () => {
  const raw = fixture(); mutate(raw);
  assert.throws(() => prepare(raw)); assert.throws(() => serverPrepare(raw));
  assert.deepEqual(read(section(raw)), serverRead(section(raw)));
  assert.equal(restore(section(raw), catalog()).status, 'invalid');
});
test('section envelope enforces exact key, int32 revision and known optional metadata', () => {
  for (const mutate of [s => { s.key = 'neighborhood_assessment'; }, s => { s.revision = '13'; },
    s => { s.revision = 0; }, s => { s.revision = 2_147_483_648; }, s => { s.updated_by = null; },
    s => { s.additional = true; }, s => { delete s.value; }]) {
    const raw = section(); mutate(raw); assert.equal(read(raw).status, 'invalid'); assert.deepEqual(read(raw), serverRead(raw));
  }
  for (const revision of [1, 2_147_483_647]) assert.equal(read({ value: fixture(), revision }).section_revision, revision);
});
test('accessors, non-enumerable fields, symbol properties and array subclasses are not evaluated or admitted', () => {
  let calls = 0;
  for (const mutate of [v => { Object.defineProperty(v, 'active', { enumerable: true, get() { calls++; return null; } }); },
    v => { Object.defineProperty(v.active.selection.included_recorded_group_ids, '0', { enumerable: true, get() { calls++; return groupId(2); } }); },
    v => { Object.defineProperty(v, 'workspace_version', { enumerable: false, value: 1 }); },
    v => { v[Symbol('hidden')] = 'not-checkpoint-data'; },
    v => { class GroupList extends Array {} v.active.selection.included_recorded_group_ids = new GroupList(groupId(1)); }]) {
    const raw = fixture(); mutate(raw); assert.throws(() => prepare(raw)); assert.throws(() => serverPrepare(raw));
    assert.deepEqual(read(section(raw)), serverRead(section(raw)));
  }
  assert.equal(calls, 0);
});
test('restores exact selected membership against its checked context, preserving section and selection revisions', () => {
  const saved = section(serverPrepare(fixture())), before = JSON.stringify(saved), retained = catalog();
  const result = restore(saved, retained);
  assert.equal(result.status, 'restored'); assert.equal(result.section_revision, 13); assert.equal(result.selection.revision, 7);
  assert.deepEqual(result.selection.pockets[0].account_ids, ['00002', 'R-1', 'unknown-account']);
  assert.deepEqual(result.active.selection.included_recorded_group_ids, [groupId(2), UNASSIGNED, groupId(1)]);
  assert.equal(result.checkpoint.pending_capture.operation_id, OTHER_UUID, 'pending intent is retained, not activated');
  assert.equal(result.active.context_ref.context_id, UUID); assert.equal(JSON.stringify(saved), before);
  assert.ok(Object.isFrozen(result.selection.pockets[0].account_ids));
});
test('restored [] stays empty even when the catalog has many available groups', () => {
  const raw = fixture(); raw.active.selection.included_recorded_group_ids = [];
  const result = restore(section(raw), catalog()); assert.equal(result.status, 'restored');
  assert.deepEqual(result.selection, { revision: 7, pockets: [] });
});
test('unknown recorded or unavailable unresolved groups fail the whole restore, never filter to a partial/all cohort', () => {
  const raw = fixture(); raw.active.selection.included_recorded_group_ids.push(groupId(99));
  assert.deepEqual(restore(section(raw), catalog()), { status: 'invalid', section_revision: null, checkpoint: null, reason: 'unknown_recorded_group' });
  const retained = catalog(); retained.unassigned = { account_ids: [], member_count: 0, reason_counts: [] };
  assert.equal(restore(section(), retained).reason, 'unknown_recorded_group');
});
test('a changed/missing catalog cannot restore old group IDs even when its names coincide', () => {
  for (const field of ['context_id', 'context_revision', 'context_sha256']) {
    const retained = catalog(); retained.binding.context_ref = { ...retained.binding.context_ref, [field]: 'changed' };
    assert.equal(restore(section(), retained).reason, 'catalog_context_mismatch');
  }
  assert.equal(restore(section(), null).reason, 'catalog_unavailable');
});
test('absence, invalid sections and pending-only checkpoints do not implicitly select catalog groups', () => {
  assert.equal(restore(undefined, catalog()).status, 'absent'); assert.equal(restore(null, catalog()).status, 'invalid');
  const raw = fixture(); raw.active = null;
  const result = restore(section(raw), catalog()); assert.equal(result.status, 'no_active');
  assert.equal(result.checkpoint.pending_capture.operation_id, OTHER_UUID); assert.equal('selection' in result, false);
});
test('129 valid saved groups restore all members without a 128-group truncation', () => {
  const raw = fixture(), retained = catalog();
  retained.pockets = Array.from({ length: 128 }, (_, i) => ({ id: groupId(i), label: `Recorded ${i}`, county: 'Dallas', account_ids: [`account-${i}`], member_count: 1 }));
  raw.active.selection.included_recorded_group_ids = [...retained.pockets.map(p => p.id), UNASSIGNED];
  const result = restore(section(raw), retained); assert.equal(result.status, 'restored');
  assert.equal(result.selection.pockets.length, 1); assert.equal(result.selection.pockets[0].account_ids.length, 129);
});
