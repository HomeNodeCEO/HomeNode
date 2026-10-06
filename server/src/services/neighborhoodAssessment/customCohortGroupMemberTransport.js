import { types } from 'node:util';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareCustomCohortGroupSummaryTransportRequest } from './customCohortRecordedGroupTransport.js';
import { prepareCustomCohortGroupSelectionReference } from './customCohortGroupSelectionRepository.js';
import { isCustomCohortPresentedMemberPage } from './customCohortPreviewPresentation.js';
import { isCustomCohortPresentedPrivateSales } from './customCohortPrivateSales.js';

// Existing 256,000-byte member page + 2MiB private projection + bounded envelope.
// Individual presenter ceilings and the reference-only request cap are unchanged.
export const CUSTOM_COHORT_SELECTION_MEMBER_BYTES = 2_360_000;
function fail(output = false) {
  throw Object.assign(new TypeError(output ? 'custom_cohort_group_members_invalid_response' : 'invalid_input'),
    { reason: output ? 'selection_response_invalid' : 'invalid_input' });
}
function closed(value, keys) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length) fail();
  const result = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) fail();
    result[key] = d.value;
  }
  return result;
}

/** Inspection of the same whole-study or selected population as its summary.
 * Recorded-group detail keeps the catalog's separate group inspection path;
 * no caller-defined pocket/member list is admitted by this exact-ref consumer. */
export function prepareCustomCohortGroupMemberInspection(population, page) {
  try {
    const p = closed(population, ['group', 'kind']), q = closed(page, ['limit', 'after_member_id']);
    if (!['all', 'selected'].includes(p.group)
      || !['stock', 'transactions', 'omitted_transactions', 'source_reported'].includes(p.kind)
      || !Number.isSafeInteger(q.limit) || q.limit < 1 || q.limit > 50
      || (q.after_member_id !== null && (typeof q.after_member_id !== 'string'
        || !/^member:[a-f0-9]{64}$/.test(q.after_member_id)))) fail();
    return Object.freeze({ population: Object.freeze(p), page: Object.freeze(q) });
  } catch { fail(); }
}

export function prepareCustomCohortGroupMemberTransportRequest(body) {
  try {
    const v = closed(body, ['assignment_file_id', 'context_ref', 'selection_ref', 'population', 'page']);
    const base = prepareCustomCohortGroupSummaryTransportRequest({ assignment_file_id: v.assignment_file_id,
      context_ref: v.context_ref, selection_ref: v.selection_ref });
    return Object.freeze({ ...base, ...prepareCustomCohortGroupMemberInspection(v.population, v.page) });
  } catch { fail(); }
}

/** A real closed projection is required, not a raw row or serialized clone.
 * This local witness never substitutes for current source/assignment rights. */
export function presentCustomCohortGroupMemberTransportResponse(result, request, accountId) {
  try {
    if (!result || types.isProxy(result)) fail();
    const privatePage = Object.hasOwn(result, 'private_sales');
    const v = closed(result, ['status', 'authority', 'target', 'context_ref', 'selection_ref',
      'selection_revision', 'subject_freshness', 'page', 'apply', ...(privatePage ? ['private_sales'] : [])]);
    const target = closed(v.target, ['account_id', 'assignment_file_id']);
    const ref = prepareCustomCohortGroupSelectionReference(v.selection_ref), page = v.page;
    const apply = closed(v.apply, ['status', 'reasons']);
    if (v.status !== 'members' || v.authority !== 'not_established' || v.subject_freshness !== 'matched'
      || target.account_id !== accountId || target.assignment_file_id !== request.assignment_file_id
      || json(v.context_ref) !== json(request.context_ref) || json(ref) !== json(request.selection_ref)
      || v.selection_revision !== ref.selection_revision || !isCustomCohortPresentedMemberPage(page, request.page)
      || json(page.binding.context_ref) !== json(request.context_ref)
      || page.binding.selection_revision !== ref.selection_revision || page.binding.selection_sha256 !== ref.selection_sha256
      || json(page.population) !== json(request.population) || page.returned_count > request.page.limit
      || (request.page.after_member_id === null && page.start_index !== 0)
      || apply.status !== 'blocked' || !Array.isArray(apply.reasons) || types.isProxy(apply.reasons)
      || json(apply.reasons) !== '["observation_preview_only"]') fail();
    if (privatePage) {
      const p = v.private_sales;
      // The closed private projection retains its assignment scope in binding,
      // not as a top-level target. Match the same envelope as summary delivery.
      if (!isCustomCohortPresentedPrivateSales(p) || p.binding.target.account_id !== accountId
        || p.binding.target.assignment_file_id !== request.assignment_file_id
        || json(p.binding.context_ref) !== json(request.context_ref)
        || p.binding.selection_revision !== ref.selection_revision || p.binding.selection_sha256 !== ref.selection_sha256
        || p.effective_date !== page.effective_date || json(p.observation_period) !== json(page.observation_period)) fail();
    }
    const output = Object.freeze({ status: 'members', authority: 'not_established',
      target: Object.freeze(target), context_ref: request.context_ref, selection_ref: ref,
      selection_revision: ref.selection_revision, subject_freshness: 'matched', page,
      apply: Object.freeze({ status: 'blocked', reasons: Object.freeze(['observation_preview_only']) }),
      ...(privatePage ? { private_sales: v.private_sales } : {}) });
    if (Buffer.byteLength(JSON.stringify(output)) > CUSTOM_COHORT_SELECTION_MEMBER_BYTES) fail();
    return output;
  } catch { fail(true); }
}
