import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { assessmentEvidenceDigest as evidenceDigest, canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { neighborhoodMemberContentDigest as contentDigest, neighborhoodMemberContentDigestBatches as contentBatches,
  neighborhoodMemberSetDigest as setDigest, prepareNeighborhoodPublication as prepare,
  prepareNeighborhoodPublicationBatches as publicationBatches } from '../src/services/neighborhoodAssessment/assessmentRepository.js';
import { REPORTED_OBSERVATION_PROFILE_ID } from '../src/services/neighborhoodAssessment/reportedObservationContract.js';
import { neighborhoodAssessmentFixture } from './fixtures/neighborhoodAssessmentFixture.js';
import { reportedObservationAssessmentFixture } from './fixtures/reportedObservationAssessmentFixture.js';

const PROFILE = Object.freeze({ contract_version: 2, profile_id: REPORTED_OBSERVATION_PROFILE_ID });
const GOLDENS = Object.freeze({
  1: { publication: '2d8126242d63ba07b31e85a7bedfdf002d22dac52bcf38b364ea48be0e9115e1',
    members: '3029b881c9a975473a482a293064661d599e01a322d0e259439752f60369e4ab' },
  2: { publication: 'eccac5c5dea62d2ddf94f6825c7127ad616c4ec8fa123b21371bec15def00915',
    members: '069563f893485157776907c85936ec768b47b81ae03658c15d56f0d6a753b65f' },
}); // Captured from the unchanged synchronous APIs before adding the bridges.
function fixture(version = 2) {
  if (version === 2) return reportedObservationAssessmentFixture();
  const input = neighborhoodAssessmentFixture(), sources = [{ id: 'fixture-source', payload: { fixture: 'neighborhood-v1' } }];
  const row = (population_id, member_unit, member_id, account_ids) => ({ population_id, member_unit, member_id, account_ids,
    member_data: { source_refs: ['fixture-source'], synthetic: true } });
  const members = [...['P1', 'P2', 'P3', 'P4'].map(id => row('stock-a', 'property', id, [id])),
    row('sales-a', 'canonical_transaction', 'T1', ['P1']), row('sales-a', 'canonical_transaction', 'T2', ['P1']),
    row('sales-a', 'canonical_transaction', 'T3', ['P2'])];
  for (const population of input.populations) {
    const id = `population-members:${population.id}`, payload = { capture_type: 'neighborhood_population_members_v1',
      population_id: population.id, member_unit: population.member_unit,
      member_content_sha256: contentDigest(members.filter(row => row.population_id === population.id)) };
    sources.push({ id, payload }); input.source_snapshots.push({ ...input.source_snapshots[0], id, content_sha256: evidenceDigest(payload) });
    population.source_refs.push(id);
  }
  return { input, members, sources };
}
function seal(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(seal); Object.freeze(value); }
  return value;
}
function assertFrozen(value) {
  if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(assertFrozen); }
}
function drain(iterator) {
  let checkpoints = 0;
  for (;;) {
    const step = iterator.next();
    if (step.done) return { value: step.value, checkpoints };
    assert.equal(step.value, undefined, 'checkpoints must never expose private members, source originals or partial results');
    checkpoints++;
  }
}
async function cooperative(iterator, check = () => {}) {
  try {
    for (;;) {
      check(); const step = iterator.next(); check();
      if (step.done) return step.value;
      assert.equal(step.value, undefined);
      await setImmediate();
    }
  } finally { iterator.return?.(); }
}
function refreshCaptures(f, profile) {
  for (const population of f.input.populations) {
    const source = f.sources.find(source => source.payload.population_id === population.id);
    source.payload.member_content_sha256 = contentDigest(f.members.filter(row => row.population_id === population.id), profile);
    f.input.source_snapshots.find(snapshot => snapshot.id === source.id).content_sha256 = evidenceDigest(source.payload);
  }
}
function expandedFixture(count) {
  const f = fixture(), prototype = f.members.find(row => row.member_unit === 'account');
  f.members = f.members.filter(row => row.member_unit !== 'account').concat(Array.from({ length: count }, (_, index) => ({
    ...structuredClone(prototype), member_id: `A-${String(index).padStart(5, '0')}`, account_ids: [`A-${String(index).padStart(5, '0')}`],
  })));
  const population = f.input.populations.find(population => population.id === prototype.population_id);
  const rows = f.members.filter(row => row.population_id === population.id);
  Object.assign(population, { member_count: count, unique_account_count: count, account_link_count: count,
    member_set_sha256: setDigest(rows.map(row => row.member_id)) });
  for (const statistic of f.input.statistics.filter(statistic => statistic.population_id === population.id)) {
    Object.assign(statistic, { observed_count: count, denominator_count: count, value: count });
  }
  refreshCaptures(f, PROFILE); return f;
}

