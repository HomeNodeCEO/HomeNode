export const SFREP_FORM_ID = 'FNMA-1004-0911' as const;

export interface SfrepSelection {
  accountId: string;
  assignmentFileId: number;
  documentIds: number[];
  includeDocuments: boolean;
}
export interface SfrepField {
  sourceField: string; fieldId: string; value: string; documentId: number; candidateId: number | null;
  type: 'TextField' | 'CheckBoxField';
}
export interface SfrepDocument {
  id: number; title: string; file_name: string; file_size_bytes: number; processing_status: string;
}
export type SfrepConflict = { sourceField: string; documentIds: number[]; values: string[] };
export type SfrepOmission = { sourceField: string; documentId: number; candidateId: number | null; reason: string };
export type SfrepNotice = string | SfrepConflict | SfrepOmission;
export interface SfrepPreview {
  ok: true;
  preview_digest: string;
  formId: typeof SFREP_FORM_ID;
  fields: SfrepField[];
  conflicts: SfrepConflict[];
  omitted: SfrepOmission[];
  warnings: string[];
  documents: SfrepDocument[];
  filename: string;
}
interface TransportOptions {
  request: (url: string, init: RequestInit) => Promise<Response>;
  urlFor: (path: string) => string;
}
interface RequestOptions { signal: AbortSignal; editorKey: string }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const validText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const cancelled = () => new DOMException('SFREP request cancelled', 'AbortError');
const checkSignal = (signal: AbortSignal) => { if (signal.aborted) throw cancelled(); };
const stop = (response: Response) => { void response.body?.cancel().catch(() => {}); };

export function checkSfrepPreview(value: unknown, selectedDocumentIds?: readonly number[]): SfrepPreview {
  if (!record(value) || value.ok !== true || value.formId !== SFREP_FORM_ID
    || typeof value.preview_digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.preview_digest)
    || !validText(value.filename) || !value.filename.toLowerCase().endsWith('.rpti')
    || !Array.isArray(value.fields) || !value.fields.every(field => record(field)
      && validText(field.sourceField) && validText(field.fieldId) && typeof field.value === 'string'
      && positiveId(field.documentId) && (field.candidateId === null || positiveId(field.candidateId))
      && (field.type === 'TextField' || field.type === 'CheckBoxField'))
    || !Array.isArray(value.conflicts) || !value.conflicts.every(conflict => record(conflict)
      && validText(conflict.sourceField) && Array.isArray(conflict.documentIds) && conflict.documentIds.every(positiveId)
      && Array.isArray(conflict.values) && conflict.values.every(item => typeof item === 'string'))
    || !Array.isArray(value.omitted) || !value.omitted.every(item => record(item)
      && typeof item.sourceField === 'string' && positiveId(item.documentId)
      && (item.candidateId === null || positiveId(item.candidateId)) && validText(item.reason))
    || !Array.isArray(value.warnings) || !value.warnings.every(item => typeof item === 'string')
    || !Array.isArray(value.documents) || !value.documents.every(doc => record(doc)
      && positiveId(doc.id) && typeof doc.title === 'string' && validText(doc.file_name)
      && typeof doc.file_size_bytes === 'number' && doc.file_size_bytes >= 0 && validText(doc.processing_status))) {
    throw new Error('The SFREP preview response is invalid. No export was downloaded.');
  }
  const preview = value as unknown as SfrepPreview;
  if (selectedDocumentIds) {
    const selected = new Set(selectedDocumentIds), received = new Set(preview.documents.map(doc => doc.id));
    if (selected.size !== received.size || received.size !== preview.documents.length
      || [...received].some(id => !selected.has(id))
      || [...preview.fields, ...preview.omitted].some(field => !selected.has(field.documentId))
      || preview.conflicts.some(conflict => conflict.documentIds.some(id => !selected.has(id)))) {
      throw new Error('The SFREP preview does not match the selected source documents. Preview again.');
    }
  }
  return preview;
}

