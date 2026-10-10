import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCustomCohortGroupWorkspaceSave as prepare } from '../src/services/neighborhoodAssessment/customCohortGroupWorkspaceSave.js';
import { saveCustomCohortGroupPendingCapture as pending,
  prepareCustomCohortGroupCaptureCompletion as complete,
  readCustomCohortFrozenSelectionWorkspaceTarget as frozenTarget } from '../src/services/neighborhoodAssessment/customCohortGroupWorkspaceSave.js';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { createCustomCohortOriginalAccountOwnerBudget as createOwnerBudget } from '../src/services/neighborhoodAssessment/customCohortOriginalAccountOwnerBudget.js';

// Strict query recording only. Native fixture checks exercise real rollback,
// competing connections, lost COMMIT acknowledgments and current-role reload.
const context = { context_id: '10000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const period = { start_date: '2024-01-01', end_date: '2024-12-31' };
const ref = { selection_version: 1, selection_revision: 1, selection_sha256: 'b'.repeat(64),
  manifest_ref: { content_sha256: 'c'.repeat(64), canonical_utf8_bytes: '1200' } };
const identity = { accountId: 'synthetic', assignmentFileId: '41', contextRef: context, expectedWorkspaceRevision: 2,
  expectedSelectionRef: null, operationId: '20000000-0000-4000-8000-000000000002',
  auth: { userId: '30000000-0000-4000-8000-000000000003' } };
const legacy = () => ({ workspace_version: 6, active: { context_ref: context, observation_period: period,
  selection: { revision: 1, included_recorded_group_ids: [] } }, pending_capture: null });
const v7 = () => ({ workspace_version: 7, active: { context_ref: structuredClone(context), observation_period: structuredClone(period),
  selection_ref: structuredClone(ref) }, pending_capture: null });
const selected = (status = 'stored') => ({ status, authority: 'not_established', operation_id: identity.operationId,
  context_ref: context, selection_ref: ref, included_recorded_group_ids: [] });
function database({ value = legacy(), revision = 2, status = 'draft', head = ref, absent = false } = {}) {
  const calls = [];
  const client = { release() { assert.fail('caller owns release'); }, async query(text, params = []) {
    const sql = text.replace(/\s+/g, ' ').trim(); calls.push({ sql, params: structuredClone(params) });
    if (sql.startsWith('/* custom-cohort-group-workspace:read */')) return absent ? { rowCount: 0, rows: [] }
      : { rowCount: 1, rows: [{ revision, value }] };
    if (sql.startsWith('/* custom-cohort-group-selection:transaction */')) return { rowCount: 1, rows: [{ transaction_id: '42' }] };
    if (sql.startsWith('/* custom-cohort-group-selection:target */')) return { rowCount: 1, rows: [context] };
    if (sql.startsWith('/* custom-cohort-group-selection:head */')) return head === null ? { rowCount: 0, rows: [] }
      : { rowCount: 1, rows: [{ selection_revision: String(head.selection_revision), selection_sha256: head.selection_sha256,
        manifest_content_sha256: head.manifest_ref.content_sha256, manifest_canonical_utf8_bytes: head.manifest_ref.canonical_utf8_bytes }] };
    if (sql.startsWith('SAVEPOINT ') || sql.startsWith('RELEASE SAVEPOINT ')) return { rows: [] };
    if (sql.startsWith('SELECT assignment_file.id, assignment_file.file_number')) return { rows: [{ id: '41', file_number: 'QA only' }] };
    if (sql.startsWith('INSERT INTO app.custom_appraisal_workfiles (')) return { rows: [] };
    if (sql.startsWith('SELECT status FROM app.custom_appraisal_workfiles')) return { rows: [{ status }] };
    if (sql.startsWith("SELECT revision, section_value->>'workspace_version'")) return absent ? { rows: [] }
      : { rows: [{ revision, workspace_version: String(value.workspace_version) }] };
    if (sql.startsWith('INSERT INTO app.custom_appraisal_workfile_sections (')) return { rows: [{
      section_key: params[1], section_value: JSON.parse(params[2]), revision: params[3], updated_by: params[4], updated_at: '2026-10-06T00:00:00Z',
    }] };
    if (sql.startsWith('INSERT INTO app.custom_appraisal_workfile_section_history (')) return { rows: [{ id: '11' }], rowCount: 1, command: 'INSERT' };
    if (sql.startsWith('UPDATE app.custom_appraisal_workfiles SET updated_at') || sql.startsWith('UPDATE app.assignment_files SET updated_at')) return { rows: [] };
    assert.fail(`unexpected workspace owner query ${sql}`);
  } };
  return { client, calls };
}
const writes = db => db.calls.filter(c => /INSERT INTO app.custom_appraisal_workfile_sections |INSERT INTO app.custom_appraisal_workfile_section_history /.test(c.sql));
const owned = (db, input = identity, discovery = null) => prepare({ client: db.client, input,
  observationPeriod: period, discovery, checkBudget() {} });

test('workspace saves a detached exact registered identity via existing quota/CAS/history writer; no separate COMMIT or report write', async () => {
  const db = database(), save = await owned(db), result = selected(), before = structuredClone(result);
  const saved = await save.save(result);
  assert.deepEqual(saved, { revision: 3, value: v7() }); assert.deepEqual(result, before);
  assert.ok(Object.isFrozen(saved.value.active.selection_ref.manifest_ref));
  assert.match(db.calls[0].sql, /FOR UPDATE NOWAIT$/); assert.equal(db.calls[0].params[2], 524288);
  assert.equal(writes(db).length, 2); assert.equal(writes(db)[0].params[1], 'neighborhood_workspace');
  assert.equal(writes(db)[0].params[4], identity.auth.userId);
  assert.ok(!db.calls.some(c => /^(BEGIN|COMMIT|ROLLBACK)$|neighborhood_acceptance|neighborhood_assessment/.test(c.sql)));
});

test('exact successor lost-ACK replay returns the saved checkpoint with no savepoint, write, history or revision advance', async () => {
  const db = database({ value: v7(), revision: 3 }); const save = await owned(db);
  assert.deepEqual(await save.save(selected('reused')), { revision: 3, value: v7() });
  assert.equal(db.calls.length, 1); assert.equal(writes(db).length, 0);
});

for (const [name, options, reason] of [
  ['later revision', { revision: 4 }, 'revision_changed'],
  ['older revision', { revision: 1 }, 'revision_changed'],
  ['legacy successor', { revision: 3 }, 'revision_changed'],
  ['absent active', { value: { workspace_version: 6, active: null, pending_capture: null } }, 'unavailable'],
  ['invalid active', { value: {} }, 'unavailable'],
  ['changed period', { value: { ...legacy(), active: { ...legacy().active, observation_period: { ...period, start_date: '2023-01-01' } } } }, 'study_changed'],
  ['changed context', { value: { ...legacy(), active: { ...legacy().active, context_ref: { ...context, context_sha256: 'd'.repeat(64) } } } }, 'study_changed'],
  ['pending capture', { value: { ...legacy(), pending_capture: { operation_id: '40000000-0000-4000-8000-000000000004', observation_period: period } } }, 'capture_pending'],
]) test(`workspace refuses ${name} before any write`, async () => {
  const db = database(options); await assert.rejects(owned(db), new RegExp(reason)); assert.equal(writes(db).length, 0);
});

test('v7 exact prior head mismatch and changed replay value cannot detach workspace from selection', async () => {
  const db = database({ value: v7() }); await assert.rejects(owned(db), /selection_changed/);
  const changed = v7(); changed.active.selection_ref.selection_sha256 = 'e'.repeat(64);
  const next = database({ value: changed, revision: 3 }), save = await owned(next);
  await assert.rejects(save.save(selected('reused')), /replay_changed/); assert.equal(writes(next).length, 0);
});

test('registered stored/reused status and exact operation/context are required; no fabricated successor is saved', async () => {
  for (const change of [{ status: 'partial' }, { authority: 'accepted' }, { operation_id: 'other' },
    { context_ref: { ...context, context_sha256: 'f'.repeat(64) } }]) {
    const db = database(), save = await owned(db);
    await assert.rejects(save.save({ ...selected(), ...change }), /selection_changed/); assert.equal(writes(db).length, 0);
  }
  const prior = database(), save = await owned(prior);
  await assert.rejects(save.save(selected('reused')), /replay_changed/); assert.equal(writes(prior).length, 0);
  const next = database({ value: v7(), revision: 3 }), successor = await owned(next);
  await assert.rejects(successor.save(selected()), /revision_changed/); assert.equal(writes(next).length, 0);
});

test('discovery comes from the exact authorized retained study, not the browser; signed workfile still refuses', async () => {
  const discovery = { profile_id: 'custom-suburban-radius-v2', radius_metres: '8046.72' };
  const db = database(), save = await owned(db, identity, discovery), result = await save.save(selected());
  assert.deepEqual(result.value.active.discovery, discovery);
  const mismatch = database({ value: { ...legacy(), active: { ...legacy().active, discovery } } });
  await assert.rejects(owned(mismatch), /study_changed/);
  const signed = database({ status: 'signed' }), s = await owned(signed);
  await assert.rejects(s.save(selected()), /custom_appraisal_workfile_signed/); assert.equal(writes(signed).length, 0);
});

const scope = json({ organization_id: identity.auth.userId, report_file_id: identity.operationId,
  assignment_file_id: identity.assignmentFileId, account_id: identity.accountId });
const nextContext = { ...context, context_id: '40000000-0000-4000-8000-000000000004', context_sha256: 'd'.repeat(64) };
const nextPeriod = { start_date: '2023-01-01', end_date: '2024-12-31' };
const capture = () => ({ operation_id: nextContext.context_id, observation_period: nextPeriod });
const transition = () => ({ ...identity, expectedWorkspaceCheckpoint: v7() });
const completion = () => ({ ...transition(), contextRef: nextContext,
  expectedWorkspaceCheckpoint: { ...v7(), pending_capture: capture() } });
const completeOwned = (db, input = completion(), settings = {}) => complete({ client: db.client, input, scopeJson: scope,
  observationPeriod: nextPeriod, discovery: null, privateSalesImport: null, checkBudget() {}, ...settings });
const frozenInput=()=>({...identity,operationId:nextContext.context_id,observationPeriod:structuredClone(nextPeriod)});
const frozenOwned=(db,input=frozenInput(),checkBudget=()=>{})=>frozenTarget({client:db.client,input,scopeJson:scope,checkBudget});

test('whole-owner executor preserves metadata-only prior-head reads without releasing its actual connection',async()=>{
  const value={...v7(),pending_capture:capture()},db=database({value}),client=createOwnerBudget(db.client,{checkBudget(){}});
  const result=await frozenTarget({client,input:frozenInput(),scopeJson:scope,checkBudget(){}});
  assert.deepEqual(result.workspace_checkpoint,value);
  assert.equal(db.calls.length,5,'workspace plus both transaction IDs, scoped target and current head share the executor');
  assert.equal(writes(db).length,0);
  assert.ok(!db.calls.some(c=>/neighborhood-cohort-blob|INSERT|UPDATE app\.|^(BEGIN|COMMIT|ROLLBACK)$/.test(c.sql)));
  assert.throws(()=>client.release(),/original_account_owner_transaction_owner_required/);
  assert.equal(db.calls.length,5);
  for(const head of [null,{...ref,selection_revision:2}]){
    const changed=database({value,head}),bounded=createOwnerBudget(changed.client,{checkBudget(){}});
    await assert.rejects(frozenTarget({client:bounded,input:frozenInput(),scopeJson:scope,checkBudget(){}}),/selection_changed/);
    assert.equal(writes(changed).length,0);
  }
});

test('frozen V2 selection target reads actual pending study and prior current head without carrying old groups or writing',async()=>{
  const value={...v7(),pending_capture:capture()},db=database({value});let checks=0;
  const result=await frozenOwned(db,{...frozenInput(),expectedWorkspaceCheckpoint:{forged:true}},()=>checks++);
  assert.equal(result.authority,'prior_workspace_target_only_not_new_selection');assert.equal(result.workspace_revision,2);
  assert.deepEqual(result.workspace_checkpoint,value);assert.notEqual(result.workspace_checkpoint,value);
  assert.ok(Object.isFrozen(result.workspace_checkpoint.pending_capture));assert.ok(checks>=4);
  const read=db.calls.find(c=>c.sql.startsWith('/* custom-cohort-group-workspace:read */'));
  assert.deepEqual(read.params,['41','neighborhood_workspace',524288]);assert.match(read.sql,/FOR UPDATE NOWAIT/);
  assert.equal(db.calls.filter(c=>c.sql.startsWith('/* custom-cohort-group-selection:head */')).length,1);
  assert.equal(writes(db).length,0);assert.ok(!db.calls.some(c=>/neighborhood-cohort-blob|report_files|ST_DWithin/.test(c.sql)));
  assert.equal(Object.hasOwn(result,'included_recorded_group_ids'),false);
  assert.equal(Object.hasOwn(result,'selection_ref'),false);
  value.pending_capture.operation_id=identity.operationId;assert.equal(result.workspace_checkpoint.pending_capture.operation_id,nextContext.context_id);
});
test('frozen V2 target permits a genuinely empty prior active editor but never absent, legacy, stale or different pending study',async()=>{
  const empty={workspace_version:7,active:null,pending_capture:capture()},db=database({value:empty});
  assert.deepEqual((await frozenOwned(db)).workspace_checkpoint,empty);assert.equal(writes(db).length,0);
  assert.ok(!db.calls.some(c=>c.sql.includes('custom-cohort-group-selection:')));
  for(const options of [{absent:true},{value:legacy()},{value:v7()},
    {value:{...empty,pending_capture:{...capture(),operation_id:identity.operationId}}},
    {value:{...empty,pending_capture:{...capture(),observation_period:period}}},
    {value:{...empty,pending_capture:{...capture(),discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}}}},
    {value:{...empty,pending_capture:{...capture(),private_sales_import:{batch_id:identity.operationId,expected_review_revision:1}}}},
    {value:{...v7(),active:{...v7().active,context_ref:nextContext},pending_capture:capture()}}]){
    const bad=database(options);await assert.rejects(frozenOwned(bad),/unavailable|study_changed/);assert.equal(writes(bad).length,0);
  }
});
test('frozen target refuses missing or changed prior head and binds exact discovery/private review with no caller authority',async()=>{
  const value={...v7(),pending_capture:capture()};
  for(const head of [null,{...ref,selection_revision:2},{...ref,selection_sha256:'e'.repeat(64)}]){
    const db=database({value,head});await assert.rejects(frozenOwned(db),/selection_changed/);assert.equal(writes(db).length,0);
  }
  const discovery={profile_id:'custom-suburban-radius-v2',radius_metres:'16093.44'},privateSalesImport={batch_id:identity.operationId,expected_review_revision:2},
    withPrivate={...value,pending_capture:{...capture(),discovery,private_sales_import:privateSalesImport}},db=database({value:withPrivate});
  assert.deepEqual((await frozenOwned(db,{...frozenInput(),discovery,privateSalesImport})).workspace_checkpoint,withPrivate);
  await assert.rejects(frozenOwned(db,{...frozenInput(),discovery,privateSalesImport:{...privateSalesImport,expected_review_revision:1}}),/study_changed/);
  assert.equal(writes(db).length,0);
});
test('frozen workspace target preserves owner budget interruption before SQL and during prior-head verification',async()=>{
  for(const at of [1,3]){const db=database({value:{...v7(),pending_capture:capture()}});let checks=0;
    await assert.rejects(frozenOwned(db,frozenInput(),()=>{if(++checks===at)throw Error('synthetic same owner deadline');}),/same owner deadline/);
    assert.equal(writes(db).length,0);if(at===1)assert.equal(db.calls.length,0);
  }
});

