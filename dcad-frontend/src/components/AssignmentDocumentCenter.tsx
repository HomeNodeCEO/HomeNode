import { useCallback, useEffect, useState } from 'react';

import {
  getAssignmentDocument,
  getAssignmentDocumentContent,
  getAssignmentDocuments,
  reprocessAssignmentDocument,
  reviewAssignmentDocumentCandidate,
  uploadAssignmentDocument,
  type AssignmentDocument,
  type AssignmentDocumentCandidate,
  type AssignmentDocumentType,
} from '@/lib/api';

const DOCUMENT_TYPE_OPTIONS: Array<[AssignmentDocumentType, string]> = [
  ['zoning_map', 'Zoning Map'],
  ['zoning_ordinance', 'Zoning Ordinance / Code'],
  ['purchase_contract', 'Purchase Contract'],
  ['engagement_letter', 'Engagement Letter'],
  ['mls_sheet', 'MLS Sheet'],
  ['map', 'Other Map'],
  ['other', 'Other Appraisal Document'],
];

const FIELD_LABELS: Record<string, string> = {
  zoning_code: 'Zoning Code',
  zoning_description: 'Verbatim Zoning Description',
  contract_price: 'Contract Price',
  contract_date: 'Contract Date',
  closing_date: 'Closing Date',
  loan_amount: 'Loan Amount',
  down_payment: 'Down Payment',
  earnest_money: 'Earnest Money',
  seller_concessions: 'Seller Concessions',
  seller_name: 'Seller',
  buyer_name: 'Buyer / Borrower',
  lender_client_name: 'Lender / Client',
  lender_client_address: 'Lender / Client Address',
  mls_number: 'MLS Number',
  list_price: 'List Price',
  list_date: 'List Date',
  financing_type: 'Financing Type',
  assignment_type: 'Assignment Type',
};

function statusStyle(status: AssignmentDocument['processing_status']) {
  if (status === 'reviewed') return 'bg-emerald-100 text-emerald-800';
  if (status === 'review_required') return 'bg-amber-100 text-amber-800';
  if (status === 'ocr_required' || status === 'extraction_failed') return 'bg-rose-100 text-rose-800';
  return 'bg-blue-100 text-blue-800';
}

function statusLabel(status: AssignmentDocument['processing_status']) {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (value) => value.toUpperCase());
}

function fileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString()} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function processingDetail(document: AssignmentDocument) {
  if (document.processing_status === 'processing') {
    return `Extraction attempt ${Math.max(1, document.processing_attempts || 1)} is in progress.`;
  }
  if (document.processing_status !== 'extraction_failed') return '';
  if (document.extraction_summary?.automatic_retry_exhausted) {
    return `Automatic retries stopped after ${document.processing_attempts} attempts. Review the PDF or retry manually.`;
  }
  if (document.next_processing_at) {
    const retryAt = new Date(document.next_processing_at);
    if (!Number.isNaN(retryAt.getTime())) {
      return `Automatic retry scheduled for ${retryAt.toLocaleString()}.`;
    }
  }
  return 'Automatic retry is pending, or the appraiser may retry now.';
}

interface AssignmentDocumentCenterProps {
  accountId: string;
  assignmentFileId?: number | null;
  getEditorKey: () => string;
  onApplyConfirmedCandidate?: (
    fieldKey: string,
    value: string,
    documentType: AssignmentDocumentType,
  ) => void;
  className?: string;
}

