import { types as utilTypes } from 'node:util';
import { normalizePublicCadastralAccountId } from '../../security/publicCadastralCatalog.js';
import { NEIGHBORHOOD_CACHED_READ_ACCESS_LIMITS } from './cachedReadAccess.js';
import { assessmentDate, assessmentEvidenceDigest, canonicalAssessmentJson } from './contract.js';

export const NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V1 = 'custom-simple-suburban-radius-v1';
const AUTHORITY = 'not_established';
const SCOPE = ['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id'];
const TARGET = ['report_file_id', 'workflow_type', 'workflow_target_id'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const DISCOVERY = Object.freeze({ radius_metres: '4828.032',
  distance_semantics: 'postgis_geography_spheroid_v1', parcel_predicate: 'all_intersecting_parcels' });

class InputProblem extends Error {
  constructor(status, reason) { super(reason); this.status = status; }
}
function reject(reason, status = 'invalid') { throw new InputProblem(status, reason); }
function record(value, keys, field) {
  if (value === undefined || value === null) reject(`${field}.missing`, 'incomplete');
  if (typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject(`${field}.object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => !keys.includes(key))) reject(`${field}.unknown_field`);
  const snapshot = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor) reject(`${field}.${key}.missing`, 'incomplete');
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) reject(`${field}.data_fields_required`);
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}
function list(value, maximum, field) {
  if (value === undefined || value === null) reject(`${field}.missing`, 'incomplete');
  if (utilTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum) reject(`${field}.array_limit`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) reject(`${field}.dense_array_required`);
  const snapshot = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) reject(`${field}.data_array_required`);
    snapshot.push(descriptor.value);
  }
  return snapshot;
}
function text(value, maximum, field) {
  if (typeof value !== 'string' || !value.length || value.length > maximum
    || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) reject(field);
  return value;
}
function uuid(value, field) {
  if (typeof value !== 'string' || !UUID.test(value)) reject(field);
  return value; // Require the access layer's already-canonical UUID; do not repair evidence.
}
function customTargetId(value, field) {
  text(value, 19, field);
  if (!/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) reject(field);
  return value; // Preserve the Custom assignment-file ID as exact positive int64 text.
}
function hash(value, field) {
  if (value === null || value === undefined) reject(`${field}.missing`, 'incomplete');
  if (typeof value !== 'string' || !HASH.test(value)) reject(field);
  return value;
}
function account(value, field) {
  text(value, 64, field);
  if (normalizePublicCadastralAccountId(value) !== value) reject(`${field}.not_normalized`);
  return value;
}
function decimalDegrees(value, bound, field) {
  // Typed decimal strings avoid binary64 rounding, exponent aliases and implicit coercion.
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d{0,2})(?:\.\d{0,14}[1-9])?$/.test(value)
    || value === '-0') reject(`${field}.decimal_string`);
  const unsigned = value.startsWith('-') ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const scale = 10n ** BigInt(fraction.length);
  if (BigInt(whole + fraction) > BigInt(bound) * scale) reject(`${field}.range`);
  return value;
}
function geometryOf(value) {
  value = record(value, ['geometry_version', 'type', 'crs', 'axis_order', 'coordinate_encoding',
    'coordinates', 'source_sha256'], 'geometry_input');
  if (value.geometry_version !== 1 || value.type !== 'Point' || value.crs !== 'EPSG:4326'
    || value.axis_order !== 'longitude_latitude' || value.coordinate_encoding !== 'decimal_string_v1') {
    reject('geometry_input.unsupported_representation', 'unsupported');
  }
  const coordinates = list(value.coordinates, 2, 'geometry_input.coordinates');
  if (coordinates.length !== 2) reject('geometry_input.coordinates.missing', 'incomplete');
  return { geometry_version: 1, type: 'Point', crs: 'EPSG:4326', axis_order: 'longitude_latitude',
    coordinate_encoding: 'decimal_string_v1', coordinates: [decimalDegrees(coordinates[0], 180, 'longitude'),
      decimalDegrees(coordinates[1], 90, 'latitude')],
    source_sha256: hash(value.source_sha256, 'geometry_input.source_sha256') };
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** Validate the same point representation before a server-owned spatial read.
 * This is data validation, never an authorization or provider-origin receipt. */
export function prepareNeighborhoodDiscoveryGeometryV1(input) {
  try {
    const geometry = geometryOf(input);
    return freeze({ status: 'prepared', authority: AUTHORITY, geometry_input: geometry,
      geometry_input_sha256: assessmentEvidenceDigest(geometry) });
  } catch (error) {
    if (!(error instanceof InputProblem)) throw error;
    return Object.freeze({ status: error.status, reason: error.message, authority: AUTHORITY });
  }
}

/**
 * Prepare DATA ONLY for the future owner-controlled discovery producer. This does
 * not authenticate caller/source origin, verify a parcel intersection or roster
 * completeness, authorize access, capture a context, or read any provider/MLS.
 * Source-origin admission and actual SQL membership belong to Foundation's real
 * producer; immutable storage and fresh workflow/license authorization stay there.
 */
export function prepareNeighborhoodSelectorInputV1(input) {
  try {
    input = record(input, ['profile_id', 'target', 'scope', 'effective_date', 'selection',
      'geometry_input', 'discovery', 'roster'], 'input');
    if (input.profile_id !== NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V1) reject('profile.unsupported', 'unsupported');
    input.target = record(input.target, TARGET, 'target');
    if (input.target.workflow_type !== 'custom_appraisal') reject('workflow.unsupported', 'unsupported');
    const target = { report_file_id: uuid(input.target.report_file_id, 'target.report_file_id'),
      workflow_type: 'custom_appraisal', workflow_target_id: customTargetId(input.target.workflow_target_id, 'target.workflow_target_id') };
    input.scope = record(input.scope, SCOPE, 'scope');
    const scope = Object.fromEntries(SCOPE.map(key => [key, key === 'account_id'
      ? account(input.scope[key], 'scope.account_id') : uuid(input.scope[key], `scope.${key}`)]));
    let effectiveDate;
    if (typeof input.effective_date !== 'string') reject('effective_date');
    try { effectiveDate = assessmentDate(input.effective_date); } catch { reject('effective_date'); }
    input.selection = record(input.selection, ['id', 'revision', 'source_sha256'], 'selection');
    const selectionId = text(input.selection.id, NEIGHBORHOOD_CACHED_READ_ACCESS_LIMITS.reference_length, 'selection.id');
    if (!Number.isSafeInteger(input.selection.revision) || input.selection.revision < 1
      || input.selection.revision > 2_147_483_647) reject('selection.revision');
    const revision = input.selection.revision;
    const sourceHash = hash(input.selection.source_sha256, 'selection.source_sha256');
    const geometry = geometryOf(input.geometry_input);
    input.discovery = record(input.discovery, Object.keys(DISCOVERY), 'discovery');
    if (Object.keys(DISCOVERY).some(key => input.discovery[key] !== DISCOVERY[key])) reject('discovery.unsupported_semantics', 'unsupported');
    input.roster = record(input.roster, ['complete', 'account_count', 'account_ids'], 'roster');
    if (input.roster.complete === false) reject('roster.incomplete', 'incomplete');
    if (input.roster.complete !== true) reject('roster.complete');
    const originalAccounts = list(input.roster.account_ids, NEIGHBORHOOD_CACHED_READ_ACCESS_LIMITS.account_ids, 'roster.account_ids');
    if (!originalAccounts.length) reject('roster.empty', 'incomplete');
    if (!Number.isSafeInteger(input.roster.account_count) || input.roster.account_count !== originalAccounts.length) reject('roster.count_mismatch');
    const accounts = [];
    let hasSubject = false;
    for (const value of originalAccounts) {
      const normalized = account(value, 'roster.account_id');
      if (accounts.length && accounts[accounts.length - 1] >= normalized) reject('roster.order_or_duplicate');
      accounts.push(normalized);
      if (normalized === scope.account_id) hasSubject = true;
    }
    if (!hasSubject) reject('roster.subject_missing', 'incomplete');
    // Hash the flat list, not 50k object entries: shared canonical JSON has a 100k-node ceiling.
    const rosterHash = assessmentEvidenceDigest({ account_ids: accounts });
    const geometryHash = assessmentEvidenceDigest(geometry);
    const definition = { query_input_version: 1, profile_id: NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V1,
      target, scope, effective_date: effectiveDate,
      selection_ref: { id: selectionId, revision }, source_sha256: sourceHash,
      geometry_input: geometry, geometry_input_sha256: geometryHash, discovery: { ...DISCOVERY },
      roster_binding: { account_count: accounts.length, account_ids_sha256: rosterHash, completeness: 'declared_complete' } };
    const definitionHash = assessmentEvidenceDigest(definition);
    const selection = { id: selectionId, revision,
      definition_sha256: definitionHash, source_sha256: sourceHash };
    return freeze({ status: 'prepared', authority: AUTHORITY, source_origin: 'unverified',
      spatial_membership: 'unverified', roster_completeness: 'declared_not_verified',
      target, scope, effective_date: effectiveDate, selection,
      query_input: { definition, canonical_json: canonicalAssessmentJson(definition), sha256: definitionHash },
      account_roster: { account_ids: accounts, account_count: accounts.length, account_ids_sha256: rosterHash },
      selection_binding_sha256: assessmentEvidenceDigest({ scope, effective_date: effectiveDate, selection, account_ids: accounts }),
      geometry_input_sha256: geometryHash });
  } catch (error) {
    // Reuse the shared UTF-8 byte bound for every canonical preimage, including
    // the larger selection binding. Never truncate a complete roster to fit.
    if (error instanceof TypeError && error.message === 'invalid_neighborhood_assessment:json_bytes') {
      return Object.freeze({ status: 'unsupported', reason: 'input.canonical_byte_limit', authority: AUTHORITY });
    }
    if (!(error instanceof InputProblem)) throw error;
    return Object.freeze({ status: error.status, reason: error.message, authority: AUTHORITY });
  }
}
