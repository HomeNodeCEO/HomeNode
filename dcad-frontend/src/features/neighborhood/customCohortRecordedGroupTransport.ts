import { createCustomCohortJsonTransport } from './customCohortPreviewTransport.ts';
import type { CustomCohortContextRef } from './customCohortPreviewController';

export interface CustomCohortGroupSelectionRef {
  readonly selection_version: 1; readonly selection_revision: number; readonly selection_sha256: string;
  readonly manifest_ref: { readonly content_sha256: string; readonly canonical_utf8_bytes: string };
}
export interface CustomCohortRecordedGroupRead {
  readonly accountId: string; readonly assignmentFileId: string; readonly contextRef: CustomCohortContextRef;
}
export interface CustomCohortRecordedGroupWrite extends CustomCohortRecordedGroupRead {
  readonly operationId: string; readonly expectedSelectionRef: CustomCohortGroupSelectionRef | null;
  readonly includedRecordedGroupIds: readonly string[];
}
export type CustomCohortRecordedGroupReceipt = {
  readonly status: 'stored' | 'reused' | 'selected'; readonly authority: 'not_established';
  readonly context_ref: CustomCohortContextRef; readonly selection_ref: CustomCohortGroupSelectionRef;
  readonly included_recorded_group_ids: readonly string[]; readonly operation_id?: string;
} | {
  readonly status: 'absent'; readonly authority: 'not_established'; readonly context_ref: CustomCohortContextRef;
  readonly selection_ref: null; readonly included_recorded_group_ids: null;
};
type RecordValue = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const GROUP = /^recorded-cad:[a-f0-9]{64}$/;
function fail(): never { throw new TypeError('invalid_custom_cohort_recorded_group_transport'); }
function closed(value: unknown, keys: readonly string[]): RecordValue {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length) fail();
  const result: RecordValue = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) fail();
    result[key] = d.value;
  }
  return result;
}
function context(value: unknown): CustomCohortContextRef {
  const v = closed(value, ['context_id', 'context_revision', 'context_sha256']);
  if (typeof v.context_id !== 'string' || !UUID.test(v.context_id) || v.context_revision !== '1'
    || typeof v.context_sha256 !== 'string' || !HASH.test(v.context_sha256)) fail();
  return Object.freeze({ context_id: v.context_id, context_revision: '1', context_sha256: v.context_sha256 });
}
function selection(value: unknown): CustomCohortGroupSelectionRef {
  const v = closed(value, ['selection_version', 'selection_revision', 'selection_sha256', 'manifest_ref']);
  const m = closed(v.manifest_ref, ['content_sha256', 'canonical_utf8_bytes']);
  if (v.selection_version !== 1 || typeof v.selection_revision !== 'number' || !Number.isInteger(v.selection_revision)
    || v.selection_revision < 1 || v.selection_revision > 2147483647
    || typeof v.selection_sha256 !== 'string' || !HASH.test(v.selection_sha256)
    || typeof m.content_sha256 !== 'string' || !HASH.test(m.content_sha256)
    || typeof m.canonical_utf8_bytes !== 'string' || !/^[1-9]\d{0,5}$/.test(m.canonical_utf8_bytes)
    || Number(m.canonical_utf8_bytes) > 750_000) fail();
  return Object.freeze({ selection_version: 1, selection_revision: v.selection_revision, selection_sha256: v.selection_sha256,
    manifest_ref: Object.freeze({ content_sha256: m.content_sha256, canonical_utf8_bytes: m.canonical_utf8_bytes }) });
}
function groups(value: unknown): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 2049
    || Reflect.ownKeys(value).length !== value.length + 1) fail();
  const ids: string[] = [], seen = new Set<string>(); let recorded = 0;
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i)), id: unknown = d?.value;
    if (!d?.enumerable || !Object.hasOwn(d, 'value') || typeof id !== 'string'
      || (id !== 'discovery:unassigned' && !GROUP.test(id)) || seen.has(id)) fail();
    if (id !== 'discovery:unassigned' && ++recorded > 2048) fail();
    seen.add(id); ids.push(id);
  }
  return Object.freeze(ids.sort());
}
function input(value: unknown, writing: boolean): CustomCohortRecordedGroupRead | CustomCohortRecordedGroupWrite {
  const v = closed(value, ['accountId', 'assignmentFileId', 'contextRef', ...(writing
    ? ['operationId', 'expectedSelectionRef', 'includedRecordedGroupIds'] : [])]);
  if (typeof v.accountId !== 'string' || !v.accountId || v.accountId.length > 64 || v.accountId.trim() !== v.accountId
    || /[\u0000-\u001f\u007f]/.test(v.accountId) || typeof v.assignmentFileId !== 'string'
    || !/^[1-9]\d{0,18}$/.test(v.assignmentFileId) || BigInt(v.assignmentFileId) > 9223372036854775807n) fail();
  const base = { accountId: v.accountId, assignmentFileId: v.assignmentFileId, contextRef: context(v.contextRef) };
  if (!writing) return Object.freeze(base);
  if (typeof v.operationId !== 'string' || !UUID.test(v.operationId)) fail();
  const expectedSelectionRef = v.expectedSelectionRef === null ? null : selection(v.expectedSelectionRef);
  if (expectedSelectionRef?.selection_revision === 2147483647) fail();
  return Object.freeze({ ...base, operationId: v.operationId, expectedSelectionRef,
    includedRecordedGroupIds: groups(v.includedRecordedGroupIds) });
}
function receipt(value: unknown, request: CustomCohortRecordedGroupRead | CustomCohortRecordedGroupWrite,
  writing: boolean): CustomCohortRecordedGroupReceipt {
  const v = closed(value, ['status', 'authority', 'context_ref', 'selection_ref', 'included_recorded_group_ids',
    ...(writing ? ['operation_id'] : [])]);
  const c = context(v.context_ref);
  if (v.authority !== 'not_established' || JSON.stringify(c) !== JSON.stringify(request.contextRef)) fail();
  if (!writing && v.status === 'absent') {
    if (v.selection_ref !== null || v.included_recorded_group_ids !== null) fail();
    return Object.freeze({ status: 'absent', authority: 'not_established', context_ref: c,
      selection_ref: null, included_recorded_group_ids: null });
  }
  const r = selection(v.selection_ref), ids = groups(v.included_recorded_group_ids);
  if (JSON.stringify(ids) !== JSON.stringify(v.included_recorded_group_ids)) fail();
  if (writing) {
    const w = request as CustomCohortRecordedGroupWrite;
    if ((v.status !== 'stored' && v.status !== 'reused') || v.operation_id !== w.operationId
      || r.selection_revision !== (w.expectedSelectionRef?.selection_revision ?? 0) + 1
      || JSON.stringify(ids) !== JSON.stringify(w.includedRecordedGroupIds)) fail();
  } else if (v.status !== 'selected') fail();
  return Object.freeze({ status: v.status as 'stored' | 'reused' | 'selected', authority: 'not_established',
    context_ref: c, selection_ref: r, included_recorded_group_ids: ids,
    ...(writing ? { operation_id: (request as CustomCohortRecordedGroupWrite).operationId } : {}) });
}

/** One authenticated, bounded request. No independent timer, automatic retry,
 * implicit all-groups selection, source facts or reviewer identity in its body.
 * The caller owns a finite signal and any explicit lost-acknowledgment recovery.
 * This is intent transport only, not preview statistics, workspace save or Apply.
 */
export function createCustomCohortRecordedGroupTransport(options: Parameters<typeof createCustomCohortJsonTransport>[0]) {
  const post = createCustomCohortJsonTransport(options);
  return Object.freeze({
    async read(value: CustomCohortRecordedGroupRead, io: { signal: AbortSignal }) {
      const r = input(value, false);
      return receipt(await post(r.accountId, 'group-selection', { assignment_file_id: r.assignmentFileId,
        context_ref: r.contextRef }, io), r, false);
    },
    async select(value: CustomCohortRecordedGroupWrite, io: { signal: AbortSignal }) {
      const r = input(value, true) as CustomCohortRecordedGroupWrite;
      return receipt(await post(r.accountId, 'select-groups', { assignment_file_id: r.assignmentFileId,
        context_ref: r.contextRef, operation_id: r.operationId, expected_selection_ref: r.expectedSelectionRef,
        included_recorded_group_ids: r.includedRecordedGroupIds }, io), r, true);
    },
  });
}
