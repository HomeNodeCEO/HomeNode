import { isProxy } from 'node:util/types';

export const SPATIAL_PARCEL_TUPLE_ENCODING = 'fixed_fields_v1';
export const SPATIAL_TUPLE_LIMITS = Object.freeze({ encoded_bytes: 16777216, expanded_bytes: 33554432 });
const FIELDS = Object.freeze(['object_id', 'account_id', 'source_record_hash', 'sync_run_id',
  'synced_at', 'source_updated_at', 'geometry_sha256']);
const MAX_PARCELS = 100_000;

function fail(reason) { throw new TypeError(`invalid_spatial_membership_encoding:${reason}`); }
function check(ok, reason) { if (!ok) fail(reason); }
function object(value) {
  check(value !== null && typeof value === 'object' && !isProxy(value)
    && Object.getPrototypeOf(value) === Object.prototype, 'object');
}
function property(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  check(descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value'), 'data_property');
  return descriptor.value;
}
function scalar(value, index) {
  check(typeof value === 'string' || (index === 5 && value === null), 'scalar');
  return value;
}
function denseArray(value, maximum, exact) {
  check(value !== null && typeof value === 'object' && !isProxy(value)
    && Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype, 'array');
  const length = Object.getOwnPropertyDescriptor(value, 'length').value;
  check(length <= maximum && (exact === undefined || length === exact), 'array_length');
  // Enumerate keys once to reject all extra names/symbols, including hidden
  // ones. Valid inputs have at most maximum + 1 keys; no row copy is made.
  // Numeric descriptors reject holes, hidden entries and accessor indices
  // without invoking a getter or custom iterator.
  check(Reflect.ownKeys(value).length === length + 1, 'array_keys');
  for (let index = 0; index < length; index++) property(value, String(index));
  return length;
}

/** Lossless representation only: remove repeated field names, not source
 * values or members. ID/hash/time semantics and complete-capture admission
 * stay with their existing owners. No count ceiling is increased here. */
export function encodeSpatialParcel(row) {
  object(row);
  const keys = Reflect.ownKeys(row);
  check(keys.length === FIELDS.length && keys.every(key => FIELDS.includes(key)), 'row_keys');
  return FIELDS.map((key, index) => scalar(property(row, key), index));
}

export function decodeSpatialParcel(tuple) {
  denseArray(tuple, FIELDS.length, FIELDS.length);
  return Object.fromEntries(FIELDS.map((key, index) => [key, scalar(property(tuple, String(index)), index)]));
}

export function spatialParcelEncoding(spatial) {
  object(spatial);
  const descriptor = Object.getOwnPropertyDescriptor(spatial, 'parcel_encoding');
  if (descriptor === undefined) return null;
  check(descriptor.enumerable === true && Object.hasOwn(descriptor, 'value')
    && descriptor.value === SPATIAL_PARCEL_TUPLE_ENCODING, 'parcel_encoding');
  return descriptor.value;
}

/** Decode one tuple at a time, without allocating an expanded roster. Legacy
 * rows keep their identity and existing consumer-owned validation. The caller
 * still owns immutable inputs, resource accounting and final completeness. */
export function* iterateSpatialParcels(spatial) {
  const encoding = spatialParcelEncoding(spatial);
  const parcels = property(spatial, 'parcels'), length = denseArray(parcels, MAX_PARCELS);
  for (let index = 0; index < length; index++) {
    // Re-read descriptors so a caller mutation between yields cannot invoke
    // an accessor even though production owners already seal their inputs.
    const row = property(parcels, String(index));
    yield encoding === null ? row : decodeSpatialParcel(row);
  }
}
