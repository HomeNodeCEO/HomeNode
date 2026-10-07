import { createHash } from 'node:crypto';
import { loadAssignmentDocumentContent } from './assignmentDocuments.js';
import { buildDeterministicZip } from '../modules/uad/uadDeliveryPackage.js';
import { buildSfrepReportExport, SFREP_SUPPORTED_FORM_IDS } from './sfrepReportExport.js';
import { sfrepSubjectContext, sfrepWorkfileDocumentRoles } from './sfrepSubjectContext.js';
import { savedSfrepSubjectFields } from './sfrepSavedReport.js';
import { filterSubjectEvidenceDocuments } from './customSubjectApplication.js';
import { customSubjectCensusSql } from './customSubjectCensus.js';
import { projectSfrepPhotos, loadSfrepPhotoBytes } from './sfrepPhotoTransfer.js';

export const SFREP_TRANSFER_LIMITS = Object.freeze({ documents: 10, bytes: 50 * 1024 * 1024, candidatesPerDocument: 200 });
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function sfrepTransferInput(body, { exporting = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('invalid_sfrep_request');
  const allowed = ['assignment_file_id', 'document_ids', 'include_documents', 'include_photos', 'form_id', ...(exporting ? ['preview_digest'] : [])];
  if (Object.keys(body).some(key => !allowed.includes(key))) fail('invalid_sfrep_request');
  if (!Number.isSafeInteger(body.assignment_file_id) || body.assignment_file_id < 1) fail('assignment_file_required');
  if (!Array.isArray(body.document_ids) || body.document_ids.length > SFREP_TRANSFER_LIMITS.documents
    || body.document_ids.some(id => !Number.isSafeInteger(id) || id < 1)
    || new Set(body.document_ids).size !== body.document_ids.length) fail('invalid_sfrep_document_selection');
  if (typeof body.include_documents !== 'boolean' || !SFREP_SUPPORTED_FORM_IDS.includes(body.form_id)) fail('invalid_sfrep_request');
  if (body.include_photos !== undefined && typeof body.include_photos !== 'boolean') fail('invalid_sfrep_request');
  if (exporting && (typeof body.preview_digest !== 'string' || !/^[a-f0-9]{64}$/.test(body.preview_digest))) fail('sfrep_preview_required');
  return { assignmentFileId: body.assignment_file_id, documentIds: [...body.document_ids].sort((a, b) => a - b),
    includeDocuments: body.include_documents, includePhotos: body.include_photos === true,
    formId: body.form_id, previewDigest: body.preview_digest };
}

// One statement and one shared snapshot: reject oversized evidence in PostgreSQL
// before pg receives/parses JSON, rather than repeating it for each selected PDF.
export async function readSfrepDocuments(pool, { accountId, assignmentFileId, documentIds }) {
  const census = await customSubjectCensusSql(pool);
  const { rows } = await pool.query({ text: `
    WITH assignment_scope AS MATERIALIZED (
      SELECT jsonb_build_object('accountId', subject.account_id, 'address', subject.address,
             'city', subject.city, 'postalCode', subject.postal_code,
             'canonicalIdentity', jsonb_build_object('accountId', subject.account_id,
               'address', subject.address, 'city', subject.city, 'postalCode', subject.postal_code,
               'county', subject.county, 'assessorParcelNumber', subject.account_id,
               'state', to_jsonb(subject)->>'state'),
             'effectiveDate', appraisal_case.effective_date::text,
             'inspectionDate', appraisal_case.inspection_date::text,
             'censusGeography', ${census.value}) AS subject_context,
           jsonb_build_object('accountId', assignment.account_id, 'assignmentFileId', assignment.id,
             'assignmentRevision', assignment.revision, 'assignmentDetails', assignment.assignment_details,
             'subject', jsonb_build_object('value', saved_subject.section_value, 'revision', saved_subject.revision),
             'market', jsonb_build_object('value', saved_market.section_value, 'revision', saved_market.revision),
             'workspace', jsonb_build_object('value', saved_workspace.section_value, 'revision', saved_workspace.revision),
             'evidence', jsonb_build_object('value', saved_evidence.section_value, 'revision', saved_evidence.revision)) AS saved_report
      FROM app.assignment_files assignment
      JOIN core.accounts subject ON subject.account_id = assignment.account_id
      ${census.join}
      LEFT JOIN app.custom_appraisal_sections saved_subject
        ON saved_subject.assignment_file_id = assignment.id AND saved_subject.section_key = 'report.subject_identification'
      LEFT JOIN app.custom_appraisal_sections saved_evidence
        ON saved_evidence.assignment_file_id = assignment.id AND saved_evidence.section_key = 'report.subject_evidence'
      -- Market studies and the retained map checkpoint belong to the workfile
      -- section store, not the document-applied report section store above.
      LEFT JOIN app.custom_appraisal_workfile_sections saved_market
        ON saved_market.assignment_file_id = assignment.id AND saved_market.section_key = 'market_conditions'
      LEFT JOIN app.custom_appraisal_workfile_sections saved_workspace
        ON saved_workspace.assignment_file_id = assignment.id AND saved_workspace.section_key = 'neighborhood_workspace'
      LEFT JOIN app.report_files report_file
        ON report_file.custom_assignment_file_id = assignment.id
       AND report_file.account_id = assignment.account_id
       AND report_file.organization_id IS NOT DISTINCT FROM assignment.organization_id
       AND report_file.workflow_type = 'custom_appraisal'
      LEFT JOIN app.appraisal_cases appraisal_case
        ON appraisal_case.id = report_file.appraisal_case_id
       AND appraisal_case.account_id = assignment.account_id
       AND appraisal_case.organization_id IS NOT DISTINCT FROM assignment.organization_id
      WHERE assignment.account_id = $1 AND assignment.id = $2
    ), scope AS MATERIALIZED (
      SELECT * FROM assignment_scope WHERE (SELECT count(*) FROM assignment_scope) = 1
    ), source_rows AS MATERIALIZED (
      SELECT document.id, document.account_id, document.assignment_file_id,
             document.document_type, document.title, document.file_name, document.content_type,
             document.file_size_bytes, document.checksum_sha256, document.processing_status,
             document.extraction_summary, document.updated_at,
             (document.uploaded_at AT TIME ZONE 'UTC')::date::text AS upload_date,
             COALESCE((SELECT jsonb_agg(candidate ORDER BY candidate.id) FROM (
          SELECT id, document_id, field_key, raw_value, normalized_value, confirmed_value,
                 review_status, page_number, reviewer, reviewed_at, extraction_method
            FROM app.assignment_document_field_candidates
           WHERE document_id = document.id ORDER BY id LIMIT $4
             ) candidate), '[]'::jsonb) AS candidates
        FROM app.assignment_documents document
       WHERE document.account_id = $1 AND document.assignment_file_id = $2
         AND document.uad_workfile_id IS NULL AND document.tax_protest_file_id IS NULL
         AND EXISTS (SELECT 1 FROM scope)
       ORDER BY document.id LIMIT 51
    ), selected_rows AS MATERIALIZED (
      SELECT * FROM source_rows WHERE id = ANY($3::bigint[])
    ), payload AS MATERIALIZED (
      SELECT jsonb_build_object(
        'documents', COALESCE((SELECT jsonb_agg(selected_rows ORDER BY id) FROM selected_rows), '[]'::jsonb),
        'subject_context', scope.subject_context,
        'saved_report', scope.saved_report || jsonb_build_object('documents', COALESCE((
          SELECT jsonb_agg(jsonb_build_object('id', id, 'account_id', account_id, 'assignment_file_id', assignment_file_id,
            'document_type', document_type, 'title', title, 'file_name', file_name,
            'processing_status', processing_status,
            'extraction_summary', extraction_summary, 'checksum_sha256', checksum_sha256,
            'upload_date', upload_date, 'candidates', candidates) ORDER BY id)
          FROM source_rows), '[]'::jsonb))) AS snapshot,
        (SELECT count(*) FROM source_rows) > 50
          OR EXISTS (SELECT 1 FROM source_rows WHERE jsonb_array_length(candidates) >= $4) AS count_limit
      FROM scope
    ), bounded_payload AS MATERIALIZED (
      SELECT snapshot, count_limit OR octet_length(snapshot::text) > $5 AS evidence_limit FROM payload
    )
    SELECT CASE WHEN evidence_limit THEN NULL ELSE snapshot END AS snapshot, evidence_limit FROM bounded_payload`,
    values: [accountId, assignmentFileId, documentIds, SFREP_TRANSFER_LIMITS.candidatesPerDocument + 1, MAX_EVIDENCE_BYTES],
  });
  if (rows.length !== 1) fail('sfrep_document_not_found');
  if (rows[0].evidence_limit === true) fail('sfrep_evidence_limit');
  const snapshot = rows[0].snapshot;
  if (rows[0].evidence_limit !== false || !record(snapshot)) fail('sfrep_invalid_saved_report');
  if (!Array.isArray(snapshot.documents) || snapshot.documents.length !== documentIds.length
    || snapshot.documents.some(document => !record(document))) fail('sfrep_document_not_found');
  const documents = snapshot.documents.map(row => ({ ...row, id: Number(row.id), assignment_file_id: Number(row.assignment_file_id),
    file_size_bytes: Number(row.file_size_bytes), subject_context: snapshot.subject_context }));
  if (new Set(documents.map(document => document.id)).size !== documentIds.length) fail('sfrep_document_not_found');
  for (const document of documents) {
    if (document.account_id !== accountId || document.assignment_file_id !== assignmentFileId
      || !documentIds.includes(document.id)) fail('sfrep_document_not_found');
    if (!Array.isArray(document.candidates) || document.candidates.length > SFREP_TRANSFER_LIMITS.candidatesPerDocument) fail('sfrep_evidence_limit');
    if (!Number.isSafeInteger(document.file_size_bytes) || document.file_size_bytes < 1
      || document.content_type !== 'application/pdf' || !/^[a-f0-9]{64}$/.test(document.checksum_sha256)) fail('sfrep_document_integrity_failed');
  }
  sfrepWorkfileDocumentRoles(documents).forEach((source, index) => { documents[index].property_role = source.property_role; });
  // One statement binds canonical report revisions, current evidence, dates and
  // selected PDF metadata. Keep its shared report snapshot once, not per PDF.
  const saved = snapshot.saved_report;
  if (!record(saved)) fail('sfrep_invalid_saved_report');
  {
    if (!Array.isArray(saved.documents) || saved.documents.length > 50) fail('sfrep_evidence_limit');
    for (const source of saved.documents) {
      source.id = Number(source.id);
      source.assignment_file_id = Number(source.assignment_file_id);
      if (source.account_id !== accountId || source.assignment_file_id !== assignmentFileId
        || !Number.isSafeInteger(source.id) || source.id < 1) fail('sfrep_document_not_found');
      if (!Array.isArray(source.candidates) || source.candidates.length > SFREP_TRANSFER_LIMITS.candidatesPerDocument) fail('sfrep_evidence_limit');
      source.subject_context = snapshot.subject_context;
    }
    sfrepWorkfileDocumentRoles(saved.documents).forEach((source, index) => {
      saved.documents[index].property_role = source.property_role;
    });
    if (documents[0]) documents[0].saved_report = saved;
    // An empty attachment selection still exports the saved, reviewed workfile.
    documents.saved_report = saved;
  }
  if (Buffer.byteLength(JSON.stringify(documents)) > MAX_EVIDENCE_BYTES) fail('sfrep_evidence_limit');
  return documents;
}

export function previewSfrepDocuments(documents, input, photoRows = []) {
  const bytes = documents.reduce((total, document) => total + document.file_size_bytes, 0);
  if (input.includeDocuments && bytes > SFREP_TRANSFER_LIMITS.bytes) fail('sfrep_package_too_large');
  const pdfAddenda = input.includeDocuments ? documents.map(document => ({
    documentId: document.id, fileName: `document-${document.id}.pdf`, title: document.title || document.file_name,
  })) : [];
  const saved = documents.saved_report || documents[0]?.saved_report;
  const subjectContext = sfrepSubjectContext(saved?.documents || documents);
  const canonical = saved ? savedSfrepSubjectFields(saved, input) : null;
  const mapped = buildSfrepReportExport({ documents: filterSubjectEvidenceDocuments(saved?.documents || documents), pdfAddenda, formId: input.formId, subjectContext, subjectOnly: true,
    contractSection: true, savedAssignmentDetails: saved?.assignmentDetails,
    savedAssignmentFileId: saved?.assignmentFileId, savedAssignmentRevision: saved?.assignmentRevision,
    contractEvidenceDocuments: saved?.documents,
    savedNeighborhoodReport: saved,
    ...(canonical ? { savedReportFields: canonical.fields } : {}) });
  if (canonical) {
    mapped.warnings.push(...canonical.warnings);
    mapped.knownMissing.push(...canonical.knownMissing);
  }
  const photoProjection = projectSfrepPhotos(photoRows, input);
  if (photoProjection.formXml.length) {
    mapped.reportXml = mapped.reportXml.replace('  </Forms>', `${photoProjection.formXml.join('\n')}\n  </Forms>`);
  }
  if (photoProjection.photos.some(photo => !photo.included)) {
    mapped.warnings.push('Some inspection photos are not verified and will not be exported. Wait for uploads to finish, then preview again.');
  }
  const photoBytes = photoProjection.imageAddenda.reduce((total, image) => total + image.byteSize, 0);
  if ((input.includeDocuments ? bytes : 0) + photoBytes + Buffer.byteLength(mapped.reportXml) > SFREP_TRANSFER_LIMITS.bytes) fail('sfrep_package_too_large');
  // A re-read during download must match the review the user actually saw.
  const previewDigest = digest(JSON.stringify({ accountId: input.accountId, assignmentFileId: input.assignmentFileId,
    documents, saved, subjectContext, includeDocuments: input.includeDocuments, includePhotos: input.includePhotos === true,
    photos: photoProjection.photos, imageAddenda: photoProjection.imageAddenda, formId: input.formId, reportXml: mapped.reportXml }));
  return { ...mapped, preview_digest: previewDigest,
    photos: photoProjection.photos, imageAddenda: photoProjection.imageAddenda,
    filename: `HomeNode-SFREP-${input.formId === 'FNMA-2055-0911' ? '2055-' : ''}file-${input.assignmentFileId}.rpti`,
    ...(saved ? { savedReport: { assignmentFileId: saved.assignmentFileId, assignmentRevision: saved.assignmentRevision,
      ...(Number.isSafeInteger(saved.market?.revision) && saved.market.revision > 0 ? { marketRevision: saved.market.revision } : {}),
      subjectRevision: Number(saved.subject?.revision || 0), sourceDocumentIds: saved.documents.map(document => document.id) } } : {}),
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
  for (const image of preview.imageAddenda || []) {
    const content = await loadSfrepPhotoBytes(storage, image, { signal,
      maxBytes: SFREP_TRANSFER_LIMITS.bytes - totalBytes });
    totalBytes += content.length;
    if (totalBytes > SFREP_TRANSFER_LIMITS.bytes) fail('sfrep_package_too_large');
    files.push({ path: `Images/${image.fileName}`, body: content });
  }
  signal.throwIfAborted();
  return buildDeterministicZip(files);
}
