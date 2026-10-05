import { useEffect, useRef, useState } from 'react';
import type { AssignmentDocument } from '@/lib/api';
import { sfrepApi } from './sfrepApi';
import { SFREP_FORM_ID, sfrepContractChecklist, sfrepDownloadFilename, sfrepNoticeText, sfrepProvenanceText, sfrepSubjectChecklist, type SfrepPreview } from './sfrepTransport';

interface Props {
  accountId: string;
  assignmentFileId: number;
  documents: AssignmentDocument[];
  documentsLoading?: boolean;
  documentLoadError?: string;
  onRetryDocuments?: () => void;
  getEditorKey: () => string;
  onClose: () => void;
}
const secondary = 'hn-action-secondary btn btn-sm rounded-lg normal-case';

export default function SfrepExportDialog({ accountId, assignmentFileId, documents, documentsLoading = false, documentLoadError = '', onRetryDocuments, getEditorKey, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const downloadUrlRef = useRef<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [includeDocuments, setIncludeDocuments] = useState(true);
  const [includeDiscrepancyAddendum, setIncludeDiscrepancyAddendum] = useState(false);
  const [preview, setPreview] = useState<SfrepPreview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'export' | null>(null);
  const [error, setError] = useState('');
  const [preparedDownload, setPreparedDownload] = useState<{ url: string; filename: string } | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current, previousFocus = document.activeElement;
    dialog?.showModal();
    return () => {
      requestRef.current?.abort(); requestRef.current = null;
      if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = null;
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  const clearDownload = () => {
    if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
    downloadUrlRef.current = null; setPreparedDownload(null);
  };
  const invalidate = () => { clearDownload(); setPreview(null); setError(''); };
  const selectDocument = (id: number, checked: boolean) => {
    if (requestRef.current) return;
    if (checked && (selectedIds.length >= 10 || selectedIds.includes(id))) return;
    invalidate(); setSelectedIds(current => checked ? [...current, id] : current.filter(value => value !== id));
  };
  const run = async (operation: 'preview' | 'export') => {
    if (requestRef.current || (operation === 'export' && (!preview
      || (!preview.fields.length && (!includeDocuments || !preview.documents.length))))) return;
    const controller = new AbortController(); requestRef.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 120_000);
    clearDownload(); setBusy(operation); setError('');
    if (operation === 'preview') setPreview(null);
    try {
      const selection = { accountId, assignmentFileId, documentIds: [...selectedIds], includeDocuments,
        includeDiscrepancyAddendum };
      const io = { signal: controller.signal, editorKey: getEditorKey() };
      if (operation === 'preview') {
        const result = await sfrepApi.preview(selection, io);
        if (!controller.signal.aborted && requestRef.current === controller) setPreview(result);
      } else if (preview) {
        const blob = await sfrepApi.export(selection, preview.preview_digest, io);
        if (controller.signal.aborted || requestRef.current !== controller) return;
        const url = URL.createObjectURL(blob); downloadUrlRef.current = url;
        const filename = sfrepDownloadFilename(preview.filename);
        setPreparedDownload({ url, filename });
        try {
          const link = document.createElement('a');
          link.href = url; link.download = filename;
          document.body.appendChild(link);
          try { link.click(); } finally { link.remove(); }
        } catch {
          // The visible link remains available if the automatic attempt is blocked.
        }
        // Keep the URL usable for a direct user gesture; click() does not confirm a download.
      }
    } catch (failure) {
      if (requestRef.current !== controller) return;
      clearDownload();
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
  const contractChecklist = preview ? sfrepContractChecklist(preview) : [];
  const reviewAssumptions = preview?.assumptions.filter(assumption => assumption.rule !== 'user_requested_fee_simple_default') || [];
  const contractFlags = preview?.warnings.filter(warning => warning.startsWith('Contract address discrepancy:')
    || warning.startsWith('Seller concessions are not confirmed')) || [];

  return <dialog ref={dialogRef} onCancel={event => { event.preventDefault(); onClose(); }} aria-label="Export report to SFREP"
    className="m-auto max-h-[90vh] w-[min(1000px,95vw)] overflow-y-auto rounded-xl border border-amber-300 bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-950/50 print:hidden">
    <header className="flex items-start justify-between gap-3 border-b border-amber-200 bg-gradient-to-r from-violet-100 to-amber-50 px-5 py-4">
      <div><h3 className="text-lg font-semibold text-violet-950">Export to SFREP</h3>
        <p className="mt-1 text-xs text-slate-700">Legacy FNMA 1004 · {SFREP_FORM_ID} · RPTI import file</p></div>
      <button type="button" autoFocus className={secondary} onClick={onClose}>Close</button>
    </header>
    <div className="space-y-4 p-5 text-sm" aria-busy={Boolean(busy)}>
      <p>Choose a report form, then preview the saved HomeNode data and supporting documents. The 1004 URAR export maps the Subject and Contract sections; other report sections will be added as their mappings are completed. Unsaved edits are not exported. This export does not support UAD 3.6.</p>
      <fieldset className="space-y-2 rounded-lg border border-violet-200 bg-violet-50/50 p-3">
        <legend className="px-1 font-semibold text-violet-950">Report form</legend>
        <label className="flex items-center gap-2"><input type="radio" name="sfrep-report-form" checked readOnly />1004 URAR — Subject and Contract sections available</label>
        <label className="flex items-center gap-2 text-slate-500"><input type="radio" name="sfrep-report-form" disabled />2055 Exterior Only — coming next</label>
      </fieldset>
      <fieldset disabled={Boolean(busy)} className="space-y-2">
        <legend className="mb-2 font-semibold text-violet-950">1. Select PDF attachments ({selectedIds.length}/10)</legend>
        <div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border border-violet-200 p-3">
          {documents.map(doc => <label key={doc.id} className="flex items-start gap-3 rounded p-1">
            <input type="checkbox" className="checkbox checkbox-sm mt-0.5" checked={selectedIds.includes(doc.id)}
              disabled={selectedIds.length >= 10 && !selectedIds.includes(doc.id)}
              onChange={event => selectDocument(doc.id, event.target.checked)} />
            <span className="min-w-0"><span className="block break-words font-medium">{doc.title || doc.file_name}</span>
              <span className="text-xs text-slate-600">{doc.document_type.replace(/_/g, ' ')} · {doc.processing_status.replace(/_/g, ' ')}</span></span>
          </label>)}
          {documentsLoading ? <p role="status">Loading this file’s documents…</p> : documentLoadError ? (
            <div role="alert" className="space-y-2 text-rose-900">
              <p>Documents could not be loaded: {documentLoadError}</p>
              {onRetryDocuments && <button type="button" className={secondary} onClick={onRetryDocuments}>Retry loading documents</button>}
            </div>
          ) : !documents.length && <p>No source PDFs are available for attachment. Saved HomeNode report fields can still be previewed and exported.</p>}
        </div>
        <label className="flex items-start gap-3 pt-2"><input type="checkbox" className="checkbox checkbox-sm" checked={includeDocuments}
          onChange={event => { if (!requestRef.current) { invalidate(); setIncludeDocuments(event.target.checked); } }} />
          <span>Include original PDFs as report addenda</span></label>
        <label className="flex items-start gap-3 pt-2"><input type="checkbox" className="checkbox checkbox-sm" checked={includeDiscrepancyAddendum}
          onChange={event => { if (!requestRef.current) { invalidate(); setIncludeDiscrepancyAddendum(event.target.checked); } }} />
          <span>Include one combined evidence-discrepancy addendum when supported, reviewed conflicts are present</span></label>
        <p className="text-xs text-slate-600">This optional page groups supported discrepancy statements together. Review its exact wording in the preview; original documents and HomeNode subject identity are unchanged.</p>
        <p className="text-xs text-slate-600">Supported, reviewed evidence from this HomeNode workfile fills the form whether or not its PDF is attached. These checkboxes only choose which original PDFs become visible report pages in SFREP. Upload CAD and Realist reference PDFs using “Other Appraisal Document.” Fields without a supported mapping remain in their source documents. Maximum: 10 documents and 50 MiB of original PDFs per export.</p>
      </fieldset>
      <button type="button" className={secondary} disabled={Boolean(busy) || documentsLoading || Boolean(documentLoadError)} onClick={() => void run('preview')}>
        {busy === 'preview' ? 'Preparing preview…' : 'Preview SFREP export'}
      </button>
      {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-rose-900">{error}</p>}
      {preview && <section className="space-y-3 rounded-xl border border-violet-200 p-4" aria-label="SFREP export preview">
        <h4 className="font-semibold text-violet-950">2. Review export</h4>
        {preview.savedReport && <p className="text-xs text-slate-600">Saved HomeNode file {preview.savedReport.assignmentFileId} · Subject revision {preview.savedReport.subjectRevision} · Assignment revision {preview.savedReport.assignmentRevision}</p>}
        <p>{preview.fields.length} mapped field(s) · {includeDocuments ? preview.documents.length : 0} original PDF(s) included</p>
        {preview.wordProcessingAddendum && <section aria-label="Evidence discrepancy addendum" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
          <h5 className="font-semibold">One combined addendum page — review before export</h5>
          <p className="mt-1 whitespace-pre-wrap">{preview.wordProcessingAddendum.text}</p>
        </section>}
        {includeDiscrepancyAddendum && !preview.wordProcessingAddendum && <p className="text-xs text-slate-600">No supported reviewed discrepancy statement was found; no addendum page will be added.</p>}
        <section aria-label="Effective-date context" className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
          <h5 className="font-semibold">Effective-date context</h5>
          {preview.effectiveDateContext.effectiveDate ? <>
            <p className="font-medium">{preview.effectiveDateContext.isPlaceholder ? 'Placeholder effective date — review required' : preview.effectiveDateContext.source === 'inspection_date' ? 'Inspection date' : 'Assignment effective date'}: {preview.effectiveDateContext.effectiveDate}</p>
            {preview.effectiveDateContext.isPlaceholder && <p>Using the document upload date (UTC), not a confirmed inspection or appraisal effective date. Confirm the effective date before relying on the listing determination.</p>}
            {preview.effectiveDateContext.sourceDocumentId !== null && <p>Date source: {documentTitle(preview.effectiveDateContext.sourceDocumentId)}</p>}
            <p>Prior 12-calendar-month window: {preview.effectiveDateContext.windowStart} through {preview.effectiveDateContext.windowEnd}.</p>
          </> : <p>Effective date unavailable — review needed. A date-based 12-month listing determination cannot be made.</p>}
          <p>This context evaluates listing history; it does not mark the Subject section complete.</p>
        </section>
        {reviewAssumptions.length > 0 && <section aria-label="Assumptions requiring confirmation" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
          <h5 className="font-semibold">Assumptions requiring confirmation</h5>
          <ul className="mt-1 list-disc space-y-1 pl-5">{reviewAssumptions.map((assumption, index) => <li key={`${assumption.fieldId}:${index}`}>{assumption.reason}</li>)}</ul>
        </section>}
        {contractFlags.length > 0 && <section role="alert" aria-label="Contract review flags" className="rounded-lg border border-amber-400 bg-amber-50 p-3 text-xs text-amber-950">
          <h5 className="font-semibold">Contract review flags — check mapped fields below</h5>
          <ul className="mt-1 list-disc space-y-1 pl-5">{contractFlags.map((flag, index) => <li key={index}>{flag}</li>)}</ul>
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
        <section aria-label="1004 Contract export checklist" className="space-y-2">
          <h5 className="font-semibold text-violet-950">1004 Contract export checklist</h5>
          <p className="text-xs text-slate-600">Keep one subject purchase contract in this workfile and confirm its extracted terms in the Document Evidence Center. Attaching its PDF is optional. Uploading alone does not certify that the appraiser analyzed the contract. Missing terms are left blank for review.</p>
          <div className="overflow-x-auto"><table className="w-full text-left text-xs">
            <caption className="sr-only">Contract-section export coverage and items requiring review</caption>
            <thead><tr className="border-b border-violet-200"><th scope="col" className="p-2">Contract item</th><th scope="col" className="p-2">Export status / value</th><th scope="col" className="p-2">Review notes</th></tr></thead>
            <tbody>{contractChecklist.map(item => <tr key={item.key} className="border-b border-slate-100 align-top">
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
            <td className="max-w-sm break-words p-2" title={field.candidateId !== null ? `Candidate ${field.candidateId}` : undefined}>{field.provenance.kind === 'saved_report' ? 'Saved HomeNode report' : field.provenance.kind === 'account_reference' ? 'Canonical county account' : documentTitle(field.documentId)}<span className="mt-1 block text-slate-600">{sfrepProvenanceText(field)}</span></td>
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
      {preparedDownload && <div role="status" className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-900">
        <p>RPTI prepared. If no download appeared, use the save link below. Import the saved .rpti file into SFREP, then verify the imported fields and attached documents.</p>
        <a className={`${secondary} inline-flex`} href={preparedDownload.url} download={preparedDownload.filename}>Save prepared RPTI</a>
        <p className="text-xs">Keep this dialog open until you have saved the file.</p>
      </div>}
      <p className="text-xs text-slate-500">The download does not change HomeNode report fields or send data directly to SFREP. Keep the RPTI file private; it may contain borrower and assignment information.</p>
    </div>
  </dialog>;
}
