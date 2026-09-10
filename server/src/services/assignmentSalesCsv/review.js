import { types } from 'node:util';
import { serializePreparedSalesValue } from './receiptIntegrity.js';
import { proposeAssignmentSalesMatchPage, ASSIGNMENT_SALES_MATCH_PROPOSAL_LIMITS } from './matchProposals.js';

export const ASSIGNMENT_SALES_REVIEW_LIMITS = Object.freeze({ command_bytes: 262144, payload_bytes: 2097152,
  rows: 100, accounts_per_row: 5, expected_revision: 2147483646 });
const L = ASSIGNMENT_SALES_REVIEW_LIMITS, PL = ASSIGNMENT_SALES_MATCH_PROPOSAL_LIMITS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTERPRETATION = ['source_name', 'provenance_note', 'currency', 'living_area_unit', 'site_area_unit',
  'consideration_field', 'marketing_time_field', 'source_use_confirmed'];
const PROPOSAL = ['proposal_version', 'basis', 'binding', 'observed_at', 'rows', 'lookups',
  'matching_status', 'analysis_status', 'accepted', 'limitations'];
const DISPOSITIONS = ['prepared', 'needs_review', 'duplicate', 'identity_conflict', 'rejected', 'empty'];
const fail = suffix => { throw Object.assign(new Error(`assignment_sales_import_${suffix}`),
  { code: `assignment_sales_import_${suffix}` }); };
const check = (ok, suffix = 'invalid_input') => { if (!ok) fail(suffix); };
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function exact(value, keys) {
  check(value && !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype);
  const ds = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(ds).length === keys.length && keys.every(key => ds[key]?.enumerable && Object.hasOwn(ds[key], 'value')));
}
function array(value, max) {
  check(Array.isArray(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Array.prototype
    && value.length <= max && Reflect.ownKeys(value).length === value.length + 1);
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    check(d?.enumerable && Object.hasOwn(d, 'value'));
  }
}
function json(value) {
  try { return serializePreparedSalesValue(value); }
  catch (error) { fail(error?.code === 'assignment_sales_import_preparation_limit' ? 'preparation_limit' : 'invalid_input'); }
}
function copy(value, limit = L.payload_bytes) {
  const text = json(value); check(Buffer.byteLength(text) <= limit, 'preparation_limit');
  return JSON.parse(text);
}
const note = value => typeof value === 'string' && value.length <= 1000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value);
const ordinal = value => Number.isInteger(value) && value >= 2 && value <= 10001;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128
  && value.trim() === value && !/\p{Cc}/u.test(value);

/** A declared interpretation is not provider permission, field truth, economic
 * membership, sale eligibility, or historical coverage. No defaults or values
 * are inferred: cumulative_days_on_market is not in today's CSV normalizer and
 * retaining that declaration does not alias it to days_on_market. */
export function validateAssignmentSalesReviewCommand(value) {
  const command = copy(value, L.command_bytes);
  exact(command, ['review_version', 'expected_revision', 'source_interpretation', 'row_decisions']);
  check(command.review_version === 1 && Number.isInteger(command.expected_revision)
    && command.expected_revision >= 0 && command.expected_revision <= L.expected_revision);
  const source = command.source_interpretation;
  if (source !== null) {
    exact(source, INTERPRETATION);
    check(typeof source.source_name === 'string' && !/\p{Cc}/u.test(source.source_name));
    source.source_name = source.source_name.trim();
    check(source.source_name.length > 0 && source.source_name.length <= 200 && note(source.provenance_note)
      && [null, 'USD'].includes(source.currency) && [null, 'sqft', 'sqm'].includes(source.living_area_unit)
      && [null, 'sqft', 'acre', 'sqm'].includes(source.site_area_unit)
      && [null, 'close_price', 'current_price'].includes(source.consideration_field)
      && [null, 'days_on_market', 'cumulative_days_on_market'].includes(source.marketing_time_field)
      && typeof source.source_use_confirmed === 'boolean');
  }
  array(command.row_decisions, L.rows);
  check(source !== null || command.row_decisions.length > 0);
  const receipts = new Set(), ordinals = new Set();
  for (const row of command.row_decisions) {
    exact(row, ['receipt_id', 'source_row_number', 'decision', 'account_ids', 'note']);
    check(typeof row.receipt_id === 'string' && UUID.test(row.receipt_id) && ordinal(row.source_row_number)
      && ['confirm_proposed_match', 'exclude', 'clear'].includes(row.decision) && note(row.note));
    row.receipt_id = row.receipt_id.toLowerCase();
    check(!receipts.has(row.receipt_id) && !ordinals.has(row.source_row_number));
    receipts.add(row.receipt_id); ordinals.add(row.source_row_number);
    array(row.account_ids, L.accounts_per_row);
    check(row.account_ids.every(id) && new Set(row.account_ids).size === row.account_ids.length
      && (row.decision === 'confirm_proposed_match' ? row.account_ids.length > 0 : row.account_ids.length === 0));
    row.account_ids.sort(compare);
  }
  return freeze(command);
}

