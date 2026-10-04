import assert from 'node:assert/strict';
import test from 'node:test';
import { projectSfrepContractSection } from '../src/services/sfrepContractSection.js';
import { buildSfrepReportExport } from '../src/services/sfrepReportExport.js';
import { previewSfrepDocuments } from '../src/services/sfrepDocumentTransfer.js';
import { checkSfrepPreview, sfrepContractChecklist } from '../../dcad-frontend/src/features/sfrep/sfrepTransport.ts';

const terms = {
  contract_date: '2026-03-15', contract_price: '785000.00', earnest_money: '7800.00',
  down_payment: '157000.00', loan_amount: '628000.00', seller_concessions: '0.00',
};
const contract = (overrides = {}) => ({ id: 9, document_type: 'purchase_contract', property_role: 'subject',
  processing_status: 'reviewed', candidates: Object.entries(terms).map(([field_key, confirmed_value], index) => ({
    id: 100 + index, document_id: 9, field_key, confirmed_value, review_status: 'confirmed',
  })), ...overrides });

test('1004 Contract section uses the reviewed Frost Hollow amounts and exact requested template', () => {
  const result = projectSfrepContractSection([contract()], { assignmentDetails: { contract_arms_length: true } });
  const byId = Object.fromEntries(result.fields.map(field => [field.fieldId, field.value]));
  assert.equal(byId.AnalyzedContractYesCheckBox, 'true');
  assert.equal(byId.ContractDate, '03/15/2026');
  assert.equal(byId.SalePriceAmount, '785000.00');
  assert.equal(byId.BorrowerFinancialAssistanceNoCheckBox, 'true');
  assert.equal(byId.AnalyzedContractDescription, 'Arms length sale;Contract dated 03/15/2026, purchase price of $785,000, earnest money $7,800, cash at close $157,000, new loan $628,000, with 0$ in concessions');
  assert.deepEqual(result.knownMissing, []);
  const mapped = buildSfrepReportExport({ documents: [contract()], subjectOnly: true, contractSection: true,
    savedAssignmentDetails: { contract_arms_length: true } });
  assert.match(mapped.reportXml, /<CheckBoxField Id="AnalyzedContractYesCheckBox" Data="true" \/>/);
  assert.match(mapped.reportXml, /<TextField Id="AnalyzedContractDescription" Data="Arms length sale;Contract dated 03\/15\/2026/);
});

test('upload alone, foreign property, conflicting versions, and unreviewed terms cannot claim analyzed contract', () => {
  for (const documents of [
    [contract({ processing_status: 'review_required' })], [contract({ property_role: 'unknown' })],
    [contract({ candidates: [] })], [contract(), contract({ id: 10 })],
  ]) {
    const result = projectSfrepContractSection(documents);
    assert.equal(result.fields.some(field => field.fieldId === 'AnalyzedContractYesCheckBox'), false);
  }
});

test('missing or inconsistent reviewed terms do not generate a complete 1004 narrative', () => {
  const missing = projectSfrepContractSection([contract({ candidates: contract().candidates.filter(item => item.field_key !== 'earnest_money') })]);
  assert.equal(missing.fields.some(field => field.fieldId === 'AnalyzedContractDescription'), false);
  assert.ok(missing.knownMissing.some(item => item.fieldId === 'AnalyzedContractDescription'));
  const inconsistent = contract();
  inconsistent.candidates.find(item => item.field_key === 'down_payment').confirmed_value = '157001.00';
  const result = projectSfrepContractSection([inconsistent]);
  assert.equal(result.fields.some(field => field.fieldId === 'AnalyzedContractDescription'), false);
});

test('arms-length status is not inferred from a document upload', () => {
  const result = projectSfrepContractSection([contract()]);
  assert.match(result.fields.find(field => field.fieldId === 'AnalyzedContractDescription').value, /^Sale type requires appraiser review;/);
  assert.ok(result.warnings.some(warning => /not established/.test(warning)));
});

test('saved HomeNode contract corrections and cleared values are not silently replaced by PDF candidates', () => {
  for (const down_payment of ['158000.00', '']) {
    const result = projectSfrepContractSection([contract()], { assignmentDetails: { down_payment } });
    assert.deepEqual(result.fields, []);
    assert.ok(result.warnings.some(warning => /Saved HomeNode contract terms differ/.test(warning)));
  }
});

test('the actual preview response passes the frontend contract boundary and checklist', () => {
  const document = { ...contract(), title: 'Frost Hollow purchase contract', file_name: 'Contract.pdf', file_size_bytes: 100,
    subject_context: { accountId: '20035000010310000', address: '1016 Frost Hollow Dr', city: 'DeSoto', postalCode: '75115',
      effectiveDate: '2026-03-27' }, upload_date: '2026-10-04' };
  const result = previewSfrepDocuments([document], { accountId: '20035000010310000', assignmentFileId: 7,
    documentIds: [9], includeDocuments: false, formId: 'FNMA-1004-0911' });
  const preview = JSON.parse(JSON.stringify({ ok: true, ...result }));
  assert.equal(checkSfrepPreview(preview, [9]), preview);
  assert.equal(sfrepContractChecklist(preview).find(item => item.key === 'contract-analyzed').status, 'included');
  assert.equal(sfrepContractChecklist(preview).find(item => item.key === 'contract-analysis').status, 'review');
  const tampered = structuredClone(preview);
  tampered.fields.find(field => field.fieldId === 'AnalyzedContractDescription').value = 'Arms length sale;Contract dated 03/15/2026, purchase price of $999,999';
  assert.throws(() => checkSfrepPreview(tampered, [9]), /invalid/);
});

test('reviewed workfile contract maps even when its PDF is not selected as an attachment', () => {
  const other = { id: 8, document_type: 'other', property_role: 'subject', processing_status: 'reviewed',
    title: 'CAD reference', file_name: 'CAD.pdf', file_size_bytes: 100, candidates: [],
    subject_context: { accountId: '20035000010310000', address: '1016 Frost Hollow Dr', city: 'DeSoto', postalCode: '75115',
      effectiveDate: '2026-03-27' }, upload_date: '2026-10-04' };
  const reviewed = contract();
  other.saved_report = { accountId: '20035000010310000', assignmentFileId: 7, assignmentRevision: 1,
    assignmentDetails: { contract_arms_length: true }, subject: { value: {}, revision: 1 }, evidence: { value: {}, revision: 1 },
    documents: [{ ...other }, reviewed] };
  const result = previewSfrepDocuments([other], { accountId: '20035000010310000', assignmentFileId: 7,
    documentIds: [8], includeDocuments: true, formId: 'FNMA-1004-0911' });
  const preview = JSON.parse(JSON.stringify({ ok: true, ...result }));
  assert.equal(preview.documents.length, 1);
  assert.deepEqual(preview.pdfAddenda.map(item => item.documentId), [8]);
  assert.equal(preview.fields.find(field => field.fieldId === 'AnalyzedContractYesCheckBox')?.documentId, 9);
  assert.equal(checkSfrepPreview(preview, [8]), preview);
  const missingSource = structuredClone(preview);
  missingSource.savedReport.sourceDocumentIds = [8];
  assert.throws(() => checkSfrepPreview(missingSource, [8]), /selected source documents/);
});

test('positive reviewed concessions select Yes instead of No and remain in the narrative', () => {
  const source = contract();
  source.candidates.find(item => item.field_key === 'seller_concessions').confirmed_value = '5000.00';
  const result = projectSfrepContractSection([source], { assignmentDetails: { contract_arms_length: false } });
  assert.equal(result.fields.find(field => field.fieldId === 'BorrowerFinancialAssistanceYesCheckBox')?.value, 'true');
  assert.equal(result.fields.some(field => field.fieldId === 'BorrowerFinancialAssistanceNoCheckBox'), false);
  assert.match(result.fields.find(field => field.fieldId === 'AnalyzedContractDescription').value, /^Non-arms length sale;.*with \$5,000 in concessions$/);
});
