import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomCohortRecordedHousing as build, CUSTOM_COHORT_RECORDED_HOUSING_PROFILE as PROFILE,
  CUSTOM_COHORT_RECORDED_HOUSING_CATEGORIES as CATEGORIES, CUSTOM_COHORT_RECORDED_HOUSING_STATES as STATES,
  CUSTOM_COHORT_RECORDED_HOUSING_LIMITS as LIMITS } from '../src/services/neighborhoodAssessment/customCohortRecordedHousing.js';
import { buildCustomCohortObservationPreview } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCachedSourceCaptures } from '../src/services/neighborhoodAssessment/cachedSourceCaptures.js';
import { mapCadEvidenceParcelRow, mapCadEvidenceAccountRow } from '../src/services/neighborhoodAssessment/cachedRowMappingsV4.js';
import { projectCustomNeighborhoodMaterialInputs } from '../src/services/neighborhoodAssessment/customMaterialInputs.js';
import { inputs, setPublic, setSection, argumentsOf } from './fixtures/neighborhoodCustomMaterialInputsFixture.js';
import { cadEvidenceFixture } from './fixtures/customCohortCadEvidenceFixture.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';
import { saleWitnessMeaningFixture } from './fixtures/customCohortSaleWitnessMeaningFixture.js';

const SUBJECT = '0000123456789', OTHER = 'B';
const CAD = { class_code: 'A11', class_description: null, use_description: null, structure_type: null, built_up: null };
const EMPTY = { ...CAD, class_code: null };
const error = reason => e => e.code === 'CUSTOM_COHORT_RECORDED_HOUSING_INVALID' && e.reason === reason;
const groupsOf = catalog => [...catalog.pockets, ...(catalog.unassigned.member_count
  ? [{ id: 'discovery:unassigned', account_ids: catalog.unassigned.account_ids }] : [])];
const argsOf = f => ({ retained_inputs: f.input.retained_inputs, preview: f.preview, groups: groupsOf(f.catalog) });
let original;
const actual = () => original ??= cadEvidenceFixture();
const candidate = result => result.accounts.find(row => row.account_id === OTHER);

// These focused consumer fixtures build real v4 mapped rows, source chunks and
// material projections. They are NOT new original-owner captures or evidence
// verification. The actual fixture test separately covers capture/persist/reopen.
async function fixture({ accounts = [SUBJECT, OTHER], parcels, counties = {}, accountRows, manual, publicHousing,
  groups = [{ id: 'recorded-housing:all', account_ids: accounts }] } = {}) {
  const f = await actual(), retained = structuredClone(f.input.retained_inputs);
  const scope = retained.acquisition.capture_result.source_capture.scope;
  const parcelRows = (parcels ?? accounts.map(account_id => ({ account_id }))).map((row, index) => ({
    object_id: String(index + 1), residential_year_built: 2000, residential_area_sqft: '1800',
    parcel_area_sqft: '6000', current_market_value: '300000', land_use_category: 'one_unit', ...CAD, ...row,
  }));
  const wrap = (rows, mapper, role) => rows.map((row, index) => {
    const data = mapper(row); return { record_id: `${role}:${index}:${data.record_id}`, data };
  });
  const roles = {
    selection: accounts.map(account_id => ({ record_id: `selection:${account_id}`, data: { account_id } })),
    parcels: wrap(parcelRows, mapCadEvidenceParcelRow, 'parcel'),
    accounts: wrap(accountRows ?? accounts.map(account_id => ({ account_id,
      county: Object.hasOwn(counties, account_id) ? counties[account_id] : 'Dallas', subdivision: 'Synthetic group' })), mapCadEvidenceAccountRow, 'account'),
    transactions: [], sale_links: [], gis_sync: [],
  };
  const now = retained.acquisition.capture_result.captured_at;
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
  retained.acquisition.capture_result.source_capture = capture;
  retained.acquisition.captured_query_request.account_ids = [...accounts];
  retained.spatial.account_ids = [...accounts];
  retained.spatial.parcels = parcelRows.map(row => ({ object_id: row.object_id, account_id: row.account_id }));
  if (manual !== undefined || publicHousing !== undefined) {
    const raw = inputs(); raw.target = { ...retained.subject.target };
    setPublic(raw, { account: { account_id: SUBJECT }, ...(publicHousing === undefined ? {} : { housing_profile: publicHousing }) });
    if (manual !== undefined) setSection(raw, 1, JSON.stringify({ housing_profile: manual }));
    const result = projectCustomNeighborhoodMaterialInputs(...argumentsOf(raw));
    assert.ok(result.material_input); retained.subject.material = result.material_input;
  }
  const preview = buildCustomCohortObservationPreview({ context_ref: f.input.expected.context_ref, retained_inputs: retained,
    selection: { revision: 1, pockets: [] } });
  return { retained_inputs: retained, preview, groups: structuredClone(groups) };
}
function counts(result) {
  for (const row of [result.coverage, ...result.pockets]) {
    assert.deepEqual(Object.keys(row.states), STATES);
    assert.equal(Object.values(row.states).reduce((a, b) => a + b, 0), row.account_count);
    assert.equal(row.observed_count, row.states.observed);
    assert.equal(row.observed_count + row.unknown_count, row.account_count);
  }
  assert.equal(result.pockets.reduce((sum, row) => sum + row.account_count, 0), result.accounts.length);
  for (const row of [result.subject, ...result.accounts]) assert.equal(row.category !== null, row.state === 'observed');
}

