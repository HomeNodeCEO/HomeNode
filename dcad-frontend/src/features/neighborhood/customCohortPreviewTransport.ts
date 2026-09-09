import type { CustomCohortPreviewRequest } from './customCohortPreviewController';

interface Options {
  request: (url: string, init: RequestInit) => Promise<Response>;
  urlFor: (path: string) => string;
}
const REQUEST_BYTES = 4_000_000;
const RESPONSE_BYTES = 18_000_000;
const ERROR_BYTES = 16_000;
const STREAM_CHUNKS = 65_536;
const encoder = new TextEncoder();
const abortError = () => new DOMException('Neighborhood preview request cancelled', 'AbortError');
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

/** One request, no retry or independent timer. Use with the preview controller's
 * bounded deadline (or another caller-owned finite AbortSignal). Semantic input
 * admission belongs to that controller and to the authorized server route. */
export function createCustomCohortPreviewTransport(options: Options) {
  return async (input: CustomCohortPreviewRequest, { signal }: { signal: AbortSignal }): Promise<unknown> => {
    checkSignal(signal);
    if (typeof input.accountId !== 'string' || !input.accountId || input.accountId.length > 64
      || typeof input.include_map !== 'boolean') throw new Error('Invalid neighborhood preview request');
    const path = `/api/accounts/${encodeURIComponent(input.accountId)}/neighborhood-cohort/preview`;
    const body = JSON.stringify({ assignment_file_id: input.assignmentFileId, context_ref: input.contextRef,
      selection: input.selection, include_map: input.include_map });
    if (encoder.encode(body).length > REQUEST_BYTES) throw new Error('Neighborhood preview selection is too large');
    const response = await requestWithSignal(options, options.urlFor(path), {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
      body, signal, cache: 'no-store',
    }, signal);
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
    const json = /^application\/(?:json|[a-z0-9_.-]+\+json)$/i.test(contentType);
    if (!response.ok) {
      let value: unknown = null;
      if (json) {
        try { value = await readJson(response, ERROR_BYTES, signal); }
        catch (error) { if (isAbort(error, signal)) throw abortError(); }
      } else stop(response.body);
      checkSignal(signal); throw new Error(errorMessage(value, response.status));
    }
    if (!json) { stop(response.body); throw new Error('Expected a JSON neighborhood preview response'); }
    return readJson(response, RESPONSE_BYTES, signal);
  };
}
