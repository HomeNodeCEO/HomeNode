import { createHash } from 'node:crypto';
import { loadAssignmentDocumentContent } from './assignmentDocuments.js';
import { buildDeterministicZip } from '../modules/uad/uadDeliveryPackage.js';
import { buildSfrepReportExport, SFREP_PRIMARY_FORM_ID } from './sfrepReportExport.js';

export const SFREP_TRANSFER_LIMITS = Object.freeze({ documents: 10, bytes: 50 * 1024 * 1024, candidatesPerDocument: 200 });
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };

export function sfrepTransferInput(body, { exporting = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('invalid_sfrep_request');
  const allowed = ['assignment_file_id', 'document_ids', 'include_documents', 'form_id', ...(exporting ? ['preview_digest'] : [])];
  if (Object.keys(body).some(key => !allowed.includes(key))) fail('invalid_sfrep_request');
  if (!Number.isSafeInteger(body.assignment_file_id) || body.assignment_file_id < 1) fail('assignment_file_required');
  if (!Array.isArray(body.document_ids) || !body.document_ids.length || body.document_ids.length > SFREP_TRANSFER_LIMITS.documents
    || body.document_ids.some(id => !Number.isSafeInteger(id) || id < 1)
    || new Set(body.document_ids).size !== body.document_ids.length) fail('invalid_sfrep_document_selection');
  if (typeof body.include_documents !== 'boolean' || body.form_id !== SFREP_PRIMARY_FORM_ID) fail('invalid_sfrep_request');
  if (exporting && (typeof body.preview_digest !== 'string' || !/^[a-f0-9]{64}$/.test(body.preview_digest))) fail('sfrep_preview_required');
  return { assignmentFileId: body.assignment_file_id, documentIds: [...body.document_ids].sort((a, b) => a - b),
    includeDocuments: body.include_documents, formId: body.form_id, previewDigest: body.preview_digest };
}

// Read metadata and candidates in one statement so the preview cannot combine
// document versions from separate requests. Every source belongs to this file.
export async function readSfrepDocuments(pool, { accountId, assignmentFileId, documentIds }) {
  const { rows } = await pool.query({ text: `
    SELECT document.id, document.account_id, document.assignment_file_id,
           document.document_type, document.title, document.file_name, document.content_type,
           document.file_size_bytes, document.checksum_sha256, document.processing_status,
           document.extraction_summary, document.updated_at,
           COALESCE(evidence.candidates, '[]'::json) AS candidates
      FROM app.assignment_documents document
      LEFT JOIN LATERAL (
        SELECT json_agg(candidate ORDER BY candidate.id) AS candidates FROM (
          SELECT id, document_id, field_key, raw_value, normalized_value, confirmed_value,
                 review_status, page_number, reviewer, reviewed_at
            FROM app.assignment_document_field_candidates
           WHERE document_id = document.id ORDER BY id LIMIT $4
        ) candidate
      ) evidence ON true
     WHERE document.account_id = $1 AND document.assignment_file_id = $2
       AND document.uad_workfile_id IS NULL AND document.tax_protest_file_id IS NULL
       AND document.id = ANY($3::bigint[]) ORDER BY document.id`,
    values: [accountId, assignmentFileId, documentIds, SFREP_TRANSFER_LIMITS.candidatesPerDocument + 1],
  });
  if (rows.length !== documentIds.length) fail('sfrep_document_not_found');
  const documents = rows.map(row => ({ ...row, id: Number(row.id), assignment_file_id: Number(row.assignment_file_id),
    file_size_bytes: Number(row.file_size_bytes) }));
  for (const document of documents) {
    if (document.account_id !== accountId || document.assignment_file_id !== assignmentFileId
      || !documentIds.includes(document.id)) fail('sfrep_document_not_found');
    if (!Array.isArray(document.candidates) || document.candidates.length > SFREP_TRANSFER_LIMITS.candidatesPerDocument) fail('sfrep_evidence_limit');
    if (!Number.isSafeInteger(document.file_size_bytes) || document.file_size_bytes < 1
      || document.content_type !== 'application/pdf' || !/^[a-f0-9]{64}$/.test(document.checksum_sha256)) fail('sfrep_document_integrity_failed');
  }
  if (Buffer.byteLength(JSON.stringify(documents)) > 8 * 1024 * 1024) fail('sfrep_evidence_limit');
  return documents;
}

export function previewSfrepDocuments(documents, input) {
  const bytes = documents.reduce((total, document) => total + document.file_size_bytes, 0);
  if (input.includeDocuments && bytes > SFREP_TRANSFER_LIMITS.bytes) fail('sfrep_package_too_large');
  const pdfAddenda = input.includeDocuments ? documents.map(document => ({
    documentId: document.id, fileName: `document-${document.id}.pdf`, title: document.title || document.file_name,
  })) : [];
  const mapped = buildSfrepReportExport({ documents, pdfAddenda, formId: input.formId });
  // A re-read during download must match the review the user actually saw.
  const previewDigest = digest(JSON.stringify({ accountId: input.accountId, assignmentFileId: input.assignmentFileId,
    documents, includeDocuments: input.includeDocuments, formId: input.formId, reportXml: mapped.reportXml }));
  return { ...mapped, preview_digest: previewDigest, filename: `HomeNode-SFREP-file-${input.assignmentFileId}.rpti`,
    documents: documents.map(({ id, title, file_name, file_size_bytes, processing_status }) =>
      ({ id, title, file_name, file_size_bytes, processing_status })) };
}

export async function packageSfrepDocuments(pool, storage, documents, preview, input, {
  loadContent = loadAssignmentDocumentContent, signal = AbortSignal.timeout(60_000),
} = {}) {
  if (preview.preview_digest !== input.previewDigest) fail('sfrep_preview_changed');
  // Keep the member encoding consistent with the mapper's UTF-8 XML prolog.
  const files = [{ path: 'Report.xml', body: Buffer.from(preview.reportXml, 'utf8') }];
  let totalBytes = files[0].body.length;
  for (const addendum of preview.pdfAddenda) {
    signal.throwIfAborted();
    const expected = documents.find(document => document.id === addendum.documentId);
    const source = await loadContent(pool, addendum.documentId, { storage: storage && {
      configured: storage.configured,
      getObject: options => storage.getObject({ ...options, signal,
        maxBytes: Math.min(expected.file_size_bytes, SFREP_TRANSFER_LIMITS.bytes - totalBytes) }),
    } });
    if (!source || source.account_id !== input.accountId || Number(source.assignment_file_id) !== input.assignmentFileId
      || source.uad_workfile_id || source.tax_protest_file_id || source.checksum_sha256 !== expected?.checksum_sha256
      || !Buffer.isBuffer(source.content) || source.content.length !== expected.file_size_bytes
      || source.content.subarray(0, 5).toString() !== '%PDF-'
      || digest(source.content) !== expected.checksum_sha256) fail('sfrep_document_integrity_failed');
    totalBytes += source.content.length;
    if (totalBytes > SFREP_TRANSFER_LIMITS.bytes) fail('sfrep_package_too_large');
    files.push({ path: `Pdf/${addendum.fileName}`, body: source.content });
  }
  signal.throwIfAborted();
  return buildDeterministicZip(files);
}
