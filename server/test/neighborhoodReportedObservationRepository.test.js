import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assessmentEvidenceDigest, buildNeighborhoodAssessment, buildNeighborhoodAttachment, canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { neighborhoodMemberContentDigest as contentDigest, neighborhoodMemberSetDigest as setDigest,
  prepareNeighborhoodPublication as prepare, createNeighborhoodAssessmentRepository as repository } from '../src/services/neighborhoodAssessment/assessmentRepository.js';
import { neighborhoodAssessmentFixture, neighborhoodTargetFixture } from './fixtures/neighborhoodAssessmentFixture.js';
import { reportedObservationAssessmentFixture } from './fixtures/reportedObservationAssessmentFixture.js';
import { REPORTED_OBSERVATION_PROFILE_ID } from '../src/services/neighborhoodAssessment/reportedObservationContract.js';
import { assertNeighborhoodJsonbStorage } from '../src/services/neighborhoodAssessment/jsonbStorage.js';

const PROFILE = Object.freeze({ contract_version: 2, profile_id: REPORTED_OBSERVATION_PROFILE_ID });
const clone = value => structuredClone(value), sha = text => createHash('sha256').update(text).digest('hex');
const legacyMembers = () => ['property', 'canonical_transaction', 'allocated_property_sale', 'listing'].map((member_unit, i) => ({
  population_id: `p${i}`, member_id: member_unit === 'property' ? 'A' : `m${i}`, member_unit,
  account_ids: member_unit === 'canonical_transaction' ? ['B', 'A'] : ['A'],
  member_data: { source_refs: ['source-z', 'source-a'], literal: 'legacy', value: 123.456 } }));
const member = (unit = 'source_record', id = 'batch:receipt', accounts = ['B', 'A']) => ({ population_id: 'observations',
  member_id: id, member_unit: unit, account_ids: accounts, member_data: { source_refs: ['captured-source'], reported_price: '9007199254740993.125' } });
const v2 = () => reportedObservationAssessmentFixture();
function refreshCaptures(f) {
  for (const population of f.input.populations) {
    const capture = f.sources.find(s => s.payload.capture_type === 'neighborhood_population_members_v2' && s.payload.population_id === population.id);
    capture.payload.member_content_sha256 = contentDigest(f.members.filter(m => m.population_id === population.id), PROFILE);
    f.input.source_snapshots.find(s => s.id === capture.id).content_sha256 = assessmentEvidenceDigest(capture.payload);
  }
}
function reconcileFixturePopulation(f, id) {
  const p = f.input.populations.find(p => p.id === id), rows = f.members.filter(m => m.population_id === id);
  p.member_count = rows.length; p.unique_account_count = new Set(rows.flatMap(m => m.account_ids)).size;
  p.account_link_count = rows.reduce((sum, m) => sum + m.account_ids.length, 0); p.member_set_sha256 = setDigest(rows.map(m => m.member_id));
  for (const statistic of f.input.statistics.filter(s => s.population_id === id)) {
    statistic.observed_count = rows.length; statistic.denominator_count = rows.length;
    if (statistic.estimator === 'count') statistic.value = rows.length;
    else if (!rows.length) Object.assign(statistic, { value: null, status: 'unsupported', estimator: 'unsupported', reason: 'synthetic_empty_population' });
  }
  refreshCaptures(f);
}
// Query choreography/parameters only, not PostgreSQL constraint or lock proof.
const JOB = '80000000-0000-4000-8000-000000000001', TOKEN = '90000000-0000-4000-8000-000000000001';
const CLAIM = { id: JOB, claim_token: TOKEN, attempts: 1 }, result = (rows = [], rowCount = rows.length) => ({ rows, rowCount });
function fakePool(f, handlers = {}) {
  const assessment = buildNeighborhoodAssessment(f.input), calls = [];
  const head = { id: assessment.id, ...assessment.scope, next_revision: 3, current_revision: 2, requested_job_id: JOB, request_generation: 1 };
  const job = { id: JOB, assessment_id: head.id, input_signature_sha256: assessment.input_signature_sha256,
    effective_date: assessment.effective_date, data_cutoff: assessment.data_cutoff };
  let connects = 0, releases = 0;
  const query = async (sql, params = []) => {
    const tag = sql.match(/\/\* neighborhood:([a-z-]+) \*\//)?.[1] ?? sql.trim(); calls.push({ tag, sql, params: clone(params) });
    if (Object.hasOwn(handlers, tag)) return handlers[tag](params, sql);
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(tag) || tag.startsWith('SET LOCAL')) return result();
    if (tag === 'scope') return result([{ case_date: assessment.effective_date, snapshot_date: assessment.effective_date, effective_date: assessment.effective_date }]);
    if (tag === 'job-head') return result([{ assessment_id: head.id }]);
    if (tag === 'lock-head') return result([head]);
    if (tag === 'publication-fence') return result([job]);
    if (['revision', 'source', 'population', 'members', 'publish', 'promote', 'finish'].includes(tag)) return result([], 1);
    throw new Error(`Unexpected synthetic SQL tag: ${tag}`);
  };
  return { calls, head, job, query, get connects() { return connects; }, get releases() { return releases; },
    async connect() { connects++; return { query, release() { releases++; } }; } };
}

