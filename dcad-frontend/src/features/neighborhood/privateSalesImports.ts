export const PRIVATE_SALES_MAX_BYTES = 8 * 1024 * 1024;
const RESPONSE_BYTES = 8 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const dispositions = ['prepared', 'needs_review', 'duplicate', 'identity_conflict', 'rejected', 'empty'] as const;
const INPUT_REJECTIONS = new Set(['invalid_input', 'file_byte_limit', 'invalid_utf8', 'nul_byte', 'field_byte_limit',
  'malformed_csv', 'row_limit', 'column_limit', 'cell_limit', 'invalid_header', 'duplicate_header', 'missing_header',
  'unsupported_columns'].map(code => `assignment_sales_csv_${code}`));
for (const code of ['invalid_input', 'preparation_limit', 'unsupported_media_type', 'unsupported_encoding'])
  INPUT_REJECTIONS.add(`assignment_sales_import_${code}`);
export interface PrivateSalesIdentity { accountId: string; assignmentFileId: number; sessionKey: string }
export interface PrivateSalesTarget { account_id: string; assignment_file_id: string; report_file_id: string;
  workfile_status: 'draft' | 'signed' | 'archived'; can_upload: boolean }
export interface PrivateSalesFile { file_name: string; file_size: number; file_sha256: string }
export interface PrivateSalesPending extends PrivateSalesFile { pending_version: 1; account_id: string;
  assignment_file_id: string; session_key: string; report_file_id: string; operation_id: string }
export interface PrivateSalesReceipt { receipt_version: 1; persisted: true; persistence_status: 'saved'; batch_id: string;
  integrity_status: 'verified' | 'count_checked';
  operation_id: string; report_file_id: string; assignment_file_id: string; account_id: string; file_name: string;
  source_sha256: string; source_byte_length: number; preparation_sha256: string; preparation_profile: string;
  preparation_version: 1; stored_at: string; actor_user_id: string; row_count: number; summary: Record<string, number>;
  raw_headers: string[]; columns: string[]; matching_status: 'not_evaluated'; analysis_status: 'not_evaluated';
  source_interpretation_status: 'not_reviewed'; replayed?: boolean }
export interface PrivateSalesRow { source_row_number: number; source_line_number: number; byte_start: number; byte_end: number;
  raw_cells: string[]; record_sha256: string | null; preparation_disposition: string; issues: string[];
  values: Record<string, string | number | boolean | null> | null; group_id: string | null;
  duplicate_of_source_row_number: number | null; receipt_id: string; persisted: true;
  matching_status: 'not_evaluated'; analysis_status: 'not_evaluated' }
export class PrivateSalesError extends Error {
  readonly code: string; readonly status?: number;
  constructor(code: string, status?: number) { super(`private_sales_${code}`); this.code = code; this.status = status; }
}
const requireValue: (value: unknown, code?: string) => asserts value = (value, code = 'invalid_response') => {
  if (!value) throw new PrivateSalesError(code);
};
const object = (value: unknown): Record<string, unknown> => {
  requireValue(value && Object.getPrototypeOf(value) === Object.prototype); return value as Record<string, unknown>;
};
function exact(value: unknown, keys: string[], optional: string[] = []) {
  const result = object(value);
  requireValue(Object.keys(result).every(key => keys.includes(key) || optional.includes(key))
    && keys.every(key => Object.hasOwn(result, key))); return result;
}
const integer = (value: unknown, low: number, high: number) => Number.isSafeInteger(value) && (value as number) >= low && (value as number) <= high;
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max
  && Array.from(value).every(character => character.length === 2 || character.charCodeAt(0) < 0xd800 || character.charCodeAt(0) > 0xdfff);
const uuid = (value: unknown) => typeof value === 'string' && UUID.test(value);
const sha = (value: unknown) => typeof value === 'string' && SHA.test(value);
const strings = (value: unknown, count: number, length = 16384): value is string[] =>
  Array.isArray(value) && value.length <= count && value.every(item => text(item, length));
