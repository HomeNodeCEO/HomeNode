import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCustomCohortSubjectRepository as repository } from '../src/services/neighborhoodAssessment/customCohortSubjectRepository.js';
import { createNeighborhoodCohortBlobRepository } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { canonicalAssessmentJson as canonical } from '../src/services/neighborhoodAssessment/contract.js';
import { inputs, setSection, setPublic, pg } from './fixtures/neighborhoodCustomMaterialInputsFixture.js';

const scopeOf = input => Object.fromEntries(['organization_id', 'report_file_id', 'assignment_file_id', 'account_id'].map(key => [key, input.target[key]]));
const row = value => ({ rowCount: 1, rows: [value] });
const absent = () => ({ rowCount: 0, rows: [] });
function fixture() {
  const input = inputs(); input.snapshot.effective_date = '2026-09-06';
  setPublic(input, { account: { account_id: input.target.account_id }, improvement: { living_area_sqft: 2000 } });
  setSection(input, 1, '{"main_improvement":{"living_area_sqft":2100.00},"review_note":"keep me"}');
  const state = { input, caseDate: '2026-09-06', status: 'draft', signedAt: null, signed: false,
    calls: [], missing: null, db: new Map(), transforms: {}, error: null };
  const client = { release() { throw new Error('repository must not release'); }, async query(sql, params) {
    const tag = sql.match(/\/\* (?:custom-cohort-subject|neighborhood-cohort-blob):([a-z-]+) \*\//)?.[1];
    assert.ok(tag, sql); state.calls.push({ tag, sql, params });
    if (state.error?.tag === tag) throw state.error.value;
    if (state.missing === tag) return absent();
    const t = state.input.target;
    let value;
    switch (tag) {
      case 'assignment': value = { id: t.assignment_file_id }; break;
      case 'workfile': value = { status: state.status, signed_at: state.signedAt }; break;
      case 'signature': value = { present: state.signed }; break;
      case 'report': value = { appraisal_case_id: t.appraisal_case_id, subject_snapshot_id: t.subject_snapshot_id }; break;
      case 'case': value = { effective_date: state.caseDate }; break;
      case 'snapshot': value = { original_json: JSON.stringify(state.input.snapshot) }; break;
      case 'sections': value = { original_json: JSON.stringify(state.input.sections) }; break;
      case 'history-target': value = { id: t.report_file_id }; break;
      case 'insert': {
        const [org, hash, bytes, text] = params, key = `${org}:${hash}`;
        if (state.db.has(key)) return absent();
        const stored = { content_sha256: hash, canonical_utf8_bytes: bytes, canonical_utf8: text };
        state.db.set(key, stored); return row(stored);
      }
      case 'read': return state.db.has(`${params[0]}:${params[1]}`) ? row(state.db.get(`${params[0]}:${params[1]}`)) : absent();
      default: assert.fail(tag);
    }
    return row(state.transforms[tag] ? state.transforms[tag](value) : value);
  } };
  return { state, client, repo: repository(client, canonical(scopeOf(input))) };
}
test('Custom retained subject reads actual scoped rows in fixed NOWAIT order and replays exact bytes', async () => {
  const { state, repo } = fixture(), ref = await repo.capture();
  assert.deepEqual(state.calls.slice(0, 7).map(c => c.tag), ['assignment', 'workfile', 'signature', 'report', 'case', 'snapshot', 'sections']);
  for (const c of state.calls.slice(0, 7).filter(c => c.tag !== 'signature')) assert.match(c.sql, /FOR (?:UPDATE|SHARE) NOWAIT/);
  assert.deepEqual(state.calls[0].params, [state.input.target.organization_id, state.input.target.assignment_file_id, state.input.target.account_id]);
  const loaded = await repo.load(ref);
  assert.equal(loaded.usage, 'retained_subject_inputs_only');
  assert.equal(loaded.effective_date, '2026-09-06');
  assert.equal(loaded.original_snapshot.pg_row_json, JSON.stringify(state.input.snapshot));
  assert.equal(loaded.original_sections.pg_reads_json, JSON.stringify(state.input.sections));
  assert.equal(loaded.snapshot.subject_data.custom_property_snapshot.improvement.living_area_sqft, 2000);
  assert.equal(loaded.material.assignment_sections.property_characteristics.projection.main_improvement.value.living_area_sqft.value, 2100);
  assert.equal(loaded.material.retained_public.improvement.value.living_area_sqft.value, 2000);
  assert.deepEqual(await repo.capture(), ref);
  assert.equal(state.db.size, 5);
});
test('history uses original snapshot and original section rows after live pointers and material change', async () => {
  const { state, repo } = fixture(), ref = await repo.capture(), original = await repo.load(ref);
  state.input.target.subject_snapshot_id = '10000000-0000-4000-8000-000000000099';
  state.input.snapshot.id = state.input.target.subject_snapshot_id;
  setSection(state.input, 1, '{"main_improvement":{"living_area_sqft":5000}}');
  state.input.snapshot.effective_date = state.caseDate = '2026-09-07';
  state.calls.length = 0;
  assert.deepEqual(await repo.load(ref), original);
  assert.equal(state.calls[0].tag, 'history-target');
  assert.ok(state.calls.slice(1).every(c => c.tag === 'read'), 'history never reads mutable core/sections');
  const next = await repo.capture();
  assert.notEqual(next.content_sha256, ref.content_sha256);
  assert.deepEqual(await repo.load(ref), original);
});
test('retention needs an existing editable exact target, but history needs no draft lifecycle', async () => {
  for (const missing of ['assignment', 'workfile', 'report', 'case', 'snapshot']) {
    const { state, repo } = fixture(); state.missing = missing;
    await assert.rejects(repo.capture(), /custom_cohort_subject_not_found/);
    assert.equal(state.db.size, 0);
  }
  for (const change of [{ status: 'signed' }, { status: 'archived' }, { signedAt: '2026-09-06' }, { signed: true }]) {
    const { state, repo } = fixture(), ref = await repo.capture(); Object.assign(state, change);
    await assert.rejects(repo.capture(), /protected_workfile/);
    assert.equal((await repo.load(ref)).target.account_id, state.input.target.account_id);
    state.missing = 'history-target'; await assert.rejects(repo.load(ref), /not_found/);
  }
});
test('effective date must be explicit, valid and agreeing, without filling or repairing either row', async () => {
  for (const [caseDate, snapshotDate, expected] of [[null, '2026-09-06', '2026-09-06'], ['2026-09-06', null, '2026-09-06'],
    [null, null, null], ['2026-09-05', '2026-09-06', null], ['2026-02-30', null, null], ['infinity', null, null]]) {
    const { state, repo } = fixture(); state.caseDate = caseDate; state.input.snapshot.effective_date = snapshotDate;
    if (expected) assert.equal((await repo.load(await repo.capture())).effective_date, expected);
    else { await assert.rejects(repo.capture(), /effective_date_unresolved/); assert.equal(state.db.size, 0); }
  }
});
test('primitive scopes reject duplicates, unsafe identifiers and unsupported shape before database activity', () => {
  const { client, state } = fixture(), scope = scopeOf(state.input);
  for (const value of [scope, '{}', JSON.stringify({ ...scope, assignment_file_id: 42 }),
    JSON.stringify({ ...scope, assignment_file_id: '9223372036854775808' }), JSON.stringify({ ...scope, assignment_file_id: '42\n' }),
    JSON.stringify({ ...scope, report_file_id: scope.report_file_id + '\n' }), JSON.stringify({ ...scope, account_id: ' x' }),
    JSON.stringify({ ...scope, ready: true }), canonical(scope).replace('{', '{"account_id":"x",')]) {
    assert.throws(() => repository(client, value), /custom_cohort_subject_/);
  }
  assert.throws(() => repository({ query() {} }, canonical(scope)), /caller_client_required/);
  assert.equal(state.calls.length, 0);
});
test('original numeric spellings stay in raw section text and unsupported complete snapshots fail closed', async () => {
  const { state, repo } = fixture();
  setSection(state.input, 1, '{"main_improvement":{"year_built":1990.0},"unused":1e999999}');
  const loaded = await repo.load(await repo.capture());
  assert.ok(loaded.original_sections.pg_reads_json.includes('1e999999'));
  assert.equal(loaded.material.assignment_sections.property_characteristics.projection.main_improvement.value.year_built.value, 1990);
  for (const text of ['{"custom_property_snapshot":{},"unsafe":9007199254740993}', '{"custom_property_snapshot":{},"x":1,"x":2}']) {
    const next = fixture(); next.state.input.snapshot.subject_data = pg(text);
    await assert.rejects(next.repo.capture(), /unsupported_inputs/); assert.equal(next.state.db.size, 0);
  }
});
test('bounded full inputs reject truncation, oversized strings and expanded wrappers before any insertion', async () => {
  for (const tag of ['snapshot', 'sections']) for (const text of [null, ' '.repeat(1500001)]) {
    const { state, repo } = fixture(); state.transforms[tag] = () => ({ original_json: text });
    await assert.rejects(repo.capture(), /input_limit/); assert.equal(state.db.size, 0);
  }
  const { state, repo } = fixture();
  setSection(state.input, 1, JSON.stringify({ unused: '\\'.repeat(370000) }));
  await assert.rejects(repo.capture());
  assert.equal(state.db.size, 0, 'JSON-escaped retention wrappers must all pass before inserts');
});
test('history rejects foreign targets, missing references and content-valid but semantically substituted evidence', async () => {
  const { state, repo, client } = fixture(), ref = await repo.capture();
  const blobs = createNeighborhoodCohortBlobRepository(client, state.input.target.organization_id);
  const original = JSON.parse(await blobs.get(ref.content_sha256, ref.canonical_utf8_bytes));
  const otherScope = { ...scopeOf(state.input), report_file_id: '10000000-0000-4000-8000-000000000098' };
  await assert.rejects(repository(client, canonical(otherScope)).load(ref), /target_mismatch/);
  await assert.rejects(repository(client, canonical({ ...otherScope, organization_id: otherScope.report_file_id })).load(ref), /missing_evidence/);
  for (const change of [
    { material_input: await blobs.put('{"wrong":true}') },
    { snapshot_evidence: await blobs.put('{"wrong":true}') },
    { effective_date: '2026-09-08' },
    { original_section_reads: { content_sha256: 'a'.repeat(64), canonical_utf8_bytes: '2' } },
    { ready: true },
  ]) {
    const altered = await blobs.put(canonical({ ...original, ...change }));
    await assert.rejects(repo.load(altered), /custom_cohort_subject_/);
  }
});
test('database failures propagate to transaction owner; repository never commits, retries, fetches or grants', async () => {
  for (const tag of ['assignment', 'report', 'snapshot', 'sections', 'insert']) {
    const { state, repo } = fixture(), error = Object.assign(new Error('synthetic database failure'), { code: '55P03' });
    state.error = { tag, value: error }; await assert.rejects(repo.capture(), actual => actual === error);
    assert.equal(state.calls.filter(c => c.tag === tag).length, 1);
  }
  const source = await readFile(new URL('../src/services/neighborhoodAssessment/customCohortSubjectRepository.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:BEGIN|COMMIT|ROLLBACK|CREATE TABLE|ALTER TABLE|DELETE FROM|UPDATE app\.)\b|fetch\(|\.connect\(/);
  assert.match(source, /octet_length\(value\)<=[\s\S]*original_json/);
});
