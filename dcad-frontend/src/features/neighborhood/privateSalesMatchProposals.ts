import type { PrivateSalesIdentity, PrivateSalesReceipt, PrivateSalesRow } from './privateSalesImports';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const LOOKUP = /^lookup:[1-9]\d{0,2}$/;
export const PRIVATE_SALES_MATCH_LIMITATIONS = ['appraiser_confirmation_required', 'lookup_not_historical_parcel_membership',
  'no_economic_property_or_sale_eligibility_determination', 'no_unit_currency_or_source_meaning_inference', 'no_shared_sales_or_alias_writes'] as const;
const REASONS = new Set(['unsupported_identity_field', 'unsupported_location_metadata', 'conflicting_location_fields',
  'unit_or_building_review_required', 'unsupported_address_format', 'address_city_required', 'parcel_identifier_requires_review',
  'conflicting_address_fields', 'row_not_interpretable', 'source_identity_conflict', 'duplicate_source_row', 'candidate_lookup_unavailable',
  'ambiguous_candidate', 'no_unique_candidate', 'candidate_county_conflict', 'incomplete_supplied_parcel_set', 'parcel_reference_alias_collision',
  'multiple_counties_require_review', 'parcel_address_conflict', 'parcel_address_unverified', 'candidate_address_conflict', 'no_supported_property_identity']);
const UNRESOLVED = new Set(['no_unique_candidate', 'no_supported_property_identity', 'incomplete_supplied_parcel_set']);
const check: (value: unknown) => asserts value = value => { if (!value) throw new Error('private_sales_match_invalid_response'); };
function closed(raw: unknown, keys: string[]): Record<string, unknown> {
  check(raw && Object.getPrototypeOf(raw) === Object.prototype);
  const value = raw as Record<string, unknown>;
  check(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))); return value;
}
const literal = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length <= maximum
  && !/\p{Cc}/u.test(value) && Array.from(value).every(part => part.length === 2 || part.charCodeAt(0) < 0xd800 || part.charCodeAt(0) > 0xdfff);
