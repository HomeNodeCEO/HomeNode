import { UAD_PHASE_ONE_FIELDS } from './fieldCatalog.js';
import { CURRENT_UAD_RELEASE_KEY } from './constants.js';
import { canonicalAssessmentJson } from '../../services/neighborhoodAssessment/contract.js';
import { assertNeighborhoodJsonbStorage } from '../../services/neighborhoodAssessment/jsonbStorage.js';

const RELEASE = 'uad-3.6-2026-08-13-h1.5';
const MAX_FIELDS = 4096;
const MAX_BYTES = 128_000;
const MAX_NODES = 25_000;
const MAX_DEPTH = 16;
const REFUSALS = new WeakMap();
const GROUPS = [
  [null, 'subject_address', ['0100.0007', '0100.0008', '0100.0009', '0100.0011', '0100.0012', '1200.0052']],
  [null, 'subject_legal', ['0100.0067']],
  [null, 'subject', ['0100.0019', '0100.0020', '0100.0021', '0100.0022', '0100.0047', '0300.0010', '0300.0066', '2500.0168']],
  [null, 'site', ['1500.0020', '1500.0021', '1500.0093', '1500.0094', '1500.0095']],
  ['dwelling', 'dwelling', ['0300.0011', '0300.0012', '0300.0034', '0300.0035', '0300.0063']],
  ['unit', 'unit', ['0700.0089', '0700.0140', '0700.0141', '0700.0142', '0700.0143', '0700.0144', '1800.0398']],
  ['unit_area_data_source', 'unit_area_data_source', ['0700.0125', '0700.0126']],
  ['site_parcel', 'site_parcel', ['1500.0022', '1500.0023', '1500.0024', '1500.0027']],
];
const ROSTERS = ['dwelling', 'outbuilding', 'property', 'site_parcel', 'unit', 'unit_area_data_source'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function stop(reason) {
  const token = Object.freeze({});
  REFUSALS.set(token, reason);
  throw token;
}

function ownData(object, key, reason) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) stop(reason);
  return descriptor.value;
}

function denseArray(array, maximum, reason) {
  if (!Array.isArray(array) || Object.getPrototypeOf(array) !== Array.prototype) stop(reason);
  const length = Object.getOwnPropertyDescriptor(array, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 0) stop(reason);
  if (length > maximum) stop('limit_exceeded');
  // A normal array has only its length and one own data entry per index.
  if (Reflect.ownKeys(array).length !== length + 1) stop(reason);
  for (let i = 0; i < length; i++) ownData(array, String(i), reason);
  return length;
}

// Only source-authored metadata reaches this copier, never caller-supplied
// property values. Do not use it as a lossless stored-value decoder.
function ownedDescriptor(input) {
  let nodes = 0;
  let contentBytes = 0;
  const path = new Set();
  function text(value) {
    if (value.length > MAX_BYTES) stop('limit_exceeded');
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code === 0) stop('definition_not_json');
      if (code < 0x80) contentBytes++;
      else if (code < 0x800) contentBytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) stop('definition_not_json');
        contentBytes += 4;
      } else if (code >= 0xdc00 && code <= 0xdfff) stop('definition_not_json');
      else contentBytes += 3;
      if (contentBytes > MAX_BYTES) stop('limit_exceeded');
    }
    return value;
  }
  function copy(value, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) stop('limit_exceeded');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return text(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Object.is(value, -0)) stop('definition_not_json');
      return value;
    }
    if (typeof value !== 'object') stop('definition_not_json');
    if (path.has(value)) stop('definition_not_json');
    path.add(value);
    let result;
    if (Array.isArray(value)) {
      const length = denseArray(value, MAX_NODES - nodes, 'definition_not_json');
      result = [];
      for (let i = 0; i < length; i++) result.push(copy(ownData(value, String(i), 'definition_not_json'), depth + 1));
    } else {
      if (Object.getPrototypeOf(value) !== Object.prototype) stop('definition_not_json');
      const keys = Reflect.ownKeys(value);
      if (keys.length > MAX_NODES - nodes) stop('limit_exceeded');
      const entries = [];
      for (const key of keys) {
        if (typeof key !== 'string') stop('definition_not_json');
        text(key);
        entries.push([key, copy(ownData(value, key, 'definition_not_json'), depth + 1)]);
      }
      result = Object.fromEntries(entries);
    }
    path.delete(value);
    return result;
  }
  return copy(input, 0);
}

function freeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function compile() {
  if (CURRENT_UAD_RELEASE_KEY !== RELEASE) stop('release_mismatch');
  const count = denseArray(UAD_PHASE_ONE_FIELDS, MAX_FIELDS, 'catalog_mismatch');
  const templates = GROUPS.flatMap(([entity_type, context_key, uids]) => uids.map(uid => ({
    context_key, uid, entity_type, catalog_definition: null,
  }))).sort((a, b) => compare(a.context_key, b.context_key) || compare(a.uid, b.uid));
  const occurrences = new Array(templates.length).fill(0);
  for (let i = 0; i < count; i++) {
    const field = ownData(UAD_PHASE_ONE_FIELDS, String(i), 'catalog_mismatch');
    if (field === null || typeof field !== 'object' || Object.getPrototypeOf(field) !== Object.prototype) stop('catalog_mismatch');
    const context = ownData(field, 'contextKey', 'catalog_mismatch');
    const uid = ownData(field, 'uid', 'catalog_mismatch');
    const key = ownData(field, 'key', 'catalog_mismatch');
    if (typeof context !== 'string' || typeof uid !== 'string' || typeof key !== 'string') stop('catalog_mismatch');
    for (let j = 0; j < templates.length; j++) {
      const template = templates[j];
      if (context !== template.context_key || uid !== template.uid) continue;
      // Count context/UID first: a conflicting entity type must not evade
      // duplicate detection through a lookup's last-winner behavior.
      if (++occurrences[j] !== 1) stop('catalog_mismatch');
      if (key !== `${template.context_key}:${template.uid}`) stop('catalog_mismatch');
      if (template.entity_type === null) {
        if (Object.hasOwn(field, 'entityType')) stop('catalog_mismatch');
      } else if (ownData(field, 'entityType', 'catalog_mismatch') !== template.entity_type) stop('catalog_mismatch');
      template.catalog_definition = field;
    }
  }
  if (occurrences.some(n => n !== 1)) stop('catalog_mismatch');
  return ownedDescriptor({
    descriptor_version: 1,
    interpretation: 'catalog_only',
    profile_id: 'uad-neighborhood-physical-stock-inputs-v1',
    profile_revision: '1',
    specification_release_key: RELEASE,
    field_templates: templates,
    roster_templates: ROSTERS.map(entity_type => ({ entity_type, data_projection: {} })),
    accepted_evidence: [],
    material_limits: {
      field_observations: 2048, entity_members: 128,
      consumed_value_utf8_bytes: 32000, source_reference_utf8_bytes: 8192,
      canonical_utf8_bytes: 1500000, nodes: 100000, depth: 35, jsonb_utf8_bytes: 2000000,
    },
  });
}

function admit(descriptor) {
  let canonical;
  try { canonical = canonicalAssessmentJson(descriptor); }
  catch (error) {
    if (error instanceof TypeError && ['invalid_neighborhood_assessment:json_limit',
      'invalid_neighborhood_assessment:json_bytes'].includes(error.message)) stop('limit_exceeded');
    throw error;
  }
  if (Buffer.byteLength(canonical, 'utf8') > MAX_BYTES) stop('limit_exceeded');
  try { assertNeighborhoodJsonbStorage(descriptor); }
  catch (error) {
    if (error instanceof TypeError && ['neighborhood_jsonb_storage_limit:bytes',
      'neighborhood_jsonb_storage_limit:nodes', 'neighborhood_jsonb_storage_limit:depth'].includes(error.message)) stop('limit_exceeded');
    throw error;
  }
  return freeze(descriptor);
}

/** Fixed catalog metadata only; no property-value interpretation, installed
 * profile, original extraction, source authority, database or current-use gate. */
export function getUadNeighborhoodMaterialCatalogV1() {
  try {
    if (arguments.length !== 0) stop('invalid_argument');
    return admit(compile());
  } catch (error) {
    const reason = error !== null && (typeof error === 'object' || typeof error === 'function')
      ? REFUSALS.get(error) : null;
    throw new TypeError(`uad_neighborhood_material_catalog:${reason || 'failed'}`);
  }
}
