import { types } from 'node:util';
import { serializePreparedSalesValue } from './receiptIntegrity.js';
import { validateSalesReconciliationAccountId } from '../salesReconciliation.js';
import { normalizeAddressAliasEvidence } from '../accountAddressAliases.js';
import { normalizePropertyAddress, normalizePropertyCity, normalizeSearchText } from '../../util/propertySearch.js';

export const ASSIGNMENT_SALES_MATCH_PROPOSAL_LIMITS = Object.freeze({
  page_rows: 100, page_utf8_bytes: 4194304, lookup_requests: 600,
  candidates_per_request: 5, evidence_utf8_bytes: 2097152, output_utf8_bytes: 4194304,
});
const L = ASSIGNMENT_SALES_MATCH_PROPOSAL_LIMITS;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const DISPOSITIONS = ['prepared', 'needs_review', 'duplicate', 'identity_conflict', 'rejected', 'empty'];
const ADDRESS_FIELDS = ['address', 'unparsed_address', 'property_address', 'street_address'];
const UNIT = /(?:#|\b(?:APT|APARTMENT|UNIT|STE|SUITE|BLD|BLDG|BUILDING|FLOOR|FL|LEVEL)\b)/i;
const fail = reason => { throw Object.assign(new TypeError(`assignment_sales_match_${reason}`),
  { code: 'ASSIGNMENT_SALES_MATCH_INVALID', reason }); };
const check = (condition, reason) => { if (!condition) fail(reason); };
const frozen = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(frozen); Object.freeze(value);
  }
  return value;
};
function closed(value, keys, reason = 'input_shape') {
  check(value && !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype, reason);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(descriptors).length === keys.length && keys.every(key =>
    descriptors[key]?.enumerable && Object.hasOwn(descriptors[key], 'value')), reason);
}
function array(value, limit, reason) {
  check(Array.isArray(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Array.prototype
    && value.length <= limit && Reflect.ownKeys(value).length === value.length + 1, reason);
  for (let index = 0; index < value.length; index += 1) {
    const d = Object.getOwnPropertyDescriptor(value, String(index));
    check(d?.enumerable && Object.hasOwn(d, 'value'), reason);
  }
}
function boundedText(value, maximum, nullable = false) {
  return nullable && value === null || typeof value === 'string' && value.length <= maximum
    && value.isWellFormed() && !/\p{Cc}/u.test(value);
}
function county(value) { return normalizeSearchText(value).replace(/\s+COUNTY$/, '').trim(); }
function postal(value) { return /^\d{5}(?:-\d{4})?$/.test(value) ? value.slice(0, 5) : null; }
function state(value) { return /^(TX|TEXAS)$/i.test(value) ? 'TX' : null; }

function snapshot(input) {
  closed(input, ['batch', 'rows']); closed(input.batch, ['batch_id', 'source_sha256', 'preparation_sha256']);
  check(typeof input.batch.batch_id === 'string' && UUID.test(input.batch.batch_id)
    && typeof input.batch.source_sha256 === 'string' && HASH.test(input.batch.source_sha256)
    && typeof input.batch.preparation_sha256 === 'string' && HASH.test(input.batch.preparation_sha256), 'batch_binding');
  array(input.rows, L.page_rows, 'page_limit');
  const rows = [], ids = new Set(); let bytes = 0, previous = null;
  for (const original of input.rows) {
    closed(original, ['receipt_id', 'source_row_number', 'record_data']);
    check(typeof original.receipt_id === 'string' && UUID.test(original.receipt_id) && !ids.has(original.receipt_id)
      && Number.isInteger(original.source_row_number) && original.source_row_number >= 2 && original.source_row_number <= 10001
      && (previous === null || original.source_row_number === previous + 1), 'row_binding');
    const text = serializePreparedSalesValue(original.record_data); bytes += Buffer.byteLength(text);
    check(bytes <= L.page_utf8_bytes, 'page_limit');
    const data = JSON.parse(text);
    check(data && !Array.isArray(data) && data.source_row_number === original.source_row_number
      && DISPOSITIONS.includes(data.preparation_disposition), 'row_binding');
    array(data.issues, 128, 'row_issues');
    check(data.issues.every(issue => boundedText(issue, 200)), 'row_issues');
    check(data.values === null || data.values && !Array.isArray(data.values) && typeof data.values === 'object', 'row_values');
    rows.push({ receipt_id: original.receipt_id, source_row_number: original.source_row_number, data });
    ids.add(original.receipt_id); previous = original.source_row_number;
  }
  return { batch: { ...input.batch }, rows };
}

function identityText(values, field, max, reasons) {
  const value = values[field];
  if (value === null || value === undefined || value === '') return null;
  if (!boundedText(value, max)) { reasons.add('unsupported_identity_field'); return null; }
  return value.trim() || null;
}
function consensus(values, fields, maximum, normalize, reasons) {
  const literals = fields.map(field => identityText(values, field, maximum, reasons)).filter(Boolean);
  const keys = [...new Set(literals.map(literal => {
    const key = normalize(literal);
    return key && key.length <= maximum ? key : null;
  }))];
  if (keys.includes(null)) reasons.add('unsupported_location_metadata');
  if (keys.length > 1) reasons.add('conflicting_location_fields');
  return keys.length === 1 ? keys[0] : null;
}

function addressRequest(raw, location, reasons) {
  // Existing shared matching drops comma-tail unit fragments. This profile does
  // not: any unit/building notation requires review, including exact ID matches.
  if (UNIT.test(raw)) { reasons.add('unit_or_building_review_required'); return null; }
  const parts = raw.split(',').map(part => part.trim());
  if (parts.some(part => !part) || parts.length > 3) { reasons.add('unsupported_address_format'); return null; }
  const street = parts[0]; let embeddedCity = null, embeddedPostal = null;
  if (parts.length > 1) {
    embeddedCity = normalizePropertyCity(parts[1]);
    if (/^(TX|TEXAS)(?:\s|$)/i.test(parts[1])) { reasons.add('address_city_required'); return null; }
  }
  if (parts.length === 3) {
    const tail = /^(TX|TEXAS)(?:\s+(\d{5}(?:-\d{4})?))?$/i.exec(parts[2]);
    if (!tail) { reasons.add('unsupported_address_format'); return null; }
    embeddedPostal = tail[2] ? postal(tail[2]) : null;
  }
  if (location.city && embeddedCity && location.city !== embeddedCity
    || location.postal && embeddedPostal && location.postal !== embeddedPostal) reasons.add('conflicting_location_fields');
  const city = location.city || embeddedCity;
  if (!city) { reasons.add('address_city_required'); return null; }
  if (!/^\d+[A-Za-z]?(?:-\d+[A-Za-z]?)?(?:\s+1\/2)?\s+\S/.test(street)) {
    reasons.add('unsupported_address_format'); return null;
  }
  // The shared alias helper truncates keys. Never let normalization expansion
  // or a long comma-tail city turn a prefix into this profile's exact evidence.
  if (normalizePropertyAddress(street).length > 500 || city.length > 200) {
    reasons.add('unsupported_identity_field'); return null;
  }
  const evidence = normalizeAddressAliasEvidence({ address: street, city, county: location.county,
    postalCode: location.postal || embeddedPostal });
  return { kind: 'address', identifier: null, address_key: evidence.address_key, city_key: evidence.city_key,
    county_key: evidence.county_key, postal_code5: evidence.postal_code5 };
}

function requestsFor(rows) {
  const requests = [], indexed = new Map();
  const lookup = definition => {
    const key = JSON.stringify(definition);
    if (!indexed.has(key)) {
      check(requests.length < L.lookup_requests, 'request_limit');
      const entry = frozen({ request_id: `lookup:${requests.length + 1}`, ...definition });
      requests.push(entry); indexed.set(key, entry.request_id);
    }
    return indexed.get(key);
  };
  const planned = rows.map(row => {
    const reasons = new Set(), parcelIds = [], addressIds = [], values = row.data.values;
    const result = { ...row, reasons, parcelIds, addressIds, hasParcel: false, location: {} };
    if (['rejected', 'empty'].includes(row.data.preparation_disposition) || values === null) {
      reasons.add('row_not_interpretable'); return result;
    }
    if (row.data.preparation_disposition === 'identity_conflict') reasons.add('source_identity_conflict');
    if (row.data.preparation_disposition === 'duplicate') reasons.add('duplicate_source_row');
    const location = result.location = {
      county: consensus(values, ['county', 'county_or_parish'], 100, county, reasons),
      city: consensus(values, ['city'], 200, normalizePropertyCity, reasons),
      postal: consensus(values, ['postal_code', 'zip'], 20, postal, reasons),
      state: consensus(values, ['state', 'state_or_province'], 100, state, reasons),
    };
    for (const field of ['parcel_number_raw', 'parcel_number2_raw']) {
      if (values[field] !== null && values[field] !== undefined && values[field] !== '') result.hasParcel = true;
      const identifier = identityText(values, field, 100, reasons);
      if (!identifier) continue;
      try { validateSalesReconciliationAccountId(identifier, location.county); }
      catch { reasons.add('parcel_identifier_requires_review'); continue; }
      parcelIds.push(lookup({ kind: 'identifier', identifier, address_key: null, city_key: null,
        county_key: location.county, postal_code5: null }));
    }
    for (const field of ADDRESS_FIELDS) {
      const raw = identityText(values, field, 500, reasons);
      if (!raw) continue;
      const definition = addressRequest(raw, location, reasons);
      if (definition) addressIds.push(lookup(definition));
    }
    result.parcelIds = [...new Set(parcelIds)]; result.addressIds = [...new Set(addressIds)];
    if (result.addressIds.length > 1) reasons.add('conflicting_address_fields');
    return result;
  });
  return { requests, planned };
}

function observedEvidence(value, requests) {
  const text = serializePreparedSalesValue(value);
  check(Buffer.byteLength(text) <= L.evidence_utf8_bytes, 'evidence_limit');
  const evidence = JSON.parse(text);
  closed(evidence, ['observed_at', 'results'], 'evidence_shape');
  const at = evidence.observed_at;
  check(typeof at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(at)
    && Number.isFinite(Date.parse(at)) && new Date(at).toISOString().slice(0, 19) === at.slice(0, 19), 'observation_time');
  array(evidence.results, L.lookup_requests, 'evidence_limit');
  check(evidence.results.length === requests.length, 'lookup_binding');
  const known = new Set(requests.map(request => request.request_id)), byId = new Map(), accounts = new Map();
  for (const result of evidence.results) {
    closed(result, ['request_id', 'status', 'candidates'], 'evidence_shape');
    check(known.has(result.request_id) && !byId.has(result.request_id)
      && ['complete', 'unavailable'].includes(result.status), 'lookup_binding');
    array(result.candidates, L.candidates_per_request, 'evidence_limit');
    const ids = new Set();
    for (const candidate of result.candidates) {
      closed(candidate, ['account_id', 'address', 'city', 'county', 'postal_code'], 'evidence_shape');
      check(boundedText(candidate.account_id, 100) && candidate.account_id.trim() === candidate.account_id
        && candidate.account_id.length > 0 && !ids.has(candidate.account_id), 'candidate_identity');
      for (const [field, maximum] of [['address', 500], ['city', 200], ['county', 100], ['postal_code', 20]]) {
        check(boundedText(candidate[field], maximum, true), 'candidate_evidence');
      }
      const exact = JSON.stringify(candidate);
      check(!accounts.has(candidate.account_id) || accounts.get(candidate.account_id) === exact, 'candidate_evidence_conflict');
      accounts.set(candidate.account_id, exact);
      ids.add(candidate.account_id);
    }
    byId.set(result.request_id, result);
  }
  return { observed_at: at, byId };
}

function sameAddress(candidate, request) {
  if (!candidate.address || !candidate.city) return null;
  // Reject rather than compare a street-only prefix of a compound CAD address.
  if (candidate.address.includes(',') || UNIT.test(candidate.address)) return false;
  return normalizePropertyAddress(candidate.address) === request.address_key
    && normalizePropertyCity(candidate.city) === request.city_key
    && (!request.county_key || county(candidate.county) === request.county_key)
    && (!request.postal_code5 || postal(candidate.postal_code || '') === request.postal_code5);
}

function proposal(row, evidence, requests) {
  const reasons = row.reasons, requestIds = [...new Set([...row.parcelIds, ...row.addressIds])];
  const seen = new Set();
  const unique = (id, deferEmpty = false) => {
    const result = evidence.byId.get(id);
    for (const candidate of result.candidates) seen.add(candidate.account_id);
    if (result.status !== 'complete') { reasons.add('candidate_lookup_unavailable'); return null; }
    if (result.candidates.length !== 1) {
      if (result.candidates.length || !deferEmpty) reasons.add(result.candidates.length ? 'ambiguous_candidate' : 'no_unique_candidate');
      return null;
    }
    const candidate = result.candidates[0], expectedCounty = row.location.county;
    if (expectedCounty && county(candidate.county) !== expectedCounty) { reasons.add('candidate_county_conflict'); return null; }
    return candidate;
  };
  const parcels = row.parcelIds.map(id => unique(id)), addresses = row.addressIds.map(id => unique(id, row.hasParcel));
  const parcelAccounts = [...new Set(parcels.filter(Boolean).map(candidate => candidate.account_id))];
  let proposed = [], method = null;
  if (row.hasParcel) {
    if (!parcels.length || parcels.some(candidate => !candidate)) reasons.add('incomplete_supplied_parcel_set');
    if (parcels.filter(Boolean).length !== parcelAccounts.length) reasons.add('parcel_reference_alias_collision');
    if (new Set(parcels.filter(Boolean).map(candidate => county(candidate.county))).size > 1) reasons.add('multiple_counties_require_review');
    for (let index = 0; index < addresses.length; index += 1) {
      const candidate = addresses[index], request = requests.get(row.addressIds[index]);
      if (candidate && !parcelAccounts.includes(candidate.account_id)) reasons.add('parcel_address_conflict');
      const comparisons = parcels.filter(Boolean).map(parcel => sameAddress(parcel, request));
      const addressEvidence = evidence.byId.get(row.addressIds[index]);
      if (addressEvidence.status === 'complete' && !addressEvidence.candidates.length) {
        // A missing alias entry is not a situs contradiction. Every supplied
        // parcel must independently corroborate the reported address/city/county;
        // a partial parcel set, missing county, or one differing situs cannot.
        const completeSet = parcels.length > 0 && comparisons.length === parcels.length;
        if (!(completeSet && request.county_key && comparisons.every(value => value === true))) {
          reasons.add('no_unique_candidate');
          if (comparisons.includes(false)) reasons.add('parcel_address_conflict');
          else if (completeSet && (!request.county_key || comparisons.includes(null))) reasons.add('parcel_address_unverified');
        }
      } else if (comparisons.length && !comparisons.includes(true)) {
        reasons.add(comparisons.includes(false) ? 'parcel_address_conflict' : 'parcel_address_unverified');
      }
    }
    proposed = parcelAccounts; method = 'supplied_parcel_identifiers';
  } else if (addresses.length === 1 && addresses[0]) {
    if (sameAddress(addresses[0], requests.get(row.addressIds[0])) !== true) reasons.add('candidate_address_conflict');
    proposed = [addresses[0].account_id]; method = 'unique_exact_address';
  }
  if (!requestIds.length && !reasons.size) reasons.add('no_supported_property_identity');
  const status = reasons.has('row_not_interpretable') ? 'not_proposed'
    : !reasons.size && proposed.length ? 'proposed'
      : [...reasons].every(reason => ['no_unique_candidate', 'no_supported_property_identity', 'incomplete_supplied_parcel_set'].includes(reason))
        ? 'unresolved' : 'review_required';
  return { receipt_id: row.receipt_id, source_row_number: row.source_row_number,
    preparation_disposition: row.data.preparation_disposition, preparation_issues: [...row.data.issues],
    proposal_status: status, method: status === 'proposed' ? method : null,
    proposed_account_ids: status === 'proposed' ? proposed : [], observed_candidate_account_ids: [...seen].sort(),
    lookup_ids: requestIds, reasons: [...reasons].sort(), accepted: false, review_required: true,
    matching_status: 'proposal_only', analysis_status: 'not_evaluated' };
}

/** Owner-only observation computation, NOT an authorization or matching write.
 * Owner must verify the saved batch/page and authorize exact assignment + public
 * CAD reads. readCandidates runs once in its finite read-only transaction; use
 * batched exact account/native-identifier and address-alias lookups, no fuzzy
 * search, per-row connections, global reconciliation, or source-file city hints.
 * `complete` concerns that lookup only, never historical/source completeness.
 * Current observations and a candidate proposal cannot admit a sale to analysis.
 */
export async function proposeAssignmentSalesMatchPage(input, { readCandidates } = {}) {
  check(typeof readCandidates === 'function', 'candidate_reader_required');
  const owned = snapshot(input), { requests, planned } = requestsFor(owned.rows);
  const evidence = requests.length ? observedEvidence(await readCandidates(frozen({ requests })), requests)
    : { observed_at: null, byId: new Map() };
  const byId = new Map(requests.map(request => [request.request_id, request]));
  const result = { proposal_version: 1, basis: 'observed_current_cad_candidates', binding: owned.batch,
    observed_at: evidence.observed_at, rows: planned.map(row => proposal(row, evidence, byId)),
    lookups: requests.map(request => ({ request, ...evidence.byId.get(request.request_id) })),
    matching_status: 'proposal_only', analysis_status: 'not_evaluated', accepted: false,
    limitations: ['appraiser_confirmation_required', 'lookup_not_historical_parcel_membership',
      'no_economic_property_or_sale_eligibility_determination', 'no_unit_currency_or_source_meaning_inference',
      'no_shared_sales_or_alias_writes'] };
  check(Buffer.byteLength(JSON.stringify(result)) <= L.output_utf8_bytes, 'output_limit');
  return frozen(result);
}
