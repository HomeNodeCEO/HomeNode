import { hasCurrentContractSubjectAssociation } from './contractSubjectAssociation.js';

export const SFREP_DISCREPANCY_RTF_NAME = 'evidence-discrepancies.rtf';

const documentKinds = new Set(['purchase_contract', 'engagement_letter', 'mls_sheet', 'other']);
const identityKeys = new Set(['subject_property_address', 'subject_street_address', 'subject_city']);
const cityFromAddress = value => String(value).match(/,\s*([A-Za-z][A-Za-z .'-]*?),?\s+(?:TX|Texas)\s+\d{5}(?:-\d{4})?\b/i)?.[1]?.trim() || null;

/** Form-neutral, nonblocking identity findings. They never turn a mismatched
 * MLS sheet or assignment page into evidence for this subject. */
export function evidenceIdentityFlags(documents) {
  return documents.flatMap(document => {
    if (!documentKinds.has(document.document_type) || document.processing_status !== 'reviewed') return [];
    const canonicalCity = String(document.subject_context?.city || '').trim();
    if (!canonicalCity) return [];
    const statedCities = (document.candidates || []).filter(candidate => candidate.review_status === 'confirmed'
      && (candidate.document_id == null || Number(candidate.document_id) === Number(document.id))
      && identityKeys.has(candidate.field_key)).map(candidate => {
        const value = candidate.confirmed_value ?? candidate.normalized_value ?? candidate.raw_value;
        return candidate.field_key === 'subject_city' ? String(value || '').trim() : cityFromAddress(value);
      }).filter(Boolean);
    if (!statedCities.some(city => city.toLowerCase() !== canonicalCity.toLowerCase())) return [];
    return [{ documentId: Number(document.id), documentType: document.document_type,
      message: `Document ${document.id} (${document.document_type.replaceAll('_', ' ')}) states a subject city different from the county-backed ${canonicalCity}. Verify the source and property association; the county address remains unchanged.` }];
  });
}

function currentEngagementOverride(document) {
  const receipt = document.extraction_summary?.subject_address_override;
  const canonical = document.subject_context;
  const candidate = (document.candidates || []).find(item => item.field_key === 'subject_property_address'
    && item.review_status === 'confirmed' && receipt?.confirmed_candidate_ids?.includes(Number(item.id)));
  return document.document_type === 'engagement_letter' && document.processing_status === 'reviewed'
    && receipt?.acknowledged === true && receipt.document_checksum_sha256 === document.checksum_sha256
    && receipt.canonical_subject_address === [canonical?.address, canonical?.city, canonical?.postalCode]
      .filter(Boolean).join(', ')
    && candidate && receipt.document_subject_address === String(candidate.confirmed_value ?? candidate.normalized_value ?? candidate.raw_value ?? '');
}

/** A fixed, source-bound suggestion. No unknown printed city is invented and
 * no report identity is changed. The appraiser opts in before export. */
export function evidenceDiscrepancyStatements(documents) {
  const statements = [];
  const sourceDocumentIds = [];
  const associated = documents.filter(document => document.document_type === 'purchase_contract'
    && document.processing_status === 'reviewed' && document.property_role !== 'subject'
    && hasCurrentContractSubjectAssociation(document));
  if (associated.length === 1 && documents.filter(document => document.document_type === 'purchase_contract').length === 1) {
    const document = associated[0];
    const canonicalCity = String(document.subject_context?.city || '').trim().toLowerCase();
    const printed = (document.candidates || []).filter(candidate => candidate.review_status === 'confirmed'
      && candidate.field_key === 'contract_printed_subject_addresses')
      .map(candidate => String(candidate.confirmed_value ?? candidate.normalized_value ?? candidate.raw_value ?? ''));
    const printedCities = printed.flatMap(value => [...value.matchAll(/,\s*([A-Za-z][A-Za-z .'-]*?),?\s+(?:TX|Texas)\s+\d{5}(?:-\d{4})?\b/gi)]
      .map(match => match[1].trim().toLowerCase()));
    if (canonicalCity && printedCities.some(city => city !== canonicalCity)) {
      statements.push('The purchase contract contains inconsistent subject-city references when compared with the county-backed subject address. The appraiser reviewed the original contract and explicitly associated it with this subject. The county-backed subject address controls in this report. The printed contract discrepancy remains in the workfile for review and does not change the reported contract terms.');
      sourceDocumentIds.push(Number(document.id));
    } else {
      // The current appraiser association itself records a printed-address
      // discrepancy, but does not prove its exact city when OCR is incomplete.
      statements.push('The purchase contract contains a printed subject-address discrepancy. The appraiser reviewed the original contract and explicitly associated it with this subject. The county-backed subject address controls in this report. The original contract remains in the workfile for review.');
      sourceDocumentIds.push(Number(document.id));
    }
  }
  for (const document of documents.filter(currentEngagementOverride)) {
    statements.push('The engagement letter or assignment page identifies a subject address that differs from the county-backed subject address. The appraiser reviewed and accepted this document for the assignment. The county-backed subject address controls in this report; the source document remains unchanged in the workfile.');
    sourceDocumentIds.push(Number(document.id));
  }
  return { statements, sourceDocumentIds };
}

export function sfrepContractDiscrepancyAddendum(documents, enabled) {
  if (!enabled) return null;
  const { statements, sourceDocumentIds } = evidenceDiscrepancyStatements(documents);
  if (!statements.length) return null;
  return {
    fileName: SFREP_DISCREPANCY_RTF_NAME,
    sourceDocumentIds,
    title: 'Evidence Discrepancies',
    text: statements.join('\n\n'),
  };
}

export function sfrepDiscrepancyRtf(text) {
  if (typeof text !== 'string' || text.length > 2_000) throw new Error('sfrep_invalid_addendum');
  const escaped = [...text].map(character => {
    if (character === '\\' || character === '{' || character === '}') return `\\${character}`;
    if (character === '\n') return '\\par ';
    const point = character.codePointAt(0);
    if (point < 32 || point === 127) return ' ';
    if (point <= 126) return character;
    return [...character].map((unit) => {
      const value = unit.charCodeAt(0);
      return `\\u${value > 32767 ? value - 65536 : value}?`;
    }).join('');
  }).join('');
  return Buffer.from(`{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0\\fs20 ${escaped}}`, 'ascii');
}
