import test from 'node:test';
import assert from 'node:assert/strict';
import { assessmentEvidenceDigest as evidenceDigest, canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { neighborhoodMemberContentDigest as contentDigest, neighborhoodMemberContentDigestBatches as contentBatches,
  prepareNeighborhoodPublication as prepare, prepareNeighborhoodPublicationBatches as publicationBatches } from '../src/services/neighborhoodAssessment/assessmentRepository.js';
import { REPORTED_OBSERVATION_PROFILE_ID } from '../src/services/neighborhoodAssessment/reportedObservationContract.js';
import { neighborhoodAssessmentFixture } from './fixtures/neighborhoodAssessmentFixture.js';
import { reportedObservationAssessmentFixture } from './fixtures/reportedObservationAssessmentFixture.js';

const PROFILE = Object.freeze({ contract_version: 2, profile_id: REPORTED_OBSERVATION_PROFILE_ID });
// Captured from the original full-copy implementation before this optimization.
const GOLDENS = Object.freeze({
  1: { publication: '2d8126242d63ba07b31e85a7bedfdf002d22dac52bcf38b364ea48be0e9115e1',
    members: '3029b881c9a975473a482a293064661d599e01a322d0e259439752f60369e4ab',
    literal: 'cc04831d4e09cb02b30b98603757210b9be136fc2890059540964142ca3dae89' },
  2: { publication: 'eccac5c5dea62d2ddf94f6825c7127ad616c4ec8fa123b21371bec15def00915',
    members: '069563f893485157776907c85936ec768b47b81ae03658c15d56f0d6a753b65f',
    literal: 'ba03def4065cd589f03fb29a494b9dd9fe9c3c51454a59eb17857158355e40ed' },
});
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
function drain(iterator) {
  let checkpoints = 0;
  for (;;) {
    const step = iterator.next();
    if (step.done) return { value: step.value, checkpoints };
    assert.equal(step.value, undefined, 'no member, source or partial digest is exposed'); checkpoints++;
  }
}
function refresh(f, profile) {
  for (const population of f.input.populations) {
    const source = f.sources.find(source => source.payload.population_id === population.id);
    source.payload.member_content_sha256 = contentDigest(f.members.filter(row => row.population_id === population.id), profile);
    f.input.source_snapshots.find(snapshot => snapshot.id === source.id).content_sha256 = evidenceDigest(source.payload);
  }
}
const literal = () => JSON.parse('{"source_refs":["z","a"],"text":"École 🏠","decimal":"9007199254740993.000000000001","numbers":[1e30,1e-30,0],"empty":"","null":null,"__proto__":{"kept":true},"2":"two","10":"ten"}');
const errorShape = error => ({ constructor: error.constructor.name, message: error.message, code: error.code ?? null, reason: error.reason ?? null });
const invalidShape = { constructor: 'Error', message: 'neighborhood_invalid_member_data', code: 'neighborhood_invalid_member_data', reason: null };
const jsonObject = { constructor: 'TypeError', message: 'invalid_neighborhood_assessment:json_object', code: null, reason: null };

for (const version of [1, 2]) test(`V${version} full publication, sources and digest retain pre-edit goldens`, () => {
  const f = fixture(version), profile = version === 2 ? PROFILE : undefined;
  const before = canonicalAssessmentJson(f), expected = prepare(f.input, f.members, f.sources);
  assert.equal(evidenceDigest(expected), GOLDENS[version].publication);
  assert.equal(contentDigest(f.members, profile), GOLDENS[version].members);
  assert.deepEqual(drain(publicationBatches(f.input, f.members, f.sources)).value, expected);
  assert.equal(drain(contentBatches(f.members, profile)).value, GOLDENS[version].members);
  assert.equal(canonicalAssessmentJson(f), before);
});

for (const version of [1, 2]) test(`V${version} exact literals, associations and own __proto__ retain pre-edit digest`, () => {
  const rows = [{ population_id: 'p', member_id: 'x', member_unit: version === 2 ? 'source_record' : 'canonical_transaction',
    account_ids: ['B', 'A'], member_data: literal() }];
  const before = canonicalAssessmentJson(rows), profile = version === 2 ? PROFILE : undefined;
  assert.equal(contentDigest(rows, profile), GOLDENS[version].literal);
  assert.equal(drain(contentBatches(rows, profile)).value, GOLDENS[version].literal);
  assert.equal(canonicalAssessmentJson(rows), before);
  assert.deepEqual(rows[0].member_data.source_refs, ['z', 'a']);
});

for (const [name, edit, expected] of [
  ['absent', row => { delete row.member_data; }, jsonObject],
  ['explicit undefined', row => { row.member_data = undefined; }, jsonObject],
  ...[null, false, 0, 'private value', [], [null]].map(value => [JSON.stringify(value), row => { row.member_data = value; }, invalidShape]),
  ['missing refs', row => { row.member_data = {}; }, { constructor: 'Error', message: 'neighborhood_member_sources', code: 'neighborhood_member_sources', reason: null }],
  ['undefined source ref', row => { row.member_data = { source_refs: [undefined] }; }, jsonObject],
  ['unpaired Unicode', row => { row.member_data.text = '\ud800'; }, { constructor: 'TypeError', message: 'neighborhood_jsonb_storage_invalid:unpaired_surrogate', code: 'neighborhood_jsonb_storage_invalid', reason: 'unpaired_surrogate' }],
]) test(`original ${name} member_data refusal is exact in all independent entry paths`, () => {
  const f = fixture(); edit(f.members[0]);
  for (const run of [() => contentDigest(f.members, PROFILE), () => drain(contentBatches(f.members, PROFILE)),
    () => prepare(f.input, f.members, f.sources), () => drain(publicationBatches(f.input, f.members, f.sources))]) {
    assert.throws(run, error => { assert.deepEqual(errorShape(error), expected); return true; });
  }
});

test('whole-row JSON refusal and original account/field checks retain precedence over nested shape', () => {
  for (const [edit, message] of [
    [row => { row.member_id = ''; row.member_data.text = '\ud800'; }, 'neighborhood_jsonb_storage_invalid:unpaired_surrogate'],
    [row => { row.account_ids = []; delete row.member_data; }, 'neighborhood_member_accounts'],
    [row => { row.extra = true; row.member_data = null; }, 'neighborhood_member_field'],
    [row => { row.member_id = ''; row.member_data = []; }, 'neighborhood_invalid_member_id'],
  ]) {
    const f = fixture(); edit(f.members[0]);
    for (const run of [() => contentDigest(f.members, PROFILE), () => prepare(f.input, f.members, f.sources)]) {
      assert.throws(run, error => error.message === message);
    }
  }
});

test('only the private whole-row copy is mutated or frozen; source aliases and caller objects remain separate', () => {
  const f = fixture(), shared = { nested: { text: 'original', numbers: [0, 1e30, 1e-30], null: null } };
  for (const row of f.members) { row.member_data.left = shared; row.member_data.right = shared; }
  refresh(f, PROFILE); const before = canonicalAssessmentJson(f);
  const prepared = prepare(f.input, f.members, f.sources), first = prepared.members[0];
  assert.notEqual(first.member_data, f.members[0].member_data);
  assert.notEqual(first.member_data.left, shared);
  assert.notEqual(first.member_data.left, first.member_data.right, 'canonical whole-row copy still separates original aliases');
  assert.notEqual(first.member_data.left, prepared.members[1].member_data.left);
  assert.ok(Object.isFrozen(first.member_data.left.nested));
  assert.equal(Object.isFrozen(shared), false); assert.equal(canonicalAssessmentJson(f), before);
  shared.nested.text = 'caller changed after completion';
  assert.equal(first.member_data.left.nested.text, 'original');
});

test('original member_data getter is read only at the unchanged whole-row copy boundary', () => {
  const row = fixture().members[0], data = row.member_data; let reads = 0;
  Object.defineProperty(row, 'member_data', { enumerable: true, get() { reads++; return data; } });
  const expected = contentDigest([{ ...row, member_data: data }], PROFILE); reads = 0;
  assert.equal(contentDigest([row], PROFILE), expected); assert.equal(reads, 1);
  assert.equal(Object.isFrozen(data), false);
});

for (const [name, edit, message] of [
  ['whole-row canonical bytes', row => { row.member_data = { source_refs: [], a: 'x'.repeat(750000), b: 'y'.repeat(750000) }; }, 'invalid_neighborhood_assessment:json_bytes'],
  ['whole-row expanded numeric storage', row => { row.member_data.values = Array(7000).fill(1e308); }, 'neighborhood_jsonb_storage_limit:bytes'],
  ['whole-row depth', row => { let nested = null; for (let i = 0; i < 41; i++) nested = { nested }; row.member_data.nested = nested; }, 'invalid_neighborhood_assessment:json_limit'],
  ['whole-row nodes', row => { row.member_data.values = Array(100000).fill(null); }, 'invalid_neighborhood_assessment:json_limit'],
  ['invalid Unicode key', row => { row.member_data['\ud800'] = 'private'; }, 'neighborhood_jsonb_storage_invalid:unpaired_surrogate'],
  ['invalid NUL value', row => { row.member_data.text = '\0'; }, 'neighborhood_jsonb_storage_invalid:nul_string'],
]) test(`${name} is still checked by every original full-row entry`, () => {
  const f = fixture(); edit(f.members[0]);
  for (const run of [() => contentDigest(f.members, PROFILE), () => prepare(f.input, f.members, f.sources)]) {
    assert.throws(run, error => error.message === message);
  }
});

for (const count of [0, 1, 124, 125, 126, 250, 251]) test(`${count} rows retain the exact original normalization/hash checkpoints`, () => {
  const prototype = fixture().members[0], rows = Array.from({ length: count }, (_, i) => ({ ...structuredClone(prototype),
    member_id: `A${i}`, account_ids: [`A${i}`] }));
  const completed = drain(contentBatches(rows, PROFILE));
  assert.equal(completed.checkpoints, 3 + 2 * Math.floor(count / 125));
  assert.equal(completed.value, contentDigest(rows, PROFILE));
});

test('late invalid shape remains after the same first normalization checkpoint', () => {
  const prototype = fixture().members[0], rows = Array.from({ length: 126 }, (_, i) => ({ ...structuredClone(prototype),
    member_id: `A${i}`, account_ids: [`A${i}`] }));
  delete rows[125].member_data;
  const iterator = contentBatches(rows, PROFILE);
  assert.deepEqual(iterator.next(), { value: undefined, done: false });
  assert.throws(() => iterator.next(), error => { assert.deepEqual(errorShape(error), jsonObject); return true; });
  assert.deepEqual(iterator.next(), { value: undefined, done: true });
});

test('every publication checkpoint can close without partial output; replay independently checks changed originals', () => {
  const f = fixture(), expected = prepare(f.input, f.members, f.sources);
  const count = drain(publicationBatches(f.input, f.members, f.sources)).checkpoints;
  for (let stop = 1; stop <= count; stop++) {
    const iterator = publicationBatches(f.input, f.members, f.sources);
    for (let i = 0; i < stop; i++) assert.deepEqual(iterator.next(), { value: undefined, done: false });
    assert.deepEqual(iterator.return(), { value: undefined, done: true });
    assert.deepEqual(iterator.next(), { value: undefined, done: true });
  }
  assert.deepEqual(prepare(f.input, f.members, f.sources), expected);
  const changed = structuredClone(expected); changed.members[0].member_data.added = 'untrusted change';
  const originals = changed.sources.map(source => ({ id: source.snapshot.id, payload: source.payload }));
  assert.throws(() => prepare(changed.assessment, changed.members, originals), /member_content_mismatch/);
  assert.throws(() => drain(publicationBatches(changed.assessment, changed.members, originals)), /member_content_mismatch/);
});

test('251-row digest removes only 251 redundant nested copies from the measured original 503', () => {
  const prototype = fixture().members[0], rows = Array.from({ length: 251 }, (_, i) => ({ ...structuredClone(prototype),
    member_id: `A${i}`, account_ids: [`A${i}`] }));
  const parse = JSON.parse; let calls = 0;
  try { JSON.parse = (...args) => { calls++; return parse(...args); }; contentDigest(rows, PROFILE); }
  finally { JSON.parse = parse; }
  assert.equal(calls, 252); // Original measured 503: retain one profile + one full-row copy per row.
});

for (const [kind, expected] of [
  ['object toJSON', '246013c8e04a44055bb6818f40d296c62df8da43cea02dfb3bdac5e9388d18c2'],
  ['array toJSON', 'a2fc657651e2cdb3fdf8a3c95a63a28eca2dc4414dbbe11f0ec45388c932e812'],
  ['inherited data', 'cbe0ef98e3e3591f013c2584fb669622ef4c674d854e31d7500729f499ef0095'],
  ['array iterator', 'a2fc657651e2cdb3fdf8a3c95a63a28eca2dc4414dbbe11f0ec45388c932e812'],
]) test(`${kind} retains the exact original non-idempotent fallback digest`, () => {
  const row = { population_id: 'p', member_id: 'x', member_unit: 'account', account_ids: ['x'],
    member_data: { source_refs: [], marker: true, count: 0, array: ['hook'] } };
  const objectHook = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const arrayHook = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  const inheritedData = Object.getOwnPropertyDescriptor(Object.prototype, 'member_data');
  const arrayIterator = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
  const restore = (target, key, descriptor) => descriptor ? Object.defineProperty(target, key, descriptor) : Reflect.deleteProperty(target, key);
  let actual;
  try {
    if (kind === 'object toJSON') Object.defineProperty(Object.prototype, 'toJSON', { configurable: true,
      value() { return this.marker ? { ...this, count: this.count + 1 } : this; } });
    if (kind === 'array toJSON') Object.defineProperty(Array.prototype, 'toJSON', { configurable: true,
      value() { return this[0] === 'hook' ? [...this, 'seen'] : this; } });
    if (kind === 'inherited data') {
      Object.defineProperty(Object.prototype, 'member_data', { configurable: true, writable: true, value: row.member_data });
      delete row.member_data;
    }
    if (kind === 'array iterator') Object.defineProperty(Array.prototype, Symbol.iterator, { ...arrayIterator,
      value: function* () { yield* arrayIterator.value.call(this); if (this[0] === 'hook') yield 'seen'; } });
    actual = contentDigest([row], PROFILE);
  } finally {
    restore(Object.prototype, 'toJSON', objectHook); restore(Array.prototype, 'toJSON', arrayHook);
    restore(Object.prototype, 'member_data', inheritedData); restore(Array.prototype, Symbol.iterator, arrayIterator);
  }
  assert.equal(actual, expected); // Captured before editing the production normalizer.
});

for (const replaceValues of [false, true]) test(`pre-import custom iterator${replaceValues ? ' and values' : ''} keeps original copy semantics`, async () => {
  const iterator = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
  const values = Object.getOwnPropertyDescriptor(Array.prototype, 'values');
  const row = { population_id: 'p', member_id: 'x', member_unit: 'account', account_ids: ['x'],
    member_data: { source_refs: [], marker: true, count: 0, array: ['hook'] } };
  const replacement = function* () { yield* iterator.value.call(this); if (this[0] === 'hook') yield 'seen'; };
  let actual;
  try {
    Object.defineProperty(Array.prototype, Symbol.iterator, { ...iterator, value: replacement });
    if (replaceValues) Object.defineProperty(Array.prototype, 'values', { ...values, value: replacement });
    const fresh = await import(`../src/services/neighborhoodAssessment/assessmentRepository.js?owned-member-startup-${replaceValues ? 'both' : 'iterator'}`);
    actual = fresh.neighborhoodMemberContentDigest([row], PROFILE);
  } finally {
    Object.defineProperty(Array.prototype, Symbol.iterator, iterator);
    Object.defineProperty(Array.prototype, 'values', values);
  }
  assert.equal(actual, 'a2fc657651e2cdb3fdf8a3c95a63a28eca2dc4414dbbe11f0ec45388c932e812');
  assert.deepEqual(Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator), iterator);
  assert.deepEqual(Object.getOwnPropertyDescriptor(Array.prototype, 'values'), values);
});

