import assert from 'node:assert/strict';
import test from 'node:test';
import { saveCustomAppraisalWorkfileSection, saveCustomAppraisalWorkfileSectionInTransaction } from '../src/services/customAppraisalWorkfiles.js';
import { readCustomNeighborhoodWorkspaceCheckpoint } from '../src/services/neighborhoodAssessment/customWorkspaceCheckpoint.js';

const context = { context_id: '10000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const period = { start_date: '2024-01-01', end_date: '2024-12-31' };
const checkpoint = () => ({ workspace_version: 1, active: { context_ref: context, observation_period: period,
  selection: { revision: 5, included_recorded_group_ids: [] } }, pending_capture: null });
const input = value => ({ accountId: 'synthetic-account', assignmentFileId: '41', sectionKey: 'neighborhood_workspace',
  sectionValue: value, expectedRevision: 2, saveReason: 'autosave', reviewer: 'Synthetic reviewer' });

// Records the existing transaction writer's queries; it does not simulate
// PostgreSQL isolation or claim actual concurrent database verification.
function clientFor({ status = 'draft', revision = 2, accountPresent = true } = {}) {
  const events = [];
  const client = { async query(statement, params = []) {
    const sql = statement.replace(/\s+/g, ' ').trim(); events.push({ sql, params: structuredClone(params) });
    if (sql.startsWith('SAVEPOINT ') || sql.startsWith('RELEASE SAVEPOINT ')) return { rows: [] };
    if (sql.startsWith('SELECT assignment_file.id, assignment_file.file_number')) {
      assert.deepEqual(params, ['41', 'synthetic-account']);
      return { rows: accountPresent ? [{ id: '41', file_number: 'Synthetic 41' }] : [] };
    }
    if (sql.startsWith('SELECT status FROM app.custom_appraisal_workfiles')) return { rows: [{ status }] };
    if (sql.startsWith('SELECT revision FROM app.custom_appraisal_workfile_sections')) {
      assert.deepEqual(params, ['41', 'neighborhood_workspace']); return { rows: [{ revision }] };
    }
    if (sql.startsWith('INSERT INTO app.custom_appraisal_workfile_sections (')) return { rows: [{
      section_key: params[1], section_value: JSON.parse(params[2]), revision: params[3], updated_by: params[4],
      updated_at: '2026-09-09T00:00:00.000Z',
    }] };
    if (sql.startsWith('INSERT INTO app.custom_appraisal_workfiles (')
      || sql.startsWith('INSERT INTO app.custom_appraisal_workfile_section_history (')
      || sql.startsWith('UPDATE app.custom_appraisal_workfiles SET updated_at')
      || sql.startsWith('UPDATE app.assignment_files SET updated_at')) return { rows: [] };
    assert.fail(`Unexpected checkpoint query: ${sql}`);
  } };
  return { client, events };
}

test('malformed workspace intent is rejected before any schema, connection or transaction write', async () => {
  for (const value of [null, {}, { ...checkpoint(), geometry: {} },
    { ...checkpoint(), active: { ...checkpoint().active, statistics: { median: 1 } } },
    { ...checkpoint(), active: { ...checkpoint().active, selection: { revision: 1, included_recorded_group_ids: ['unknown'] } } }]) {
    const db = { async query() { assert.fail('database must not be reached'); }, async connect() { assert.fail('connection must not be reached'); } };
    for (const sectionKey of ['neighborhood_workspace', ' NEIGHBORHOOD_WORKSPACE ']) {
      await assert.rejects(saveCustomAppraisalWorkfileSection(db, { ...input(value), sectionKey }), /invalid_custom_neighborhood_workspace_checkpoint/);
      await assert.rejects(saveCustomAppraisalWorkfileSectionInTransaction(db, { ...input(value), sectionKey }), /invalid_custom_neighborhood_workspace_checkpoint/);
    }
  }
});

test('workspace intent uses the existing section/history writer and preserves an explicitly empty selection', async () => {
  const db = clientFor(), value = checkpoint(), before = structuredClone(value);
  const saved = await saveCustomAppraisalWorkfileSectionInTransaction(db.client, input(value));
  assert.deepEqual(value, before); assert.deepEqual(saved.value, before); assert.equal(saved.revision, 3);
  const restored = readCustomNeighborhoodWorkspaceCheckpoint(saved);
  assert.equal(restored.status, 'restored'); assert.equal(restored.section_revision, 3);
  assert.equal(restored.checkpoint.active.selection.revision, 5, 'selection revision is not the DB section revision');
  assert.deepEqual(restored.checkpoint.active.selection.included_recorded_group_ids, []);
  const history = db.events.find(e => e.sql.startsWith('INSERT INTO app.custom_appraisal_workfile_section_history ('));
  assert.deepEqual(history.params, ['41', 'neighborhood_workspace', JSON.stringify(before), 3, 'autosave', 'Synthetic reviewer']);
  assert.equal(db.events.some(e => /neighborhood_(?:acceptances|applications)|neighborhood_assessment/.test(e.sql)), false);
  assert.equal(db.events.at(-1).sql, 'RELEASE SAVEPOINT homenode_custom_section_save');
});

test('pending capture keeps the operation UUID and prior active context without becoming accepted evidence', async () => {
  const db = clientFor(), value = { ...checkpoint(), pending_capture: {
    operation_id: '20000000-0000-4000-8000-000000000002', observation_period: { start_date: '2023-01-01', end_date: '2024-12-31' },
  } };
  const saved = await saveCustomAppraisalWorkfileSectionInTransaction(db.client, input(value));
  assert.deepEqual(saved.value, value); assert.deepEqual(Object.keys(saved.value).sort(), ['active', 'pending_capture', 'workspace_version']);
});

test('checkpoint save detaches caller intent before yielding to database work', async () => {
  const db = clientFor(), value = structuredClone(checkpoint()), before = structuredClone(value);
  const query = db.client.query.bind(db.client);
  db.client.query = async (sql, params) => {
    if (sql.startsWith('SAVEPOINT ')) {
      value.active.selection.included_recorded_group_ids.push('discovery:unassigned');
      value.active.context_ref.context_sha256 = 'f'.repeat(64);
      value.pending_capture = { operation_id: '20000000-0000-4000-8000-000000000002', observation_period: period };
    }
    return query(sql, params);
  };
  const saved = await saveCustomAppraisalWorkfileSectionInTransaction(db.client, input(value));
  assert.deepEqual(saved.value, before);
  assert.notDeepEqual(value, before);
});

for (const [name, options, message] of [
  ['signed workfile', { status: 'signed' }, 'custom_appraisal_workfile_signed'],
  ['stale section revision', { revision: 3 }, 'custom_appraisal_section_revision_conflict'],
  ['different account', { accountPresent: false }, 'assignment_file_not_found'],
]) test(`workspace checkpoints retain ${name} protection`, async () => {
  const db = clientFor(options);
  await assert.rejects(saveCustomAppraisalWorkfileSectionInTransaction(db.client, input(checkpoint())), { message });
  assert.equal(db.events.some(e => e.sql.startsWith('INSERT INTO app.custom_appraisal_workfile_sections (')
    || e.sql.startsWith('INSERT INTO app.custom_appraisal_workfile_section_history (')), false);
});
