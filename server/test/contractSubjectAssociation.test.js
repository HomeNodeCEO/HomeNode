import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContractSubjectAssociation, hasCurrentContractSubjectAssociation, contractAssociationReviewSnapshot } from '../src/services/contractSubjectAssociation.js';
import { sfrepDocumentPropertyRole } from '../src/services/sfrepSubjectContext.js';
import { buildCustomSubjectListingHistory } from '../src/services/customSubjectListingHistory.js';
import { confirmAssignmentDocumentDespiteSubjectMismatch } from '../src/services/assignmentDocuments.js';

const actor = { reviewer: 'Synthetic Appraiser', actorUserId: 'appraiser-123', acknowledgedAt: '2026-10-04T12:00:00Z' };
function source() {
  const canonicalIdentity = { accountId: '123', address: '100 Example Dr', city: 'Garland', postalCode: '75041',
    county: 'DALLAS', state: 'TX', assessorParcelNumber: '123' };
  return { id: 2, account_id: '123', assignment_file_id: 4, document_type: 'purchase_contract', processing_status: 'reviewed',
    checksum_sha256: 'a'.repeat(64), extraction_summary: {}, subject_context: { ...canonicalIdentity, canonicalIdentity },
    candidates: [
      { id: 20, field_key: 'contract_printed_subject_addresses', raw_value: 'Main: 100 Example, Dallas TX 75041\nAddendum: 100 Example Dr, Garland TX 75041' },
      { id: 21, field_key: 'contract_date', raw_value: '2026-08-25' },
    ].map(candidate => ({ ...candidate, normalized_value: candidate.raw_value, confirmed_value: candidate.raw_value,
      review_status: 'confirmed', document_id: 2 })) };
}
function associate(document = source()) {
  const receipt = buildContractSubjectAssociation(document, actor);
  assert.ok(receipt);
  document.extraction_summary.contract_subject_association = receipt;
  return document;
}
const expectedRequest = document => ({ accountId: document.account_id, assignmentFileId: document.assignment_file_id,
  documentChecksumSha256: document.checksum_sha256, reviewedCandidates: contractAssociationReviewSnapshot(document) });
function listingDocuments(contract) {
  const candidate = (id, field_key, confirmed_value) => ({ id, field_key, confirmed_value, review_status: 'confirmed' });
  return [
    { id: 1, document_type: 'mls_sheet', property_role: 'subject', processing_status: 'reviewed', candidates: [
      candidate(11, 'mls_number', '77700001'), candidate(12, 'list_date', '2026-05-29'),
      candidate(13, 'original_list_price', '345000'), candidate(14, 'days_on_market', '77'),
      candidate(15, 'listing_price_history', JSON.stringify({ schema_version: 1, listing_id: '77700001', list_date: '2026-05-29', coverage: 'complete', price_changes: [] })),
    ] }, { ...contract, property_role: sfrepDocumentPropertyRole(contract) },
  ];
}
const listingContext = { effectiveDate: '2026-08-31', effectiveDateSource: 'assignment_effective_date', effectiveDateSourceDocumentId: null };

test('explicit contract association permits reviewed listing date only and never promotes document identity', () => {
  const contract = source();
  assert.equal(sfrepDocumentPropertyRole(contract), 'unknown');
  assert.equal(buildCustomSubjectListingHistory(listingDocuments(contract), listingContext).field, undefined);
  associate(contract);
  assert.equal(hasCurrentContractSubjectAssociation(contract), true);
  assert.equal(sfrepDocumentPropertyRole(contract), 'unknown');
  const listing = buildCustomSubjectListingHistory(listingDocuments(contract), listingContext);
  assert.match(listing.field.value, /under current contract on 08\/25\/2026$/);
  assert.ok(listing.warnings.some(value => /explicitly associated.*printed-address discrepancies/.test(value)));
  assert.equal(listing.field.provenance.sourceEvidence.filter(value => value.documentId === 2).length, 1);
  assert.equal(listing.field.provenance.sourceEvidence.find(value => value.documentId === 2).sourceField, 'contract_date');
});

