import assert from 'node:assert/strict';
import test from 'node:test';
import { projectCustomSubjectDocuments, mergeCustomSubjectApplication } from '../src/services/customSubjectApplication.js';
import { savedSfrepSubjectFields } from '../src/services/sfrepSavedReport.js';
import { buildSfrepReportExport } from '../src/services/sfrepReportExport.js';
import { previewSfrepDocuments } from '../src/services/sfrepDocumentTransfer.js';

const input = { accountId: '000123', assignmentFileId: 4, documentIds: [1], formId: 'FNMA-1004-0911', includeDocuments: false };
const candidate = (field_key, confirmed_value, index = 1, documentId = 1) => ({ id: index, document_id: documentId, field_key, confirmed_value, review_status: 'confirmed' });
function fixture() {
  const documents = [{ id: 1, account_id: '000123', assignment_file_id: 4, document_type: 'engagement_letter',
    processing_status: 'reviewed', upload_date: '2026-10-02', file_size_bytes: 100, title: 'Synthetic Subject', file_name: 'subject.pdf',
    subject_context: { accountId: '000123', address: '100 Example Dr', city: 'Garland', postalCode: '75041', effectiveDate: '2026-08-31' },
    candidates: Object.entries({ subject_property_address: '100 Example Dr, Garland, TX 75041', assessor_parcel_number: '000123',
      borrower_name: 'Example Borrower', owner_name: 'Example Owner', county: 'Dallas', neighborhood_name: 'Example Park',
      legal_description: 'EXAMPLE PARK\nBLK 1 LOT 2', tax_year: '2025', tax_amount: '4321.50',
      assignment_type: 'purchase_transaction', lender_client_name: 'Example Bank', lender_client_address: '20 Example Ave, Austin TX 78701',
      hoa_dues_amount: '120.49', hoa_frequency: 'per_year', pud: 'false',
    }).map(([key, value], index) => candidate(key, value, index + 1)) }];
  const copy = (id, type, values, sourceKind) => ({ ...documents[0], id, document_type: type,
    extraction_summary: sourceKind ? { urar_subject_evidence: { source_kind: sourceKind } } : undefined,
    candidates: Object.entries(values).map(([key, value], index) => candidate(key, value, id * 100 + index, id)) });
  documents.push(copy(2, 'other', { subject_property_address: '100 Example Dr, Garland, TX 75041',
    assessor_parcel_number: '000123', owner_name: 'Example Owner', county: 'Dallas',
    neighborhood_name: 'Example Park', legal_description: 'EXAMPLE PARK\nBLK 1 LOT 2' }, 'cad'));
  documents.push(copy(3, 'other', { assessor_parcel_number: '000123', tax_year: '2025', tax_amount: '4321.50' }, 'realist'));
  documents.push(copy(4, 'mls_sheet', { subject_property_address: '100 Example Dr, Garland, TX 75041',
    hoa_dues_amount: '120.49', hoa_frequency: 'per_year', pud: 'false' }));
  const projection = projectCustomSubjectDocuments(documents);
  const applied = mergeCustomSubjectApplication({ projection });
  const saved = { accountId: '000123', assignmentFileId: 4, assignmentRevision: 2,
    assignmentDetails: applied.assignmentDetails, subject: { value: applied.subject, revision: 1 },
    evidence: { value: applied.evidence, revision: 1 }, documents };
  return { documents, saved, applied };
}
const exportSaved = saved => buildSfrepReportExport({ savedReportFields: savedSfrepSubjectFields(saved, input).fields });

test('reviewed Subject saves exact values and exports the canonical report, with honest provenance', () => {
  const { saved, applied } = fixture();
  assert.equal(applied.subject.urar_subject.tax_amount, '4321.50');
  assert.deepEqual(applied.subject.legal_description.lines, ['EXAMPLE PARK', 'BLK 1 LOT 2']);
  assert.equal(applied.assignmentDetails.pud, false);
  const result = exportSaved(saved);
  assert.equal(result.fields.find(field => field.fieldId === 'RealEstateTaxAmount').value, '4322');
  assert.equal(result.fields.find(field => field.fieldId === 'AssessorsParcelNumber').value, '000123');
  assert.equal(result.fields.find(field => field.fieldId === 'LegalDescription').value, 'EXAMPLE PARK BLK 1 LOT 2');
  assert.equal(result.fields.find(field => field.fieldId === 'BorrowerName').provenance.origin, 'reviewed_document');
  assert.equal(result.fields.find(field => field.fieldId === 'BorrowerName').provenance.sourceDocumentId, 1);
  assert.equal(result.fields.find(field => field.fieldId === 'PropertyRightsAppraisedFeeSimpleCheckBox').provenance.origin, 'user_default');
  assert.equal(result.assumptions.length, 1);
});

