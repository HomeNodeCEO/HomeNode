import { isProxy } from 'node:util/types';

export const CACHED_SALE_WITNESS_LIMITS = Object.freeze({ scalar_utf8_bytes: 512, witness_utf8_bytes: 24_576 });
// Literal stored keys, not an installed provider dictionary or a meaning grant.
export const CACHED_SALE_WITNESS_FIELDS = Object.freeze([
  'MlsStatus', 'StandardStatus', 'CloseDate', 'ClosePrice', 'CurrentPrice', 'ListPrice', 'OriginalListPrice', 'Currency',
  'LivingArea', 'LivingAreaUnits', 'AboveGradeFinishedArea', 'AboveGradeFinishedAreaUnits',
  'LotSizeArea', 'LotSizeUnits', 'LotSizeSquareFeet', 'LotSizeAcres',
  'DaysOnMarket', 'CumulativeDaysOnMarket', 'YearBuilt', 'StructuralStyle', 'PropertyType', 'PropertySubType',
  'StructureType', 'PropertyAttachedYN', 'ListingKey', 'ListingId', 'OriginatingSystemName', 'ModificationTimestamp',
]);
const SCALARS = ['string', 'number', 'boolean'];
const ROOT_TYPES = ['array', ...SCALARS];
const FIELD_KEYS = ['state', 'json_type', 'value_text', 'utf8_bytes'];
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
function invalid(reason) {
  throw Object.assign(new TypeError(`invalid_cached_sale_witness:${reason}`), { code: 'CACHED_SALE_WITNESS_INVALID', reason });
}
function closed(value, keys) {
  if (!value || typeof value !== 'object' || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid('shape');
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || !own.every(key => typeof key === 'string' && keys.includes(key))) invalid('shape');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!keys.every(key => descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key], 'value'))) invalid('data_properties_required');
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function field(value, rootObject) {
  const item = closed(value, FIELD_KEYS);
  const { state, json_type: kind, value_text: text, utf8_bytes: bytes } = item;
  if (!rootObject) {
    if (state !== 'payload_unavailable' || kind !== null || text !== null || bytes !== null) invalid('root_field_mismatch');
  } else if (state === 'absent' || state === 'json_null') {
    if (kind !== (state === 'absent' ? null : 'null') || text !== null || bytes !== null) invalid('presence_mismatch');
  } else if (state === 'non_scalar') {
    if (!['array', 'object'].includes(kind) || text !== null || bytes !== null) invalid('non_scalar_mismatch');
  } else if (state === 'oversize') {
    if (!SCALARS.includes(kind) || kind === 'boolean' || text !== null || !Number.isInteger(bytes)
      || bytes <= CACHED_SALE_WITNESS_LIMITS.scalar_utf8_bytes || bytes > 2_147_483_647) invalid('oversize_mismatch');
  } else if (state === 'scalar') {
    if (!SCALARS.includes(kind) || typeof text !== 'string' || text.length > CACHED_SALE_WITNESS_LIMITS.scalar_utf8_bytes
      || !text.isWellFormed() || text.includes('\u0000') || !Number.isInteger(bytes) || Object.is(bytes, -0)
      || bytes < 0 || bytes > CACHED_SALE_WITNESS_LIMITS.scalar_utf8_bytes || Buffer.byteLength(text, 'utf8') !== bytes) invalid('scalar_mismatch');
    if ((kind === 'number' && !JSON_NUMBER.test(text)) || (kind === 'boolean' && !['true', 'false'].includes(text))) invalid('scalar_type_mismatch');
  } else invalid('field_state');
  return Object.freeze(item);
}

/** Admits only the exact installed SQL witness. A content hash binds these
 * stored observations, not original provider bytes, history, units or rights.
 * The SQL overflow sentinel is distinct from a valid sql_null-root witness.
 */
