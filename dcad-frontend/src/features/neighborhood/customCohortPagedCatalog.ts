import { prepareCustomCohortRecordedGroupWrite } from './customCohortRecordedGroupTransport.ts';
import type { CustomCohortContextRef } from './customCohortPreviewController';
import type { CustomWorkspaceOperationOptions } from './customWorkspaceLifecycle';

type Ref = { readonly content_sha256: string; readonly canonical_utf8_bytes: string };
export interface CustomCohortPagedCatalogRequest {
  readonly accountId: string; readonly assignmentFileId: string;
  readonly contextRef: CustomCohortContextRef; readonly catalogRef: Ref;
}
export interface CheckedCustomCohortPagedCatalogGroup {
  readonly id: string; readonly label: string; readonly county: string | null;
  readonly member_count: number; readonly account_ids_sha256: string;
}
export interface CheckedCustomCohortPagedCatalog {
  readonly catalog_format: 1; readonly catalog_version: 3; readonly authority: 'not_established';
  readonly request: CustomCohortPagedCatalogRequest;
  readonly account_count: number; readonly assigned_account_count: number; readonly unassigned_account_count: number;
  readonly groups: readonly CheckedCustomCohortPagedCatalogGroup[];
  readonly subject_membership: { readonly account_id: string; readonly assigned_pocket_id: string | null;
    readonly status: string; readonly recorded_label_match_only: true };
  readonly limitations: readonly string[];
}
type Ports = {
  open(request: CustomCohortPagedCatalogRequest, io: CustomWorkspaceOperationOptions): Promise<unknown>;
  page(request: CustomCohortPagedCatalogRequest, index: number, io: CustomWorkspaceOperationOptions): Promise<unknown>;
};
type Obj = Record<string, unknown>;
const SHA = /^[a-f0-9]{64}$/, GROUP = /^recorded-cad:[a-f0-9]{64}$/, UNASSIGNED = 'discovery:unassigned';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const issued = new WeakSet<object>(), utf8 = new TextEncoder();
function fail(): never { throw new TypeError('invalid_custom_cohort_paged_catalog'); }
function closed(value: unknown, keys: readonly string[]): Obj {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length) fail();
  const copy: Obj = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) fail(); copy[key] = d.value;
  }
  return copy;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function ref(value: unknown, maximum: number): Ref {
  const v = closed(value, ['content_sha256', 'canonical_utf8_bytes']);
  if (typeof v.content_sha256 !== 'string' || !SHA.test(v.content_sha256)
    || typeof v.canonical_utf8_bytes !== 'string' || !/^[1-9]\d{0,6}$/.test(v.canonical_utf8_bytes)
    || Number(v.canonical_utf8_bytes) > maximum) fail();
  return Object.freeze({ content_sha256: v.content_sha256, canonical_utf8_bytes: v.canonical_utf8_bytes });
}
function count(value: unknown, maximum = 1_000_000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) fail(); return value;
}
function decimalCount(value: unknown, maximum: number): number {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) || value.length > 7) fail(); return count(Number(value), maximum);
}
function text(value: unknown, maximum = 512): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || utf8.encode(value).length > maximum) fail();
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 32 || c === 127) fail();
    if (c >= 0xd800 && c <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) fail(); }
    else if (c >= 0xdc00 && c <= 0xdfff) fail();
  }
  return value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
function parsed(value: unknown, maximum: number): Obj {
  if (typeof value !== 'string' || value.length > maximum || utf8.encode(value).length > maximum) fail();
  let result: unknown; try { result = JSON.parse(value); } catch { fail(); }
  if (!result || typeof result !== 'object' || Object.getPrototypeOf(result) !== Object.prototype) fail();
  return result as Obj;
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) fail();
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d?.enumerable || !Object.hasOwn(d, 'value')) fail(); result.push(d.value);
  }
  return result;
}
function request(value: unknown): CustomCohortPagedCatalogRequest {
  const v = closed(value, ['accountId', 'assignmentFileId', 'contextRef', 'catalogRef']);
  const r = prepareCustomCohortRecordedGroupWrite({ accountId: v.accountId, assignmentFileId: v.assignmentFileId,
    contextRef: v.contextRef, operationId: '10000000-0000-4000-8000-000000000001',
    expectedSelectionRef: null, includedRecordedGroupIds: [] });
  return Object.freeze({ accountId: r.accountId, assignmentFileId: r.assignmentFileId,
    contextRef: r.contextRef, catalogRef: ref(v.catalogRef, 16_000) });
}