test('only explicit empty V7 intent at revision zero can bootstrap an actually absent workspace', async () => {
  const prior = { workspace_version: 7, active: null, pending_capture: null };
  const input = { ...transition(), expectedWorkspaceRevision: 0, expectedWorkspaceCheckpoint: prior };
  const db = database({ absent: true });
  const result = await pending({ client: db.client, input, scopeJson: scope, pendingCapture: capture(), checkBudget() {} });
  assert.equal(result.status, 'stored'); assert.equal(result.workspace.revision, 1);
  assert.equal(result.workspace.value.active, null); assert.deepEqual(result.workspace.value.pending_capture, capture());
  assert.equal(writes(db).length, 2); assert.ok(!db.calls.some(c => c.sql.includes('group-selection:')));
  for (const other of [transition(), { ...input, expectedWorkspaceCheckpoint: v7() }]) {
    const unavailable = database({ absent: true });
    await assert.rejects(pending({ client: unavailable.client, input: other, scopeJson: scope,
      pendingCapture: capture(), checkBudget() {} }), /unavailable/); assert.equal(writes(unavailable).length, 0);
  }
  const existing = database();
  await assert.rejects(pending({ client: existing.client, input, scopeJson: scope,
    pendingCapture: capture(), checkBudget() {} }), /revision_changed/); assert.equal(writes(existing).length, 0);
});

