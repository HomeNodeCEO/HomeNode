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

test('2055 Contract section preserves the same reviewed narrative in its own primary form', () => {
  const options = { documents: [contract()], subjectOnly: true, contractSection: true,
    savedAssignmentDetails: { contract_arms_length: true } };
  const urar = buildSfrepReportExport(options);
  const exterior = buildSfrepReportExport({ ...options, formId: 'FNMA-2055-0911' });
  assert.deepEqual(exterior.fields, urar.fields);
  assert.match(exterior.reportXml, /<Form Id="FNMA-2055-0911">/);
  assert.match(exterior.reportXml, /<TextField Id="AnalyzedContractDescription" Data="Arms length sale;Contract dated 03\/15\/2026/);
});

test('both legacy forms export the saved seller-owner answer and CAD as its data source', () => {
  const owner = [{ sourceField: 'owner_name', value: 'Loredo Lorenzo Jr & Thompson Andi',
    provenance: { kind: 'saved_report', sourceField: 'owner_name' } }];
  for (const formId of ['FNMA-1004-0911', 'FNMA-2055-0911']) {
    for (const matches of [true, false]) {
      const result = buildSfrepReportExport({ documents: [contract()], subjectOnly: true,
        contractSection: true, formId, savedReportFields: owner,
        savedAssignmentFileId: 7, savedAssignmentRevision: 2,
        savedAssignmentDetails: { contract_seller_names: 'Lorenzo Jr Loredo, Andi Li-Kay Thompson',
          seller_matches_public_records: matches } });
      const selected = matches ? 'SellerOwnerPublicYesCheckBox' : 'SellerOwnerPublicNoCheckBox';
      const other = matches ? 'SellerOwnerPublicNoCheckBox' : 'SellerOwnerPublicYesCheckBox';
      assert.match(result.reportXml, new RegExp(`<CheckBoxField Id="${selected}" Data="true" \\/>`));
      assert.doesNotMatch(result.reportXml, new RegExp(other));
      assert.match(result.reportXml, /<TextField Id="ContractDataSources" Data="CAD" \/>/);
    }
  }
  const withoutCad = buildSfrepReportExport({ documents: [contract()], subjectOnly: true,
    contractSection: true, savedReportFields: [], savedAssignmentFileId: 7, savedAssignmentRevision: 2,
    savedAssignmentDetails: {
      contract_seller_names: 'Lorenzo Jr Loredo', seller_matches_public_records: true,
    } });
  assert.doesNotMatch(withoutCad.reportXml, /SellerOwnerPublicYesCheckBox|ContractDataSources/);
});

test('upload alone, foreign property, conflicting base versions, and unconfirmed terms cannot claim analyzed contract', () => {
  for (const documents of [
    [contract({ processing_status: 'processing' })], [contract({ property_role: 'unknown' })],
    [contract({ candidates: [] })], [contract(), contract({ id: 10 })],
  ]) {
    const result = projectSfrepContractSection(documents);
    assert.equal(result.fields.some(field => field.fieldId === 'AnalyzedContractYesCheckBox'), false);
  }
  const partialReview = projectSfrepContractSection([contract({ processing_status: 'review_required' })]);
  assert.equal(partialReview.fields.some(field => field.fieldId === 'AnalyzedContractDescription'), true);
  assert.ok(partialReview.warnings.some(warning => /unreviewed suggestions/.test(warning)));
});

test('contract checklist identifies pending review and preserves independently approved date', () => {
  const pending = projectSfrepContractSection([contract({ candidates: [], processing_status: 'review_required' })]);
  assert.ok(pending.knownMissing.some(item => item.fieldId === 'AnalyzedContractDescription'
    && /no approved terms/i.test(item.reason)));
  const dateOnly = projectSfrepContractSection([contract({ processing_status: 'review_required',
    candidates: contract().candidates.filter(item => item.field_key === 'contract_date') })],
  { assignmentDetails: { contract_date: '2026-03-15', contract_price: '' } });
  assert.equal(dateOnly.fields.find(field => field.fieldId === 'ContractDate')?.value, '03/15/2026');
  assert.equal(dateOnly.fields.some(field => field.fieldId === 'AnalyzedContractDescription'), false);
  assert.ok(dateOnly.knownMissing.some(item => item.fieldId === 'AnalyzedContractDescription'
    && /contract_price/.test(item.reason)));
});

test('a document labeled Contract outranks financing and other addenda in both legacy forms', () => {
  const main = contract({ title: 'Contract.pdf', file_name: 'Contract.pdf' });
  const financing = contract({ id: 10, title: 'Thhird PArty Financing.pdf', file_name: 'Thhird PArty Financing.pdf',
    processing_status: 'review_required', candidates: [] });
  const result = projectSfrepContractSection([financing, main]);
  assert.equal(result.fields.find(field => field.fieldId === 'AnalyzedContractDescription')?.documentId, 9);
  assert.ok(result.warnings.some(warning => /did not replace the base contract/.test(warning)));
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
    assignmentDetails: { contract_arms_length: true, contract_seller_names: 'Lorenzo Jr Loredo',
      seller_matches_public_records: true },
    subject: { value: { owner: { owner_name: 'LOREDO LORENZO JR' } }, revision: 1 },
    evidence: { value: {}, revision: 1 },
    documents: [{ ...other }, reviewed] };
  const result = previewSfrepDocuments([other], { accountId: '20035000010310000', assignmentFileId: 7,
    documentIds: [8], includeDocuments: true, formId: 'FNMA-1004-0911' });
  const preview = JSON.parse(JSON.stringify({ ok: true, ...result }));
  assert.equal(preview.documents.length, 1);
  assert.deepEqual(preview.pdfAddenda.map(item => item.documentId), [8]);
  assert.equal(preview.fields.find(field => field.fieldId === 'AnalyzedContractYesCheckBox')?.documentId, 9);
  assert.equal(preview.fields.find(field => field.fieldId === 'SellerOwnerPublicYesCheckBox')?.value, 'true');
  assert.equal(preview.fields.find(field => field.fieldId === 'ContractDataSources')?.value, 'CAD');
  assert.deepEqual(sfrepContractChecklist(preview).find(item => item.key === 'seller-owner').values, ['Yes']);
  assert.equal(checkSfrepPreview(preview, [8]), preview);
  const exterior = JSON.parse(JSON.stringify({ ok: true, ...previewSfrepDocuments([other], {
    accountId: '20035000010310000', assignmentFileId: 7, documentIds: [8],
    includeDocuments: true, formId: 'FNMA-2055-0911',
  }) }));
  assert.equal(checkSfrepPreview(exterior, [8], 'FNMA-2055-0911'), exterior);
  assert.equal(exterior.fields.find(field => field.fieldId === 'SellerOwnerPublicYesCheckBox')?.value, 'true');
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
