import { useCallback, useEffect, useState } from 'react';

import type {
  AssignmentDocument,
  PropertyTaxProtestFile,
} from '@/lib/api';
import {
  deletePropertyTaxDocument,
  getPropertyTaxDocument,
  getPropertyTaxDocumentContent,
  getPropertyTaxDocuments,
  reprocessPropertyTaxDocument,
  uploadPropertyTaxDocument,
} from '@/lib/propertyTaxApi';
import { editorCredentialForRequest } from '@/lib/editorCredential';
import {
  districtEvidenceGridRows,
  type PropertyTaxComparableGridRow,
} from '@/lib/propertyTaxComparableGrid';

type DocumentKind = 'district_evidence' | 'mls_sheet' | 'other';

function statusLabel(value: AssignmentDocument['processing_status']): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function PropertyTaxEvidenceDocumentCenter({
  accountId,
  file,
  onDistrictComparables,
}: {
  accountId: string;
  file: PropertyTaxProtestFile;
  onDistrictComparables: (rows: PropertyTaxComparableGridRow[]) => void;
}) {
  const [open, setOpen] = useState(true);
  const [documents, setDocuments] = useState<AssignmentDocument[]>([]);
  const [selectedDocument, setSelectedDocument] = useState<AssignmentDocument | null>(null);
  const [viewerUrl, setViewerUrl] = useState('');
  const [documentType, setDocumentType] = useState<DocumentKind>('district_evidence');
  const [title, setTitle] = useState('');
  const [reviewer, setReviewer] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const selectedDocumentId = selectedDocument?.id || null;

  const stageDistrictComparables = useCallback(async (loaded: AssignmentDocument[]) => {
    const districtDocuments = loaded.filter((document) => (
      document.document_type === 'district_evidence'
      && !['uploaded', 'processing'].includes(document.processing_status)
    ));
    if (!districtDocuments.length) return;
    const detailed = await Promise.all(districtDocuments.map((document) => (
      getPropertyTaxDocument(accountId, file.tax_protest_file_id, document.id)
    )));
    const rows = detailed.flatMap(districtEvidenceGridRows);
    if (rows.length) onDistrictComparables(rows);
  }, [accountId, file.tax_protest_file_id, onDistrictComparables]);

  const loadDocuments = useCallback(async () => {
    setBusy(true);
    setMessage('');
    try {
      const loaded = await getPropertyTaxDocuments(accountId, file.tax_protest_file_id);
      setDocuments(loaded);
      await stageDistrictComparables(loaded);
      if (selectedDocumentId) {
        const current = loaded.find((document) => document.id === selectedDocumentId);
        if (!current) setSelectedDocument(null);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Property Tax documents could not be loaded.');
    } finally {
      setBusy(false);
    }
  }, [accountId, file.tax_protest_file_id, selectedDocumentId, stageDistrictComparables]);

  const viewDocument = useCallback(async (documentId: number) => {
    setBusy(true);
    setMessage('');
    try {
      const [document, content] = await Promise.all([
        getPropertyTaxDocument(accountId, file.tax_protest_file_id, documentId),
        getPropertyTaxDocumentContent(accountId, file.tax_protest_file_id, documentId),
      ]);
      if (viewerUrl) URL.revokeObjectURL(viewerUrl);
      setViewerUrl(URL.createObjectURL(content));
      setSelectedDocument(document);
      const rows = districtEvidenceGridRows(document);
      if (rows.length) onDistrictComparables(rows);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The PDF could not be opened.');
    } finally {
      setBusy(false);
    }
  }, [accountId, file.tax_protest_file_id, onDistrictComparables, viewerUrl]);

  useEffect(() => {
    if (open) void loadDocuments();
    // Reload only when the selected protest file changes or the center is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, file.tax_protest_file_id, open]);

  useEffect(() => {
    if (!selectedDocument || !['uploaded', 'processing'].includes(selectedDocument.processing_status)) return;
    const timer = window.setTimeout(async () => {
      const refreshed = await getPropertyTaxDocument(accountId, file.tax_protest_file_id, selectedDocument.id).catch(() => null);
      if (!refreshed) return;
      setSelectedDocument(refreshed);
      if (!['uploaded', 'processing'].includes(refreshed.processing_status)) {
        await loadDocuments();
      }
    }, 1_800);
    return () => window.clearTimeout(timer);
  }, [accountId, file.tax_protest_file_id, loadDocuments, selectedDocument]);

  useEffect(() => () => {
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  }, [viewerUrl]);

  const upload = async () => {
    if (!selectedFile) {
      setMessage('Choose a PDF before uploading.');
      return;
    }
    if (selectedFile.type && selectedFile.type !== 'application/pdf') {
      setMessage('The Property Tax document center currently accepts PDF files.');
      return;
    }
    const editorKey = editorCredentialForRequest();
    if (!editorKey) {
      setMessage('Sign in or enter an editor key before uploading evidence.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const document = await uploadPropertyTaxDocument(
        accountId,
        file.tax_protest_file_id,
        selectedFile,
        {
          documentType,
          title: title.trim() || selectedFile.name,
          uploadedBy: reviewer.trim(),
        },
        editorKey,
      );
      setSelectedFile(null);
      setTitle('');
      setSelectedDocument(document);
      await loadDocuments();
      setMessage(documentType === 'district_evidence'
        ? 'District evidence saved. Recognized comparable blocks will be staged in the grid for verification.'
        : 'PDF saved to this Property Tax file.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The PDF could not be uploaded.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (document: AssignmentDocument) => {
    if (!window.confirm(`Delete ${document.title}? This removes the PDF and its extracted suggestions.`)) return;
    const editorKey = editorCredentialForRequest();
    if (!editorKey) {
      setMessage('Sign in or enter an editor key before deleting evidence.');
      return;
    }
    setBusy(true);
    try {
      await deletePropertyTaxDocument(accountId, file.tax_protest_file_id, document.id, editorKey);
      if (selectedDocument?.id === document.id) {
        if (viewerUrl) URL.revokeObjectURL(viewerUrl);
        setViewerUrl('');
        setSelectedDocument(null);
      }
      await loadDocuments();
      setMessage('Document deleted. Saved comparable rows remain until removed from the grid.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The document could not be deleted.');
    } finally {
      setBusy(false);
    }
  };

  const reprocess = async (document: AssignmentDocument) => {
    const editorKey = editorCredentialForRequest();
    if (!editorKey) {
      setMessage('Sign in or enter an editor key before reprocessing evidence.');
      return;
    }
    setBusy(true);
    try {
      const refreshed = await reprocessPropertyTaxDocument(
        accountId,
        file.tax_protest_file_id,
        document.id,
        editorKey,
      );
      setSelectedDocument(refreshed);
      await loadDocuments();
      setMessage('Extraction completed again. Recognized district sales were refreshed in the draft grid.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The document could not be reprocessed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-4 rounded-xl border border-violet-200 bg-violet-50/50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-700">File-scoped source documents</div>
          <h3 className="mt-1 text-lg font-semibold text-slate-950">District evidence &amp; MLS document loader</h3>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            Upload, extract, and view PDFs for {file.file_number}. District comparable suggestions are staged in the grid but require reviewer verification.
          </p>
        </div>
        <button type="button" className="hn-action-secondary rounded-lg px-3 py-2 text-sm font-semibold" onClick={() => setOpen((value) => !value)}>
          {open ? 'Close documents' : `Open documents (${documents.length})`}
        </button>
      </div>

      {open && (
        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(280px,0.8fr)_minmax(420px,1.2fr)]">
          <div className="space-y-3">
            <div className="rounded-xl border border-violet-100 bg-white p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-xs font-medium text-slate-700">
                  Document type
                  <select className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" value={documentType} onChange={(event) => setDocumentType(event.target.value as DocumentKind)}>
                    <option value="district_evidence">District evidence packet</option>
                    <option value="mls_sheet">MLS sheet</option>
                    <option value="other">Other supporting PDF</option>
                  </select>
                </label>
                <label className="text-xs font-medium text-slate-700">
                  Reviewer / uploader
                  <input className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" value={reviewer} onChange={(event) => setReviewer(event.target.value)} />
                </label>
              </div>
              <label className="mt-3 block text-xs font-medium text-slate-700">
                Display title
                <input className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Defaults to the PDF filename" />
              </label>
              <input className="mt-3 block w-full text-xs text-slate-600" type="file" accept="application/pdf,.pdf" onChange={(event) => setSelectedFile(event.target.files?.[0] || null)} />
              <button type="button" className="hn-action-primary mt-3 rounded-lg px-4 py-2 text-sm font-semibold" onClick={() => void upload()} disabled={busy || !selectedFile}>
                {busy ? 'Working…' : 'Upload PDF'}
              </button>
            </div>

            <div className="space-y-2">
              {documents.map((document) => (
                <article key={document.id} className="rounded-lg border border-slate-200 bg-white p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">{document.title}</div>
                      <div className="mt-1 text-xs text-slate-500">{sizeLabel(document.file_size_bytes)} · {statusLabel(document.processing_status)} · {document.candidate_count || 0} suggestion(s)</div>
                    </div>
                    <span className="rounded-full bg-violet-100 px-2 py-1 text-[10px] font-semibold uppercase text-violet-800">{document.document_type.replaceAll('_', ' ')}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" className="hn-action-secondary rounded-md px-2.5 py-1.5 text-xs font-semibold" onClick={() => void viewDocument(document.id)} disabled={busy}>View</button>
                    <button type="button" className="hn-action-secondary rounded-md px-2.5 py-1.5 text-xs font-semibold" onClick={() => void reprocess(document)} disabled={busy}>Reprocess</button>
                    <button type="button" className="rounded-md border border-rose-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-rose-700" onClick={() => void remove(document)} disabled={busy}>Delete</button>
                  </div>
                </article>
              ))}
              {!busy && !documents.length && <p className="rounded-lg border border-dashed border-violet-200 bg-white p-4 text-sm text-slate-600">No PDFs have been uploaded to this protest file.</p>}
            </div>
          </div>

          <div className="min-h-[520px] overflow-hidden rounded-xl border border-slate-200 bg-white">
            {viewerUrl ? (
              <iframe className="h-[68vh] min-h-[520px] w-full" src={viewerUrl} title={selectedDocument?.title || 'Property Tax evidence PDF'} />
            ) : (
              <div className="flex min-h-[520px] items-center justify-center p-8 text-center text-sm text-slate-500">Choose View to open district evidence or an MLS sheet beside the comparable grid.</div>
            )}
          </div>
        </div>
      )}

      {message && <p className="mt-3 rounded-lg border border-violet-100 bg-white px-3 py-2 text-sm text-slate-700">{message}</p>}
    </section>
  );
}
