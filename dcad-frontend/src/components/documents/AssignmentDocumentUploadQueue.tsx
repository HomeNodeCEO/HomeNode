import { useEffect, useId, useRef, useState } from 'react';
import type { AssignmentDocumentType } from '@/lib/api';
import {
  addDocumentUploadFiles,
  createDocumentUploadRunner,
  DOCUMENT_UPLOAD_TYPES,
  type DocumentUploadItem,
  type DocumentUploadMetadata,
} from './documentUploadQueue';

interface AssignmentDocumentUploadQueueProps {
  disabled: boolean;
  onUpload: (file: File, metadata: DocumentUploadMetadata) => Promise<void>;
  onComplete?: () => void | Promise<void>;
}

function fileSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.ceil(bytes / 1024))} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const STATUS_LABELS = { queued: 'Ready', uploading: 'Uploading…', uploaded: 'Uploaded', failed: 'Upload failed' };

export default function AssignmentDocumentUploadQueue({ disabled, onUpload, onComplete }: AssignmentDocumentUploadQueueProps) {
  const inputId = useId();
  const [items, setItems] = useState<DocumentUploadItem[]>([]);
  const [defaultType, setDefaultType] = useState<AssignmentDocumentType>('other');
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState('');
  const [retryConfirmed, setRetryConfirmed] = useState(false);
  const itemsRef = useRef(items);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const mountedRef = useRef(false);
  const activeRef = useRef(false);
  const runnerRef = useRef(createDocumentUploadRunner());

  useEffect(() => {
    mountedRef.current = true;
    const runner = runnerRef.current;
    return () => {
      mountedRef.current = false;
      runner.cancel();
    };
  }, []);

  useEffect(() => {
    if (disabled) runnerRef.current.cancel();
  }, [disabled]);

  const updateItems = (next: DocumentUploadItem[]) => {
    itemsRef.current = next;
    setItems(next);
  };

  const addFiles = (files: File[]) => {
    if (disabledRef.current || activeRef.current) return;
    const result = addDocumentUploadFiles(itemsRef.current, files, defaultType);
    updateItems(result.items);
    setNotice(result.messages.join(' '));
  };

  const editItem = (id: string, metadata: Partial<DocumentUploadMetadata>) => {
    if (disabledRef.current || activeRef.current) return;
    updateItems(itemsRef.current.map(item => item.id === id && ['queued', 'failed'].includes(item.status)
      ? { ...item, ...metadata } : item));
    setRetryConfirmed(false);
  };

  const removeItems = (keep: (item: DocumentUploadItem) => boolean) => {
    if (disabledRef.current || activeRef.current) return;
    updateItems(itemsRef.current.filter(keep));
    setRetryConfirmed(false);
  };

  const start = async (mode: 'queued' | 'failed') => {
    if (disabledRef.current || activeRef.current || (mode === 'failed' && !retryConfirmed)) return;
    if (!itemsRef.current.some(item => item.status === mode)) return;
    // Ref closes the double-click window before React paints disabled controls.
    activeRef.current = true;
    setRunning(true);
    setRetryConfirmed(false);
    setNotice('');
    try {
      const result = await runnerRef.current.run(itemsRef.current, {
        mode,
        upload: onUpload,
        blocked: () => disabledRef.current || !mountedRef.current,
        update: (updated) => {
          if (mountedRef.current) updateItems(itemsRef.current.map(item => item.id === updated.id ? updated : item));
        },
      });
      if (!mountedRef.current) return;
      setNotice(`${result.uploaded} uploaded${result.failed ? `; ${result.failed} failed` : ''}.${result.cancelled ? ' Uploads paused; remaining files are still queued.' : ''}`);
      if (result.started) {
        try {
          await onComplete?.();
        } catch {
          if (mountedRef.current) setNotice('Upload results are shown below. The attached document list could not be refreshed; reopen it before retrying any failed files.');
        }
      }
    } finally {
      activeRef.current = false;
      if (mountedRef.current) setRunning(false);
    }
  };

  const queued = items.filter(item => item.status === 'queued').length;
  const failed = items.filter(item => item.status === 'failed').length;
  const uploaded = items.filter(item => item.status === 'uploaded').length;
  const controlsDisabled = disabled || running;

  return (
    <section className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-4" aria-label="PDF upload queue">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Add document PDFs</h3>
          <p className="mt-1 text-xs text-slate-600">Up to 20 files, 25 MiB per PDF, and 100 MiB total in this queue.</p>
        </div>
        <label className="text-xs font-medium text-slate-700">
          Type for new files
          <select className="hn-document-type select mt-1 block rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm" value={defaultType}
            disabled={controlsDisabled} onChange={event => setDefaultType(event.target.value as AssignmentDocumentType)}>
            {DOCUMENT_UPLOAD_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
      <div className="mt-3 rounded-lg border border-dashed border-slate-300 bg-white p-3"
        onDragOver={event => event.preventDefault()}
        onDrop={event => { event.preventDefault(); addFiles(Array.from(event.dataTransfer.files)); }}>
        <label className="mb-2 block text-sm font-medium text-slate-700" htmlFor={inputId}>Choose PDFs or drop them here</label>
        <input id={inputId} type="file" accept="application/pdf,.pdf" multiple disabled={controlsDisabled}
          className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border file:border-slate-300 file:bg-slate-50 file:px-3 file:py-2 file:text-sm file:font-medium"
          onChange={event => { addFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />
      </div>
      <p role="status" aria-live="polite" aria-atomic="true" className={notice ? 'mt-3 text-sm text-slate-700' : 'sr-only'}>{notice}</p>
      {disabled && running ? <p role="status" className="mt-3 text-sm text-amber-900">Uploads are paused. The current upload may finish; no further files will start.</p> : null}
      {items.length ? <>
        <p className="mt-3 text-xs text-slate-600">{items.length} files · {fileSize(items.reduce((sum, item) => sum + item.file.size, 0))} · {uploaded} uploaded</p>
        <ul className="mt-2 space-y-2">
          {items.map(item => {
            const metadataDisabled = controlsDisabled || item.status === 'uploaded' || item.status === 'uploading';
            return <li key={item.id} className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium text-slate-900">{item.file.name}</p>
                  <p className={`mt-1 text-xs ${item.status === 'failed' ? 'text-rose-700' : item.status === 'uploaded' ? 'text-emerald-700' : 'text-slate-600'}`}>
                    {fileSize(item.file.size)} · {STATUS_LABELS[item.status]}
                  </p>
                </div>
                <button type="button" disabled={controlsDisabled} onClick={() => removeItems(current => current.id !== item.id)}
                  aria-label={`Remove ${item.file.name} from upload queue`} className="text-xs text-slate-600 underline disabled:opacity-50">Remove</button>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(10rem,1fr)_minmax(12rem,2fr)]">
                <label className="text-xs font-medium text-slate-700">Document type
                  <select value={item.documentType} disabled={metadataDisabled}
                    onChange={event => editItem(item.id, { documentType: event.target.value as AssignmentDocumentType })}
                    className="hn-document-type select mt-1 block w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm disabled:bg-slate-50">
                    {DOCUMENT_UPLOAD_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                <label className="text-xs font-medium text-slate-700">Label
                  <input value={item.title} maxLength={300} disabled={metadataDisabled} placeholder={item.file.name}
                    onChange={event => editItem(item.id, { title: event.target.value })}
                    className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-2 text-sm disabled:bg-slate-50" />
                </label>
              </div>
              {item.error ? <p className="mt-2 break-words text-xs text-rose-700">{item.error}</p> : null}
            </li>;
          })}
        </ul>
        {failed ? <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <p>An upload may have saved before a connection failed. Check the attached document list before retrying to avoid duplicates. Successful files will not be resent.</p>
          <label className="mt-2 flex items-start gap-2">
            <input type="checkbox" checked={retryConfirmed} disabled={controlsDisabled}
              onChange={event => setRetryConfirmed(event.target.checked)} />
            I checked the attached documents and want to retry the failed files.
          </label>
        </div> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={controlsDisabled || !queued} onClick={() => void start('queued')}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {running ? 'Uploading…' : `Upload ${queued} ${queued === 1 ? 'PDF' : 'PDFs'}`}
          </button>
          {failed ? <button type="button" disabled={controlsDisabled || !retryConfirmed} onClick={() => void start('failed')}
            className="rounded-lg border border-amber-400 px-3 py-2 text-sm font-medium text-amber-900 disabled:opacity-50">Retry failed ({failed})</button> : null}
          {uploaded ? <button type="button" disabled={controlsDisabled} onClick={() => removeItems(item => item.status !== 'uploaded')}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 disabled:opacity-50">Clear uploaded from queue</button> : null}
        </div>
      </> : null}
    </section>
  );
}