test('saved appraiser corrections replace old evidence for both Subject and Assignment exports', () => {
  const { saved, documents } = fixture();
  saved.subject.value.urar_subject.borrower_name = 'Corrected Borrower';
  saved.subject.value.urar_subject.tax_amount = '999.49';
  saved.assignmentDetails.lender_client_name = 'Corrected Bank';
  saved.assignmentDetails.assignment_types = ['refinance'];
  const result = buildSfrepReportExport({ documents, savedReportFields: savedSfrepSubjectFields(saved, input).fields });
  assert.match(result.reportXml, /Corrected Borrower/);
  assert.match(result.reportXml, /Corrected Bank/);
  assert.doesNotMatch(result.reportXml, /Example Borrower|Example Bank|AssignmentTypePurchaseCheckBox/);
  assert.match(result.reportXml, /AssignmentTypeRefinanceCheckBox/);
  const tax = result.fields.find(field => field.fieldId === 'RealEstateTaxAmount');
  assert.equal(tax.value, '999');
  assert.equal(tax.sourceValue, '999.49');
  assert.equal(tax.provenance.origin, 'appraiser_edit');
  assert.equal(tax.provenance.sourceDocumentId, undefined);
});

test('explicit clearing does not refill a report field from an old document or CAD', () => {
  const { saved, documents } = fixture();
  saved.subject.value.owner.owner_name = '';
  saved.subject.value.legal_description.lines = [];
  saved.assignmentDetails.assignment_types = [];
  const result = buildSfrepReportExport({ documents, savedReportFields: savedSfrepSubjectFields(saved, input).fields });
  assert.doesNotMatch(result.reportXml, /OwnerName|LegalDescription|AssignmentTypePurchaseCheckBox/);
});

test('saved owner-party corrections are the same canonical identity exported to SFREP', () => {
  const { saved } = fixture();
  saved.subject.value.owner.parties = [{ owner_name: 'Corrected Owner One' }, { owner_name: 'Corrected Owner Two' }];
  const owner = exportSaved(saved).fields.find(field => field.fieldId === 'OwnerName');
  assert.equal(owner.value, 'Corrected Owner One / Corrected Owner Two');
  assert.equal(owner.provenance.origin, 'appraiser_edit');
  saved.subject.value.owner.parties = [{ owner_name: '' }];
  assert.equal(exportSaved(saved).fields.some(field => field.fieldId === 'OwnerName'), false);
});

test('saved false or cleared PUD cannot be refilled by a document property-type alias', () => {
  for (const pud of [false, null, '']) {
    const { saved, documents } = fixture();
    saved.assignmentDetails.pud = pud;
    documents[0].candidates.push(candidate('property_type', 'PUD', 190));
    const result = buildSfrepReportExport({ documents, savedReportFields: savedSfrepSubjectFields(saved, input).fields });
    assert.doesNotMatch(result.reportXml, /PropertyTypePUDCheckBox/);
  }
});

test('saved street text never refills or conflicts with independently saved locality components', () => {
  for (const city of ['', 'Corrected City']) {
    const { saved, documents } = fixture();
    saved.subject.value.property_location = { address: '100 Example Dr, Garland, TX 75041', city, state: '', postal_code: '' };
    const result = buildSfrepReportExport({ documents, savedReportFields: savedSfrepSubjectFields(saved, input).fields });
    assert.equal(result.fields.find(field => field.fieldId === 'StreetAddress').value, '100 Example Dr, Garland, TX 75041');
    assert.equal(result.fields.find(field => field.fieldId === 'City')?.value, city || undefined);
    assert.equal(result.fields.some(field => ['State', 'ZipCode'].includes(field.fieldId)), false);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.omitted.some(field => field.documentId === null), false);
  }
});

for (const change of ['rejected', 'reprocessing', 'deleted', 'conflicting', 'changed_receipt']) {
  test(`previously applied evidence is omitted, not silently promoted to manual, when ${change}`, () => {
    const { saved } = fixture();
    const borrower = saved.documents[0].candidates.find(item => item.field_key === 'borrower_name');
    if (change === 'rejected') borrower.review_status = 'rejected';
    if (change === 'reprocessing') saved.documents[0].processing_status = 'processing';
    if (change === 'deleted') saved.documents = [];
    if (change === 'conflicting') saved.documents[0].candidates.push(candidate('borrower_name', 'Different Borrower', 200));
    if (change === 'changed_receipt') saved.evidence.value.fields.borrower_name.status = 'needs_review';
    const projection = savedSfrepSubjectFields(saved, input);
    assert.equal(projection.fields.some(field => field.sourceField === 'borrower_name'), false);
    assert.ok(projection.knownMissing.some(item => item.fieldId === 'BorrowerName'));
  });
}

