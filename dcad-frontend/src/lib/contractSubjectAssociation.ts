import { fetchJSON, makeUrl, type AssignmentDocument } from './api';

const identityKeys = ['contract_printed_subject_addresses', 'subject_property_address', 'subject_street_address',
  'subject_city', 'subject_state', 'subject_zip', 'subject_zip_code', 'assessor_parcel_number', 'assessors_parcel_number'];
export function contractAssociationReviewSnapshot(document: AssignmentDocument) {
  return (document.candidates || []).filter(candidate => identityKeys.includes(candidate.field_key) || candidate.field_key === 'contract_date')
    .map(candidate => ({ id: candidate.id, fieldKey: candidate.field_key, rawValue: candidate.raw_value ?? null,
      normalizedValue: candidate.normalized_value ?? null, confirmedValue: candidate.confirmed_value ?? null,
      reviewStatus: candidate.review_status })).sort((left, right) => Number(left.id) - Number(right.id));
}
export function canAssociateContractSubject(document: AssignmentDocument) {
  const snapshot = contractAssociationReviewSnapshot(document);
  return document.document_type === 'purchase_contract' && ['reviewed', 'review_required'].includes(document.processing_status)
    && /^[a-f0-9]{64}$/.test(document.checksum_sha256 || '')
    && snapshot.some(candidate => candidate.fieldKey === 'contract_date')
    && snapshot.some(candidate => identityKeys.includes(candidate.fieldKey))
    && snapshot.every(candidate => candidate.reviewStatus === 'confirmed');
}
export async function associateContractSubject(document: AssignmentDocument, accountId: string, assignmentFileId: number,
  editorKey: string): Promise<AssignmentDocument> {
  const response = await fetchJSON<{ ok: true; document: AssignmentDocument }>(
    makeUrl(`/api/documents/${document.id}/subject-address-override`), {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-homenode-editor-key': editorKey },
      body: JSON.stringify({ contract_subject_association: { accountId, assignmentFileId,
        documentChecksumSha256: document.checksum_sha256, reviewedCandidates: contractAssociationReviewSnapshot(document) } }),
    });
  return response.document;
}
