import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareNeighborhoodSelectorInputV1, NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V1 } from '../src/services/neighborhoodAssessment/selectorInputProfile.js';
import { assessmentEvidenceDigest, canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';

const id = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
function input() {
  return { profile_id: NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V1,
    target: { report_file_id: id(1), workflow_type: 'custom_appraisal', workflow_target_id: '2' },
    scope: { organization_id: id(3), appraisal_case_id: id(4), subject_snapshot_id: id(5), account_id: '0002' },
    effective_date: '2026-09-07', selection: { id: 'original-selection', revision: 1, source_sha256: 'a'.repeat(64) },
    geometry_input: { geometry_version: 1, type: 'Point', crs: 'EPSG:4326', axis_order: 'longitude_latitude',
      coordinate_encoding: 'decimal_string_v1', coordinates: ['-96.8', '32.8'], source_sha256: 'b'.repeat(64) },
    discovery: { radius_metres: '4828.032', distance_semantics: 'postgis_geography_spheroid_v1', parcel_predicate: 'all_intersecting_parcels' },
    roster: { complete: true, account_count: 3, account_ids: ['0001', '0002', '0010'] } };
}
test('prepares bound data without asserting source, membership, completeness or access authority', () => {
  const original = input(); const result = prepareNeighborhoodSelectorInputV1(original);
  assert.equal(result.status, 'prepared'); assert.equal(result.authority, 'not_established');
  assert.equal(result.source_origin, 'unverified'); assert.equal(result.spatial_membership, 'unverified');
  assert.equal(result.roster_completeness, 'declared_not_verified');
  assert.equal(result.query_input.sha256, createHash('sha256').update(result.query_input.canonical_json).digest('hex'));
  assert.equal(result.selection.definition_sha256, result.query_input.sha256);
  assert.equal(result.selection_binding_sha256, assessmentEvidenceDigest({ scope: result.scope, effective_date: result.effective_date,
    selection: result.selection, account_ids: original.roster.account_ids }));
  assert.deepEqual(result.account_roster.account_ids, original.roster.account_ids);
  assert.equal(result.query_input.definition.discovery.radius_metres, '4828.032');
  assert.equal(Object.isFrozen(original.roster.account_ids), false);
  original.geometry_input.coordinates[0] = '0'; original.roster.account_ids[0] = 'changed';
  assert.equal(result.query_input.definition.geometry_input.coordinates[0], '-96.8');
  assert.equal(result.account_roster.account_ids[0], '0001');
  assert.throws(() => { result.account_roster.account_ids[0] = 'changed'; }, TypeError);
});
test('definition binds every target/scope identity, E, original geometry/source and complete selected roster', () => {
  const baseline = prepareNeighborhoodSelectorInputV1(input());
  const mutations = [value => { value.target.report_file_id = id(7); }, value => { value.target.workflow_target_id = '8'; },
    ...['organization_id', 'appraisal_case_id', 'subject_snapshot_id'].map(key => value => { value.scope[key] = id(9); }),
    value => { value.scope.account_id = '0001'; }, value => { value.effective_date = '2026-09-06'; },
    value => { value.geometry_input.coordinates[0] = '-96.81'; }, value => { value.geometry_input.source_sha256 = 'c'.repeat(64); },
    value => { value.selection.source_sha256 = 'd'.repeat(64); }, value => { value.selection.id = 'other'; },
    value => { value.selection.revision = 2; }, value => { value.roster.account_ids[2] = '0011'; }];
  for (const mutate of mutations) {
    const changed = input(); mutate(changed); const result = prepareNeighborhoodSelectorInputV1(changed);
    assert.equal(result.status, 'prepared'); assert.notEqual(result.query_input.sha256, baseline.query_input.sha256);
    assert.notEqual(result.selection_binding_sha256, baseline.selection_binding_sha256);
  }
});
test('unknown policy/geometry semantics and UAD workflow are explicitly unsupported', () => {
  for (const mutate of [v => { v.profile_id = 'future'; }, v => { v.target.workflow_type = 'uad_3_6'; },
    v => { v.geometry_input.type = 'Polygon'; }, v => { v.geometry_input.crs = 'EPSG:3857'; },
    v => { v.geometry_input.axis_order = 'latitude_longitude'; }, v => { v.geometry_input.coordinate_encoding = 'number'; },
    v => { v.discovery.radius_metres = '5000'; }, v => { v.discovery.distance_semantics = 'planar'; },
    v => { v.discovery.parcel_predicate = 'centroids_within_radius'; }]) {
    const value = input(); mutate(value); const result = prepareNeighborhoodSelectorInputV1(value);
    assert.equal(result.status, 'unsupported'); assert.equal(result.authority, 'not_established');
    assert.equal('selection' in result, false);
  }
});
test('missing evidence, declared partial/empty roster and absent subject stay incomplete', () => {
  for (const mutate of [v => { delete v.geometry_input; }, v => { v.geometry_input.source_sha256 = null; },
    v => { v.selection.source_sha256 = null; }, v => { v.roster.complete = false; },
    v => { v.roster.account_ids = []; v.roster.account_count = 0; },
    v => { v.roster.account_ids = ['0001']; v.roster.account_count = 1; }]) {
    const value = input(); mutate(value); assert.equal(prepareNeighborhoodSelectorInputV1(value).status, 'incomplete');
  }
});
test('never repairs original roster ordering, duplication, spelling, count or types', () => {
  for (const roster of [['0002', '0001', '0010'], ['0001', '0002', '0002'], ['0001', ' 0002', '0010'],
    ['0001', 2, '0010'], ['0001', '0002', '\u0000'], ['0001', '0002', {}]]) {
    const value = input(); value.roster.account_ids = roster;
    assert.equal(prepareNeighborhoodSelectorInputV1(value).status, 'invalid');
    assert.deepEqual(value.roster.account_ids, roster);
  }
  const count = input(); count.roster.account_count = 2; assert.equal(prepareNeighborhoodSelectorInputV1(count).status, 'invalid');
  const sparse = input(); delete sparse.roster.account_ids[0]; assert.equal(prepareNeighborhoodSelectorInputV1(sparse).status, 'invalid');
});
test('decimal ranges use exact integer arithmetic at the binary64 rounding boundary', () => {
  for (const longitude of ['180.000000000000001', '-180.000000000000001', '181', '1e2', '01', '-0', '1.0', '0.0000000000000001', 180, NaN, Infinity]) {
    const value = input(); value.geometry_input.coordinates[0] = longitude;
    assert.equal(prepareNeighborhoodSelectorInputV1(value).status, 'invalid', String(longitude));
  }
  for (const latitude of ['90.000000000000001', '-90.000000000000001', '91']) {
    const value = input(); value.geometry_input.coordinates[1] = latitude;
    assert.equal(prepareNeighborhoodSelectorInputV1(value).status, 'invalid');
  }
  for (const coordinates of [['180', '90'], ['-180', '-90'], ['0', '0'], ['179.999999999999999', '89.999999999999999']]) {
    const value = input(); value.geometry_input.coordinates = coordinates;
    assert.equal(prepareNeighborhoodSelectorInputV1(value).status, 'prepared');
  }
});
test('closed plain data rejects getters without executing them and does not accept future output fields', () => {
  const getter = input(); let called = false;
  Object.defineProperty(getter, 'profile_id', { enumerable: true, get() { called = true; throw new Error('not data'); } });
  assert.equal(prepareNeighborhoodSelectorInputV1(getter).status, 'invalid'); assert.equal(called, false);
  for (const field of ['road_narrative', 'selected_sales', 'market_decision', 'authority', 'latest_boundary']) {
    const value = input(); value[field] = {}; assert.equal(prepareNeighborhoodSelectorInputV1(value).status, 'invalid');
  }
  const value = input(); Object.setPrototypeOf(value, { trusted: true }); assert.equal(prepareNeighborhoodSelectorInputV1(value).status, 'invalid');
});
test('retains int32 selection revision and strict date/hash identities', () => {
  for (const revision of [0, -1, 1.5, 2_147_483_648, '1']) {
    const value = input(); value.selection.revision = revision; assert.equal(prepareNeighborhoodSelectorInputV1(value).status, 'invalid');
  }
  for (const date of ['2026-02-29', '2026-9-07', '2026-09-07T00:00:00Z']) {
    const value = input(); value.effective_date = date; assert.equal(prepareNeighborhoodSelectorInputV1(value).status, 'invalid');
  }
  const value = input(); value.selection.revision = 2_147_483_647;
  assert.equal(prepareNeighborhoodSelectorInputV1(value).status, 'prepared');
});

test('proxy-backed records and arrays are rejected before any trap executes', () => {
  for (const field of [null, 'target', 'scope', 'selection', 'geometry_input', 'discovery', 'roster',
    'geometry_input.coordinates', 'roster.account_ids']) {
    let value = input(), calls = 0;
    const trap = () => { calls += 1; throw new Error('caller trap executed'); };
    const handler = { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap };
    if (field === null) value = new Proxy(value, handler);
    else {
      const parts = field.split('.');
      const owner = parts.length === 2 ? value[parts[0]] : value;
      const key = parts.at(-1);
      owner[key] = new Proxy(owner[key], handler);
    }
    const result = prepareNeighborhoodSelectorInputV1(value);
    assert.equal(result.status, 'invalid', field ?? 'input');
    assert.equal(calls, 0, field ?? 'input');
    assert.equal(Object.hasOwn(result, 'selection'), false);
    assert.equal(Object.hasOwn(result, 'account_roster'), false);
  }
});

test('changing proxy revision and oversized custom iteration cannot create prepared evidence', () => {
  let revisions = 0, iterators = 0;
  const changing = input();
  changing.selection = new Proxy(changing.selection, { get(target, key) {
    return key === 'revision' ? ++revisions : target[key];
  } });
  assert.equal(prepareNeighborhoodSelectorInputV1(changing).status, 'invalid');
  assert.equal(revisions, 0);
  const oversized = input();
  oversized.roster.account_count = 1;
  oversized.roster.account_ids = new Proxy(['0002'], { get(target, key) {
    if (key === Symbol.iterator) return function* () {
      iterators += 1;
      for (let index = 0; index <= 50_000; index += 1) yield String(index).padStart(5, '0');
    };
    return Reflect.get(target, key);
  } });
  assert.equal(prepareNeighborhoodSelectorInputV1(oversized).status, 'invalid');
  assert.equal(iterators, 0);
});

test('revoked proxies and coercion-bearing dates fail closed without executing user code', () => {
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.equal(prepareNeighborhoodSelectorInputV1(revoked.proxy).status, 'invalid');
  const nested = input(); nested.roster.account_ids = revoked.proxy;
  assert.equal(prepareNeighborhoodSelectorInputV1(nested).status, 'invalid');
  let calls = 0;
  const date = input();
  date.effective_date = new Proxy({}, { get() { calls += 1; throw new Error('date coercion'); } });
  assert.equal(prepareNeighborhoodSelectorInputV1(date).status, 'invalid');
  assert.equal(calls, 0);
});
test('50,000 short account IDs fit; the account-count ceiling is rejected before hashing', () => {
  const value = input(); value.roster.account_ids = Array.from({ length: 50_000 }, (_, index) => String(index).padStart(8, '0'));
  value.roster.account_count = value.roster.account_ids.length; value.scope.account_id = '00000002';
  const result = prepareNeighborhoodSelectorInputV1(value);
  assert.equal(result.status, 'prepared'); assert.equal(result.account_roster.account_count, 50_000);
  assert.equal(result.account_roster.account_ids[49_999], '00049999');
  value.roster.account_ids.push('00050000'); value.roster.account_count += 1;
  assert.equal(prepareNeighborhoodSelectorInputV1(value).status, 'invalid');
});

test('oversized canonical rosters return unsupported without throwing, truncation or partial selection', () => {
  for (const [count, prefix] of [[22_387, '0'.repeat(56)], [25_000, '0'.repeat(56)], [13_000, 'é'.repeat(56)]]) {
    const value = input();
    const accounts = Array.from({ length: count }, (_, index) => prefix + String(index).padStart(8, '0'));
    value.roster.account_ids = accounts; value.roster.account_count = count; value.scope.account_id = accounts[0];
    if (count === 22_387) {
      // The roster alone fits: the final selection binding must be checked too.
      assert.ok(Buffer.byteLength(canonicalAssessmentJson({ account_ids: accounts }), 'utf8') <= 1_500_000);
    }
    const result = prepareNeighborhoodSelectorInputV1(value);
    assert.deepEqual(result, { status: 'unsupported', reason: 'input.canonical_byte_limit', authority: 'not_established' });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(value.roster.account_ids, accounts); assert.equal(accounts.length, count);
  }
});

test('Custom workflow target preserves exact positive int64 text, including both boundaries', () => {
  for (const targetId of ['1', '2', '9007199254740992', '9007199254740993', '9223372036854775807']) {
    const value = input(); value.target.workflow_target_id = targetId;
    const result = prepareNeighborhoodSelectorInputV1(value);
    assert.equal(result.status, 'prepared', targetId);
    assert.equal(result.target.workflow_target_id, targetId);
    assert.equal(result.query_input.definition.target.workflow_target_id, targetId);
    assert.equal(JSON.parse(result.query_input.canonical_json).target.workflow_target_id, targetId);
    assert.equal(value.target.workflow_target_id, targetId);
  }
  const first = input(); first.target.workflow_target_id = '9007199254740992';
  const second = input(); second.target.workflow_target_id = '9007199254740993';
  assert.notEqual(prepareNeighborhoodSelectorInputV1(first).query_input.sha256,
    prepareNeighborhoodSelectorInputV1(second).query_input.sha256);
});
test('Custom workflow target rejects UUIDs, coercion, aliases and values outside positive int64', () => {
  for (const targetId of [id(2), 1, 9007199254740992, 1n, NaN, Infinity, null, undefined, {}, ['1'],
    '', '0', '00', '01', '-1', '+1', ' 1', '1 ', '1\n', '1e2', '1E2', '1.0', '0x1',
    '9223372036854775808', '9999999999999999999', '10000000000000000000']) {
    const value = input(); value.target.workflow_target_id = targetId;
    assert.deepEqual(prepareNeighborhoodSelectorInputV1(value),
      { status: 'invalid', reason: 'target.workflow_target_id', authority: 'not_established' }, String(targetId));
    assert.equal(value.target.workflow_target_id, targetId);
  }
});
test('four genuine UUID fields match access-layer version/variant rules without case repair', () => {
  const fields = [['scope', 'organization_id'], ['scope', 'appraisal_case_id'], ['scope', 'subject_snapshot_id'],
    ['target', 'report_file_id']];
  const invalid = ['00000000-0000-0000-0000-000000000000', '00000001-1111-0111-8111-111111111111',
    '00000001-1111-9111-8111-111111111111', '00000001-1111-f111-8111-111111111111',
    '00000001-1111-4111-7111-111111111111', '00000001-1111-4111-c111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase()];
  for (const [group, field] of fields) {
    for (const uuid of invalid) {
      const value = input(); value[group][field] = uuid;
      assert.deepEqual(prepareNeighborhoodSelectorInputV1(value),
        { status: 'invalid', reason: `${group}.${field}`, authority: 'not_established' });
    }
    for (let version = 1; version <= 8; version += 1) {
      const value = input(); value[group][field] = `00000001-1111-${version}111-a111-111111111111`;
      assert.equal(prepareNeighborhoodSelectorInputV1(value).status, 'prepared');
    }
  }
});