test('installed profile is fixed and dictionary meanings are observation-only', () => {
  assert.deepEqual(PROFILE, { id: 'custom-recorded-housing-v1', revision: 1,
    content_sha256: '12871b3b6251f507a19b1ac20e45df07ace43f6d10654ee513f314ad830de391' });
  assert.deepEqual(CATEGORIES, ['detached_single_family', 'townhouse', 'condominium', 'duplex', 'apartment', 'mobile_home', 'manufactured_home']);
  assert.ok(Object.isFrozen(PROFILE) && Object.isFrozen(CATEGORIES) && Object.isFrozen(LIMITS));
});
for (const known of [false, true]) test(`genuine mapping4 capture/persist/reopen resolves ${known ? 'A11' : 'unknown numeric/literal'} without I/O`, async () => {
  const f = known ? await cadEvidenceFixture({ parcelOverrides: CAD }) : await actual();
  const args = argsOf(f), before = JSON.stringify(args), calls = f.base.f.state.calls.length;
  const result = build(args); counts(result);
  assert.equal(result.subject.state, known ? 'observed' : 'unknown');
  assert.equal(result.subject.origin, 'current_subject_cad');
  assert.equal(result.coverage.observed_count, known ? 2 : 0);
  assert.equal(result.authority, 'not_established');
  assert.ok(result.limitations.includes('current_observations_not_historical_housing_population'));
  assert.equal(Object.hasOwn(result, 'apply'), false);
  assert.equal(JSON.stringify(args), before); assert.equal(f.base.f.state.calls.length, calls);
  assert.ok(Object.isFrozen(result.accounts[0]) && Object.isFrozen(result.coverage.states));
  assert.throws(() => { result.accounts[0].category = 'duplex'; }, TypeError);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= LIMITS.output_utf8_bytes);
});
for (const [version, factory] of [[2, decisionEvidenceFixture], [3, saleWitnessMeaningFixture]]) {
  test(`legacy mapping${version} stays null without inspecting housing or preview`, async () => {
    const f = await factory(), before = JSON.stringify(f.input);
    assert.equal(build({ retained_inputs: f.input.retained_inputs }), null);
    assert.equal(JSON.stringify(f.input), before);
  });
}