/** Decode only a complete retained display directory + all its exact pages.
 * This has a NEW type: it cannot be cast into the legacy member-array catalog.
 * Hashes/counts describe the server's original v3 partition, not browser proof
 * of individual account membership, current rights, statistics or Apply. The
 * future keyed host must fence the current session/display at both ends.
 * Ports must be fixed authenticated, bounded, no-store application transports;
 * this decoder owns no URL, retry, timer, cache, worker or report write.
 */
export function createCustomCohortPagedCatalogReader(ports: Ports) {
  if (typeof ports?.open !== 'function' || typeof ports.page !== 'function') fail();
  const open = ports.open.bind(ports), page = ports.page.bind(ports);
  return async (value: CustomCohortPagedCatalogRequest, io: CustomWorkspaceOperationOptions): Promise<CheckedCustomCohortPagedCatalog> => {
    const r = request(value), signal = io?.signal, deadline = io?.deadline;
    const live = () => {
      if (!(signal instanceof AbortSignal) || !Number.isFinite(deadline) || deadline <= performance.now())
        throw new Error('custom_workspace_deadline');
      if (signal.aborted) throw new DOMException('Neighborhood catalog cancelled', 'AbortError');
    };
    const boundedIo = Object.freeze({ signal, deadline }); live();
    const verified = async (encoded: string, reference: Ref) => {
      live(); const bytes = utf8.encode(encoded); if (String(bytes.length) !== reference.canonical_utf8_bytes) fail();
      if (!globalThis.crypto?.subtle) fail();
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes); live();
      if ([...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('') !== reference.content_sha256) fail();
    };
    const header = closed(await open(r, boundedIo), ['authority', 'status', 'manifest_ref', 'manifest_json', 'metadata_json']); live();
    if (header.authority !== 'not_established' || header.status !== 'display_directory' || !same(ref(header.manifest_ref, 16_000), r.catalogRef)) fail();
    const root = closed(parsed(header.manifest_json, 16_000), ['recorded_catalog_version', 'kind', 'metadata_ref', 'group_count', 'account_count', 'pages']);
    if (root.recorded_catalog_version !== 1 || root.kind !== 'recorded_group_display') fail();
    const metadataRef = ref(root.metadata_ref, 32_000), groupCount = decimalCount(root.group_count, 2049), accountCount = decimalCount(root.account_count, 1_000_000);
    const directory = array(root.pages, 21).map((raw, i) => {
      const d = closed(raw, ['page_index', 'group_count', 'page_ref']);
      if (d.page_index !== String(i) || decimalCount(d.group_count, 100) !== Math.min(100, groupCount - i * 100)) fail();
      return { pageIndex: i, count: Number(d.group_count), ref: ref(d.page_ref, 200_000) };
    });
    if (directory.length !== Math.ceil(groupCount / 100) || new Set(directory.map(d => d.ref.content_sha256)).size !== directory.length) fail();
    const m = closed(parsed(header.metadata_json, 32_000), ['recorded_catalog_version', 'usage', 'scope', 'context_ref', 'catalog_version',
      'original_catalog_ref', 'original_read_model_sha256', 'roster_account_ids_sha256', 'group_count', 'account_count',
      'assigned_account_count', 'unassigned_account_count', 'subject_membership', 'limitations', 'unassigned_reason_counts']);
    const scope = closed(m.scope, ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id']);
    if (m.recorded_catalog_version !== 1 || m.usage !== 'retained_recorded_group_display_only' || m.catalog_version !== 3
      || scope.account_id !== r.accountId || scope.assignment_file_id !== r.assignmentFileId
      || typeof scope.organization_id !== 'string' || !UUID.test(scope.organization_id)
      || typeof scope.report_file_id !== 'string' || !UUID.test(scope.report_file_id)
      || !same(closed(m.context_ref, ['context_id', 'context_revision', 'context_sha256']), r.contextRef)
      || count(m.group_count, 2049) !== groupCount || count(m.account_count) !== accountCount
      || typeof m.original_read_model_sha256 !== 'string' || !SHA.test(m.original_read_model_sha256)
      || typeof m.roster_account_ids_sha256 !== 'string' || !SHA.test(m.roster_account_ids_sha256)) fail();
    ref(m.original_catalog_ref, 750_000);
    const assignedCount = count(m.assigned_account_count), unassignedCount = count(m.unassigned_account_count);
    if (assignedCount + unassignedCount !== accountCount) fail();
    const subject = closed(m.subject_membership, ['account_id', 'assigned_pocket_id', 'status', 'recorded_label_match_only']);
    if (subject.account_id !== r.accountId || subject.recorded_label_match_only !== true
      || (subject.assigned_pocket_id !== null && (typeof subject.assigned_pocket_id !== 'string' || !GROUP.test(subject.assigned_pocket_id)))
      || typeof subject.status !== 'string'
      || !['recorded_label_matched', 'unassigned', 'conflicting_evidence', 'invalid_evidence', 'not_in_discovery'].includes(subject.status)
      || (accountCount === 0 && subject.status !== 'not_in_discovery')
      || (['unassigned', 'conflicting_evidence', 'invalid_evidence'].includes(subject.status) && unassignedCount === 0)) fail();
    const limitations = array(m.limitations, 64).map(v => text(v, 200)); if (new Set(limitations).size !== limitations.length) fail();
    const reasons = array(m.unassigned_reason_counts, 64).map(raw => {
      const reason = closed(raw, ['reason', 'member_count']); text(reason.reason, 200);
      if (!count(reason.member_count) || Number(reason.member_count) > unassignedCount) fail(); return reason.reason;
    });
    if (new Set(reasons).size !== reasons.length) fail();
    await verified(header.manifest_json as string, r.catalogRef); await verified(header.metadata_json as string, metadataRef);
    const groups: CheckedCustomCohortPagedCatalogGroup[] = []; let sum = 0, unresolved = 0, prior = '';
    for (const d of directory) {
      live(); const raw = closed(await page(r, d.pageIndex, boundedIo), ['page_ref', 'page_json']); live();
      if (!same(ref(raw.page_ref, 200_000), d.ref)) fail();
      // Capture primitive original bytes before the asynchronous hash; callers
      // cannot swap a page/ref/name while crypto or the network is suspended.
      const encoded = raw.page_json, p = closed(parsed(encoded, 200_000), ['recorded_catalog_version', 'kind', 'metadata_ref', 'page_index', 'groups']);
      if (p.recorded_catalog_version !== 1 || p.kind !== 'recorded_group_display' || p.page_index !== String(d.pageIndex)
        || !same(ref(p.metadata_ref, 32_000), metadataRef)) fail();
      const entries = array(p.groups, 100); if (entries.length !== d.count) fail();
      for (const entry of entries) {
        const g = closed(entry, ['id', 'label', 'county', 'member_count', 'account_ids_sha256']);
        if (typeof g.id !== 'string' || (g.id !== UNASSIGNED && !GROUP.test(g.id)) || g.id <= prior
          || !count(g.member_count) || typeof g.account_ids_sha256 !== 'string' || !SHA.test(g.account_ids_sha256)) fail();
        const label = text(g.label), county = g.id === UNASSIGNED ? null : text(g.county);
        if ((g.id === UNASSIGNED && (g.county !== null || label !== 'Unresolved recorded groups')) || sum + Number(g.member_count) > accountCount) fail();
        sum += Number(g.member_count); if (g.id === UNASSIGNED) unresolved = Number(g.member_count); prior = g.id;
        groups.push(Object.freeze({ id: g.id, label, county, member_count: Number(g.member_count), account_ids_sha256: g.account_ids_sha256 }));
      }
      await verified(encoded as string, d.ref);
    }
    // End with another exact original header/current-owner admission. A page
    // reply or successful local hash is not a permanent source/role decision.
    const ending = closed(await open(r, boundedIo), ['authority', 'status', 'manifest_ref', 'manifest_json', 'metadata_json']); live();
    if (ending.authority !== header.authority || ending.status !== header.status
      || !same(ref(ending.manifest_ref, 16_000), r.catalogRef)
      || ending.manifest_json !== header.manifest_json || ending.metadata_json !== header.metadata_json) fail();
    live();
    if (groups.length !== groupCount || sum !== accountCount || unresolved !== unassignedCount
      || (subject.assigned_pocket_id !== null && !groups.some(g => g.id === subject.assigned_pocket_id))
      || (subject.status === 'recorded_label_matched') !== (subject.assigned_pocket_id !== null)) fail();
    const result = freeze({ catalog_format: 1 as const, catalog_version: 3 as const, authority: 'not_established' as const, request: r,
      account_count: accountCount, assigned_account_count: assignedCount, unassigned_account_count: unassignedCount, groups,
      subject_membership: { account_id: r.accountId, assigned_pocket_id: subject.assigned_pocket_id as string | null,
        status: subject.status as string, recorded_label_match_only: true as const }, limitations });
    issued.add(result); return result;
  };
}

export function requireCustomCohortPagedCatalog(value: unknown): CheckedCustomCohortPagedCatalog {
  if (!value || typeof value !== 'object' || !issued.has(value)) fail(); return value as CheckedCustomCohortPagedCatalog;
}