test('pending start/cancel retains the exact active identity; scoped metadata-only head fence and one history write', async () => {
  for (const [prior, target] of [[v7(), capture()], [{ ...v7(), pending_capture: capture() }, null]]) {
    const db = database({ value: prior });
    const result = await pending({ client: db.client, input: { ...transition(), expectedWorkspaceCheckpoint: prior },
      scopeJson: scope, pendingCapture: target, checkBudget() {} });
    assert.equal(result.status, 'stored'); assert.equal(result.workspace.revision, 3);
    assert.deepEqual(result.workspace.value.active, prior.active); assert.deepEqual(result.workspace.value.pending_capture, target);
    assert.equal(writes(db).length, 2);
    assert.ok(db.calls.some(c => c.sql.includes('custom-cohort-group-selection:target') && c.sql.endsWith('FOR SHARE NOWAIT')));
    assert.ok(!db.calls.some(c => /blob:|catalog|preview|acceptance|^(BEGIN|COMMIT)$/.test(c.sql)));
    const replay = database({ value: result.workspace.value, revision: 3 });
    assert.equal((await pending({ client: replay.client, input: { ...transition(), expectedWorkspaceCheckpoint: prior },
      scopeJson: scope, pendingCapture: target, checkBudget() {} })).status, 'reused');
    assert.equal(writes(replay).length, 0);
  }
});

