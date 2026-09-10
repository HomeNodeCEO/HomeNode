import { checkPrivateSalesIdentity, checkPrivateSalesReceipt, checkPrivateSalesRows } from './privateSalesImports.ts';
import type { PrivateSalesIdentity, PrivateSalesIo, PrivateSalesReceipt, PrivateSalesRow } from './privateSalesImports';
import { checkPrivateSalesMatchProposals } from './privateSalesMatchProposals.ts';
import type { PrivateSalesMatchProposalPage } from './privateSalesMatchProposals';

export interface PrivateSalesSourceInterpretation {
  source_name: string; provenance_note: string; currency: 'USD' | null;
  living_area_unit: 'sqft' | 'sqm' | null; site_area_unit: 'sqft' | 'acre' | 'sqm' | null;
  consideration_field: 'close_price' | 'current_price' | null;
  marketing_time_field: 'days_on_market' | 'cumulative_days_on_market' | null;
  source_use_confirmed: boolean;
}
export interface PrivateSalesRowDecision {
  receipt_id: string; source_row_number: number; decision: 'confirm_proposed_match' | 'exclude' | 'clear'; account_ids: string[]; note: string;
}
export interface PrivateSalesReviewCommand {
  review_version: 1; expected_revision: number; source_interpretation: PrivateSalesSourceInterpretation | null;
  row_decisions: PrivateSalesRowDecision[];
}
interface ReviewScope {
  review_version: 1; account_id: string; assignment_file_id: string; report_file_id: string; batch_id: string;
  source_sha256: string; preparation_sha256: string; matching_status: 'reviewed_separately'; analysis_status: 'not_evaluated';
}
export interface PrivateSalesReviewState extends ReviewScope {
  revision: number; last_review_id: string | null; source_interpretation: PrivateSalesSourceInterpretation | null;
  source_review_id: string | null; row_decisions: (PrivateSalesRowDecision & { review_id: string; revision: number })[];
  next_after_row: number | null;
}
export interface PrivateSalesReviewReceipt extends ReviewScope {
  persisted: true; review_id: string; operation_id: string; revision: number; previous_revision: number; actor_user_id: string;
  recorded_at: string; command_sha256: string; payload_sha256: string; command: PrivateSalesReviewCommand; replayed: boolean;
}
export interface PrivateSalesReviewPage { batch_id: string; rows: PrivateSalesRow[]; next_after_row: number | null }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const SOURCE_KEYS = ['source_name', 'provenance_note', 'currency', 'living_area_unit', 'site_area_unit', 'consideration_field', 'marketing_time_field', 'source_use_confirmed'];
const ROW_KEYS = ['receipt_id', 'source_row_number', 'decision', 'account_ids', 'note'];
const SCOPE_KEYS = ['review_version', 'account_id', 'assignment_file_id', 'report_file_id', 'batch_id', 'source_sha256', 'preparation_sha256', 'matching_status', 'analysis_status'];
const check: (value: unknown) => asserts value = value => { if (!value) throw new Error('private_sales_review_invalid'); };
const integer = (value: unknown, minimum: number, maximum: number): value is number => Number.isSafeInteger(value)
  && (value as number) >= minimum && (value as number) <= maximum;
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sameFields = (a: object, b: Record<string, unknown>, keys: string[]) => keys.every(key =>
  same((a as Record<string, unknown>)[key], b[key]));
