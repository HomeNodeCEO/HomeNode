import { useEffect, useRef, useState } from 'react';
import type { AssignmentDocument } from '@/lib/api';
import { sfrepApi } from './sfrepApi';
import { SFREP_FORM_ID, sfrepDownloadFilename, sfrepNoticeText, sfrepProvenanceText, sfrepSubjectChecklist, type SfrepPreview } from './sfrepTransport';

interface Props {
  accountId: string;
  assignmentFileId: number;
  documents: AssignmentDocument[];
  getEditorKey: () => string;
  onClose: () => void;
}
const secondary = 'hn-action-secondary btn btn-sm rounded-lg normal-case';

export default function SfrepExportDialog({ accountId, assignmentFileId, documents, getEditorKey, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const downloadUrlRef = useRef<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [includeDocuments, setIncludeDocuments] = useState(true);
  const [preview, setPreview] = useState<SfrepPreview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'export' | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current, previousFocus = document.activeElement;
    dialog?.showModal();
    return () => {
      requestRef.current?.abort(); requestRef.current = null;
      if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  const invalidate = () => { setPreview(null); setError(''); setMessage(''); };
  const selectDocument = (id: number, checked: boolean) => {
    if (requestRef.current) return;
    if (checked && (selectedIds.length >= 10 || selectedIds.includes(id))) return;
    invalidate(); setSelectedIds(current => checked ? [...current, id] : current.filter(value => value !== id));
  };
  const run = async (operation: 'preview' | 'export') => {
    if (requestRef.current || !selectedIds.length || (operation === 'export' && (!preview
      || (!preview.fields.length && (!includeDocuments || !preview.documents.length))))) return;
    const controller = new AbortController(); requestRef.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 120_000);
    setBusy(operation); setError(''); setMessage('');
    if (operation === 'preview') setPreview(null);
    try {
      const selection = { accountId, assignmentFileId, documentIds: [...selectedIds], includeDocuments };
      const io = { signal: controller.signal, editorKey: getEditorKey() };
      if (operation === 'preview') {
        const result = await sfrepApi.preview(selection, io);
        if (!controller.signal.aborted && requestRef.current === controller) setPreview(result);
      } else if (preview) {
        const blob = await sfrepApi.export(selection, preview.preview_digest, io);
        if (controller.signal.aborted || requestRef.current !== controller) return;
        if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
        const url = URL.createObjectURL(blob); downloadUrlRef.current = url;
        const link = document.createElement('a');
        link.href = url; link.download = sfrepDownloadFilename(preview.filename);
        document.body.appendChild(link); link.click(); link.remove();
        setMessage('Download started. Import the .rpti file into SFREP, then verify the imported fields and attached documents.');
      }
    } catch (failure) {
      if (requestRef.current !== controller) return;
      setPreview(null);
      setError(controller.signal.aborted ? 'The SFREP request timed out. Preview again to retry.'
        : failure instanceof Error ? failure.message : 'The SFREP request failed. No export was downloaded.');
    } finally {
      window.clearTimeout(timer);
      if (requestRef.current === controller) { requestRef.current = null; setBusy(null); }
    }
  };
  const documentTitle = (id: number | null) => id === null ? 'No source document (user default)'
    : documents.find(doc => doc.id === id)?.title || `Document ${id}`;
  const subjectChecklist = preview ? sfrepSubjectChecklist(preview) : [];

  return <dialog ref={dialogRef} onCancel={event => { event.preventDefault(); onClose(); }} aria-label="Export documents to SFREP"
    className="m-auto max-h-[90vh] w-[min(1000px,95vw)] overflow-y-auto rounded-xl border border-amber-300 bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-950/50 print:hidden">
    <header className="flex items-start justify-between gap-3 border-b border-amber-200 bg-gradient-to-r from-violet-100 to-amber-50 px-5 py-4">
      <div><h3 className="text-lg font-semibold text-violet-950">Export to SFREP</h3>
        <p className="mt-1 text-xs text-slate-700">Legacy FNMA 1004 · {SFREP_FORM_ID} · RPTI import file</p></div>
      <button type="button" autoFocus className={secondary} onClick={onClose}>Close</button>
    </header>
    <div className="space-y-4 p-5 text-sm" aria-busy={Boolean(busy)}>
      <p>Choose source documents, then review the mapped report fields before downloading. Document-derived fields require appraiser confirmation; any user-requested defaults are identified separately. This export does not support UAD 3.6.</p>
      <fieldset disabled={Boolean(busy)} className="space-y-2">
        <legend className="mb-2 font-semibold text-violet-950">1. Select documents ({selectedIds.length}/10)</legend>
        <div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border border-violet-200 p-3">
          {documents.map(doc => <label key={doc.id} className="flex items-start gap-3 rounded p-1">
            <input type="checkbox" className="checkbox checkbox-sm mt-0.5" checked={selectedIds.includes(doc.id)}
              disabled={selectedIds.length >= 10 && !selectedIds.includes(doc.id)}
              onChange={event => selectDocument(doc.id, event.target.checked)} />
            <span className="min-w-0"><span className="block break-words font-medium">{doc.title || doc.file_name}</span>
              <span className="text-xs text-slate-600">{doc.document_type.replace(/_/g, ' ')} · {doc.processing_status.replace(/_/g, ' ')}</span></span>
          </label>)}
          {!documents.length && <p>No source documents are available. Upload a PDF in the Document Evidence Center first.</p>}
        </div>
        <label className="flex items-start gap-3 pt-2"><input type="checkbox" className="checkbox checkbox-sm" checked={includeDocuments}
          onChange={event => { if (!requestRef.current) { invalidate(); setIncludeDocuments(event.target.checked); } }} />
          <span>Include original PDFs as report addenda</span></label>
        <p className="text-xs text-slate-600">Included PDFs become visible report pages in SFREP. Upload CAD and Realist reference PDFs using “Other Appraisal Document.” Fields without a supported mapping remain in their source documents. Maximum: 10 documents and 50 MiB of original PDFs per export.</p>
      </fieldset>
      <button type="button" className={secondary} disabled={Boolean(busy) || !selectedIds.length} onClick={() => void run('preview')}>
        {busy === 'preview' ? 'Preparing preview…' : 'Preview SFREP export'}
      </button>
      {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-rose-900">{error}</p>}
      {preview && <section className="space-y-3 rounded-xl border border-violet-200 p-4" aria-label="SFREP export preview">
        <h4 className="font-semibold text-violet-950">2. Review export</h4>
        <p>{preview.fields.length} mapped field(s) · {includeDocuments ? preview.documents.length : 0} original PDF(s) included</p>
        <section aria-label="Effective-date context" className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
          <h5 className="font-semibold">Effective-date context</h5>
          {preview.effectiveDateContext.effectiveDate ? <>
            <p className="font-medium">{preview.effectiveDateContext.isPlaceholder ? 'Placeholder effective date — review required' : preview.effectiveDateContext.source === 'inspection_date' ? 'Inspection date' : 'Assignment effective date'}: {preview.effectiveDateContext.effectiveDate}</p>
            {preview.effectiveDateContext.isPlaceholder && <p>Using the document upload date, not a confirmed inspection or appraisal effective date. Confirm the effective date before relying on the listing determination.</p>}
            {preview.effectiveDateContext.sourceDocumentId !== null && <p>Date source: {documentTitle(preview.effectiveDateContext.sourceDocumentId)}</p>}
            <p>Prior 12-calendar-month window: {preview.effectiveDateContext.windowStart} through {preview.effectiveDateContext.windowEnd}.</p>
          </> : <p>Effective date unavailable — review needed. A date-based 12-month listing determination cannot be made.</p>}
          <p>This context evaluates listing history; it does not mark the Subject section complete.</p>
        </section>
        {preview.assumptions.length > 0 && <section aria-label="Assumptions requiring confirmation" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
          <h5 className="font-semibold">Assumptions requiring confirmation</h5>
          <ul className="mt-1 list-disc space-y-1 pl-5">{preview.assumptions.map(assumption => <li key={assumption.fieldId}>{assumption.reason}</li>)}</ul>
        </section>}
        <section aria-label="1004 Subject export checklist" className="space-y-2">
          <h5 className="font-semibold text-violet-950">1004 Subject export checklist</h5>
          <p className="text-xs text-slate-600">{subjectChecklist.filter(item => item.status !== 'included').length} of {subjectChecklist.length} items need review or are missing. This checklist shows export coverage, not a completed appraisal. Missing and omitted items are not exported; existing SFREP values may remain. Review the destination report and alternative checkbox selections.</p>
          {subjectChecklist.some(item => item.status === 'missing' || !item.values.length) && <p className="text-xs text-amber-900">For documents uploaded before this update, use Re-run extraction and review the new suggestions.</p>}
          <div className="overflow-x-auto"><table className="w-full text-left text-xs">
            <caption className="sr-only">Subject-section export coverage and items requiring review</caption>
            <thead><tr className="border-b border-violet-200"><th scope="col" className="p-2">Subject item</th><th scope="col" className="p-2">Export status / value</th><th scope="col" className="p-2">Review notes</th></tr></thead>
            <tbody>{subjectChecklist.map(item => <tr key={item.key} className="border-b border-slate-100 align-top">
              <th scope="row" className="p-2 font-medium">{item.label}</th>
              <td className="max-w-sm break-words p-2"><span className={item.status === 'included' ? 'font-medium text-emerald-800' : 'font-medium text-amber-900'}>{item.statusLabel}</span>
                {item.values.map((value, index) => <span key={index} className="mt-1 block whitespace-pre-wrap">{value}</span>)}</td>
              <td className="max-w-sm break-words p-2 text-slate-600">{item.notes.map((note, index) => <p key={index}>{note}</p>)}</td>
            </tr>)}</tbody>
          </table></div>
        </section>
        {preview.fields.length ? <details className="rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer font-medium">Mapped fields and provenance ({preview.fields.length})</summary><div className="mt-2 overflow-x-auto"><table className="w-full text-left text-xs">
          <caption className="sr-only">Report field values and their source documents</caption>
          <thead><tr className="border-b border-violet-200"><th scope="col" className="p-2">Source field / SFREP ID</th><th scope="col" className="p-2">Value</th><th scope="col" className="p-2">Source / provenance</th></tr></thead>
          <tbody>{preview.fields.map((field, index) => <tr key={`${field.fieldId}:${index}`} className="border-b border-slate-100 align-top">
            <th scope="row" className="p-2 font-medium">{field.sourceField.replace(/_/g, ' ')}<span className="block text-slate-500">{field.fieldId}</span></th>
            <td className="max-w-sm whitespace-pre-wrap break-words p-2">{field.value}</td>
            <td className="max-w-sm break-words p-2" title={field.candidateId !== null ? `Candidate ${field.candidateId}` : undefined}>{documentTitle(field.documentId)}<span className="mt-1 block text-slate-600">{sfrepProvenanceText(field)}</span></td>
          </tr>)}</tbody>
        </table></div></details> : <p className="rounded-lg bg-amber-50 p-3 text-amber-900">No supported confirmed fields are available. {includeDocuments ? 'This export contains reference PDFs only.' : 'No report fields or PDFs would be included. Select original PDFs or review document candidates first.'}</p>}
        {([['Conflicting fields (not exported)', preview.conflicts], ['Omitted fields', preview.omitted], ['Warnings', preview.warnings]] as const).map(([label, notices]) => notices.length > 0 && <details key={label} open={label === 'Conflicting fields (not exported)'} className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <summary className="cursor-pointer font-semibold text-amber-950">{label} ({notices.length})</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-950">{notices.map((notice, index) => <li key={index} className="break-words">{sfrepNoticeText(notice)}</li>)}</ul>
        </details>)}
        {includeDocuments && preview.documents.length > 0 && <details className="rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer font-medium">Included reference PDFs ({preview.documents.length})</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">{preview.documents.map(doc => <li key={doc.id}>{doc.title || doc.file_name} · {Math.max(1, Math.round(doc.file_size_bytes / 1024)).toLocaleString()} KB</li>)}</ul>
        </details>}
        <p className="text-xs text-slate-600">Review the fields and exclusions above before downloading. Resolve conflicts in the Document Evidence Center if you want those fields included.</p>
        <button type="button" className="hn-action-gold btn btn-sm rounded-lg normal-case" disabled={Boolean(busy) || (!preview.fields.length && (!includeDocuments || !preview.documents.length))}
          onClick={() => void run('export')}>{busy === 'export' ? 'Preparing download…' : 'Download SFREP .rpti'}</button>
      </section>}
      {message && <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-900">{message}</p>}
      <p className="text-xs text-slate-500">The download does not change HomeNode report fields or send data directly to SFREP. Keep the RPTI file private; it may contain borrower and assignment information.</p>
    </div>
  </dialog>;
}
