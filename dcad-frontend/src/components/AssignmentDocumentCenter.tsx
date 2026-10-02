import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { useApplicationAuth } from '@/features/auth/ApplicationAuth';
import SfrepExportDialog from '@/features/sfrep/SfrepExportDialog';
import AssignmentDocumentUploadQueue from './documents/AssignmentDocumentUploadQueue';
import {
  confirmAllAssignmentDocumentCandidates,
  confirmAssignmentDocumentDespiteSubjectMismatch,
  deleteAssignmentDocument,
  getAssignmentDocument,
  getAssignmentDocumentContent,
  getAssignmentDocuments,
  reprocessAssignmentDocument,
  reviewAssignmentDocumentCandidate,
  uploadAssignmentDocument,
  type AssignmentDocument,
  type AssignmentDocumentApplication,
  type AssignmentDocumentCandidate,
  type AssignmentDocumentType,
} from '@/lib/api';
import {
  assignmentDocumentConfirmationBlocked,
  confirmedDocumentFieldApplications,
  documentSubjectAddressComparison,
} from '@/lib/propertyReportPresentation';
import {
  applyUadDocumentCandidate,
  confirmAllUadPurchaseContractCandidates,
  confirmUadDocumentDespiteSubjectMismatch,
  deleteUadDocument,
  getUadDocument,
  getUadDocumentContent,
  listUadDocuments,
  reprocessUadDocument,
  reviewUadDocumentCandidate,
  synchronizeUadPurchaseContract,
  uploadUadDocument,
  type UadEvidenceDocument,
  type UadDocumentApplicationResult,
} from '@/features/uad/api';

type EvidenceDocument = AssignmentDocument & Partial<UadEvidenceDocument>;
type DocumentReviewOperation = {
  scope: string;
  documentId: number;
  selectionEpoch: number;
  candidateIds: ReadonlySet<number>;
};

const AssignmentPdfPreview = lazy(() => import('./documents/AssignmentPdfPreview'));
const EMPTY_EDITOR_KEY = () => '';

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
  contract_property_condition: 'Property Condition Provision',
  contract_repairs: 'Seller Repairs / Treatments',
  contract_personal_property_included: 'Personal Property Conveyed',
  contract_personal_property_details: 'Personal Property Included in Sale',
  contract_exclusions: 'Contract Section 2D Exclusions',
  seller_name: 'Seller',
  buyer_name: 'Buyer / Borrower',
  borrower_name: 'Borrower',
  owner_name: 'Owner of Public Record',
  assessor_parcel_number: 'Assessor Parcel Number',
  county: 'County',
  legal_description: 'Legal Description',
  neighborhood_name: 'Recorded Subdivision / Neighborhood',
  tax_year: 'Real Estate Tax Year',
  tax_amount: 'Real Estate Taxes',
  hoa_dues_amount: 'HOA Dues',
  hoa_frequency: 'HOA Dues Frequency',
  pud: 'Explicit PUD Status (true / false)',
  lender_client_name: 'Lender / Client',
  lender_client_address: 'Lender / Client Address',
  subject_property_address: 'Assignment Property Address',
  subject_street_address: 'Subject Street Address',
  subject_city: 'Subject City',
  subject_state: 'Subject State',
  subject_zip: 'Subject ZIP Code',
  mls_number: 'MLS Number',
  listing_status: 'Listing Status',
  list_price: 'Current / Final List Price (LP)',
  original_list_price: 'Starting List Price (OLP)',
  list_date: 'Listing Start Date (LD)',
  listing_end_date: 'Listing End / Close Date',
  days_on_market: 'Days on Market (DOM)',
  financing_type: 'Financing Type',
  assignment_type: 'Assignment Type',
};

function uadSectionLabel(section: UadDocumentApplicationResult['section']) {
  if (section === 'subject_listing_information') return 'Subject Listing Information (Section 19)';
  if (section === 'sales_contract') return 'Sales Contract';
  return 'Assignment Information';
}

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
  uadWorkfileId?: string | null;
  subjectAddress?: string;
  getEditorKey?: () => string;
  onApplyConfirmedCandidate?: (
    fieldKey: string,
    value: string,
    documentType: AssignmentDocumentType,
  ) => void;
  onCustomAssignmentApplied?: (application: AssignmentDocumentApplication) => void;
  onUadApplied?: (result: UadDocumentApplicationResult) => void;
  className?: string;
  embedded?: boolean;
  defaultOpen?: boolean;
  readOnly?: boolean;
}

