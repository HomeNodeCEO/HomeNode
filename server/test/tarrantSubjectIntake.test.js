import assert from 'node:assert/strict';
import test from 'node:test';
import PDFDocument from 'pdfkit';
import { extractPdfEvidence, buildDocumentFieldCandidates } from '../src/services/documentIntelligence.js';
import { buildUrarSubjectEvidence } from '../src/services/urarSubjectEvidence.js';
import { assignmentPostalAddress } from '../src/services/appraisalOrderAssignment.js';
import { buildTarrantCadSubjectEvidence } from '../src/services/tarrantCadSubjectEvidence.js';
import { sfrepDocumentPropertyRole, sfrepDocumentParcelMismatch } from '../src/services/sfrepSubjectContext.js';
import { buildCustomSubjectIdentity } from '../src/services/customSubjectIdentity.js';
import { projectCustomSubjectDocuments, mergeCustomSubjectApplication } from '../src/services/customSubjectApplication.js';
import { savedSfrepSubjectFields } from '../src/services/sfrepSavedReport.js';
import { buildSfrepReportExport } from '../src/services/sfrepReportExport.js';

// Entirely synthetic layout-shaped fixtures: no original client documents,
// names, addresses, account numbers, or order identifiers are published here.
const pid = '12345678', accountId = `TA${pid.padStart(15, '0')}`;
const context = { accountId, address: '100 EXAMPLE DR', city: 'Arlington', postalCode: '76010',
  canonicalIdentity: { accountId, address: '100 EXAMPLE DR', city: 'Arlington', postalCode: '76010',
    county: 'Tarrant', assessorParcelNumber: accountId }, effectiveDate: '2026-10-18' };
const assignmentPages = purpose => [
  `Order Information\nOrder Type: Residential Appraisal Order Number: QA-1\nProperty Address: 100 EXAMPLE DRIVE ARLINGTON TX 76010\n( Additional Resources )\nProperty County: Tarrant\nClient: Example Mortgage - Collateral\nManagement\nClient Address: 20 S Example\nRd, Houston TX 77077\nVendor: Example Appraiser\nTransaction Type: ${purpose} Legal Description: N/A\nFHA Case Number: 000-000\nhttps://estreetamc.com`,
  'Borrower Information\nBorrower Name: TAYLOR EXAMPLE\nContact Information\nENGAGEMENT LETTER',
];
const summaryPages = id => [`Online Services | Tarrant Appraisal District\nProperty Summary Report | Year 2026\nPID ${id} | 2026\nACCOUNT\nOWNER`,
  `Online Services | Tarrant Appraisal District\nPID ${id} | 2026\nTAXING UNITS\n220 TARRANT COUNTY 100.00`];
// Deliberately ordered labels first, values second, just like the generated
// county PDF. OWNER is followed in stream order by the numeric Property ID.
const labels = [['ACCOUNT', 40, 100], ['OWNER', 330, 100], ['Property ID:', 40, 120],
  ['Geographic ID:', 40, 145], ['Type:', 40, 165], ['Legal Description:', 40, 185],
  ['Property Use:', 40, 220], ['LOCATION', 40, 250], ['Address:', 40, 270], ['Protest:', 40, 310],
  ['Name:', 330, 120], ['Agent:', 330, 165], ['Mailing Address:', 330, 185], ['Ownership:', 330, 230]];
const values = [['12345678', 150, 120], ['99999-A-9', 150, 145], ['Real', 150, 165],
  ['EXAMPLE WOODS ADDN, THE', 150, 185], ['Block A Lot 9', 150, 200], ['Single Family', 150, 220],
  ['100 EXAMPLE DR,', 150, 270], ['ARLINGTON TX 76010', 150, 285], ['Not Filed', 150, 310],
  ['EXAMPLE TAYLOR and', 400, 120], ['EXAMPLE ALEX', 400, 135], ['None', 400, 165],
  ['999 OTHER ST', 440, 185], ['DALLAS TX 75201', 440, 200], ['100%', 400, 230]];
