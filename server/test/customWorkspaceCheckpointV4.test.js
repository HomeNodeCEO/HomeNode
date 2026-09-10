import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareNeighborhoodDiscoveryChoice } from '../src/services/neighborhoodAssessment/selectorInputProfile.js';
import { saveCustomAppraisalWorkfileSectionInTransaction } from '../src/services/customAppraisalWorkfiles.js';
import { prepareCustomNeighborhoodWorkspaceCheckpoint as prepare, readCustomNeighborhoodWorkspaceCheckpoint as read,
  CUSTOM_NEIGHBORHOOD_WORKSPACE_CHECKPOINT_LIMITS as LIMITS } from '../src/services/neighborhoodAssessment/customWorkspaceCheckpoint.js';

// Structural editor intent only: these identifiers are not registered captures,
// source permissions, installed city assets, or accepted report records.
const CONTEXT = { context_id: '10000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const OPERATION = '20000000-0000-4000-8000-000000000002';
const BATCH = { batch_id: '30000000-0000-4000-8000-000000000003', expected_review_revision: 9 };
const PERIOD = { start_date: '2024-01-01', end_date: '2024-12-31' };
const NEXT_PERIOD = { start_date: '2024-02-29', end_date: '2024-12-31' };
const copy = value => structuredClone(value);
const radius = (value = '8046.72') => ({ profile_id: 'custom-suburban-radius-v2', radius_metres: value });
const city = () => ({ profile_id: 'custom-city-polygon-v1',
  city: { geoid: '4899999', vintage: '1999-02-28', asset_sha256: 'b'.repeat(64) } });
const legacy = () => ({ workspace_version: 1,
  active: { context_ref: copy(CONTEXT), observation_period: copy(PERIOD),
    selection: { revision: 7, included_recorded_group_ids: [] } },
  pending_capture: { operation_id: OPERATION, observation_period: copy(NEXT_PERIOD) } });
const fixture = () => {
  const value = legacy(); value.workspace_version = 4; value.pending_capture.discovery = city(); return value;
};
function invalid(value, reason) {
  assert.throws(() => prepare(value), error => error.code === 'CUSTOM_NEIGHBORHOOD_WORKSPACE_CHECKPOINT_INVALID'
    && (!reason || error.reason === reason));
}
function frozen(value) {
  if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozen); }
}
function sameOperation() {
  const value = fixture(); value.active.discovery = city();
  value.pending_capture.operation_id = CONTEXT.context_id;
  value.pending_capture.observation_period = copy(PERIOD); return value;
}

test('v1/v2 and both pre-city v3 canonical hashes remain byte-identical', () => {
  const v1 = legacy(), v2 = { ...copy(v1), workspace_version: 2 };
  v2.pending_capture.private_sales_import = copy(BATCH);
  const v3 = { ...copy(v1), workspace_version: 3 }; v3.pending_capture.discovery = radius();
  const expanded = copy(v3); expanded.active.discovery = radius('16093.44');
  expanded.pending_capture.private_sales_import = copy(BATCH);
  // V3 hashes independently captured from the frozen W implementation before this change.
  for (const [input, digest] of [
    [v1, '154e8e19a44836819df7a5799f18085371019ff339f33c20e5ca7d29411af600'],
    [v2, '5e2a2142b7ec1f4458de9dbdf9341164c000c4f9ceda8a5a7df0d39ac1c385cf'],
    [v3, 'e5dafb6df6213a0b01f82806cf7a4c6f86643fc32c8c901f40c31733a33d9077'],
    [expanded, '2f3aa1a689b875e85a0ced90784176962963cfb494ba6d1f99301a8627fdd4ab'],
  ]) {
    const result = prepare(input); assert.deepEqual(result, input);
    assert.equal(createHash('sha256').update(canonicalAssessmentJson(result)).digest('hex'), digest);
  }
});

