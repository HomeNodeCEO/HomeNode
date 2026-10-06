import { createCustomCohortJsonTransport } from './customCohortPreviewTransport.ts';
import { checkCustomCohortBoundSummaryResponse } from './customCohortPreviewController.ts';
import type { CustomCohortContextRef } from './customCohortPreviewController';
import { checkCustomCohortBoundViewportResponse } from './customCohortViewportClient.ts';
import type { CustomCohortViewportBounds } from './customCohortViewportClient';
import type { CheckedPocketCatalog } from './customCohortPocketCatalog';
import { checkCustomCohortBoundMemberPage } from './customCohortMemberPage.ts';
import type { CustomCohortMemberExpectation, CustomCohortMemberPageRequest, CustomCohortMemberPopulation,
  CheckedCustomCohortMemberPage, CustomCohortMemberContinuation } from './customCohortMemberPage';

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
export interface CustomCohortRecordedGroupSummary extends CustomCohortRecordedGroupRead {
  readonly selectionRef: CustomCohortGroupSelectionRef;
}
export interface CustomCohortRecordedGroupViewport extends CustomCohortRecordedGroupSummary {
  readonly viewport: CustomCohortViewportBounds;
}
export interface CustomCohortRecordedGroupMembers extends CustomCohortRecordedGroupSummary {
  readonly population: Exclude<CustomCohortMemberPopulation, { readonly group: 'pocket' }>;
  readonly page: CustomCohortMemberPageRequest;
}
export interface CustomCohortRecordedGroupMemberContinuation {
  readonly selection_ref: CustomCohortGroupSelectionRef;
  readonly members: CheckedCustomCohortMemberPage | CustomCohortMemberContinuation;
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
function input(value: unknown, writing: boolean, summary = false): CustomCohortRecordedGroupRead | CustomCohortRecordedGroupWrite | CustomCohortRecordedGroupSummary {
  const v = closed(value, ['accountId', 'assignmentFileId', 'contextRef', ...(summary ? ['selectionRef'] : writing
    ? ['operationId', 'expectedSelectionRef', 'includedRecordedGroupIds'] : [])]);
  if (typeof v.accountId !== 'string' || !v.accountId || v.accountId.length > 64 || v.accountId.trim() !== v.accountId
    || typeof v.assignmentFileId !== 'string'
    || !/^[1-9]\d{0,18}$/.test(v.assignmentFileId) || BigInt(v.assignmentFileId) > 9223372036854775807n) fail();
  for (let i = 0; i < v.accountId.length; i++) {
    const code = v.accountId.charCodeAt(i); if (code < 32 || code === 127) fail();
  }
  const base = { accountId: v.accountId, assignmentFileId: v.assignmentFileId, contextRef: context(v.contextRef) };
  if (summary) return Object.freeze({ ...base, selectionRef: selection(v.selectionRef) });
  if (!writing) return Object.freeze(base);
  if (typeof v.operationId !== 'string' || !UUID.test(v.operationId)) fail();
  const expectedSelectionRef = v.expectedSelectionRef === null ? null : selection(v.expectedSelectionRef);
  if (expectedSelectionRef?.selection_revision === 2147483647) fail();
  return Object.freeze({ ...base, operationId: v.operationId, expectedSelectionRef,
    includedRecordedGroupIds: groups(v.includedRecordedGroupIds) });
}
function checkedSummary(value: unknown, request: CustomCohortRecordedGroupSummary) {
  const hasPrivate = value !== null && typeof value === 'object' && Object.hasOwn(value, 'private_sales');
  const v = closed(value, ['status', 'authority', 'target', 'context_ref', 'selection_ref', 'selection_revision',
    'subject_freshness', 'summary', 'parcel_map', 'apply', ...(hasPrivate ? ['private_sales'] : [])]);
  const r = selection(v.selection_ref), map = closed(v.parcel_map, ['status', 'reason']);
  const apply = closed(v.apply, ['status', 'reasons']);
  if (v.authority !== 'not_established' || JSON.stringify(r) !== JSON.stringify(request.selectionRef)
    || map.status !== 'omitted' || map.reason !== 'geometry_not_requested' || apply.status !== 'blocked'
    || !Array.isArray(apply.reasons) || JSON.stringify(apply.reasons) !== '["observation_preview_only"]') fail();
  const accepted = checkCustomCohortBoundSummaryResponse({ status: v.status, target: v.target, context_ref: v.context_ref,
    selection_revision: v.selection_revision, subject_freshness: v.subject_freshness, summary: v.summary,
    parcel_map: v.parcel_map, apply: v.apply, ...(hasPrivate ? { private_sales: v.private_sales } : {}) }, {
    accountId: request.accountId, assignmentFileId: request.assignmentFileId, contextRef: request.contextRef,
    selectionRevision: r.selection_revision, selectionFingerprint: r.selection_sha256,
  });
  return Object.freeze({ ...accepted, selection_ref: r });
}
function viewportBounds(value: unknown): CustomCohortViewportBounds {
  const v = closed(value, ['west', 'south', 'east', 'north']);
  const { west, south, east, north } = v;
  if (typeof west !== 'number' || typeof south !== 'number' || typeof east !== 'number' || typeof north !== 'number'
    || ![west, south, east, north].every(Number.isFinite) || west < -180 || east > 180 || south < -90 || north > 90
    || east <= west || north <= south || east - west > 1 || north - south > 1) fail();
  return Object.freeze({ west, south, east, north });
}
function viewportInput(value: CustomCohortRecordedGroupViewport) {
  const v = closed(value, ['accountId', 'assignmentFileId', 'contextRef', 'selectionRef', 'viewport']);
  const request = input({ accountId: v.accountId, assignmentFileId: v.assignmentFileId,
    contextRef: v.contextRef, selectionRef: v.selectionRef }, false, true) as CustomCohortRecordedGroupSummary;
  return Object.freeze({ ...request, viewport: viewportBounds(v.viewport) });
}
function membersInput(value: CustomCohortRecordedGroupMembers) {
  const v = closed(value, ['accountId', 'assignmentFileId', 'contextRef', 'selectionRef', 'population', 'page']);
  const request = input({ accountId: v.accountId, assignmentFileId: v.assignmentFileId,
    contextRef: v.contextRef, selectionRef: v.selectionRef }, false, true) as CustomCohortRecordedGroupSummary;
  const p = closed(v.population, ['group', 'kind']), page = closed(v.page, ['limit', 'after_member_id']);
  if (!['all', 'selected'].includes(String(p.group))
    || !['stock', 'transactions', 'omitted_transactions', 'source_reported'].includes(String(p.kind))
    || typeof page.limit !== 'number' || !Number.isInteger(page.limit) || page.limit < 1 || page.limit > 50
    || (page.after_member_id !== null && (typeof page.after_member_id !== 'string'
      || !/^member:[a-f0-9]{64}$/.test(page.after_member_id)))) fail();
  return Object.freeze({ ...request, population: Object.freeze(p) as unknown as CustomCohortRecordedGroupMembers['population'],
    page: Object.freeze(page) as unknown as CustomCohortMemberPageRequest });
}
function viewportPopulation(request: CustomCohortRecordedGroupSummary, saved: CustomCohortRecordedGroupReceipt,
  catalog: CheckedPocketCatalog) {
  const writing = Object.hasOwn(saved, 'operation_id');
  const v = closed(saved, ['status', 'authority', 'context_ref', 'selection_ref', 'included_recorded_group_ids',
    ...(writing ? ['operation_id'] : [])]);
  if (writing && (!['stored', 'reused'].includes(String(v.status))
    || typeof v.operation_id !== 'string' || !UUID.test(v.operation_id))) fail();
  // The previously accepted write receipt carries the same exact reference/IDs
  // as a read receipt. This is not a new save or predecessor validation.
  const current = receipt({ status: writing ? 'selected' : v.status, authority: v.authority,
    context_ref: v.context_ref, selection_ref: v.selection_ref,
    included_recorded_group_ids: v.included_recorded_group_ids }, request, false);
  if (current.status === 'absent' || JSON.stringify(current.selection_ref) !== JSON.stringify(request.selectionRef)
    || JSON.stringify(catalog.binding.context_ref) !== JSON.stringify(request.contextRef)) fail();
  const choices = new Set(current.included_recorded_group_ids), members = new Set<string>(), selected = new Set<string>();
  for (const group of [...catalog.pockets, { id: 'discovery:unassigned', account_ids: catalog.unassigned.account_ids }]) {
    for (const account of group.account_ids) { members.add(account); if (choices.has(group.id)) selected.add(account); }
    choices.delete(group.id);
  }
  if (choices.size) fail();
  return { members, selected };
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
 * Numeric preview returns only an exact-bound public summary. The separately
 * bounded viewport contains captured display geometry, never raw source rows.
 * The workspace UI, map publication and Apply are not activated here.
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
    async preview(value: CustomCohortRecordedGroupSummary, io: { signal: AbortSignal }) {
      const r = input(value, false, true) as CustomCohortRecordedGroupSummary;
      return checkedSummary(await post(r.accountId, 'selection-preview', { assignment_file_id: r.assignmentFileId,
        context_ref: r.contextRef, selection_ref: r.selectionRef }, io), r);
    },
    async viewport(value: CustomCohortRecordedGroupViewport, saved: CustomCohortRecordedGroupReceipt,
      catalog: CheckedPocketCatalog, capturedParcels: number | null, io: { signal: AbortSignal }) {
      const r = viewportInput(value), population = viewportPopulation(r, saved, catalog);
      const v = closed(await post(r.accountId, 'selection-viewport', { assignment_file_id: r.assignmentFileId,
        context_ref: r.contextRef, selection_ref: r.selectionRef, viewport: r.viewport }, io),
      ['status', 'authority', 'selection_ref', 'viewport_map']);
      const ref = selection(v.selection_ref);
      if (v.status !== 'viewport' || v.authority !== 'not_established' || JSON.stringify(ref) !== JSON.stringify(r.selectionRef)) fail();
      return Object.freeze({ selection_ref: ref, map: checkCustomCohortBoundViewportResponse(v.viewport_map, {
        accountId: r.accountId, assignmentFileId: r.assignmentFileId, contextRef: r.contextRef,
        selectionRevision: ref.selection_revision, selectionFingerprint: ref.selection_sha256,
      }, capturedParcels, population, r.viewport) });
    },
    async members(value: CustomCohortRecordedGroupMembers, saved: CustomCohortRecordedGroupReceipt,
      catalog: CheckedPocketCatalog, expected: CustomCohortMemberExpectation, io: { signal: AbortSignal },
      previous?: CustomCohortRecordedGroupMemberContinuation) {
      const r = membersInput(value), population = viewportPopulation(r, saved, catalog);
      const e = closed(expected, ['group', 'kind', 'total_count']);
      if (e.group !== r.population.group || e.kind !== r.population.kind || typeof e.total_count !== 'number'
        || !Number.isSafeInteger(e.total_count) || e.total_count < 0 || e.total_count > 100000) fail();
      const expectation = Object.freeze(e) as unknown as CustomCohortMemberExpectation;
      const accounts = r.population.group === 'all' ? population.members : population.selected;
      if (r.population.kind === 'stock' && accounts.size !== e.total_count) fail();
      if ((r.page.after_member_id === null) !== (previous === undefined)) fail();
      let predecessor: CheckedCustomCohortMemberPage | CustomCohortMemberContinuation | undefined;
      if (previous !== undefined) {
        const p = closed(previous, ['selection_ref', 'members']);
        if (JSON.stringify(selection(p.selection_ref)) !== JSON.stringify(r.selectionRef)) fail();
        predecessor = p.members as typeof predecessor;
      }
      const raw = await post(r.accountId, 'selection-members', { assignment_file_id: r.assignmentFileId,
        context_ref: r.contextRef, selection_ref: r.selectionRef, population: r.population, page: r.page }, io);
      const hasPrivate = raw !== null && typeof raw === 'object' && Object.hasOwn(raw, 'private_sales');
      const v = closed(raw, ['status', 'authority', 'target', 'context_ref', 'selection_ref', 'selection_revision',
        'subject_freshness', 'page', 'apply', ...(hasPrivate ? ['private_sales'] : [])]);
      const ref = selection(v.selection_ref);
      if (v.authority !== 'not_established' || JSON.stringify(ref) !== JSON.stringify(r.selectionRef)) fail();
      const members = checkCustomCohortBoundMemberPage({ status: v.status, target: v.target, context_ref: v.context_ref,
        selection_revision: v.selection_revision, subject_freshness: v.subject_freshness, page: v.page, apply: v.apply,
        ...(hasPrivate ? { private_sales: v.private_sales } : {}) }, {
        accountId: r.accountId, assignmentFileId: r.assignmentFileId, contextRef: r.contextRef,
        selectionRevision: ref.selection_revision, selectionFingerprint: ref.selection_sha256,
      }, expectation, r.page, predecessor, accounts);
      return Object.freeze({ selection_ref: ref, members });
    },
  });
}