export function prepareCachedSaleWitness(value) {
  if (value === null) invalid('witness_byte_limit');
  const item = closed(value, ['witness_version', 'root_state', 'root_json_type', 'fields']);
  if (item.witness_version !== 1) invalid('version');
  const { root_state: root, root_json_type: type } = item;
  if (!((root === 'sql_null' && type === null) || (root === 'json_null' && type === 'null')
    || (root === 'non_object' && ROOT_TYPES.includes(type)) || (root === 'object' && type === 'object'))) invalid('root_state');
  const supplied = closed(item.fields, CACHED_SALE_WITNESS_FIELDS);
  const fields = Object.freeze(Object.fromEntries(CACHED_SALE_WITNESS_FIELDS.map(key => [key, field(supplied[key], root === 'object')])));
  const result = Object.freeze({ ...item, fields });
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > CACHED_SALE_WITNESS_LIMITS.witness_utf8_bytes) invalid('witness_byte_limit');
  return result;
}

// Fixed src alias and fixed VALUES vocabulary only: no caller-controlled SQL,
// full raw-payload transfer, private fields, or traversal of arbitrary keys.
// JSONB numeric scalars become TEXT in PostgreSQL, before Node JSON parsing.
// Oversized individual scalars keep only their type/length; oversized complete
// witnesses return SQL NULL and MUST be rejected, never interpreted as absence.
export const CACHED_SALE_WITNESS_SQL = `(
  SELECT CASE WHEN octet_length(witness.body::text) <= ${CACHED_SALE_WITNESS_LIMITS.witness_utf8_bytes}
    THEN witness.body ELSE NULL::jsonb END
  FROM (
    SELECT jsonb_build_object(
      'witness_version', 1,
      'root_state', CASE WHEN src.raw_payload IS NULL THEN 'sql_null'
        WHEN jsonb_typeof(src.raw_payload) = 'null' THEN 'json_null'
        WHEN jsonb_typeof(src.raw_payload) = 'object' THEN 'object' ELSE 'non_object' END,
      'root_json_type', jsonb_typeof(src.raw_payload),
      'fields', (SELECT jsonb_object_agg(keys.name, jsonb_build_object(
        'state', CASE WHEN jsonb_typeof(src.raw_payload) IS DISTINCT FROM 'object' THEN 'payload_unavailable'
          WHEN NOT (src.raw_payload ? keys.name) THEN 'absent'
          WHEN jsonb_typeof(src.raw_payload -> keys.name) = 'null' THEN 'json_null'
          WHEN jsonb_typeof(src.raw_payload -> keys.name) NOT IN ('string', 'number', 'boolean') THEN 'non_scalar'
          WHEN octet_length(src.raw_payload ->> keys.name) > ${CACHED_SALE_WITNESS_LIMITS.scalar_utf8_bytes} THEN 'oversize' ELSE 'scalar' END,
        'json_type', CASE WHEN jsonb_typeof(src.raw_payload) = 'object' THEN jsonb_typeof(src.raw_payload -> keys.name) ELSE NULL END,
        'value_text', CASE WHEN jsonb_typeof(src.raw_payload) = 'object'
          AND jsonb_typeof(src.raw_payload -> keys.name) IN ('string', 'number', 'boolean')
          AND octet_length(src.raw_payload ->> keys.name) <= ${CACHED_SALE_WITNESS_LIMITS.scalar_utf8_bytes}
          THEN src.raw_payload ->> keys.name ELSE NULL END,
        'utf8_bytes', CASE WHEN jsonb_typeof(src.raw_payload) = 'object'
          AND jsonb_typeof(src.raw_payload -> keys.name) IN ('string', 'number', 'boolean')
          THEN octet_length(src.raw_payload ->> keys.name) ELSE NULL END
      )) FROM (VALUES ${CACHED_SALE_WITNESS_FIELDS.map(key => `('${key}')`).join(', ')}) AS keys(name))
    ) AS body
  ) AS witness
)`;