const textItems = () => [...labels, ...values].map(([str, x, y]) => ({ str,
  width: str.length * 3, transform: [1, 0, 0, 1, x, 792 - y] }));
const byKey = extraction => Object.fromEntries(extraction.candidates.map(candidate => [candidate.field_key, candidate.normalized_value]));
function reviewed(id, type, extraction) {
  return { id, account_id: accountId, assignment_file_id: 7001, document_type: type,
    processing_status: 'reviewed', subject_context: context,
    extraction_summary: { urar_subject_evidence: extraction.urar_subject_evidence || { source_kind: extraction.source_kind } },
    candidates: extraction.candidates.map((candidate, index) => ({ ...candidate, id: id * 100 + index + 1,
      document_id: id, review_status: 'confirmed', confirmed_value: candidate.normalized_value })) };
}
async function summaryPdf() {
  const pdf = new PDFDocument({ size: 'LETTER', margin: 30 });
  const chunks = [], done = new Promise((resolve, reject) => {
    pdf.on('data', chunk => chunks.push(chunk)); pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.on('error', reject);
  });
  pdf.fontSize(8).text('Online Services | Tarrant Appraisal District', 40, 35)
    .text('Property Summary Report | Year 2026', 40, 50).text(`PID ${pid} | 2026`, 40, 65);
  for (const [str, x, y] of [...labels, ...values]) pdf.text(str, x, y, { lineBreak: false });
  pdf.addPage().text('Online Services | Tarrant Appraisal District', 40, 35)
    .text(`PID ${pid} | 2026`, 40, 50).text('TAXING UNITS', 40, 65).text('220 TARRANT COUNTY 100.00', 40, 80);
  pdf.end(); return done;
}

test('Tarrant label coordinates separate Property ID, owner, legal, and situs from mailing address', () => {
  const result = buildUrarSubjectEvidence({ documentType: 'other', pages: summaryPages(pid), textItems: textItems() });
  assert.equal(result.source_kind, 'cad');
  assert.deepEqual(byKey(result), { assessor_parcel_number: pid, owner_name: 'EXAMPLE TAYLOR and EXAMPLE ALEX',
    legal_description: 'EXAMPLE WOODS ADDN, THE Block A Lot 9', neighborhood_name: 'EXAMPLE WOODS ADDN, THE',
    subject_property_address: '100 EXAMPLE DR, ARLINGTON, TX 76010', subject_street_address: '100 EXAMPLE DR',
    subject_city: 'ARLINGTON', subject_state: 'TX', subject_zip: '76010', county: 'Tarrant' });
  assert.ok(result.candidates.every(candidate => candidate.review_status === 'suggested' && candidate.page_number === 1));
});

test('values-only county print cannot invent General Info or treat its PID as owner', () => {
  const result = buildTarrantCadSubjectEvidence(summaryPages(pid), []);
  assert.deepEqual(byKey(result), { assessor_parcel_number: pid });
  const source = reviewed(1, 'other', result);
  assert.equal(sfrepDocumentPropertyRole(source), 'unknown', 'native PID alone cannot prove a namespaced internal account');
  assert.ok(result.unresolved.some(issue => issue.reason === 'tarrant_general_info_not_in_pdf'));
});

test('Tarrant adapter rejects mixed records, damaged coordinates and oversized or mixed report input', () => {
  for (const [pages, items] of [[summaryPages(pid).map((page, i) => i ? page.replace(pid, '87654321') : page), textItems()],
    [summaryPages(pid), textItems().map((item, i) => i === 0 ? { ...item, transform: [NaN] } : item)],
    [[...summaryPages(pid), 'REALIST PROPERTY REPORT\nOwner Name: Other Person'], textItems()],
    [[...summaryPages(pid), 'MLS#: 12345678'], textItems()],
    [[...summaryPages(pid), 'x'.repeat(4_001)], textItems()]]) {
    const result = buildUrarSubjectEvidence({ documentType: 'other', pages, textItems: items });
    assert.deepEqual(result.candidates, []);
    assert.ok(result.unresolved.some(issue => issue.reason === 'source_input_incomplete'));
  }
});

