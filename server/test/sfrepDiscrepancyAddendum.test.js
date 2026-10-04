import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContractSubjectAssociation } from '../src/services/contractSubjectAssociation.js';
import { evidenceIdentityFlags, evidenceDiscrepancyStatements, sfrepContractDiscrepancyAddendum,
  sfrepDiscrepancyRtf } from '../src/services/sfrepDiscrepancyAddendum.js';
import { previewSfrepDocuments, packageSfrepDocuments } from '../src/services/sfrepDocumentTransfer.js';
import { checkSfrepPreview } from '../../dcad-frontend/src/features/sfrep/sfrepTransport.ts';

const context = { accountId: 'TEST-PARCEL-001', address: '100 Sample Dr', city: 'Exampleton', postalCode: '75041',
  canonicalIdentity: { accountId: 'TEST-PARCEL-001', address: '100 Sample Dr', city: 'Exampleton', postalCode: '75041',
    county: 'Sample', state: 'TX', assessorParcelNumber: 'TEST-PARCEL-001' } };
function associatedContract() {
  const contract = { id: 9, account_id: context.accountId, assignment_file_id: 7, document_type: 'purchase_contract',
    processing_status: 'reviewed', property_role: 'comparable', checksum_sha256: 'a'.repeat(64), subject_context: context,
    candidates: [
      { id: 91, document_id: 9, field_key: 'contract_printed_subject_addresses', review_status: 'confirmed',
        confirmed_value: 'Main: 100 Sample Dr, Othercity TX 75041. Addendum: 100 Sample Dr, Exampleton TX 75041.' },
      { id: 92, document_id: 9, field_key: 'contract_date', review_status: 'confirmed', confirmed_value: '2026-03-15' },
    ] };
  contract.extraction_summary = { contract_subject_association: buildContractSubjectAssociation(contract,
    { reviewer: 'Synthetic Reviewer', actorUserId: 'appraiser-1', acknowledgedAt: '2026-10-04T12:00:00Z' }) };
  assert.ok(contract.extraction_summary.contract_subject_association);
  return contract;
}

test('reviewed, current association produces one consolidated, opt-in, source-bound addendum', () => {
  const contract = associatedContract();
  assert.equal(sfrepContractDiscrepancyAddendum([contract], false), null);
  const addendum = sfrepContractDiscrepancyAddendum([contract], true);
  assert.equal(addendum.title, 'Evidence Discrepancies');
  assert.deepEqual(addendum.sourceDocumentIds, [9]);
  assert.match(addendum.text, /inconsistent subject-city references/);
  assert.match(sfrepDiscrepancyRtf(addendum.text).toString('ascii'), /\\rtf1/);
  const stale = structuredClone(contract);
  stale.candidates[0].confirmed_value = 'Main: another property, Othercity TX 75041';
  assert.equal(sfrepContractDiscrepancyAddendum([stale], true), null);
  assert.equal(sfrepContractDiscrepancyAddendum([contract, associatedContract()], true), null);
});

test('non-contract reviewed documents produce nonblocking locality flags; rejected suggestions do not', () => {
  const document = { id: 3, document_type: 'mls_sheet', processing_status: 'reviewed', subject_context: context,
    candidates: [{ id: 31, document_id: 3, field_key: 'subject_city', review_status: 'confirmed', confirmed_value: 'Othercity' },
      { id: 32, document_id: 3, field_key: 'subject_city', review_status: 'rejected', raw_value: 'Fort Worth' }] };
  assert.match(evidenceIdentityFlags([document])[0].message, /county-backed Exampleton/);
  assert.deepEqual(evidenceDiscrepancyStatements([document]).statements, []);
});

test('contract and engagement statements share one addendum rather than becoming separate report pages', () => {
  const engagement = { id: 20, document_type: 'engagement_letter', processing_status: 'reviewed',
    checksum_sha256: 'b'.repeat(64), subject_context: context,
    candidates: [{ id: 201, document_id: 20, field_key: 'subject_property_address', review_status: 'confirmed',
      confirmed_value: '100 Sample Dr, Othercity, TX 75041' }],
    extraction_summary: { subject_address_override: { acknowledged: true, document_checksum_sha256: 'b'.repeat(64),
      canonical_subject_address: '100 Sample Dr, Exampleton, 75041',
      document_subject_address: '100 Sample Dr, Othercity, TX 75041', confirmed_candidate_ids: [201] } } };
  const addendum = sfrepContractDiscrepancyAddendum([associatedContract(), engagement], true);
  assert.deepEqual(addendum.sourceDocumentIds, [9, 20]);
  assert.equal(addendum.text.split('\n\n').length, 2);
  assert.equal(addendum.fileName, 'evidence-discrepancies.rtf');
});

test('preview digest and one RTF member are bound to the appraiser addendum choice without PDF attachment', async () => {
  const contract = associatedContract();
  const documents = [];
  documents.saved_report = { accountId: context.accountId, assignmentFileId: 7, assignmentRevision: 1,
    assignmentDetails: {}, subject: { value: {}, revision: 1 }, evidence: { value: {}, revision: 1 }, documents: [contract] };
  const base = { accountId: context.accountId, assignmentFileId: 7, documentIds: [], includeDocuments: false,
    formId: 'FNMA-1004-0911' };
  const without = previewSfrepDocuments(documents, { ...base, includeDiscrepancyAddendum: false });
  const withAddendum = previewSfrepDocuments(documents, { ...base, includeDiscrepancyAddendum: true });
  assert.equal(without.wordProcessingAddendum, null);
  assert.notEqual(without.preview_digest, withAddendum.preview_digest);
  assert.match(withAddendum.reportXml, /WordProcessingAddendum/);
  assert.match(withAddendum.reportXml, /WordProcessingPages" Data="evidence-discrepancies.rtf"/);
  const publicPreview = JSON.parse(JSON.stringify({ ok: true, ...withAddendum }));
  assert.equal(checkSfrepPreview(publicPreview, []), publicPreview);
  const archive = await packageSfrepDocuments(null, null, documents, withAddendum,
    { ...base, includeDiscrepancyAddendum: true, previewDigest: withAddendum.preview_digest },
    { loadContent: () => assert.fail('no PDF should be loaded') });
  assert.match(archive.content.toString('latin1'), /Rtf\/evidence-discrepancies\.rtf/);
  assert.match(archive.content.toString('latin1'), /The purchase contract contains inconsistent subject-city references/);
});
