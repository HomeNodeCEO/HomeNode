import assert from 'node:assert/strict';
import test from 'node:test';
import { previewSfrepDocuments } from '../src/services/sfrepDocumentTransfer.js';
import { mergeCustomSubjectApplication, projectCustomSubjectDocuments } from '../src/services/customSubjectApplication.js';
import { checkSfrepPreview } from '../../dcad-frontend/src/features/sfrep/sfrepTransport.ts';

// Exercise the public preview producer, not only Report.xml. A valid XML file
// is insufficient if the browser cannot validate its date-evidence envelope.
test('fields-only public preview carries historical No and Other assignment through the actual browser validator', () => {
  const context = { accountId: 'SYNTHETIC-LISTING', address: '100 Example Dr', city: 'Arlington', postalCode: '76010', effectiveDate: '2026-10-18' };
  const sources = [
    ['engagement_letter', { subject_property_address: '100 Example Dr, Arlington, TX 76010',
      borrower_name: 'Example Borrower', assignment_type: 'other', assignment_explanation: 'Foreclosure' }],
    ['mls_sheet', { subject_property_address: '100 Example Dr, Arlington, TX 76010',
      list_date: '2022-03-07', listing_end_date: '06/22/2022', listing_status: 'OffMarket' }],
  ].map(([document_type, values], index) => ({ id: index + 1, account_id: context.accountId, assignment_file_id: 4,
    document_type, title: 'Synthetic source', file_name: `synthetic-${index + 1}.pdf`, file_size_bytes: 100,
    processing_status: 'reviewed', subject_context: context,
    candidates: Object.entries(values).map(([field_key, confirmed_value], offset) => ({
      id: (index + 1) * 100 + offset, document_id: index + 1, field_key, confirmed_value, review_status: 'confirmed',
    })),
  }));
  const applied = mergeCustomSubjectApplication({ projection: projectCustomSubjectDocuments(sources) });
  const documents = [];
  documents.saved_report = { accountId: context.accountId, assignmentFileId: 4, assignmentRevision: 1,
    assignmentDetails: applied.assignmentDetails, subject: { revision: 1, value: applied.subject },
    evidence: { value: applied.evidence }, documents: sources };
  for (const formId of ['FNMA-1004-0911', 'FNMA-2055-0911']) for (const [startDate, endDate] of [
    ['2022-03-07', '06/22/2022'], ['3/7/2022', '6/2/2022'], ['2022-03-07', '6/22/2022'],
  ]) {
    sources[1].candidates.find(candidate => candidate.field_key === 'list_date').confirmed_value = startDate;
    sources[1].candidates.find(candidate => candidate.field_key === 'listing_end_date').confirmed_value = endDate;
    const refreshed = mergeCustomSubjectApplication({ projection: projectCustomSubjectDocuments(sources) });
    documents.saved_report.subject.value = refreshed.subject;
    documents.saved_report.evidence.value = refreshed.evidence;
    const { reportXml, pdfAddenda, imageAddenda, ...body } = previewSfrepDocuments(documents, {
      accountId: context.accountId, assignmentFileId: 4, documentIds: [], includeDocuments: false, includePhotos: false, formId,
    });
    const response = JSON.parse(JSON.stringify({ ok: true, ...body }));
    assert.equal(checkSfrepPreview(response, [], formId), response);
    assert.deepEqual(response.documents, []);
    assert.deepEqual(pdfAddenda, []);
    assert.deepEqual(imageAddenda, []);
    assert.equal(response.fields.find(field => field.fieldId === 'CurrentPriorListingNoCheckBox')?.value, 'true');
    assert.equal(response.fields.find(field => field.fieldId === 'AssignmentTypeOtherDescription')?.value, 'Foreclosure');
    assert.match(reportXml, /Id="CurrentPriorListingNoCheckBox" Data="true"/);
  }
});
