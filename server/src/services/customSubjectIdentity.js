import { formatSubjectPresentationValue, titleCaseSubjectText } from '../util/subjectPresentation.js';
import { isUrarStateCode } from '../util/urarScalarValidation.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 500
  && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : null;
const definitions = [
  ['subject_street_address', 'address', 'address'], ['subject_city', 'city', 'city'],
  ['subject_zip', 'postalCode', 'postal_code'], ['county', 'county', 'county'],
  ['assessor_parcel_number', 'assessorParcelNumber', 'account_id'], ['subject_state', 'state', 'state'],
];

/** Canonical identity is supplied by the assignment-scoped database snapshot,
 * not by document metadata. It remains separate from PDF review/provenance. */
export function buildCustomSubjectIdentity(context) {
  const source = context?.canonicalIdentity;
  if (!record(source) || !text(context?.accountId) || source.accountId !== context.accountId) return [];
  const fields = [];
  for (const [key, property, column] of definitions) {
    const raw = text(source[property]);
    if (!raw || (key === 'subject_zip' && !/^\d{5}(?:-?\d{4})?$/.test(raw))
      || (key === 'subject_state' && !isUrarStateCode(raw))) continue;
    const value = key === 'county' ? titleCaseSubjectText(raw.replace(/\s+county$/i, ''))
      : formatSubjectPresentationValue(key, raw);
    fields.push({ key, value, sourceValue: raw,
      provenance: { kind: 'account_reference', sourceField: key, documentId: null, candidateId: null,
        documentType: null, rule: 'canonical_county_subject_identity_v1', sourceValue: raw,
        sourceEvidence: [{ sourceTable: 'core.accounts', accountId: source.accountId, sourceField: column, value: raw }] } });
  }
  return fields;
}

/** User-maintained lender preset, not text claimed to appear in an upload. */
export function customSubjectLenderPreset(fields) {
  if (fields.some(field => field.key === 'lender_client_address')) return null;
  const lender = fields.find(field => field.key === 'lender_client_name');
  if (!lender || !/^united\s+wholesale\s+mortgage$/i.test(String(lender.value).trim())
    || lender.provenance?.kind !== 'reviewed_document') return null;
  const sourceValue = String(lender.value).trim();
  return { key: 'lender_client_address', value: '585 S Blvd E, Pontiac, MI 48341', sourceValue,
    provenance: { ...lender.provenance, kind: 'user_default', sourceField: 'lender_client_address',
      rule: 'user_requested_lender_address_v1', sourceValue,
      sourceEvidence: [{ documentId: lender.provenance.documentId, candidateId: lender.provenance.candidateId,
        sourceField: 'lender_client_name', value: sourceValue }] } };
}
