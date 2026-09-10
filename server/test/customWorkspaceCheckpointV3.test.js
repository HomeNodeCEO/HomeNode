import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { normalizeCustomAppraisalSectionValue } from '../src/services/customAppraisalSectionValue.js';
import { saveCustomAppraisalWorkfileSectionInTransaction } from '../src/services/customAppraisalWorkfiles.js';
import { prepareNeighborhoodDiscoveryChoice } from '../src/services/neighborhoodAssessment/selectorInputProfile.js';
import { prepareCustomNeighborhoodWorkspaceCheckpoint as prepare, readCustomNeighborhoodWorkspaceCheckpoint as read,
  CUSTOM_NEIGHBORHOOD_WORKSPACE_CHECKPOINT_LIMITS as LIMITS } from '../src/services/neighborhoodAssessment/customWorkspaceCheckpoint.js';

// Structural navigation-intent fixtures, not registered contexts or source grants.
const CONTEXT = { context_id: '10000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const OPERATION = '20000000-0000-4000-8000-000000000002';
const BATCH = { batch_id: '30000000-0000-4000-8000-000000000003', expected_review_revision: 9 };
const PERIOD = { start_date: '2024-01-01', end_date: '2024-12-31' };
const NEXT_PERIOD = { start_date: '2024-02-29', end_date: '2024-12-31' };
const RADII = ['4828.032', '8046.72', '16093.44'];
const choice = radius => ({ profile_id: 'custom-suburban-radius-v2', radius_metres: radius });
const copy = value => structuredClone(value);
const legacy = () => ({ workspace_version: 1, active: { context_ref: copy(CONTEXT), observation_period: copy(PERIOD),
  selection: { revision: 7, included_recorded_group_ids: [] } },
  pending_capture: { operation_id: OPERATION, observation_period: copy(NEXT_PERIOD) } });
const fixture = (radius = '8046.72', withPrivate = false) => {
  const result = legacy(); result.workspace_version = 3;
  result.pending_capture.discovery = choice(radius);
  if (withPrivate) result.pending_capture.private_sales_import = copy(BATCH);
  return result;
};
function invalid(value, reason) {
  assert.throws(() => prepare(value), error => error.code === 'CUSTOM_NEIGHBORHOOD_WORKSPACE_CHECKPOINT_INVALID'
    && (!reason || error.reason === reason));
}
function frozen(value) {
  if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozen); }
}

test('v1 and v2 exact pre-change canonical digests remain unchanged; neither gains default discovery', () => {
  const v1 = legacy(), v2 = { ...copy(v1), workspace_version: 2 };
  v2.pending_capture.private_sales_import = copy(BATCH);
  for (const [value, digest] of [
    [v1, '154e8e19a44836819df7a5799f18085371019ff339f33c20e5ca7d29411af600'],
    [v2, '5e2a2142b7ec1f4458de9dbdf9341164c000c4f9ceda8a5a7df0d39ac1c385cf'],
  ]) {
    const result = prepare(value); assert.deepEqual(result, value);
    assert.equal(createHash('sha256').update(canonicalAssessmentJson(result)).digest('hex'), digest);
    assert.equal(Object.hasOwn(result.active, 'discovery'), false);
    assert.equal(Object.hasOwn(result.pending_capture, 'discovery'), false);
  }
});