test('association is exact, current, account/file/checksum/canonical-identity bound and cannot approve new evidence', () => {
  for (const change of [
    doc => { delete doc.extraction_summary.contract_subject_association; },
    doc => { doc.extraction_summary.contract_subject_association = { acknowledged: true }; },
    doc => { doc.extraction_summary.contract_subject_association.extra = true; },
    doc => { doc.extraction_summary.contract_subject_association.reviewerUserId = ''; },
    doc => { doc.account_id = 'other'; }, doc => { doc.assignment_file_id = 8; }, doc => { doc.id = 3; },
    doc => { doc.checksum_sha256 = 'b'.repeat(64); }, doc => { doc.processing_status = 'processing'; },
    doc => { doc.document_type = 'engagement_letter'; }, doc => { doc.uad_workfile_id = 'uad'; },
    doc => { doc.subject_context.canonicalIdentity.address = '102 Example Dr'; },
    doc => { doc.subject_context.canonicalIdentity.city = 'Dallas'; },
    doc => { doc.subject_context.canonicalIdentity.postalCode = '75201'; },
    doc => { doc.candidates[0].confirmed_value = 'Edited address'; }, doc => { doc.candidates[0].raw_value = 'New printed address'; },
    doc => { doc.candidates[0].review_status = 'suggested'; }, doc => { doc.candidates[1].review_status = 'rejected'; },
    doc => { doc.candidates[1].confirmed_value = '2026-08-26'; }, doc => { doc.candidates[1].id = 99; },
    doc => { doc.candidates[1].document_id = 99; },
    doc => { doc.candidates.push({ ...doc.candidates[1], id: 22, review_status: 'suggested' }); },
  ]) {
    const contract = associate(); change(contract);
    assert.equal(hasCurrentContractSubjectAssociation(contract), false, String(change));
    assert.equal(buildCustomSubjectListingHistory(listingDocuments(contract), listingContext).field, undefined, String(change));
  }
});

function servicePool(document, { signed = false, applyReport = false } = {}) {
  const queries = [];
  const assignmentDetails = { contract_price: '999999', contract_date: '2026-01-02', lender_client_name: 'Appraiser Bank' };
  const originalSubject = { property_location: { address: '100 Appraiser Correction Dr' }, urar_subject: { borrower_name: 'Saved Borrower' } };
  const originalEvidence = { fields: { borrower_name: { value: 'Saved Borrower', status: 'current', documentId: 99 } } };
  const savedSections = new Map([
    ['report.subject_identification', { section_key: 'report.subject_identification', section_value: structuredClone(originalSubject), revision: 2 }],
    ['report.subject_evidence', { section_key: 'report.subject_evidence', section_value: structuredClone(originalEvidence), revision: 2 }],
  ]);
  const client = { release() {}, async query(sql, values = []) {
    queries.push({ sql, values });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (/SELECT account_id, assignment_file_id/.test(sql)) return { rows: [document] };
    if (/SELECT id, file_number FROM app.assignment_files/.test(sql)) return { rows: [{ id: 4, file_number: 'SYNTHETIC' }] };
    if (/INSERT INTO app.custom_appraisal_workfiles/.test(sql)) return { rows: [] };
    if (/FROM app.custom_appraisal_workfiles workfile/.test(sql)) return { rows: [{ status: signed ? 'signed' : 'draft' }] };
    if (/SELECT \* FROM app.assignment_documents/.test(sql)) return { rows: [document] };
    if (/FROM core.accounts subject/.test(sql)) { const c = document.subject_context.canonicalIdentity;
      return { rows: [{ account_id: c.accountId, address: c.address, city: c.city, postal_code: c.postalCode, county: c.county, state: c.state }] }; }
    if (/SELECT \* FROM app.assignment_document_field_candidates/.test(sql)) return { rows: document.candidates };
    if (/UPDATE app.assignment_documents SET extraction_summary/.test(sql)) {
      document.extraction_summary = JSON.parse(values[1]); return { rows: [] };
    }
    if (/SELECT assignment_file.id/.test(sql)) {
      // The persistence read must see an already-stored association. Returning
      // no report keeps this service-order test independent of report SQL mocks.
      assert.equal(hasCurrentContractSubjectAssociation(document), true);
      return { rows: applyReport ? [{ id: 4, account_id: '123', file_number: 'SYNTHETIC', assignment_details: assignmentDetails,
        revision: 3, workfile_status: 'draft' }] : [] };
    }
    if (/census_available/.test(sql)) return { rows: [{ census_available: false }] };
    if (/SELECT document.id, document.account_id/.test(sql)) {
      const sheet = listingDocuments(document)[0];
      Object.assign(sheet, { account_id: '123', assignment_file_id: 4, subject_context: { ...document.subject_context, effectiveDate: '2026-08-31' } });
      sheet.candidates.push({ id: 16, field_key: 'subject_property_address', confirmed_value: '100 Example Dr, Garland, TX 75041', review_status: 'confirmed' });
      sheet.candidates.forEach(candidate => { candidate.document_id = 1; });
      return { rows: [sheet, document] };
    }
    if (/SELECT section_key, section_value, revision/.test(sql)) return { rows: [...savedSections.values()] };
    if (/INSERT INTO app.custom_appraisal_sections/.test(sql)) {
      const row = { section_key: values[1], section_value: JSON.parse(values[2]), revision: 3 };
      savedSections.set(values[1], row); return { rows: [row] };
    }
    if (/INSERT INTO app.custom_appraisal_section_history/.test(sql)) return { rows: [] };
    throw new Error(`Unexpected SQL ${sql}`);
  } };
  return { queries, savedSections, assignmentDetails, originalSubject, originalEvidence,
    pool: { query: async () => ({ rows: [] }), connect: async () => client } };
}