function closed(raw: unknown, keys: string[]) {
  check(raw && Object.getPrototypeOf(raw) === Object.prototype);
  const value = raw as Record<string, unknown>;
  check(Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.getOwnPropertyDescriptor(value, key)?.enumerable
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))); return value;
}
function array(raw: unknown, limit: number): unknown[] {
  check(Array.isArray(raw) && Object.getPrototypeOf(raw) === Array.prototype && raw.length <= limit && Reflect.ownKeys(raw).length === raw.length + 1);
  for (let index = 0; index < raw.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    check(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
  } return raw;
}
function text(value: unknown, limit: number, multiline = false): value is string {
  return typeof value === 'string' && value.length <= limit && Array.from(value).every(part => {
    const code = part.charCodeAt(0);
    return (part.length === 2 || code < 0xd800 || code > 0xdfff)
      && (code >= 32 && (code < 127 || code > 159) || multiline && [9, 10, 13].includes(code));
  });
}
export function preparePrivateSalesSourceInterpretation(raw: unknown): PrivateSalesSourceInterpretation {
  const value = closed(raw, SOURCE_KEYS); check(typeof value.source_name === 'string' && text(value.source_name, 262144));
  const name = value.source_name.trim(); check(text(name, 200) && name.length > 0 && text(value.provenance_note, 1000, true));
  for (const [key, allowed] of [['currency', ['USD']], ['living_area_unit', ['sqft', 'sqm']], ['site_area_unit', ['sqft', 'acre', 'sqm']],
    ['consideration_field', ['close_price', 'current_price']], ['marketing_time_field', ['days_on_market', 'cumulative_days_on_market']]] as const)
    check(value[key] === null || (allowed as readonly unknown[]).includes(value[key]));
  check(typeof value.source_use_confirmed === 'boolean');
  return { source_name: name, provenance_note: value.provenance_note, currency: value.currency,
    living_area_unit: value.living_area_unit, site_area_unit: value.site_area_unit, consideration_field: value.consideration_field,
    marketing_time_field: value.marketing_time_field, source_use_confirmed: value.source_use_confirmed } as PrivateSalesSourceInterpretation;
}
function rowDecision(raw: unknown): PrivateSalesRowDecision {
  const value = closed(raw, ROW_KEYS); check(typeof value.receipt_id === 'string');
  const id = value.receipt_id.toLowerCase(); check(uuid(id) && integer(value.source_row_number, 2, 10001)
    && ['confirm_proposed_match', 'exclude', 'clear'].includes(value.decision as string) && text(value.note, 1000, true));
  const ids = array(value.account_ids, 5); check(ids.every(id => text(id, 128) && id.length > 0 && id.trim() === id) && new Set(ids).size === ids.length);
  check(value.decision === 'confirm_proposed_match' ? ids.length > 0 : ids.length === 0);
  return { receipt_id: id, source_row_number: value.source_row_number, decision: value.decision as PrivateSalesRowDecision['decision'],
    account_ids: [...ids as string[]].sort(), note: value.note };
}
export function preparePrivateSalesReviewCommand(raw: unknown): PrivateSalesReviewCommand {
  const value = closed(raw, ['review_version', 'expected_revision', 'source_interpretation', 'row_decisions']);
  check(value.review_version === 1 && integer(value.expected_revision, 0, 2147483646));
  const source = value.source_interpretation === null ? null : preparePrivateSalesSourceInterpretation(value.source_interpretation);
  const rows = array(value.row_decisions, 100).map(rowDecision);
  check(source !== null || rows.length > 0);
  check(new Set(rows.map(row => row.receipt_id)).size === rows.length && new Set(rows.map(row => row.source_row_number)).size === rows.length);
  const result = { review_version: 1 as const, expected_revision: value.expected_revision, source_interpretation: source, row_decisions: rows };
  // The server caps the original closed command before trimming its source name.
  const encoder = new TextEncoder();
  check(encoder.encode(JSON.stringify(raw)).byteLength <= 262144 && encoder.encode(JSON.stringify(result)).byteLength <= 262144); return result;
}
function scope(value: Record<string, unknown>, identity: PrivateSalesIdentity, receipt: PrivateSalesReceipt) {
  checkPrivateSalesIdentity(identity); checkPrivateSalesReceipt(receipt, identity, receipt.report_file_id);
  check(value.review_version === 1 && value.account_id === identity.accountId && value.assignment_file_id === String(identity.assignmentFileId)
    && value.report_file_id === receipt.report_file_id && value.batch_id === receipt.batch_id && value.source_sha256 === receipt.source_sha256
    && value.preparation_sha256 === receipt.preparation_sha256 && value.matching_status === 'reviewed_separately' && value.analysis_status === 'not_evaluated');
}
export function checkPrivateSalesReviewState(raw: unknown, identity: PrivateSalesIdentity, receipt: PrivateSalesReceipt,
  page: PrivateSalesReviewPage): PrivateSalesReviewState {
  const value = closed(raw, [...SCOPE_KEYS, 'revision', 'last_review_id', 'source_interpretation', 'source_review_id', 'row_decisions', 'next_after_row']);
  check(page && Array.isArray(page.rows) && page.rows.length <= 100);
  checkPrivateSalesRows(page, receipt, page.rows.length ? page.rows[0].source_row_number - 1 : receipt.row_count + 1, 100);
  scope(value, identity, receipt); check(page.batch_id === receipt.batch_id && value.next_after_row === page.next_after_row
    && integer(value.revision, 0, 2147483647) && (value.revision === 0 ? value.last_review_id === null : uuid(value.last_review_id)));
  if (value.source_interpretation === null) check(value.source_review_id === null);
  else check(value.revision > 0 && uuid(value.source_review_id) && sameFields(preparePrivateSalesSourceInterpretation(value.source_interpretation),
    value.source_interpretation as Record<string, unknown>, SOURCE_KEYS));
  const rows = array(value.row_decisions, 100), ids = new Set<string>(); let previous = 1;
  for (const rawRow of rows) {
    const row = closed(rawRow, [...ROW_KEYS, 'review_id', 'revision']);
    const { review_id, revision, ...body } = row, normalized = rowDecision(body);
    check(sameFields(normalized, body, ROW_KEYS) && uuid(review_id) && integer(revision, 1, value.revision)
      && normalized.source_row_number > previous && !ids.has(normalized.receipt_id)
      && page.rows.some(original => original.receipt_id === normalized.receipt_id && original.source_row_number === normalized.source_row_number));
    ids.add(normalized.receipt_id); previous = normalized.source_row_number;
  }
  check(value.revision > 0 || rows.length === 0); return value as unknown as PrivateSalesReviewState;
}
export function checkPrivateSalesReviewReceipt(raw: unknown, identity: PrivateSalesIdentity, receipt: PrivateSalesReceipt,
  operationId: string, submitted: PrivateSalesReviewCommand | null): PrivateSalesReviewReceipt {
  const value = closed(raw, [...SCOPE_KEYS, 'persisted', 'review_id', 'operation_id', 'revision', 'previous_revision', 'actor_user_id',
    'recorded_at', 'command_sha256', 'payload_sha256', 'command', 'replayed']);
  scope(value, identity, receipt); const command = preparePrivateSalesReviewCommand(value.command);
  check(uuid(operationId) && value.operation_id === operationId && value.persisted === true && uuid(value.review_id) && uuid(value.actor_user_id)
    && value.previous_revision === command.expected_revision && value.revision === command.expected_revision + 1 && typeof value.replayed === 'boolean'
    && typeof value.command_sha256 === 'string' && SHA.test(value.command_sha256) && typeof value.payload_sha256 === 'string' && SHA.test(value.payload_sha256)
    && typeof value.recorded_at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.recorded_at)
    && Number.isFinite(Date.parse(value.recorded_at)) && new Date(value.recorded_at).toISOString() === value.recorded_at
    && (submitted === null || same(command, preparePrivateSalesReviewCommand(submitted))));
  return value as unknown as PrivateSalesReviewReceipt;
}
export function preparePrivateSalesReviewForPage(raw: unknown, state: PrivateSalesReviewState, identity: PrivateSalesIdentity,
  receipt: PrivateSalesReceipt, page: PrivateSalesReviewPage, proposals: PrivateSalesMatchProposalPage | null): PrivateSalesReviewCommand {
  checkPrivateSalesReviewState(state, identity, receipt, page); const command = preparePrivateSalesReviewCommand(raw);
  check(command.expected_revision === state.revision);
  const confirmed = command.row_decisions.filter(row => row.decision === 'confirm_proposed_match');
  const checked = confirmed.length ? checkPrivateSalesMatchProposals(proposals, { identity, receipt, page }) : null;
  for (const decision of command.row_decisions) {
    check(page.rows.some(row => row.receipt_id === decision.receipt_id && row.source_row_number === decision.source_row_number));
    if (decision.decision === 'confirm_proposed_match') {
      const proposal = checked!.rows.find(row => row.receipt_id === decision.receipt_id);
      check(proposal?.proposal_status === 'proposed' && same([...proposal.proposed_account_ids].sort(), decision.account_ids));
    }
  }
  return command;
}

