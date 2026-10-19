import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSfrepReportExport } from '../src/services/sfrepReportExport.js';
import { projectCustomSubjectDocuments, mergeCustomSubjectApplication } from '../src/services/customSubjectApplication.js';
import { savedSfrepSubjectFields } from '../src/services/sfrepSavedReport.js';

const subjectContext = { effectiveDate: '2026-10-18', effectiveDateSource: 'assignment_effective_date' };
function mls(listDate = '2022-03-01', endDate = '2022-05-01', status = 'OffMarket') {
  return { id: 1, account_id: 'QA123', assignment_file_id: 7001, document_type: 'mls_sheet',
    processing_status: 'reviewed', property_role: 'subject',
    subject_context: { accountId: 'QA123', address: '100 Example Dr', city: 'Arlington', postalCode: '76010', effectiveDate: '2026-10-18' },
    candidates: Object.entries({ subject_property_address: '100 Example Dr, Arlington, TX 76010',
      list_date: listDate, listing_end_date: endDate, listing_status: status }).filter(([, value]) => value !== null)
      .map(([field_key, value], i) => ({ id: 100 + i, document_id: 1, field_key,
        raw_value: value, normalized_value: value, confirmed_value: value, review_status: 'confirmed' })) };
}
const listingFields = result => result.fields.filter(field => /^CurrentPriorListing(?:Yes|No)CheckBox$/.test(field.fieldId));

test('an ended historical subject MLS automatically selects No with source-limited date proof on both forms', () => {
  for (const formId of ['FNMA-1004-0911', 'FNMA-2055-0911']) {
    const exported = buildSfrepReportExport({ documents: [mls()], formId, subjectContext });
    const fields = listingFields(exported);
    assert.equal(fields.length, 1);
    assert.equal(fields[0].fieldId, 'CurrentPriorListingNoCheckBox');
    assert.equal(fields[0].provenance.rule, 'user_requested_ended_mls_outside_12_months_v1');
    assert.equal(fields[0].provenance.windowStart, '2025-10-18');
    assert.deepEqual(fields[0].provenance.sourceEvidence.map(item => item.sourceField), ['list_date', 'listing_status', 'listing_end_date']);
    assert.ok(exported.warnings.some(warning => /No is based on the uploaded MLS/.test(warning)));
    assert.match(exported.reportXml, /Id="CurrentPriorListingNoCheckBox" Data="true"/);
  }
});

test('a listing interval touching the preceding twelve-month window is Yes, not No', () => {
  for (const endedOn of ['2025-10-18', '2026-01-15', '2026-10-18']) {
    const fields = listingFields(buildSfrepReportExport({ documents: [mls('2022-03-01', endedOn, 'Closed')], subjectContext }));
    assert.equal(fields.length, 1);
    assert.equal(fields[0].fieldId, 'CurrentPriorListingYesCheckBox');
  }
  assert.equal(listingFields(buildSfrepReportExport({ documents: [mls('2022-03-01', '2025-10-17', 'Expired')], subjectContext }))[0].fieldId,
    'CurrentPriorListingNoCheckBox');
});

test('old dates cannot become No without a reviewed, coherent end date and terminal subject status', () => {
  const sources = [mls('2022-03-01', null), mls('2022-03-01', '2022-05-01', 'Active'),
    mls('2022-03-01', '2022-02-01'), mls('2022-03-01', '02/30/2022'),
    mls('2022-03-01', '2026-10-19'), mls('2026-10-19', '2026-10-20')];
  for (const source of sources) assert.deepEqual(listingFields(buildSfrepReportExport({ documents: [source], subjectContext })), []);
  for (const key of ['listing_end_date', 'listing_status']) {
    const source = mls(); source.candidates.find(candidate => candidate.field_key === key).review_status = 'suggested';
    assert.deepEqual(listingFields(buildSfrepReportExport({ documents: [source], subjectContext })), []);
  }
  for (const state of [{ property_role: 'comparable' }, { processing_status: 'processing' }]) {
    assert.deepEqual(listingFields(buildSfrepReportExport({ documents: [{ ...mls(), ...state }], subjectContext })), []);
  }
  const conflicting = mls();
  conflicting.candidates.push({ ...conflicting.candidates.find(candidate => candidate.field_key === 'listing_end_date'), id: 199,
    confirmed_value: '2026-01-01' });
  assert.deepEqual(listingFields(buildSfrepReportExport({ documents: [conflicting], subjectContext })), []);
  assert.deepEqual(listingFields(buildSfrepReportExport({ documents: [mls()] })), []);
});