for (const version of [1, 2]) test(`V${version} cooperative publication and content hashes match pre-change pinned originals`, async () => {
  const f = seal(fixture(version)), before = canonicalAssessmentJson(f), profile = version === 2 ? PROFILE : undefined;
  const original = prepare(f.input, f.members, f.sources), completed = drain(publicationBatches(f.input, f.members, f.sources));
  assert.equal(evidenceDigest(original), GOLDENS[version].publication);
  assert.equal(evidenceDigest(completed.value), GOLDENS[version].publication);
  assert.equal(contentDigest(f.members, profile), GOLDENS[version].members);
  assert.equal(drain(contentBatches(f.members, profile)).value, GOLDENS[version].members);
  assert.deepEqual(completed.value, original); assertFrozen(completed.value);
  assert.ok(completed.checkpoints > 10);
  assert.deepEqual(await cooperative(publicationBatches(f.input, f.members, f.sources)), original);
  assert.equal(canonicalAssessmentJson(f), before);
});

for (const count of [0, 1, 124, 125, 126, 250, 751]) test(`member normalization and hashing yield in 125-row chunks: ${count}`, () => {
  const prototype = fixture().members[0];
  const rows = seal(Array.from({ length: count }, (_, index) => ({ ...prototype, member_id: `A-${index}`, account_ids: [`A-${index}`] })));
  const completed = drain(contentBatches(rows, PROFILE));
  assert.equal(completed.checkpoints, 3 + 2 * Math.floor(count / 125));
  assert.equal(completed.value, contentDigest(rows, PROFILE));
});

test('normalization yields before reading the first member beyond its chunk, without emitting a partial digest', () => {
  const prototype = fixture().members[0];
  const rows = seal([...Array.from({ length: 125 }, (_, index) => ({ ...prototype, member_id: `A-${index}`, account_ids: [`A-${index}`] })), null]);
  const stages = contentBatches(rows, PROFILE);
  assert.deepEqual(stages.next(), { value: undefined, done: false });
  assert.throws(() => stages.next(), /invalid_member/);
  assert.deepEqual(stages.next(), { value: undefined, done: true });
});

test('751 accounts retain all members, population counters, source originals and postorder immutability across suspension', async () => {
  const f = seal(expandedFixture(751)), before = canonicalAssessmentJson(f), expected = prepare(f.input, f.members, f.sources);
  const completed = drain(publicationBatches(f.input, f.members, f.sources));
  assert.ok(completed.checkpoints >= 4 * Math.floor(751 / 125), 'normalization, both independent digest passes and final freeze stay chunked');
  let serviced = false;
  const pending = cooperative(publicationBatches(f.input, f.members, f.sources));
  setImmediate().then(() => { serviced = true; });
  assert.deepEqual(await pending, expected); assert.equal(serviced, true);
  assert.equal(completed.value.members.length, 752);
  assert.equal(completed.value.assessment.populations.find(population => population.id === 'accounts').member_count, 751);
  assert.deepEqual(completed.value.members.map(row => row.member_id), expected.members.map(row => row.member_id));
  assert.deepEqual(completed.value.sources, expected.sources);
  assertFrozen(completed.value); assert.equal(canonicalAssessmentJson(f), before);
});

for (const version of [1, 2]) test(`V${version} content normalization retains exact Unicode, decimal strings, numeric JSON and complete associations`, () => {
  const f = fixture(version), profile = version === 2 ? PROFILE : undefined;
  const row = f.members.find(row => row.member_unit === (version === 2 ? 'source_record' : 'canonical_transaction'));
  row.account_ids.reverse(); row.member_data.literal = { text: 'École 🏠', decimal: '9007199254740993.000000000001',
    scientific: 1e30, small: 1e-30, zero: -0, absent: null, empty: '', integer: 0 };
  refreshCaptures(f, profile);
  const expected = prepare(f.input, f.members, f.sources), before = canonicalAssessmentJson(f);
  seal(f);
  const saved = drain(publicationBatches(f.input, [...f.members].reverse(), [...f.sources].reverse())).value;
  assert.deepEqual(saved, expected);
  const kept = saved.members.find(member => member.member_id === row.member_id);
  assert.equal(kept.member_data.literal.decimal, '9007199254740993.000000000001');
  assert.equal(kept.member_data.literal.text, 'École 🏠');
  assert.deepEqual(kept.account_ids, [...row.account_ids].sort());
  assert.equal(canonicalAssessmentJson(f), before);
});