for (const radius of RADII) for (const withPrivate of [false, true]) {
  test(`v3 retains exact ${radius} discovery and ${withPrivate ? 'explicit private batch' : 'ordinary source intent'}`, () => {
    const input = fixture(radius, withPrivate), before = copy(input), result = prepare(input);
    assert.deepEqual(result, before); assert.notEqual(result, input); frozen(result);
    assert.deepEqual(result.pending_capture.discovery, prepareNeighborhoodDiscoveryChoice(choice(radius)));
    assert.equal(Object.hasOwn(result.pending_capture, 'private_sales_import'), withPrivate);
    assert.equal(Object.hasOwn(result.active, 'discovery'), false, 'legacy active may remain during new expanded acquisition');
    assert.equal(normalizeCustomAppraisalSectionValue(result), result);
    assert.ok(Buffer.byteLength(canonicalAssessmentJson(result)) <= LIMITS.canonical_utf8_bytes);
    input.pending_capture.discovery.radius_metres = 'changed'; assert.deepEqual(result, before);
    const restored = read({ key: 'neighborhood_workspace', revision: 11, value: JSON.parse(canonicalAssessmentJson(result)) });
    assert.deepEqual(restored, { status: 'restored', section_revision: 11, checkpoint: result }); frozen(restored);
  });
}
test('v3 saved active discovery survives pending completion and explicit empty selection', () => {
  const value = fixture(); value.active.discovery = choice('16093.44'); value.pending_capture = null;
  const restored = read({ revision: 2147483647, value: prepare(value) });
  assert.equal(restored.status, 'restored'); assert.deepEqual(restored.checkpoint.active.discovery, choice('16093.44'));
  assert.deepEqual(restored.checkpoint.active.selection.included_recorded_group_ids, []);
  assert.equal(restored.checkpoint.active.selection.revision, 7);
});
test('v3 pending-only and explicitly cleared checkpoints stay distinct from absent or malformed sections', () => {
  const pending = fixture('16093.44', true); pending.active = null;
  assert.deepEqual(prepare(pending), pending);
  const cleared = { workspace_version: 3, active: null, pending_capture: null };
  assert.deepEqual(read({ revision: 4, value: cleared }), { status: 'restored', section_revision: 4, checkpoint: cleared });
  assert.deepEqual(read(undefined), { status: 'absent', section_revision: 0, checkpoint: null });
  for (const section of [null, { revision: 4, value: null }, { revision: 4, value: { ...cleared, pending_capture: undefined } }]) {
    assert.equal(read(section).status, 'invalid');
  }
});
test('same operation permits only exact matching period and explicit discovery', () => {
  const value = fixture(); value.active.discovery = choice('8046.72');
  value.pending_capture.operation_id = CONTEXT.context_id; value.pending_capture.observation_period = copy(PERIOD);
  assert.deepEqual(prepare(value), value);
  value.pending_capture.discovery.radius_metres = '16093.44'; invalid(value, 'operation_discovery_conflict');
});
test('absent legacy active discovery is not silently equal to explicit v2 three-mile discovery', () => {
  const value = fixture('4828.032'); value.pending_capture.operation_id = CONTEXT.context_id;
  value.pending_capture.observation_period = copy(PERIOD);
  invalid(value, 'operation_discovery_conflict');
  value.active.discovery = choice('4828.032'); assert.deepEqual(prepare(value), value);
});
test('same operation changed period keeps its existing study conflict even at identical radius', () => {
  const value = fixture(); value.active.discovery = choice('8046.72'); value.pending_capture.operation_id = CONTEXT.context_id;
  invalid(value, 'operation_study_conflict');
});
test('different operation may change period/radius while preserving the old expanded active context', () => {
  const value = fixture('16093.44', true); value.active.discovery = choice('4828.032');
  assert.deepEqual(prepare(value), value);
  assert.equal(prepare(value).active.context_ref.context_id, CONTEXT.context_id);
});

