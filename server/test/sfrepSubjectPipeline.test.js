import assert from 'node:assert/strict';
import test from 'node:test';
import PDFDocument from 'pdfkit';
import { extractPdfEvidence, buildDocumentFieldCandidates, classifyDocument } from '../src/services/documentIntelligence.js';
import { sfrepDocumentPropertyRole } from '../src/services/sfrepSubjectContext.js';
import { previewSfrepDocuments } from '../src/services/sfrepDocumentTransfer.js';
import { SFREP_SUBJECT_QA, SFREP_SUBJECT_DOCUMENTS } from './fixtures/sfrepSubjectDocuments.js';

async function pdfFor(lines, fontSize = 12) {
  const pdf = new PDFDocument({ size: 'LETTER', margin: 48 });
  pdf.fontSize(fontSize);
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
    RealEstateTaxYear: '2025', RealEstateTaxAmount: '4322', NeighborhoodName: 'EXAMPLE PARK 4', PropertyTypePUDCheckBox: 'true',
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

test('printed CAD, tabular Property Details, and Matrix PDFs populate the same reviewed Subject coherently', async () => {
  // Layout-shaped fixtures only; no client names, addresses, IDs or PDF bytes.
  const fixtures = [SFREP_SUBJECT_DOCUMENTS[0],
    { id: 2, type: 'mls_sheet', lines: [
      '100 Example Dr, Garland, Texas 75041',
      'MLS#: 12345678 Active Option Contract 100 Example Dr Garland, TX 75041-1234 LP: $310,000',
      'Property Type: Residential SubType: Single Family',
      'Parcel ID: 00001234567890000 Plan Dvlpm:', 'Country: United States Lse MLS#:',
      'HOA: None HOA Co:', 'CDOM: 31 DOM: 31 LD: 09/01/2026 XD:', 'Contract Date: 09/30/2026',
    ] },
    { id: 3, type: 'other', lines: [
      'Residential Account #00001234567890000', 'Property Location (Current 2027)',
      'Address: 100 EXAMPLE DR', 'Neighborhood: 1EXAMPLE',
      'Owner (Current 2027)', 'MORGAN PUBLICRECORD &', 'ALEX PUBLICRECORD',
      '999 OTHER ROAD', 'AUSTIN, TEXAS 78701', 'Multi-Owner (Current 2027)',
      'Owner Name Ownership %', 'MORGAN PUBLICRECORD & 50%', 'ALEX PUBLICRECORD 50%',
      'Legal Desc (Current 2027)', '1: EXAMPLE PARK 4', '2: BLK A LT 2', '3:', '4: EXAMPLE DEED', '5: EXAMPLE RECORD',
      'Deed Transfer Date: 01/01/2025', 'Value', '2026 Certified Values',
      '10/2/26, 1:11 PM DCAD: Residential Acct Detail',
      'https://www.dallascad.org/AcctDetailRes.aspx?ID=00001234567890000 1/1',
    ] },
    { id: 4, type: 'other', lines: [
      '100 Example Dr, Garland, TX 75041-1234, Dallas County Active Listing',
      'APN: 0000-1234567890000 CLIP: 1234567890',
      'MLS List Date 09/01/2026', 'OWNER INFORMATION', 'Owner Name Morgan Publicrecord',
      'LOCATION INFORMATION', 'Location City Garland', 'TAX INFORMATION',
      'ASSESSMENT & TAX', 'Assessment Year 2026 2025 2024', 'Assessed Value - Total $900,000 $800,000 $700,000',
      'Tax Year Total Tax Change ($) Change (%)', '2023 $3,000', '2024 $3,500 $500 16.67%', '2025 $4,321.50 $821.50 23.47%',
      'Jurisdiction Tax Amount Tax Type Tax Rate', 'Example County $200.00 Actual .1', 'CHARACTERISTICS',
      'Property Details Courtesy of QA Reviewer, Example MLS Generated on: 10/02/26',
      'The data within this report is compiled by CoreLogic from public and private sources.',
    ] },
  ];
  const documents = [];
  for (const fixture of fixtures) {
    const bytes = await pdfFor(fixture.lines, 8);
    const extraction = await extractPdfEvidence(bytes, { requestedType: fixture.type, fileName: 'synthetic-layout.pdf' });
    assert.equal(extraction.document_type, fixture.type);
    assert.equal(extraction.extraction_status, 'review_required');
    const document = { id: fixture.id, document_type: extraction.document_type, processing_status: 'reviewed',
      subject_context: SFREP_SUBJECT_QA, file_size_bytes: bytes.length,
      candidates: extraction.candidates.map((candidate, index) => ({ ...candidate, id: fixture.id * 100 + index,
        document_id: fixture.id, review_status: 'confirmed', confirmed_value: candidate.normalized_value })) };
    document.property_role = sfrepDocumentPropertyRole(document);
    assert.equal(document.property_role, 'subject', `source ${fixture.id}`);
    documents.push(document);
  }
  const preview = previewSfrepDocuments(documents, { accountId: SFREP_SUBJECT_QA.accountId, assignmentFileId: 7001, includeDocuments: false, formId: 'FNMA-1004-0911' });
  assert.deepEqual(preview.conflicts, []);
  const fields = Object.fromEntries(preview.fields.map(field => [field.fieldId, field.value]));
  assert.equal(fields.StreetAddress, '100 Example Dr');
  assert.equal(fields.ZipCode, '75041-1234');
  assert.equal(fields.OwnerName, 'MORGAN PUBLICRECORD &\nALEX PUBLICRECORD');
  assert.equal(fields.AssessorsParcelNumber, '00001234567890000');
  assert.equal(fields.County, 'Dallas');
  assert.equal(fields.NeighborhoodName, 'EXAMPLE PARK 4');
  assert.equal(fields.RealEstateTaxYear, '2025');
  assert.equal(fields.RealEstateTaxAmount, '4322');
  assert.equal(fields.CurrentPriorListingYesCheckBox, 'true');
  assert.equal(fields.AssignmentTypePurchaseCheckBox, 'true');
  assert.equal(fields.PropertyTypePUDCheckBox, undefined);
  assert.equal(fields.AssessmentAmount, undefined);
  assert.equal(preview.fields.find(field => field.fieldId === 'OwnerName').documentId, 3);
  assert.equal(preview.fields.find(field => field.fieldId === 'RealEstateTaxAmount').documentId, 4);
});