export default function AssignmentDocumentCenter({
  accountId,
  assignmentFileId = null,
  uadWorkfileId = null,
  subjectAddress = '',
  getEditorKey = EMPTY_EDITOR_KEY,
  onApplyConfirmedCandidate,
  onCustomAssignmentApplied,
  onUadApplied,
  className = '',
  embedded = false,
  defaultOpen = false,
  readOnly = false,
}: AssignmentDocumentCenterProps) {
  const { session } = useApplicationAuth();
  const isUad = Boolean(uadWorkfileId);
  const uploadScopeReady = isUad || (Number.isSafeInteger(assignmentFileId) && Number(assignmentFileId) > 0);
  const defaultReviewer = session?.display_name?.trim() || session?.email?.trim() || '';
  const [open, setOpen] = useState(defaultOpen);
  const [sfrepOpen, setSfrepOpen] = useState(false);
  const [documents, setDocuments] = useState<EvidenceDocument[]>([]);
  const [selectedDocument, setSelectedDocument] = useState<EvidenceDocument | null>(null);
  const selectedDocumentRef = useRef(selectedDocument);
  selectedDocumentRef.current = selectedDocument;
  const selectedDocumentScopeRef = useRef<string | null>(null);
  const [reviewer, setReviewer] = useState(() => defaultReviewer.trim());
  const reviewerInputId = useId();
  const [reviewerAnimationEnabled, setReviewerAnimationEnabled] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? !window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false
  ));
  const [candidateValues, setCandidateValues] = useState<Record<number, string>>({});
  const candidateEditVersionsRef = useRef(new Map<number, number>());
  const candidateEditSequenceRef = useRef(0);
  const [sourcePdf, setSourcePdf] = useState<{ scope: string; documentId: number; blob: Blob } | null>(null);
  const sourcePdfRef = useRef(sourcePdf);
  sourcePdfRef.current = sourcePdf;
  const [documentLoading, setLoading] = useState(false);
  const [reviewLocks, setReviewLocks] = useState<DocumentReviewOperation[]>([]);
  const reviewLocksRef = useRef(new Set<DocumentReviewOperation>());
  const pendingReviewRef = useRef<DocumentReviewOperation | null>(null);
  const selectionEpochRef = useRef(0);
  const renderedSelectionEpoch = selectionEpochRef.current;
  const [message, setMessage] = useState('');
  const discrepancyDocumentCount = isUad
    ? documents.filter((document) => (document.uad_discrepancies?.length || 0) > 0).length
    : 0;
  const scopeKey = isUad
    ? `uad:${uadWorkfileId || ''}`
    : `custom:${accountId}:${assignmentFileId ?? ''}`;
  const currentScopeKeyRef = useRef(scopeKey);
  currentScopeKeyRef.current = scopeKey;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const mountedRef = useRef(true);
  const lastUploadedRef = useRef<{ scope: string; id: number } | null>(null);
  const loadDocumentRequestRef = useRef(0);
  const reviewOperationIsCurrent = useCallback((operation: DocumentReviewOperation) => (
    mountedRef.current && pendingReviewRef.current === operation
    && currentScopeKeyRef.current === operation.scope
    && selectionEpochRef.current === operation.selectionEpoch
    && selectedDocumentScopeRef.current === operation.scope
    && selectedDocumentRef.current?.id === operation.documentId
  ), []);
  const reviewIsPending = () => [...reviewLocksRef.current].some(operation => (
    operation.scope === currentScopeKeyRef.current && selectedDocumentScopeRef.current === operation.scope
    && operation.documentId === selectedDocumentRef.current?.id
  ));
  const reviewCanContinue = (operation: DocumentReviewOperation) => reviewOperationIsCurrent(operation) && !readOnlyRef.current;
  const loading = documentLoading || reviewLocks.some(operation => operation.scope === scopeKey && operation.documentId === selectedDocument?.id);
  const invalidateReviewSelection = useCallback(() => {
    selectionEpochRef.current += 1;
    pendingReviewRef.current = null;
  }, []);
  const beginReview = (candidates: AssignmentDocumentCandidate[]) => {
    if (!mountedRef.current || readOnlyRef.current || currentScopeKeyRef.current !== scopeKey
      || renderedSelectionEpoch !== selectionEpochRef.current || !selectedDocument
      || selectedDocumentScopeRef.current !== scopeKey || selectedDocumentRef.current?.id !== selectedDocument.id
      || reviewIsPending()) return null;
    const operation: DocumentReviewOperation = {
      scope: scopeKey, documentId: selectedDocument.id, selectionEpoch: selectionEpochRef.current,
      candidateIds: new Set(candidates.flatMap(candidate => candidate.id ? [candidate.id] : [])),
    };
    pendingReviewRef.current = operation;
    reviewLocksRef.current.add(operation);
    setReviewLocks([...reviewLocksRef.current]);
    return operation;
  };
  const finishReview = (operation: DocumentReviewOperation) => {
    // Navigation invalidates completion effects, not an already-sent write.
    // Release only this operation's locks, even if another document is active.
    reviewLocksRef.current.delete(operation);
    if (mountedRef.current) setReviewLocks([...reviewLocksRef.current]);
    if (!reviewOperationIsCurrent(operation)) return;
    pendingReviewRef.current = null;
    setLoading(false);
  };
  const candidateIsSaving = (id?: number) => Boolean(id && reviewLocks.some(operation => operation.scope === scopeKey
    && operation.documentId === selectedDocument?.id && operation.candidateIds.has(id)));
  const editCandidateValue = (id: number, value: string) => {
    if (!mountedRef.current || readOnlyRef.current || currentScopeKeyRef.current !== scopeKey
      || renderedSelectionEpoch !== selectionEpochRef.current || selectedDocumentScopeRef.current !== scopeKey
      || selectedDocumentRef.current?.id !== selectedDocument?.id
      || !selectedDocumentRef.current?.candidates?.some(candidate => candidate.id === id && candidate.review_status === 'suggested')
      || [...reviewLocksRef.current].some(operation => operation.scope === scopeKey
        && operation.documentId === selectedDocument?.id && operation.candidateIds.has(id))) return;
    candidateEditVersionsRef.current.set(id, ++candidateEditSequenceRef.current);
    setCandidateValues(current => ({ ...current, [id]: value }));
  };
  const snapshotCandidateEdits = (candidates: AssignmentDocumentCandidate[]) => {
    const ids = new Set(candidates.map(candidate => candidate.id));
    return new Map([...candidateEditVersionsRef.current].filter(([id]) => ids.has(id)));
  };
  const refreshCandidateValues = useCallback((document: EvidenceDocument) => {
    const candidates = (document.candidates || [])
      .filter((candidate): candidate is AssignmentDocumentCandidate & { id: number } => Boolean(candidate.id));
    const available = new Set(candidates.map(candidate => candidate.id));
    for (const id of candidateEditVersionsRef.current.keys()) {
      if (!available.has(id)) candidateEditVersionsRef.current.delete(id);
    }
    const dirty = new Set(candidateEditVersionsRef.current.keys());
    setCandidateValues(current => Object.fromEntries(candidates.map(candidate => [candidate.id,
      dirty.has(candidate.id) && Object.hasOwn(current, candidate.id) ? current[candidate.id]
        : candidate.confirmed_value ?? candidate.normalized_value ?? candidate.raw_value])));
  }, []);
  const clearSavedCandidateEdits = (documentId: number, submitted: ReadonlyMap<number, number>, ids: Iterable<number> = submitted.keys()) => {
    if (!mountedRef.current || currentScopeKeyRef.current !== scopeKey || selectedDocumentScopeRef.current !== scopeKey
      || selectedDocumentRef.current?.id !== documentId) return;
    for (const id of ids) {
      // A save acknowledges the submitted edit, never a newer edit made while
      // that save was in flight (even if both edits happen to have equal text).
      if (submitted.has(id) && candidateEditVersionsRef.current.get(id) === submitted.get(id)) candidateEditVersionsRef.current.delete(id);
    }
  };
  const documentSubjectCandidate = useMemo(
    () => selectedDocument?.candidates?.find((candidate) => (
      candidate.field_key === 'subject_property_address'
    )) || null,
    [selectedDocument],
  );
  const subjectAddressComparison = useMemo(() => documentSubjectAddressComparison(
    documentSubjectCandidate?.confirmed_value
      || documentSubjectCandidate?.normalized_value
      || documentSubjectCandidate?.raw_value,
    subjectAddress,
  ), [documentSubjectCandidate, subjectAddress]);
  const subjectAddressOverride = selectedDocument?.extraction_summary?.subject_address_override;
  const subjectAddressMismatch = subjectAddressComparison.matches === false;
  const confirmationBlocked = assignmentDocumentConfirmationBlocked(
    selectedDocument?.document_type,
    subjectAddressComparison.matches,
    Boolean(subjectAddressOverride?.acknowledged),
  );
  const reviewableCandidates = useMemo(
    () => (selectedDocument?.candidates || []).filter((candidate) => !(
      isUad
      && selectedDocument?.document_type === 'purchase_contract'
      && candidate.field_key === 'assignment_type'
    )),
    [isUad, selectedDocument],
  );
  const suggestedCandidates = useMemo(
    () => reviewableCandidates.filter((candidate) => (
      candidate.review_status === 'suggested'
    )),
    [reviewableCandidates],
  );
  const reviewedCandidates = useMemo(
    () => reviewableCandidates.filter((candidate) => (
      candidate.review_status !== 'suggested'
    )),
    [reviewableCandidates],
  );
  const hasUnsavedCandidateValue = (id?: number) => Boolean(id
    && candidateEditVersionsRef.current.has(id) && Object.hasOwn(candidateValues, id));
  const hasUnsavedReviewedValues = reviewedCandidates.some(candidate => hasUnsavedCandidateValue(candidate.id));
  const confirmedCandidateCount = reviewedCandidates.filter((candidate) => (
    candidate.review_status === 'confirmed'
  )).length;
  const rejectedCandidateCount = reviewedCandidates.filter((candidate) => (
    candidate.review_status === 'rejected'
  )).length;

  const requireMutableWorkfile = () => {
    if (!readOnlyRef.current) return true;
    setMessage('This appraisal workfile is locked. Document evidence remains available for review, but it cannot be changed.');
    return false;
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingReviewRef.current = null;
      selectionEpochRef.current += 1;
      loadDocumentRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const authenticatedReviewer = defaultReviewer.trim();
    if (!authenticatedReviewer) return;
    setReviewer((current) => current.trim() || authenticatedReviewer);
  }, [defaultReviewer]);

  useEffect(() => {
    loadDocumentRequestRef.current += 1;
    invalidateReviewSelection();
    setSfrepOpen(false);
    setDocuments([]);
    setSelectedDocument(null);
    selectedDocumentScopeRef.current = null;
    candidateEditVersionsRef.current.clear();
    setCandidateValues({});
    lastUploadedRef.current = null;
    setMessage('');
    setLoading(false);
    setSourcePdf(null);
  }, [invalidateReviewSelection, scopeKey]);

  const loadDocuments = useCallback(async (reviewOperation?: DocumentReviewOperation) => {
    if (!accountId) return;
    const requestedScopeKey = scopeKey;
    const requestIsCurrent = () => mountedRef.current && currentScopeKeyRef.current === requestedScopeKey
      && (!reviewOperation || reviewOperationIsCurrent(reviewOperation));
    if (!requestIsCurrent()) return;
    setLoading(true);
    setMessage('');
    try {
      const editorKey = getEditorKey();
      if (!isUad && !editorKey) return;
      const loaded: EvidenceDocument[] = isUad && uadWorkfileId
        ? await listUadDocuments(uadWorkfileId)
        : await getAssignmentDocuments(accountId, editorKey, assignmentFileId);
      if (!requestIsCurrent()) return;
      setDocuments(loaded);
      if (selectedDocumentRef.current?.id) {
        const selectedId = selectedDocumentRef.current.id;
        const matching = loaded.find((document) => document.id === selectedId);
        if (!matching) {
          invalidateReviewSelection();
          setSelectedDocument(null);
          candidateEditVersionsRef.current.clear();
          setCandidateValues({});
          setLoading(false);
        }
        else if (isUad) setSelectedDocument((current) => current?.id === matching.id
          ? { ...current, uad_discrepancies: matching.uad_discrepancies,
              uad_comparison_incomplete: matching.uad_comparison_incomplete }
          : current);
      }
    } catch (error) {
      if (!requestIsCurrent()) return;
      setMessage(error instanceof Error ? error.message : 'Documents could not be loaded.');
    } finally {
      if (requestIsCurrent()) setLoading(false);
    }
  }, [accountId, assignmentFileId, getEditorKey, invalidateReviewSelection, isUad, reviewOperationIsCurrent, scopeKey, uadWorkfileId]);

  const loadDocument = useCallback(async (documentId: number, expectedPollRequest?: number, reviewOperation?: DocumentReviewOperation) => {
    const requestedScopeKey = scopeKey;
    const metadataOnly = expectedPollRequest !== undefined;
    if (!mountedRef.current || currentScopeKeyRef.current !== requestedScopeKey) return;
    if (reviewOperation && !reviewOperationIsCurrent(reviewOperation)) return;
    if (metadataOnly && (loadDocumentRequestRef.current !== expectedPollRequest
      || selectedDocumentScopeRef.current !== requestedScopeKey
      || selectedDocumentRef.current?.id !== documentId
      || !['uploaded', 'processing'].includes(selectedDocumentRef.current.processing_status))) return;
    // User selection, including A -> B -> A, invalidates saves immediately.
    // Metadata polls and a save's own refresh are not new selections.
    if (!metadataOnly && !reviewOperation) invalidateReviewSelection();
    const requestId = loadDocumentRequestRef.current + 1;
    loadDocumentRequestRef.current = requestId;
    const requestIsCurrent = () => (
      mountedRef.current && currentScopeKeyRef.current === requestedScopeKey
      && loadDocumentRequestRef.current === requestId
      && (!reviewOperation || reviewOperationIsCurrent(reviewOperation))
    );
    // Original PDFs are immutable. Keep the loaded bytes during extraction polls,
    // but never show a previous document's PDF beside another document's fields.
    const cached = sourcePdfRef.current;
    const cachedBlob = cached?.scope === requestedScopeKey && cached.documentId === documentId
      ? cached.blob : null;
    if (!metadataOnly && !cachedBlob) setSourcePdf(null);
    const sameDocument = selectedDocumentScopeRef.current === requestedScopeKey
      && selectedDocumentRef.current?.id === documentId;
    if (!sameDocument) {
      selectedDocumentScopeRef.current = null;
      candidateEditVersionsRef.current.clear();
      setSelectedDocument(null);
      setCandidateValues({});
    }
    setLoading(true);
    if (!metadataOnly) setMessage('');
    try {
      const editorKey = getEditorKey();
      if (!isUad && !editorKey) return;
      const [documentResult, contentResult] = await Promise.allSettled([
        isUad && uadWorkfileId
          ? getUadDocument(uadWorkfileId, documentId)
          : getAssignmentDocument(documentId, editorKey),
        metadataOnly || cachedBlob ? Promise.resolve(cachedBlob) : isUad && uadWorkfileId
          ? getUadDocumentContent(uadWorkfileId, documentId)
          : getAssignmentDocumentContent(documentId, editorKey),
      ]);
      if (documentResult.status === 'rejected') throw documentResult.reason;
      if (!requestIsCurrent()) return;
      const document: EvidenceDocument = documentResult.value;
      selectedDocumentScopeRef.current = requestedScopeKey;
      setSelectedDocument(document);
      if (isUad) setDocuments((current) => current.map((item) => item.id === document.id
        ? { ...item, uad_discrepancies: document.uad_discrepancies,
            uad_comparison_incomplete: document.uad_comparison_incomplete }
        : item));
      // Explicit edit intent survives even when an intermediate server refresh
      // happens to match the draft. Only save/reset acknowledges that intent.
      refreshCandidateValues(document);
      if (!metadataOnly && contentResult.status === 'fulfilled' && contentResult.value) {
        setSourcePdf({ scope: requestedScopeKey, documentId, blob: contentResult.value });
      } else if (!metadataOnly && contentResult.status === 'rejected') {
        setSourcePdf(null);
        const previewError = contentResult.reason instanceof Error
          ? contentResult.reason.message
          : 'The source PDF preview is temporarily unavailable.';
        setMessage(`Document information loaded for review, but the source PDF preview could not be opened: ${previewError}`);
      }
    } catch (error) {
      if (!requestIsCurrent()) return;
      setMessage(error instanceof Error ? error.message : 'The document could not be loaded.');
    } finally {
      if (requestIsCurrent()) setLoading(false);
    }
  }, [getEditorKey, invalidateReviewSelection, isUad, refreshCandidateValues, reviewOperationIsCurrent, scopeKey, uadWorkfileId]);

  useEffect(() => {
    if (isUad || embedded || open) void loadDocuments();
  }, [embedded, isUad, open, loadDocuments]);

  useEffect(() => {
    if (!selectedDocument || !['uploaded', 'processing'].includes(selectedDocument.processing_status)) return;
    const requestId = loadDocumentRequestRef.current;
    const timer = window.setTimeout(() => void loadDocument(selectedDocument.id, requestId), 1800);
    return () => window.clearTimeout(timer);
  }, [loadDocument, selectedDocument]);

  const uploadQueuedDocument = async (
    file: File,
    metadata: { documentType: AssignmentDocumentType; title: string },
  ) => {
    const requestedScopeKey = scopeKey;
    if (!mountedRef.current || readOnlyRef.current || !uploadScopeReady || currentScopeKeyRef.current !== requestedScopeKey) {
      throw new Error('The active workfile changed or is locked. No upload was started.');
    }
    const editorKey = getEditorKey();
    if (!isUad && !editorKey) throw new Error('Sign in before uploading documents.');
    const input = { ...metadata, uploadedBy: reviewer };
    const document = isUad && uadWorkfileId
      ? await uploadUadDocument(uadWorkfileId, file, input)
      : await uploadAssignmentDocument(accountId, file, { ...input, assignmentFileId }, editorKey);
    if (!mountedRef.current || currentScopeKeyRef.current !== requestedScopeKey) return;
    setDocuments((current) => [...current.filter((item) => item.id !== document.id), document]);
    lastUploadedRef.current = { scope: requestedScopeKey, id: document.id };
  };

  const completeQueuedUpload = async () => {
    const requestedScopeKey = scopeKey;
    if (!mountedRef.current || currentScopeKeyRef.current !== requestedScopeKey) return;
    const lastUploaded = lastUploadedRef.current;
    lastUploadedRef.current = null;
    await loadDocuments();
    if (!mountedRef.current || currentScopeKeyRef.current !== requestedScopeKey) return;
    if (lastUploaded?.scope === requestedScopeKey) await loadDocument(lastUploaded.id);
  };

  const reviewCandidate = async (
    candidate: AssignmentDocumentCandidate,
    reviewStatus: 'confirmed' | 'rejected',
  ) => {
    if (!requireMutableWorkfile()) return;
    if (!selectedDocument || !candidate.id) return;
    if (!reviewer.trim()) {
      setMessage('Enter the appraiser or reviewer name before confirming extracted data.');
      return;
    }
    const editorKey = getEditorKey();
    if (!isUad && !editorKey) return;
    const operation = beginReview([candidate]);
    if (!operation) return;
    const submittedEdits = snapshotCandidateEdits([candidate]);
    setLoading(true);
    setMessage('');
    try {
      const confirmedValue = candidateValues[candidate.id] ?? candidate.raw_value;
      const reviewInput = {
        reviewStatus,
        confirmedValue,
        reviewer: reviewer.trim(),
      } as const;
      let customApplication: AssignmentDocumentApplication | undefined;
      if (isUad && uadWorkfileId) {
        await reviewUadDocumentCandidate(
          uadWorkfileId,
          selectedDocument.id,
          candidate.id,
          reviewInput,
        );
        if (!reviewCanContinue(operation)) return;
        clearSavedCandidateEdits(selectedDocument.id, submittedEdits, [candidate.id]);
      } else {
        const reviewed = await reviewAssignmentDocumentCandidate(
          selectedDocument.id,
          candidate.id,
          reviewInput,
          editorKey,
        );
        if (!reviewCanContinue(operation)) return;
        clearSavedCandidateEdits(selectedDocument.id, submittedEdits, [candidate.id]);
        if (reviewed.assignment_application) {
          customApplication = reviewed.assignment_application;
          onCustomAssignmentApplied?.(reviewed.assignment_application);
        }
      }
      if (!reviewCanContinue(operation)) return;
      if (reviewStatus === 'confirmed') {
        if (isUad && uadWorkfileId) {
          const result = await applyUadDocumentCandidate(uadWorkfileId, selectedDocument.id, candidate.id);
          if (!reviewCanContinue(operation)) return;
          onUadApplied?.(result);
          setMessage(result.applied
            ? `Candidate confirmed and applied to UAD ${uadSectionLabel(result.section)}.`
            : 'Candidate confirmed with its source page retained. This evidence has no direct UAD form mapping.');
        } else if (!customApplication) {
          onApplyConfirmedCandidate?.(candidate.field_key, confirmedValue, selectedDocument.document_type);
        }
      }
      if (!reviewCanContinue(operation)) return;
      await loadDocument(selectedDocument.id, undefined, operation);
      if (!reviewCanContinue(operation)) return;
      await loadDocuments(operation);
      if (!reviewCanContinue(operation)) return;
      if (reviewStatus === 'rejected') {
        setMessage('Candidate rejected; the source PDF remains unchanged.');
      } else if (!isUad) {
        setMessage(customApplication?.applied
          ? 'Candidate confirmed and synchronized with Assignment Details and Contract Analysis.'
          : 'Candidate confirmed with its exact source page retained.');
      }
    } catch (error) {
      if (!reviewOperationIsCurrent(operation)) return;
      setMessage(error instanceof Error ? error.message : 'The review could not be saved.');
    } finally {
      finishReview(operation);
    }
  };

  const reprocess = async () => {
    if (reviewIsPending()) return;
    if (!requireMutableWorkfile()) return;
    if (!selectedDocument) return;
    const editorKey = getEditorKey();
    if (!isUad && !editorKey) return;
    setLoading(true);
    try {
      const document = isUad && uadWorkfileId
        ? await reprocessUadDocument(uadWorkfileId, selectedDocument.id)
        : await reprocessAssignmentDocument(selectedDocument.id, editorKey);
      setSelectedDocument(document);
      refreshCandidateValues(document);
      await loadDocuments();
      if (isUad) await loadDocument(document.id);
      setMessage('Extraction completed with the current document rules.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The document could not be reprocessed.');
    } finally {
      setLoading(false);
    }
  };

  const deleteFromFile = async () => {
    if (reviewIsPending()) return;
    if (!requireMutableWorkfile()) return;
    if (!selectedDocument) return;
    const confirmed = window.confirm(
      `Permanently delete "${selectedDocument.title}" from this appraisal file?\n\n`
        + 'The PDF, extracted fields, and review history will be removed from HomeNode and cannot be recovered.',
    );
    if (!confirmed) return;
    const editorKey = getEditorKey();
    if (!isUad && !editorKey) return;
    const deletedId = selectedDocument.id;
    const deletedTitle = selectedDocument.title;
    setLoading(true);
    setMessage('');
    try {
      if (isUad && uadWorkfileId) {
        await deleteUadDocument(uadWorkfileId, deletedId);
      } else {
        await deleteAssignmentDocument(deletedId, editorKey);
      }
      setDocuments((current) => current.filter((document) => document.id !== deletedId));
      setSelectedDocument(null);
      candidateEditVersionsRef.current.clear();
      setCandidateValues({});
      setSourcePdf(null);
      setMessage(`"${deletedTitle}" was permanently deleted from this appraisal file.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The document could not be deleted.');
    } finally {
      setLoading(false);
    }
  };

  const applyConfirmedDocumentFields = (document: AssignmentDocument, operation?: DocumentReviewOperation) => {
    if (operation ? !reviewCanContinue(operation) : reviewIsPending()) return 0;
    if (!requireMutableWorkfile()) return 0;
    const applications = confirmedDocumentFieldApplications(document.candidates);
    applications.forEach(({ fieldKey, value }) => {
      if (operation && !reviewCanContinue(operation)) return;
      onApplyConfirmedCandidate?.(fieldKey, value, document.document_type);
    });
    return applications.length;
  };

  const applyConfirmedCandidateToUad = async (candidate: AssignmentDocumentCandidate, operation?: DocumentReviewOperation) => {
    if (operation ? !reviewCanContinue(operation) : reviewIsPending()) return null;
    if (!requireMutableWorkfile()) return null;
    if (!uadWorkfileId || !selectedDocument || !candidate.id) return null;
    const result = await applyUadDocumentCandidate(uadWorkfileId, selectedDocument.id, candidate.id);
    if (readOnlyRef.current || (operation && !reviewOperationIsCurrent(operation))) return null;
    onUadApplied?.(result);
    return result;
  };

  const synchronizeReviewedUadPurchaseContract = async () => {
    if (reviewIsPending()) return;
    if (!requireMutableWorkfile()) return;
    if (!uadWorkfileId || !selectedDocument || selectedDocument.document_type !== 'purchase_contract') return;
    setLoading(true);
    setMessage('');
    try {
      const result = await synchronizeUadPurchaseContract(uadWorkfileId, selectedDocument.id);
      onUadApplied?.(result);
      setMessage(result.changed_field_count
        ? `Approved contract information synchronized with UAD Sections 2 and 20 (${result.changed_field_count} updated field${result.changed_field_count === 1 ? '' : 's'}).`
        : 'Approved contract information is already synchronized with UAD Sections 2 and 20.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The approved contract information could not be synchronized with UAD.');
    } finally {
      setLoading(false);
    }
  };

  const approveAllSuggestedFields = async () => {
    if (!requireMutableWorkfile()) return;
    if (!selectedDocument || !suggestedCandidates.length) return;
    if (!reviewer.trim()) {
      setMessage('Enter the appraiser or reviewer name before approving extracted fields.');
      return;
    }
    if (confirmationBlocked) {
      setMessage('Resolve the engagement-letter subject mismatch before approving extracted fields.');
      return;
    }
    const editorKey = getEditorKey();
    if (!isUad && !editorKey) return;
    const operation = beginReview(suggestedCandidates);
    if (!operation) return;
    const submittedEdits = snapshotCandidateEdits(suggestedCandidates);
    setLoading(true);
    setMessage('');
    try {
      if (isUad && uadWorkfileId) {
        if (selectedDocument.document_type === 'purchase_contract') {
          const response = await confirmAllUadPurchaseContractCandidates(
            uadWorkfileId,
            selectedDocument.id,
            {
              reviewer: reviewer.trim(),
              reportSubjectAddress: subjectAddress,
              candidateValues,
            },
          );
          if (!reviewCanContinue(operation)) return;
          clearSavedCandidateEdits(selectedDocument.id, submittedEdits);
          loadDocumentRequestRef.current += 1;
          setSelectedDocument(response.document);
          refreshCandidateValues(response.document);
          onUadApplied?.(response.application);
          if (!reviewCanContinue(operation)) return;
          await loadDocuments(operation);
          if (!reviewCanContinue(operation)) return;
          setMessage(
            `${suggestedCandidates.length} extracted contract field${suggestedCandidates.length === 1 ? '' : 's'} approved and synchronized with UAD Assignment Information and Sales Contract.`,
          );
          return;
        }
        let applied = 0;
        for (const candidate of suggestedCandidates) {
          if (!reviewCanContinue(operation)) return;
          if (!candidate.id) continue;
          await reviewUadDocumentCandidate(
            uadWorkfileId,
            selectedDocument.id,
            candidate.id,
            {
              reviewStatus: 'confirmed',
              confirmedValue: candidateValues[candidate.id] ?? candidate.raw_value,
              reviewer: reviewer.trim(),
            },
          );
          if (!reviewCanContinue(operation)) return;
          clearSavedCandidateEdits(selectedDocument.id, submittedEdits, [candidate.id]);
          const result = await applyConfirmedCandidateToUad(candidate, operation);
          if (!reviewCanContinue(operation)) return;
          if (result?.applied) applied += 1;
        }
        await loadDocument(selectedDocument.id, undefined, operation);
        if (!reviewCanContinue(operation)) return;
        await loadDocuments(operation);
        if (!reviewCanContinue(operation)) return;
        setMessage(
          `${suggestedCandidates.length} extracted field${suggestedCandidates.length === 1 ? '' : 's'} approved`
            + `${applied ? ` and ${applied} supported value${applied === 1 ? '' : 's'} applied to the canonical UAD workfile` : ''}.`,
        );
        return;
      }
      const response = await confirmAllAssignmentDocumentCandidates(selectedDocument.id, {
        reviewer: reviewer.trim(),
        reportSubjectAddress: subjectAddress,
        candidateValues,
      }, editorKey);
      if (!reviewCanContinue(operation)) return;
      clearSavedCandidateEdits(selectedDocument.id, submittedEdits);
      const { document } = response;
      if (response.assignmentApplication) {
        onCustomAssignmentApplied?.(response.assignmentApplication);
      } else {
        applyConfirmedDocumentFields(document, operation);
      }
      if (!reviewCanContinue(operation)) return;
      loadDocumentRequestRef.current += 1;
      setSelectedDocument(document);
      refreshCandidateValues(document);
      await loadDocuments(operation);
      if (!reviewCanContinue(operation)) return;
      setMessage(
        `${suggestedCandidates.length} extracted field${suggestedCandidates.length === 1 ? '' : 's'} approved`
          + ' and synchronized with Assignment Details and Contract Analysis.',
      );
    } catch (error) {
      if (!reviewOperationIsCurrent(operation)) return;
      const errorMessage = error instanceof Error ? error.message : 'The extracted fields could not be approved.';
      setMessage(errorMessage === 'document_subject_address_mismatch'
        ? 'The engagement-letter address differs from this report. Use Upload Anyway only after verifying the assignment.'
        : errorMessage);
    } finally {
      finishReview(operation);
    }
  };

  const uploadAnyway = async () => {
    if (!requireMutableWorkfile()) return;
    if (!selectedDocument) return;
    if (!reviewer.trim()) {
      setMessage('Enter the appraiser or reviewer name before overriding the address warning.');
      return;
    }
    const editorKey = getEditorKey();
    if (!isUad && !editorKey) return;
    const submittedCandidates = (selectedDocument.candidates || []).filter(candidate => candidate.review_status === 'suggested');
    const operation = beginReview(submittedCandidates);
    if (!operation) return;
    const submittedEdits = snapshotCandidateEdits(submittedCandidates);
    setLoading(true);
    setMessage('');
    try {
      const overrideInput = {
        reviewer: reviewer.trim(),
        reportSubjectAddress: subjectAddress,
        candidateValues,
      };
      const document = isUad && uadWorkfileId
        ? await confirmUadDocumentDespiteSubjectMismatch(
            uadWorkfileId,
            selectedDocument.id,
            overrideInput,
          )
        : await confirmAssignmentDocumentDespiteSubjectMismatch(
            selectedDocument.id,
            overrideInput,
            editorKey,
          );
      if (!reviewCanContinue(operation)) return;
      clearSavedCandidateEdits(selectedDocument.id, submittedEdits);
      if (isUad) {
        for (const candidate of document.candidates || []) {
          if (!reviewCanContinue(operation)) return;
          if (candidate.review_status === 'confirmed' && candidate.id) {
            await applyConfirmedCandidateToUad(candidate, operation);
          }
        }
      } else {
        applyConfirmedDocumentFields(document, operation);
      }
      if (!reviewCanContinue(operation)) return;
      loadDocumentRequestRef.current += 1;
      setSelectedDocument(document);
      refreshCandidateValues(document);
      await loadDocuments(operation);
      if (!reviewCanContinue(operation)) return;
      setMessage(isUad
        ? 'Override recorded. Supported, appraiser-confirmed evidence was applied to the canonical UAD workfile.'
        : 'Override recorded. Extracted assignment fields were added to the current draft; save Assignment Details to retain them.');
    } catch (error) {
      if (!reviewOperationIsCurrent(operation)) return;
      setMessage(error instanceof Error ? error.message : 'The address override could not be saved.');
    } finally {
      finishReview(operation);
    }
  };

  return (
    <section
      className={embedded
        ? className
        : `hn-custom-section ${open ? 'hn-custom-section-active' : ''} rounded-2xl border ${className}`}
      data-section-expanded={embedded || open ? 'true' : 'false'}
    >
      {!embedded ? <button
        type="button"
        className={`hn-custom-section-header ${open ? 'hn-custom-section-header-active' : ''} flex w-full items-center justify-between gap-4 px-5 py-4 text-left`}
        onClick={() => setOpen((value) => !value)}
      >
        <span>
          <span className="hn-custom-section-title block text-sm font-semibold uppercase tracking-[0.12em]">
            Document Evidence Center
          </span>
          <span className="hn-custom-section-subtitle mt-1 block text-xs">
            {isUad
              ? 'Private PDFs with page-cited suggestions that require appraiser confirmation before UAD fields change'
              : 'Zoning records, contracts, engagement letters, MLS sheets, maps, and other assignment PDFs'}
          </span>
        </span>
        <span className={open ? 'hn-action-gold rounded-lg px-3 py-2 text-xs font-semibold' : 'hn-action-secondary rounded-lg px-3 py-2 text-xs font-semibold'}>
          {open ? 'Close Documents' : `Review Documents${documents.length ? ` (${documents.length})` : ''}`}
          {discrepancyDocumentCount > 0 ? ` · ${discrepancyDocumentCount} with discrepancies` : ''}
        </span>
      </button> : null}

      {embedded || open ? (
        <div className={embedded ? '' : 'border-t border-slate-200 p-5'}>
          {!isUad && assignmentFileId ? <div className="mb-3 flex justify-end">
            <button type="button" className="hn-action-gold btn btn-sm rounded-lg normal-case" disabled={loading || !documents.length}
              onClick={() => setSfrepOpen(true)}>Export to SFREP</button>
          </div> : null}
          {readOnly ? (
            <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
              Document changes are unavailable while this workfile is locked or its status is being verified. Existing documents remain available for review and download.
            </p>
          ) : null}
          <AssignmentDocumentUploadQueue
            key={scopeKey}
            disabled={readOnly || !uploadScopeReady}
            onUpload={uploadQueuedDocument}
            onComplete={completeQueuedUpload}
          />

          <div className="mt-4 grid gap-4 xl:grid-cols-[16rem_minmax(0,1fr)]">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-semibold text-slate-900">{isUad ? 'UAD Workfile Documents' : 'Property File Documents'}</h4>
                <button type="button" className="hn-action-secondary btn btn-xs shrink-0 rounded-lg normal-case" onClick={() => void loadDocuments()} disabled={loading}>Refresh</button>
              </div>
              {documents.length ? documents.map((document) => (
                <button key={document.id} type="button" onClick={() => void loadDocument(document.id)} aria-pressed={selectedDocument?.id === document.id} className="hn-document-choice w-full rounded-lg border p-3 text-left transition">
                  <span className="hn-document-choice-title block truncate text-sm font-semibold">{document.title}</span>
                  <span className="hn-document-choice-detail mt-1 block text-[11px]">{fileSize(document.file_size_bytes)} · {document.page_count || 'Pending'} page(s)</span>
                  <span className={`mt-2 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusStyle(document.processing_status)}`}>
                    {statusLabel(document.processing_status)}
                  </span>
                  {isUad && document.uad_discrepancies?.length ? (
                    <span className="ml-1 mt-2 inline-flex rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-900">
                      {document.uad_discrepancies.length} discrepanc{document.uad_discrepancies.length === 1 ? 'y' : 'ies'}
                    </span>
                  ) : null}
                </button>
              )) : (
                <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-xs leading-5 text-slate-600">No PDFs have been attached to this appraisal file yet.</p>
              )}
            </div>

            <div className="min-w-0">
              {selectedDocument && sourcePdf?.scope === scopeKey && sourcePdf.documentId === selectedDocument.id ? (
                <Suspense fallback={<p role="status">Loading PDF viewer…</p>}>
                  <AssignmentPdfPreview key={`${scopeKey}:${selectedDocument.id}`} blob={sourcePdf.blob} title={selectedDocument.title} />
                </Suspense>
              ) : selectedDocument ? (
                <div className="flex h-64 items-center justify-center rounded-lg border border-amber-300 bg-amber-50 p-5 text-center text-sm text-amber-900">
                  The document details are available below. The immutable source PDF preview is temporarily unavailable; select the document again to retry it.
                </div>
              ) : (
                <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-center text-sm text-slate-600">Select a document to view the immutable source PDF.</div>
              )}
            </div>

            <div className="min-w-0 space-y-3 xl:col-span-2">
              <div className="hn-document-reviewer hn-evidence-reviewer-frame block rounded-xl p-3" data-reviewer-animation={reviewerAnimationEnabled ? 'on' : 'off'}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <label htmlFor={reviewerInputId} className="hn-document-reviewer-label text-xs font-semibold uppercase tracking-wide">Appraiser / Reviewer</label>
                  <button type="button" className="hn-action-secondary btn btn-xs rounded-lg normal-case" aria-pressed={reviewerAnimationEnabled} onClick={() => setReviewerAnimationEnabled((enabled) => !enabled)}>
                    {reviewerAnimationEnabled ? 'Pause glow' : 'Animate glow'}
                  </button>
                </div>
                <span className="hn-evidence-reviewer-input-ring">
                  <input id={reviewerInputId} className="hn-evidence-reviewer-input input input-sm w-full bg-white" value={reviewer} onChange={(event) => setReviewer(event.target.value)} placeholder="Required to confirm suggestions" disabled={readOnly} />
                </span>
              </div>
              {selectedDocument ? (
                <>
                  {isUad && selectedDocument.uad_discrepancies?.length ? (
                    <div role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-xs leading-5 text-rose-950">
                      <strong>Document facts need appraiser review</strong>
                      <p>These extracted values differ from another uploaded document or the saved HomeNode subject record. Check the cited PDF pages before confirming or using them.</p>
                      <ul className="mt-2 space-y-2">
                        {selectedDocument.uad_discrepancies.map((item, index) => (
                          <li key={`${item.field_key}-${item.other_document_id}-${index}`} className="rounded border border-rose-200 bg-white p-2">
                            <strong>{item.field_label}:</strong> this document says “{item.document_value}”{item.document_page ? ` (page ${item.document_page})` : ''};{' '}
                            {item.source === 'saved_subject_record' ? 'saved HomeNode subject record' : item.other_document_title} says “{item.other_value}”{item.other_page ? ` (page ${item.other_page})` : ''}.
                            {item.other_document_id ? (
                              <button type="button" className="ml-1 font-semibold underline" onClick={() => void loadDocument(item.other_document_id as number)}>
                                View other document
                              </button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {isUad && selectedDocument.uad_comparison_incomplete ? (
                    <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
                      Document comparison is incomplete while extraction is pending, text is unavailable, or a large evidence set exceeds the review scan. Review the source PDFs directly.
                    </p>
                  ) : null}
                  <div className={`rounded-lg p-3 text-xs leading-5 ${statusStyle(selectedDocument.processing_status)}`}>
                    <strong>{statusLabel(selectedDocument.processing_status)}</strong>
                    <p>{selectedDocument.extraction_summary?.review_reason || 'Every machine suggestion remains separate from appraiser-confirmed data.'}</p>
                    {processingDetail(selectedDocument) ? <p>{processingDetail(selectedDocument)}</p> : null}
                    {selectedDocument.last_processing_error ? (
                      <p className="mt-1 break-words">Last error: {selectedDocument.last_processing_error}</p>
                    ) : null}
                    {!['uploaded', 'processing'].includes(selectedDocument.processing_status) ? (
                      <button type="button" className="hn-action-primary btn btn-primary btn-xs mt-2 normal-case rounded-lg" onClick={() => void reprocess()} disabled={readOnly || loading}>
                        {['ocr_required', 'extraction_failed'].includes(selectedDocument.processing_status)
                          ? 'Retry Extraction'
                          : 'Re-run Extraction'}
                      </button>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="hn-document-delete btn btn-sm w-full normal-case rounded-lg"
                    onClick={() => void deleteFromFile()}
                    disabled={readOnly || loading}
                  >
                    Delete From File
                  </button>
                  {selectedDocument.document_type === 'engagement_letter' ? (
                    documentSubjectCandidate ? (
                      <div
                        role={subjectAddressMismatch ? 'alert' : undefined}
                        className={`rounded-lg border p-3 text-xs leading-5 ${subjectAddressMismatch
                          ? 'border-rose-300 bg-rose-50 text-rose-900'
                          : subjectAddressComparison.matches === true
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                            : 'border-amber-200 bg-amber-50 text-amber-900'}`}
                      >
                        <strong>
                          {subjectAddressMismatch
                            ? subjectAddressOverride?.acknowledged
                              ? 'Assignment address mismatch — override recorded'
                              : 'Assignment address mismatch'
                            : subjectAddressComparison.matches === true
                              ? 'Assignment address verified'
                              : 'Verify the open report subject address'}
                        </strong>
                        <p>
                          The engagement letter identifies <strong>{subjectAddressComparison.documentAddress}</strong>.
                          {' '}The open report is <strong>{subjectAddressComparison.reportAddress || 'missing its subject address'}</strong>.
                        </p>
                        {confirmationBlocked ? (
                          <>
                            <p>Confirming extracted fields is disabled so information from the wrong assignment cannot populate this file.</p>
                            <button
                              type="button"
                              className="hn-action-primary btn btn-primary btn-xs mt-2 normal-case rounded-lg"
                              onClick={() => void uploadAnyway()}
                              disabled={readOnly || loading}
                            >
                              {loading ? 'Recording Override...' : 'Upload Anyway'}
                            </button>
                            <p className="mt-1">This records the reviewer acknowledgment, confirms the visible suggestions, and keeps the mismatch in the audit record.</p>
                          </>
                        ) : subjectAddressMismatch && subjectAddressOverride?.acknowledged ? (
                          <>
                            <p>
                              Override acknowledged by <strong>{subjectAddressOverride.reviewer || 'the appraiser'}</strong>
                              {subjectAddressOverride.acknowledged_at
                                ? ` on ${new Date(subjectAddressOverride.acknowledged_at).toLocaleString()}`
                                : ''}. The source PDF and CAD subject address were not changed.
                            </p>
                            <button
                              type="button"
                              className="hn-action-primary btn btn-primary btn-xs mt-2 normal-case rounded-lg"
                              onClick={() => void (async () => {
                                if (isUad) {
                                  let applied = 0;
                                  for (const candidate of selectedDocument.candidates || []) {
                                    if (candidate.review_status !== 'confirmed' || !candidate.id) continue;
                                    const result = await applyConfirmedCandidateToUad(candidate);
                                    if (result?.applied) applied += 1;
                                  }
                                  setMessage(applied
                                    ? `Reapplied ${applied} confirmed suggestion${applied === 1 ? '' : 's'} to the canonical UAD workfile.`
                                    : 'This document has no confirmed fields with a direct UAD mapping.');
                                  return;
                                }
                                const applied = applyConfirmedDocumentFields(selectedDocument);
                                setMessage(applied
                                  ? 'Confirmed engagement fields were reapplied to the current assignment draft; save Assignment Details to retain them.'
                                  : 'This document has no confirmed fields to apply.');
                              })()}
                              disabled={readOnly || loading}
                            >
                              Apply Confirmed Fields
                            </button>
                          </>
                        ) : null}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
                        <strong>Verify the assignment address manually.</strong>
                        <p>HomeNode did not find a labeled subject property address in this engagement letter.</p>
                      </div>
                    )
                  ) : null}
                  {suggestedCandidates.length ? (
                    <div className="flex flex-col gap-2 rounded-lg border border-violet-200 bg-violet-50 p-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="text-xs leading-5 text-slate-700">
                        <strong>{suggestedCandidates.length} field{suggestedCandidates.length === 1 ? '' : 's'} awaiting review</strong>
                        <p>Approve every visible value at once, or review the individual suggestions below.</p>
                      </div>
                      <button
                        type="button"
                        className="hn-action-primary btn btn-primary btn-sm normal-case rounded-lg sm:min-w-40"
                        onClick={() => void approveAllSuggestedFields()}
                        disabled={readOnly || loading || confirmationBlocked}
                        title={confirmationBlocked ? 'Resolve the engagement-letter subject mismatch before approving fields.' : undefined}
                      >
                        {loading ? 'Approving...' : `Approve All (${suggestedCandidates.length})`}
                      </button>
                    </div>
                  ) : null}
                  <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                    {suggestedCandidates.length ? suggestedCandidates.map((candidate) => (
                      <div key={candidate.id || `${candidate.field_key}-${candidate.page_number}`} className="rounded-lg border border-slate-200 bg-white p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-700">{FIELD_LABELS[candidate.field_key] || candidate.field_key.replace(/_/g, ' ')}</h5>
                            <p className="mt-1 text-[11px] text-slate-500">Page {candidate.page_number || 'unknown'} · {candidate.confidence == null ? 'Unscored' : `${Math.round(candidate.confidence * 100)}% text match`}</p>
                          </div>
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">Suggested</span>
                        </div>
                        {candidate.field_key === 'contract_personal_property_included' ? (
                          <select
                            className="select select-bordered select-sm mt-2 w-full bg-white"
                            value={candidate.id ? candidateValues[candidate.id] ?? candidate.raw_value : candidate.raw_value}
                            onChange={(event) => candidate.id && editCandidateValue(candidate.id, event.target.value)}
                            disabled={readOnly || candidateIsSaving(candidate.id)}
                            aria-describedby={candidateIsSaving(candidate.id) ? `${reviewerInputId}-saving-${candidate.id}` : undefined}
                          >
                            <option value="Yes">Yes</option>
                            <option value="No">No</option>
                          </select>
                        ) : (
                          <input className="input input-bordered input-sm mt-2 w-full bg-white" value={candidate.id ? candidateValues[candidate.id] ?? candidate.raw_value : candidate.raw_value} onChange={(event) => candidate.id && editCandidateValue(candidate.id, event.target.value)} disabled={readOnly || candidateIsSaving(candidate.id)} aria-describedby={candidateIsSaving(candidate.id) ? `${reviewerInputId}-saving-${candidate.id}` : undefined} />
                        )}
                        {candidateIsSaving(candidate.id) ? <p id={`${reviewerInputId}-saving-${candidate.id}`} role="status" className="mt-2 text-xs text-slate-600">Saving this field. Editing is temporarily disabled.</p> : null}
                        <p className="mt-2 rounded bg-slate-50 p-2 text-[11px] leading-4 text-slate-600">{candidate.evidence_excerpt || candidate.raw_value}</p>
                        {candidate.id ? (
                          <div className="mt-2 flex gap-2">
                            <button
                              type="button"
                              className="hn-action-primary btn btn-primary btn-xs flex-1 normal-case rounded-lg"
                              onClick={() => void reviewCandidate(candidate, 'confirmed')}
                              disabled={readOnly || loading || confirmationBlocked}
                              title={confirmationBlocked ? 'Resolve the engagement-letter subject mismatch before confirming fields.' : undefined}
                            >
                              Confirm
                            </button>
                            <button type="button" className="hn-action-secondary btn btn-outline btn-xs flex-1 normal-case rounded-lg" onClick={() => void reviewCandidate(candidate, 'rejected')} disabled={readOnly || loading}>Reject</button>
                          </div>
                        ) : null}
                        {isUad && candidate.review_status === 'confirmed' && candidate.id ? (
                          <button
                            type="button"
                            className="hn-action-secondary btn btn-outline btn-xs mt-2 w-full normal-case rounded-lg"
                            onClick={() => void (async () => {
                              setLoading(true);
                              setMessage('');
                              try {
                                const result = await applyConfirmedCandidateToUad(candidate);
                                setMessage(result?.applied
                                  ? `Confirmed evidence applied to UAD ${uadSectionLabel(result.section)}.`
                                  : 'This evidence is retained for review but has no direct UAD form mapping.');
                              } catch (error) {
                                setMessage(error instanceof Error ? error.message : 'The confirmed evidence could not be applied to UAD.');
                              } finally {
                                setLoading(false);
                              }
                            })()}
                            disabled={readOnly || loading}
                          >
                            Apply to UAD 3.6
                          </button>
                        ) : null}
                      </div>
                    )) : !reviewableCandidates.length ? (
                      <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3 text-xs leading-5 text-slate-600">No labeled fields were found. Review the visible PDF directly; scanned or blurry pages remain appraiser-review items.</p>
                    ) : null}
                  </div>
                  {reviewedCandidates.length ? (
                    <details open={hasUnsavedReviewedValues || undefined} className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                      <summary className="cursor-pointer text-xs font-semibold text-emerald-900">
                        {hasUnsavedReviewedValues ? 'Reviewed fields — unsaved local edits' : suggestedCandidates.length ? 'Reviewed fields' : 'Review complete'} · {confirmedCandidateCount} approved{rejectedCandidateCount ? ` · ${rejectedCandidateCount} rejected` : ''}
                      </summary>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                        {reviewedCandidates.map((candidate) => (
                          <div key={candidate.id || `${candidate.field_key}-${candidate.page_number}`} className="rounded-md border border-emerald-100 bg-white p-2 text-[11px] leading-4 text-slate-600">
                            <div className="flex items-center justify-between gap-2">
                              <strong className="text-slate-800">{FIELD_LABELS[candidate.field_key] || candidate.field_key.replace(/_/g, ' ')}</strong>
                              <span className={candidate.review_status === 'confirmed' ? 'text-emerald-700' : 'text-slate-500'}>
                                {candidate.review_status === 'confirmed' ? 'Approved' : 'Rejected'}
                              </span>
                            </div>
                            {candidate.review_status === 'confirmed' ? (
                              <p className="mt-1 break-words">{candidate.confirmed_value || candidate.normalized_value || candidate.raw_value}</p>
                            ) : null}
                            {candidate.id && hasUnsavedCandidateValue(candidate.id) ? (
                              <div role="note" aria-label="Unsaved local edit" className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-amber-950">
                                <strong>Unsaved local edit — not submitted or applied</strong>
                                <p className="mt-1 whitespace-pre-wrap break-words">{candidateValues[candidate.id] === '' ? '(empty draft)' : candidateValues[candidate.id]}</p>
                                <p className="mt-1">Copy this draft before leaving this document.</p>
                              </div>
                            ) : null}
                            <p className="mt-1 text-slate-400">Page {candidate.page_number || 'unknown'}</p>
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : null}
                  {isUad
                    && selectedDocument.document_type === 'purchase_contract'
                    && !suggestedCandidates.length
                    && confirmedCandidateCount > 0 ? (
                      <button
                        type="button"
                        className="hn-action-secondary btn btn-outline btn-sm w-full normal-case rounded-lg"
                        onClick={() => void synchronizeReviewedUadPurchaseContract()}
                        disabled={readOnly || loading}
                      >
                        {loading ? 'Synchronizing...' : 'Sync Approved Contract to UAD 3.6'}
                      </button>
                    ) : null}
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
      {sfrepOpen && !isUad && assignmentFileId ? <SfrepExportDialog key={scopeKey}
        accountId={accountId} assignmentFileId={assignmentFileId} documents={documents} getEditorKey={getEditorKey}
        onClose={() => setSfrepOpen(false)} /> : null}
    </section>
  );
}
