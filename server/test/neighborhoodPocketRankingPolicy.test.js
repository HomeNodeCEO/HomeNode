import test from 'node:test';
import assert from 'node:assert/strict';
import { rankNeighborhoodPockets, POCKET_RANKING_LIMITS } from '../src/services/neighborhoodAssessment/pocketRankingPolicy.js';
import { canonicalAssessmentJson, assessmentEvidenceDigest } from '../src/services/neighborhoodAssessment/contract.js';
import { neighborhoodPocketRankingPolicyFixture as fixture, addSyntheticRankingMember as addMember,
  syntheticRankingPhysicalRecord as physical } from './fixtures/neighborhoodPocketRankingPolicyFixture.js';
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1e-12, `${actual} != ${expected}`);
const minimal = () => fixture('minimal').input;
const fact = (input, id = 'A1') => input.records.find(row => row.kind === 'physical_facts' && row.property_id === id);
const membership = (input, id = 'A1') => input.records.find(row => row.kind === 'pocket_membership' && row.property_id === id);
const pocket = (result, id = 'A') => result.pockets.find(row => row.id === id);
const resolution = (result, id = 'A1') => result.property_resolutions.find(row => row.property_id === id);
const rejection = fn => assert.throws(fn, error => error instanceof TypeError && /^invalid_pocket_ranking_input:[a-z_]+$/.test(error.message));
const atomic = result => {
  assert.equal(result.status, 'incomplete'); assert.equal(result.input_sha256, null); assert.equal(result.ranking_revision, null);
  assert.deepEqual(result.pockets, []); assert.deepEqual(result.property_resolutions, []); assert.deepEqual(result.overlap_groups, []);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024);
};