const noControls = (value: string, c1 = false) => Array.from(value).every(character => {
  const code = character.charCodeAt(0); return code >= 32 && code !== 127 && (!c1 || code < 128 || code > 159);
});
function file(value: PrivateSalesFile) {
  requireValue(text(value.file_name, 255) && value.file_name.trim() && noControls(value.file_name, true) && !/[\\/]/.test(value.file_name)
    && integer(value.file_size, 1, PRIVATE_SALES_MAX_BYTES) && sha(value.file_sha256), 'invalid_file');
}
export function checkPrivateSalesIdentity(value: PrivateSalesIdentity): PrivateSalesIdentity {
  requireValue(text(value.accountId, 128) && value.accountId.trim() === value.accountId && value.accountId.length > 0
    && noControls(value.accountId) && integer(value.assignmentFileId, 1, Number.MAX_SAFE_INTEGER)
    && text(value.sessionKey, 200) && value.sessionKey.trim() === value.sessionKey && value.sessionKey.length > 0
    && noControls(value.sessionKey), 'invalid_target');
  return Object.freeze({ accountId: value.accountId, assignmentFileId: value.assignmentFileId, sessionKey: value.sessionKey });
}
export function checkPrivateSalesTarget(raw: unknown, identity: PrivateSalesIdentity): PrivateSalesTarget {
  const value = exact(raw, ['account_id', 'assignment_file_id', 'report_file_id', 'workfile_status', 'can_upload']);
  requireValue(value.account_id === identity.accountId && value.assignment_file_id === String(identity.assignmentFileId)
    && uuid(value.report_file_id) && ['draft', 'signed', 'archived'].includes(value.workfile_status as string)
    && typeof value.can_upload === 'boolean' && (!value.can_upload || value.workfile_status === 'draft'));
  return Object.freeze(value) as unknown as PrivateSalesTarget;
}
export function checkPrivateSalesReceipt(raw: unknown, identity: PrivateSalesIdentity, reportId: string,
  pending?: PrivateSalesPending): PrivateSalesReceipt {
  const value = exact(raw, ['receipt_version', 'persisted', 'persistence_status', 'integrity_status', 'batch_id', 'operation_id', 'report_file_id',
    'assignment_file_id', 'account_id', 'file_name', 'source_sha256', 'source_byte_length', 'preparation_sha256',
    'preparation_profile', 'preparation_version', 'stored_at', 'actor_user_id', 'row_count', 'summary', 'raw_headers', 'columns',
    'matching_status', 'analysis_status', 'source_interpretation_status'], ['replayed']);
  requireValue(value.receipt_version === 1 && value.persisted === true && value.persistence_status === 'saved'
    && ['verified', 'count_checked'].includes(value.integrity_status as string)
    && value.account_id === identity.accountId && value.assignment_file_id === String(identity.assignmentFileId)
    && value.report_file_id === reportId && uuid(reportId) && uuid(value.batch_id) && uuid(value.operation_id) && uuid(value.actor_user_id)
    && sha(value.source_sha256) && sha(value.preparation_sha256) && integer(value.source_byte_length, 1, PRIVATE_SALES_MAX_BYTES)
    && value.preparation_profile === 'private_sales_csv_preparation_v1' && value.preparation_version === 1
    && integer(value.row_count, 0, 10000) && strings(value.raw_headers, 128) && strings(value.columns, 128)
    && value.raw_headers.length > 0 && value.raw_headers.length === value.columns.length
    && value.matching_status === 'not_evaluated' && value.analysis_status === 'not_evaluated'
    && value.source_interpretation_status === 'not_reviewed' && (!Object.hasOwn(value, 'replayed') || typeof value.replayed === 'boolean')
    && typeof value.stored_at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.stored_at)
    && Number.isFinite(Date.parse(value.stored_at)) && new Date(value.stored_at).toISOString() === value.stored_at);
  file({ file_name: value.file_name as string, file_size: value.source_byte_length as number, file_sha256: value.source_sha256 as string });
  const summary = exact(value.summary, [...dispositions]);
  requireValue(Object.values(summary).every(count => integer(count, 0, 10000))
    && Object.values(summary).reduce<number>((sum, count) => sum + (count as number), 0) === value.row_count);
  if (pending) requireValue(value.integrity_status === 'verified' && pending.report_file_id === reportId && pending.operation_id === value.operation_id
    && pending.file_name === value.file_name && pending.file_sha256 === value.source_sha256 && pending.file_size === value.source_byte_length);
  return value as unknown as PrivateSalesReceipt;
}
function checkedRow(raw: unknown): PrivateSalesRow {
  const row = exact(raw, ['source_row_number', 'source_line_number', 'byte_start', 'byte_end', 'raw_cells', 'record_sha256',
    'preparation_disposition', 'issues', 'values', 'group_id', 'duplicate_of_source_row_number', 'receipt_id', 'persisted',
    'matching_status', 'analysis_status']);
  requireValue(integer(row.source_row_number, 2, 10001) && integer(row.source_line_number, 2, 8 * 1024 * 1024)
    && integer(row.byte_start, 0, PRIVATE_SALES_MAX_BYTES) && integer(row.byte_end, row.byte_start as number, PRIVATE_SALES_MAX_BYTES)
    && strings(row.raw_cells, 128) && strings(row.issues, 128, 128) && uuid(row.receipt_id)
    && dispositions.includes(row.preparation_disposition as typeof dispositions[number]) && row.persisted === true
    && row.matching_status === 'not_evaluated' && row.analysis_status === 'not_evaluated'
    && (row.record_sha256 === null || sha(row.record_sha256))
    && (row.group_id === null || (typeof row.group_id === 'string' && /^rows:[1-9]\d{0,4}$/.test(row.group_id)))
    && (row.duplicate_of_source_row_number === null || integer(row.duplicate_of_source_row_number, 2, (row.source_row_number as number) - 1)));
  if (row.values !== null) {
    const values = object(row.values);
    requireValue(Object.keys(values).length <= 128 && Object.keys(values).every(key => /^[a-z][a-z0-9_]{0,127}$/.test(key))
      && Object.values(values).every(value => value === null || typeof value === 'boolean' || text(value, 16384)
        || (typeof value === 'number' && Number.isFinite(value))));
  }
  return row as unknown as PrivateSalesRow;
}
export function checkPrivateSalesRows(raw: unknown, receipt: PrivateSalesReceipt, afterRow: number, limit: number) {
  const value = exact(raw, ['batch_id', 'rows', 'next_after_row']);
  requireValue(value.batch_id === receipt.batch_id && Array.isArray(value.rows) && value.rows.length <= limit);
  const rows = value.rows.map(checkedRow), first = Math.max(2, afterRow + 1);
  requireValue(rows.every((row, index) => row.source_row_number === first + index && row.source_row_number <= receipt.row_count + 1
    && row.byte_end <= receipt.source_byte_length) && new Set(rows.map(row => row.receipt_id)).size === rows.length);
  const last = rows.at(-1)?.source_row_number ?? Math.max(1, afterRow), remaining = last < receipt.row_count + 1;
  requireValue(remaining ? rows.length > 0 && value.next_after_row === last : value.next_after_row === null);
  return { batch_id: receipt.batch_id, rows, next_after_row: value.next_after_row as number | null };
}
export function privateSalesPendingKey(identity: PrivateSalesIdentity) {
  const target = checkPrivateSalesIdentity(identity);
  return 'private-sales-pending:v1:' + encodeURIComponent(JSON.stringify([target.accountId, target.assignmentFileId, target.sessionKey]));
}
export function checkPrivateSalesPending(raw: unknown, identity: PrivateSalesIdentity): PrivateSalesPending {
  const value = exact(raw, ['pending_version', 'account_id', 'assignment_file_id', 'session_key', 'report_file_id',
    'operation_id', 'file_name', 'file_size', 'file_sha256']);
  requireValue(value.pending_version === 1 && value.account_id === identity.accountId
    && value.assignment_file_id === String(identity.assignmentFileId) && value.session_key === identity.sessionKey
    && uuid(value.report_file_id) && uuid(value.operation_id), 'invalid_pending');
  file(value as unknown as PrivateSalesFile); return Object.freeze(value) as unknown as PrivateSalesPending;
}
export function makePrivateSalesPending(identity: PrivateSalesIdentity, reportId: string, value: PrivateSalesFile, operationId: string) {
  return checkPrivateSalesPending({ pending_version: 1, account_id: identity.accountId, assignment_file_id: String(identity.assignmentFileId),
    session_key: identity.sessionKey, report_file_id: reportId, operation_id: operationId, ...value }, identity);
}
export function readPrivateSalesPending(storage: Pick<Storage, 'getItem'>, identity: PrivateSalesIdentity):
  { status: 'absent' } | { status: 'restored'; pending: PrivateSalesPending } | { status: 'invalid' } {
  try {
    const raw = storage.getItem(privateSalesPendingKey(identity));
    if (raw === null) return { status: 'absent' };
    requireValue(raw.length <= 4096); return { status: 'restored', pending: checkPrivateSalesPending(JSON.parse(raw), identity) };
  } catch { return { status: 'invalid' }; }
}
export function savePrivateSalesPending(storage: Pick<Storage, 'setItem' | 'getItem'>, identity: PrivateSalesIdentity, pending: PrivateSalesPending) {
  const value = JSON.stringify(checkPrivateSalesPending(pending, identity)), key = privateSalesPendingKey(identity);
  try { storage.setItem(key, value); requireValue(storage.getItem(key) === value); }
  catch { throw new PrivateSalesError('pending_storage_unavailable'); }
}
export function clearPrivateSalesPending(storage: Pick<Storage, 'removeItem' | 'getItem'>, identity: PrivateSalesIdentity) {
  try { const key = privateSalesPendingKey(identity); storage.removeItem(key); requireValue(storage.getItem(key) === null); }
  catch { throw new PrivateSalesError('pending_storage_unavailable'); }
}
export async function privateSalesFileDigest(bytes: Uint8Array): Promise<string> {
  requireValue(bytes instanceof Uint8Array && integer(bytes.byteLength, 1, PRIVATE_SALES_MAX_BYTES), 'invalid_file');
  const result = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(result), value => value.toString(16).padStart(2, '0')).join('');
}
export interface PrivateSalesIo { signal: AbortSignal; deadlineMs?: number }
export function createPrivateSalesImportsClient(identityInput: PrivateSalesIdentity, options: {
  request: (url: string, init: RequestInit) => Promise<Response>; urlFor: (path: string) => string;
}) {
  const identity = checkPrivateSalesIdentity(identityInput);
  const base = `/api/accounts/${encodeURIComponent(identity.accountId)}/assignment-files/${identity.assignmentFileId}/sales-imports`;
  async function call(path: string, init: RequestInit, io: PrivateSalesIo, missing = false): Promise<unknown> {
    const timeout = io.deadlineMs ?? 30000;
    requireValue(integer(timeout, 1, 60000), 'invalid_deadline');
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const controller = new AbortController(), abort = () => {
      controller.abort(); void activeReader?.cancel().catch(() => undefined);
    };
    io.signal.addEventListener('abort', abort, { once: true });
    if (io.signal.aborted) controller.abort();
    const timer = setTimeout(abort, timeout);
    let stop: (() => void) | undefined;
    try {
      return await Promise.race([new Promise<never>((_, reject) => {
        stop = () => reject(new PrivateSalesError('request_interrupted'));
        controller.signal.addEventListener('abort', stop, { once: true });
        if (controller.signal.aborted) stop();
      }), (async () => {
        if (controller.signal.aborted) throw new PrivateSalesError('request_interrupted');
        const response = await options.request(options.urlFor(path), { ...init, signal: controller.signal, cache: 'no-store' });
        const cancelBody = () => { void response.body?.cancel().catch(() => undefined); };
        if (controller.signal.aborted) { cancelBody(); throw new PrivateSalesError('request_interrupted'); }
        if (missing && response.status === 404) { cancelBody(); return null; }
        const isJson = response.headers.get('content-type')?.toLowerCase().includes('application/json');
        async function readJson(maximumBytes: number): Promise<unknown> {
          const reader = response.body?.getReader(); requireValue(reader); activeReader = reader;
          const chunks: Uint8Array[] = []; let bytes = 0;
          try {
            while (true) {
              if (controller.signal.aborted) throw new PrivateSalesError('request_interrupted');
              const part = await reader.read(); if (part.done) break;
              bytes += part.value.byteLength;
              if (bytes > maximumBytes) { await reader.cancel(); throw new PrivateSalesError('response_limit'); }
              chunks.push(part.value);
            }
          } finally { activeReader = null; reader.releaseLock(); }
          const body = new Uint8Array(bytes); let offset = 0;
          for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
          if (controller.signal.aborted) throw new PrivateSalesError('request_interrupted');
          return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
        }
        if (!response.ok) {
          if (isJson && [400, 413, 415].includes(response.status)) {
            let errorBody: unknown;
            try { errorBody = await readJson(1024); } catch { /* Unknown or oversized error is never a definitive rejection. */ }
            if (errorBody && typeof errorBody === 'object' && 'error' in errorBody
              && typeof errorBody.error === 'string' && INPUT_REJECTIONS.has(errorBody.error)) {
              throw new PrivateSalesError('input_rejected', response.status);
            }
          } else cancelBody();
          throw new PrivateSalesError('request_failed', response.status);
        }
        if (!isJson) { cancelBody(); throw new PrivateSalesError('invalid_response'); }
        return readJson(RESPONSE_BYTES);
      })()]);
    } catch (error) { if (error instanceof PrivateSalesError) throw error; throw new PrivateSalesError('request_failed'); }
    finally { clearTimeout(timer); io.signal.removeEventListener('abort', abort); if (stop) controller.signal.removeEventListener('abort', stop); }
  }
  const scoped = (reportId: string, suffix = '', query: Record<string, string> = {}) => {
    requireValue(uuid(reportId), 'invalid_target');
    return base + suffix + '?' + new URLSearchParams({ report_file_id: reportId, ...query }).toString();
  };
  return {
    async target(io: PrivateSalesIo) { return checkPrivateSalesTarget(await call(base + '/target', {}, io), identity); },
    async list(reportId: string, before: string | null, io: PrivateSalesIo) {
      requireValue(before === null || uuid(before), 'invalid_cursor');
      const value = exact(await call(scoped(reportId, '', before ? { before_batch_id: before } : {}), {}, io), ['imports', 'next_before_batch_id']);
      requireValue(Array.isArray(value.imports) && value.imports.length <= 20);
      const imports = value.imports.map(raw => checkPrivateSalesReceipt(raw, identity, reportId));
      requireValue(new Set(imports.map(item => item.batch_id)).size === imports.length
        && imports.every((item, index) => item.integrity_status === 'count_checked' && item.batch_id !== before
          && (index === 0 || item.stored_at <= imports[index - 1].stored_at))
        && (value.next_before_batch_id === null || (imports.length > 0 && value.next_before_batch_id === imports.at(-1)?.batch_id)));
      return { imports, next_before_batch_id: value.next_before_batch_id as string | null };
    },
    async check(pending: PrivateSalesPending, io: PrivateSalesIo) {
      checkPrivateSalesPending(pending, identity);
      const value = await call(scoped(pending.report_file_id, '/operations/' + pending.operation_id), {}, io, true);
      return value === null ? null : checkPrivateSalesReceipt(value, identity, pending.report_file_id, pending);
    },
    async commit(pending: PrivateSalesPending, bytes: Uint8Array, io: PrivateSalesIo) {
      checkPrivateSalesPending(pending, identity);
      const copy = new Uint8Array(bytes);
      requireValue(copy.byteLength === pending.file_size && await privateSalesFileDigest(copy) === pending.file_sha256, 'wrong_file');
      const value = await call(scoped(pending.report_file_id), { method: 'POST',
        headers: { 'content-type': 'text/csv', 'Idempotency-Key': pending.operation_id, 'X-Document-File-Name': encodeURIComponent(pending.file_name) },
        body: new Blob([copy.buffer], { type: 'text/csv' }) }, io);
      return checkPrivateSalesReceipt(value, identity, pending.report_file_id, pending);
    },
    async rows(receipt: PrivateSalesReceipt, afterRow: number, limit: number, io: PrivateSalesIo) {
      checkPrivateSalesReceipt(receipt, identity, receipt.report_file_id);
      requireValue(integer(afterRow, 0, 10001) && integer(limit, 1, 100), 'invalid_cursor');
      return checkPrivateSalesRows(await call(scoped(receipt.report_file_id, '/' + receipt.batch_id + '/rows',
        { after_row: String(afterRow), limit: String(limit) }), {}, io), receipt, afterRow, limit);
    },
  };
}