test('pinned v1 member, assessment, Custom and UAD attachment hashes remain byte-identical', () => {
  const members = legacyMembers(), assessment = buildNeighborhoodAssessment(neighborhoodAssessmentFixture());
  assert.equal(contentDigest(members), 'b6fb3d81a8b7e5417561ba5d822ef235ab12cc079b5530e0e6ad737c4e5c20d4');
  assert.equal(contentDigest(members, { contract_version: 1 }), contentDigest(members));
  assert.equal(assessment.evidence_digest_sha256, 'ed3270b1be558fee346ecfa2ced5585835b4d2feb09eb0f70ae31557520a591b');
  assert.equal(assessmentEvidenceDigest(buildNeighborhoodAttachment(assessment, neighborhoodTargetFixture('custom_appraisal'))),
    '9136d4dfce5aebf3ff7a38754221a34210b9084b06e8ed1e4812e3310a8291e3');
  assert.equal(assessmentEvidenceDigest(buildNeighborhoodAttachment(assessment, neighborhoodTargetFixture())),
    'c9f6749e4dc9159781a1069448ce00d9e3ede5e0e107b316cabe28babf8fe195');
});
test('v2 member digest explicitly binds installed profile, preserves full matches, and normalizes without mutation', () => {
  const rows = [member(), member('account', 'A', ['A'])], before = clone(rows);
  const normalized = clone(rows).map(row => ({ ...row, account_ids: [...row.account_ids].sort() })).sort((a, b) => a.member_id < b.member_id ? -1 : 1);
  assert.equal(contentDigest(rows, PROFILE), sha(canonicalAssessmentJson({ ...PROFILE, members: normalized })));
  assert.equal(contentDigest([...rows].reverse(), PROFILE), contentDigest(rows, PROFILE)); assert.deepEqual(rows, before);
  const changed = clone(rows); changed[0].account_ids.push('C');
  assert.notEqual(contentDigest(changed, PROFILE), contentDigest(rows, PROFILE));
  assert.equal(setDigest(changed.map(m => m.member_id)), setDigest(rows.map(m => m.member_id)));
  changed[0].member_data.reported_price = '9007199254740993.126';
  assert.notEqual(contentDigest(changed, PROFILE), contentDigest(rows, PROFILE));
});
test('even empty v2 members have a domain-separated digest; v1 empty remains canonical []', () => {
  assert.equal(contentDigest([]), sha('[]'));
  assert.equal(contentDigest([], PROFILE), sha(canonicalAssessmentJson({ ...PROFILE, members: [] })));
  assert.notEqual(contentDigest([], PROFILE), contentDigest([]));
});
for (const profile of [null, {}, { contract_version: '2', profile_id: REPORTED_OBSERVATION_PROFILE_ID }, { contract_version: 2 },
  { contract_version: 2, profile_id: 'unknown' }, { ...PROFILE, authority: 'verified' }, { contract_version: 3 }, { contract_version: 1, profile_id: REPORTED_OBSERVATION_PROFILE_ID }])
  test(`member digest refuses unknown/mixed profile ${JSON.stringify(profile)}`, () => assert.throws(() => contentDigest([], profile), /member_profile/));
