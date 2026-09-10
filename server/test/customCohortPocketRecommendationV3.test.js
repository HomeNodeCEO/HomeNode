import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildCustomCohortPocketRecommendation as build,
  CUSTOM_COHORT_POCKET_RECOMMENDATION_POLICY as V1,
  CUSTOM_COHORT_POCKET_RECOMMENDATION_POLICY_V3 as V3 } from '../src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { buildCustomCohortCurrentCadBaseline } from '../src/services/neighborhoodAssessment/customCohortCurrentCadBaseline.js';
import { buildCustomCohortObservationPreview } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCustomCohortPocketCatalog } from '../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { buildCachedSourceCaptures } from '../src/services/neighborhoodAssessment/cachedSourceCaptures.js';
import { mapCadEvidenceParcelRow, mapCadEvidenceAccountRow } from '../src/services/neighborhoodAssessment/cachedRowMappingsV4.js';
import { projectCustomNeighborhoodMaterialInputs } from '../src/services/neighborhoodAssessment/customMaterialInputs.js';
import { deriveCustomCohortRecordedProximity } from '../src/services/neighborhoodAssessment/customCohortRecordedProximity.js';
import { inputs, setPublic, setSection, argumentsOf as materialArgs } from './fixtures/neighborhoodCustomMaterialInputsFixture.js';
import { cadEvidenceFixture } from './fixtures/customCohortCadEvidenceFixture.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';
import { saleWitnessMeaningFixture } from './fixtures/customCohortSaleWitnessMeaningFixture.js';
import { recordedProximityFixture } from './fixtures/customCohortRecordedProximityFixture.js';

const SUBJECT = '0000123456789', CANDIDATE = 'R-001';
const CAD = { class_code: 'A11', class_description: null, use_description: null, structure_type: null, built_up: true };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const argsOf = f => ({ context_ref: f.input.expected.context_ref, retained_inputs: f.input.retained_inputs, selection: f.input.selection });
const near = (a, b) => assert.ok(Math.abs(a - b) < .00011, `${a} != ${b}`);
const property = (r, id = CANDIDATE) => r.properties.find(p => p.account_id === id);
let shared;
const actual = () => shared ??= cadEvidenceFixture();
const groupsOf = catalog => [...catalog.pockets, ...(catalog.unassigned.member_count
  ? [{ id: 'discovery:unassigned', account_ids: catalog.unassigned.account_ids }] : [])];

