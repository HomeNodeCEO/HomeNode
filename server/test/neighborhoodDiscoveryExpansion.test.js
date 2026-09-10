import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareNeighborhoodDiscoveryChoice, prepareNeighborhoodSelectorInput, prepareNeighborhoodSelectorInputV1,
  NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V1 as V1, NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V2 as V2,
  NEIGHBORHOOD_DISCOVERY_RADII_METRES as RADII } from '../src/services/neighborhoodAssessment/selectorInputProfile.js';
import { captureNeighborhoodSpatialMembership } from '../src/services/neighborhoodAssessment/cachedSpatialMembership.js';
import { prepareCustomCohortCaptureInputs, loadCustomCohortCaptureInputs } from '../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { buildCustomCohortObservationPreview } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { prepareCustomCohortContextHeader } from '../src/services/neighborhoodAssessment/customCohortContextContract.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';
import { customCohortDiscoveryExpansionFixture } from './fixtures/customCohortDiscoveryExpansionFixture.js';

const hash = value => createHash('sha256').update(json(value)).digest('hex');
const choice = (radius = '8046.72') => ({ profile_id: V2, radius_metres: radius });
const id = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const geometry = () => ({ geometry_version: 1, type: 'Point', crs: 'EPSG:4326', axis_order: 'longitude_latitude',
  coordinate_encoding: 'decimal_string_v1', coordinates: ['-96.63', '32.88'], source_sha256: 'a'.repeat(64) });
function selectorInput(profile_id = V2, radius = '8046.72') {
  return { profile_id, target: { report_file_id: id(1), workflow_type: 'custom_appraisal', workflow_target_id: '2' },
    scope: { organization_id: id(3), appraisal_case_id: id(4), subject_snapshot_id: id(5), account_id: '0002' },
    effective_date: '2026-09-07', selection: { id: 'original-selection', revision: 1, source_sha256: 'a'.repeat(64) },
    geometry_input: geometry(), discovery: { radius_metres: radius, distance_semantics: 'postgis_geography_spheroid_v1',
      parcel_predicate: 'all_intersecting_parcels' }, roster: { complete: true, account_count: 2, account_ids: ['0001', '0002'] } };
}
const snapshot = { isolation: 'repeatable read', read_only: 'on', backend_pid: 12,
  snapshot: '100:105:101,102', transaction_started_at: '2026-09-08T16:00:00.123456Z' };
const parcel = index => ({ object_id: String(index), account_id: `000${index}`, source_record_hash: 'b'.repeat(64),
  geometry_sha256: 'c'.repeat(64), sync_run_id: id(6), synced_at: '2026-09-08T15:00:00.123456Z', source_updated_at: null });
function spatialClient(rows = [parcel(1)], options = {}) {
  const calls = [];
  return { calls, async query(call) {
    calls.push(call);
    const tag = /neighborhood-membership:([^* ]+)/.exec(call.text)?.[1];
    if (tag === options.throwOn) throw Object.assign(new Error('synthetic failure'), { code: '57014' });
    if (tag === 'snapshot') return { rows: [options.snapshot ?? snapshot] };
    if (tag === 'snapshot-end') return { rows: [options.end ?? snapshot] };
    if (tag === 'geometry-eligibility') return { rows: options.invalidGeometry ? [{ object_id: '99' }] : [] };
    assert.equal(tag, 'parcels');
    return { rows: rows.filter(row => call.values[2] === null || BigInt(row.object_id) > BigInt(call.values[2]))
      .slice(0, call.values[3]).map(payload => ({ payload })) };
  } };
}
function deepFrozen(value) {
  if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(deepFrozen); }
}

