import assert from 'node:assert/strict';
import test from 'node:test';
import { CUSTOM_APPRAISAL_SECTION_MAX_BYTES, normalizeCustomAppraisalSectionValue } from '../src/services/customAppraisalSectionValue.js';
import { canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareCustomCohortContextHeader } from '../src/services/neighborhoodAssessment/customCohortContextContract.js';
import { CUSTOM_NEIGHBORHOOD_ACCEPTED_SECTION } from '../src/services/neighborhoodAssessment/customAcceptanceSnapshot.js';
import { CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION, CUSTOM_NEIGHBORHOOD_WORKSPACE_CHECKPOINT_LIMITS as LIMITS,
  prepareCustomNeighborhoodWorkspaceCheckpoint as prepare,
  readCustomNeighborhoodWorkspaceCheckpoint as read } from '../src/services/neighborhoodAssessment/customWorkspaceCheckpoint.js';
import { contextFixture } from './fixtures/customCohortContextFixture.js';

const REF = prepareCustomCohortContextHeader(canonicalAssessmentJson(contextFixture())).context_ref;
const PERIOD = { start_date: '2024-02-29', end_date: '2024-06-30' };
const NEXT_OPERATION = '99999999-0000-4000-8000-000000000001';
const group = index => `recorded-cad:${index.toString(16).padStart(64, '0')}`;
const copy = value => structuredClone(value);
function checkpoint() {
  return { workspace_version: 1,
    active: { context_ref: copy(REF), observation_period: copy(PERIOD),
      selection: { revision: 7, included_recorded_group_ids: [group(2), 'discovery:unassigned', group(1)] } },
    pending_capture: { operation_id: NEXT_OPERATION, observation_period: { start_date: '2023-01-01', end_date: '2024-06-30' } } };
}
function invalid(value, reason) {
  assert.throws(() => prepare(value), error => error.code === 'CUSTOM_NEIGHBORHOOD_WORKSPACE_CHECKPOINT_INVALID'
    && error.message.startsWith('invalid_custom_neighborhood_workspace_checkpoint:') && (!reason || error.reason === reason));
}

test('checkpoint is distinct from accepted report section and fits the actual workfile store', () => {
  assert.equal(CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION, 'neighborhood_workspace');
  assert.notEqual(CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION, CUSTOM_NEIGHBORHOOD_ACCEPTED_SECTION);
  const input = checkpoint(), before = copy(input), result = prepare(input);
  assert.deepEqual(result, before);
  assert.notEqual(result, input);
  assert.notEqual(result.active.selection.included_recorded_group_ids, input.active.selection.included_recorded_group_ids);
  assert.equal(normalizeCustomAppraisalSectionValue(result), result);
  assert.deepEqual(input, before);
  assert.equal(Object.isFrozen(input), false);
  for (const item of [result, result.active, result.active.context_ref, result.active.selection,
    result.active.selection.included_recorded_group_ids, result.pending_capture, result.pending_capture.observation_period]) {
    assert.equal(Object.isFrozen(item), true);
  }
  input.active.selection.included_recorded_group_ids.pop();
  input.pending_capture.operation_id = 'modified';
  assert.deepEqual(result, before);
});

test('only undefined means absent; valid intentionally cleared state remains restored', () => {
  assert.deepEqual(read(undefined), { status: 'absent', section_revision: 0, checkpoint: null });
  for (const absentLike of [null, {}, false, 0, '', { revision: 1 }, { revision: 1, value: null }]) {
    const result = read(absentLike);
    assert.equal(result.status, 'invalid');
    assert.equal(result.section_revision, null);
    assert.equal(result.checkpoint, null);
  }
  const value = { workspace_version: 1, active: null, pending_capture: null };
  assert.deepEqual(read({ revision: 3, value }), { status: 'restored', section_revision: 3, checkpoint: value });
});

test('an explicit empty selection survives JSON/workfile round-trip without becoming all groups', () => {
  const value = checkpoint();
  value.active.selection.included_recorded_group_ids = [];
  value.pending_capture = null;
  const encoded = canonicalAssessmentJson(prepare(value));
  const restored = read({ key: CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION, value: JSON.parse(encoded), revision: 12,
    updated_by: 'synthetic-actor', updated_at: '2026-09-09T00:00:00.000Z' });
  assert.equal(restored.status, 'restored');
  assert.equal(restored.section_revision, 12);
  assert.deepEqual(restored.checkpoint.active.selection.included_recorded_group_ids, []);
  assert.equal(restored.checkpoint.active.selection.revision, 7);
  assert.equal(restored.checkpoint.pending_capture, null);
});

