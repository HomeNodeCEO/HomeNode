import { purchaseContractCurrency } from './purchaseContractAnalysis.js';
import { hasCurrentContractSubjectAssociation } from './contractSubjectAssociation.js';
import { selectSubjectPurchaseContract } from './subjectPurchaseContract.js';

const TERMS = ['contract_date', 'contract_price', 'earnest_money', 'down_payment', 'loan_amount', 'seller_concessions'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;

function contractDate(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
    || value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [year, month, day] = value.includes('-') ? [match[1], match[2], match[3]] : [match[3], match[1], match[2]];
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return parsed.getUTCFullYear() === Number(year) && parsed.getUTCMonth() + 1 === Number(month)
    && parsed.getUTCDate() === Number(day) ? `${month.padStart(2, '0')}/${day.padStart(2, '0')}/${year}` : null;
}

const dollars = amount => `$${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(amount)}`;

/** The legacy 1004/2055 Contract section is deliberately assembled from one,
 * subject-matched purchase contract with confirmed terms. A PDF merely being uploaded never
 * claims the appraiser analyzed it. Original terms and the source PDF remain in
 * the workfile; this concise narrative is an export-only presentation. */
export function projectSfrepContractSection(documents, {
  assignmentDetails, cadOwnerName, assignmentFileId, assignmentRevision,
} = {}) {
  const fields = [], warnings = [], knownMissing = [];
  const selection = selectSubjectPurchaseContract(documents);
  if (!selection.document) {
    if (selection.ambiguous) warnings.push('Multiple base purchase contracts are in the workfile. Select which signed contract applies before mapping the legacy Contract section.');
    else if (selection.supplementalCount) warnings.push('Only financing or other contract addenda were found; upload the base purchase contract.');
    knownMissing.push({ fieldId: 'AnalyzedContractDescription', reason: selection.ambiguous
      ? 'More than one base contract is present; select the subject contract in the Document Evidence Center.'
      : 'No base subject contract is available. Financing and other addenda do not supply the contract analysis.' });
    return { fields, warnings, knownMissing };
  }
  const document = selection.document;
  if ((document.property_role !== 'subject' && !hasCurrentContractSubjectAssociation(document))
    || !['reviewed', 'review_required'].includes(document.processing_status)) {
    warnings.push('The base contract needs subject-property verification and confirmed terms before it can mark the legacy Contract section analyzed.');
    knownMissing.push({ fieldId: 'AnalyzedContractDescription', reason: 'Verify that the base contract belongs to this subject and review its extracted terms in the Document Evidence Center.' });
    return { fields, warnings, knownMissing };
  }
  if (selection.supplementalCount) warnings.push(`${selection.supplementalCount} financing/addendum document(s) were kept as workfile evidence and did not replace the base contract.`);
  if (document.processing_status === 'review_required') warnings.push('The base contract still has unreviewed suggestions; only individually confirmed terms are mapped. Review its remaining suggestions in HomeNode.');
  if (document.property_role !== 'subject') warnings.push('The appraiser explicitly associated this contract with the subject despite a printed-address discrepancy; review the consolidated discrepancy addendum.');
  const documentId = Number(document.id);
  const candidates = new Map();
  for (const candidate of Array.isArray(document.candidates) ? document.candidates : []) {
    if (candidate?.review_status !== 'confirmed' || !TERMS.includes(candidate.field_key)
      || !positive(candidate.id) || (candidate.document_id != null && Number(candidate.document_id) !== documentId)) continue;
    const value = candidate.confirmed_value ?? candidate.normalized_value ?? candidate.raw_value;
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const normalized = candidate.field_key === 'contract_date' ? contractDate(String(value))
      : /^\$?\s*(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(String(value).trim())
        ? purchaseContractCurrency(value) : null;
    if (normalized === null) continue;
    const existing = candidates.get(candidate.field_key);
    if (existing && existing.value !== normalized) {
      warnings.push(`Conflicting confirmed ${candidate.field_key} values in the contract; resolve them in the Document Evidence Center.`);
      return { fields, warnings, knownMissing };
    }
    candidates.set(candidate.field_key, { candidateId: Number(candidate.id), value: normalized });
  }
  const sellerMatch = record(assignmentDetails) ? assignmentDetails.seller_matches_public_records : null;
  if (typeof sellerMatch === 'boolean' && String(assignmentDetails.contract_seller_names || '').trim()
    && String(cadOwnerName || '').trim() && positive(assignmentFileId) && positive(assignmentRevision)) {
    // These field IDs and ContractDataSources were verified in the installed
    // SFREP FNMA-1004-0911 and FNMA-2055-0911 conversion dictionaries.
    const provenance = { kind: 'saved_report', sourceField: 'seller_matches_public_records',
      documentId: null, candidateId: null, assignmentFileId, revision: assignmentRevision,
      sectionKey: 'report.assignment_details', origin: 'derived_reviewed_document',
      rule: 'seller_vs_cad_owner_name_v1' };
    fields.push({ sourceField: 'seller_matches_public_records',
      fieldId: sellerMatch ? 'SellerOwnerPublicYesCheckBox' : 'SellerOwnerPublicNoCheckBox',
      value: 'true', type: 'CheckBoxField', documentId: null, candidateId: null, provenance });
    fields.push({ sourceField: 'seller_match_data_source', fieldId: 'ContractDataSources', value: 'CAD',
      type: 'TextField', documentId: null, candidateId: null, provenance: { ...provenance, sourceField: 'seller_match_data_source' } });
  } else if (typeof sellerMatch === 'boolean') {
    knownMissing.push({ fieldId: 'SellerOwnerPublicYesCheckBox',
      reason: 'A contract seller and a saved CAD public-record owner are both needed before exporting the seller-owner answer.' });
  }
  if (!candidates.size) {
    warnings.push('The contract has no confirmed terms. Review its extracted fields before marking the contract analyzed.');
    knownMissing.push({ fieldId: 'AnalyzedContractDescription', reason: 'The base contract has no approved terms. Review its suggested fields in the Document Evidence Center.' });
    return { fields, warnings, knownMissing };
  }
  // Confirmation normally writes these terms into the HomeNode assignment.
  // A later appraiser edit or clear takes precedence over stale PDF values;
  // do not silently replace that saved choice at export time.
  if (record(assignmentDetails)) {
    const differences = TERMS.filter(key => {
      if (!candidates.has(key) || !Object.hasOwn(assignmentDetails, key)) return false;
      const raw = assignmentDetails[key];
      const saved = key === 'contract_date' ? contractDate(String(raw ?? ''))
        : /^\$?\s*(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(String(raw ?? '').trim())
          ? purchaseContractCurrency(raw) : null;
      return saved === null || saved !== candidates.get(key)?.value;
    });
    if (differences.length) {
      warnings.push(`Saved HomeNode contract terms differ from the selected reviewed PDF (${differences.join(', ')}). Resolve the saved values or review the contract again before export.`);
      knownMissing.push({ fieldId: 'AnalyzedContractDescription', reason: 'Saved contract terms and reviewed PDF evidence disagree; no contract terms were exported.' });
      return { fields, warnings, knownMissing };
    }
  }
  const proof = (sourceField, candidateId) => ({ kind: 'reviewed_document', sourceField, documentId, candidateId,
    documentType: 'purchase_contract' });
  fields.push({ sourceField: 'contract_reviewed', fieldId: 'AnalyzedContractYesCheckBox', value: 'true',
    type: 'CheckBoxField', documentId, candidateId: null, provenance: proof('contract_reviewed', null) });
  const date = candidates.get('contract_date');
  if (date) fields.push({ sourceField: 'contract_date', fieldId: 'ContractDate', value: date.value,
    type: 'TextField', documentId, candidateId: date.candidateId, provenance: proof('contract_date', date.candidateId) });
  const price = candidates.get('contract_price');
  if (price) fields.push({ sourceField: 'contract_price', fieldId: 'SalePriceAmount', value: price.value.toFixed(2),
    type: 'TextField', documentId, candidateId: price.candidateId, provenance: proof('contract_price', price.candidateId) });
  const concessions = candidates.get('seller_concessions');
  if (concessions?.value === 0) fields.push({ sourceField: 'seller_concessions',
    fieldId: 'BorrowerFinancialAssistanceNoCheckBox', value: 'true', type: 'CheckBoxField', documentId,
    candidateId: concessions.candidateId, provenance: proof('seller_concessions', concessions.candidateId) });
  if (concessions?.value > 0) fields.push({ sourceField: 'seller_concessions',
    fieldId: 'BorrowerFinancialAssistanceYesCheckBox', value: 'true', type: 'CheckBoxField', documentId,
    candidateId: concessions.candidateId, provenance: proof('seller_concessions', concessions.candidateId) });
  const missing = TERMS.filter(key => !candidates.has(key));
  if (missing.length) {
    knownMissing.push({ fieldId: 'AnalyzedContractDescription',
      reason: `Contract narrative requires reviewed ${missing.join(', ')}. Missing terms are not guessed from the sales price or another document.` });
    return { fields, warnings, knownMissing };
  }
  const cash = candidates.get('down_payment').value, loan = candidates.get('loan_amount').value;
  if (Math.abs(cash + loan - price.value) > 0.01) {
    knownMissing.push({ fieldId: 'AnalyzedContractDescription', reason: 'Reviewed cash and financing do not sum to the reviewed purchase price; resolve the contract terms before export.' });
    return { fields, warnings, knownMissing };
  }
  const armsLength = record(assignmentDetails) ? assignmentDetails.contract_arms_length : null;
  const saleType = armsLength === true ? 'Arms length sale' : armsLength === false ? 'Non-arms length sale' : 'Sale type requires appraiser review';
  if (armsLength == null) warnings.push('Arms-length status was not established by uploading the contract. Select it in HomeNode before relying on the legacy Contract analysis.');
  const amount = concessions.value === 0 ? '0$' : dollars(concessions.value);
  const value = `${saleType};Contract dated ${date.value}, purchase price of ${dollars(price.value)}, earnest money ${dollars(candidates.get('earnest_money').value)}, cash at close ${dollars(cash)}, new loan ${dollars(loan)}, with ${amount} in concessions`;
  const sourceEvidence = TERMS.map(sourceField => ({ documentId, candidateId: candidates.get(sourceField).candidateId,
    sourceField, value: sourceField === 'contract_date' ? candidates.get(sourceField).value : candidates.get(sourceField).value.toFixed(2) }));
  fields.push({ sourceField: 'contract_analysis_summary', fieldId: 'AnalyzedContractDescription', value,
    type: 'TextField', documentId, candidateId: date.candidateId,
    provenance: { kind: 'derived_reviewed_document', sourceField: 'contract_analysis_summary', documentId,
      candidateId: date.candidateId, documentType: 'purchase_contract', rule: 'reviewed_1004_contract_terms_template_v1', sourceEvidence } });
  return { fields, warnings, knownMissing };
}