test('canonical report scope and revisions are required, not supplied by the browser', () => {
  for (const patch of [{ accountId: 'other' }, { assignmentFileId: 9 }, { assignmentRevision: 0 }, { assignmentDetails: null }]) {
    assert.throws(() => savedSfrepSubjectFields({ ...fixture().saved, ...patch }, input), /invalid_saved_report/);
  }
  const { saved } = fixture();
  saved.subject.revision = 0;
  assert.throws(() => savedSfrepSubjectFields(saved, input), /invalid_saved_report/);
});

test('saved fields and both saved revisions participate in the preview receipt', () => {
  const { saved, documents } = fixture();
  documents[0].saved_report = saved;
  // Real reads carry a separate source snapshot, not the selected-PDF objects.
  saved.documents = structuredClone(documents.map(({ saved_report: _saved, ...document }) => document));
  const original = previewSfrepDocuments(documents, input);
  saved.subject.value.urar_subject.borrower_name = 'Saved Correction';
  assert.notEqual(original.preview_digest, previewSfrepDocuments(documents, input).preview_digest);
  const corrected = previewSfrepDocuments(documents, input);
  saved.subject.revision++;
  assert.notEqual(corrected.preview_digest, previewSfrepDocuments(documents, input).preview_digest);
  const revision = previewSfrepDocuments(documents, input);
  saved.assignmentRevision++;
  assert.notEqual(revision.preview_digest, previewSfrepDocuments(documents, input).preview_digest);
  assert.match(corrected.reportXml, /Saved Correction/);
});

test('multiple assignment choices and unsupported HOA frequency are not guessed', () => {
  const { saved } = fixture();
  saved.assignmentDetails.assignment_types = ['purchase_transaction', 'refinance'];
  saved.assignmentDetails.hoa_frequency = 'per_quarter';
  const result = exportSaved(saved);
  assert.doesNotMatch(result.reportXml, /AssignmentTypePurchaseCheckBox|AssignmentTypeRefinanceCheckBox|AssessmentAmount/);
});

test('presentation-only normalization preserves an exact older source receipt without concealing source changes', () => {
  const { saved } = fixture();
  const owner = saved.documents[1].candidates.find(candidate => candidate.field_key === 'owner_name');
  owner.confirmed_value = 'EXAMPLE OWNER';
  const proposal = projectCustomSubjectDocuments(saved.documents).fields.find(field => field.key === 'owner_name');
  saved.subject.value.owner.owner_name = 'EXAMPLE OWNER';
  saved.evidence.value.fields.owner_name = { ...proposal.provenance, reviewedSourceValue: proposal.sourceValue, value: 'EXAMPLE OWNER', status: 'current' };
  const exported = exportSaved(saved).fields.find(field => field.fieldId === 'OwnerName');
  assert.equal(exported.value, 'Example Owner');
  assert.equal(exported.provenance.origin, 'reviewed_document');
  owner.confirmed_value = 'DIFFERENT OWNER';
  assert.equal(exportSaved(saved).fields.some(field => field.fieldId === 'OwnerName'), false);
});

test('a stale identity receipt revalidates only when the current reviewed CAD still supports the saved value', () => {
  const { saved } = fixture();
  for (const key of ['subject_street_address', 'subject_city', 'subject_zip', 'county', 'assessor_parcel_number']) {
    saved.evidence.value.fields[key].status = 'needs_review';
  }
  const result = exportSaved(saved);
  for (const id of ['StreetAddress', 'City', 'ZipCode', 'County', 'AssessorsParcelNumber']) {
    assert.ok(result.fields.some(field => field.fieldId === id), id);
  }
  const cadAddress = saved.documents[1].candidates.find(item => item.field_key === 'subject_property_address');
  cadAddress.confirmed_value = '101 Different Dr, Garland, TX 75041';
  assert.equal(exportSaved(saved).fields.some(field => field.fieldId === 'StreetAddress'), false);
  cadAddress.confirmed_value = '100 Example Dr, Garland, TX 75041';
  cadAddress.review_status = 'rejected';
  assert.equal(exportSaved(saved).fields.some(field => field.fieldId === 'StreetAddress'), false);
});