const malformed = [
  ['null', null], ['undefined', undefined], ['array', []], ['missing profile', { radius_metres: '8046.72' }],
  ['missing radius', { profile_id: 'custom-suburban-radius-v2' }],
  ['legacy profile relabel', { profile_id: 'custom-simple-suburban-radius-v1', radius_metres: '4828.032' }],
  ['unknown profile', { profile_id: 'custom-suburban-radius-v3', radius_metres: '8046.72' }],
  ['number radius', { profile_id: 'custom-suburban-radius-v2', radius_metres: 8046.72 }],
  ['whitespace radius', choice(' 8046.72')], ['decimal alias', choice('8046.720')], ['exponent alias', choice('8.04672e3')],
  ['arbitrary radius', choice('10000')], ['city scope', { ...choice('8046.72'), city_id: 'Dallas' }],
  ['source permission', { ...choice('8046.72'), allowed: true }], ['raw geometry', { ...choice('8046.72'), geometry: {} }],
];
for (const [name, discovery] of malformed) test(`v3 rejects ${name} discovery without fallback or numeric repair`, () => {
  for (const target of ['active', 'pending_capture']) {
    const value = fixture(); value[target].discovery = discovery; invalid(value);
  }
});
test('v3 pending discovery is required; old versions cannot smuggle it into any location', () => {
  const value = fixture(); delete value.pending_capture.discovery; invalid(value, 'pending_capture');
  for (const version of [1, 2]) for (const target of ['active', 'pending_capture', 'checkpoint']) {
    const old = legacy(); old.workspace_version = version;
    if (version === 2) old.pending_capture.private_sales_import = copy(BATCH);
    (target === 'checkpoint' ? old : old[target]).discovery = choice('4828.032'); invalid(old);
  }
});
test('v3 discovery and private source remain closed intent, never raw evidence or an active source binding', () => {
  const value = fixture(); value.discovery = choice('8046.72'); invalid(value, 'checkpoint');
  delete value.discovery; value.active.private_sales_import = copy(BATCH); invalid(value, 'active');
  delete value.active.private_sales_import; value.pending_capture.raw_rows = []; invalid(value, 'pending_capture');
  for (const privateValue of [null, undefined, { ...BATCH, expected_review_revision: 0 }, { ...BATCH, expected_review_revision: '9' },
    { ...BATCH, expected_review_revision: 2147483648 }, { ...BATCH, allowed: true }]) {
    const input = fixture(); input.pending_capture.private_sales_import = privateValue; invalid(input, 'private_sales_import');
  }
});
test('discovery field accessors, symbols and hidden fields never execute or disappear during admission', () => {
  let invoked = 0;
  for (const target of ['active', 'pending_capture']) {
    const value = fixture(); value[target].discovery = choice('8046.72');
    Object.defineProperty(value[target].discovery, 'radius_metres', { enumerable: true, get() { invoked++; return '8046.72'; } });
    invalid(value, 'discovery.non_data_property');
    const wrapper = fixture(); Object.defineProperty(wrapper[target], 'discovery', { enumerable: true, get() { invoked++; return choice('8046.72'); } });
    invalid(wrapper, `${target === 'active' ? 'active' : 'pending_capture'}.non_data_property`);
    const hidden = fixture(); hidden[target].discovery = choice('8046.72');
    Object.defineProperty(hidden[target].discovery, 'radius_metres', { value: '8046.72', enumerable: false }); invalid(hidden);
    const symbol = fixture(); symbol[target].discovery = choice('8046.72'); symbol[target].discovery[Symbol('grant')] = true; invalid(symbol);
  }
  assert.equal(invoked, 0);
});
test('v3 keeps exact group capacity and section/selection revision guards', () => {
  const value = fixture('16093.44', true); value.active.discovery = choice('4828.032');
  value.active.selection.included_recorded_group_ids = ['discovery:unassigned',
    ...Array.from({ length: 128 }, (_, i) => `recorded-cad:${i.toString(16).padStart(64, '0')}`)];
  assert.equal(prepare(value).active.selection.included_recorded_group_ids.length, 129);
  assert.ok(Buffer.byteLength(canonicalAssessmentJson(prepare(value))) <= LIMITS.canonical_utf8_bytes);
  value.active.selection.included_recorded_group_ids.push(`recorded-cad:${'f'.repeat(64)}`); invalid(value, 'group_ids');
  value.active.selection.included_recorded_group_ids = [];
  for (const revision of [0, '1', 2147483648]) assert.equal(read({ revision, value }).status, 'invalid');
  value.active.selection.revision = 0; invalid(value, 'selection.revision');
});
for (const version of [0, 4, '3', null]) test(`unsupported workspace version ${String(version)} remains invalid`, () => {
  const value = fixture(); value.workspace_version = version; invalid(value, 'workspace_version');
});

