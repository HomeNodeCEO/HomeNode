import { isDeepStrictEqual } from 'node:util';

export const CONTRACT_SUBJECT_ASSOCIATION_RULE = 'appraiser_confirmed_contract_subject_association_v1';
const identityKeys = new Set(['contract_printed_subject_addresses', 'subject_property_address', 'subject_street_address',
  'subject_city', 'subject_state', 'subject_zip', 'subject_zip_code', 'assessor_parcel_number', 'assessors_parcel_number']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const positive = value => Number.isSafeInteger(value) && value > 0;
const ready = document => ['reviewed', 'review_required'].includes(document?.processing_status);

/** Exact reviewed identity AND date snapshot. A new suggestion, later edit or
 * re-extraction invalidates association; this helper never confirms candidates. */
export function contractAssociationReviewSnapshot(document) {
  if (!Array.isArray(document?.candidates) || document.candidates.length > 200) return null;
  const candidates = document.candidates.filter(candidate => identityKeys.has(candidate?.field_key) || candidate?.field_key === 'contract_date');
  if (!candidates.length || candidates.length > 30 || !candidates.some(candidate => identityKeys.has(candidate.field_key))
    || !candidates.some(candidate => candidate.field_key === 'contract_date')
    || candidates.some(candidate => !positive(Number(candidate.id)) || Number(candidate.document_id) !== Number(document.id)
      || candidate.review_status !== 'confirmed' || !text(candidate.confirmed_value ?? candidate.normalized_value ?? candidate.raw_value, 4_000))) return null;
  if (new Set(candidates.map(candidate => Number(candidate.id))).size !== candidates.length) return null;
  return candidates.map(candidate => ({ id: Number(candidate.id), fieldKey: candidate.field_key,
    rawValue: candidate.raw_value ?? null, normalizedValue: candidate.normalized_value ?? null,
    confirmedValue: candidate.confirmed_value ?? null, reviewStatus: candidate.review_status }))
    .sort((left, right) => left.id - right.id);
}

function canonicalIdentity(context) {
  const identity = context?.canonicalIdentity;
  if (!record(identity) || identity.accountId !== context.accountId || !text(identity.accountId, 200)
    || !text(identity.address, 1_000) || !text(identity.city, 500) || !text(identity.postalCode, 100)) return null;
  return { accountId: identity.accountId, address: identity.address, city: identity.city, postalCode: identity.postalCode,
    county: identity.county ?? null, state: identity.state ?? null, assessorParcelNumber: identity.assessorParcelNumber ?? null };
}

export function buildContractSubjectAssociation(document, { reviewer, actorUserId, acknowledgedAt } = {}) {
  const identity = canonicalIdentity(document?.subject_context), reviewedCandidates = contractAssociationReviewSnapshot(document);
  if (document?.document_type !== 'purchase_contract' || !ready(document) || !positive(Number(document.id))
    || !positive(Number(document.assignment_file_id)) || document.uad_workfile_id || document.tax_protest_file_id
    || !identity || document.account_id !== identity.accountId || !reviewedCandidates
    || typeof document.checksum_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(document.checksum_sha256)
    || !text(reviewer, 200) || !text(actorUserId, 200) || !text(acknowledgedAt, 64) || !Number.isFinite(Date.parse(acknowledgedAt))) return null;
  return { rule: CONTRACT_SUBJECT_ASSOCIATION_RULE, acknowledged: true,
    documentId: Number(document.id), accountId: document.account_id, assignmentFileId: Number(document.assignment_file_id),
    documentChecksumSha256: document.checksum_sha256, canonicalIdentity: identity, reviewedCandidates,
    reviewer, reviewerUserId: actorUserId, acknowledgedAt,
    reason: 'Appraiser associated this contract with this subject despite printed-address discrepancies. Only reviewed contract dates may support listing history; printed addresses do not replace county identity.' };
}

/** Never changes property_role: this decision is only for listing-date use. */
export function hasCurrentContractSubjectAssociation(document) {
  const receipt = document?.extraction_summary?.contract_subject_association;
  if (!record(receipt)) return false;
  const current = buildContractSubjectAssociation(document, { reviewer: receipt.reviewer,
    actorUserId: receipt.reviewerUserId, acknowledgedAt: receipt.acknowledgedAt });
  return current !== null && isDeepStrictEqual(current, receipt);
}

export function contractAssociationWarning(document) {
  return `Listing history: contract document ${document.id} was explicitly associated with this subject by the appraiser despite printed-address discrepancies. The PDF and county identity are unchanged.`;
}
