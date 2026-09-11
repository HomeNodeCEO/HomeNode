import type { CustomCohortPreviewInput, CustomCohortPreviewRequest } from './customCohortPreviewController';
import type { CustomCohortMemberPopulation, CustomCohortMemberPageRequest } from './customCohortMemberPage';

interface Options {
  request: (url: string, init: RequestInit) => Promise<Response>;
  urlFor: (path: string) => string;
}
const REQUEST_BYTES = 4_000_000;
const RESPONSE_BYTES = 18_000_000;
// Exact parcel geometry (24MB) plus the unchanged 2MB summary and envelope.
// This applies only to map previews; catalog/member/request limits stay intact.
const MAP_PREVIEW_RESPONSE_BYTES = 27_000_000;
const OPENING_RESPONSE_BYTES = REQUEST_BYTES + MAP_PREVIEW_RESPONSE_BYTES;
const ERROR_BYTES = 16_000;
const STREAM_CHUNKS = 65_536;
const encoder = new TextEncoder();
const abortError = () => new DOMException('Neighborhood preview request cancelled', 'AbortError');
/** Only a settled, exact server refusal (or its sanitized workspace equivalent)
 * identifies computed preview capacity. Timeouts and local decoder limits do not. */
export function isCustomCohortPreviewCapacityError(error: unknown): boolean {
  return error instanceof Error && 'status' in error && error.status === 422
    && (('errorCode' in error && error.errorCode === 'neighborhood_preview_capacity_exceeded')
      || ('workspaceCode' in error && error.workspaceCode === 'preview_capacity_exceeded'));
}
const stop = (stream: ReadableStream<Uint8Array> | null) => { void stream?.cancel().catch(() => {}); };
function checkSignal(signal: AbortSignal) { if (signal.aborted) throw abortError(); }
function isAbort(error: unknown, signal: AbortSignal) {
  return signal.aborted || (error instanceof Error && error.name === 'AbortError');
}

/** Preserve the caller's signal through authentication/token lookup as well as
 * fetch. An injected request which ignores cancellation cannot hold this owner
 * open; a late response body is cancelled, not read or delivered. */
function requestWithSignal(options: Options, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const aborted = () => {
      if (settled) return; settled = true; signal.removeEventListener('abort', aborted); reject(abortError());
    };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(() => { checkSignal(signal); return options.request(url, init); }).then(response => {
      if (settled) { stop(response.body); return; }
      settled = true; signal.removeEventListener('abort', aborted);
      if (signal.aborted) { stop(response.body); reject(abortError()); } else resolve(response);
    }, error => {
      if (settled) return; settled = true; signal.removeEventListener('abort', aborted);
      reject(isAbort(error, signal) ? abortError() : new Error('Neighborhood preview request failed'));
    });
  });
}

async function readJson(response: Response, maximum: number, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) { stop(response.body); throw abortError(); }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    stop(response.body); throw new Error('Neighborhood preview response is too large');
  }
  if (!response.body) throw new Error('Neighborhood preview response is empty');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, chunks = 0, done = false, text = '', rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const onAbort = () => { cancel(); rejectAbort(abortError()); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    checkSignal(signal);
    while (true) {
      const part = await Promise.race([reader.read(), aborted]); checkSignal(signal);
      if (part.done) { done = true; break; }
      if (++chunks > STREAM_CHUNKS || !(part.value instanceof Uint8Array)) throw new Error('Invalid neighborhood preview stream');
      size += part.value.byteLength;
      if (size > maximum) throw new Error('Neighborhood preview response is too large');
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode(); checkSignal(signal);
    try { return JSON.parse(text) as unknown; }
    catch { throw new Error('Invalid neighborhood preview JSON response'); }
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!done) cancel();
    reader.releaseLock();
  }
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>, value = record.error ?? record.message;
    if (typeof value === 'string' && value.trim()) return value.replace(/\p{Cc}/gu, ' ').trim().slice(0, 500);
  }
  return `Neighborhood preview request failed (HTTP ${status})`;
}
function exactErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'error')) return undefined;
  const value = (body as Record<string, unknown>).error;
  // Preserve only original machine vocabulary, never normalized display text
  // or a message fallback. Callers must still allowlist exact code + status.
  return typeof value === 'string' && value.length <= 100 && /^[a-z]/.test(value)
    && !/[^a-z0-9_]/.test(value) ? value : undefined;
}

async function jsonRequest(options: Options, path: string, init: RequestInit, maximum: number, signal: AbortSignal) {
  const response = await requestWithSignal(options, options.urlFor(path), {
    ...init, headers: { accept: 'application/json', ...init.headers }, signal, cache: 'no-store',
  }, signal);
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
  const json = /^application\/(?:json|[a-z0-9_.-]+\+json)$/i.test(contentType);
  if (!response.ok) {
    let value: unknown = null;
    if (json) {
      try { value = await readJson(response, ERROR_BYTES, signal); }
      catch (error) { if (isAbort(error, signal)) throw abortError(); }
    } else stop(response.body);
    checkSignal(signal);
    const errorCode = exactErrorCode(value);
    throw Object.assign(new Error(errorMessage(value, response.status)), { status: response.status, ...(errorCode ? { errorCode } : {}) });
  }
  if (!json) { stop(response.body); throw new Error('Expected a JSON neighborhood preview response'); }
  return readJson(response, maximum, signal);
}

/** One request, no retry or independent timer. Use with the preview controller's
 * bounded deadline (or another caller-owned finite AbortSignal). Semantic input
 * admission belongs to that controller and to the authorized server route. */