test('assignment order does not append Additional Resources, truncate client, or invent Purchase from Foreclosure', () => {
  const result = buildUrarSubjectEvidence({ documentType: 'engagement_letter', pages: assignmentPages('Foreclosure') });
  const values = byKey(result);
  assert.equal(values.subject_property_address, '100 EXAMPLE DRIVE, ARLINGTON, TX 76010');
  assert.equal(values.borrower_name, 'TAYLOR EXAMPLE');
  assert.equal(result.candidates.find(candidate => candidate.field_key === 'borrower_name').page_number, 2);
  assert.equal(values.lender_client_name, 'Example Mortgage - Collateral Management');
  assert.equal(values.lender_client_address, '20 S Example Rd, Houston TX 77077');
  assert.equal(values.assignment_type, 'other');
  assert.equal(values.assignment_explanation, 'Foreclosure');
  assert.ok(result.candidates.every(candidate => candidate.review_status === 'suggested'));
  assert.equal(byKey(buildUrarSubjectEvidence({ documentType: 'engagement_letter', pages: assignmentPages('Purchase') })).assignment_type, 'purchase_transaction');
  assert.equal(byKey(buildUrarSubjectEvidence({ documentType: 'engagement_letter', pages: assignmentPages('Refinance') })).assignment_type, 'refinance');
  assert.equal(byKey(buildUrarSubjectEvidence({ documentType: 'engagement_letter', pages: assignmentPages('Unknown') })).assignment_type, undefined);
  assert.equal(assignmentPostalAddress('100 DR EXAMPLE DR ARLINGTON TX 76010'), null, 'ambiguous suffix boundaries require review');
  assert.deepEqual(buildDocumentFieldCandidates({ documentType: 'engagement_letter',
    pages: [...assignmentPages('Foreclosure'), 'Property Address: 900 Different Dr, Arlington TX 76010'] }), []);
});

test('internal Tarrant key is not exported as APN and exact subject address still binds county evidence', () => {
  assert.equal(buildCustomSubjectIdentity(context).some(field => field.key === 'assessor_parcel_number'), false);
  const extraction = buildTarrantCadSubjectEvidence(summaryPages(pid), textItems());
  const source = reviewed(1, 'other', extraction);
  assert.equal(sfrepDocumentPropertyRole(source), 'subject');
  assert.equal(sfrepDocumentParcelMismatch(source), false);
  source.candidates.find(candidate => candidate.field_key === 'subject_street_address').confirmed_value = '999 OTHER DR';
  assert.equal(sfrepDocumentPropertyRole(source), 'comparable');
  const explicitNative = reviewed(1, 'other', extraction);
  explicitNative.subject_context = { ...context, assessorParcelNumber: '87654321' };
  assert.equal(sfrepDocumentPropertyRole(explicitNative), 'comparable', 'a known different county PID stays quarantined');
});

