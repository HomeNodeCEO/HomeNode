import { createCustomCohortJsonTransport } from './customCohortPreviewTransport.ts';
import { prepareCustomCohortRecordedGroupWrite } from './customCohortRecordedGroupTransport.ts';
import { createCustomCohortPagedCatalogReader, requireCustomCohortPagedCatalog } from './customCohortPagedCatalog.ts';
import type { CheckedCustomCohortPagedCatalog, CustomCohortPagedCatalogRequest } from './customCohortPagedCatalog';
import type { CustomCohortRecordedGroupRead } from './customCohortRecordedGroupTransport';
import type { CustomWorkspaceOperationOptions } from './customWorkspaceLifecycle';

type Obj = Record<string, unknown>;
type Ref = CustomCohortPagedCatalogRequest['catalogRef'];
type Directory = { readonly status: 'display_directory'; readonly authority: 'not_established';
  readonly manifest_ref: Ref; readonly manifest_json: string; readonly metadata_json: string };
type Page = { readonly page_ref: Ref; readonly page_json: string };
export type CustomCohortPreparedCatalogResult = { readonly status: 'not_prepared' } |
  { readonly status: 'available'; readonly catalog: CheckedCustomCohortPagedCatalog };
const utf8 = new TextEncoder(), SHA = /^[a-f0-9]{64}$/;
function fail(): never { throw new TypeError('invalid_custom_cohort_prepared_catalog'); }
function closed(value: unknown, keys: readonly string[]): Obj {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length) fail();
  const result: Obj = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key); if (!d?.enumerable || !Object.hasOwn(d, 'value')) fail(); result[key] = d.value;
  }
  return result;
}
function reference(value: unknown, maximum: number): Ref {
  const v = closed(value, ['content_sha256', 'canonical_utf8_bytes']);
  if (typeof v.content_sha256 !== 'string' || !SHA.test(v.content_sha256) || typeof v.canonical_utf8_bytes !== 'string'
    || !/^[1-9]\d{0,6}$/.test(v.canonical_utf8_bytes) || Number(v.canonical_utf8_bytes) > maximum) fail();
  return Object.freeze({ content_sha256: v.content_sha256, canonical_utf8_bytes: v.canonical_utf8_bytes });
}
function encoded(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || utf8.encode(value).length > maximum) fail(); return value;
}
function input(value: unknown): CustomCohortRecordedGroupRead {
  const v = closed(value, ['accountId', 'assignmentFileId', 'contextRef']);
  const r = prepareCustomCohortRecordedGroupWrite({ accountId: v.accountId, assignmentFileId: v.assignmentFileId,
    contextRef: v.contextRef, operationId: '10000000-0000-4000-8000-000000000001',
    expectedSelectionRef: null, includedRecordedGroupIds: [] });
  return Object.freeze({ accountId: r.accountId, assignmentFileId: r.assignmentFileId, contextRef: r.contextRef });
}
function response(value: unknown, request: CustomCohortRecordedGroupRead, index?: number): Directory | Page | null {
  const r = closed(value, ['status', 'authority', 'target', 'context_ref', 'catalog', ...(index === undefined ? [] : ['page_index'])]);
  const target = closed(r.target, ['account_id', 'assignment_file_id']);
  const context = closed(r.context_ref, ['context_id', 'context_revision', 'context_sha256']);
  if (r.authority !== 'not_established' || target.account_id !== request.accountId || target.assignment_file_id !== request.assignmentFileId
    || context.context_id !== request.contextRef.context_id || context.context_revision !== request.contextRef.context_revision
    || context.context_sha256 !== request.contextRef.context_sha256 || (index !== undefined && r.page_index !== index)) fail();
  if (r.status === 'not_prepared') { if (r.catalog !== null) fail(); return null; }
  if (r.status !== 'available') fail();
  if (index !== undefined) {
    const p = closed(r.catalog, ['page_ref', 'page_json']);
    return Object.freeze({ page_ref: reference(p.page_ref, 200_000), page_json: encoded(p.page_json, 200_000) });
  }
  const d = closed(r.catalog, ['status', 'authority', 'manifest_ref', 'manifest_json', 'metadata_json']);
  if (d.status !== 'display_directory' || d.authority !== 'not_established') fail();
  return Object.freeze({ status: 'display_directory', authority: 'not_established', manifest_ref: reference(d.manifest_ref, 16_000),
    manifest_json: encoded(d.manifest_json, 16_000), metadata_json: encoded(d.metadata_json, 32_000) });
}

/** A final current-owner directory fence for an ACTUAL already checked complete
 * catalog, not another catalog load or permanent source/member authority. The
 * root names the same original metadata/pages. No supplied root travels to the
 * server, no pages are fabricated/cached, and this never issues a new catalog.
 * Missing preparation returns false; changed/corrupt originals refuse. */