for (const unit of ['account', 'source_record']) test(`legacy default and explicit v1 refuse ${unit}`, () => {
  const row = member(unit, 'A', ['A']);
  assert.throws(() => contentDigest([row]), /member_unit/); assert.throws(() => contentDigest([row], { contract_version: 1 }), /member_unit/);
});
for (const unit of ['property', 'canonical_transaction', 'allocated_property_sale', 'listing']) test(`v2 refuses v1 ${unit} members`, () => {
  assert.throws(() => contentDigest([member(unit, 'A', ['A'])], PROFILE), /member_unit/);
});
for (const [label, alter] of [
  ['account identity mismatch', r => { r.member_unit = 'account'; r.member_id = 'A'; r.account_ids = ['B']; }],
  ['account multi-link', r => { r.member_unit = 'account'; r.member_id = 'A'; }], ['no account', r => { r.account_ids = []; }],
  ['oversized source matches', r => { r.account_ids = Array.from({ length: 1001 }, (_, n) => `ACCOUNT-${n}`); }], ['duplicate account', r => { r.account_ids = ['A', 'A']; }],
  ['blank account', r => { r.account_ids = [' A']; }], ['oversized account', r => { r.account_ids = ['x'.repeat(101)]; }],
  ['member authority extra', r => { r.accepted = true; }], ['duplicate source', r => { r.member_data.source_refs = ['s', 's']; }],
]) test(`v2 member refuses ${label}`, () => { const r = member(); alter(r); assert.throws(() => contentDigest([r], PROFILE)); });
test('source-record five-account boundary is admitted without widening legacy listing limits', () => {
  assert.doesNotThrow(() => contentDigest([member('source_record', 'batch:receipt', ['E', 'B', 'D', 'A', 'C'])], PROFILE));
  assert.throws(() => contentDigest([member('listing', 'listing:1', ['A', 'B'])]), /member_accounts/);
  assert.doesNotThrow(() => contentDigest([member('canonical_transaction', 'event:1', ['A', 'B'])]));
});
test('member identity, source-reference, storage and publication capacity ceilings are unchanged', () => {
  assert.throws(() => contentDigest(new Array(100001), PROFILE), /member_limit/);
  assert.throws(() => contentDigest([member('source_record', 'x'.repeat(301))], PROFILE), /member_id/);
  const refs = member(); refs.member_data.source_refs = Array.from({ length: 1001 }, (_, i) => `source:${i}`);
  assert.throws(() => contentDigest([refs], PROFILE), /member_sources/);
  const tooBig = member(); tooBig.member_data.text = 'x'.repeat(1_500_000);
  assert.throws(() => contentDigest([tooBig], PROFILE));
  const invalid = member(); invalid.member_data.text = '\u0000'; assert.throws(() => contentDigest([invalid], PROFILE), /jsonb_storage_invalid/);
  const duplicate = member(); assert.throws(() => contentDigest([duplicate, duplicate], PROFILE), /duplicate_member/);
});

