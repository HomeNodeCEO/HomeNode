import test from 'node:test';
import assert from 'node:assert/strict';
import { customCohortRepositoryFixture as fixture } from './fixtures/customCohortRepositoryFixture.js';
import { setSection, setPublic } from './fixtures/neighborhoodCustomMaterialInputsFixture.js';

const matched = { status: 'matched', authority: 'not_established', changed_inputs: [] };
async function retained() {
  const f = fixture(), ref = await f.repo.capture();
  f.state.calls.length = 0;
  return { ...f, ref };
}

test('capture and comparison require server-observed READ COMMITTED visibility before target reads', async () => {
  for (const isolation of ['repeatable read', 'serializable', 'read uncommitted', undefined, null, '']) {
    for (const operation of ['capture', 'compareCurrent']) {
      const { state, repo, ref } = await retained();
      const before = state.db.size;
      state.transforms.transaction = row => ({ ...row, transaction_isolation: isolation });
      const invoke = operation === 'capture' ? () => repo.capture() : () => repo.compareCurrent(ref);
      await assert.rejects(invoke, /read_committed_transaction_required/);
      assert.deepEqual(state.calls.map(call => call.tag), ['transaction']);
      assert.equal(state.db.size, before);
    }
  }
});

test('fresh actual material comparison is read-only, fenced and explicitly not an authority grant', async () => {
  const { state, repo, ref } = await retained();
  const result = await repo.compareCurrent(ref);
  assert.deepEqual(result, matched);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.changed_inputs));
  assert.equal(state.db.size, 5);
  assert.deepEqual(state.calls.slice(0, 9).map(c => c.tag), ['transaction', 'assignment', 'workfile', 'signature', 'report', 'case', 'snapshot', 'section-fence', 'sections']);
  const sectionFence = state.calls.find(c => c.tag === 'section-fence');
  assert.match(sectionFence.sql, /WITH held AS MATERIALIZED/);
  assert.match(sectionFence.sql, /FOR SHARE NOWAIT/);
  assert.match(sectionFence.sql, /count\(\*\)/);
  assert.doesNotMatch(sectionFence.sql, /ANY\(|section_value|LIMIT/);
  assert.deepEqual(sectionFence.params, [state.input.target.assignment_file_id]);
  assert.equal(state.calls.filter(c => c.tag === 'insert').length, 0);
  assert.deepEqual(await repo.compareCurrent(ref), matched);
  assert.equal(state.db.size, 5);
});

test('note, output, row revision, save timestamps and actor-only changes do not invalidate physical inputs', async () => {
  const { state, repo, ref } = await retained();
  setSection(state.input, 1, '{"main_improvement":{"living_area_sqft":2100.0},"review_note":"new note","neighborhood_statistics":{"median":123}}');
  const row = state.input.sections[1].row;
  row.revision += 1; row.updated_at = '2026-09-07 00:00:00+00';
  row.last_applied_by_user_id = '90000000-0000-4000-8000-000000000009';
  state.input.snapshot.created_at = '2026-09-07 00:00:00+00';
  state.input.snapshot.created_by_user_id = row.last_applied_by_user_id;
  assert.deepEqual(await repo.compareCurrent(ref), matched);
  assert.equal(state.db.size, 5);
});

for (const [name, value] of [
  ['GLA', '{"main_improvement":{"living_area_sqft":2101}}'],
  ['age', '{"main_improvement":{"living_area_sqft":2100,"year_built":2000}}'],
  ['housing type', '{"main_improvement":{"living_area_sqft":2100},"housing_profile":{"housing_type":"duplex"}}'],
  ['null physical field', '{"main_improvement":{"living_area_sqft":null}}'],
  ['absent physical field', '{"main_improvement":{}}'],
  ['additional improvement', '{"main_improvement":{"living_area_sqft":2100},"additional_improvements":[{"number":1,"area_sqft":100}]}'],
]) test(`${name} changes with the same snapshot and editor revision are detected`, async () => {
  const { state, repo, ref } = await retained();
  setSection(state.input, 1, value);
  assert.deepEqual(await repo.compareCurrent(ref), { status: 'changed', authority: 'not_established', changed_inputs: ['material_inputs'] });
  assert.equal(state.db.size, 5);
});

test('land, subject location, legal/subdivision and roster changes are compared, not only improvements', async () => {
  for (const [index, text] of [[0, '{"land_detail":[{"line_number":1,"area_sqft":10000}]}'],
    [2, '{"property_location":{"city":"Garland"}}'], [2, '{"legal_description":{"lines":["Subdivision A"]}}']]) {
    const { state, repo, ref } = await retained(); setSection(state.input, index, text);
    assert.deepEqual((await repo.compareCurrent(ref)).changed_inputs, ['material_inputs']);
  }
});

test('snapshot replacement and effective date drift are independent from unchanged manual material', async () => {
  const { state, repo, ref } = await retained();
  state.input.target.subject_snapshot_id = state.input.snapshot.id = '90000000-0000-4000-8000-000000000009';
  state.input.target.snapshot_version = state.input.snapshot.snapshot_version = 2;
  state.input.snapshot.effective_date = state.caseDate = '2026-09-07';
  assert.deepEqual((await repo.compareCurrent(ref)).changed_inputs, ['snapshot_identity', 'effective_date', 'snapshot_evidence']);
  assert.equal(state.db.size, 5);
});

test('mutable public snapshot contents cannot hide behind the same snapshot identifier', async () => {
  const { state, repo, ref } = await retained();
  setPublic(state.input, { account: { account_id: state.input.target.account_id }, improvement: { living_area_sqft: 2001 } });
  assert.deepEqual((await repo.compareCurrent(ref)).changed_inputs, ['snapshot_evidence', 'material_inputs']);
  const original = await repo.load(ref);
  assert.equal(original.material.retained_public.improvement.value.living_area_sqft.value, 2000);
});

test('current validation refuses unresolved date, protected workfile, autocommit and missing original evidence', async () => {
  for (const change of [f => { f.state.caseDate = '2026-09-05'; }, f => { f.state.status = 'signed'; },
    f => { f.state.transforms.assignment = row => ({ ...row, transaction_id: '123456790' }); },
    f => { f.state.db.delete(`${f.state.input.target.organization_id}:${f.ref.content_sha256}`); }]) {
    const f = await retained(); change(f);
    await assert.rejects(f.repo.compareCurrent(f.ref), /effective_date_unresolved|protected_workfile|caller_transaction_required|missing_evidence/);
    assert.equal(f.state.calls.filter(c => c.tag === 'insert').length, 0);
  }
});

test('original lock/connection errors propagate, not a matched result or automatic retry', async () => {
  for (const tag of ['assignment', 'workfile', 'report', 'case', 'snapshot', 'section-fence', 'sections', 'read']) {
    const f = await retained(), error = Object.assign(new Error('synthetic lock'), { code: '55P03' });
    f.state.error = { tag, value: error };
    await assert.rejects(f.repo.compareCurrent(f.ref), actual => actual === error);
    assert.equal(f.state.calls.filter(c => c.tag === tag).length, 1);
  }
});