test('independent exact and half-similarity fixture, missingness, and whole-pocket1/99 denominator', () => {
  const { input, expected } = fixture(); const result = rankNeighborhoodPockets(input);
  assert.equal(result.status, 'complete'); assert.deepEqual(result.pockets.map(row => row.id), expected.order);
  for (const [id, expectedRow] of Object.entries(expected).filter(([key]) => key !== 'order')) {
    const row = pocket(result, id); near(row.lower_bound, expectedRow.low); near(row.upper_bound, expectedRow.high);
    near(row.compatible_physical_support, expectedRow.support); assert.equal(row.disposition, expectedRow.disposition);
  }
  assert.equal(pocket(result, 'D').member_count, 100); assert.equal(pocket(result, 'D').compatible_count, 1);
  assert.equal(pocket(result, 'D').incompatible_count, 99); near(pocket(result, 'D').compatible_fraction, 0.01);
  assert.equal(result.source_authority, 'not_established'); assert.equal(result.report_eligibility, 'not_assessed');
  assert.equal(result.builder_support, 'not_assessed'); assert.equal(result.sales_support, 'not_assessed');
  const { ranking_revision, ...body } = result; assert.equal(ranking_revision, assessmentEvidenceDigest(body));
  assert.ok(Object.isFrozen(result.pockets[0].members[0].feature_scores));
});
test('dictionary and all set-like input order preserves exact result and identity', () => {
  const input = minimal(); const extra = physical('A1', {}, 'agree'); input.records.push(extra); input.properties.find(row => row.id === 'A1').physical_record_refs.push(extra.ref);
  const reorder = value => Array.isArray(value) ? value.map(reorder).reverse() : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reorder(child)])) : value;
  assert.deepEqual(rankNeighborhoodPockets(reorder(input)), rankNeighborhoodPockets(input));
});
test('unrelated alternative changes global digest but no existing score/disposition', () => {
  const input = minimal(), before = rankNeighborhoodPockets(input);
  addMember(input, 'Z', 'Z1', { year_built: 1900, gla: 600, site_area: 100000 });
  const after = rankNeighborhoodPockets(input); assert.deepEqual(pocket(after), pocket(before));
  assert.notEqual(after.input_sha256, before.input_sha256);
});
test('agreement and missing source copies preserve one property vote; conflicting fact becomes uncertainty', () => {
  const input = minimal(), extra = physical('A1', { site_area: null }, 'second');
  input.records.push(extra); input.properties.find(row => row.id === 'A1').physical_record_refs.push(extra.ref);
  let result = rankNeighborhoodPockets(input); assert.equal(pocket(result).member_count, 2); near(pocket(result).lower_bound, 1);
  extra.facts.year_built = 2014; result = rankNeighborhoodPockets(input);
  assert.equal(resolution(result).facts.year_built.status, 'conflicted'); assert.equal(resolution(result).facts.year_built.record_refs.length, 2);
  near(pocket(result).lower_bound, 0.8); near(pocket(result).upper_bound, 1);
});
test('paired member characteristics cannot be replaced by marginal centers', () => {
  const input = minimal(); Object.assign(fact(input, 'A1').facts, { gla: 1000, site_area: 16000 });
  Object.assign(fact(input, 'A2').facts, { gla: 4000, site_area: 4000 });
  const gla = Math.exp(-Math.log(2) * (Math.log(2) / Math.log(1.25)) ** 2);
  const site = Math.exp(-Math.log(2) * (Math.log(2) / Math.log(1.5)) ** 2);
  const row = pocket(rankNeighborhoodPockets(input)); near(row.lower_bound, 0.4 + 0.4 * gla + 0.2 * site);
  assert.ok(row.lower_bound < 0.5); assert.equal(row.disposition, 'not_recommended');
});
for (const field of ['housing_type', 'year_built', 'gla']) test(`missing subject ${field} yields incomplete review`, () => {
  const input = minimal(); fact(input, 'S').facts[field] = null;
  const result = rankNeighborhoodPockets(input); assert.equal(result.status, 'incomplete');
  assert.equal(pocket(result).disposition, 'review_required'); near(pocket(result).lower_bound, 0); near(pocket(result).upper_bound, 1);
});
test('unsupported subject class and future construction year never become anchors', () => {
  for (const patch of [{ housing_type: 'two_to_four_units' }, { year_built: 2025 }]) {
    const input = minimal(); Object.assign(fact(input, 'S').facts, patch);
    const result = rankNeighborhoodPockets(input); assert.equal(result.subject_resolution.status, 'incomplete');
  }
});
test('unknown subject site widens bounds while observed physical match remains1', () => {
  const input = minimal(); fact(input, 'S').facts.site_area = null;
  const result = rankNeighborhoodPockets(input), row = pocket(result);
  near(row.lower_bound, 0.8); near(row.upper_bound, 1); near(row.compatible_observed_score, 1); near(row.compatible_physical_support, 0.8);
});
for (const kind of ['after_cutoff', 'future_interval', 'expired_interval', 'unknown_history', 'unknown_validity']) test(`temporal ${kind} record cannot score`, () => {
  const input = minimal(), row = fact(input);
  if (kind === 'after_cutoff') row.retrieved_at = row.recorded_at = '2024-07-01T00:00:00.001Z';
  if (kind === 'future_interval') row.validity.from = '2024-07-01';
  if (kind === 'expired_interval') row.validity.to = '2024-06-29';
  if (kind === 'unknown_history') row.validity.historical_availability = 'unknown';
  if (kind === 'unknown_validity') row.validity = { status: 'unknown', from: null, to: null, historical_availability: 'unknown' };
  const result = rankNeighborhoodPockets(input); assert.equal(resolution(result).facts.gla.status, 'unsupported');
  near(pocket(result).lower_bound, 0.5); near(pocket(result).upper_bound, 1);
});
for (const availability of ['known_at_effective_date', 'reconstructed']) test(`late retrieved supported ${availability} retains explicit historical availability`, () => {
  const input = minimal(), row = fact(input);
  input.knowledge_cutoff = input.capture.knowledge_cutoff = '2024-08-01T00:00:00.000Z';
  row.retrieved_at = row.recorded_at = '2024-07-15T00:00:00.000Z'; row.validity.historical_availability = availability;
  near(pocket(rankNeighborhoodPockets(input)).lower_bound, 1);
});
test('interval and knowledge-cutoff endpoints are inclusive', () => {
  const input = minimal(), row = fact(input); row.retrieved_at = row.recorded_at = input.knowledge_cutoff;
  row.validity.from = row.validity.to = input.effective_date; near(pocket(rankNeighborhoodPockets(input)).lower_bound, 1);
});
test('future contradictory source remains bound but cannot veto an applicable fact', () => {
  const input = minimal(), extra = physical('A1', { year_built: 2014 }, 'future-conflict');
  extra.retrieved_at = extra.recorded_at = '2024-07-01T00:00:00.001Z';
  const before = rankNeighborhoodPockets(input); input.records.push(extra); input.properties.find(row => row.id === 'A1').physical_record_refs.push(extra.ref);
  const result = rankNeighborhoodPockets(input); near(pocket(result).lower_bound, 1); assert.notEqual(result.input_sha256, before.input_sha256);
  assert.equal(resolution(result).ignored_record_refs.length, 1);
});
for (const completeness of ['incomplete', 'unknown']) test(`${completeness} candidate capture prevents recommendations`, () => {
  const input = minimal(); input.capture.completeness = completeness;
  const result = rankNeighborhoodPockets(input); assert.equal(result.status, 'incomplete'); assert.equal(pocket(result).disposition, 'review_required');
});
test('membership conflict keeps declared denominator and affects only its own pocket', () => {
  const input = minimal(); addMember(input, 'B', 'B1'); const extra = structuredClone(membership(input));
  extra.ref.record_id = 'opposite'; extra.included = false; input.records.push(extra); input.pockets[0].members[0].membership_record_refs.push(extra.ref);
  const result = rankNeighborhoodPockets(input); assert.equal(result.status, 'incomplete'); assert.equal(pocket(result).member_count, 2);
  near(pocket(result).lower_bound, 0.5); near(pocket(result).upper_bound, 1);
  assert.equal(pocket(result).disposition, 'review_required'); assert.equal(pocket(result, 'B').disposition, 'recommended');
});
test('overlapping alternatives retain independent per-property weights and explicit overlap', () => {
  const input = minimal(); addMember(input, 'B', 'A1'); const result = rankNeighborhoodPockets(input);
  assert.deepEqual(result.overlap_groups, [{ property_id: 'A1', pocket_ids: ['A', 'B'] }]);
  assert.equal(pocket(result).member_count, 2); assert.equal(pocket(result, 'B').member_count, 1);
  assert.equal(result.population_application, 'not_performed');
});
test('empty pocket and absent membership witness produce review, never divide by zero', () => {
  const input = minimal(); input.pockets.push({ id: 'empty', revision: '1', membership_completeness: 'complete', members: [] });
  const result = rankNeighborhoodPockets(input); assert.equal(pocket(result, 'empty').compatible_fraction, null);
  assert.equal(pocket(result, 'empty').disposition, 'review_required');
  const clean = minimal(), old = membership(clean); clean.records = clean.records.filter(row => row !== old); clean.pockets[0].members[0].membership_record_refs = [];
  assert.equal(pocket(rankNeighborhoodPockets(clean)).disposition, 'review_required');
});
test('80% whole-pocket compatibility passes;79% cannot recommend', () => {
  const input = minimal(); input.pockets = []; input.properties = input.properties.slice(0, 1); input.records = input.records.slice(0, 1);
  for (let i = 0; i < 100; i++) addMember(input, 'P', `P${i}`, { housing_type: i < 80 ? 'single_family_detached' : 'condominium_unit' });
  let result = rankNeighborhoodPockets(input); assert.equal(pocket(result, 'P').disposition, 'recommended');
  fact(input, 'P79').facts.housing_type = 'condominium_unit'; result = rankNeighborhoodPockets(input);
  assert.equal(pocket(result, 'P').disposition, 'not_recommended');
});
test('entire numerical decision band around0.75 reviews; no upward recommendation epsilon', () => {
  for (const desired of [0.75 - 5e-13, 0.75, 0.75 + 5e-13]) {
    const input = minimal(), feature = (desired - 0.6) / 0.4;
    const distance = Math.sqrt(-Math.log(feature) / Math.log(2));
    for (const id of ['A1', 'A2']) fact(input, id).facts.gla = 2000 * Math.exp(Math.log(1.25) * distance);
    const row = pocket(rankNeighborhoodPockets(input)); near(row.lower_bound, desired); assert.equal(row.disposition, 'review_required');
  }
});
test('log difference accepts tiny positive magnitudes and exponential underflow without ratio overflow', () => {
  const input = minimal(); fact(input).facts.gla = Number.MIN_VALUE;
  const result = rankNeighborhoodPockets(input); assert.equal(pocket(result).members[0].feature_scores.gla, 0); assert.ok(result.ranking_revision);
});