function storedRows(value) {
  array(value, L.rows);
  const receipts = new Set(), ordinals = new Set(); let bytes = 0;
  return value.map(row => {
    exact(row, ['receipt_id', 'source_row_number', 'record_data']);
    check(typeof row.receipt_id === 'string' && UUID.test(row.receipt_id) && row.receipt_id === row.receipt_id.toLowerCase()
      && ordinal(row.source_row_number) && !receipts.has(row.receipt_id) && !ordinals.has(row.source_row_number));
    const text = json(row.record_data); bytes += Buffer.byteLength(text);
    check(bytes <= PL.page_utf8_bytes, 'preparation_limit');
    const data = JSON.parse(text);
    check(data && !Array.isArray(data) && data.source_row_number === row.source_row_number
      && DISPOSITIONS.includes(data.preparation_disposition));
    receipts.add(row.receipt_id); ordinals.add(row.source_row_number);
    return { receipt_id: row.receipt_id, source_row_number: row.source_row_number, record_data: data };
  });
}
function snapshotProposal(value) {
  exact(value, PROPOSAL); array(value.rows, PL.page_rows); array(value.lookups, PL.lookup_requests);
  const header = copy(Object.fromEntries(PROPOSAL.filter(key => !['rows', 'lookups'].includes(key)).map(key => [key, value[key]])));
  let bytes = Buffer.byteLength(json(header));
  const items = values => values.map(value => {
    const text = json(value); bytes += Buffer.byteLength(text); check(bytes <= PL.output_utf8_bytes, 'preparation_limit');
    return JSON.parse(text);
  });
  return { ...header, rows: items(value.rows), lookups: items(value.lookups) };
}
function sameProposal(left, right) {
  return PROPOSAL.every(key => ['rows', 'lookups'].includes(key)
    ? left[key].length === right[key].length && left[key].every((item, index) => json(item) === json(right[key][index]))
    : json(left[key]) === json(right[key]));
}

/** Owner-only pure construction. The owner must load/authorize the exact batch,
 * supply fresh server observations and serialize review/signing state. This
 * recomputation checks consistency, NOT provenance or freshness of caller data.
 * All inputs are detached before the first await. The kernel replay performs
 * no I/O and avoids a second, divergent set of address/parcel identity rules. */
export async function buildAssignmentSalesReviewPayload(input) {
  exact(input, ['command', 'rows', 'proposalPage']);
  const command = validateAssignmentSalesReviewCommand(input.command), rows = storedRows(input.rows);
  const confirmations = command.row_decisions.some(row => row.decision === 'confirm_proposed_match');
  const page = confirmations ? snapshotProposal(input.proposalPage) : null;
  if (!confirmations) check(input.proposalPage === null);
  const byReceipt = new Map(rows.map(row => [row.receipt_id, row]));
  for (const decision of command.row_decisions) {
    const row = byReceipt.get(decision.receipt_id);
    check(row && row.source_row_number === decision.source_row_number, 'stale_match');
    if (decision.decision === 'confirm_proposed_match') {
      check(['prepared', 'needs_review'].includes(row.record_data.preparation_disposition), 'stale_match');
    }
  }
  if (page) {
    const lookupById = new Map();
    for (const lookup of page.lookups) {
      exact(lookup, ['request', 'request_id', 'status', 'candidates']);
      check(!lookupById.has(lookup.request_id), 'stale_match'); lookupById.set(lookup.request_id, lookup);
    }
    let rebuilt;
    try {
      rebuilt = await proposeAssignmentSalesMatchPage({ batch: page.binding, rows }, { readCandidates: ({ requests }) => {
        check(requests.length === page.lookups.length, 'stale_match');
        return { observed_at: page.observed_at, results: requests.map(request => {
          const lookup = lookupById.get(request.request_id);
          check(lookup && json(lookup.request) === json(request), 'stale_match');
          return { request_id: lookup.request_id, status: lookup.status, candidates: lookup.candidates };
        }) };
      } });
    } catch (error) { fail(error?.code === 'assignment_sales_import_preparation_limit' ? 'preparation_limit' : 'stale_match'); }
    check(sameProposal(page, rebuilt), 'stale_match');
  }
  const proposals = new Map((page?.rows ?? []).map(row => [row.receipt_id, row]));
  const rowDecisions = command.row_decisions.map(decision => {
    const stored = byReceipt.get(decision.receipt_id); let evidence = null;
    if (decision.decision === 'confirm_proposed_match') {
      const proposal = proposals.get(decision.receipt_id);
      check(proposal?.source_row_number === decision.source_row_number && proposal.proposal_status === 'proposed'
        && json([...proposal.proposed_account_ids].sort(compare)) === json(decision.account_ids), 'stale_match');
      const selectedLookups = new Set(proposal.lookup_ids);
      evidence = { proposal_version: page.proposal_version, basis: page.basis, binding: page.binding,
        observed_at: page.observed_at, proposal, lookups: page.lookups.filter(lookup => selectedLookups.has(lookup.request_id)) };
    }
    return { ...decision, record_data: stored.record_data, match_evidence: evidence };
  });
  // Honest whole-payload ceiling: large original rows require a smaller review
  // submission. No prefix is saved and no evidence is clipped to make it fit.
  return freeze(copy({ review_version: 1, source_interpretation: command.source_interpretation,
    row_decisions: rowDecisions, matching_status: 'reviewed_separately', analysis_status: 'not_evaluated' }, L.payload_bytes));
}
