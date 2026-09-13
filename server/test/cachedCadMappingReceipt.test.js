import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { CACHED_CAD_EVIDENCE_FIELDS as FIELDS, CACHED_CAD_EVIDENCE_LIMITS as LIMITS,
  mapCadEvidenceParcelRow as parcelMapper, mapCadEvidenceAccountRow as accountMapper,
  mapCadEvidenceSaleRow as saleMapper, mapCadEvidenceSaleLinkRow as linkMapper,
  hasOriginalPrimitiveCadMappingReceipt as hasReceipt } from '../src/services/neighborhoodAssessment/cachedRowMappingsV4.js';
import { mapCachedAccountRow } from '../src/services/neighborhoodAssessment/cachedRowMappings.js';
import { mapWitnessAccountRow } from '../src/services/neighborhoodAssessment/cachedRowMappingsV3.js';

const parcel = () => ({ object_id: '9007199254740993', account_id: 'R-00001', low_parcel_id: '000001',
  residential_year_built: 2001, residential_area_sqft: '1800.125', parcel_area_sqft: '8000', current_market_value: '300000.00',
  source_record_hash: 'a'.repeat(64), source_updated_at: null, sync_run_id: '60000000-0000-4000-8000-000000000001',
  synced_at: '2026-09-05T12:00:00.000000Z', stored_geometry_ewkb: '010203',
  class_code: ' 01 ', class_description: 'Café 🏠', use_description: '', structure_type: null, built_up: false });
const account = () => ({ account_id: 'R-00001', county: 'Dallas', subdivision: '  Recorded plat  ',
  neighborhood_code: '', legal_description: null });
const frozenTree = value => {
  if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozenTree); }
};

for (const [kind, make, mapper] of [['parcel', parcel, parcelMapper], ['account', account, accountMapper]]) {
  test(`${kind} recognizes only its exact frozen output without changing evidence bytes or fields`, () => {
    const input = make(), output = mapper(input), originalBytes = json(output);
    assert.equal(hasReceipt(output, kind, 4), true);
    assert.deepEqual(Reflect.ownKeys(output).sort(), ['capability_gaps', 'data', 'raw_projection', 'record_id']);
    assert.deepEqual(output, mapper(output.raw_projection));
    assert.equal(json(mapper(output.raw_projection)), originalBytes);
    frozenTree(output);
    input.account_id = 'changed-after-mapping';
    assert.equal(output.raw_projection.account_id, 'R-00001');
    assert.throws(() => { output.raw_projection.account_id = 'changed'; }, TypeError);
    assert.equal(hasReceipt(output, kind, 4), true);
    assert.equal(json(output), originalBytes);
    assert.equal(output.data.historical_support, 'unknown');
    assert.ok(output.capability_gaps.includes('housing_classification_unverified'));
  });

  test(`${kind} copies, inherited wrappers and transplanted descendants remain normal-replay inputs`, () => {
    const output = mapper(make());
    for (const copied of [{ ...output }, structuredClone(output), JSON.parse(json(output)), Object.create(output),
      Object.freeze({ ...output }), { record_id: output.record_id, raw_projection: output.raw_projection, data: output.data,
        capability_gaps: output.capability_gaps }]) {
      assert.equal(hasReceipt(copied, kind, 4), false);
      assert.deepEqual(copied.raw_projection, output.raw_projection);
      assert.deepEqual(mapper(copied.raw_projection), output, 'receipt miss must not reject otherwise valid replay');
    }
    assert.equal(hasReceipt(output.raw_projection, kind, 4), false);
    assert.equal(hasReceipt(output.data, kind, 4), false);
    assert.equal(hasReceipt(output.data.cached_projection_sha256, kind, 4), false);
  });
}