// Pure consumer scenarios build actual v4 mapped rows/source chunks and the
// material projector. They do NOT claim to be new original graph captures or
// owner admission. Genuine reader -> persist -> reopen coupling is tested below.
async function fixture({ accounts = [SUBJECT, CANDIDATE], parcels, names = {}, county = 'Dallas', manual,
  publicProperty, proximity = false } = {}) {
  const base = proximity ? await recordedProximityFixture() : await actual();
  const input = structuredClone(base.input.retained_inputs), original = await actual();
  input.acquisition.compact_metadata_json = original.input.retained_inputs.acquisition.compact_metadata_json;
  const scope = input.acquisition.capture_result.source_capture.scope;
  const sourceParcel = input.acquisition.capture_result.source_capture.sources
    .find(s => s.payload.projection.definition.role === 'parcels').payload.records[0].data.raw_projection;
  const rows = (parcels ?? accounts.map(account_id => ({ account_id }))).map((row, index) => ({
    ...sourceParcel, ...CAD, ...row, object_id: String(9007199254740993n + BigInt(index)),
  }));
  const roles = {
    selection: accounts.map(account_id => ({ record_id: `selected:${account_id}`, data: { account_id } })),
    parcels: rows.map(row => ({ record_id: `parcel:${row.object_id}`, data: mapCadEvidenceParcelRow(row) })),
    accounts: accounts.map(account_id => ({ record_id: `account:${account_id}`, data: mapCadEvidenceAccountRow({
      account_id, county, subdivision: names[account_id] ?? `Group ${account_id}`,
    }) })), transactions: [], sale_links: [], gis_sync: [],
  };
  const now = input.acquisition.capture_result.captured_at;
  const capture = buildCachedSourceCaptures({ scope, captures: Object.entries(roles).map(([role, records]) => ({
    upstream: { id: `local-cache:${role}`, key: role, state: records.length ? 'populated' : 'present_empty', complete: true,
      revision: 'synthetic-housing-v4', content_sha256: 'a'.repeat(64), captured_at: now,
      visibility: 'assignment_private', scope, row_count: records.length },
    metadata: { id: `local-cache-${role}`, provider: 'Synthetic local mirror', revision: 'synthetic-housing-v4',
      valid_from: null, valid_to: null, observed_at: now, historical_availability: 'unknown' },
    projection: { id: `cache-${role}`, revision: 'synthetic-housing-v4', definition: { role, mapping_version: 4 },
      complete: true, input_row_count: records.length, output_record_count: records.length }, records,
  })) });
  assert.equal(capture.status, 'ready');
  input.acquisition.capture_result.source_capture = capture;
  input.acquisition.captured_query_request.account_ids = [...accounts];
  input.spatial.account_ids = [...accounts];
  input.spatial.parcels = rows.map(row => ({ ...input.spatial.parcels[0], object_id: row.object_id, account_id: row.account_id }));
  if (manual !== undefined || publicProperty !== undefined) {
    const originalMaterial = inputs(); originalMaterial.target = { ...input.subject.target };
    setPublic(originalMaterial, { account: { account_id: SUBJECT }, ...publicProperty });
    if (manual !== undefined) setSection(originalMaterial, 1, JSON.stringify(manual));
    const material = projectCustomNeighborhoodMaterialInputs(...materialArgs(originalMaterial));
    assert.ok(material.material_input); input.subject.material = material.material_input;
  }
  return { context_ref: base.input.expected.context_ref, retained_inputs: input,
    selection: { revision: 1, included_recorded_group_ids: [] } };
}

async function withProximity(args, distance = 1.5) {
  let calls = 0;
  const recorded_proximity = await deriveCustomCohortRecordedProximity(async (_sql, values) => {
    calls++;
    return { rows: JSON.parse(values[0]).map(row => ({ object_id: row.object_id, valid: true, location_count: 1,
      minimum_metres: distance * 1609.344, maximum_metres: distance * 1609.344 })) };
  }, { context_ref: args.context_ref, retained_inputs: args.retained_inputs });
  return { args: { ...args, recorded_proximity }, calls: () => calls };
}

function bounds(result) {
  for (const row of result.properties) {
    near(row.similarity.lower, Object.entries(row.factors).reduce((n, [key, factor]) => n + (factor.score ?? 0) * V1.weights[key], 0));
    near(row.similarity.known_weight_percent, Object.entries(row.factors).reduce((n, [key, factor]) => n + (factor.score === null ? 0 : 100 * V1.weights[key]), 0));
    near(row.similarity.upper, row.similarity.lower + 100 - row.similarity.known_weight_percent);
  }
  for (const row of [...result.properties, result.all, result.selected, ...result.pockets.map(p => p.result)]) {
    for (const value of Object.values(row.similarity)) {
      if (row.member_count === 0) assert.equal(value, null);
      else assert.ok(Number.isFinite(value) && value >= 0 && value <= 100);
    }
    if (row.member_count !== 0) assert.ok(row.similarity.lower <= row.similarity.upper);
    if (row.factor_coverage) for (const field of Object.values(row.factor_coverage)) {
      assert.equal(field.observed_count + field.unknown_count, row.member_count);
      assert.equal(Object.values(field.states).reduce((a, b) => a + b, 0), row.member_count);
    }
  }
  const coverage = result.recorded_housing.coverage;
  assert.equal(coverage.account_count, result.all.member_count);
  assert.equal(coverage.observed_count + coverage.unknown_count, coverage.account_count);
  assert.equal(Object.values(coverage.states).reduce((a, b) => a + b, 0), coverage.account_count);
  assert.deepEqual(Object.keys(coverage.states).sort(), ['conflicting', 'missing', 'observed', 'partial', 'unknown']);
  assert.ok(result.all.factor_coverage.housing_type.observed_count <= coverage.observed_count);
}

