import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSfrepPreview, createSfrepTransport, SFREP_FORM_ID, SFREP_2055_FORM_ID, sfrepDownloadFilename, sfrepNoticeText, sfrepProvenanceText, sfrepSubjectChecklist } from '../src/features/sfrep/sfrepTransport.ts';
import { projectCustomSubjectDocuments, mergeCustomSubjectApplication } from '../../server/src/services/customSubjectApplication.js';
import { buildSfrepReportExport } from '../../server/src/services/sfrepReportExport.js';
import { savedSfrepSubjectFields } from '../../server/src/services/sfrepSavedReport.js';
import { sfrepDocumentPropertyRole, sfrepSubjectContext } from '../../server/src/services/sfrepSubjectContext.js';

// Use the real pure server field producers, without requiring backend-only
// PDF dependencies in a frontend-only install. The server integration suite
// separately exercises the full previewSfrepDocuments public response.
function serverPreview({ saved = true, hoa = 'true', county = false, lenderPreset = false, fallbackIdentity = false, partyRoles = false } = {}) {
  const subject = { accountId: 'SYNTHETIC-SFREP', address: '100 Example Dr', city: 'Garland', postalCode: '75041',
    effectiveDate: '2026-08-31', censusGeography: { tractCode: '018206', status: 'matched', geoid: '48113018206',
      vintage: 'Census2020_Current', updatedAt: '2026-10-03T00:00:00Z' } };
  if (county) subject.canonicalIdentity = { accountId: subject.accountId, address: '100 EXAMPLE DR', city: 'GARLAND',
    state: 'TX', postalCode: '75041-1234', county: 'DALLAS COUNTY', assessorParcelNumber: subject.accountId };
  const history = JSON.stringify({ schema_version: 1, listing_id: '77700001', list_date: '2026-05-29',
    coverage: 'complete', price_changes: [] });
  const data = [
    ['other', county ? {} : { subject_property_address: '100 EXAMPLE DR, GARLAND, TX 75041-1234',
      owner_name: 'EXAMPLE OWNER LLC\nSECOND OWNER', neighborhood_name: 'EXAMPLE PARK 4',
      legal_description: 'EXAMPLE PARK\nBLK 1 LOT 2' }],
    ['engagement_letter', { subject_property_address: '100 Example Dr, Garland, TX 75041',
      borrower_name: 'EXAMPLE BORROWER' }],
    ['mls_sheet', { subject_property_address: '100 Example Dr, Garland, TX 75041', mls_number: '77700001',
      list_date: '2026-05-29', original_list_price: '345000.00', days_on_market: '77', pud: hoa,
      listing_price_history: history }],
    ['purchase_contract', { subject_property_address: '100 Example Dr, Garland, TX 75041', contract_date: '2026-08-25' }],
  ];
  if (partyRoles) data.splice(0, data.length,
    ['engagement_letter', { subject_property_address: '100 Example Dr, Garland, TX 75041', borrower_name: 'ALEX SAMPLE AND TAYLOR EXAMPLE' }],
    ['purchase_contract', { subject_property_address: '100 Example Dr, Garland, TX 75041', buyer_name: 'CONTRACT BUYER', seller_name: 'CONTRACT SELLER' }],
    ['other', { subject_property_address: '100 Example Dr, Garland, TX 75041', record_owner_name: 'RECORD OWNER LLC' }]);
  if (lenderPreset) data[partyRoles ? 0 : 1][1].lender_client_name = 'United Wholesale Mortgage';
  const documents = data.map(([document_type, values], index) => ({ id: index + 1, account_id: subject.accountId,
    assignment_file_id: 4, document_type, processing_status: 'reviewed', upload_date: '2026-10-02',
    title: document_type === 'other' ? 'CAD record' : 'Synthetic source',
    file_name: `synthetic-${index + 1}.pdf`, file_size_bytes: 100, subject_context: subject,
    ...(document_type === 'other' ? { extraction_summary: { urar_subject_evidence: { source_kind: 'cad' } } } : {}),
    candidates: Object.entries(values).map(([field_key, confirmed_value], offset) => ({ id: (index + 1) * 100 + offset,
      document_id: index + 1, field_key, confirmed_value, review_status: 'confirmed',
      ...(field_key === 'pud' ? { normalized_value: hoa, raw_value: hoa === 'true' ? 'Mandatory' : 'None',
        extraction_method: 'urar_subject_mls_sheet_hoa_workflow_proxy' } : {}) })) }));
  if (saved) {
    const applied = mergeCustomSubjectApplication({ projection: projectCustomSubjectDocuments(documents) });
    documents[0].saved_report = { accountId: subject.accountId, assignmentFileId: 4, assignmentRevision: 2,
      assignmentDetails: { ...applied.assignmentDetails, ...(!lenderPreset ? { lender_client_address: '20 EXAMPLE AVE, AUSTIN TX 78701-1234' } : {}) },
      subject: { revision: fallbackIdentity ? 0 : 1, value: fallbackIdentity ? {} : applied.subject },
      evidence: { revision: 1, value: fallbackIdentity ? {} : applied.evidence },
      documents: structuredClone(documents) };
  }
  const input = { accountId: subject.accountId, assignmentFileId: 4 };
  const canonical = documents[0].saved_report;
  const { reportXml: _xml, pdfAddenda: _pdfs, ...result } = buildSfrepReportExport({
    documents: documents.map(document => ({ ...document, property_role: sfrepDocumentPropertyRole(document) })), subjectOnly: true,
    subjectContext: sfrepSubjectContext(documents), ...(canonical ? { savedReportFields: savedSfrepSubjectFields(canonical, input).fields } : {}) });
  return JSON.parse(JSON.stringify({ ok: true, ...result, preview_digest: 'a'.repeat(64), filename: 'HomeNode-SFREP-file-4.rpti',
    documents: documents.map(({ id, title, file_name, file_size_bytes, processing_status }) => ({ id, title, file_name, file_size_bytes, processing_status })),
    ...(canonical ? { savedReport: { assignmentFileId: 4, assignmentRevision: 2, subjectRevision: fallbackIdentity ? 0 : 1,
      sourceDocumentIds: documents.map(document => document.id) } } : {}) }));
}

test('canonical county identity and user lender preset cross the strict producer boundary with honest labels', () => {
  for (const fallbackIdentity of [false, true]) {
    const preview = serverPreview({ county: true, lenderPreset: true, fallbackIdentity });
    assert.equal(checkSfrepPreview(preview, [1, 2, 3, 4]), preview);
    const identity = preview.fields.filter(field => field.provenance.rule === 'canonical_county_subject_identity_v1');
    assert.equal(identity.length, 6);
    for (const field of identity) {
      assert.equal(field.provenance.kind, fallbackIdentity ? 'account_reference' : 'saved_report');
      assert.match(sfrepProvenanceText(field), /county-backed subject identity.*not PDF evidence/);
    }
    const lender = preview.fields.find(field => field.fieldId === 'LenderClientCompanyUnparsedAddress');
    if (!fallbackIdentity) {
      assert.equal(lender.provenance.rule, 'user_requested_lender_address_v1');
      assert.match(sfrepProvenanceText(lender), /user-requested lender address preset.*not PDF evidence/);
      assert.equal(sfrepSubjectChecklist(preview).find(item => item.key === 'lender-address').statusLabel, 'Included — user default');
    }
    assert.equal(sfrepSubjectChecklist(preview).find(item => item.key === 'street').statusLabel, 'Included — county record');
  }
});

