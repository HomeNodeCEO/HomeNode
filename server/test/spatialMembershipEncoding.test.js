import test from 'node:test';
import assert from 'node:assert/strict';
import { SPATIAL_PARCEL_TUPLE_ENCODING, SPATIAL_TUPLE_LIMITS, encodeSpatialParcel,
  decodeSpatialParcel, spatialParcelEncoding, iterateSpatialParcels } from '../src/services/neighborhoodAssessment/spatialMembershipEncoding.js';

const FIELDS = ['object_id', 'account_id', 'source_record_hash', 'sync_run_id',
  'synced_at', 'source_updated_at', 'geometry_sha256'];
const row = () => ({ object_id: '-9223372036854775808', account_id: '00000000000000001',
  source_record_hash: 'a'.repeat(64), sync_run_id: ' original sync literal ',
  synced_at: '2026-09-12T00:00:00.123456Z', source_updated_at: null, geometry_sha256: 'b'.repeat(64) });
const encoded = parcels => ({ parcel_encoding: SPATIAL_PARCEL_TUPLE_ENCODING, parcels });
const throws = call => assert.throws(call, { name: 'TypeError', message: /^invalid_spatial_membership_encoding:/ });
function hostileProxy(target = {}) {
  return new Proxy(target, new Proxy({}, { get() { return () => { assert.fail('proxy trap executed'); }; } }));
}
function getter(target, key, enumerable = true) {
  Object.defineProperty(target, key, { configurable: true, enumerable,
    get() { assert.fail('accessor executed'); } });
  return target;
}

test('fixed order is lossless and distinct from input key insertion order', () => {
  const original = row(), reversed = Object.fromEntries(Object.entries(original).reverse());
  const tuple = encodeSpatialParcel(reversed), decoded = decodeSpatialParcel(tuple);
  assert.deepEqual(tuple, FIELDS.map(key => original[key]));
  assert.deepEqual(decoded, original);
  assert.deepEqual(Object.keys(decoded), FIELDS);
  assert.notStrictEqual(decoded, original);
  assert.deepEqual(reversed, original);
  assert.equal(SPATIAL_PARCEL_TUPLE_ENCODING, 'fixed_fields_v1');
  assert.deepEqual(SPATIAL_TUPLE_LIMITS, { encoded_bytes: 16777216, expanded_bytes: 33554432 });
  assert.ok(Object.isFrozen(SPATIAL_TUPLE_LIMITS));
});

test('empty, escaped, Unicode and semantically invalid literals remain unchanged', () => {
  const original = { object_id: '', account_id: ' \tquoted"\\\r\n ', source_record_hash: 'not-a-hash',
    sync_run_id: '\u0000\ud800', synced_at: 'not-a-date', source_updated_at: '原始 timestamp 🌍', geometry_sha256: '' };
  assert.deepEqual(decodeSpatialParcel(encodeSpatialParcel(original)), original);
  const tuple = encodeSpatialParcel(original);
  assert.deepEqual(decodeSpatialParcel(JSON.parse(JSON.stringify(tuple))), original);
});

test('codec accepts frozen inputs without mutating or freezing its own results', () => {
  const original = Object.freeze(row()), tuple = encodeSpatialParcel(original);
  assert.ok(!Object.isFrozen(tuple));
  const decoded = decodeSpatialParcel(Object.freeze(tuple));
  assert.ok(!Object.isFrozen(decoded)); assert.deepEqual(decoded, original);
});

test('encoder rejects missing, extra, symbolic, hidden and accessor properties', () => {
  const missing = row(); delete missing.object_id;
  const symbol = row(); symbol[Symbol('hidden')] = 'unexpected';
  const hidden = row(); Object.defineProperty(hidden, 'object_id', { enumerable: false });
  const extraHidden = row(); Object.defineProperty(extraHidden, 'extra', { value: 'unexpected' });
  for (const value of [missing, { ...row(), extra: 'unexpected' }, symbol, hidden, extraHidden,
    getter(row(), 'object_id'), getter(row(), 'extra'), Object.create(row()),
    Object.assign(Object.create(null), row()), [], null, 'row', new Date(), hostileProxy(row())]) {
    throws(() => encodeSpatialParcel(value));
  }
});

test('all seven scalar types are strict; only source_updated_at may be null', () => {
  for (let index = 0; index < FIELDS.length; index++) {
    for (const value of [undefined, 0, false, {}, [], new String('text'), hostileProxy()]) {
      const original = { ...row(), [FIELDS[index]]: value }, tuple = FIELDS.map(key => original[key]);
      throws(() => encodeSpatialParcel(original)); throws(() => decodeSpatialParcel(tuple));
    }
    const original = { ...row(), [FIELDS[index]]: null }, tuple = FIELDS.map(key => original[key]);
    if (index === 5) assert.deepEqual(decodeSpatialParcel(encodeSpatialParcel(original)), original);
    else { throws(() => encodeSpatialParcel(original)); throws(() => decodeSpatialParcel(tuple)); }
  }
});