test('pending-only capture preserves its exact UUID and study for repeatable retries', () => {
  const value = checkpoint(); value.active = null;
  const first = prepare(value), reopened = read({ value: JSON.parse(canonicalAssessmentJson(first)), revision: 1 });
  assert.equal(reopened.checkpoint.pending_capture.operation_id, NEXT_OPERATION);
  assert.deepEqual(reopened.checkpoint, first);
  assert.deepEqual(prepare(first), first);
});

test('old active context survives a different pending capture and changed observation period', () => {
  const value = checkpoint(), result = prepare(value);
  assert.deepEqual(result.active, value.active);
  assert.notEqual(result.pending_capture.operation_id, result.active.context_ref.context_id);
  assert.notDeepEqual(result.pending_capture.observation_period, result.active.observation_period);
});

test('actual context_id=operationId replay allows matching study but rejects contradictory study', () => {
  const value = checkpoint();
  value.pending_capture = { operation_id: value.active.context_ref.context_id, observation_period: copy(PERIOD) };
  assert.deepEqual(prepare(value), value);
  value.pending_capture.observation_period.start_date = '2024-01-01';
  invalid(value, 'operation_study_conflict');
});

test('all 128 recorded groups plus unresolved are retained exactly without truncation', () => {
  const value = checkpoint();
  value.active.selection.included_recorded_group_ids = ['discovery:unassigned', ...Array.from({ length: 128 }, (_, i) => group(i + 1))];
  const result = prepare(value), bytes = Buffer.byteLength(canonicalAssessmentJson(result));
  assert.deepEqual(result.active.selection.included_recorded_group_ids, value.active.selection.included_recorded_group_ids);
  assert.equal(result.active.selection.included_recorded_group_ids.length, LIMITS.group_ids);
  assert.ok(bytes <= LIMITS.canonical_utf8_bytes && LIMITS.canonical_utf8_bytes < CUSTOM_APPRAISAL_SECTION_MAX_BYTES);
  assert.equal(LIMITS.recorded_group_ids, 128);
  assert.equal(Object.isFrozen(LIMITS), true);
});

for (const [name, mutate] of [
  ['129 recorded groups without unresolved', c => { c.active.selection.included_recorded_group_ids = Array.from({ length: 129 }, (_, i) => group(i)); }],
  ['130 total groups', c => { c.active.selection.included_recorded_group_ids = ['discovery:unassigned', ...Array.from({ length: 129 }, (_, i) => group(i))]; }],
  ['duplicate group', c => { c.active.selection.included_recorded_group_ids = [group(1), group(1)]; }],
  ['duplicate unresolved', c => { c.active.selection.included_recorded_group_ids = ['discovery:unassigned', 'discovery:unassigned']; }],
  ['raw account identity', c => { c.active.selection.included_recorded_group_ids = ['00000123']; }],
  ['arbitrary pocket label', c => { c.active.selection.included_recorded_group_ids = ['Oak subdivision']; }],
  ['uppercase digest', c => { c.active.selection.included_recorded_group_ids = [`recorded-cad:${'A'.repeat(64)}`]; }],
  ['whitespace identity', c => { c.active.selection.included_recorded_group_ids = [` ${group(1)}`]; }],
  ['overlong identity', c => { c.active.selection.included_recorded_group_ids = [`recorded-cad:${'a'.repeat(40_000)}`]; }],
  ['null group list', c => { c.active.selection.included_recorded_group_ids = null; }],
  ['sparse group list', c => { c.active.selection.included_recorded_group_ids = new Array(1); }],
  ['custom array property', c => { c.active.selection.included_recorded_group_ids.extra = true; }],
]) test(`rejects ${name} instead of silently repairing membership`, () => {
  const value = checkpoint(); mutate(value); invalid(value, 'group_ids');
});

for (const [name, mutate] of [
  ['unknown version', c => { c.workspace_version = 2; }],
  ['missing active', c => { delete c.active; }],
  ['missing pending', c => { delete c.pending_capture; }],
  ['undefined pending', c => { c.pending_capture = undefined; }],
  ['missing selection', c => { delete c.active.selection; }],
  ['null active selection', c => { c.active.selection = null; }],
  ['missing group list', c => { delete c.active.selection.included_recorded_group_ids; }],
  ['raw geometry', c => { c.active.geometry = { type: 'Polygon', coordinates: [] }; }],
  ['stored statistics', c => { c.active.statistics = { median: 300000 }; }],
  ['accepted receipt', c => { c.receipt = {}; }],
  ['raw account roster', c => { c.active.selection.account_ids = ['000123']; }],
  ['caller source grant', c => { c.source_permission = true; }],
  ['expanded pending purpose', c => { c.pending_capture.source_classes = ['core.sales']; }],
  ['unknown context field', c => { c.active.context_ref.organization_id = NEXT_OPERATION; }],
  ['historical cutoff', c => { c.active.observation_period.knowledge_cutoff = null; }],
]) test(`closed checkpoint rejects ${name}`, () => {
  const value = checkpoint(); mutate(value); invalid(value);
});