export function createCustomCohortPreparedCatalogRecheck(options: Parameters<typeof createCustomCohortJsonTransport>[0]) {
  const post = createCustomCohortJsonTransport(options);
  return async (value: CheckedCustomCohortPagedCatalog, io: CustomWorkspaceOperationOptions): Promise<boolean> => {
    const catalog = requireCustomCohortPagedCatalog(value);
    const request = input({ accountId: catalog.request.accountId, assignmentFileId: catalog.request.assignmentFileId,
      contextRef: catalog.request.contextRef });
    const signal = io?.signal, deadline = io?.deadline;
    const live = () => {
      if (!(signal instanceof AbortSignal) || !Number.isFinite(deadline) || performance.now() >= deadline)
        throw new Error('custom_workspace_deadline');
      if (signal.aborted) throw new DOMException('Neighborhood catalog cancelled', 'AbortError');
    };
    live();
    const out = response(await post(request.accountId, 'prepared-catalog', {
      assignment_file_id: request.assignmentFileId, context_ref: request.contextRef,
    }, Object.freeze({ signal, deadline })), request);
    live(); if (out === null) return false; if (!('manifest_ref' in out)) fail();
    const expected = catalog.request.catalogRef;
    if (out.manifest_ref.content_sha256 !== expected.content_sha256
      || out.manifest_ref.canonical_utf8_bytes !== expected.canonical_utf8_bytes) fail();
    const verified = async (original: string, ref: Ref) => {
      live(); const b = utf8.encode(original); if (b.length !== Number(ref.canonical_utf8_bytes)) fail();
      const digest = await globalThis.crypto.subtle.digest('SHA-256', b); live();
      if ([...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('') !== ref.content_sha256) fail();
    };
    await verified(out.manifest_json, expected);
    // The exact previously admitted root pins the original metadata's grammar,
    // scope/context and source identity; verify its actual bytes again, too.
    const root: unknown = JSON.parse(out.manifest_json);
    const r = closed(root, ['recorded_catalog_version', 'kind', 'metadata_ref', 'group_count', 'account_count', 'pages']);
    await verified(out.metadata_json, reference(r.metadata_ref, 32_000)); live(); return true;
  };
}

/** Fixed authenticated, byte-bounded application transport + actual whole-page
 * decoder. Never send roots, digests, members, selections, roles or a prepare
 * command. Cache miss is explicit, not a fallback to synchronous exploration.
 * Every directory/page invokes the current server owner. The decoder verifies
 * exact original hashes/lengths, every ordered page/whole count and an ending
 * directory; no partial catalog can be delivered. No retry/cache/timer/report
 * write or legacy full-account catalog cast. Caller still owns the finite
 * signal/deadline and keyed current session/display fences at BOTH ends.
 * This opt-in client does not mount a UI or activate server routes/V7/caps.
 */
export function createCustomCohortPreparedCatalogClient(options: Parameters<typeof createCustomCohortJsonTransport>[0]) {
  const post = createCustomCohortJsonTransport(options);
  return async (value: CustomCohortRecordedGroupRead, io: CustomWorkspaceOperationOptions): Promise<CustomCohortPreparedCatalogResult> => {
    const request = input(value), signal = io?.signal, deadline = io?.deadline;
    const live = () => {
      if (!(signal instanceof AbortSignal) || !Number.isFinite(deadline) || performance.now() >= deadline)
        throw new Error('custom_workspace_deadline');
      if (signal.aborted) throw new DOMException('Neighborhood catalog cancelled', 'AbortError');
    };
    const boundedIo = Object.freeze({ signal, deadline }); live();
    const read = async (index?: number) => {
      live();
      const raw = await post(request.accountId, index === undefined ? 'prepared-catalog' : 'prepared-catalog-page',
        { assignment_file_id: request.assignmentFileId, context_ref: request.contextRef,
          ...(index === undefined ? {} : { page_index: index }) }, boundedIo);
      live(); return response(raw, request, index);
    };
    const first = await read(); if (first === null) return Object.freeze({ status: 'not_prepared' });
    if (!('manifest_ref' in first)) fail();
    // Pin the root from the current authorized directory, never a browser root.
    // That same detached directory is the decoder's beginning original. Consume
    // it once rather than repeat the identical read; pages and the ending open
    // still hit the current owner. This is not a cross-operation lookup cache.
    const bound = Object.freeze({ ...request, catalogRef: first.manifest_ref });
    let beginning: Directory | null = first;
    const reader = createCustomCohortPagedCatalogReader({
      async open() {
        live();
        if (beginning !== null) { const result = beginning; beginning = null; return result; }
        const result = await read(); if (result === null || !('manifest_ref' in result)) fail(); return result;
      },
      async page(_r, index) { const result = await read(index); if (result === null || !('page_ref' in result)) fail(); return result; },
    });
    const catalog = await reader(bound, boundedIo); live(); return Object.freeze({ status: 'available', catalog });
  };
}