test('contract service writes association before report persistence and changes no candidate status or value', async () => {
  const document = source(), before = structuredClone(document.candidates), { pool, queries } = servicePool(document);
  const result = await confirmAssignmentDocumentDespiteSubjectMismatch(pool, { documentId: 2, reviewer: actor.reviewer,
    actorUserId: actor.actorUserId, contractSubjectAssociation: expectedRequest(document) });
  assert.equal(result.subject_address_override.acknowledged, true);
  assert.equal(result.subject_address_override.reviewerUserId, actor.actorUserId);
  assert.deepEqual(result.confirmed_candidates, []);
  assert.deepEqual(document.candidates, before);
  assert.equal(queries.some(query => /UPDATE app.assignment_document_field_candidates/.test(query.sql)), false);
  const update = queries.findIndex(query => /UPDATE app.assignment_documents SET extraction_summary/.test(query.sql));
  const persist = queries.findIndex(query => /SELECT assignment_file.id/.test(query.sql));
  assert.ok(update >= 0 && persist > update);
  assert.equal(queries.at(-1).sql, 'COMMIT');
});

test('association transaction saves only listing history, preserving manual contract scalars and unrelated subject receipts', async () => {
  const document = source();
  document.candidates.push({ id: 22, document_id: 2, field_key: 'contract_price', raw_value: '337500',
    confirmed_value: '337500', review_status: 'confirmed' });
  const state = servicePool(document, { applyReport: true });
  const result = await confirmAssignmentDocumentDespiteSubjectMismatch(state.pool, { documentId: 2, reviewer: actor.reviewer,
    actorUserId: actor.actorUserId, contractSubjectAssociation: expectedRequest(document) });
  assert.equal(result.assignment_application.applied, true);
  assert.deepEqual(result.assignment_application.assignment_details, state.assignmentDetails);
  assert.equal(result.assignment_application.revision, 3);
  assert.equal(state.queries.some(query => /UPDATE app.assignment_files|INSERT INTO app.assignment_file_history/.test(query.sql)), false);
  const subject = state.savedSections.get('report.subject_identification').section_value;
  assert.match(subject.urar_subject.listing_history_summary, /under current contract on 08\/25\/2026$/);
  const withoutListing = structuredClone(subject); delete withoutListing.urar_subject.listing_history_summary;
  assert.deepEqual(withoutListing, state.originalSubject);
  const receipts = state.savedSections.get('report.subject_evidence').section_value.fields;
  assert.deepEqual(receipts.borrower_name, state.originalEvidence.fields.borrower_name);
  assert.deepEqual(Object.keys(receipts).sort(), ['borrower_name', 'listing_history_summary']);
});

test('service rejects stale visible snapshot, unreviewed data, foreign workflow and signed reports without mutation', async () => {
  for (const change of [
    (doc, input) => { input.contractSubjectAssociation.documentChecksumSha256 = 'b'.repeat(64); },
    (doc, input) => { input.contractSubjectAssociation.accountId = 'other'; },
    (doc, input) => { input.contractSubjectAssociation.assignmentFileId = 9; },
    (doc, input) => { input.contractSubjectAssociation.reviewedCandidates[1].confirmedValue = '2026-08-26'; },
    (doc, input) => { input.candidateValues = { 21: '2026-08-26' }; },
    doc => { doc.candidates[1].review_status = 'suggested'; }, doc => { doc.processing_status = 'processing'; },
    doc => { doc.tax_protest_file_id = 'tax'; }, doc => { doc.document_type = 'engagement_letter'; },
    (doc, input) => { input.actorUserId = null; },
  ]) {
    const document = source(), input = { documentId: 2, reviewer: actor.reviewer, actorUserId: actor.actorUserId,
      contractSubjectAssociation: expectedRequest(document) };
    change(document, input);
    const { pool, queries } = servicePool(document);
    await assert.rejects(confirmAssignmentDocumentDespiteSubjectMismatch(pool, input), /contract_subject_association/);
    assert.equal(queries.some(query => /UPDATE|INSERT INTO app.assignment_document_candidate_reviews/.test(query.sql) && !/FOR UPDATE/.test(query.sql)), false);
    assert.equal(queries.at(-1).sql, 'ROLLBACK');
  }
  const document = source(), { pool } = servicePool(document, { signed: true });
  await assert.rejects(confirmAssignmentDocumentDespiteSubjectMismatch(pool, { documentId: 2, reviewer: actor.reviewer,
    actorUserId: actor.actorUserId, contractSubjectAssociation: expectedRequest(document) }), /custom_appraisal_workfile_signed/);
});