export function createCustomCohortPreviewTransport(options: Options) {
  const post = createCustomCohortJsonTransport(options);
  return async (input: CustomCohortPreviewRequest, { signal }: { signal: AbortSignal }): Promise<unknown> => {
    checkSignal(signal);
    if (typeof input.accountId !== 'string' || !input.accountId || input.accountId.length > 64
      || typeof input.include_map !== 'boolean') throw new Error('Invalid neighborhood preview request');
    return post(input.accountId, 'preview', { assignment_file_id: input.assignmentFileId, context_ref: input.contextRef,
      selection: input.selection, include_map: input.include_map }, { signal });
  };
}

/** Read-only member inspection uses the same authenticated, bounded transport.
 * The inspector owns its finite deadline and validates the returned page against
 * its exact checked summary. This never obtains an editor key or saves a choice. */
export function createCustomCohortMemberTransport(options: Options) {
  const post = createCustomCohortJsonTransport(options);
  return (input: CustomCohortPreviewInput, population: CustomCohortMemberPopulation,
    page: CustomCohortMemberPageRequest, io: { signal: AbortSignal }): Promise<unknown> =>
    post(input.accountId, 'members', { assignment_file_id: input.assignmentFileId,
      context_ref: input.contextRef, selection: input.selection, population, page }, io);
}
export type CustomCohortMemberTransport = ReturnType<typeof createCustomCohortMemberTransport>;

/** Shared bounded transport for the three read-only views and idempotent context
 * capture. Operation names are closed; callers cannot supply arbitrary URLs. */
export function createCustomCohortJsonTransport(options: Options) {
  return async (accountId: string, operation: 'preview' | 'catalog' | 'members' | 'capture' | 'reported-proposal' | 'reported-apply',
    payload: unknown, { signal }: { signal: AbortSignal }): Promise<unknown> => {
    checkSignal(signal);
    if (typeof accountId !== 'string' || !accountId || accountId.length > 64
      || !['preview', 'catalog', 'members', 'capture', 'reported-proposal', 'reported-apply'].includes(operation)) throw new Error('Invalid neighborhood request');
    const path = `/api/accounts/${encodeURIComponent(accountId)}/neighborhood-cohort/${operation}`;
    const body = JSON.stringify(payload);
    if (typeof body !== 'string') throw new Error('Invalid neighborhood request body');
    if (encoder.encode(body).length > REQUEST_BYTES) throw new Error('Neighborhood preview selection is too large');
    return jsonRequest(options, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body },
      operation === 'preview' ? MAP_PREVIEW_RESPONSE_BYTES
        : operation === 'catalog' && payload !== null && typeof payload === 'object' && Object.hasOwn(payload, 'initial_preview_groups')
          ? OPENING_RESPONSE_BYTES : REQUEST_BYTES, signal);
  };
}

/** Existing generic workfile endpoints, but only this one editor-intent section.
 * No reviewer/signing identity is supplied by the browser. The server remains
 * the authority for session identity, assignment access, CAS and signed locks.
 * These legacy endpoints still encode IDs as JSON numbers; reject unsafe IDs
 * instead of rounding them, even though the cohort API supports int64 strings.
 */
export function createCustomWorkspaceSectionTransport(options: Options) {
  function path(accountId: string, assignmentFileId: string) {
    if (typeof accountId !== 'string' || typeof assignmentFileId !== 'string'
      || !/^[0-9A-Za-z_-]{1,50}$/.test(accountId) || !/^[1-9][0-9]{0,15}$/.test(assignmentFileId)
      || !Number.isSafeInteger(Number(assignmentFileId))) throw new Error('Invalid custom workspace target');
    return `/api/accounts/${encodeURIComponent(accountId)}/assignment-files/${assignmentFileId}/workfile`;
  }
  return Object.freeze({
    read(accountId: string, assignmentFileId: string, { signal }: { signal: AbortSignal }) {
      checkSignal(signal);
      return jsonRequest(options, path(accountId, assignmentFileId), { method: 'GET' }, RESPONSE_BYTES, signal);
    },
    save(accountId: string, assignmentFileId: string,
      input: { value: unknown; expectedRevision: number; editorKey: string }, { signal }: { signal: AbortSignal }) {
      checkSignal(signal);
      const endpoint = path(accountId, assignmentFileId);
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision >= 2_147_483_647
        || typeof input.editorKey !== 'string' || !input.editorKey || input.editorKey.length > 4096
        || /[\r\n]/.test(input.editorKey)) throw new Error('Invalid custom workspace save');
      const value = JSON.stringify(input.value);
      // API admission has validated the closed checkpoint. Read the version
      // from its serialized bytes so getters/mutation cannot select a different
      // limit than the exact value submitted; this grants no save authority.
      if (typeof value !== 'string') throw new Error('Invalid custom workspace checkpoint size');
      const valueBytes = encoder.encode(value).length;
      if (valueBytes > 131_072) throw new Error('Invalid custom workspace checkpoint size');
      const checkpointLimit = JSON.parse(value)?.workspace_version === 5 ? 131_072 : 32_768;
      if (valueBytes > checkpointLimit) throw new Error('Invalid custom workspace checkpoint size');
      // Serialize once before awaiting authentication/network; caller mutations
      // cannot change the value paired with this expected revision.
      const body = `{"value":${value},"expected_revision":${input.expectedRevision},"save_reason":"autosave"}`;
      return jsonRequest(options, `${endpoint}/sections/neighborhood_workspace`, { method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-homenode-editor-key': input.editorKey }, body }, checkpointLimit * 2, signal);
    },
  });
}