test('primitive numeric, presence, UTF8 and input-order variants preserve exact replay semantics', () => {
  const cases = [];
  for (const field of ['residential_year_built', 'residential_area_sqft', 'parcel_area_sqft', 'current_market_value']) {
    for (const value of [null, '', ' ', false, true, 0, -0, '-0', '0.00', 'not recorded', 1e21, 1e-7]) {
      cases.push({ ...parcel(), [field]: value });
    }
    const missing = parcel(); delete missing[field]; cases.push(missing);
  }
  cases.push({ ...parcel(), object_id: 1 }, { ...parcel(), object_id: '1' });
  for (const input of cases) {
    const output = parcelMapper(input);
    assert.equal(hasReceipt(output, 'parcel', 4), true);
    assert.deepEqual(parcelMapper(output.raw_projection), output);
    assert.equal(json(parcelMapper(output.raw_projection)), json(output));
    const reordered = Object.fromEntries(Object.entries(input).reverse());
    assert.deepEqual(parcelMapper(reordered), output);
  }
  assert.ok(Object.is(parcelMapper({ ...parcel(), parcel_area_sqft: -0 }).raw_projection.parcel_area_sqft, 0));
  assert.equal(parcelMapper({ ...parcel(), parcel_area_sqft: '-0' }).raw_projection.parcel_area_sqft, '-0');
  for (const value of [null, '', ' ', false, true, 0, -0, 'Café 🏠', '1.00']) {
    const output = accountMapper({ ...account(), legal_description: value });
    assert.equal(hasReceipt(output, 'account', 4), true);
    assert.deepEqual(accountMapper(output.raw_projection), output);
  }
  const missing = account(); delete missing.legal_description;
  const output = accountMapper(missing);
  assert.equal(hasReceipt(output, 'account', 4), true);
  assert.equal(Object.hasOwn(output.raw_projection, 'legal_description'), false);
  assert.deepEqual(accountMapper(output.raw_projection), output);
});

test('receipt lookup requires the exact kind and numeric mapping version without coercion', () => {
  const output = parcelMapper(parcel());
  for (const kind of ['account', 'parcels', 'sale', 'sale_link', '', null, undefined, {}, new String('parcel')]) {
    assert.equal(hasReceipt(output, kind, 4), false);
  }
  for (const version of [undefined, null, 0, 2, 3, 5, '4', 4n, new Number(4), {}]) {
    assert.equal(hasReceipt(output, 'parcel', version), false);
  }
  for (const version of [2, 3, 5]) {
    const copy = structuredClone(output); copy.data.cached_mapping_version = version;
    assert.equal(hasReceipt(copy, 'parcel', 4), false);
  }
});

test('lookup never evaluates forged getters, proxy traps or revoked proxies', () => {
  let calls = 0;
  const poison = () => { calls++; throw new Error('must not execute'); };
  const fake = Object.defineProperties({}, Object.fromEntries(['data', 'raw_projection', 'record_id', 'capability_gaps']
    .map(key => [key, { enumerable: true, get: poison }])));
  const traps = { get: poison, getPrototypeOf: poison, ownKeys: poison, getOwnPropertyDescriptor: poison, isExtensible: poison };
  const wrapped = new Proxy(parcelMapper(parcel()), traps), revoked = Proxy.revocable({}, traps); revoked.revoke();
  for (const value of [fake, wrapped, new Proxy({}, traps), revoked.proxy, null, undefined, 4, 'parcel', Symbol('receipt')]) {
    assert.equal(hasReceipt(value, 'parcel', 4), false);
  }
  assert.equal(calls, 0);
});

test('discarded enumerable fields never gain a replay receipt or execute ignored getters', () => {
  let calls = 0;
  for (const [kind, make, mapper] of [['parcel', parcel, parcelMapper], ['account', account, accountMapper]]) {
    for (const accessor of [false, true]) {
      const input = make();
      Object.defineProperty(input, 'private_field', accessor
        ? { enumerable: true, get() { calls++; throw new Error('private getter'); } }
        : { enumerable: true, value: 'not retained' });
      const output = mapper(input);
      assert.equal(hasReceipt(output, kind, 4), false);
      assert.ok(output.capability_gaps.includes('projection_fields_not_retained'));
      assert.notDeepEqual(mapper(output.raw_projection), output, 'preserve the existing remap mismatch');
    }
  }
  assert.equal(calls, 0);
});