for (const privateImport of [false, true]) test(`legacy active survives explicit city pending, private=${privateImport}`, () => {
  const input = fixture(); if (privateImport) input.pending_capture.private_sales_import = copy(BATCH);
  const expected = copy(input), result = prepare(input); assert.deepEqual(result, expected); frozen(result);
  assert.equal(Object.hasOwn(result.active, 'discovery'), false);
  assert.equal(Object.hasOwn(result.pending_capture, 'private_sales_import'), privateImport);
  assert.deepEqual(result.active.selection.included_recorded_group_ids, []);
  assert.deepEqual(result.pending_capture.discovery, prepareNeighborhoodDiscoveryChoice(city()));
  input.pending_capture.discovery.city.asset_sha256 = 'c'.repeat(64);
  assert.deepEqual(result, expected, 'saved choices must be detached from caller mutation');
  const restored = read({ key: 'neighborhood_workspace', revision: 23, value: JSON.parse(canonicalAssessmentJson(result)) });
  assert.deepEqual(restored, { status: 'restored', section_revision: 23, checkpoint: result }); frozen(restored);
});

for (const metres of ['4828.032', '8046.72', '16093.44']) test(`v4 city active may transition to explicit ${metres} radius`, () => {
  const value = fixture(); value.active.discovery = city(); value.pending_capture.discovery = radius(metres);
  assert.deepEqual(prepare(value), value);
  assert.deepEqual(prepare(value).active.context_ref, CONTEXT);
});
test('v4 radius active may transition to city without changing the preceding selection', () => {
  const value = fixture(); value.active.discovery = radius();
  value.active.selection.included_recorded_group_ids = ['discovery:unassigned', `recorded-cad:${'d'.repeat(64)}`];
  assert.deepEqual(prepare(value), value);
});
test('saved city identity is syntax-bound, not restricted to the current registry or capture date', () => {
  const value = fixture(); value.active.discovery = city(); value.pending_capture = null;
  assert.equal(prepare(value).active.discovery.city.vintage, '1999-02-28');
  assert.equal(prepare(value).active.discovery.city.geoid, '4899999');
  value.active.discovery.city.vintage = '0001-01-01'; assert.deepEqual(prepare(value), value);
});
test('pending-only, completed city, and explicitly cleared v4 states remain distinct from absent', () => {
  const pending = fixture(); pending.active = null; assert.deepEqual(prepare(pending), pending);
  const completed = fixture(); completed.active.discovery = city(); completed.pending_capture = null;
  assert.deepEqual(read({ revision: 2147483647, value: completed }).checkpoint, completed);
  const cleared = { workspace_version: 4, active: null, pending_capture: null };
  assert.deepEqual(read({ revision: 3, value: cleared }), { status: 'restored', section_revision: 3, checkpoint: cleared });
  assert.deepEqual(read(undefined), { status: 'absent', section_revision: 0, checkpoint: null });
  assert.equal(read({ revision: 3, value: null }).status, 'invalid');
});
test('same UUID exact city and period replay is admitted independent of object key order', () => {
  const value = sameOperation(); value.pending_capture.discovery.city = {
    asset_sha256: 'b'.repeat(64), vintage: '1999-02-28', geoid: '4899999' };
  assert.deepEqual(prepare(value).active.discovery, prepare(value).pending_capture.discovery);
});
for (const [key, changed] of [['geoid', '4899998'], ['vintage', '1999-03-01'], ['asset_sha256', 'c'.repeat(64)]]) {
  test(`same operation cannot change city ${key}`, () => {
    const value = sameOperation(); value.pending_capture.discovery.city[key] = changed;
    invalid(value, 'operation_discovery_conflict');
  });
}
test('same operation cannot switch city/radius or reinterpret absent legacy discovery', () => {
  const value = sameOperation(); value.pending_capture.discovery = radius(); invalid(value, 'operation_discovery_conflict');
  value.pending_capture.discovery = city(); delete value.active.discovery; invalid(value, 'operation_discovery_conflict');
});
test('same UUID changed period retains the original study conflict, even when city matches', () => {
  const value = sameOperation(); value.pending_capture.observation_period.start_date = '2024-02-29';
  invalid(value, 'operation_study_conflict');
});
test('new operation permits different city identity and period without replacing active context', () => {
  const value = fixture(); value.active.discovery = city(); value.pending_capture.discovery.city.asset_sha256 = 'c'.repeat(64);
  assert.deepEqual(prepare(value), value);
});