test('pre-import throwing values accessor is not invoked by iterator admission', async () => {
  const values = Object.getOwnPropertyDescriptor(Array.prototype, 'values');
  const original = fixture().members[0]; let reads = 0, fresh;
  try {
    Object.defineProperty(Array.prototype, 'values', { configurable: true, get() { reads++; throw new Error('startup values accessor'); } });
    fresh = await import('../src/services/neighborhoodAssessment/assessmentRepository.js?owned-member-startup-accessor');
  } finally { Object.defineProperty(Array.prototype, 'values', values); }
  assert.equal(reads, 0);
  const parse = JSON.parse; let calls = 0, actual;
  try {
    JSON.parse = (...args) => { calls++; return parse(...args); };
    actual = fresh.neighborhoodMemberContentDigest([original], PROFILE);
  } finally { JSON.parse = parse; }
  assert.equal(actual, contentDigest([original], PROFILE));
  assert.equal(calls, 3, 'an unadmitted startup iterator retains both original copies even after accessor restoration');
  assert.deepEqual(Object.getOwnPropertyDescriptor(Array.prototype, 'values'), values);
});

for (const accessor of [true, false]) test(`pre-import throwing function stringifier ${accessor ? 'accessor' : 'function'} keeps fallback`, async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Function.prototype, 'toString');
  const original = fixture().members[0]; let calls = 0, fresh;
  const throwing = () => { calls++; throw new Error('startup stringifier'); };
  try {
    Object.defineProperty(Function.prototype, 'toString', accessor
      ? { configurable: true, get: throwing } : { ...descriptor, value: throwing });
    fresh = await import(`../src/services/neighborhoodAssessment/assessmentRepository.js?owned-member-stringifier-${accessor}`);
  } finally { Object.defineProperty(Function.prototype, 'toString', descriptor); }
  assert.equal(calls, accessor ? 0 : 1);
  const parse = JSON.parse; let copies = 0, actual;
  try {
    JSON.parse = (...args) => { copies++; return parse(...args); };
    actual = fresh.neighborhoodMemberContentDigest([original], PROFILE);
  } finally { JSON.parse = parse; }
  assert.equal(actual, contentDigest([original], PROFILE));
  assert.equal(copies, 3);
  assert.deepEqual(Object.getOwnPropertyDescriptor(Function.prototype, 'toString'), descriptor);
});