test('ignored symbols and non-enumerable unknown fields are not inspected or added to evidence', () => {
  let calls = 0; const input = parcel();
  const poison = () => { calls++; throw new Error('ignored'); };
  Object.defineProperty(input, 'private_hidden', { get: poison });
  Object.defineProperty(input, Symbol('private'), { enumerable: true, get: poison });
  const output = parcelMapper(input);
  assert.equal(hasReceipt(output, 'parcel', 4), true);
  assert.deepEqual(output, parcelMapper(parcel()));
  assert.equal(calls, 0);
});

test('valid nested raw evidence misses the receipt and continues to pass ordinary replay', () => {
  for (const [kind, mapper, input] of [
    ['parcel', parcelMapper, { ...parcel(), stored_geometry_geojson: { type: 'Point', coordinates: [0, 1] } }],
    ['parcel', parcelMapper, { ...parcel(), classification_review_reason: ['unverified'] }],
    ['account', accountMapper, { ...account(), legal_description: { recorded: ['literal'] } }],
  ]) {
    const output = mapper(input);
    assert.equal(hasReceipt(output, kind, 4), false);
    assert.deepEqual(mapper(output.raw_projection), output);
  }
});

test('sales, links and previous mapper versions never gain primitive CAD receipts', () => {
  const outputs = [saleMapper({ source_record_id: '10', sale_id: '20', sale_account_id: 'R-00001', sale_price: '1.00' }),
    linkMapper({ parcel_link_id: '1', source_record_id: '10', source_position: 1, parcel_sequence: 1,
      account_id: 'R-00001', is_resolved: true, match_method: 'exact' }),
    mapCachedAccountRow(account()), mapWitnessAccountRow(account())];
  for (const output of outputs) for (const kind of ['parcel', 'account', 'sale', 'sale_link']) {
    assert.equal(hasReceipt(output, kind, 4), false);
  }
});

test('original CAD validation failures and text boundaries remain unchanged before receipt issuance', () => {
  for (const field of FIELDS) {
    const missing = parcel(); delete missing[field];
    assert.throws(() => parcelMapper(missing), error => error.reason === 'cad_fields_required');
    assert.throws(() => parcelMapper({ ...parcel(), [field]: undefined }), error => error.reason === 'data_properties_required');
  }
  const text = 'é'.repeat(LIMITS.text_utf8_bytes / 2);
  assert.equal(hasReceipt(parcelMapper({ ...parcel(), class_description: text }), 'parcel', 4), true);
  for (const value of [`${text}x`, '\u0000', '\ud800', false, {}, []]) {
    assert.throws(() => parcelMapper({ ...parcel(), class_description: value }), error => error.reason === 'class_description');
  }
  let calls = 0;
  const poison = () => { calls++; throw new Error('selected getter/trap'); };
  const input = Object.defineProperty(parcel(), 'class_code', { enumerable: true, get: poison });
  assert.throws(() => parcelMapper(input), error => error.reason === 'data_properties_required');
  assert.throws(() => parcelMapper({ ...parcel(), residential_area_sqft: undefined }), error => error.reason === 'data_properties_required');
  for (const input of [Object.assign(Object.create(null), parcel()), Object.assign(Object.create({ inherited: true }), parcel())]) {
    assert.throws(() => parcelMapper(input), error => error.reason === 'projection_object');
  }
  assert.throws(() => parcelMapper(new Proxy({}, { getPrototypeOf: poison })), error => error.reason === 'projection_object');
  assert.throws(() => parcelMapper({ ...parcel(), residential_area_sqft: Infinity }), error => error.reason === 'plain_data_required');
  assert.equal(calls, 0);
});