for (const [code, description, category] of [
  ['A11', 'SINGLE FAMILY RESIDENCES', 'detached_single_family'], ['A12', 'SFR - TOWNHOUSES', 'townhouse'],
  ['A13', 'SFR - CONDOMINIUMS', 'condominium'], ['A20', 'MOBILE HOME ON OWNERS LAND', 'mobile_home'],
  ['B11', 'MFR - APARTMENTS', 'apartment'], ['B12', 'MFR - DUPLEXES', 'duplex'],
]) test(`Dallas whole legacy ${code} and exact description independently resolve ${category}`, async () => {
  for (const row of [{ class_code: ` ${code.toLowerCase()} ` }, { class_code: '111', class_description: description, structure_type: '999' }]) {
    const result = build(await fixture({ parcels: [{ account_id: SUBJECT }, { account_id: OTHER, ...row }] }));
    assert.equal(candidate(result).category, category); counts(result);
  }
});
for (const [literal, category] of [['Single Family Detached', 'detached_single_family'], ['Townhome', 'townhouse'],
  ['Condominium', 'condominium'], ['Duplex', 'duplex'], ['Apartment', 'apartment'], ['Mobile Home', 'mobile_home'],
  ['Manufactured Home', 'manufactured_home']]) test(`exact literal ${literal} is distinct category ${category}`, async () => {
  const result = build(await fixture({ parcels: [{ account_id: SUBJECT }, { account_id: OTHER, ...EMPTY, structure_type: ` ${literal.toLowerCase()} ` }] }));
  assert.equal(candidate(result).category, category); counts(result);
});
for (const literal of ['One_Unit', 'Single Family', 'SFR', 'Attached', 'Condo/Townhome', 'Attached/Duplex',
  'Half Duplex', 'Mixed/Review', 'A11 extra', 'Single Family Detached extra', 'Single  Family Detached', 'CONDO\n']) {
  test(`unsupported or ambiguous whole literal ${JSON.stringify(literal)} stays unknown`, async () => {
    const result = build(await fixture({ parcels: [{ account_id: SUBJECT }, { account_id: OTHER, ...EMPTY, structure_type: literal, built_up: true }] }));
    assert.equal(candidate(result).state, 'unknown'); assert.equal(candidate(result).category, null);
  });
}
test('numeric codes, broad one_unit and built_up never create completion or housing meaning', async () => {
  for (const built_up of [false, true, null]) {
    const result = build(await fixture({ parcels: [{ account_id: OTHER, ...EMPTY, class_code: '111', structure_type: '1', built_up }] }));
    assert.equal(candidate(result).state, 'unknown'); assert.equal(result.subject.state, 'missing');
  }
});
test('live-style numeric CLASSCD plus padded exact description resolves without interpreting story labels', async () => {
  const f = await cadEvidenceFixture({ parcelOverrides: { ...EMPTY, class_code: '1',
    class_description: 'SINGLE FAMILY RESIDENCES                 ', structure_type: 'TWO STORIES' } });
  const result = build(argsOf(f));
  assert.equal(result.subject.category, 'detached_single_family');
  assert.equal(result.coverage.observed_count, 2); counts(result);
});
test('observed story-count vocabulary alone cannot fill unknown housing or numeric code meaning', async () => {
  for (const structure_type of [null, 'N/A', 'ONE AND ONE HALF STORIES', 'ONE STORY', 'THREE STORIES',
    'TWO AND ONE HALF STORIES', 'TWO STORIES']) {
    const result = build(await fixture({ parcels: [{ account_id: OTHER, ...EMPTY, class_code: '1', structure_type }] }));
    assert.equal(candidate(result).state, 'unknown'); assert.equal(candidate(result).category, null);
  }
});
test('known-field contradiction conflicts; explicit alternative blocks a compatible known code', async () => {
  const conflict = build(await fixture({ parcels: [{ account_id: OTHER, class_description: 'SFR - TOWNHOUSES' }] }));
  assert.equal(candidate(conflict).state, 'conflicting');
  const mixed = build(await fixture({ parcels: [{ account_id: OTHER, structure_type: 'CONDO/TOWNHOME' }] }));
  assert.equal(candidate(mixed).state, 'unknown');
});
for (const county of [null, '', 'Collin', 'Dallas County', 'DALLAS extra']) test(`unestablished Dallas county ${JSON.stringify(county)} cannot use dictionary`, async () => {
  const r = build(await fixture({ counties: { [OTHER]: county }, parcels: [{ account_id: OTHER, class_description: 'SFR - TOWNHOUSES' }] }));
  assert.equal(candidate(r).state, 'unknown');
});
test('all retained county observations must agree on Dallas', async () => {
  const r = build(await fixture({ accountRows: [{ account_id: SUBJECT, county: 'Dallas' },
    { account_id: OTHER, county: 'Dallas' }, { account_id: OTHER, county: null }] }));
  assert.equal(candidate(r).state, 'unknown');
});
for (const [name, extra, state] of [['same', {}, 'observed'], ['missing', EMPTY, 'partial'],
  ['unknown', { ...EMPTY, class_code: '111' }, 'partial'], ['different', { class_code: 'A12' }, 'conflicting']]) {
  test(`all-parcel aggregation ${name} preserves complete uncertainty`, async () => {
    const args = await fixture({ parcels: [{ account_id: OTHER }, { account_id: OTHER }, { account_id: OTHER, ...extra }] });
    const result = build(args); assert.equal(candidate(result).state, state); assert.equal(result.subject.state, 'missing'); counts(result);
    const reordered = structuredClone(args);
    reordered.retained_inputs.acquisition.capture_result.source_capture.sources.forEach(s => s.payload.records.reverse());
    assert.deepEqual(build(reordered), result);
  });
}
test('all-missing and no parcel records remain missing with full-account denominator', async () => {
  const result = build(await fixture({ accounts: [SUBJECT, OTHER, 'C'], parcels: [{ account_id: OTHER, ...EMPTY }] }));
  assert.equal(result.coverage.states.missing, 3); assert.equal(result.coverage.account_count, 3); counts(result);
});