test('automatic historical No persists, invalidates changed date proof, and preserves an appraiser override', () => {
  const documents = [mls()];
  const applied = mergeCustomSubjectApplication({ projection: projectCustomSubjectDocuments(documents) });
  assert.equal(applied.subject.urar_subject.offered_for_sale_prior_12_months, false);
  const saved = { accountId: 'QA123', assignmentFileId: 7001, assignmentRevision: 1,
    assignmentDetails: applied.assignmentDetails, subject: { value: applied.subject, revision: 1 },
    evidence: { value: applied.evidence }, documents };
  const input = { accountId: 'QA123', assignmentFileId: 7001 };
  for (const formId of ['FNMA-1004-0911', 'FNMA-2055-0911']) {
    const exported = buildSfrepReportExport({ formId, savedReportFields: savedSfrepSubjectFields(saved, input).fields });
    assert.equal(listingFields(exported)[0].fieldId, 'CurrentPriorListingNoCheckBox');
    assert.ok(exported.warnings.some(warning => /No is based on the uploaded MLS/.test(warning)));
  }
  const end = documents[0].candidates.find(candidate => candidate.field_key === 'listing_end_date');
  end.confirmed_value = '2026-01-01';
  assert.equal(savedSfrepSubjectFields(saved, input).fields.some(field => field.sourceField === 'offered_for_sale_prior_12_months'), false);
  const manual = mergeCustomSubjectApplication({ subject: { urar_subject: { offered_for_sale_prior_12_months: true } },
    projection: projectCustomSubjectDocuments([mls()]), reviewedDocumentId: 1 });
  assert.equal(manual.subject.urar_subject.offered_for_sale_prior_12_months, true);
});

test('historical No considers every reviewed subject MLS, not just one complete older listing', () => {
  const second = mls(); second.id = 2;
  second.candidates = second.candidates.map(candidate => ({ ...candidate, id: candidate.id + 100, document_id: 2 }));
  const complete = buildSfrepReportExport({ documents: [mls(), second], subjectContext });
  assert.equal(listingFields(complete)[0].fieldId, 'CurrentPriorListingNoCheckBox');
  assert.deepEqual([...new Set(listingFields(complete)[0].provenance.sourceEvidence.map(entry => entry.documentId))], [1, 2]);
  for (const change of ['active_without_end', 'missing_start', 'conflicting_status']) {
    const copy = structuredClone(second);
    if (change === 'active_without_end') {
      copy.candidates = copy.candidates.filter(candidate => candidate.field_key !== 'listing_end_date');
      copy.candidates.find(candidate => candidate.field_key === 'listing_status').confirmed_value = 'Active';
    }
    if (change === 'missing_start') copy.candidates = copy.candidates.filter(candidate => candidate.field_key !== 'list_date');
    if (change === 'conflicting_status') copy.candidates.push({ ...copy.candidates.find(candidate => candidate.field_key === 'listing_status'),
      id: 299, confirmed_value: 'Active' });
    assert.deepEqual(listingFields(buildSfrepReportExport({ documents: [mls(), copy], subjectContext })), [], change);
  }
  const documents = [mls(), structuredClone(second)];
  const applied = mergeCustomSubjectApplication({ projection: projectCustomSubjectDocuments(documents) });
  const saved = { accountId: 'QA123', assignmentFileId: 7001, assignmentRevision: 1,
    assignmentDetails: applied.assignmentDetails, subject: { value: applied.subject, revision: 1 },
    evidence: { value: applied.evidence }, documents };
  documents[1].candidates.find(candidate => candidate.field_key === 'listing_status').confirmed_value = 'Active';
  assert.equal(savedSfrepSubjectFields(saved, { accountId: 'QA123', assignmentFileId: 7001 }).fields
    .some(field => field.sourceField === 'offered_for_sale_prior_12_months'), false, 'second-source change invalidates the saved No receipt');
});
