import { hasCurrentContractSubjectAssociation } from './contractSubjectAssociation.js';

export const SFREP_DISCREPANCY_RTF_NAME = 'evidence-discrepancies.rtf';

const identityKeys = new Set(['subject_property_address', 'subject_street_address', 'subject_city']);
const addressLocality = value => String(value).match(/,\s*([A-Za-z][A-Za-z .'-]*?),?\s+(?:TX|Texas),?\s+(\d{5})(?:-\d{4})?\b/i);
const firstFiveZip = value => String(value || '').match(/^\d{5}/)?.[0] || null;

function confirmedLocalityDifferences(document) {
  if (document.processing_status !== 'reviewed' || !Array.isArray(document.candidates)) return [];
  const canonicalCity = String(document.subject_context?.city || '').trim();
  const canonicalZip = firstFiveZip(document.subject_context?.postalCode);
  if (!canonicalCity && !canonicalZip) return [];
  const differences = new Set();
  for (const candidate of document.candidates) {
    if (candidate.review_status !== 'confirmed'
      || (candidate.document_id != null && Number(candidate.document_id) !== Number(document.id))) continue;
    const value = candidate.confirmed_value ?? candidate.normalized_value ?? candidate.raw_value;
    const locality = identityKeys.has(candidate.field_key) && candidate.field_key !== 'subject_city' ? addressLocality(value) : null;
    const city = candidate.field_key === 'subject_city' ? String(value || '').trim() : locality?.[1]?.trim();
    const postal = ['subject_zip', 'subject_zip_code'].includes(candidate.field_key)
      ? firstFiveZip(value) : locality?.[2];
    if (city && canonicalCity && city.toLowerCase() !== canonicalCity.toLowerCase()) differences.add('city');
    if (postal && canonicalZip && postal !== canonicalZip) differences.add('ZIP');
  }
  return [...differences];
}

/** Form-neutral, nonblocking identity findings. They never turn a mismatched
 * MLS sheet or assignment page into evidence for this subject. */
export function evidenceIdentityFlags(documents) {
  return documents.flatMap(document => {
    const differences = confirmedLocalityDifferences(document);
    if (!differences.length) return [];
    const canonical = [document.subject_context?.city, document.subject_context?.postalCode].filter(Boolean).join(' ');
    return [{ documentId: Number(document.id), documentType: document.document_type,
      message: `Document ${document.id} (${String(document.document_type || 'source').replaceAll('_', ' ')}) states a subject ${differences.join(' and ')} different from the county-backed ${canonical}. Verify the source and property association; the county address remains unchanged.` }];
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
  const acknowledgedEngagements = documents.filter(currentEngagementOverride);
  if (acknowledgedEngagements.length) {
    statements.push('The engagement letter or assignment page identifies a subject address that differs from the county-backed subject address. The appraiser reviewed and accepted this document for the assignment. The county-backed subject address controls in this report; the source document remains unchanged in the workfile.');
    sourceDocumentIds.push(...acknowledgedEngagements.map(document => Number(document.id)));
  }
  // Keep the statement collection independent of the SFREP form adapter.
  // Group other reviewed source locality conflicts into one cautious statement,
  // without asserting an unassociated document belongs to this subject.
  const otherConflicts = documents.filter(document => !sourceDocumentIds.includes(Number(document.id))
    && !['purchase_contract', 'engagement_letter'].includes(document.document_type)
    && confirmedLocalityDifferences(document).length);
  if (otherConflicts.length) {
    statements.push('One or more reviewed supporting documents contain a subject city or ZIP reference that differs from the county-backed subject address. The appraiser should verify each source and its relationship to the subject. The county-backed subject address controls in this report; the original documents remain unchanged in the workfile.');
    sourceDocumentIds.push(...otherConflicts.map(document => Number(document.id)));
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