test('actual v2 contract fixture publication reconciles honest account/source-record units with no property aliases', () => {
  const f = v2(), before = canonicalAssessmentJson(f), saved = prepare(f.input, f.members, f.sources);
  assert.equal(saved.assessment.contract_version, 2); assert.equal(saved.assessment.methodology.configuration.profile_id, PROFILE.profile_id);
  for (const p of saved.assessment.populations) {
    const members = saved.members.filter(m => m.population_id === p.id);
    assert.equal(p.member_count, members.length); assert.equal(p.unique_account_count, new Set(members.flatMap(m => m.account_ids)).size);
    assert.equal(p.account_link_count, members.reduce((sum, m) => sum + m.account_ids.length, 0));
    assert.equal(Object.hasOwn(p, 'unique_property_count'), false); assert.equal(Object.hasOwn(p, 'property_link_count'), false);
    const captured = saved.sources.find(s => s.payload.population_id === p.id);
    assert.equal(captured.payload.capture_type, 'neighborhood_population_members_v2'); assert.equal(captured.payload.contract_version, 2);
    assert.equal(captured.payload.member_content_sha256, contentDigest(members, PROFILE));
  }
  assert.equal(canonicalAssessmentJson(f), before); assert.ok(Object.isFrozen(saved.members[0].member_data));
});
test('zero selected accounts/source records preserve explicit zero counters and versioned empty captures', () => {
  const f = v2(); f.members = []; f.input.selection.pocket_ids = [];
  for (const p of f.input.populations) { p.pocket_ids = []; reconcileFixturePopulation(f, p.id); }
  const saved = prepare(f.input, f.members, f.sources); assert.equal(saved.members.length, 0);
  assert.equal(saved.assessment.application_group.status, 'ready');
  for (const p of saved.assessment.populations) assert.deepEqual([p.member_count, p.unique_account_count, p.account_link_count], [0, 0, 0]);
  for (const s of saved.sources.filter(s => s.payload.capture_type)) assert.equal(s.payload.member_content_sha256, contentDigest([], PROFILE));
});
test('all 31 distinct source records retain their complete five-account sets without a target count or allocation', () => {
  const f = v2(), original = f.members.find(m => m.member_unit === 'source_record');
  f.members = f.members.filter(m => m.member_unit === 'account').concat(Array.from({ length: 31 }, (_, i) => ({
    ...clone(original), member_id: `batch:synthetic:receipt:${i + 1}`, account_ids: ['A', 'B', 'C', 'D', 'E'] })));
  reconcileFixturePopulation(f, original.population_id);
  const saved = prepare(f.input, f.members, f.sources), population = saved.assessment.populations.find(p => p.member_unit === 'source_record');
  assert.deepEqual([population.member_count, population.unique_account_count, population.account_link_count], [31, 5, 155]);
  assert.equal(saved.members.filter(m => m.member_unit === 'source_record').length, 31);
  assert.ok(saved.members.filter(m => m.member_unit === 'source_record').every(m => m.account_ids.length === 5));
});
test('incomplete population cannot store nonnull account counts contradicting its actual rows', () => {
  const f = v2(), p = f.input.populations.find(p => p.member_unit === 'source_record');
  p.completeness = 'incomplete'; p.reasons = ['synthetic_partial']; p.unique_account_count = 1;
  for (const s of f.input.statistics.filter(s => s.population_id === p.id)) Object.assign(s,
    { status: 'unsupported', estimator: 'unsupported', value: null, reason: 'synthetic_partial' });
  assert.doesNotThrow(() => buildNeighborhoodAssessment(f.input));
  assert.throws(() => prepare(f.input, f.members, f.sources), /population_account_counts/);
});
test('a correct v2 member capture cannot conceal a second mixed-version capture for the same population', () => {
  const f = v2(), original = f.sources.find(s => s.payload.capture_type === 'neighborhood_population_members_v2');
  const extra = { id: 'mixed-version-capture', payload: { ...original.payload, capture_type: 'neighborhood_population_members_v1' } };
  f.sources.push(extra); f.input.source_snapshots.push({ ...f.input.source_snapshots.find(s => s.id === original.id),
    id: extra.id, content_sha256: assessmentEvidenceDigest(extra.payload) });
  f.input.populations.find(p => p.id === extra.payload.population_id).source_refs.push(extra.id);
  assert.throws(() => prepare(f.input, f.members, f.sources), /member_content_mismatch/);
});
for (const [label, edit] of [
  ['missing member', f => { f.members.pop(); }], ['changed member ID', f => { f.members[0].member_id += ':changed'; }],
  ['mixed old unit', f => { f.members[0].member_unit = 'property'; }], ['missing population', f => { f.members[0].population_id = 'missing'; }],
  ['member source empty', f => { f.members[0].member_data.source_refs = []; }], ['member source unknown', f => { f.members[0].member_data.source_refs = ['missing']; }],
  ['changed row observation', f => { f.members[0].member_data.changed = true; }],
  ['changed source bytes', f => { f.sources[0].payload.changed = true; }], ['repeated source', f => { f.sources.push(f.sources[0]); }],
  ['legacy property counter', f => { f.input.populations[0].unique_property_count = 1; }],
]) test(`v2 publication rejects ${label} before connecting`, async () => {
  const f = v2(), pool = fakePool(f); edit(f);
  await assert.rejects(repository(pool).publish(CLAIM, f.input, f.members, f.sources)); assert.equal(pool.connects, 0);
});
for (const [label, edit] of [
  ['version', p => { p.contract_version = 1; }], ['profile', p => { p.profile_id = 'other'; }],
  ['capture type', p => { p.capture_type = 'neighborhood_population_members_v1'; }],
  ['unit', p => { p.member_unit = 'canonical_transaction'; }], ['digest', p => { p.member_content_sha256 = 'a'.repeat(64); }],
]) test(`a source-rehashed wrong v2 member capture ${label} still fails exact publication binding`, () => {
  const f = v2(), capture = f.sources.find(s => s.payload.capture_type === 'neighborhood_population_members_v2'); edit(capture.payload);
  f.input.source_snapshots.find(s => s.id === capture.id).content_sha256 = assessmentEvidenceDigest(capture.payload);
  assert.throws(() => prepare(f.input, f.members, f.sources), /member_content_mismatch/);
});
test('v2 publication inserts null legacy typed counters and publishes only the newly fenced revision', async () => {
  const f = v2(), pool = fakePool(f), saved = await repository(pool).publish(CLAIM, f.input, f.members, f.sources);
  assert.equal(saved.assessment.revision, 3); assert.equal(saved.promoted, true);
  for (const call of pool.calls.filter(c => c.tag === 'population')) {
    assert.equal(call.params[5], null); assert.equal(call.params[6], null);
    const p = JSON.parse(call.params[9]); assert.equal(typeof p.unique_account_count, 'number'); assert.equal(typeof p.account_link_count, 'number');
    assert.equal(Object.hasOwn(p, 'unique_property_count'), false); assert.equal(Object.hasOwn(p, 'property_link_count'), false);
  }
  const stored = JSON.parse(pool.calls.find(c => c.tag === 'revision').params[4]); assert.deepEqual(stored, saved.assessment);
  assert.equal(pool.calls.at(-1).tag, 'COMMIT'); assert.equal(pool.connects, pool.releases);
});
test('v2 payloads still use bounded member batches without partial publication', async () => {
  const f = v2(); assert.ok(f.members.length >= 2);
  f.members.forEach(m => { m.member_data.synthetic_note = 'x'.repeat(800000); }); refreshCaptures(f);
  const pool = fakePool(f); await repository(pool).publish(CLAIM, f.input, f.members, f.sources);
  const batches = pool.calls.filter(c => c.tag === 'members').map(c => c.params[2]); assert.ok(batches.length > 1);
  assert.ok(batches.every(b => Buffer.byteLength(b) <= 1500000 && assertNeighborhoodJsonbStorage(JSON.parse(b)) <= 2000000));
  assert.deepEqual(batches.flatMap(b => JSON.parse(b).map(m => m.member_id)).sort(), f.members.map(m => m.member_id).sort());
});
test('v2 lost final publication fence rolls back all prior staged sources and members', async () => {
  for (const tag of ['publish', 'promote', 'finish']) {
    const f = v2(), pool = fakePool(f, { [tag]: () => result([], 0) });
    await assert.rejects(repository(pool).publish(CLAIM, f.input, f.members, f.sources), /publication_conflict|claim_lost/);
    assert.equal(pool.calls.at(-1).tag, 'ROLLBACK'); assert.equal(pool.calls.some(c => c.tag === 'COMMIT'), false);
    assert.equal(pool.connects, pool.releases); assert.ok(pool.calls.some(c => c.tag === 'members'));
  }
});
