import assert from 'node:assert/strict';
import test from 'node:test';
import { projectCustomSubjectDocuments, mergeCustomSubjectApplication } from '../src/services/customSubjectApplication.js';
import { savedSfrepSubjectFields } from '../src/services/sfrepSavedReport.js';
import { buildSfrepReportExport } from '../src/services/sfrepReportExport.js';
import { sfrepDocumentPropertyRole, sfrepWorkfileDocumentRoles } from '../src/services/sfrepSubjectContext.js';
import { selectSubjectPurchaseContract } from '../src/services/subjectPurchaseContract.js';
import { classifyDocument } from '../src/services/documentIntelligence.js';

const context = { accountId: '000123', address: '100 OLD ADDRESS DR', city: 'Garland', postalCode: '75041',
  canonicalIdentity: { accountId: '000123', address: '100 OLD ADDRESS DR', city: 'Garland',
    postalCode: '75041', county: 'Dallas', assessorParcelNumber: '000123', state: 'TX' },
  censusGeography: { tractCode: '016617', status: 'matched', geoid: '48113016617',
    vintage: 'Census2020_Current', updatedAt: '2026-10-04T00:00:00Z' }, effectiveDate: '2026-08-31' };
const candidate = (documentId, field_key, confirmed_value, index) => ({ id: documentId * 100 + index,
  document_id: documentId, field_key, raw_value: confirmed_value, normalized_value: confirmed_value,
  confirmed_value, review_status: 'confirmed' });
const document = (id, type, values, kind) => ({ id, account_id: '000123', assignment_file_id: 4,
  document_type: type, processing_status: 'reviewed', subject_context: context,
  ...(kind ? { extraction_summary: { urar_subject_evidence: { source_kind: kind } } } : {}),
  candidates: Object.entries(values).map(([key, value], index) => candidate(id, key, value, index + 1)) });

function sources() {
  const engagement = document(1, 'engagement_letter', { subject_property_address: '200 New Address Dr, Garland, TX 75042',
    borrower_name: 'Borrower One', assignment_type: 'purchase_transaction', lender_client_name: 'Example Bank',
    lender_client_address: '10 Bank St, Dallas, TX 75201', owner_name: 'Wrong Owner' });
  const cad = document(2, 'other', { assessor_parcel_number: '000123',
    subject_property_address: '200 New Address Dr, Garland, TX 75042', county: 'Dallas',
    owner_name: 'Cad Owner', legal_description: 'NEW PARK 4 BLK 1 LOT 2', neighborhood_name: 'New Park 4',
    census_tract: '999.99' }, 'cad');
  const realist = document(3, 'other', { assessor_parcel_number: '000123', tax_year: '2025',
    tax_amount: '16089.00', owner_name: 'Wrong Realist Owner' }, 'realist');
  const mls = document(4, 'mls_sheet', { subject_property_address: '200 New Address Dr, Garland, TX 75042',
    pud: 'true', hoa_dues_amount: '600.00', hoa_frequency: 'per_year', owner_name: 'Wrong MLS Owner' });
  return [engagement, cad, realist, mls];
}

test('CAD is the workfile identity even when shared account and other PDFs differ', () => {
  const documents = sources();
  assert.equal(sfrepDocumentPropertyRole(documents[1]), 'subject');
  const projected = projectCustomSubjectDocuments(documents);
  const byKey = Object.fromEntries(projected.fields.map(field => [field.key, field]));
  assert.equal(byKey.subject_street_address.value, '200 New Address Dr');
  assert.equal(byKey.subject_city.value, 'Garland');
  assert.equal(byKey.subject_zip.value, '75042');
  assert.equal(byKey.owner_name.value, 'Cad Owner');
  assert.equal(byKey.neighborhood_name.value, 'New Park');
  assert.equal(byKey.legal_description.value, 'NEW PARK 4 BLK 1 LOT 2');
  assert.equal(byKey.assessor_parcel_number.value, '000123');
  assert.equal(byKey.borrower_name.value, 'Borrower One');
  assert.equal(byKey.lender_client_name.value, 'Example Bank');
  assert.equal(byKey.assignment_type.value, 'purchase_transaction');
  assert.equal(byKey.pud.value, true);
  assert.equal(byKey.tax_amount.value, '16089.00');
  assert.notEqual(byKey.census_tract.value, '999.99');
  assert.equal(byKey.subject_street_address.provenance.documentId, 2);
  assert.equal(byKey.borrower_name.provenance.documentId, 1);
  assert.equal(byKey.pud.provenance.documentId, 4);
});