const schemaMutations = {
  foreign_scope: input => { fact(input).scope.account_id = 'OTHER'; },
  capture_scope: input => { input.capture.scope.account_id = 'OTHER'; },
  capture_date: input => { input.capture.effective_date = '2024-06-29'; },
  wrong_physical_target: input => { fact(input).property_id = 'A2'; },
  wrong_membership_revision: input => { membership(input).pocket_revision = '2'; },
  dangling_ref: input => { input.properties[0].physical_record_refs[0].record_id = 'missing'; },
  wrong_record_kind: input => { input.properties[1].physical_record_refs = [membership(input).ref]; },
  duplicate_property: input => input.properties.push(structuredClone(input.properties[1])),
  duplicate_record: input => input.records.push(structuredClone(input.records[1])),
  duplicate_member: input => input.pockets[0].members.push(structuredClone(input.pockets[0].members[0])),
  duplicate_ref: input => input.properties[0].physical_record_refs.push({ ...input.properties[0].physical_record_refs[0] }),
  unreferenced_record: input => input.records.push(physical('A1', {}, 'unreferenced')),
  invalid_year: input => { fact(input).facts.year_built = 2004.5; },
  numeric_string: input => { fact(input).facts.gla = '2000'; },
  wrong_unit: input => { input.units.gla = 'm2'; },
  zero: input => { fact(input).facts.gla = 0; },
  negative_zero: input => { fact(input).facts.gla = -0; },
  infinity: input => { fact(input).facts.gla = Infinity; },
  nan: input => { fact(input).facts.site_area = NaN; },
  date_invalid: input => { input.effective_date = '2024-02-30'; },
  chronology: input => { fact(input).recorded_at = '2024-01-01T00:00:00.000Z'; },
  bad_unicode: input => { input.capture.id = '\ud800'; },
  target_price: input => { input.target_price = 900000; },
  builder_bonus: input => { input.builder_bonus = 1; },
  sales: input => { input.sales = []; },
  geometry: input => { input.geometry = {}; },
  demographic: input => { input.demographic_score = 1; },
};
for (const [name, mutate] of Object.entries(schemaMutations)) test(`strict input rejects ${name}`, () => {
  const input = minimal(); mutate(input); rejection(() => rankNeighborhoodPockets(input));
});
test('getters, Proxies, inherited data and malformed arrays reject without invoking hooks', () => {
  let calls = 0; const getter = () => { calls++; throw new Error('SYNTHETIC_PRIVATE_MARKER'); };
  const input = minimal(); Object.defineProperty(input, 'capture', { get: getter, enumerable: true }); rejection(() => rankNeighborhoodPockets(input));
  for (const value of [new Proxy({}, { ownKeys: getter, getPrototypeOf: getter }), Object.create({ capture: 1 })]) rejection(() => rankNeighborhoodPockets(value));
  const options = {}; Object.defineProperty(options, 'limits', { get: getter, enumerable: true }); rejection(() => rankNeighborhoodPockets(minimal(), options));
  const limits = {}; Object.defineProperty(limits, 'output_bytes', { get: getter, enumerable: true }); rejection(() => rankNeighborhoodPockets(minimal(), { limits }));
  assert.equal(calls, 0);
  for (const mutate of [v => { v.properties.length++; }, v => { v.properties.note = 1; }, v => { v.loop = v; }, v => { v[Symbol('x')] = 1; }]) {
    const value = minimal(); mutate(value); rejection(() => rankNeighborhoodPockets(value));
  }
});
for (const bad of [{ limits: null }, { extra: 1 }, { limits: { unknown: 1 } }, { limits: { output_bytes: -1 } }, { limits: { records: 15001 } }]) {
  test(`invalid options ${JSON.stringify(bad)}`, () => rejection(() => rankNeighborhoodPockets(minimal(), bad)));
}
for (const [key, exact] of [['properties', 3], ['pockets', 1], ['records', 5], ['members', 2], ['references', 5]]) test(`exact ${key} cap and cap+1 request`, () => {
  const input = minimal(); assert.ok(rankNeighborhoodPockets(input, { limits: { [key]: exact } }).ranking_revision);
  if (exact > 1) atomic(rankNeighborhoodPockets(input, { limits: { [key]: exact - 1 } }));
});
test('input, output, node and depth exhaustion fail atomically including full metadata', () => {
  for (const limits of [{ input_bytes: 1 }, { output_bytes: 1 }, { nodes: 1 }, { depth: 1 }]) atomic(rankNeighborhoodPockets(minimal(), { limits }));
  const result = rankNeighborhoodPockets(minimal()); const rawBytes = Buffer.byteLength(canonicalAssessmentJson(result));
  assert.ok(rawBytes > 1000); atomic(rankNeighborhoodPockets(minimal(), { limits: { output_bytes: rawBytes - 100 } }));
});
test('defaults are immutable and no caller input is mutated', () => {
  const input = minimal(), before = structuredClone(input); rankNeighborhoodPockets(input); assert.deepEqual(input, before);
  assert.ok(Object.isFrozen(POCKET_RANKING_LIMITS));
});