for (const [version, factory, expected] of [
  [2, decisionEvidenceFixture, '78860738699f476933619fc5b5378bc3fe496ed007e22f5334b29d9e6060b2a2'],
  [3, saleWitnessMeaningFixture, '19afa6d54f9a425f4420aaf53b3d928f5ebdacc8bbdfdde20663012f2f953661'],
]) test(`mapping${version} complete installed v1 bytes remain exact without interpreter`, async () => {
  const result = build(argsOf(await factory()));
  assert.equal(hash(result), expected);
  assert.ok(!Object.hasOwn(result, 'recorded_housing') && !Object.hasOwn(result, 'evidence_mode'));
});

// Complete v2 JSON pins captured BEFORE this kernel edit with these same real
// capture/persist/reopen fixtures and the same deterministic native-query oracle.
for (const [radius, expected] of [
  [undefined, 'b6d97db2df1542844ff6822372e4aeebf0e149801aa51bd5e97ea60b8af57d4b'],
  ['8046.72', '5d819d58428666634eb5b27ffaa20f0e63eed3b07f32acfa74f424b4ef2d1672'],
]) test(`complete installed v2 output bytes remain pinned at ${radius ?? 'legacy 3 miles'}`, async () => {
  const f = await recordedProximityFixture({ radius }), d = await withProximity(argsOf(f));
  assert.equal(hash(build(d.args)), expected);
});

test('v3 policy preserves all prior weights, curves, thresholds and bounds', () => {
  assert.deepEqual(V3, { ...V1, id: 'custom-current-observation-review-v3', revision: 3 });
  assert.ok(Object.isFrozen(V3) && Object.isFrozen(V3.weights));
});

for (const known of [false, true]) test(`actual mapping4 reader/persist/reopen runs v3 with ${known ? 'known' : 'unknown'} observations`, async () => {
  const f = known ? await cadEvidenceFixture({ parcelOverrides: CAD }) : await actual();
  const args = argsOf(f), before = JSON.stringify(f.input), calls = f.base.f.state.calls.length;
  const result = build(args);
  assert.deepEqual(result.policy, V3); assert.equal(result.recommendation_version, 1);
  assert.equal(result.evidence_mode, 'recorded_housing_only');
  assert.equal(Object.hasOwn(result, 'recorded_proximity'), false);
  assert.deepEqual(Object.keys(result.unavailable_factors), ['proximity', 'sale_price']);
  assert.equal(result.recorded_housing.subject.state, known ? 'observed' : 'unknown');
  assert.deepEqual(property(result).factors.housing_type, known ? { score: 100, state: 'observed' } : { score: null, state: 'subject_unknown' });
  assert.deepEqual(result.cad_recorded_evidence, buildCustomCohortCurrentCadBaseline({ retained_inputs: args.retained_inputs,
    preview: f.preview, groups: groupsOf(f.catalog) }));
  assert.deepEqual(result.selection, f.input.selection);
  assert.equal(result.authority, 'not_established'); assert.equal(result.apply.status, 'blocked');
  assert.equal(JSON.stringify(f.input), before); assert.equal(f.base.f.state.calls.length, calls);
  assert.deepEqual(Object.keys(result.recorded_housing).sort(), ['authority', 'basis', 'coverage', 'housing_version', 'mapping_version', 'profile', 'subject']);
  assert.deepEqual(Object.keys(result.recorded_housing.subject).sort(), ['category', 'origin', 'state']);
  assert.ok(Object.isFrozen(result.recorded_housing.coverage.states)); bounds(result);
});