test('canonical county receipts reject altered destinations, values, sources and saved bindings', () => {
  for (const fallbackIdentity of [false, true]) {
    const preview = serverPreview({ county: true, fallbackIdentity });
    for (const change of [
      field => { field.value = '999 Forged Dr'; }, field => { field.fieldId = 'BorrowerName'; },
      field => { field.provenance.rule = 'unknown_county_rule'; },
      field => { field.provenance.sourceEvidence[0].sourceTable = 'core.untrusted'; },
      field => { field.provenance.sourceEvidence[0].sourceField = 'city'; },
      field => { field.provenance.sourceEvidence[0].value += '\u0000'; },
      field => { field.provenance.sourceEvidence[0].unexpected = true; },
      field => { field.provenance.sourceEvidence.push(field.provenance.sourceEvidence[0]); },
      field => { field.provenance.sourceDocumentId = 1; },
      field => { field.provenance.assignmentFileId = 9; }, field => { field.provenance.revision = 99; },
      field => { field.provenance.sourceValue = field.value; },
      field => { field.provenance.kind = 'reviewed_document'; },
    ]) {
      const invalid = structuredClone(preview);
      change(invalid.fields.find(field => field.fieldId === 'StreetAddress'));
      assert.throws(() => checkSfrepPreview(invalid, [1, 2, 3, 4]), /invalid|does not match/, String(change));
    }
    const apn = structuredClone(preview);
    apn.fields.find(field => field.fieldId === 'AssessorsParcelNumber').provenance.sourceEvidence[0].accountId = 'OTHER';
    assert.throws(() => checkSfrepPreview(apn, [1, 2, 3, 4]), /invalid/);
  }
});

test('lender preset receipts are exact, source-bound and cannot authorize other user defaults', () => {
  const preview = serverPreview({ lenderPreset: true });
  for (const change of [
    field => { field.value = 'Other lender address'; }, field => { field.fieldId = 'StreetAddress'; },
    field => { field.provenance.rule = 'user_requested_any_lender'; },
    field => { field.provenance.sourceValue = 'Other Bank'; },
    field => { field.provenance.sourceEvidence[0].value = 'Other Bank'; },
    field => { field.provenance.sourceEvidence[0].documentId = 1; },
    field => { field.provenance.sourceEvidence[0].candidateId = 999; },
    field => { field.provenance.sourceEvidence[0].sourceField = 'borrower_name'; },
    field => { field.provenance.sourceEvidence[0].extra = true; },
    field => { field.provenance.sourceDocumentId = field.provenance.sourceEvidence[0].documentId = 99; },
    field => { field.provenance.sectionKey = 'report.subject_identification'; field.provenance.revision = 1; },
  ]) {
    const invalid = structuredClone(preview);
    change(invalid.fields.find(field => field.fieldId === 'LenderClientCompanyUnparsedAddress'));
    assert.throws(() => checkSfrepPreview(invalid, [1, 2, 3, 4]), /invalid|does not match/, String(change));
  }
});