for (const [manual, state] of [[null, 'missing'], [{ housing_type: null }, 'missing'], [{ housing_type: ' ' }, 'missing'],
  [{ housing_type: 'Unknown' }, 'unknown'], [{ housing_type: 'Provider unmapped form', structural_style: 'Single Family Detached' }, 'unknown'],
  [{ housing_type: 'Single Family Detached', structural_style: 'Condominium' }, 'conflicting']]) {
  test(`explicit saved housing ${JSON.stringify(manual)} blocks public/CAD fallback`, async () => {
    const r = build(await fixture({ manual, publicHousing: { housing_type: 'Duplex' } }));
    assert.deepEqual(r.subject, { state, category: null, origin: 'saved_subject' });
  });
}
test('absent saved falls to retained public; absent both falls to same-account CAD', async () => {
  const r = build(await fixture({ publicHousing: { housing_type: 'Condominium' } }));
  assert.deepEqual(r.subject, { state: 'observed', category: 'condominium', origin: 'retained_subject_public' });
  assert.equal(build(await fixture()).subject.origin, 'current_subject_cad');
});
test('retained public null blocks CAD, and saved absence does not cross-merge attachment', async () => {
  assert.equal(build(await fixture({ publicHousing: null })).subject.state, 'missing');
  const r = build(await fixture({ manual: { housing_type: 'Single Family' }, publicHousing: { attachment_type: 'detached' } }));
  assert.deepEqual(r.subject, { state: 'unknown', category: null, origin: 'saved_subject' });
});
for (const [housing, state, category] of [
  [{ housing_type: 'Single Family', attachment_type: 'detached' }, 'observed', 'detached_single_family'],
  [{ housing_type: 'Single Family', attachment_type: 'attached' }, 'unknown', null],
  [{ housing_type: 'Single Family', attachment_type: 'unknown' }, 'unknown', null],
  [{ housing_type: 'Single Family Detached', attachment_type: 'unknown' }, 'observed', 'detached_single_family'],
  [{ housing_type: 'Single Family Detached', attachment_type: 'attached' }, 'conflicting', null],
  [{ housing_type: 'Townhouse', attachment_type: 'detached' }, 'conflicting', null],
  [{ housing_type: null, structural_style: 'Single Family Detached' }, 'missing', null],
  [{ structural_style: 'Single Family Detached' }, 'observed', 'detached_single_family'],
  [{ housing_type: 'Single Family', attachment_type: 'detached', structural_style: 'Duplex' }, 'conflicting', null],
]) test(`same-source subject semantics ${JSON.stringify(housing)}`, async () => {
  assert.deepEqual(build(await fixture({ manual: housing })).subject, { state, category, origin: 'saved_subject' });
});
test('profile source/confidence and architectural style never establish meaning or authority', async () => {
  const r = build(await fixture({ manual: { housing_type: 'unmapped', architectural_style: 'Condominium',
    profile_source: 'verified_override', confidence: 1, source_name: 'Claimed licensed reviewer' } }));
  assert.equal(r.subject.state, 'unknown'); assert.equal(r.authority, 'not_established');
});
test('subject outside discovery can use retained saved housing without entering the account population', async () => {
  const r = build(await fixture({ accounts: [OTHER], manual: { housing_type: 'Mobile Home' } }));
  assert.equal(r.subject.category, 'mobile_home'); assert.deepEqual(r.accounts.map(x => x.account_id), [OTHER]); counts(r);
});
test('recorded groups partition all accounts and are output in deterministic order', async () => {
  const args = await fixture({ groups: [{ id: 'z', account_ids: [OTHER] }, { id: 'a', account_ids: [SUBJECT] }] });
  const r = build(args); assert.deepEqual(r.pockets.map(g => g.id), ['a', 'z']); counts(r);
  args.groups.reverse(); assert.deepEqual(build(args), r);
});
for (const [name, mutate, reason] of [
  ['preview time', a => { a.preview.captured_at = '2020-01-01T00:00:00.000Z'; }, 'preview_capture_mismatch'],
  ['target', a => { a.preview.target.account_id = 'foreign'; }, 'target_mismatch'],
  ['source refs', a => { a.preview.source_snapshots[0].content_sha256 = 'b'.repeat(64); }, 'preview_capture_mismatch'],
  ['missing member', a => { a.retained_inputs.spatial.account_ids.pop(); }, 'stock_roster_mismatch'],
  ['group omission', a => { a.groups[0].account_ids.pop(); }, 'group_partition'],
  ['group duplicate', a => { a.groups[0].account_ids.push(SUBJECT); }, 'group_partition'],
  ['duplicate group', a => { a.groups.push({ id: a.groups[0].id, account_ids: [] }); }, 'group_identity'],
  ['mapping', a => { a.retained_inputs.acquisition.capture_result.source_capture.sources[0].payload.projection.definition.mapping_version = 3; }, 'mapping_profile_mismatch'],
  ['limit', a => { a.preview.all.stock.members = new Array(LIMITS.accounts + 1); }, 'input_limit'],
]) test(`rejects incoherent ${name} without repair`, async () => {
  const a = structuredClone(await fixture()); mutate(a); assert.throws(() => build(a), error(reason));
});
test('duplicate source records and non-string or oversized retained literal are rejected', async () => {
  for (const [mutate, reason] of [
    [rows => rows.push(rows[0]), 'duplicate_source_record'],
    [rows => { rows[0].data.raw_projection.class_code = 111; }, 'literal_type'],
    [rows => { rows[0].data.raw_projection.class_code = 'x'.repeat(LIMITS.cad_literal_utf8_bytes + 1); }, 'literal_type'],
    [rows => { rows[0].data.raw_projection.class_code = 'é'.repeat(LIMITS.cad_literal_utf8_bytes); }, 'literal_limit'],
  ]) {
    const a = structuredClone(await fixture()), rows = a.retained_inputs.acquisition.capture_result.source_capture.sources
      .find(s => s.payload.projection.definition.role === 'parcels').payload.records;
    mutate(rows); assert.throws(() => build(a), error(reason));
  }
});
test('plain data guards do not invoke getters/proxies or return a partial result', async () => {
  const a = await fixture(); let invoked = 0;
  const getter = { ...a }; Object.defineProperty(getter, 'groups', { enumerable: true, get() { invoked++; return a.groups; } });
  assert.throws(() => build(getter), error('data_property'));
  assert.throws(() => build(new Proxy(a, { get() { invoked++; } })), error('plain_object'));
  assert.equal(invoked, 0);
});