test('known category match adds exactly 20 known points; mismatch remains known zero, not unknown', async () => {
  const same = build(await fixture()), different = build(await fixture({ parcels: [
    { account_id: SUBJECT }, { account_id: CANDIDATE, class_code: 'A12' },
  ] }));
  assert.deepEqual(property(same).factors.housing_type, { score: 100, state: 'observed' });
  assert.deepEqual(property(different).factors.housing_type, { score: 0, state: 'observed' });
  near(property(same).similarity.lower - property(different).similarity.lower, 20);
  near(property(same).similarity.known_weight_percent, property(different).similarity.known_weight_percent);
  for (const key of Object.keys(V1.weights).filter(k => k !== 'housing_type')) assert.deepEqual(property(same).factors[key], property(different).factors[key]);
  assert.equal(different.recorded_housing.subject.category, 'detached_single_family');
  bounds(same); bounds(different);
});

test('known mismatch narrows only the unknown upper bound; a match adds its full fixed weight', async () => {
  const make = class_code => fixture({ parcels: [{ account_id: SUBJECT }, { account_id: CANDIDATE, class_code }] });
  const unknown = build(await make('Unknown')), mismatch = build(await make('A12')), match = build(await make('A11'));
  const u = property(unknown).similarity, d = property(mismatch).similarity, m = property(match).similarity;
  near(d.lower, u.lower); near(d.upper, u.upper - 20); near(d.known_weight_percent, u.known_weight_percent + 20);
  near(m.lower, u.lower + 20); near(m.upper, u.upper); near(m.known_weight_percent, u.known_weight_percent + 20);
  for (const key of Object.keys(V1.weights).filter(k => k !== 'housing_type')) {
    assert.deepEqual(property(unknown).factors[key], property(match).factors[key]);
    assert.deepEqual(property(unknown).factors[key], property(mismatch).factors[key]);
  }
  bounds(unknown); bounds(mismatch); bounds(match);
});

for (const [class_code, label, category] of [
  ['A11', 'Single Family Detached', 'detached_single_family'], ['A12', 'Townhouse', 'townhouse'],
  ['A13', 'Condominium Unit', 'condominium'], ['B12', 'Duplex', 'duplex'], ['B11', 'Apartment', 'apartment'],
  ['A20', 'Mobile Home', 'mobile_home'], [null, 'Manufactured Home', 'manufactured_home'],
]) test(`exact recorded ${category} comparison is a match, without collapsing distinct categories`, async () => {
  const result = build(await fixture({ manual: { housing_profile: { housing_type: label } }, parcels: [
    { account_id: SUBJECT }, { account_id: CANDIDATE, class_code, structure_type: label },
  ] }));
  assert.equal(result.recorded_housing.subject.category, category);
  assert.deepEqual(property(result).factors.housing_type, { score: 100, state: 'observed' });
  assert.equal(property(result, SUBJECT).factors.housing_type.score, category === 'detached_single_family' ? 100 : 0,
    'subject CAD does not receive a forced matching category when saved subject observations differ');
  bounds(result);
});

test('mobile and manufactured homes are observed different categories, not an automatic match', async () => {
  const result = build(await fixture({ manual: { housing_profile: { housing_type: 'Manufactured Home' } },
    parcels: [{ account_id: SUBJECT }, { account_id: CANDIDATE, class_code: 'A20' }] }));
  assert.equal(result.recorded_housing.subject.category, 'manufactured_home');
  assert.deepEqual(property(result).factors.housing_type, { score: 0, state: 'observed' }); bounds(result);
});