test('real PDF content-stream order -> reviewed workfile -> identical complete 1004/2055 Subject XML', async () => {
  const extraction = await extractPdfEvidence(await summaryPdf(), { fileName: 'synthetic-county-summary.pdf', requestedType: 'other' });
  assert.equal(byKey(extraction).owner_name, 'EXAMPLE TAYLOR and EXAMPLE ALEX');
  const cad = reviewed(1, 'other', extraction);
  const order = reviewed(2, 'engagement_letter', buildUrarSubjectEvidence({ documentType: 'engagement_letter', pages: assignmentPages('Foreclosure') }));
  const documents = [cad, order];
  const applied = mergeCustomSubjectApplication({ projection: projectCustomSubjectDocuments(documents) });
  assert.deepEqual(applied.assignmentDetails.assignment_types, ['other']);
  assert.equal(applied.assignmentDetails.assignment_explanation, 'Foreclosure');
  const saved = { accountId, assignmentFileId: 7001, assignmentRevision: 1, assignmentDetails: applied.assignmentDetails,
    subject: { value: applied.subject, revision: 1 }, evidence: { value: applied.evidence }, documents };
  const savedFields = savedSfrepSubjectFields(saved, { accountId, assignmentFileId: 7001 }).fields;
  for (const formId of ['FNMA-1004-0911', 'FNMA-2055-0911']) {
    const exported = buildSfrepReportExport({ formId, savedReportFields: savedFields });
    const fields = Object.fromEntries(exported.fields.map(field => [field.fieldId, field.value]));
    for (const [id, value] of Object.entries({ AssessorsParcelNumber: pid, StreetAddress: '100 Example Dr', City: 'Arlington',
      State: 'TX', ZipCode: '76010', County: 'Tarrant', BorrowerName: 'Taylor Example',
      OwnerName: 'Example Taylor And Example Alex', LegalDescription: 'EXAMPLE WOODS ADDN, THE Block A Lot 9',
      NeighborhoodName: 'Example Woods Addn, The', AssignmentTypeOtherCheckBox: 'true', AssignmentTypeOtherDescription: 'Foreclosure',
      PropertyRightsAppraisedFeeSimpleCheckBox: 'true', LenderClientCompanyName: 'Example Mortgage - Collateral Management',
      LenderClientCompanyUnparsedAddress: '20 S Example Rd, Houston TX 77077' })) assert.equal(fields[id], value, `${formId}: ${id}`);
    assert.match(exported.reportXml, new RegExp(`<Form Id="${formId}">`));
    assert.ok(!exported.reportXml.includes(accountId));
    assert.equal(fields.AssignmentTypePurchaseCheckBox, undefined);
  }
});

test('Other description remains paired, engagement-scoped, confirmed, and conflict-sensitive', () => {
  const source = reviewed(1, 'engagement_letter', buildUrarSubjectEvidence({ documentType: 'engagement_letter', pages: assignmentPages('Foreclosure') }));
  source.property_role = 'subject';
  for (const mutate of [doc => { doc.candidates = doc.candidates.filter(candidate => candidate.field_key !== 'assignment_explanation'); },
    doc => { doc.candidates.find(candidate => candidate.field_key === 'assignment_explanation').review_status = 'suggested'; },
    doc => { doc.document_type = 'purchase_contract'; },
    doc => { doc.candidates.find(candidate => candidate.field_key === 'assignment_type').confirmed_value = 'refinance'; }]) {
    const copy = structuredClone(source); mutate(copy);
    const fields = buildSfrepReportExport({ documents: [copy], subjectOnly: true }).fields;
    assert.equal(fields.some(field => /^AssignmentTypeOther/.test(field.fieldId)), false);
  }
  const conflicting = structuredClone(source);
  conflicting.candidates.push({ ...conflicting.candidates.find(candidate => candidate.field_key === 'assignment_type'), id: 199, confirmed_value: 'purchase_transaction' });
  assert.equal(buildSfrepReportExport({ documents: [conflicting], subjectOnly: true }).fields.some(field => /^AssignmentType/.test(field.fieldId)), false);
  const second = reviewed(2, 'engagement_letter', buildUrarSubjectEvidence({ documentType: 'engagement_letter', pages: assignmentPages('REO') }));
  second.property_role = 'subject';
  const selected = buildSfrepReportExport({ documents: [source, second], subjectOnly: true, fieldSelections: { assignment_type: 2 } });
  assert.equal(selected.fields.find(field => field.fieldId === 'AssignmentTypeOtherDescription')?.value, 'REO');
  assert.ok(selected.fields.filter(field => /^AssignmentType/.test(field.fieldId)).every(field => field.documentId === 2));
});