// Small query fake for the actual existing section writer, not PostgreSQL or
// concurrency evidence. No alternate store/CAS mechanism is introduced.
function writer({ status = 'draft', revision = 2, account = true } = {}) {
  const writes = [], queries = [];
  const client = { async query(statement, values = []) {
    const sql = statement.replace(/\s+/g, ' ').trim(); queries.push({ sql, values: copy(values) });
    if (sql.startsWith('SAVEPOINT ') || sql.startsWith('RELEASE SAVEPOINT ')) return { rows: [] };
    if (sql.startsWith('SELECT assignment_file.id, assignment_file.file_number')) {
      assert.deepEqual(values, ['41', 'synthetic-account']); return { rows: account ? [{ id: '41', file_number: 'Synthetic 41' }] : [] };
    }
    if (sql.startsWith('SELECT status FROM app.custom_appraisal_workfiles')) return { rows: [{ status }] };
    if (sql.startsWith('SELECT revision FROM app.custom_appraisal_workfile_sections')) return { rows: [{ revision }] };
    if (sql.startsWith('INSERT INTO app.custom_appraisal_workfile_sections (')) {
      writes.push({ sql, values: copy(values) }); return { rows: [{ section_key: values[1], section_value: JSON.parse(values[2]),
        revision: values[3], updated_by: values[4], updated_at: '2026-09-10T00:00:00.000Z' }] };
    }
    if (sql.startsWith('INSERT INTO app.custom_appraisal_workfiles (')
      || sql.startsWith('INSERT INTO app.custom_appraisal_workfile_section_history (')
      || sql.startsWith('UPDATE app.custom_appraisal_workfiles SET updated_at')
      || sql.startsWith('UPDATE app.assignment_files SET updated_at')) { writes.push({ sql, values: copy(values) }); return { rows: [] }; }
    assert.fail('unexpected existing section query');
  } };
  return { client, queries, writes };
}
const saveInput = value => ({ accountId: 'synthetic-account', assignmentFileId: '41', sectionKey: 'neighborhood_workspace',
  sectionValue: value, expectedRevision: 2, saveReason: 'autosave', reviewer: 'Synthetic reviewer' });
test('actual existing section writer persists v3/discovery using its unchanged history and section CAS', async () => {
  const db = writer(), value = fixture('16093.44', true); value.active.discovery = choice('4828.032');
  const before = copy(value), saved = await saveCustomAppraisalWorkfileSectionInTransaction(db.client, saveInput(value));
  assert.deepEqual(saved.value, before); assert.equal(saved.revision, 3);
  assert.equal(read(saved).status, 'restored'); assert.equal(read(saved).checkpoint.active.selection.revision, 7);
  const history = db.writes.find(row => row.sql.startsWith('INSERT INTO app.custom_appraisal_workfile_section_history ('));
  assert.deepEqual(JSON.parse(history.values[2]), before);
  assert.equal(db.queries.some(row => /neighborhood_(?:acceptances|applications)|neighborhood_assessment/.test(row.sql)), false);
  assert.equal(db.queries.at(-1).sql, 'RELEASE SAVEPOINT homenode_custom_section_save');
});
for (const [name, options, message] of [
  ['signed', { status: 'signed' }, 'custom_appraisal_workfile_signed'],
  ['stale section revision', { revision: 3 }, 'custom_appraisal_section_revision_conflict'],
  ['foreign account', { account: false }, 'assignment_file_not_found'],
]) test(`actual v3 section save preserves ${name} refusal`, async () => {
  const db = writer(options);
  await assert.rejects(saveCustomAppraisalWorkfileSectionInTransaction(db.client, saveInput(fixture())), { message });
  assert.equal(db.writes.some(row => row.sql.startsWith('INSERT INTO app.custom_appraisal_workfile_sections (')
    || row.sql.startsWith('INSERT INTO app.custom_appraisal_workfile_section_history (')), false);
});
test('malformed v3 discovery is refused before the actual writer enters any transaction/query', async () => {
  const value = fixture(); value.pending_capture.discovery.radius_metres = 'latest';
  const client = { query: async () => assert.fail('database must not be reached') };
  await assert.rejects(saveCustomAppraisalWorkfileSectionInTransaction(client, saveInput(value)),
    /invalid_custom_neighborhood_workspace_checkpoint/);
});
