import assert from 'node:assert/strict';
import test from 'node:test';
import PDFDocument from 'pdfkit';
import { extractPdfEvidence, buildDocumentFieldCandidates, classifyDocument } from '../src/services/documentIntelligence.js';
import { sfrepDocumentPropertyRole } from '../src/services/sfrepSubjectContext.js';
import { previewSfrepDocuments } from '../src/services/sfrepDocumentTransfer.js';
import { SFREP_SUBJECT_QA, SFREP_SUBJECT_DOCUMENTS } from './fixtures/sfrepSubjectDocuments.js';

async function pdfFor(lines) {
  const pdf = new PDFDocument({ size: 'LETTER', margin: 48 });
  const chunks = [];
  const done = new Promise((resolve, reject) => { pdf.on('data', chunk => chunks.push(chunk)); pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.on('error', reject); });
  lines.forEach(line => pdf.text(line)); pdf.end(); return done;
}

test('four uploaded PDF families -> reviewed Subject evidence -> complete 1004 Subject transfer', async () => {
  const documents = [];
  for (const fixture of SFREP_SUBJECT_DOCUMENTS) {
    const bytes = await pdfFor(fixture.lines);
    const extracted = await extractPdfEvidence(bytes, { requestedType: fixture.type, fileName: `${fixture.title}.pdf` });
    assert.equal(extracted.document_type, fixture.type);
    assert.equal(extracted.extraction_status, 'review_required');
    assert.ok(extracted.urar_subject_evidence.source_kind);
    const document = { id: fixture.id, document_type: fixture.type, processing_status: 'reviewed',
      subject_context: SFREP_SUBJECT_QA, file_size_bytes: bytes.length,
      candidates: extracted.candidates.map((candidate, index) => ({ ...candidate, id: fixture.id * 100 + index,
        document_id: fixture.id, review_status: 'confirmed', confirmed_value: candidate.normalized_value })) };
    document.property_role = sfrepDocumentPropertyRole(document);
    assert.equal(document.property_role, 'subject', fixture.title);
    documents.push(document);
  }
  const preview = previewSfrepDocuments(documents, { accountId: SFREP_SUBJECT_QA.accountId, assignmentFileId: 7001, includeDocuments: false, formId: 'FNMA-1004-0911' });
  assert.deepEqual(preview.conflicts, []);
  const fields = Object.fromEntries(preview.fields.map(field => [field.fieldId, field.value]));
  for (const [fieldId, value] of Object.entries({ StreetAddress: '100 Example Dr', City: 'Garland', State: 'TX', ZipCode: '75041',
    BorrowerName: 'Taylor Example', OwnerName: 'Morgan Publicrecord', County: 'Dallas', AssessorsParcelNumber: '00001234567890000',
    RealEstateTaxYear: '2025', RealEstateTaxAmount: '4321.50', NeighborhoodName: 'EXAMPLE PARK 4', PropertyTypePUDCheckBox: 'true',
    PropertyRightsAppraisedFeeSimpleCheckBox: 'true', AssignmentTypePurchaseCheckBox: 'true',
    LenderClientCompanyName: 'Example QA Bank', LenderClientCompanyUnparsedAddress: '20 Finance Road, Austin, TX 78701',
    CurrentPriorListingYesCheckBox: 'true' })) assert.equal(fields[fieldId], value, fieldId);
  assert.equal(preview.fields.find(field => field.fieldId === 'RealEstateTaxAmount').documentId, 4);
  assert.equal(preview.fields.find(field => field.fieldId === 'OwnerName').documentId, 3);
  assert.equal(preview.fields.find(field => field.fieldId === 'BorrowerName').documentId, 1);
  assert.equal(preview.fields.find(field => field.fieldId === 'CurrentPriorListingYesCheckBox').documentId, 2);
  assert.equal(preview.assumptions.length, 1);
});

test('Realist heading outranks incidental MLS references and invalid listing dates do not roll forward', () => {
  const pages = ['REALIST PROPERTY REPORT\nMLS Number: 123456\nTax Year: 2025\nTotal Taxes: $4,321.50'];
  assert.equal(classifyDocument({ pages }), 'other');
  const candidates = buildDocumentFieldCandidates({ documentType: 'other', pages });
  assert.equal(candidates.find(value => value.field_key === 'tax_amount')?.normalized_value, '4321.50');
  assert.equal(candidates.some(value => value.field_key === 'mls_number'), false);
  assert.equal(buildDocumentFieldCandidates({ documentType: 'mls_sheet', pages: ['List Date: 02/30/2026'] }).some(value => value.field_key === 'list_date'), false);
});

test('new fields are not silently confirmed or taken from suggested candidates', () => {
  const candidates = buildDocumentFieldCandidates({ documentType: 'other', pages: [SFREP_SUBJECT_DOCUMENTS[3].lines.join('\n')] });
  assert.ok(candidates.some(value => value.field_key === 'tax_amount'));
  const preview = previewSfrepDocuments([{ id: 4, candidates, file_size_bytes: 100, processing_status: 'review_required', property_role: 'subject' }],
    { accountId: SFREP_SUBJECT_QA.accountId, assignmentFileId: 7001, includeDocuments: false, formId: 'FNMA-1004-0911' });
  assert.equal(preview.fields.some(field => field.fieldId === 'RealEstateTaxAmount'), false);
});

test('engagement conflicts survive legacy-parser integration and prevent first-match export', () => {
  const candidates = buildDocumentFieldCandidates({ documentType: 'engagement_letter', pages: [
    'Property Address: 100 Example Dr, Garland, TX 75041\nLoan Purpose: Purchase\nLoan Purpose: Refinance\nLender: Bank One\nLender: Bank Two',
  ] });
  assert.equal(candidates.filter(candidate => candidate.field_key === 'assignment_type').length, 2);
  assert.equal(candidates.filter(candidate => candidate.field_key === 'lender_client_name').length, 2);
  const preview = previewSfrepDocuments([{ id: 1, document_type: 'engagement_letter', property_role: 'subject', processing_status: 'reviewed', file_size_bytes: 100,
    candidates: candidates.map((candidate, index) => ({ ...candidate, id: index + 1, document_id: 1, review_status: 'confirmed', confirmed_value: candidate.normalized_value })) }],
    { accountId: SFREP_SUBJECT_QA.accountId, assignmentFileId: 7001, includeDocuments: false, formId: 'FNMA-1004-0911' });
  assert.equal(preview.conflicts.length, 2);
  assert.equal(preview.fields.some(field => field.fieldId === 'LenderClientCompanyName' || field.fieldId === 'AssignmentTypePurchaseCheckBox'), false);
});