test('pending transition refuses changed revision, workspace or detached current head without clearing active data', async () => {
  for (const options of [{ revision: 4 }, { head: null }, { head: { ...ref, selection_revision: 2 } },
    { value: { ...v7(), pending_capture: capture() } }]) {
    const db = database({ value: v7(), ...options });
    await assert.rejects(pending({ client: db.client, input: transition(), scopeJson: scope,
      pendingCapture: capture(), checkBudget() {} }), /revision_changed|study_changed|selection_changed/);
    assert.equal(writes(db).length, 0);
  }
});

test('capture completion saves only the exact registered new study and atomically replaces active with pending cleared', async () => {
  const input = completion(), db = database({ value: input.expectedWorkspaceCheckpoint });
  const save = await completeOwned(db, input), result = { ...selected(), context_ref: nextContext };
  const saved = await save.save(result);
  assert.equal(saved.revision, 3); assert.deepEqual(saved.value.active.context_ref, nextContext);
  assert.deepEqual(saved.value.active.observation_period, nextPeriod); assert.equal(saved.value.pending_capture, null);
  assert.deepEqual(saved.value.active.selection_ref, ref); assert.equal(writes(db).length, 2);
  const replay = database({ value: saved.value, revision: 3 }), again = await completeOwned(replay, input);
  assert.deepEqual(await again.save({ ...result, status: 'reused' }), saved); assert.equal(writes(replay).length, 0);
  await assert.rejects(again.save(result), /revision_changed/);
});