for (const version of [1, 2]) test(`V${version} cancellation at every checkpoint returns no partial publication and preserves retry parity`, async () => {
  const f = seal(fixture(version)), before = canonicalAssessmentJson(f), expected = prepare(f.input, f.members, f.sources);
  const checkpoints = drain(publicationBatches(f.input, f.members, f.sources)).checkpoints;
  for (let stop = 1; stop <= checkpoints; stop++) {
    const iterator = publicationBatches(f.input, f.members, f.sources);
    for (let index = 0; index < stop; index++) assert.deepEqual(iterator.next(), { value: undefined, done: false });
    assert.deepEqual(iterator.return(), { value: undefined, done: true });
    assert.deepEqual(iterator.next(), { value: undefined, done: true });
  }
  const failure = new Error('synthetic cancelled publication');
  let checks = 0;
  await assert.rejects(cooperative(publicationBatches(f.input, f.members, f.sources), () => {
    if (++checks === 9) throw failure;
  }), error => error === failure);
  assert.deepEqual(drain(publicationBatches(f.input, f.members, f.sources)).value, expected);
  assert.equal(canonicalAssessmentJson(f), before);
});

for (const version of [1, 2]) for (const [name, edit] of [
  ['missing member', f => f.members.pop()],
  ['extra member field', f => { f.members[0].private_override = true; }],
  ['unknown population', f => { f.members[0].population_id = 'foreign'; }],
  ['wrong member unit', f => { f.members[0].member_unit = 'invented'; }],
  ['duplicate member', f => { f.members.push(f.members[0]); }],
  ['empty associations', f => { f.members[0].account_ids = []; }],
  ['unknown source dependency', f => { f.members[0].member_data.source_refs = ['foreign']; }],
  ['changed member original', f => { f.members[0].member_data.changed = true; }],
  ['changed source original', f => { f.sources[0].payload.changed = true; }],
  ['missing source', f => f.sources.pop()],
  ['duplicate source', f => f.sources.push(f.sources[0])],
  ['invalid Unicode storage', f => { f.members[0].member_data.private_text = '\ud800'; }],
  ['invalid numeric storage', f => { f.members[0].member_data.number = Infinity; }],
]) test(`V${version} cooperative ${name} preserves exact synchronous refusal and no private checkpoint data`, () => {
  const f = fixture(version); edit(f);
  let original;
  try { prepare(f.input, f.members, f.sources); } catch (error) { original = error; }
  assert.ok(original);
  seal(f);
  assert.throws(() => drain(publicationBatches(f.input, f.members, f.sources)), error =>
    error.constructor === original.constructor && error.message === original.message && error.code === original.code);
});

test('rehashed but altered V2 capture profile or member digest still fails independent content verification', () => {
  for (const edit of [payload => { payload.member_content_sha256 = 'a'.repeat(64); },
    payload => { payload.contract_version = 1; }, payload => { payload.profile_id = 'foreign'; }]) {
    const f = fixture(), source = f.sources.find(source => source.payload.capture_type === 'neighborhood_population_members_v2');
    edit(source.payload); f.input.source_snapshots.find(snapshot => snapshot.id === source.id).content_sha256 = evidenceDigest(source.payload);
    seal(f);
    assert.throws(() => drain(publicationBatches(f.input, f.members, f.sources)), /member_content_mismatch/);
  }
});

test('member and publication list limits fail before the first checkpoint; profile remains strictly versioned', () => {
  const f = seal(fixture());
  for (const iterator of [contentBatches(new Array(100001), PROFILE),
    publicationBatches(f.input, new Array(100001), f.sources), publicationBatches(f.input, f.members, new Array(1001))]) {
    assert.throws(() => iterator.next(), /member_limit|publication_limit/);
  }
  for (const profile of [null, {}, { ...PROFILE, contract_version: 1 }, { ...PROFILE, authority: 'verified' },
    { ...PROFILE, profile_id: 'unknown' }]) assert.throws(() => contentBatches([], profile).next(), /member_profile/);
});

test('per-row canonical and expanded storage byte guards are identical on both paths', () => {
  for (const member_data of [{ text: 'x'.repeat(1500000) }, { values: Array(7000).fill(1e308) }]) {
    const f = fixture(); Object.assign(f.members[0].member_data, member_data);
    let original;
    try { prepare(f.input, f.members, f.sources); } catch (error) { original = error; }
    assert.ok(original);
    seal(f);
    assert.throws(() => drain(publicationBatches(f.input, f.members, f.sources)), error => error.message === original.message);
    assert.throws(() => drain(contentBatches(f.members, PROFILE)), error => error.message === original.message);
  }
});