for (const version of [1, 2, 3]) for (const position of ['active', 'pending_capture']) {
  test(`v${version} cannot admit city in ${position} after shared choice grammar widens`, () => {
    const value = legacy(); value.workspace_version = version;
    if (version === 2) value.pending_capture.private_sales_import = copy(BATCH);
    if (version === 3) value.pending_capture.discovery = radius();
    value[position].discovery = city(); invalid(value);
  });
}
test('v4 pending discovery is required, while legacy active discovery remains optional', () => {
  const value = fixture(); delete value.pending_capture.discovery; invalid(value, 'pending_capture');
  value.pending_capture.discovery = null; invalid(value, 'discovery');
});
for (const [name, change] of [
  ['unknown profile', value => { value.profile_id = 'custom-city-polygon-v2'; }],
  ['missing city', value => { delete value.city; }],
  ['null city', value => { value.city = null; }],
  ['array city', value => { value.city = []; }],
  ['missing geoid', value => { delete value.city.geoid; }],
  ['number geoid', value => { value.city.geoid = 4899999; }],
  ['non-Texas geoid', value => { value.city.geoid = '0699999'; }],
  ['short geoid', value => { value.city.geoid = '489999'; }],
  ['trimmed geoid', value => { value.city.geoid = ' 4899999'; }],
  ['numeric vintage', value => { value.city.vintage = 2024; }],
  ['invalid date', value => { value.city.vintage = '2023-02-29'; }],
  ['zero-year vintage', value => { value.city.vintage = '0000-01-01'; }],
  ['datetime vintage', value => { value.city.vintage = '2024-02-29T00:00:00Z'; }],
  ['uppercase digest', value => { value.city.asset_sha256 = 'B'.repeat(64); }],
  ['short digest', value => { value.city.asset_sha256 = 'b'.repeat(63); }],
  ['unknown city field', value => { value.city.name = 'Synthetic city'; }],
  ['geometry field', value => { value.city.geometry = { type: 'Polygon' }; }],
  ['radius alongside city', value => { value.radius_metres = '8046.72'; }],
  ['permission flag', value => { value.authorized = true; }],
]) test(`v4 refuses ${name} without fallback or normalization`, () => {
  for (const position of ['active', 'pending_capture']) {
    const value = fixture(); value[position].discovery = city(); change(value[position].discovery); invalid(value);
  }
});
test('city accessors, hidden fields, symbols and prototypes are refused before executing user code', () => {
  let invoked = 0;
  for (const field of ['profile_id', 'city']) {
    const value = fixture(); Object.defineProperty(value.pending_capture.discovery, field,
      { enumerable: true, get() { invoked++; return city()[field]; } }); invalid(value, 'discovery.non_data_property');
  }
  for (const field of ['geoid', 'vintage', 'asset_sha256']) {
    const value = fixture(); Object.defineProperty(value.pending_capture.discovery.city, field,
      { enumerable: true, get() { invoked++; return city().city[field]; } }); invalid(value, 'discovery.city.non_data_property');
    const hidden = fixture(); Object.defineProperty(hidden.pending_capture.discovery.city, field,
      { enumerable: false, value: city().city[field] }); invalid(hidden);
  }
  const symbol = fixture(); symbol.pending_capture.discovery.city[Symbol('grant')] = true; invalid(symbol);
  const prototype = fixture(); Object.setPrototypeOf(prototype.pending_capture.discovery.city, null); invalid(prototype);
  assert.equal(invoked, 0);
});
test('city checkpoints carry no actor/session, acceptance, source grant or raw evidence authority', () => {
  for (const field of ['actor_user_id', 'session_id', 'accepted', 'source_grant', 'raw_rows']) {
    for (const position of ['active', 'pending_capture', 'checkpoint']) {
      const value = fixture(); (position === 'checkpoint' ? value : value[position])[field] = true; invalid(value);
    }
  }
  const value = fixture(); value.active.private_sales_import = copy(BATCH); invalid(value, 'active');
});
test('v4 retains private-import exact revision, operation UUID, group and section bounds', () => {
  const value = fixture(); value.pending_capture.private_sales_import = { ...BATCH, expected_review_revision: 2147483647 };
  value.active.selection.included_recorded_group_ids = ['discovery:unassigned',
    ...Array.from({ length: 128 }, (_, index) => `recorded-cad:${index.toString(16).padStart(64, '0')}`)];
  const admitted = prepare(value); assert.equal(admitted.active.selection.included_recorded_group_ids.length, 129);
  assert.ok(Buffer.byteLength(canonicalAssessmentJson(admitted)) <= LIMITS.canonical_utf8_bytes);
  value.active.selection.included_recorded_group_ids.push(`recorded-cad:${'f'.repeat(64)}`); invalid(value, 'group_ids');
  value.active.selection.included_recorded_group_ids = [];
  value.pending_capture.private_sales_import.expected_review_revision++; invalid(value, 'private_sales_import');
  value.pending_capture.private_sales_import = copy(BATCH);
  for (const operation of ['latest', OPERATION.toUpperCase().replace('20000000', 'A0000000'), null]) {
    value.pending_capture.operation_id = operation; invalid(value, 'pending_capture.operation_id');
  }
  value.pending_capture.operation_id = OPERATION;
  for (const revision of [0, '1', 2147483648]) assert.equal(read({ revision, value }).status, 'invalid');
});
for (const version of [0, 5, '4', null]) test(`v4 does not admit unsupported version ${String(version)}`, () => {
  const value = fixture(); value.workspace_version = version; invalid(value, 'workspace_version');
});