test('transport binds canonical county evidence to the selected account before returning a preview', async () => {
  const preview = serverPreview({ county: true });
  const transport = createSfrepTransport({ urlFor: path => path,
    request: async () => new Response(JSON.stringify(preview), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(transport.preview({ accountId: 'DIFFERENT-ACCOUNT', assignmentFileId: 4, documentIds: [1, 2, 3, 4], includeDocuments: false },
    { signal: new AbortController().signal, editorKey: 'key' }), /selected county account/);
});

test('actual canonical server preview accepts current presentation, Census, listing and HOA contracts', () => {
  for (const hoa of ['true', 'false']) {
    const value = serverPreview({ hoa });
    assert.equal(value.fields.find(field => field.fieldId === 'CensusTract')?.value, '182.06');
    assert.equal(value.fields.find(field => field.fieldId === 'CurrentPriorListingDataSources')?.provenance.rule,
      'reviewed_subject_listing_history_template_v1');
    assert.equal(checkSfrepPreview(value, [1, 2, 3, 4]), value);
  }
});

test('actual reviewed-document server preview accepts transformed composite addresses and HOA proof', () => {
  const value = serverPreview({ saved: false });
  assert.equal(checkSfrepPreview(value, [1, 2, 3, 4]), value);
});

test('new presentation rules are recomputed and remain bound to exact source and destination fields', () => {
  for (const saved of [true, false]) {
    const source = serverPreview({ saved });
    for (const field of source.fields.filter(field => ['subject_title_case', 'zip5_display',
      'title_case_subdivision_without_numeric_phase', 'title_case_single_line_owner_name'].includes(field.formattingRule))) {
      assert.ok(sfrepProvenanceText(field).includes(JSON.stringify(field.sourceValue)));
      for (const change of [
        field => { field.value += ' forged'; }, field => { field.formattingRule = 'future_unknown_rule'; },
        field => { field.sourceField = field.provenance.sourceField = 'contract_price'; },
        field => { field.fieldId = 'UnrelatedDestination'; }, field => { field.type = 'CheckBoxField'; },
        field => { delete field.sourceValue; }, field => { delete field.formattingRule; },
      ]) {
        const invalid = structuredClone(source);
        change(invalid.fields.find(item => item.fieldId === field.fieldId));
        assert.throws(() => checkSfrepPreview(invalid, [1, 2, 3, 4]), /invalid/, `${field.fieldId}: ${change}`);
      }
    }
  }
});

test('canonical Census proof rejects invented rules, malformed receipts, wrong tract and non-account origins', () => {
  for (const change of [
    field => { field.value = '999.99'; }, field => { field.fieldId = 'County'; },
    field => { field.provenance.rule = 'future_census_rule'; }, field => { field.provenance.origin = 'reviewed_document'; },
    field => { field.provenance.sectionKey = 'report.assignment_details'; },
    field => { field.provenance.sourceDocumentId = 1; }, field => { field.provenance.sourceValue = '018206'; },
    field => { field.provenance.extra = true; }, field => { field.provenance.sourceEvidence = []; },
    field => { field.provenance.sourceEvidence.push(structuredClone(field.provenance.sourceEvidence[0])); },
    ...[
      ['sourceTable', 'other.table'], ['tractCode', '000000'], ['geoid', '48113000000'], ['status', 'review_required'],
      ['accountId', ''], ['vintage', ''], ['updatedAt', '2026-02-30T00:00:00Z'], ['updatedAt', 'not-a-time'], ['extra', true],
    ].map(([key, value]) => field => { field.provenance.sourceEvidence[0][key] = value; }),
  ]) {
    const invalid = serverPreview();
    change(invalid.fields.find(field => field.fieldId === 'CensusTract'));
    assert.throws(() => checkSfrepPreview(invalid, [1, 2, 3, 4]), /invalid|does not match/);
  }
});

test('listing-history provenance is rule-specific, date-bound and scoped to saved source documents', () => {
  for (const change of [
    field => { field.provenance.rule = 'subject_mls_list_date_within_preceding_12_calendar_months'; },
    field => { field.provenance.rule = 'unknown'; }, field => { field.provenance.origin = 'reviewed_document'; },
    field => { field.provenance.sectionKey = 'report.assignment_details'; }, field => { field.value = 'x'.repeat(4001); },
    field => { field.provenance.sourceEvidence = []; }, field => { field.provenance.sourceEvidence.pop(); },
    field => { field.provenance.sourceEvidence.push(structuredClone(field.provenance.sourceEvidence[0])); },
    field => { field.provenance.sourceEvidence[0].documentId = 99; },
    field => { field.provenance.sourceEvidence[0].candidateId = 0; },
    field => { field.provenance.sourceEvidence[0].sourceField = 'unreviewed_note'; },
    field => { field.provenance.sourceEvidence[0].value = { unsafe: true }; },
    field => { field.provenance.sourceEvidence[0].extra = true; },
    field => { field.provenance.sourceCandidateId = 999999; }, field => { field.provenance.windowStart = '2025-08-31'; },
    field => { field.provenance.effectiveDate = '2026-08-30'; }, field => { field.provenance.effectiveDate = '2026-02-30'; },
    field => { field.provenance.effectiveDateSource = 'inspection_date'; },
    field => { field.provenance.effectiveDateSourceDocumentId = 1; }, field => { field.provenance.extra = true; },
  ]) {
    const invalid = serverPreview();
    change(invalid.fields.find(field => field.fieldId === 'CurrentPriorListingDataSources'));
    assert.throws(() => checkSfrepPreview(invalid, [1, 2, 3, 4]), /invalid|does not match/);
  }
  // Evidence can belong to saved sources that were not selected as PDF addenda.
  const subset = serverPreview();
  subset.documents = subset.documents.filter(document => document.id === 1);
  subset.omitted = subset.omitted.filter(item => item.documentId === 1);
  subset.conflicts = subset.conflicts.filter(item => item.documentIds.every(id => id === 1));
  assert.equal(checkSfrepPreview(subset, [1]), subset);
});

test('HOA assumptions remain narrowly identified and cannot masquerade as verified PUD proof', () => {
  for (const saved of [true, false]) {
    for (const change of [
      value => { value.assumptions = value.assumptions.filter(item => item.rule !== 'user_requested_hoa_workflow_proxy_v1'); },
      value => { value.assumptions.find(item => item.fieldId === 'PropertyTypePUDCheckBox').value = 'false'; },
      ...[true, false, 1, { value: 'true' }].map(assumed => value => { value.assumptions.find(item => item.fieldId === 'PropertyTypePUDCheckBox').value = assumed; }),
      value => { value.assumptions.find(item => item.fieldId === 'PropertyTypePUDCheckBox').rule = 'unknown'; },
      value => { value.assumptions.find(item => item.fieldId === 'PropertyTypePUDCheckBox').extra = true; },
      value => { value.fields.find(item => item.fieldId === 'PropertyTypePUDCheckBox').provenance.sourceValue = 'None'; },
      ...['Not specified', '$0 yearly', '$-25 monthly', '$100 weekly', '1,23 per month', '$1000000000000 yearly']
        .map(raw => value => { value.fields.find(item => item.fieldId === 'PropertyTypePUDCheckBox').provenance.sourceValue = raw; }),
      value => { value.fields.find(item => item.fieldId === 'PropertyTypePUDCheckBox').provenance.rule = 'unknown'; },
      value => { value.fields.find(item => item.fieldId === 'PropertyTypePUDCheckBox').provenance.extra = true; },
    ]) {
      const invalid = serverPreview({ saved }); change(invalid);
      assert.throws(() => checkSfrepPreview(invalid, [1, 2, 3, 4]), /invalid/);
    }
  }
  const value = serverPreview({ hoa: 'false' });
  const rows = sfrepSubjectChecklist(checkSfrepPreview(value, [1, 2, 3, 4]));
  assert.deepEqual(rows.find(item => item.key === 'census').values, ['182.06']);
  assert.match(rows.find(item => item.key === 'census').notes.join(' '), /not PDF evidence/);
  assert.equal(rows.find(item => item.key === 'listing-history').statusLabel, 'Derived — review');
  assert.equal(rows.find(item => item.key === 'pud').statusLabel, 'User default — confirm');
  assert.deepEqual(rows.find(item => item.key === 'pud').values, []);
  for (const rule of ['user_requested_fee_simple_default', 'user_requested_hoa_workflow_proxy_v1']) {
    const duplicate = serverPreview();
    duplicate.assumptions.push(structuredClone(duplicate.assumptions.find(item => item.rule === rule)));
    assert.throws(() => checkSfrepPreview(duplicate, [1, 2, 3, 4]), /invalid/);
  }
});

const selection = { accountId: 'R-1/#', assignmentFileId: 12, documentIds: [21], includeDocuments: true };
const digest = 'a'.repeat(64);
const noDate = () => ({ effectiveDate: null, source: null, sourceDocumentId: null, windowStart: null, windowEnd: null, calendarMonths: 12, isPlaceholder: false });
const field = (sourceField, fieldId, value, rest = {}) => ({ sourceField, fieldId, value, documentId: 21, candidateId: null, type: 'TextField',
  provenance: { kind: 'reviewed_document', sourceField, documentId: 21, candidateId: null, documentType: 'purchase_contract' }, ...rest });
const preview = () => ({ ok: true, preview_digest: digest, formId: SFREP_FORM_ID, filename: 'HomeNode-SFREP-file-12.rpti',
  fields: [field('contract_price', 'SalePriceAmount', '200000')],
  effectiveDateContext: noDate(), assumptions: [], knownMissing: [],
  conflicts: [], omitted: [], warnings: [], documents: [{ id: 21, title: 'Contract', file_name: 'contract.pdf', file_size_bytes: 100, processing_status: 'reviewed' }] });
const feeSimple = () => ({ sourceField: 'property_rights', fieldId: 'PropertyRightsAppraisedFeeSimpleCheckBox', value: 'true',
  documentId: null, candidateId: null, type: 'CheckBoxField', provenance: { kind: 'user_default', sourceField: 'property_rights',
    documentId: null, candidateId: null, rule: 'user_requested_fee_simple_default' } });
const assumption = () => ({ fieldId: 'PropertyRightsAppraisedFeeSimpleCheckBox', value: 'true', rule: 'user_requested_fee_simple_default', reason: 'User-requested fee simple default; confirm property rights.' });
const listingPreview = () => ({ ...preview(),
  effectiveDateContext: { effectiveDate: '2026-10-01', source: 'document_upload_date_placeholder', sourceDocumentId: 21,
    windowStart: '2025-10-01', windowEnd: '2026-10-01', calendarMonths: 12, isPlaceholder: true },
  fields: [{ sourceField: 'list_date', fieldId: 'CurrentPriorListingYesCheckBox', value: 'true', type: 'CheckBoxField', documentId: 21, candidateId: 41,
    provenance: { kind: 'derived_reviewed_document', sourceField: 'list_date', documentId: 21, candidateId: 41, documentType: 'mls_sheet',
      rule: 'subject_mls_list_date_within_preceding_12_calendar_months', sourceValue: '2026-09-15', effectiveDate: '2026-10-01',
      effectiveDateSource: 'document_upload_date_placeholder', effectiveDateSourceDocumentId: 21, windowStart: '2025-10-01', windowEnd: '2026-10-01' } }],
  knownMissing: [{ fieldId: 'CurrentPriorListingDataSources', reason: 'Complete the prior-listing data-source narrative in SFREP.' }] });
const formatted = (sourceField, fieldId, sourceValue, value, formattingRule = 'uad_whole_dollars_half_up') => field(sourceField, fieldId, value, {
  sourceValue, formattingRule,
  provenance: { kind: 'reviewed_document', sourceField, documentId: 21, candidateId: null, documentType: 'other' },
});
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const savedPreview = () => ({ ...preview(), savedReport: { assignmentFileId: 12, assignmentRevision: 3, subjectRevision: 2, sourceDocumentIds: [21, 22] },
  fields: [{ sourceField: 'borrower_name', fieldId: 'BorrowerName', value: 'Saved Borrower', type: 'TextField', documentId: null, candidateId: null,
    provenance: { kind: 'saved_report', sourceField: 'borrower_name', documentId: null, candidateId: null,
      assignmentFileId: 12, sectionKey: 'report.subject_identification', revision: 2, origin: 'reviewed_document', sourceDocumentId: 22, sourceCandidateId: 88 } }] });

test('saved HomeNode values validate with scoped revisions and source evidence independent of PDF addenda selection', () => {
  const result = checkSfrepPreview(savedPreview(), [21]);
  assert.match(sfrepProvenanceText(result.fields[0]), /Applied from reviewed document 22.*Subject revision 2/);
  const manual = savedPreview();
  manual.fields[0].provenance.origin = 'appraiser_edit';
  delete manual.fields[0].provenance.sourceDocumentId;
  delete manual.fields[0].provenance.sourceCandidateId;
  assert.match(sfrepProvenanceText(checkSfrepPreview(manual).fields[0]), /Saved appraiser entry\/correction/);
});

test('saved report provenance rejects mixed revisions, scopes and invented document proof', () => {
  for (const change of [
    value => { delete value.savedReport; },
    value => { value.fields[0].provenance.assignmentFileId = 13; },
    value => { value.fields[0].provenance.revision = 3; },
    value => { value.fields[0].provenance.sourceDocumentId = 99; },
    value => { value.fields[0].provenance.origin = 'appraiser_edit'; },
    value => { value.fields[0].provenance.sectionKey = 'other_file'; },
    value => { value.savedReport.subjectRevision = -1; },
    value => { value.savedReport.sourceDocumentIds = [21, 21]; },
    value => { value.fields[0].provenance.sql = 'untrusted'; },
  ]) {
    const value = savedPreview(); change(value);
    assert.throws(() => checkSfrepPreview(value, [21]), /invalid|does not match/);
  }
});

test('saved value formatting is recomputed rather than trusted', () => {
  const value = savedPreview();
  Object.assign(value.fields[0], { sourceField: 'tax_amount', fieldId: 'RealEstateTaxAmount', sourceValue: '1234.50', value: '1235', formattingRule: 'uad_whole_dollars_half_up' });
  value.fields[0].provenance.sourceField = 'tax_amount';
  assert.match(sfrepProvenanceText(checkSfrepPreview(value).fields[0]), /Original saved value.*1234\.50/);
  value.fields[0].value = '1234';
  assert.throws(() => checkSfrepPreview(value), /invalid/);
});

test('transport rejects an otherwise coherent saved preview from another assignment', async () => {
  const value = savedPreview();
  value.savedReport.assignmentFileId = value.fields[0].provenance.assignmentFileId = 13;
  const h = harness(async () => json(value));
  await assert.rejects(h.api.preview(selection, h.io), /selected HomeNode file/);
});
function harness(request = async () => json(preview())) {
  const calls = [], controller = new AbortController();
  const api = createSfrepTransport({ urlFor: path => `https://example.invalid${path}`, request: (url, init) => { calls.push({ url, init }); return request(url, init); } });
  return { calls, api, controller, io: { signal: controller.signal, editorKey: 'test-editor' } };
}

test('preview and export use scoped authenticated POSTs with exact selections and a reviewed digest', async () => {
  const h = harness(async (_url, init) => init.headers.accept === 'application/json' ? json(preview())
    : new Response('rpti-fixture', { headers: { 'content-type': 'application/octet-stream' } }));
  const result = await h.api.preview(selection, h.io);
  assert.equal(result.fields[0].candidateId, null);
  assert.equal(h.calls[0].url, 'https://example.invalid/api/accounts/R-1%2F%23/sfrep/preview');
  assert.deepEqual(JSON.parse(h.calls[0].init.body), { assignment_file_id: 12, document_ids: [21], include_documents: true, form_id: SFREP_FORM_ID });
  assert.equal(h.calls[0].init.headers['x-homenode-editor-key'], 'test-editor');
  assert.equal(h.calls[0].init.signal, h.controller.signal); assert.equal(h.calls[0].init.cache, 'no-store');
  assert.equal(await (await h.api.export(selection, result.preview_digest, h.io)).text(), 'rpti-fixture');
  assert.equal(JSON.parse(h.calls[1].init.body).preview_digest, digest);
  assert.match(h.calls[1].url, /\/sfrep\/export$/); assert.equal(h.calls.length, 2);
});

test('2055 transport sends the selected form and rejects a 1004 preview response', async () => {
  const choice = { ...selection, formId: SFREP_2055_FORM_ID };
  const wrong = harness(async () => json(preview()));
  await assert.rejects(wrong.api.preview(choice, wrong.io), /invalid/);
  assert.equal(JSON.parse(wrong.calls[0].init.body).form_id, SFREP_2055_FORM_ID);
  const valid = harness(async (_url, init) => init.headers.accept === 'application/json'
    ? json({ ...preview(), formId: SFREP_2055_FORM_ID })
    : new Response('2055-rpti', { headers: { 'content-type': 'application/octet-stream' } }));
  const result = await valid.api.preview(choice, valid.io);
  assert.equal(result.formId, SFREP_2055_FORM_ID);
  assert.equal(await (await valid.api.export(choice, result.preview_digest, valid.io)).text(), '2055-rpti');
  assert.equal(JSON.parse(valid.calls[1].init.body).form_id, SFREP_2055_FORM_ID);
});

test('fields-only preview accepts workfile evidence without selecting its source PDFs', async () => {
  const value = serverPreview(); value.documents = [];
  const choice = { accountId: 'SYNTHETIC-SFREP', assignmentFileId: 4, documentIds: [], includeDocuments: false };
  const h = harness(async () => json(value));
  const result = await h.api.preview(choice, h.io);
  assert.equal(result.fields.some(field => field.fieldId === 'StreetAddress'), true);
  assert.deepEqual(JSON.parse(h.calls[0].init.body).document_ids, []);
});

test('invalid selection, absent digest and already-aborted calls do not issue a request', async () => {
  const h = harness();
  for (const documentIds of [[21, 21], [NaN], Array.from({ length: 11 }, (_, i) => i + 1)]) {
    await assert.rejects(h.api.preview({ ...selection, documentIds }, h.io));
  }
  await assert.rejects(h.api.export(selection, '', h.io));
  h.controller.abort(); await assert.rejects(h.api.preview(selection, h.io), { name: 'AbortError' });
  assert.equal(h.calls.length, 0);
});

test('HTTP failures including busy/stale refusals never become a successful preview or download and never retry', async () => {
  for (const [status, code, expected] of [[401, 'authentication_required', /authentication_required/],
    [409, 'sfrep_preview_changed', /changed after your preview/], [429, 'sfrep_export_busy', /Another SFREP export/], [500, 'failed', /failed/]]) {
    const h = harness(async () => json({ error: code }, status));
    await assert.rejects(h.api.preview(selection, h.io), expected);
    await assert.rejects(h.api.export(selection, digest, h.io), expected);
    assert.equal(h.calls.length, 2);
  }
});

test('malformed schemas, unexpected form versions, HTML responses and empty exports fail closed', async () => {
  for (const change of [{ ok: false }, { formId: 'UAD-3.6' }, { preview_digest: 'unbound' }, { fields: [{}] },
    { conflicts: [{}] }, { omitted: [{}] }, { warnings: [{}] }, { documents: [{}] }]) {
    assert.throws(() => checkSfrepPreview({ ...preview(), ...change }), /invalid/);
  }
  const html = harness(async () => new Response('<html>Login</html>', { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(html.api.preview(selection, html.io), /Unexpected/);
  await assert.rejects(html.api.export(selection, digest, html.io), /Unexpected/);
  const empty = harness(async () => new Response('', { headers: { 'content-type': 'application/octet-stream' } }));
  await assert.rejects(empty.api.export(selection, digest, empty.io), /empty/);
});

test('oversized responses are refused before body download', async () => {
  const h = harness(async () => new Response('small', { headers: { 'content-type': 'application/octet-stream', 'content-length': String(52 * 1024 * 1024) } }));
  await assert.rejects(h.api.export(selection, digest, h.io), /too large/);
});

test('preview sources must exactly match selected document IDs', async () => {
  for (const change of [{ documents: [] }, { documents: [preview().documents[0], preview().documents[0]] },
    { fields: [{ ...preview().fields[0], documentId: 22, provenance: { ...preview().fields[0].provenance, documentId: 22 } }] },
    { conflicts: [{ sourceField: 'contract_price', documentIds: [22], values: ['1', '2'] }] },
    { omitted: [{ sourceField: 'seller_name', documentId: 22, candidateId: null, reason: 'unsupported' }] }]) {
    const h = harness(async () => json({ ...preview(), ...change }));
    await assert.rejects(h.api.preview(selection, h.io), /does not match/);
  }
});

test('only the exact declared fee-simple default may have no document source', () => {
  const accepted = { ...preview(), fields: [feeSimple()], assumptions: [assumption()] };
  assert.equal(checkSfrepPreview(accepted, [21]).fields[0].documentId, null);
  assert.match(sfrepProvenanceText(accepted.fields[0]), /not document evidence/);
  const changes = [
    item => { item.fields[0].fieldId = 'BorrowerName'; },
    item => { item.fields[0].sourceField = item.fields[0].provenance.sourceField = 'borrower_name'; },
    item => { item.fields[0].value = 'false'; },
    item => { item.fields[0].type = 'TextField'; },
    item => { item.fields[0].candidateId = item.fields[0].provenance.candidateId = 41; },
    item => { item.fields[0].documentId = item.fields[0].provenance.documentId = 21; },
    item => { item.fields[0].provenance.kind = 'reviewed_document'; },
    item => { item.fields[0].provenance.rule = 'other_default'; },
    item => { item.fields[0].provenance.documentType = 'purchase_contract'; },
    item => { item.assumptions = []; },
    item => { item.assumptions[0].fieldId = 'BorrowerName'; },
    item => { item.assumptions.push(assumption()); },
    item => { item.fields = []; },
  ];
  for (const change of changes) {
    const invalid = structuredClone(accepted); change(invalid);
    assert.throws(() => checkSfrepPreview(invalid, [21]), /invalid/);
  }
});

test('document provenance cannot spoof scope, source, or candidate identity', () => {
  for (const change of [
    item => { item.fields[0].documentId = null; },
    item => { item.fields[0].provenance.documentId = 22; },
    item => { item.fields[0].provenance.sourceField = 'borrower_name'; },
    item => { item.fields[0].provenance.candidateId = 99; },
    item => { item.fields[0].provenance.kind = 'unreviewed_document'; },
    item => { item.fields[0].provenance.rule = 'user_requested_fee_simple_default'; },
    item => { item.fields[0].provenance = undefined; },
    item => { item.fields.push(structuredClone(item.fields[0])); },
  ]) {
    const invalid = preview(); change(invalid);
    assert.throws(() => checkSfrepPreview(invalid, [21]), /invalid/);
  }
});

test('formatted tax, HOA, and legal values disclose their exact reviewed source without mutating it', () => {
  for (const [sourceValue, value] of [[' $4,119.00 ', '4119'], ['4119.49', '4119'], ['4119.50', '4120'],
    ['0.50', '1'], ['00000025.5', '26'], ['999999999999.99', '1000000000000']]) {
    for (const [sourceField, fieldId] of [['tax_amount', 'RealEstateTaxAmount'], ['real_estate_tax_amount', 'RealEstateTaxAmount'], ['hoa_dues_amount', 'AssessmentAmount']]) {
      const item = formatted(sourceField, fieldId, sourceValue, value);
      const accepted = checkSfrepPreview({ ...preview(), fields: [item] }, [21]);
      assert.equal(accepted.fields[0].sourceValue, sourceValue);
      assert.equal(accepted.fields[0].value, value);
      assert.equal(accepted.fields[0].provenance.kind, 'reviewed_document');
      const note = sfrepProvenanceText(accepted.fields[0]);
      assert.ok(note.includes(JSON.stringify(sourceValue)));
      assert.match(note, /whole dollars.*half up/);
      assert.match(note, /Source evidence is unchanged/);
    }
  }
  const sourceValue = '  EXAMPLE  PARK 4 \r\n BLK 7\t LOT 9  ';
  const item = formatted('legal_description', 'LegalDescription', sourceValue, 'EXAMPLE  PARK 4 BLK 7 LOT 9', 'single_line_legal_description');
  const accepted = checkSfrepPreview({ ...preview(), fields: [item] }, [21]);
  assert.equal(accepted.fields[0].sourceValue, sourceValue);
  assert.ok(sfrepProvenanceText(item).includes(JSON.stringify(sourceValue)));
  assert.match(sfrepProvenanceText(item), /line breaks and tabs replaced by spaces/);
});

test('owner line display preserves and verifies the entire original owner identity', () => {
  const source = 'EXAMPLE OWNER ONE &\r\nEXAMPLE OWNER TWO';
  const item = formatted('owner_name', 'OwnerName', source, 'EXAMPLE OWNER ONE & EXAMPLE OWNER TWO', 'single_line_owner_name');
  assert.equal(checkSfrepPreview({ ...preview(), fields: [item] }, [21]).fields[0].sourceValue, source);
  for (const value of ['EXAMPLE OWNER ONE', source]) {
    assert.throws(() => checkSfrepPreview({ ...preview(), fields: [{ ...item, value }] }, [21]), /invalid/);
  }
  assert.throws(() => checkSfrepPreview({ ...preview(), fields: [{ ...item, fieldId: 'BorrowerName' }] }, [21]), /invalid/);
});

test('formatting metadata is paired, rule-specific, source-bound, and recomputed before accepting a preview', () => {
  const accepted = { ...preview(), fields: [formatted('tax_amount', 'RealEstateTaxAmount', '123.50', '124')] };
  for (const change of [
    item => { delete item.sourceValue; }, item => { delete item.formattingRule; },
    item => { item.sourceValue = null; }, item => { item.sourceValue = ''; },
    item => { item.sourceValue = '-123.50'; }, item => { item.sourceValue = '1,23.50'; },
    item => { item.sourceValue = '123.500'; }, item => { item.sourceValue = '1000000000000.00'; },
    item => { item.value = '123'; }, item => { item.value = '124.00'; },
    item => { item.formattingRule = 'unknown_rule'; }, item => { item.type = 'CheckBoxField'; },
    item => { item.fieldId = 'SalePriceAmount'; }, item => { item.fieldId = 'AssessmentAmount'; },
    item => { item.sourceField = item.provenance.sourceField = 'borrower_name'; },
    item => { item.provenance.kind = 'derived_reviewed_document'; },
    item => { item.provenance.sourceValue = item.sourceValue; },
    item => { item.provenance.documentId = 22; },
  ]) {
    const invalid = structuredClone(accepted); change(invalid.fields[0]);
    assert.throws(() => checkSfrepPreview(invalid, [21]), /invalid/);
  }
  for (const value of ['EXAMPLE PARK\nBLK 7', 'EXAMPLE PARK', 'EXAMPLE PARK  BLK 7']) {
    const invalid = { ...preview(), fields: [formatted('legal_description', 'LegalDescription', 'EXAMPLE PARK\nBLK 7', value, 'single_line_legal_description')] };
    assert.throws(() => checkSfrepPreview(invalid, [21]), /invalid/);
  }
  const foreign = structuredClone(accepted);
  foreign.fields[0].documentId = foreign.fields[0].provenance.documentId = 22;
  assert.throws(() => checkSfrepPreview(foreign, [21]), /does not match/);
});

test('Subject checklist identifies formatted taxes and shows the source plus formatting rule separately', () => {
  const value = { ...preview(), fields: [formatted('tax_amount', 'RealEstateTaxAmount', '$1,234.50', '1235')] };
  const row = sfrepSubjectChecklist(checkSfrepPreview(value, [21])).find(item => item.key === 'taxes');
  assert.equal(row.status, 'review'); assert.equal(row.statusLabel, 'Formatted — review');
  assert.deepEqual(row.values, ['1235']);
  assert.ok(row.notes.join(' ').includes('"$1,234.50"'));
  assert.match(row.notes.join(' '), /whole dollars.*half up/);
});

test('pure title case and ZIP presentation stay included while meaningful formatting and missing evidence still need review', () => {
  const value = { ...preview(), fields: [
    formatted('subject_street_address', 'StreetAddress', '100 EXAMPLE DR', '100 Example Dr', 'subject_title_case'),
    formatted('subject_city', 'City', 'GARLAND', 'Garland', 'subject_title_case'),
    formatted('subject_zip', 'ZipCode', '75041-1234', '75041', 'zip5_display'),
    formatted('owner_name', 'OwnerName', 'EXAMPLE OWNER LLC', 'Example Owner LLC', 'title_case_single_line_owner_name'),
    formatted('neighborhood_name', 'NeighborhoodName', 'EXAMPLE PARK', 'Example Park', 'title_case_subdivision_without_numeric_phase'),
  ] };
  const rows = sfrepSubjectChecklist(checkSfrepPreview(value, [21]));
  for (const key of ['street', 'city', 'zip', 'owner', 'neighborhood']) assert.equal(rows.find(item => item.key === key).status, 'included', key);
  assert.equal(rows.find(item => item.key === 'borrower').status, 'missing');
  value.fields[3] = formatted('owner_name', 'OwnerName', 'EXAMPLE OWNER\nSECOND OWNER', 'Example Owner Second Owner', 'title_case_single_line_owner_name');
  value.fields[4] = formatted('neighborhood_name', 'NeighborhoodName', 'EXAMPLE PARK 4', 'Example Park', 'title_case_subdivision_without_numeric_phase');
  value.conflicts = [{ sourceField: 'subject_city', documentIds: [21], values: ['Garland', 'Other City'] }];
  const reviewed = sfrepSubjectChecklist(checkSfrepPreview(value, [21]));
  for (const key of ['owner', 'neighborhood', 'city']) assert.equal(reviewed.find(item => item.key === key).status, 'review', key);
});

test('saved and direct fee-simple defaults stay traceable without confirmation warnings', () => {
  for (const saved of [false, true]) {
    const value = saved ? serverPreview() : { ...preview(), fields: [feeSimple()], assumptions: [assumption()] };
    const row = sfrepSubjectChecklist(checkSfrepPreview(value)).find(item => item.key === 'property-rights');
    assert.equal(row.status, 'included');
    assert.equal(row.statusLabel, 'Included — user default');
    assert.match(row.notes.join(' '), /user-requested fee-simple default/i);
    assert.doesNotMatch(row.notes.join(' '), /confirm property rights/i);
    value.knownMissing.push({ fieldId: 'PropertyRightsAppraisedFeeSimpleCheckBox', reason: 'A genuine unresolved rights issue.' });
    assert.equal(sfrepSubjectChecklist(checkSfrepPreview(value)).find(item => item.key === 'property-rights').status, 'review');
  }
});

test('listing derivation is bound to a valid calendar window and its selected date source', () => {
  const accepted = checkSfrepPreview(listingPreview(), [21]);
  assert.equal(accepted.effectiveDateContext.isPlaceholder, true);
  assert.match(sfrepProvenanceText(accepted.fields[0]), /2025-10-01 to 2026-10-01.*placeholder effective date/);
  for (const change of [
    item => { item.effectiveDateContext.isPlaceholder = false; },
    item => { item.effectiveDateContext.effectiveDate = '2026-02-30'; },
    item => { item.effectiveDateContext.source = 'other_source'; },
    item => { item.effectiveDateContext.windowStart = '2025-10-02'; },
    item => { item.effectiveDateContext.calendarMonths = 365; },
    item => { item.effectiveDateContext.sourceDocumentId = null; },
    item => { item.fields[0].provenance.effectiveDateSourceDocumentId = 22; },
    item => { item.fields[0].provenance.effectiveDateSource = 'inspection_date'; },
    item => { item.fields[0].provenance.windowStart = '2025-09-01'; },
    item => { item.fields[0].provenance.sourceValue = '2025-09-30'; },
    item => { item.fields[0].provenance.sourceValue = '2026-10-02'; },
    item => { item.fields[0].provenance.documentType = 'purchase_contract'; },
    item => { item.fields[0].value = 'false'; },
  ]) {
    const invalid = listingPreview(); change(invalid);
    assert.throws(() => checkSfrepPreview(invalid, [21]), /invalid/);
  }
  const foreign = listingPreview(); foreign.effectiveDateContext.sourceDocumentId = 22;
  foreign.fields[0].provenance.effectiveDateSourceDocumentId = 22;
  assert.throws(() => checkSfrepPreview(foreign, [21]), /does not match/);
  const leap = preview();
  leap.effectiveDateContext = { effectiveDate: '2024-02-29', source: 'assignment_effective_date', sourceDocumentId: null,
    windowStart: '2023-02-28', windowEnd: '2024-02-29', calendarMonths: 12, isPlaceholder: false };
  assert.equal(checkSfrepPreview(leap, [21]).effectiveDateContext.windowStart, '2023-02-28');
});

test('Subject checklist keeps independently reviewed parties included despite unsupported contract-role omissions', () => {
  for (const saved of [false, true]) {
    const value = checkSfrepPreview(serverPreview({ saved, partyRoles: true }), [1, 2, 3]);
    const unchanged = structuredClone(value);
    for (const [key, fieldId, sourceId, unrelatedRole, caution] of [
      ['borrower', 'BorrowerName', 1, 'buyer_name', /A buyer is not automatically/],
      ['owner', 'OwnerName', 3, 'seller_name', /A seller is not automatically/],
    ]) {
      const mapped = value.fields.find(field => field.fieldId === fieldId);
      assert.equal(mapped.provenance.kind, saved ? 'saved_report' : 'reviewed_document');
      assert.equal(saved ? mapped.provenance.sourceDocumentId : mapped.documentId, sourceId);
      assert.ok(value.omitted.some(entry => entry.sourceField === unrelatedRole && /Outside the current Subject/.test(entry.reason)));
      const row = sfrepSubjectChecklist(value).find(item => item.key === key);
      assert.equal(row.status, 'included', `${saved ? 'saved' : 'direct'} ${key}`);
      assert.equal(row.statusLabel, 'Included — reviewed');
      assert.deepEqual(row.values, [mapped.value]);
      assert.doesNotMatch(row.notes.join(' '), caution);
      assert.doesNotMatch(row.notes.join(' '), /Outside the current Subject/);
    }
    assert.deepEqual(value, unchanged, 'checklist must not remove the separately displayed omission evidence');
  }
});

test('party checklist still exposes correct-role omissions, conflicts, missing evidence and unsupported-role-only gaps', () => {
  for (const saved of [false, true]) {
    const original = checkSfrepPreview(serverPreview({ saved, partyRoles: true }), [1, 2, 3]);
    for (const [key, fieldId, sources, caution] of [
      ['borrower', 'BorrowerName', ['borrower_name'], /A buyer is not automatically/],
      ['owner', 'OwnerName', ['owner_name', 'record_owner_name'], /A seller is not automatically/],
    ]) {
      for (const sourceField of sources) {
        const omitted = structuredClone(original);
        omitted.omitted.push({ sourceField, documentId: 3, candidateId: null, reason: 'Correct-role evidence needs review.' });
        const omittedRow = sfrepSubjectChecklist(checkSfrepPreview(omitted, [1, 2, 3])).find(item => item.key === key);
        assert.equal(omittedRow.status, 'review');
        assert.match(omittedRow.notes.join(' '), /Correct-role evidence needs review/);
        const conflicting = structuredClone(original);
        conflicting.conflicts.push({ sourceField, documentIds: [1, 3], values: ['First reviewed party', 'Second reviewed party'] });
        const conflictRow = sfrepSubjectChecklist(checkSfrepPreview(conflicting, [1, 2, 3])).find(item => item.key === key);
        assert.match(conflictRow.statusLabel, /Review conflict/);
        assert.match(conflictRow.notes.join(' '), /Resolve the conflicting source evidence/);
      }
      const knownMissing = structuredClone(original);
      knownMissing.knownMissing.push({ fieldId, reason: 'Correct-role evidence is incomplete.' });
      const knownMissingRow = sfrepSubjectChecklist(checkSfrepPreview(knownMissing, [1, 2, 3])).find(item => item.key === key);
      assert.equal(knownMissingRow.status, 'review');
      assert.match(knownMissingRow.notes.join(' '), /Correct-role evidence is incomplete/);
      const unsupportedOnly = structuredClone(original);
      unsupportedOnly.fields = unsupportedOnly.fields.filter(field => field.fieldId !== fieldId);
      const unsupportedRow = sfrepSubjectChecklist(checkSfrepPreview(unsupportedOnly, [1, 2, 3])).find(item => item.key === key);
      assert.equal(unsupportedRow.status, 'review');
      assert.deepEqual(unsupportedRow.values, []);
      assert.match(unsupportedRow.notes.join(' '), caution);
      assert.match(unsupportedRow.notes.join(' '), /Outside the current Subject/);
      unsupportedOnly.omitted = [];
      const missingRow = sfrepSubjectChecklist(checkSfrepPreview(unsupportedOnly, [1, 2, 3])).find(item => item.key === key);
      assert.equal(missingRow.status, 'missing');
      assert.deepEqual(missingRow.values, []);
      assert.match(missingRow.notes.join(' '), caution);
    }
  }
});

test('Subject checklist distinguishes coverage, defaults, missing narrative, and unsafe inferences', () => {
  const value = preview();
  value.fields.push(field('subject_city', 'City', 'Dallas'), field('hoa_dues', 'AssessmentAmount', '75'), feeSimple());
  value.assumptions = [assumption()];
  value.conflicts = [{ sourceField: 'lender_client_name', documentIds: [21], values: ['First bank', 'Second bank'] }];
  value.omitted = [{ sourceField: 'is_pud', documentId: 21, candidateId: null, reason: 'An unchecked PUD checkbox is not exported.' }];
  const rows = sfrepSubjectChecklist(checkSfrepPreview(value, [21]));
  const row = key => rows.find(item => item.key === key);
  assert.equal(rows.length, 19);
  assert.equal(row('city').status, 'included'); assert.deepEqual(row('city').values, ['Dallas']);
  assert.equal(row('property-rights').status, 'included'); assert.equal(row('property-rights').statusLabel, 'Included — user default');
  assert.equal(row('pud').status, 'review'); assert.deepEqual(row('pud').values, []);
  assert.match(row('pud').notes.join(' '), /HOA dues or membership do not establish PUD/);
  assert.equal(row('listing').status, 'missing'); assert.deepEqual(row('listing').values, []);
  assert.match(row('listing').notes.join(' '), /No MLS evidence is not a No/);
  assert.match(row('lender').statusLabel, /Review conflict/);
  assert.equal(row('borrower').status, 'missing'); assert.equal(row('owner').status, 'missing');
  const listing = sfrepSubjectChecklist(checkSfrepPreview(listingPreview(), [21])).find(item => item.key === 'listing');
  assert.equal(listing.status, 'review'); assert.deepEqual(listing.values, ['Yes']);
  const history = sfrepSubjectChecklist(checkSfrepPreview(listingPreview(), [21])).find(item => item.key === 'listing-history');
  assert.match(history.notes.join(' '), /Complete the prior-listing data-source narrative/);
});

test('Subject checklist includes the reviewed Other assignment checkbox and its description', () => {
  const value = preview();
  const source = { kind: 'reviewed_document', sourceField: 'assignment_type', documentId: 21, candidateId: null, documentType: 'engagement_letter' };
  value.fields = [
    field('assignment_type', 'AssignmentTypeOtherCheckBox', 'true', { type: 'CheckBoxField', provenance: source }),
    field('assignment_type', 'AssignmentTypeOtherDescription', 'HELOC', { provenance: source }),
  ];
  const row = sfrepSubjectChecklist(checkSfrepPreview(value, [21])).find(item => item.key === 'assignment');
  assert.equal(row.status, 'included');
  assert.deepEqual(row.values, ['Other assignment', 'HELOC']);
});

test('cancellation settles pending authentication and disposes of a late response', async () => {
  let resolve, cancelled = 0;
  const h = harness(() => new Promise(r => { resolve = r; }));
  const pending = h.api.preview(selection, h.io);
  await Promise.resolve(); await Promise.resolve(); h.controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  resolve(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'application/json' } }));
  await Promise.resolve(); await Promise.resolve(); assert.equal(cancelled, 1);
});

test('cancellation while receiving the body never returns partial data', async () => {
  let cancelled = 0, started;
  const ready = new Promise(r => { started = r; });
  const h = harness(async () => new Response(new ReadableStream({ pull() { started(); }, cancel() { cancelled++; } }), { headers: { 'content-type': 'application/octet-stream' } }));
  const pending = h.api.export(selection, digest, h.io); await ready; await Promise.resolve(); h.controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(cancelled, 1);
});

test('download names remove path and control characters, notices remain plain strings', () => {
  assert.equal(sfrepDownloadFilename('../../folder/file.rpti'), 'file.rpti');
  assert.equal(sfrepDownloadFilename('C:\\folder\\file\n.rpti'), 'file_.rpti');
  assert.equal(sfrepDownloadFilename('bad.html'), 'HomeNode-SFREP.rpti');
  assert.equal(sfrepNoticeText('<script>text</script>'), '<script>text</script>');
  assert.match(sfrepNoticeText({ sourceField: 'contract_price', values: ['1', '2'], documentIds: [21, 22] }), /contract price: 1 \/ 2/);
  assert.match(sfrepNoticeText({ sourceField: 'seller_name', documentId: 21, candidateId: null, reason: 'not_mapped' }), /seller name: not mapped/);
});

const verifiedPhoto = () => ({ id: '10000000-0000-4000-8000-000000000001', label: 'Kitchen', category: 'Kitchen',
  roomLabel: 'Kitchen', caption: 'North wall', position: 1, revision: 2, status: 'verified', included: true,
  verifiedAt: '2026-10-06T12:00:00Z', variant: 'display', byteSize: 100,
  fileName: 'photo-10000000-0000-4000-8000-000000000001.jpg', reason: null,
  view_url: 'https://synthetic.example/photo?signature=short-lived' });

test('photo selection is sent through the existing preview/export transport and an old server cannot silently omit images', async () => {
  const h = harness(async (_url, init) => init.headers.accept === 'application/json'
    ? json({ ...preview(), photos: [verifiedPhoto()] })
    : new Response('rpti', { headers: { 'content-type': 'application/octet-stream' } }));
  const request = { ...selection, includePhotos: true };
  assert.equal((await h.api.preview(request, h.io)).photos[0].label, 'Kitchen');
  await h.api.export(request, digest, h.io);
  assert.ok(h.calls.every(call => JSON.parse(call.init.body).include_photos === true));
  const old = harness(); await assert.rejects(old.api.preview(request, old.io), /not available on this server/);
});

test('photo receipts reject private internals, unsafe URLs, duplicate IDs and false verification claims', () => {
  for (const change of [{ id: '../foreign' }, { included: true, status: 'uploading' }, { verifiedAt: null },
    { fileName: '../photo.jpg' }, { byteSize: 0 }, { variant: 'unknown' },
    { view_url: 'javascript:alert(1)' }, { view_url: 'https://user:password@synthetic.example/photo' },
    { objectKey: 'private' }, { checksumSha256: 'private' }]) {
    assert.throws(() => checkSfrepPreview({ ...preview(), photos: [{ ...verifiedPhoto(), ...change }] }), /photo preview is invalid/);
  }
  assert.throws(() => checkSfrepPreview({ ...preview(), photos: [verifiedPhoto(), verifiedPhoto()] }), /photo preview is invalid/);
});