test('exact three installed radius choices are detached and frozen without authority fields', () => {
  assert.deepEqual(RADII, ['4828.032', '8046.72', '16093.44']); assert.ok(Object.isFrozen(RADII));
  for (const radius of RADII) {
    const original = choice(radius), checked = prepareNeighborhoodDiscoveryChoice(original);
    assert.deepEqual(checked, original); assert.notEqual(checked, original); deepFrozen(checked);
    original.radius_metres = 'changed'; assert.equal(checked.radius_metres, radius);
    assert.equal(Object.hasOwn(checked, 'authority'), false);
  }
});
for (const [name, value] of [
  ['absent', undefined], ['null', null], ['array', []], ['string', '5'], ['number', 8046.72],
  ['old profile', { profile_id: V1, radius_metres: '4828.032' }], ['future profile', { ...choice(), profile_id: 'future' }],
  ['missing radius', { profile_id: V2 }], ['numeric radius', choice(8046.72)], ['padded radius', choice(' 8046.72')],
  ['trailing zero alias', choice('8046.720')], ['exponent alias', choice('8.04672e3')], ['uninstalled', choice('5000')],
  ['infinite', choice(Infinity)], ['symbol', choice(Symbol('radius'))], ['boxed', choice(new String('8046.72'))],
  ['extra grant', { ...choice(), allowed: true }], ['extra miles', { ...choice(), miles: 5 }],
]) test(`choice refuses ${name} with one bounded fixed error`, () => {
  assert.throws(() => prepareNeighborhoodDiscoveryChoice(value), { name: 'TypeError', message: 'invalid_neighborhood_discovery_choice' });
});
test('choice and selector reject proxies/getters/custom prototypes without invoking them', () => {
  let calls = 0;
  const trap = () => { calls += 1; throw new Error('not data'); };
  const getter = choice(); Object.defineProperty(getter, 'radius_metres', { enumerable: true, get: trap });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const proxy = new Proxy(choice(), { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
  const symbolic = choice(); symbolic[Symbol('hidden')] = true;
  const hidden = choice(); Object.defineProperty(hidden, 'radius_metres', { value: '8046.72', enumerable: false });
  for (const input of [getter, proxy, revoked.proxy, symbolic, hidden, Object.assign(Object.create({}), choice())]) {
    assert.throws(() => prepareNeighborhoodDiscoveryChoice(input), TypeError);
  }
  const selector = selectorInput(); Object.defineProperty(selector, 'profile_id', { enumerable: true, get: trap });
  assert.equal(prepareNeighborhoodSelectorInput(selector).status, 'invalid');
  assert.equal(prepareNeighborhoodSelectorInput(proxy).status, 'invalid');
  assert.equal(calls, 0);
});
test('v2 selector binds profile/radius while preserving exact fixed spatial semantics and authority limits', () => {
  const hashes = new Set();
  for (const radius of RADII) {
    const input = selectorInput(V2, radius), before = JSON.stringify(input), result = prepareNeighborhoodSelectorInput(input);
    assert.equal(result.status, 'prepared'); assert.equal(result.query_input.definition.query_input_version, 2);
    assert.equal(result.query_input.definition.profile_id, V2); assert.deepEqual(result.query_input.definition.discovery, input.discovery);
    assert.equal(result.authority, 'not_established'); assert.equal(result.spatial_membership, 'unverified');
    assert.equal(result.roster_completeness, 'declared_not_verified'); assert.equal(result.source_origin, 'unverified');
    assert.equal(result.query_input.sha256, hash(result.query_input.definition));
    assert.equal(JSON.stringify(input), before); deepFrozen(result); hashes.add(result.selection_binding_sha256);
    assert.equal(prepareNeighborhoodSelectorInputV1(input).status, 'unsupported');
  }
  assert.equal(hashes.size, 3);
  assert.notEqual(prepareNeighborhoodSelectorInput(selectorInput(V1, RADII[0])).selection_binding_sha256,
    prepareNeighborhoodSelectorInput(selectorInput(V2, RADII[0])).selection_binding_sha256);
});
test('v2 does not loosen selector geometry, roster, profile or discovery admission', () => {
  for (const mutate of [
    v => { v.discovery.radius_metres = '16093.440'; }, v => { v.discovery.distance_semantics = 'planar'; },
    v => { v.discovery.parcel_predicate = 'centroid'; }, v => { v.discovery.extra = true; },
    v => { v.profile_id = 'future'; }, v => { v.target.workflow_type = 'uad_3_6'; },
    v => { v.roster.complete = false; }, v => { v.roster.account_count = 1; },
    v => { v.roster.account_ids = ['0002', '0001']; }, v => { v.geometry_input.coordinates[0] = '-181'; },
  ]) { const input = selectorInput(); mutate(input); const out = prepareNeighborhoodSelectorInput(input);
    assert.notEqual(out.status, 'prepared'); assert.equal(Object.hasOwn(out, 'selection'), false); }
  assert.equal(prepareNeighborhoodSelectorInput(selectorInput(V1, '8046.72')).status, 'unsupported');
});
test('omitted choice keeps the exact old SQL, four parameters and successful shape', async () => {
  const client = spatialClient(), first = await captureNeighborhoodSpatialMembership(client, geometry());
  const explicitUndefined = await captureNeighborhoodSpatialMembership(spatialClient(), geometry(), {}, undefined);
  assert.deepEqual(explicitUndefined, first); assert.equal(Object.hasOwn(first, 'discovery'), false);
  const query = client.calls.find(q => q.text.includes(':parcels'));
  assert.deepEqual(query.values, ['-96.63', '32.88', null, 501]);
  assert.equal(createHash('sha256').update(query.text.replaceAll('\r\n', '\n')).digest('hex'),
    'a82a5a39727c5c3f3ecd8aa0e9cba5290236d08d81f6e0a13836bbef73036fed');
});
test('new spatial domain separates all radii and v1 even for exactly the same parcel roster', async () => {
  const values = [];
  for (const radius of RADII) {
    const client = spatialClient(), result = await captureNeighborhoodSpatialMembership(client, geometry(), {}, choice(radius));
    assert.equal(result.status, 'captured'); assert.equal(result.radius_metres, radius); assert.deepEqual(result.discovery, choice(radius));
    assert.equal(result.authority, 'not_established'); assert.equal(result.source_coverage, 'not_established'); deepFrozen(result);
    const query = client.calls.find(q => q.text.includes(':parcels'));
    assert.match(query.text, /\$5::double precision, true/); assert.equal(query.values[4], radius);
    assert.doesNotMatch(query.text, /centroid|sale_price|LIMIT 5\b|land_use_category/i);
    const expected = createHash('sha256').update('homenode-cached-spatial-membership-v2\n').update(json({
      geometry_input: geometry(), discovery: choice(radius), distance_semantics: 'postgis_geography_spheroid_v1',
      parcel_predicate: 'all_intersecting_parcels' })).update('\n').update(json(parcel(1))).update('\n').digest('hex');
    assert.equal(result.membership_sha256, expected); values.push(expected);
    assert.ok(client.calls.every(q => !/\b(BEGIN|COMMIT|ROLLBACK|SET LOCAL)\b/.test(q.text)));
  }
  values.push((await captureNeighborhoodSpatialMembership(spatialClient(), geometry())).membership_sha256);
  assert.equal(new Set(values).size, 4);
});
test('v2 snapshot and capacity failures remain whole-result failures without partial memberships', async () => {
  for (const [limits, options, reason] of [
    [{ parcels: 1 }, {}, 'parcel_limit'], [{ accounts: 1 }, {}, 'account_limit'], [{ bytes: 1 }, {}, 'byte_limit'],
    [{}, { invalidGeometry: true }, 'cached_geometry_ineligible'],
    [{}, { snapshot: { ...snapshot, read_only: 'off' } }, 'repeatable_read_read_only_transaction_required'],
    [{}, { end: { ...snapshot, backend_pid: 13 } }, 'transaction_changed'],
  ]) {
    const result = await captureNeighborhoodSpatialMembership(spatialClient([parcel(1), parcel(2)], options), geometry(), limits, choice(RADII[2]));
    assert.equal(result.status, 'incomplete'); assert.equal(result.reason, reason); assert.equal(result.query_complete, false);
    assert.equal(Object.hasOwn(result, 'parcels'), false); assert.equal(Object.hasOwn(result, 'membership_sha256'), false);
  }
  const client = spatialClient();
  await assert.rejects(captureNeighborhoodSpatialMembership(client, geometry(), {}, null), TypeError); assert.equal(client.calls.length, 0);
  await assert.rejects(captureNeighborhoodSpatialMembership(spatialClient([], { throwOn: 'parcels' }), geometry(), {}, choice()), { code: '57014' });
});
test('spatial queries use the admitted snapshot even if the caller changes its choice while awaiting SQL', async () => {
  const original = choice(), client = spatialClient(), query = client.query.bind(client);
  client.query = call => { original.radius_metres = RADII[2]; return query(call); };
  const result = await captureNeighborhoodSpatialMembership(client, geometry(), {}, original);
  assert.equal(result.radius_metres, '8046.72'); assert.deepEqual(result.discovery, choice());
  assert.equal(client.calls.find(call => call.text.includes(':parcels')).values[4], '8046.72');
});
test('v1 full retained fixture, selector, spatial result and exact context retain pre-change golden hashes', async () => {
  const f = await decisionEvidenceFixture(), i = f.input.retained_inputs;
  assert.equal(hash(i), '2d9f335ec934089825c94709ede8483c7367d1d76c899cd35cd19da235ea9c63');
  assert.equal(hash(i.selector), 'c960b3f1f15aecbbb0962135bc7b3d95a1f683a8f0e6a307cada9c099613ef88');
  assert.equal(hash(i.spatial), '936391bbad1f0da05bc204e9b70c61370823775da518e92d580afd409c987a39');
  assert.equal(hash(f.input.expected.context_ref), 'abe2c69087ad176d9821e96c4bfef3216ab0c26cd5601e4c7f290e45156e2906');
  const input = selectorInput(V1, RADII[0]); assert.deepEqual(prepareNeighborhoodSelectorInput(input), prepareNeighborhoodSelectorInputV1(input));
});
for (const [index, radius] of RADII.entries()) for (const privateSales of [false, true]) {
  test(`genuine ${radius} acquisition persists/reopens every original row${privateSales ? ' and private supplement' : ''}`, async () => {
    const f = await customCohortDiscoveryExpansionFixture({ radius, privateSales });
    assert.deepEqual(f.reopened.retained_inputs, f.input); assert.equal(f.reopened.summary.radius_metres, radius);
    assert.equal(f.reopened.summary.account_count, index + 2); assert.deepEqual(f.reopened.study.discovery, choice(radius));
    assert.equal(f.reopened.study.profile_id, V2); assert.equal(f.reopened.study.knowledge_cutoff, null);
    assert.deepEqual(f.input.subject, f.previous.subject); assert.equal(f.input.acquisition_intent.body.intent_version, privateSales ? 2 : 1);
    assert.equal(Object.hasOwn(f.reopened.retained_inputs, 'private_sales'), privateSales);
    assert.deepEqual(JSON.parse(f.input.acquisition.compact_metadata_json).authorization.market_decision,
      JSON.parse(f.previous.acquisition.compact_metadata_json).authorization.market_decision);
    const header = prepareCustomCohortContextHeader(json({ ...JSON.parse(f.originalContextHeaderJson), ...f.refs }));
    const preview = buildCustomCohortObservationPreview({ context_ref: header.context_ref,
      retained_inputs: f.reopened.retained_inputs, selection: { revision: 7, pockets: [] } });
    assert.equal(preview.all.stock.member_count, index + 2);
    assert.equal(preview.all.stock.temporal_basis, 'current_mirror_observation');
    assert.equal(preview.all.stock.assessment_tax_year, null); assert.equal(preview.apply.status, 'blocked');
    assert.equal(preview.all.transactions.member_count, 1); // The original 2024 closing remains observed.
    if (privateSales) assert.equal(f.reopened.retained_inputs.private_sales.capture.rows[0].record_data.values.close_price, '275000');
    deepFrozen(f.reopened);
  });
}
test('changed study/selector/spatial/intent/private bindings are rejected without a persistence query', async () => {
  const f = await customCohortDiscoveryExpansionFixture({ privateSales: true });
  const mutations = [
    i => { i.study.discovery.radius_metres = RADII[2]; }, i => { i.study.discovery.profile_id = V1; },
    i => { i.study.profile_id = V1; }, i => { delete i.study.discovery; }, i => { i.study.extra = true; },
    i => { i.spatial.radius_metres = RADII[2]; }, i => { delete i.spatial.discovery; },
    i => { i.spatial.discovery.radius_metres = RADII[2]; }, i => { i.spatial.membership_sha256 = f.previous.spatial.membership_sha256; },
    i => { i.selector.query_input.definition.discovery.radius_metres = RADII[2]; },
    i => { i.selector.query_input.definition.profile_id = V1; }, i => { i.selector = structuredClone(f.previous.selector); },
    i => { i.acquisition_intent.body.study.discovery.radius_metres = RADII[2]; },
    i => { i.private_sales.capture.review.revision = 2; }, i => { i.private_sales.capture.source_interpretation.source_use_confirmed = false; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(f.input); mutate(changed); const before = f.f.state.calls.length;
    assert.throws(() => prepareCustomCohortCaptureInputs(changed)); assert.equal(f.f.state.calls.length, before);
  }
  const wrong = structuredClone(f.refs); wrong.study_input = f.previous.subject_reference;
  await assert.rejects(loadCustomCohortCaptureInputs(f.client, f.scopeJson, wrong));
  const storedStudy = JSON.parse(await f.store.get(f.refs.study_input.content_sha256, f.refs.study_input.canonical_utf8_bytes));
  storedStudy.settings.discovery.radius_metres = RADII[2];
  const rehashedStudy = await f.store.put(json(storedStudy));
  await assert.rejects(loadCustomCohortCaptureInputs(f.client, f.scopeJson, { ...f.refs, study_input: rehashedStudy }));
});