export default function AssignmentDocumentCenter({
  accountId,
  assignmentFileId = null,
  getEditorKey,
  onApplyConfirmedCandidate,
  className = '',
}: AssignmentDocumentCenterProps) {
  const [open, setOpen] = useState(false);
  const [documents, setDocuments] = useState<AssignmentDocument[]>([]);
  const [selectedDocument, setSelectedDocument] = useState<AssignmentDocument | null>(null);
  const [documentType, setDocumentType] = useState<AssignmentDocumentType>('other');
  const [documentTitle, setDocumentTitle] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [reviewer, setReviewer] = useState('');
  const [candidateValues, setCandidateValues] = useState<Record<number, string>>({});
  const [viewerUrl, setViewerUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const loadDocuments = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setMessage('');
    try {
      const editorKey = getEditorKey();
      if (!editorKey) return;
      const loaded = await getAssignmentDocuments(accountId, editorKey, assignmentFileId);
      setDocuments(loaded);
      if (selectedDocument) {
        const matching = loaded.find((document) => document.id === selectedDocument.id);
        if (!matching) setSelectedDocument(null);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Documents could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [accountId, assignmentFileId, getEditorKey, selectedDocument?.id]);

  const loadDocument = useCallback(async (documentId: number) => {
    setLoading(true);
    setMessage('');
    try {
      const editorKey = getEditorKey();
      if (!editorKey) return;
      const [document, content] = await Promise.all([
        getAssignmentDocument(documentId, editorKey),
        getAssignmentDocumentContent(documentId, editorKey),
      ]);
      setSelectedDocument(document);
      setViewerUrl(URL.createObjectURL(content));
      setCandidateValues(Object.fromEntries(
        (document.candidates || [])
          .filter((candidate): candidate is AssignmentDocumentCandidate & { id: number } => Boolean(candidate.id))
          .map((candidate) => [candidate.id, candidate.confirmed_value || candidate.normalized_value || candidate.raw_value]),
      ));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The document could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [getEditorKey]);

  useEffect(() => {
    if (open) void loadDocuments();
  }, [open, accountId, assignmentFileId]);

  useEffect(() => {
    if (!selectedDocument || !['uploaded', 'processing'].includes(selectedDocument.processing_status)) return;
    const timer = window.setTimeout(() => void loadDocument(selectedDocument.id), 1800);
    return () => window.clearTimeout(timer);
  }, [loadDocument, selectedDocument]);

  useEffect(() => () => {
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  }, [viewerUrl]);

  const upload = async () => {
    if (!selectedFile) {
      setMessage('Choose a PDF before uploading.');
      return;
    }
    if (selectedFile.type && selectedFile.type !== 'application/pdf') {
      setMessage('The document evidence center currently accepts PDF files.');
      return;
    }
    const editorKey = getEditorKey();
    if (!editorKey) return;
    setLoading(true);
    setMessage('');
    try {
      const document = await uploadAssignmentDocument(accountId, selectedFile, {
        assignmentFileId,
        documentType,
        title: documentTitle || selectedFile.name,
        uploadedBy: reviewer,
      }, editorKey);
      setSelectedFile(null);
      setDocumentTitle('');
      await loadDocuments();
      await loadDocument(document.id);
      setMessage('PDF saved. HomeNode is extracting page-cited suggestions for appraiser review.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The PDF could not be uploaded.');
    } finally {
      setLoading(false);
    }
  };

  const reviewCandidate = async (
    candidate: AssignmentDocumentCandidate,
    reviewStatus: 'confirmed' | 'rejected',
  ) => {
    if (!selectedDocument || !candidate.id) return;
    if (!reviewer.trim()) {
      setMessage('Enter the appraiser or reviewer name before confirming extracted data.');
      return;
    }
    const editorKey = getEditorKey();
    if (!editorKey) return;
    setLoading(true);
    setMessage('');
    try {
      const confirmedValue = candidateValues[candidate.id] || candidate.raw_value;
      await reviewAssignmentDocumentCandidate(selectedDocument.id, candidate.id, {
        reviewStatus,
        confirmedValue,
        reviewer: reviewer.trim(),
      }, editorKey);
      if (reviewStatus === 'confirmed') {
        onApplyConfirmedCandidate?.(candidate.field_key, confirmedValue, selectedDocument.document_type);
      }
      await loadDocument(selectedDocument.id);
      await loadDocuments();
      setMessage(reviewStatus === 'confirmed'
        ? 'Candidate confirmed with its exact source page retained.'
        : 'Candidate rejected; the source PDF remains unchanged.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The review could not be saved.');
    } finally {
      setLoading(false);
    }
  };

  const reprocess = async () => {
    if (!selectedDocument) return;
    const editorKey = getEditorKey();
    if (!editorKey) return;
    setLoading(true);
    try {
      const document = await reprocessAssignmentDocument(selectedDocument.id, editorKey);
      setSelectedDocument(document);
      await loadDocuments();
      setMessage('Extraction completed with the current document rules.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The document could not be reprocessed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className={`rounded-2xl border border-slate-200 bg-white shadow-sm ${className}`}>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
        onClick={() => setOpen((value) => !value)}
      >
        <span>
          <span className="block text-sm font-semibold uppercase tracking-[0.12em] text-slate-900">
            Document Evidence Center
          </span>
          <span className="mt-1 block text-xs text-slate-500">
            Zoning records, contracts, engagement letters, MLS sheets, maps, and other assignment PDFs
          </span>
        </span>
        <span className="btn btn-primary btn-sm normal-case rounded-lg">
          {open ? 'Close Documents' : `Review Documents${documents.length ? ` (${documents.length})` : ''}`}
        </span>
      </button>

      {open ? (
        <div className="border-t border-slate-200 p-5">
          <div className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 lg:grid-cols-[13rem_minmax(0,1fr)_minmax(14rem,1fr)_auto] lg:items-end">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Document Type</span>
              <select className="select select-bordered select-sm mt-1 w-full bg-white" value={documentType} onChange={(event) => setDocumentType(event.target.value as AssignmentDocumentType)}>
                {DOCUMENT_TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Title</span>
              <input className="input input-bordered input-sm mt-1 w-full bg-white" value={documentTitle} onChange={(event) => setDocumentTitle(event.target.value)} placeholder="Defaults to the PDF file name" />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">PDF File</span>
              <input className="file-input file-input-bordered file-input-sm mt-1 w-full bg-white" type="file" accept="application/pdf,.pdf" onChange={(event) => setSelectedFile(event.target.files?.[0] || null)} />
            </label>
            <button type="button" className="btn btn-primary btn-sm normal-case rounded-lg" onClick={() => void upload()} disabled={loading || !selectedFile}>
              {loading ? 'Working...' : 'Upload and Analyze'}
            </button>
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-[18rem_minmax(0,1.35fr)_minmax(20rem,0.85fr)]">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-slate-900">Property File Documents</h4>
                <button type="button" className="text-xs font-semibold text-blue-700 hover:underline" onClick={() => void loadDocuments()} disabled={loading}>Refresh</button>
              </div>
              {documents.length ? documents.map((document) => (
                <button key={document.id} type="button" onClick={() => void loadDocument(document.id)} className={`w-full rounded-lg border p-3 text-left transition ${selectedDocument?.id === document.id ? 'border-blue-500 bg-blue-50' : 'border-slate-200 bg-white hover:border-slate-400'}`}>
                  <span className="block truncate text-sm font-semibold text-slate-900">{document.title}</span>
                  <span className="mt-1 block text-[11px] text-slate-500">{fileSize(document.file_size_bytes)} · {document.page_count || 'Pending'} page(s)</span>
                  <span className={`mt-2 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusStyle(document.processing_status)}`}>
                    {statusLabel(document.processing_status)}
                  </span>
                </button>
              )) : (
                <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-xs leading-5 text-slate-600">No PDFs have been attached to this appraisal file yet.</p>
              )}
            </div>

            <div className="min-w-0">
              {selectedDocument ? (
                <iframe title={selectedDocument.title} src={`/pdfjs-viewer.html?file=${encodeURIComponent(viewerUrl)}`} className="h-[38rem] w-full rounded-lg border border-slate-300 bg-slate-100" />
              ) : (
                <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-center text-sm text-slate-600">Select a document to view the immutable source PDF.</div>
              )}
            </div>

            <div className="min-w-0 space-y-3">
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Appraiser / Reviewer</span>
                <input className="input input-bordered input-sm mt-1 w-full bg-white" value={reviewer} onChange={(event) => setReviewer(event.target.value)} placeholder="Required to confirm suggestions" />
              </label>
              {selectedDocument ? (
                <>
                  <div className={`rounded-lg p-3 text-xs leading-5 ${statusStyle(selectedDocument.processing_status)}`}>
                    <strong>{statusLabel(selectedDocument.processing_status)}</strong>
                    <p>{selectedDocument.extraction_summary?.review_reason || 'Every machine suggestion remains separate from appraiser-confirmed data.'}</p>
                    {processingDetail(selectedDocument) ? <p>{processingDetail(selectedDocument)}</p> : null}
                    {selectedDocument.last_processing_error ? (
                      <p className="mt-1 break-words">Last error: {selectedDocument.last_processing_error}</p>
                    ) : null}
                    {['ocr_required', 'extraction_failed'].includes(selectedDocument.processing_status) ? (
                      <button type="button" className="btn btn-primary btn-xs mt-2 normal-case rounded-lg" onClick={() => void reprocess()} disabled={loading}>Retry Extraction</button>
                    ) : null}
                  </div>
                  <div className="space-y-3">
                    {(selectedDocument.candidates || []).length ? selectedDocument.candidates?.map((candidate) => (
                      <div key={candidate.id || `${candidate.field_key}-${candidate.page_number}`} className="rounded-lg border border-slate-200 bg-white p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-700">{FIELD_LABELS[candidate.field_key] || candidate.field_key.replace(/_/g, ' ')}</h5>
                            <p className="mt-1 text-[11px] text-slate-500">Page {candidate.page_number || 'unknown'} · {candidate.confidence == null ? 'Unscored' : `${Math.round(candidate.confidence * 100)}% text match`}</p>
                          </div>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${candidate.review_status === 'confirmed' ? 'bg-emerald-100 text-emerald-800' : candidate.review_status === 'rejected' ? 'bg-slate-200 text-slate-700' : 'bg-amber-100 text-amber-800'}`}>
                            {candidate.review_status || 'suggested'}
                          </span>
                        </div>
                        <input className="input input-bordered input-sm mt-2 w-full bg-white" value={candidate.id ? candidateValues[candidate.id] ?? candidate.raw_value : candidate.raw_value} onChange={(event) => candidate.id && setCandidateValues((current) => ({ ...current, [candidate.id as number]: event.target.value }))} disabled={candidate.review_status === 'rejected'} />
                        <p className="mt-2 rounded bg-slate-50 p-2 text-[11px] leading-4 text-slate-600">{candidate.evidence_excerpt || candidate.raw_value}</p>
                        {candidate.review_status === 'suggested' && candidate.id ? (
                          <div className="mt-2 flex gap-2">
                            <button type="button" className="btn btn-primary btn-xs flex-1 normal-case rounded-lg" onClick={() => void reviewCandidate(candidate, 'confirmed')} disabled={loading}>Confirm</button>
                            <button type="button" className="btn btn-outline btn-xs flex-1 normal-case rounded-lg" onClick={() => void reviewCandidate(candidate, 'rejected')} disabled={loading}>Reject</button>
                          </div>
                        ) : null}
                      </div>
                    )) : (
                      <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3 text-xs leading-5 text-slate-600">No labeled fields were found. Review the visible PDF directly; scanned or blurry pages remain appraiser-review items.</p>
                    )}
                  </div>
                  {(selectedDocument.review_history || []).length ? (
                    <details className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-700">
                        Review history ({selectedDocument.review_history?.length})
                      </summary>
                      <div className="mt-2 space-y-2">
                        {selectedDocument.review_history?.map((review) => (
                          <div key={review.id} className="rounded bg-white p-2 text-[11px] leading-4 text-slate-600">
                            <strong className="text-slate-800">{FIELD_LABELS[review.field_key] || review.field_key.replace(/_/g, ' ')}</strong>
                            {' · '}{review.review_status} by {review.reviewer}
                            {' · '}{new Date(review.reviewed_at).toLocaleString()}
                            {review.confirmed_value ? <div>Confirmed value: {review.confirmed_value}</div> : null}
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
          {message ? <p className="mt-4 text-xs font-medium text-slate-700">{message}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