const account = (value: unknown): value is string => literal(value, 100) && value.length > 0 && value.trim() === value;
const sequence = (raw: unknown, maximum: number): unknown[] => {
  check(Array.isArray(raw) && raw.length <= maximum && Object.keys(raw).length === raw.length);
  for (let index = 0; index < raw.length; index++) check(Object.hasOwn(raw, index)); return raw;
};
function strings(raw: unknown, maximum: number, validate: (value: unknown) => boolean): string[] {
  const values = sequence(raw, maximum); check(values.every(validate) && new Set(values).size === values.length); return values as string[];
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (values: string[]) => equal(values, [...values].sort());
function observedAt(value: unknown): boolean {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}
export interface PrivateSalesMatchProposalRow {
  receipt_id: string; source_row_number: number; preparation_disposition: string; preparation_issues: string[];
  proposal_status: 'proposed' | 'unresolved' | 'review_required' | 'not_proposed';
  method: 'supplied_parcel_identifiers' | 'unique_exact_address' | null;
  proposed_account_ids: string[]; observed_candidate_account_ids: string[]; lookup_ids: string[]; reasons: string[];
  accepted: false; review_required: true; matching_status: 'proposal_only'; analysis_status: 'not_evaluated';
}
export interface PrivateSalesMatchProposalPage {
  account_id: string; assignment_file_id: string; report_file_id: string; next_after_row: number | null;
  proposal_version: 1; basis: 'observed_current_cad_candidates';
  binding: { batch_id: string; source_sha256: string; preparation_sha256: string };
  observed_at: string | null; rows: PrivateSalesMatchProposalRow[]; lookups: unknown[];
  matching_status: 'proposal_only'; analysis_status: 'not_evaluated'; accepted: false;
  limitations: string[]; proposal_page_sha256: string;
}

/** Display admission only. The server-issued digest is an opaque observation
 * identity, not browser-verified evidence, an approval, or a durable match. */
export function checkPrivateSalesMatchProposals(raw: unknown, expected: {
  identity: PrivateSalesIdentity; receipt: PrivateSalesReceipt;
  page: { batch_id: string; rows: PrivateSalesRow[]; next_after_row: number | null };
}): PrivateSalesMatchProposalPage {
  const { identity, receipt, page } = expected;
  const value = closed(raw, ['account_id', 'assignment_file_id', 'report_file_id', 'next_after_row', 'proposal_version', 'basis',
    'binding', 'observed_at', 'rows', 'lookups', 'matching_status', 'analysis_status', 'accepted', 'limitations', 'proposal_page_sha256']);
  check(value.account_id === identity.accountId && value.assignment_file_id === String(identity.assignmentFileId)
    && value.report_file_id === receipt.report_file_id && value.next_after_row === page.next_after_row
    && value.proposal_version === 1 && value.basis === 'observed_current_cad_candidates' && value.matching_status === 'proposal_only'
    && value.analysis_status === 'not_evaluated' && value.accepted === false && equal(value.limitations, PRIVATE_SALES_MATCH_LIMITATIONS)
    && typeof value.proposal_page_sha256 === 'string' && SHA.test(value.proposal_page_sha256));
  const binding = closed(value.binding, ['batch_id', 'source_sha256', 'preparation_sha256']);
  check(binding.batch_id === receipt.batch_id && binding.batch_id === page.batch_id
    && binding.source_sha256 === receipt.source_sha256 && binding.preparation_sha256 === receipt.preparation_sha256);
  const lookups = sequence(value.lookups, 600), rows = sequence(value.rows, 100);
  check(rows.length === page.rows.length && (lookups.length ? observedAt(value.observed_at) : value.observed_at === null));
  const byLookup = new Map<string, string[]>(), lookupComplete = new Map<string, boolean>(), candidateFacts = new Map<string, string>();
  for (const [index, rawLookup] of lookups.entries()) {
    const lookup = closed(rawLookup, ['request', 'request_id', 'status', 'candidates']);
    const request = closed(lookup.request, ['request_id', 'kind', 'identifier', 'address_key', 'city_key', 'county_key', 'postal_code5']);
    const requestId = `lookup:${index + 1}`;
    check(lookup.request_id === requestId && request.request_id === requestId && ['complete', 'unavailable'].includes(lookup.status as string)
      && (request.county_key === null || literal(request.county_key, 100))
      && (request.postal_code5 === null || typeof request.postal_code5 === 'string' && /^\d{5}$/.test(request.postal_code5)));
    if (request.kind === 'identifier') check(account(request.identifier) && request.address_key === null
      && request.city_key === null && request.postal_code5 === null);
    else check(request.kind === 'address' && request.identifier === null && literal(request.address_key, 500)
      && Boolean(request.address_key) && literal(request.city_key, 200) && Boolean(request.city_key));
    const candidates = sequence(lookup.candidates, 5), ids: string[] = [];
    for (const item of candidates) {
      const candidate = closed(item, ['account_id', 'address', 'city', 'county', 'postal_code']); check(account(candidate.account_id));
      for (const [key, maximum] of [['address', 500], ['city', 200], ['county', 100], ['postal_code', 20]] as const)
        check(candidate[key] === null || literal(candidate[key], maximum));
      check(!ids.includes(candidate.account_id)); ids.push(candidate.account_id);
      const facts = JSON.stringify([candidate.address, candidate.city, candidate.county, candidate.postal_code]);
      check(!candidateFacts.has(candidate.account_id) || candidateFacts.get(candidate.account_id) === facts);
      candidateFacts.set(candidate.account_id, facts);
    }
    byLookup.set(requestId, ids);
    lookupComplete.set(requestId, lookup.status === 'complete');
  }
  const used = new Set<string>(), rowIds = new Set<string>();
  for (const [index, rawRow] of rows.entries()) {
    const row = closed(rawRow, ['receipt_id', 'source_row_number', 'preparation_disposition', 'preparation_issues', 'proposal_status',
      'method', 'proposed_account_ids', 'observed_candidate_account_ids', 'lookup_ids', 'reasons', 'accepted', 'review_required',
      'matching_status', 'analysis_status']);
    const original = page.rows[index];
    check(row.receipt_id === original.receipt_id && typeof row.receipt_id === 'string' && UUID.test(row.receipt_id)
      && !rowIds.has(row.receipt_id) && row.source_row_number === original.source_row_number
      && row.preparation_disposition === original.preparation_disposition && equal(row.preparation_issues, original.issues)
      && row.accepted === false && row.review_required === true && row.matching_status === 'proposal_only' && row.analysis_status === 'not_evaluated');
    rowIds.add(row.receipt_id);
    const lookupIds = strings(row.lookup_ids, 6, value => typeof value === 'string' && LOOKUP.test(value) && byLookup.has(value));
    lookupIds.forEach(id => used.add(id));
    const proposed = strings(row.proposed_account_ids, 2, account), observed = strings(row.observed_candidate_account_ids, 30, account);
    const reasons = strings(row.reasons, REASONS.size, value => typeof value === 'string' && REASONS.has(value));
    check(sorted(reasons) && sorted(observed) && equal(observed, [...new Set(lookupIds.flatMap(id => byLookup.get(id)!))].sort())
      && proposed.every(id => observed.includes(id)));
    if (row.proposal_status === 'proposed') check(reasons.length === 0 && proposed.length > 0 && lookupIds.every(id => lookupComplete.get(id))
      && (row.method === 'supplied_parcel_identifiers' || row.method === 'unique_exact_address' && proposed.length === 1));
    else {
      check(proposed.length === 0 && row.method === null && reasons.length > 0);
      const status = reasons.includes('row_not_interpretable') ? 'not_proposed'
        : reasons.every(reason => UNRESOLVED.has(reason)) ? 'unresolved' : 'review_required';
      check(row.proposal_status === status);
    }
  }
  check(used.size === lookups.length);
  return value as unknown as PrivateSalesMatchProposalPage;
}
