import {
  CUSTOM_SUBJECT_FIELD_DESCRIPTORS, readCustomSubjectValue, projectCustomSubjectDocuments,
} from './customSubjectApplication.js';
import { formatSubjectPresentationValue } from '../util/subjectPresentation.js';
import { isDeepStrictEqual } from 'node:util';

// PostgreSQL jsonb reorders object keys. Evidence equality is structural, while
// ordered arrays and exact scalar values still remain part of the receipt.
const same = isDeepStrictEqual;
const positive = value => Number.isSafeInteger(value) && value > 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const PROOF_KEYS = ['kind', 'sourceField', 'documentId', 'candidateId', 'documentType', 'rule',
  'sourceValue', 'sourceEvidence', 'effectiveDate', 'effectiveDateSource', 'effectiveDateSourceDocumentId', 'windowStart', 'windowEnd'];

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
  for (const descriptor of CUSTOM_SUBJECT_FIELD_DESCRIPTORS) {
    const value = readCustomSubjectValue({ subject, assignmentDetails: saved.assignmentDetails }, descriptor.key);
    if (value == null || value === '') continue;
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
      if (!valid) {
        const reason = `${descriptor.key}: saved document-derived value needs review because its source or appraisal-date context changed. Review the source or correct the saved HomeNode field before exporting.`;
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
      ...(source?.rule === 'user_requested_hoa_workflow_proxy_v1' ? { sourceValue: source.sourceValue } : {}),
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