test('decoder rejects sparse, oversized, subclassed and adorned tuples without executing code', () => {
  const tuple = () => encodeSpatialParcel(row());
  const sparse = tuple(); delete sparse[2];
  const symbol = tuple(); symbol[Symbol.iterator] = () => { assert.fail('iterator executed'); };
  const named = tuple(); named.extra = 'unexpected';
  const hidden = tuple(); Object.defineProperty(hidden, '0', { enumerable: false });
  const extraHidden = tuple(); Object.defineProperty(extraHidden, 'extra', { value: 'unexpected' });
  class Tuple extends Array {}
  for (const value of [sparse, [...tuple(), 'extra'], tuple().slice(0, 6), symbol, named, hidden, extraHidden,
    getter(tuple(), '0'), getter(tuple(), 'extra'), new Tuple(...tuple()), Object.assign({}, tuple()),
    Object.setPrototypeOf(tuple(), null), null, 'tuple', hostileProxy(tuple())]) throws(() => decodeSpatialParcel(value));
});

test('encoding discriminator distinguishes absent legacy from invalid own properties safely', () => {
  assert.equal(spatialParcelEncoding({}), null);
  assert.equal(spatialParcelEncoding(encoded([])), SPATIAL_PARCEL_TUPLE_ENCODING);
  for (const value of [null, undefined, '', 1, false, {}, [], 'fixed_fields_v2']) {
    throws(() => spatialParcelEncoding({ parcel_encoding: value }));
  }
  throws(() => spatialParcelEncoding(getter({}, 'parcel_encoding')));
  throws(() => spatialParcelEncoding(Object.defineProperty({}, 'parcel_encoding', { value: SPATIAL_PARCEL_TUPLE_ENCODING })));
  throws(() => spatialParcelEncoding(hostileProxy()));
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  throws(() => spatialParcelEncoding(revoked.proxy));
});

test('iterator preserves every legacy row identity without replacing consumer validation', () => {
  const first = row(), second = { object_id: 'legacy-consumer-specific' }, parcels = [first, second];
  const actual = [...iterateSpatialParcels({ parcels })];
  assert.equal(actual.length, 2); assert.strictEqual(actual[0], first); assert.strictEqual(actual[1], second);
  assert.strictEqual(parcels[0], first); assert.ok(!Object.isFrozen(parcels));
  assert.deepEqual([...iterateSpatialParcels({ parcels: [] })], []);
  assert.deepEqual([...iterateSpatialParcels(encoded([]))], []);
});

test('iterator decodes just one tuple per yield, not an expanded roster', () => {
  const first = row(), second = { ...row(), object_id: '2' };
  const broken = encodeSpatialParcel(second); broken[2] = null;
  const iterator = iterateSpatialParcels(encoded([encodeSpatialParcel(first), broken]));
  assert.deepEqual(iterator.next(), { done: false, value: first });
  throws(() => iterator.next());
  const complete = [...iterateSpatialParcels(encoded([encodeSpatialParcel(first), encodeSpatialParcel(second)]))];
  assert.deepEqual(complete, [first, second]);
  assert.notStrictEqual(complete[0], first); assert.notStrictEqual(complete[1], second);
});

test('top-level parcel arrays reject holes, hidden/accessor indices and extra keys', () => {
  const sparse = [row(), row()]; delete sparse[1];
  const hidden = [row()]; Object.defineProperty(hidden, '0', { enumerable: false });
  const symbol = [row()]; symbol[Symbol.iterator] = () => { assert.fail('iterator executed'); };
  const named = [row()]; named.extra = 'unexpected';
  const extraHidden = [row()]; Object.defineProperty(extraHidden, 'extra', { value: 'unexpected' });
  for (const parcels of [sparse, hidden, symbol, named, extraHidden, getter([row(), row()], '1'),
    hostileProxy([row()]), Object.setPrototypeOf([row()], null), {}, null]) {
    throws(() => iterateSpatialParcels({ parcels }).next());
  }
  throws(() => iterateSpatialParcels(getter({}, 'parcels')).next());
  throws(() => iterateSpatialParcels({ parcel_encoding: 'unknown', parcels: [] }).next());
  throws(() => iterateSpatialParcels(hostileProxy({ parcels: [] })).next());
});

test('top array limit admits all 100000 entries and refuses one more before yielding', () => {
  const original = row(), parcels = new Array(100000).fill(original);
  let count = 0;
  for (const actual of iterateSpatialParcels({ parcels })) { assert.strictEqual(actual, original); count++; }
  assert.equal(count, 100000);
  throws(() => iterateSpatialParcels({ parcels: new Array(100001).fill(original) }).next());
});

test('an accessor inserted between yields is rejected without invoking it', () => {
  const parcels = [row(), row()], iterator = iterateSpatialParcels({ parcels });
  assert.strictEqual(iterator.next().value, parcels[0]);
  getter(parcels, '1');
  throws(() => iterator.next());
});

test('tuple JSON removes only repeated field names, with exact array framing left to the owner', () => {
  const original = row(), tuple = encodeSpatialParcel(original);
  assert.equal(Buffer.byteLength(JSON.stringify(original)) - Buffer.byteLength(JSON.stringify(tuple)), 110);
  const one = Buffer.byteLength(JSON.stringify(tuple));
  assert.equal(Buffer.byteLength(JSON.stringify([tuple, tuple])), one * 2 + 3);
  assert.equal(Buffer.byteLength(JSON.stringify([])), 2);
});