for (const [name, extra, state] of [
  ['no parcel', [], 'missing'],
  ['missing cells', [{ class_code: null }], 'missing'],
  ['unknown code', [{ class_code: 'not-in-profile' }], 'unknown'],
  ['known plus missing sibling', [{}, { class_code: null }], 'partial'],
  ['known plus unknown sibling', [{}, { class_code: 'unlisted' }], 'partial'],
  ['different known siblings', [{}, { class_code: 'A12' }], 'conflicting'],
]) test(`candidate ${name} retains full denominator and no housing score`, async () => {
  const result = build(await fixture({ parcels: [{ account_id: SUBJECT }, ...extra.map(r => ({ account_id: CANDIDATE, ...r }))] }));
  assert.equal(result.properties.length, 2);
  assert.deepEqual(property(result).factors.housing_type, { score: null, state: `candidate_${state}` });
  assert.equal(result.all.factor_coverage.housing_type.observed_count, 1);
  assert.equal(result.all.factor_coverage.housing_type.unknown_count, 1);
  assert.equal(result.recorded_housing.coverage.states[state], 1); bounds(result);
});

test('partial subject CAD makes all housing comparisons unknown without hiding observed candidate evidence', async () => {
  const result = build(await fixture({ parcels: [{ account_id: SUBJECT }, { account_id: SUBJECT, class_code: null },
    { account_id: CANDIDATE }] }));
  assert.deepEqual(result.recorded_housing.subject, { state: 'partial', category: null, origin: 'current_subject_cad' });
  assert.equal(result.recorded_housing.coverage.observed_count, 1);
  assert.ok(result.properties.every(row => row.factors.housing_type.score === null && row.factors.housing_type.state === 'subject_partial'));
  bounds(result);
});

test('Dallas-only CAD interpretation is not silently applied to an unknown or different county', async () => {
  for (const county of [null, 'Collin']) {
    const result = build(await fixture({ county }));
    assert.equal(result.recorded_housing.subject.state, 'unknown');
    assert.equal(result.recorded_housing.coverage.observed_count, 0);
    assert.ok(result.properties.every(row => row.factors.housing_type.score === null)); bounds(result);
  }
});

for (const [name, profile, state] of [
  ['null profile', null, 'missing'],
  ['empty value', { housing_type: '' }, 'missing'],
  ['unknown value', { housing_type: 'Unknown' }, 'unknown'],
  ['conflicting values', { housing_type: 'Single Family Detached', structural_style: 'Condominium Unit' }, 'conflicting'],
]) test(`saved subject ${name} blocks a known public/CAD fallback`, async () => {
  const result = build(await fixture({ manual: { housing_profile: profile },
    publicProperty: { housing_profile: { housing_type: 'Single Family Detached' } } }));
  assert.equal(result.recorded_housing.subject.origin, 'saved_subject');
  assert.equal(result.recorded_housing.subject.state, state);
  assert.equal(result.recorded_housing.subject.category, null);
  assert.ok(result.properties.every(row => row.factors.housing_type.state === `subject_${state}` && row.factors.housing_type.score === null));
  assert.equal(result.recorded_housing.coverage.observed_count, 2, 'candidate evidence is not hidden by subject gap');
  assert.equal(result.all.factor_coverage.housing_type.observed_count, 0); bounds(result);
});

for (const origin of ['saved_subject', 'retained_subject_public']) test(`exact current subject label from ${origin} is a recorded observation only`, async () => {
  const profile = { housing_type: 'Single Family', attachment_type: 'detached', profile_source: 'verified_override' };
  const result = build(await fixture(origin === 'saved_subject' ? { manual: { housing_profile: profile } }
    : { publicProperty: { housing_profile: profile } }));
  assert.deepEqual(result.recorded_housing.subject, { state: 'observed', category: 'detached_single_family', origin });
  assert.equal(property(result).factors.housing_type.score, 100);
  assert.equal(result.recorded_housing.authority, 'not_established'); bounds(result);
});