// Actual existing section writer with bounded query fakes, not native database
// or concurrency evidence. The writer still owns its existing scope/status/CAS.
function writer({ revision = 2, status = 'draft', account = true } = {}) {
  const queries = [], writes = [];
  const client = { async query(statement, values = []) {
    const sql = statement.replace(/\s+/g, ' ').trim(); queries.push(sql);
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
  } }; return { client, queries, writes };
}
const saveInput = value => ({ accountId: 'synthetic-account', assignmentFileId: '41', sectionKey: 'neighborhood_workspace',
  sectionValue: value, expectedRevision: 2, saveReason: 'autosave', reviewer: 'Synthetic reviewer' });
test('actual section writer saves and reopens v4 through unchanged section/history CAS, not report acceptance', async () => {
  const db = writer(), value = fixture(); value.pending_capture.private_sales_import = copy(BATCH);
  const saved = await saveCustomAppraisalWorkfileSectionInTransaction(db.client, saveInput(value));
  assert.deepEqual(saved.value, value); assert.equal(saved.revision, 3);
  assert.deepEqual(read(saved).checkpoint, value);
  const history = db.writes.find(row => row.sql.startsWith('INSERT INTO app.custom_appraisal_workfile_section_history ('));
  assert.deepEqual(JSON.parse(history.values[2]), value);
  assert.equal(db.queries.some(sql => /neighborhood_(?:acceptances|applications)|neighborhood_assessment/.test(sql)), false);
  assert.equal(db.queries.at(-1), 'RELEASE SAVEPOINT homenode_custom_section_save');
});
for (const [name, options, message] of [
  ['signed', { status: 'signed' }, 'custom_appraisal_workfile_signed'],
  ['stale section revision', { revision: 3 }, 'custom_appraisal_section_revision_conflict'],
  ['foreign account', { account: false }, 'assignment_file_not_found'],
]) test(`v4 actual writer preserves ${name} refusal without section/history writes`, async () => {
  const db = writer(options);
  await assert.rejects(saveCustomAppraisalWorkfileSectionInTransaction(db.client, saveInput(fixture())), { message });
  assert.equal(db.writes.some(row => row.sql.startsWith('INSERT INTO app.custom_appraisal_workfile_sections (')
    || row.sql.startsWith('INSERT INTO app.custom_appraisal_workfile_section_history (')), false);
});
test('malformed city is refused before actual section writer reaches a query', async () => {
  const value = fixture(); value.pending_capture.discovery.city.asset_sha256 = 'latest';
  await assert.rejects(saveCustomAppraisalWorkfileSectionInTransaction({ query: async () => assert.fail('no query') }, saveInput(value)),
    /invalid_custom_neighborhood_workspace_checkpoint/);
});