export function sfrepDownloadFilename(value: string): string {
  const name = value.split(/[\\/]/).pop()?.replace(/[<>:"|?*\p{Cc}]/gu, '_').trim() || 'HomeNode-SFREP.rpti';
  return name.toLowerCase().endsWith('.rpti') ? name.slice(0, -5).slice(0, 150) + '.rpti' : 'HomeNode-SFREP.rpti';
}

/** Untrusted diagnostic text is displayed as text, never interpreted as markup. */
export function sfrepNoticeText(notice: SfrepNotice): string {
  if (typeof notice === 'string') return notice;
  const label = notice.sourceField.replace(/_/g, ' ') || 'Document';
  if ('values' in notice) return `${label}: ${notice.values.join(' / ')} (documents ${notice.documentIds.join(', ')})`;
  return `${label}: ${notice.reason.replace(/_/g, ' ')} (document ${notice.documentId})`;
}

/** Cancellation also settles promptly if authentication is still waiting for a token. */
function requestWithSignal(options: TransportOptions, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); reject(cancelled());
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { checkSignal(signal); return options.request(url, init); }).then(response => {
      if (settled) { stop(response); return; }
      settled = true; signal.removeEventListener('abort', abort);
      if (signal.aborted) { stop(response); reject(cancelled()); } else resolve(response);
    }, error => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

async function readBody(response: Response, limit: number, signal: AbortSignal): Promise<Blob> {
  checkSignal(signal);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) { stop(response); throw new Error('The SFREP response is too large.'); }
  if (!response.body) throw new Error('The SFREP response is empty.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, done = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    checkSignal(signal);
    while (true) {
      const part = await reader.read(); checkSignal(signal);
      if (part.done) { done = true; break; }
      size += part.value.byteLength;
      if (size > limit) throw new Error('The SFREP response is too large.');
      chunks.push(part.value);
    }
    return new Blob(chunks, { type: response.headers.get('content-type') || 'application/octet-stream' });
  } finally {
    signal.removeEventListener('abort', abort);
    if (!done) abort();
    reader.releaseLock();
  }
}

export function createSfrepTransport(options: TransportOptions) {
  async function post(selection: SfrepSelection, operation: 'preview' | 'export', io: RequestOptions, digest?: string) {
    checkSignal(io.signal);
    if (!selection.accountId.trim() || !positiveId(selection.assignmentFileId) || !selection.documentIds.length || selection.documentIds.length > 10
      || !selection.documentIds.every(positiveId) || new Set(selection.documentIds).size !== selection.documentIds.length
      || typeof selection.includeDocuments !== 'boolean' || (operation === 'export' && (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)))) {
      throw new Error('Choose 1–10 documents in a saved assignment and review a fresh preview before exporting.');
    }
    const path = `/api/accounts/${encodeURIComponent(selection.accountId)}/sfrep/${operation}`;
    const response = await requestWithSignal(options, options.urlFor(path), {
      method: 'POST', signal: io.signal, cache: 'no-store',
      headers: { accept: operation === 'preview' ? 'application/json' : 'application/octet-stream',
        'content-type': 'application/json', 'x-homenode-editor-key': io.editorKey },
      body: JSON.stringify({ assignment_file_id: selection.assignmentFileId, document_ids: selection.documentIds,
        include_documents: selection.includeDocuments, form_id: SFREP_FORM_ID,
        ...(operation === 'export' ? { preview_digest: digest } : {}) }),
    }, io.signal);
    if (io.signal.aborted) { stop(response); throw cancelled(); }
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!response.ok) {
      let message = `SFREP ${operation} failed (HTTP ${response.status}).`;
      if (type === 'application/json') {
        try {
          const error: unknown = JSON.parse(await (await readBody(response, 16_000, io.signal)).text());
          if (record(error) && validText(error.message ?? error.error)) message = String(error.message ?? error.error).slice(0, 500);
          if (record(error) && error.error === 'sfrep_preview_changed') message = 'The source evidence changed after your preview. Preview again and review the updated export.';
          if (record(error) && error.error === 'sfrep_export_busy') message = 'Another SFREP export is being prepared. Wait briefly, then preview again.';
        } catch { checkSignal(io.signal); }
      } else stop(response);
      throw new Error(message);
    }
    if (type !== (operation === 'preview' ? 'application/json' : 'application/octet-stream')) {
      stop(response); throw new Error(`Unexpected SFREP ${operation} response. No export was downloaded.`);
    }
    return readBody(response, operation === 'preview' ? 4_000_000 : 51 * 1024 * 1024, io.signal);
  }
  return {
    async preview(selection: SfrepSelection, io: RequestOptions): Promise<SfrepPreview> {
      const value: unknown = JSON.parse(await (await post(selection, 'preview', io)).text());
      checkSignal(io.signal);
      return checkSfrepPreview(value, selection.documentIds);
    },
    async export(selection: SfrepSelection, previewDigest: string, io: RequestOptions): Promise<Blob> {
      const blob = await post(selection, 'export', io, previewDigest);
      checkSignal(io.signal);
      if (!blob.size) throw new Error('The SFREP export is empty. No export was downloaded.');
      return blob;
    },
  };
}