/** The host injects its existing bounded, authenticated JSON transport. It owns
 * serialization and retains operationId+command through uncertain writes. */
export function createPrivateSalesReviewClient(identityInput: PrivateSalesIdentity, options: {
  call: (path: string, init: RequestInit, io: PrivateSalesIo, missing?: boolean) => Promise<unknown>;
  expectedActorUserId?: string;
}) {
  const identity = checkPrivateSalesIdentity(identityInput);
  check(options.expectedActorUserId === undefined || uuid(options.expectedActorUserId));
  const actor = options.expectedActorUserId;
  const checkedReceipt = (result: unknown, receipt: PrivateSalesReceipt, operationId: string, command: PrivateSalesReviewCommand | null) => {
    const checked = checkPrivateSalesReviewReceipt(result, identity, receipt, operationId, command);
    check(actor === undefined || checked.actor_user_id === actor); return checked;
  };
  const path = (receipt: PrivateSalesReceipt, suffix = '', extra: Record<string, string> = {}) => {
    checkPrivateSalesReceipt(receipt, identity, receipt.report_file_id);
    return `/api/accounts/${encodeURIComponent(identity.accountId)}/assignment-files/${identity.assignmentFileId}/sales-imports/${receipt.batch_id}/reviews${suffix}?`
      + new URLSearchParams({ report_file_id: receipt.report_file_id, ...extra });
  };
  return {
    async get(receipt: PrivateSalesReceipt, page: PrivateSalesReviewPage, after: number, limit: number, io: PrivateSalesIo) {
      check(integer(after, 0, 10001) && integer(limit, 1, 100)); checkPrivateSalesRows(page, receipt, after, limit);
      io.signal.throwIfAborted();
      const expected = structuredClone({ receipt, page });
      const result = await options.call(path(receipt, '', { after_row: String(after), limit: String(limit) }), {}, io);
      io.signal.throwIfAborted(); return checkPrivateSalesReviewState(result, identity, expected.receipt, expected.page);
    },
    async save(receipt: PrivateSalesReceipt, operationId: string, submitted: PrivateSalesReviewCommand, io: PrivateSalesIo) {
      check(uuid(operationId)); const command = preparePrivateSalesReviewCommand(submitted), expected = { ...receipt };
      io.signal.throwIfAborted();
      const result = await options.call(path(receipt), { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': operationId }, body: JSON.stringify(command) }, io);
      io.signal.throwIfAborted(); return checkedReceipt(result, expected, operationId, command);
    },
    async checkOperation(receipt: PrivateSalesReceipt, operationId: string, submitted: PrivateSalesReviewCommand | null, io: PrivateSalesIo) {
      check(uuid(operationId)); const command = submitted === null ? null : preparePrivateSalesReviewCommand(submitted), expected = { ...receipt };
      io.signal.throwIfAborted();
      const result = await options.call(path(receipt, '/operations/' + operationId), {}, io, true);
      io.signal.throwIfAborted(); return result === null ? null : checkedReceipt(result, expected, operationId, command);
    },
  };
}