test('a changed presentation of the same canonical account row does not strand saved locality', () => {
  const { saved } = fixture();
  for (const document of saved.documents) {
    document.subject_context.canonicalIdentity = { accountId: '000123', address: '100 Example Dr', city: 'Garland',
      postalCode: '75041', county: 'Dallas', assessorParcelNumber: '000123', state: 'TX' };
  }
  // CAD supplies the street and parcel; the account is the locality fallback.
  saved.documents[1].candidates = saved.documents[1].candidates.filter(item => item.field_key !== 'county');
  const applied = mergeCustomSubjectApplication({ projection: projectCustomSubjectDocuments(saved.documents) });
  saved.subject.value = applied.subject;
  saved.assignmentDetails = applied.assignmentDetails;
  saved.evidence.value = applied.evidence;
  const county = saved.evidence.value.fields.county;
  assert.equal(county.kind, 'account_reference');
  county.status = 'needs_review';
  county.reviewedSourceValue = 'DALLAS COUNTY';
  county.sourceEvidence[0].value = 'DALLAS COUNTY';
  assert.equal(exportSaved(saved).fields.find(field => field.fieldId === 'County')?.value, 'Dallas');
  saved.documents[0].subject_context.canonicalIdentity.county = 'Collin';
  assert.equal(exportSaved(saved).fields.some(field => field.fieldId === 'County'), false);
});

test('account Census provenance revalidates every source revision and never refills an explicit saved blank', () => {
  const { saved } = fixture();
  saved.documents[0].subject_context.censusGeography = { tractCode: '001234', status: 'matched',
    geoid: '48113001234', vintage: 'Census2020_Current', updatedAt: '2026-10-03T00:00:00Z' };
  const applied = mergeCustomSubjectApplication({ subject: saved.subject.value, assignmentDetails: saved.assignmentDetails,
    evidence: saved.evidence.value, projection: projectCustomSubjectDocuments(saved.documents), reviewedDocumentId: 1 });
  saved.subject.value = applied.subject;
  saved.evidence.value = applied.evidence;
  const result = exportSaved(saved).fields.find(field => field.fieldId === 'CensusTract');
  assert.equal(result.value, '12.34');
  assert.equal(result.provenance.origin, 'account_reference');
  assert.equal(result.provenance.sourceEvidence[0].accountId, '000123');
  saved.documents[0].subject_context.censusGeography.updatedAt = '2026-10-04T00:00:00Z';
  assert.equal(exportSaved(saved).fields.some(field => field.fieldId === 'CensusTract'), false);
  saved.subject.value.property_location.census_tract = '';
  assert.equal(exportSaved(saved).fields.some(field => field.fieldId === 'CensusTract'), false);
});

test('saved HOA workflow defaults remain identified as assumptions, not eligibility proof', () => {
  const { saved } = fixture();
  const pud = saved.documents[3].candidates.find(candidate => candidate.field_key === 'pud');
  Object.assign(pud, { raw_value: 'Yes', normalized_value: 'true', confirmed_value: 'true',
    extraction_method: 'urar_subject_mls_sheet_hoa_workflow_proxy' });
  const proposal = projectCustomSubjectDocuments(saved.documents).fields.find(field => field.key === 'pud');
  saved.assignmentDetails.pud = true;
  saved.evidence.value.fields.pud = { ...proposal.provenance, reviewedSourceValue: proposal.sourceValue, value: true, status: 'current' };
  const result = exportSaved(saved);
  assert.equal(result.fields.find(field => field.fieldId === 'PropertyTypePUDCheckBox').provenance.rule, 'user_requested_hoa_workflow_proxy_v1');
  assert.ok(result.assumptions.some(assumption => assumption.rule === 'user_requested_hoa_workflow_proxy_v1'));
});

test('phase and ZIP suffix presentation cannot hide a changed raw reviewed source', () => {
  for (const [key, original, replacement, fieldId] of [
    ['neighborhood_name', 'EXAMPLE PARK 4', 'EXAMPLE PARK 5', 'NeighborhoodName'],
    ['subject_zip', '75041-1234', '75041-5678', 'ZipCode'],
  ]) {
    const { saved } = fixture();
    saved.documents[1].candidates = saved.documents[1].candidates.filter(item => item.field_key !== key);
    const source = candidate(key, original, 199, 2);
    saved.documents[1].candidates.push(source);
    const applied = mergeCustomSubjectApplication({ projection: projectCustomSubjectDocuments(saved.documents) });
    saved.subject.value = applied.subject;
    saved.assignmentDetails = applied.assignmentDetails;
    saved.evidence.value = applied.evidence;
    assert.ok(exportSaved(saved).fields.some(field => field.fieldId === fieldId));
    source.confirmed_value = replacement;
    assert.equal(exportSaved(saved).fields.some(field => field.fieldId === fieldId), false);
  }
});