test('old evidence receipts migrate only when reviewed CAD agrees, for both 1004 and 2055', () => {
  const documents = sources();
  const applied = mergeCustomSubjectApplication({ projection: projectCustomSubjectDocuments(documents) });
  const saved = { accountId: '000123', assignmentFileId: 4, assignmentRevision: 1,
    assignmentDetails: applied.assignmentDetails, subject: { value: applied.subject, revision: 1 },
    evidence: { value: applied.evidence }, documents };
  const old = saved.evidence.value.fields.subject_street_address;
  saved.evidence.value.fields.subject_street_address = { ...old, documentId: 1, candidateId: 101,
    reviewedSourceValue: '200 New Address Dr', status: 'current' };
  for (const formId of ['FNMA-1004-0911', 'FNMA-2055-0911']) {
    const fields = savedSfrepSubjectFields(saved, { accountId: '000123', assignmentFileId: 4 }).fields;
    const exported = buildSfrepReportExport({ formId, savedReportFields: fields });
    assert.equal(exported.fields.find(field => field.fieldId === 'StreetAddress')?.value, '200 New Address Dr');
    assert.equal(exported.fields.find(field => field.fieldId === 'StreetAddress')?.provenance.sourceDocumentId, 2);
    for (const id of ['City', 'State', 'ZipCode', 'County', 'AssessorsParcelNumber', 'OwnerName', 'NeighborhoodName']) {
      assert.ok(exported.fields.some(field => field.fieldId === id), `${formId}: ${id}`);
    }
  }
  const cadAddress = documents[1].candidates.find(item => item.field_key === 'subject_property_address');
  cadAddress.confirmed_value = '201 Different Address Dr, Garland, TX 75042';
  assert.equal(savedSfrepSubjectFields(saved, { accountId: '000123', assignmentFileId: 4 }).fields
    .some(field => field.sourceField === 'subject_street_address'), false);
});

test('the labeled base contract wins over financing; unrelated addenda stay Other', () => {
  const base = document(5, 'purchase_contract', {});
  base.title = 'Contract.pdf';
  const addendum = document(6, 'purchase_contract', {});
  addendum.title = 'Thhird PArty Financing.pdf';
  assert.equal(selectSubjectPurchaseContract([addendum, base]).document.id, 5);
  assert.equal(selectSubjectPurchaseContract([addendum]).document, null);
  assert.equal(classifyDocument({ fileName: 'Third Party Financing Addendum.pdf',
    pages: ['One to Four Family Residential Contract. Earnest Money $1,000'] }), 'other');
  assert.equal(classifyDocument({ fileName: 'Thhird PArty Financing.pdf',
    pages: ['One to Four Family Residential Contract. Earnest Money $1,000'] }), 'other');
});

test('PUD is not inferred from a generic property-type label outside MLS', () => {
  const documents = sources();
  documents[3].candidates = documents[3].candidates.filter(candidate =>
    !['pud', 'hoa_dues_amount', 'hoa_frequency'].includes(candidate.field_key));
  documents[1].candidates.push(candidate(2, 'property_type', 'PUD', 99));
  assert.equal(projectCustomSubjectDocuments(documents).fields.some(field => field.key === 'pud'), false);
});

test('1004 and 2055 use the same CAD identity and base-contract terms without attached PDFs', () => {
  const documents = sources();
  const base = document(5, 'purchase_contract', {
    subject_property_address: '200 New Address Dr, Garland, TX 75042', contract_date: '2026-08-25',
    contract_price: '785000', earnest_money: '7800', down_payment: '157000',
    loan_amount: '628000', seller_concessions: '0',
  });
  base.title = 'Purchase agreement';
  base.file_name = 'Contract.pdf';
  const financing = document(6, 'purchase_contract', { subject_property_address: '200 New Address Dr, Garland, TX 75042',
    contract_date: '2026-08-26', contract_price: '900000' });
  financing.title = 'Thhird PArty Financing.pdf';
  documents.push(financing, base);
  const applied = mergeCustomSubjectApplication({ projection: projectCustomSubjectDocuments(documents) });
  const saved = { accountId: '000123', assignmentFileId: 4, assignmentRevision: 1,
    assignmentDetails: { ...applied.assignmentDetails, contract_arms_length: true },
    subject: { value: applied.subject, revision: 1 }, evidence: { value: applied.evidence }, documents };
  const savedFields = savedSfrepSubjectFields(saved, { accountId: '000123', assignmentFileId: 4 }).fields;
  for (const formId of ['FNMA-1004-0911', 'FNMA-2055-0911']) {
    const exported = buildSfrepReportExport({ formId, documents: [], savedReportFields: savedFields,
      contractSection: true, contractEvidenceDocuments: sfrepWorkfileDocumentRoles(documents),
      savedAssignmentDetails: saved.assignmentDetails });
    const byId = Object.fromEntries(exported.fields.map(field => [field.fieldId, field]));
    assert.equal(byId.StreetAddress?.value, '200 New Address Dr', formId);
    assert.equal(byId.City?.value, 'Garland', formId);
    assert.equal(byId.ZipCode?.value, '75042', formId);
    assert.equal(byId.OwnerName?.value, 'Cad Owner', formId);
    assert.equal(byId.AnalyzedContractYesCheckBox?.value, 'true', formId);
    assert.equal(byId.ContractDate?.value, '08/25/2026', formId);
    assert.equal(byId.SalePriceAmount?.value, '785000.00', formId);
    assert.match(byId.AnalyzedContractDescription?.value || '', /purchase price of \$785,000/);
    assert.equal(byId.AnalyzedContractDescription?.provenance.documentId, 5);
    assert.equal(exported.pdfAddenda.length, 0);
  }
});
