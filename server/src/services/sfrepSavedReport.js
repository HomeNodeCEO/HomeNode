import {
  CUSTOM_SUBJECT_FIELD_DESCRIPTORS, readCustomSubjectValue, projectCustomSubjectDocuments, subjectDocumentSourceKind,
} from './customSubjectApplication.js';
import { formatSubjectPresentationValue } from '../util/subjectPresentation.js';
import { isDeepStrictEqual } from 'node:util';
import { sfrepDocumentParcelMismatch, sfrepDocumentPropertyRole } from './sfrepSubjectContext.js';
import { hasCurrentContractSubjectAssociation, contractAssociationWarning } from './contractSubjectAssociation.js';

// PostgreSQL jsonb reorders object keys. Evidence equality is structural, while
// ordered arrays and exact scalar values still remain part of the receipt.
const same = isDeepStrictEqual;
const positive = value => Number.isSafeInteger(value) && value > 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const PROOF_KEYS = ['kind', 'sourceField', 'documentId', 'candidateId', 'documentType', 'rule',
  'sourceValue', 'sourceEvidence', 'effectiveDate', 'effectiveDateSource', 'effectiveDateSourceDocumentId', 'windowStart', 'windowEnd'];
const CAD_KEYS = new Set(['subject_street_address', 'subject_city', 'subject_state', 'subject_zip',
  'county', 'assessor_parcel_number', 'owner_name', 'legal_description', 'neighborhood_name']);
const REVALIDATABLE_IDENTITY_KEYS = new Set(['subject_street_address', 'subject_city', 'subject_state',
  'subject_zip', 'county', 'assessor_parcel_number']);

function sameIdentityDisplay(key, left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return same(left, right);
  if (key === 'county') return left.trim().replace(/\s+county$/i, '').toLowerCase()
    === right.trim().replace(/\s+county$/i, '').toLowerCase();
  return same(formatSubjectPresentationValue(key, left), formatSubjectPresentationValue(key, right));
}

function revalidatedIdentity(saved, key, value, receipt, proposal) {
  if (!REVALIDATABLE_IDENTITY_KEYS.has(key) || !proposal || !receipt
    || !sameIdentityDisplay(key, value, proposal.value)) return false;
  const proof = proposal.provenance;
  if (proof?.kind === 'reviewed_document') {
    const cad = saved.documents.find(document => document.id === proof.documentId
      && subjectDocumentSourceKind(document) === 'cad' && sfrepDocumentPropertyRole(document) === 'subject'
      && !sfrepDocumentParcelMismatch(document)
      && ['reviewed', 'review_required'].includes(document.processing_status));
    if (!cad) return false;
    if (receipt.sourceValue != null && !sameIdentityDisplay(key, receipt.sourceValue, receipt.reviewedSourceValue)) return false;
    // A changed raw value on the same candidate still needs review, even if
    // display formatting would hide the difference (ZIP+4 or phase suffix).
    if (receipt.documentId === proof.documentId && receipt.candidateId === proof.candidateId
      && !same(receipt.reviewedSourceValue, proposal.sourceValue)) return false;
    return true;
  }
  if (proof?.kind !== 'account_reference' || proof.rule !== 'canonical_county_subject_identity_v1'
    || receipt.kind !== proof.kind || receipt.rule !== proof.rule
    || !sameIdentityDisplay(key, receipt.reviewedSourceValue, proposal.sourceValue)) return false;
  // A changed capitalization or ZIP+4 presentation of the same account row
  // must not strand a saved file. A different account or column still does.
  const source = proof.sourceEvidence?.[0], old = receipt.sourceEvidence?.[0];
  return source?.sourceTable === 'core.accounts' && old?.sourceTable === source.sourceTable
    && source?.accountId === saved.accountId && old?.accountId === source.accountId
    && old?.sourceField === source.sourceField
    && sameIdentityDisplay(key, old?.value, receipt.reviewedSourceValue)
    && sameIdentityDisplay(key, receipt.sourceValue, receipt.reviewedSourceValue)
    && same(source?.value, proposal.sourceValue);
}

/** Resolve only persisted report values. Evidence receipts cannot authorize
 * themselves: exact source/value/derivation are checked against the current,
 * assignment-scoped source snapshot. A saved manual correction is labeled as
 * an appraiser edit, never presented as a statement printed in a source PDF. */