test('v3 preserves real issued proximity scoring; no kernel lookup or invented radius', async () => {
  const args = await fixture({ proximity: true }), without = build(args), d = await withProximity(args), result = build(d.args);
  assert.equal(d.calls(), 1); assert.equal(result.evidence_mode, 'recorded_housing_and_proximity');
  assert.equal(result.recorded_proximity.status, 'available'); assert.equal(result.recorded_proximity.radius_metres, '4828.032');
  assert.deepEqual(Object.keys(result.unavailable_factors), ['sale_price']);
  assert.deepEqual(result.recorded_housing, without.recorded_housing);
  for (const row of result.properties) {
    assert.deepEqual(row.factors.proximity, { score: 50, state: 'observed' });
    for (const key of Object.keys(V1.weights).filter(k => k !== 'proximity')) assert.deepEqual(row.factors[key], property(without, row.account_id).factors[key]);
    near(row.similarity.lower - property(without, row.account_id).similarity.lower, 50 / 30);
  }
  assert.equal(d.calls(), 1); bounds(result);
});

test('issued but unavailable proximity remains explicit alongside known housing', async () => {
  const args = argsOf(await cadEvidenceFixture({ parcelOverrides: CAD }));
  const d = await withProximity(args), result = build(d.args);
  assert.equal(d.calls(), 0, 'fixture retains deliberately invalid EWKB, so native query must not run');
  assert.equal(result.recorded_proximity.status, 'unavailable');
  assert.equal(result.evidence_mode, 'recorded_housing_and_proximity');
  assert.equal(property(result).factors.housing_type.score, 100);
  assert.deepEqual(property(result).factors.proximity, { score: null, state: 'proximity_unavailable' }); bounds(result);
});

test('selection changes, empty, and input ordering do not recalibrate scores or mutate retained observations', async () => {
  const args = await fixture(), baseline = build(args), before = JSON.stringify(args);
  const strip = result => result.properties.map(({ selected, ...row }) => row);
  for (const ids of [[], [baseline.pockets[0].id], baseline.pockets.map(p => p.id).reverse()]) {
    const result = build({ ...args, selection: { revision: 41, included_recorded_group_ids: ids } });
    assert.deepEqual(strip(result), strip(baseline)); assert.deepEqual(result.all, baseline.all);
    assert.deepEqual(result.recorded_housing, baseline.recorded_housing);
    assert.deepEqual(result.recommended_recorded_group_ids, baseline.recommended_recorded_group_ids);
    assert.ok(result.properties.every(p => p.selected === ids.includes(p.recorded_group_id)));
    if (!ids.length) assert.equal(result.selected.member_count, 0); bounds(result);
  }
  const reverse = structuredClone(args);
  reverse.retained_inputs.acquisition.capture_result.source_capture.sources.reverse();
  for (const source of reverse.retained_inputs.acquisition.capture_result.source_capture.sources) source.payload.records.reverse();
  reverse.retained_inputs.spatial.account_ids.reverse(); reverse.retained_inputs.spatial.parcels.reverse();
  assert.deepEqual(strip(build(reverse)), strip(baseline));
  assert.equal(JSON.stringify(args), before);
  assert.throws(() => build({ ...args, selection: { revision: 42, included_recorded_group_ids: [`recorded-cad:${'0'.repeat(64)}`] } }), /unknown_group_id/);
});

test('all 45 candidate accounts, including unknowns and duplicates of a recorded category, remain in group means', async () => {
  const accounts = [SUBJECT, ...Array.from({ length: 44 }, (_, i) => `R-${String(i).padStart(3, '0')}`)];
  const names = Object.fromEntries(accounts.map(id => [id, 'Complete recorded group']));
  const args = await fixture({ accounts, names, parcels: accounts.map((account_id, index) => ({ account_id,
    class_code: index % 3 === 0 ? 'A11' : index % 3 === 1 ? 'A12' : 'Unknown',
  })) }), result = build(args);
  assert.equal(result.properties.length, 45); assert.equal(result.pockets[0].result.member_count, 45);
  assert.equal(result.recorded_housing.coverage.observed_count, 30); assert.equal(result.recorded_housing.coverage.unknown_count, 15);
  assert.equal(result.all.factor_coverage.housing_type.observed_count, 30);
  near(result.all.similarity.lower, result.properties.reduce((n, p) => n + p.similarity.lower, 0) / 45);
  assert.equal(result.selected.member_count, 0, 'recommendations never select accounts automatically'); bounds(result);
});