function treeSize(value) {
  let nodes = 0, depth = 0;
  function visit(item, level) { nodes++; depth = Math.max(depth, level);
    if (item && typeof item === 'object') Object.values(item).forEach(child => visit(child, level + 1)); }
  visit(value, 0); return { nodes, depth };
}
test('complete output UTF8 boundary includes references, limits and outer digest', () => {
  const input = minimal(), template = structuredClone(rankNeighborhoodPockets(input));
  let cap = 1000000;
  for (let i = 0; i < 8; i++) { template.limits.output_bytes = cap;
    const next = Buffer.byteLength(canonicalAssessmentJson(template)); if (next === cap) break; cap = next; }
  const exact = rankNeighborhoodPockets(input, { limits: { output_bytes: cap } });
  assert.ok(exact.ranking_revision); assert.equal(Buffer.byteLength(canonicalAssessmentJson(exact)), cap);
  atomic(rankNeighborhoodPockets(input, { limits: { output_bytes: cap - 1 } }));
});
test('complete normalized input identity UTF8 boundary includes effective limits', () => {
  const input = minimal(), limits = { ...POCKET_RANKING_LIMITS };
  let cap = 1000000;
  for (let i = 0; i < 8; i++) { limits.input_bytes = cap;
    const next = Buffer.byteLength(canonicalAssessmentJson({ input, limits })); if (next === cap) break; cap = next; }
  assert.ok(rankNeighborhoodPockets(input, { limits: { input_bytes: cap } }).ranking_revision);
  atomic(rankNeighborhoodPockets(input, { limits: { input_bytes: cap - 1 } }));
});
for (const key of ['nodes', 'depth']) test(`actual ${key} allocation boundary covers input and full result`, () => {
  const input = minimal(), result = rankNeighborhoodPockets(input);
  const count = Math.max(treeSize({ input, limits: POCKET_RANKING_LIMITS })[key], treeSize(result)[key]);
  assert.ok(rankNeighborhoodPockets(input, { limits: { [key]: count } }).ranking_revision);
  atomic(rankNeighborhoodPockets(input, { limits: { [key]: count - 1 } }));
});
test('100 missing-feature members retain every diagnostic without exhausting global summary codes', () => {
  const input = minimal();
  for (let index = 0; index < 100; index++) addMember(input, 'M', `M${index}`, { gla: null });
  const result = rankNeighborhoodPockets(input); assert.ok(result.ranking_revision); assert.ok(result.reasons.length <= 32);
  const members = pocket(result, 'M').members; assert.equal(members.length, 100);
  assert.ok(members.every(member => member.reason_codes.includes('gla_similarity_unknown')));
  assert.equal(pocket(result, 'M').disposition, 'review_required');
});