test('completion cannot relabel period, discovery, private import/review or old head; failures preserve pending', async () => {
  for (const settings of [{ observationPeriod: period }, { discovery: { profile_id: 'custom-suburban-radius-v2', radius_metres: '8046.72' } },
    { privateSalesImport: { batch_id: identity.operationId, expected_review_revision: 1 } }]) {
    const db = database({ value: completion().expectedWorkspaceCheckpoint });
    await assert.rejects(completeOwned(db, completion(), settings), /study_changed/); assert.equal(writes(db).length, 0);
  }
  for (const options of [{ head: null }, { revision: 4 }, { value: v7() }]) {
    const db = database({ value: completion().expectedWorkspaceCheckpoint, ...options });
    await assert.rejects(completeOwned(db), /selection_changed|revision_changed|study_changed/); assert.equal(writes(db).length, 0);
  }
  const input = completion(); input.expectedWorkspaceCheckpoint.pending_capture.private_sales_import = {
    batch_id: identity.operationId, expected_review_revision: 2 };
  const db = database({ value: input.expectedWorkspaceCheckpoint });
  await assert.rejects(completeOwned(db, input, { privateSalesImport: {
    batch_id: identity.operationId, expected_review_revision: 1 } }), /study_changed/);
  assert.equal(writes(db).length, 0);
});

test('completion replay is exact immediate successor only and never writes a fabricated stored/reused result', async () => {
  const input = completion(), value = { workspace_version: 7, active: { context_ref: nextContext,
    observation_period: nextPeriod, selection_ref: ref }, pending_capture: null };
  const changed = structuredClone(value); changed.active.selection_ref.selection_sha256 = 'e'.repeat(64);
  const db = database({ value: changed, revision: 3 }), save = await completeOwned(db, input);
  await assert.rejects(save.save({ ...selected('reused'), context_ref: nextContext }), /replay_changed/);
  assert.equal(writes(db).length, 0);
  const prior = database({ value: input.expectedWorkspaceCheckpoint }), fresh = await completeOwned(prior, input);
  await assert.rejects(fresh.save({ ...selected('reused'), context_ref: nextContext }), /replay_changed/);
  await assert.rejects(fresh.save({ ...selected(), context_ref: nextContext, authority: 'accepted' }), /selection_changed/);
  assert.equal(writes(prior).length, 0);
});