for (const revision of [0, -1, 1.5, '1', null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`selection revision rejects ${String(revision)}`, () => {
    const value = checkpoint(); value.active.selection.revision = revision; invalid(value, 'selection.revision');
  });
}

test('safe selection revisions are independent of the actual stored section revision', () => {
  const value = checkpoint(); value.active.selection.revision = Number.MAX_SAFE_INTEGER;
  assert.equal(read({ revision: 2_147_483_647, value }).checkpoint.active.selection.revision, Number.MAX_SAFE_INTEGER);
  for (const revision of [0, -1, 1.5, '1', null, 2_147_483_648, Infinity]) {
    assert.equal(read({ revision, value }).status, 'invalid');
  }
});

test('both periods require real exact calendar dates and ordered intervals without coercion', () => {
  for (const target of ['active', 'pending_capture']) {
    for (const date of ['2024-2-29', '2023-02-29', '2024-02-30', '2024-06-30T00:00:00Z', 20240630, null, ' 2024-02-29']) {
      const value = checkpoint(); value[target].observation_period.start_date = date;
      invalid(value, 'observation_period');
    }
    const value = checkpoint(); value[target].observation_period.start_date = '2024-07-01';
    invalid(value, 'observation_period');
  }
  const value = checkpoint(); value.active.observation_period = { start_date: '2100-01-01', end_date: '2100-01-01' };
  assert.deepEqual(prepare(value).active.observation_period, value.active.observation_period);
  // Dates versus actual effective date must be checked on authorized context reopen, not guessed here.
});

test('context reference reuses exact retained-context UUID/revision/digest admission', () => {
  for (const mutate of [r => { r.context_id = 'ABCDEFAB-0000-4000-8000-000000000001'; }, r => { r.context_id = 'not-uuid'; },
    r => { r.context_revision = 1; }, r => { r.context_revision = '2'; }, r => { r.context_sha256 = 'A'.repeat(64); },
    r => { r.context_sha256 = 'a'.repeat(63); }]) {
    const value = checkpoint(); mutate(value.active.context_ref); invalid(value, 'context_ref');
  }
});

test('pending UUID is strict, lower-case, unchanged and not a fabricated new operation', () => {
  for (const id of ['ABCDEFAB-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
    '99999999-0000-4000-7000-000000000001', `${NEXT_OPERATION} `, '1', 1, null]) {
    const value = checkpoint(); value.pending_capture.operation_id = id; invalid(value, 'pending_capture.operation_id');
  }
});

test('accessors, toJSON and non-data object properties never execute during admission', () => {
  let invoked = 0;
  for (const select of [c => c, c => c.active, c => c.active.context_ref, c => c.active.selection,
    c => c.active.observation_period, c => c.pending_capture]) {
    const value = checkpoint(), selected = select(value), key = Object.keys(selected)[0];
    Object.defineProperty(selected, key, { enumerable: true, get() { invoked += 1; throw new Error('must not run'); } });
    invalid(value);
  }
  const array = checkpoint();
  Object.defineProperty(array.active.selection.included_recorded_group_ids, '0', { enumerable: true, get() { invoked += 1; return group(1); } });
  invalid(array, 'group_ids');
  const json = checkpoint(); json.toJSON = () => { invoked += 1; return {}; }; invalid(json);
  const hidden = checkpoint(); Object.defineProperty(hidden, 'workspace_version', { value: 1, enumerable: false }); invalid(hidden);
  const symbol = checkpoint(); symbol[Symbol('hidden')] = true; invalid(symbol);
  assert.equal(invoked, 0);
});

test('present section metadata is closed and cannot impersonate accepted neighborhood data', () => {
  const value = checkpoint();
  for (const section of [{ value, revision: 1, key: CUSTOM_NEIGHBORHOOD_ACCEPTED_SECTION },
    { value, revision: 1, extra: true }, { value, revision: 1, updated_by: null }, { value, revision: 1, updated_at: new Date() }]) {
    assert.equal(read(section).status, 'invalid');
  }
  const section = { revision: 1 };
  Object.defineProperty(section, 'value', { enumerable: true, get() { throw new Error('must not execute'); } });
  assert.equal(read(section).status, 'invalid');
});

test('well-formed context/group hashes remain untrusted intent, not roster or publication authority', () => {
  const value = checkpoint();
  value.active.context_ref.context_sha256 = 'f'.repeat(64);
  value.active.selection.included_recorded_group_ids = [group(999)];
  const admitted = prepare(value);
  assert.deepEqual(admitted, value);
  assert.equal(Object.hasOwn(admitted, 'authority'), false);
  assert.equal(Object.hasOwn(admitted.active, 'statistics'), false);
  // Authorized context/catalog lookup must reject nonexistent/foreign/stale refs.
});