export function savedSfrepSubjectFields(saved, input) {
  if (!record(saved) || saved.accountId !== input.accountId || saved.assignmentFileId !== input.assignmentFileId
    || !positive(saved.assignmentRevision) || !record(saved.assignmentDetails)
    || !Array.isArray(saved.documents) || saved.documents.length > 50) throw new Error('sfrep_invalid_saved_report');
  const subject = record(saved.subject?.value) ? saved.subject.value : {};
  const receipts = record(saved.evidence?.value?.fields) ? saved.evidence.value.fields : {};
  const projection = projectCustomSubjectDocuments(saved.documents);
  const proposals = new Map(projection.fields.map(field => [field.key, field]));
  const fields = [], warnings = [], knownMissing = [];
  for (const document of saved.documents) {
    if (hasCurrentContractSubjectAssociation(document)) warnings.push(contractAssociationWarning(document));
    if (subjectDocumentSourceKind(document) === 'cad' && sfrepDocumentParcelMismatch(document)) {
      warnings.push(`Assessor parcel number (document ${document.id}): reviewed PDF APN differs from the assignment account. That CAD document is quarantined; review the discrepancy before relying on shared-account fallback identity.`);
    }
  }
  for (const descriptor of CUSTOM_SUBJECT_FIELD_DESCRIPTORS) {
    const value = readCustomSubjectValue({ subject, assignmentDetails: saved.assignmentDetails }, descriptor.key);
    if (value == null || value === '') {
      // Only absent leaves can use canonical account identity. An explicit
      // saved blank/null remains an appraiser choice, never silently refilled.
      const hasPath = (() => {
        let container = descriptor.section === 'subject' ? subject : saved.assignmentDetails;
        for (const key of descriptor.path) {
          if (!record(container)) return true; // Explicitly cleared/invalid ancestor is not absence.
          if (!Object.hasOwn(container, key)) return false;
          container = container[key];
        }
        return true;
      })();
      const proposal = proposals.get(descriptor.key);
      if (!hasPath && !receipts[descriptor.key] && proposal?.provenance.rule === 'canonical_county_subject_identity_v1') {
        fields.push({ sourceField: descriptor.key, value: proposal.value,
          provenance: { kind: 'account_reference', sourceField: descriptor.key, documentId: null, candidateId: null,
            assignmentFileId: saved.assignmentFileId, revision: saved.assignmentRevision,
            rule: proposal.provenance.rule, sourceEvidence: proposal.provenance.sourceEvidence } });
      }
      continue;
    }
    const revision = descriptor.section === 'subject' ? Number(saved.subject?.revision) : saved.assignmentRevision;
    if (!positive(revision)) throw new Error('sfrep_invalid_saved_report');
    if (!['string', 'boolean', 'number'].includes(typeof value)) {
      warnings.push(`${descriptor.key}: the saved report has multiple or unsupported choices. Review this field in HomeNode.`);
      continue;
    }
    let origin = 'appraiser_edit';
    let source;
    const receipt = receipts[descriptor.key];
    if (receipt && same(receipt.value, value)) {
      const proposal = proposals.get(descriptor.key);
      const proof = proposal?.provenance;
      // Older receipts retain their exact capitals/ZIP+4/phase suffix. A pure
      // presentation update does not invalidate otherwise identical evidence.
      const valid = receipt.status === 'current' && proposal
        && same(proposal.value, formatSubjectPresentationValue(descriptor.key, value)) && proof
        && same(receipt.reviewedSourceValue, proposal.sourceValue)
        && PROOF_KEYS.every(key => same(receipt[key], proof[key]));
      // Older files can hold a valid reviewed value from a different source.
      // When the same value is now confirmed by the workfile's reviewed CAD
      // record, migrate its export provenance without changing the saved file.
      const cadDocument = CAD_KEYS.has(descriptor.key) && saved.documents.find(document =>
        document.id === proof?.documentId && subjectDocumentSourceKind(document) === 'cad'
        && sfrepDocumentPropertyRole(document) === 'subject'
        && ['reviewed', 'review_required'].includes(document.processing_status));
      const matchingCad = receipt.status === 'current' && cadDocument && proof?.kind === 'reviewed_document'
        && (receipt.kind !== proof.kind || receipt.documentId !== proof.documentId)
        && same(proposal.value, formatSubjectPresentationValue(descriptor.key, value));
      if (!valid && !matchingCad && !revalidatedIdentity(saved, descriptor.key, value, receipt, proposal)) {
        const reason = `${descriptor.key}: saved source-backed value needs review because its source or appraisal-date context changed. Review the source or correct the saved HomeNode field before exporting.`;
        warnings.push(reason);
        knownMissing.push(...descriptor.fieldIds.map(fieldId => ({ fieldId, reason })));
        continue;
      }
      origin = proof.kind;
      source = proof;
    }
    const provenance = { kind: 'saved_report', sourceField: descriptor.key, documentId: null, candidateId: null,
      assignmentFileId: saved.assignmentFileId,
      sectionKey: descriptor.section === 'subject' ? 'report.subject_identification' : 'report.assignment_details',
      revision, origin,
      ...(source?.documentId ? { sourceDocumentId: source.documentId } : {}),
      ...(source?.candidateId ? { sourceCandidateId: source.candidateId } : {}),
      ...(source?.rule ? { rule: source.rule } : {}),
      ...(['user_requested_hoa_workflow_proxy_v1', 'user_requested_lender_address_v1'].includes(source?.rule)
        ? { sourceValue: source.sourceValue } : {}),
      ...(source?.sourceEvidence ? { sourceEvidence: source.sourceEvidence } : {}),
      ...(source?.kind === 'derived_reviewed_document' ? Object.fromEntries(
        ['sourceValue', 'effectiveDate', 'effectiveDateSource', 'effectiveDateSourceDocumentId', 'windowStart', 'windowEnd']
          .map(key => [key, source[key]])) : {}),
    };
    fields.push({ sourceField: descriptor.key, value, provenance });
  }
  const frequency = fields.find(field => field.sourceField === 'hoa_frequency');
  if (!frequency || !['per_month', 'per_year'].includes(frequency.value)) {
    const index = fields.findIndex(field => field.sourceField === 'hoa_dues_amount');
    if (index >= 0) {
      fields.splice(index, 1);
      warnings.push('HOA amount omitted: the saved HomeNode report needs a supported monthly or annual frequency.');
    }
  }
  if (!saved.subject?.revision) warnings.push('Review the uploaded documents to populate and save the HomeNode Subject section before exporting.');
  return { fields, warnings, knownMissing };
}
