import assert from 'node:assert/strict';
import test from 'node:test';
import { projectCustomSubjectDocuments, mergeCustomSubjectApplication } from '../src/services/customSubjectApplication.js';
import { previewSfrepDocuments } from '../src/services/sfrepDocumentTransfer.js';
import { buildUrarSubjectEvidence } from '../src/services/urarSubjectEvidence.js';
import { checkSfrepPreview, sfrepProvenanceText, sfrepSubjectChecklist } from '../../dcad-frontend/src/features/sfrep/sfrepTransport.ts';

function actualPreview({ hoa = 'true', saved = true, hoaText, duplicateHoa = false } = {}) {
  const context = { accountId: 'SYNTHETIC-CONTRACT', address: '100 Example Dr', city: 'Garland', postalCode: '75041',
    effectiveDate: '2026-08-31', censusGeography: { tractCode: '018206', status: 'matched', geoid: '48113018206',
      vintage: 'Census2020_Current', updatedAt: '2026-10-03T00:00:00Z' } };
  const history = JSON.stringify({ schema_version: 1, listing_id: '77700001', list_date: '2026-05-29', coverage: 'complete', price_changes: [] });
  const sources = [
    ['mls_sheet', { subject_property_address: '100 EXAMPLE DR, GARLAND, TX 75041-1234', borrower_name: 'EXAMPLE BORROWER',
      owner_name: 'EXAMPLE OWNER LLC\nSECOND OWNER', neighborhood_name: 'EXAMPLE PARK 4', legal_description: 'EXAMPLE PARK\nBLK 1 LOT 2',
      tax_amount: '4321.50', mls_number: '77700001', list_date: '2026-05-29', original_list_price: '345000.00', days_on_market: '77', pud: hoa }],
    ['purchase_contract', { subject_property_address: '100 Example Dr, Garland, TX 75041', contract_date: '2026-08-25' }],
    ['mls_sheet', { subject_property_address: '100 Example Dr, Garland, TX 75041', mls_number: '77700001', listing_price_history: history }],
  ];
  const documents = sources.map(([document_type, values], index) => ({ id: index + 1, account_id: context.accountId,
    assignment_file_id: 4, document_type, processing_status: 'reviewed', upload_date: '2026-10-02', subject_context: context,
    title: 'Synthetic source', file_name: `synthetic-${index + 1}.pdf`, file_size_bytes: 100,
    candidates: Object.entries(values).map(([field_key, confirmed_value], offset) => ({ id: (index + 1) * 100 + offset,
      document_id: index + 1, field_key, confirmed_value, review_status: 'confirmed',
      ...(field_key === 'pud' ? { normalized_value: hoa, raw_value: hoa === 'true' ? 'Mandatory' : 'None',
        extraction_method: 'urar_subject_mls_sheet_hoa_workflow_proxy' } : {}) })) }));
  if (hoaText) {
    const evidence = buildUrarSubjectEvidence({ documentType: 'mls_sheet', pages: [hoaText] });
    documents[0].candidates = documents[0].candidates.filter(candidate => candidate.field_key !== 'pud');
    documents[0].candidates.push(...evidence.candidates.map((candidate, index) => ({ ...candidate, id: 900 + index,
      document_id: 1, review_status: 'confirmed', confirmed_value: candidate.normalized_value })));
    assert.ok(evidence.candidates.some(candidate => candidate.field_key === 'pud'), hoaText);
  }
  if (duplicateHoa) documents[0].candidates.push({ ...documents[0].candidates.find(candidate => candidate.field_key === 'pud'), id: 999 });
  if (saved) {
    const applied = mergeCustomSubjectApplication({ projection: projectCustomSubjectDocuments(documents) });
    documents[0].saved_report = { accountId: context.accountId, assignmentFileId: 4, assignmentRevision: 2,
      subject: { revision: 1, value: applied.subject }, evidence: { revision: 1, value: applied.evidence },
      assignmentDetails: { ...applied.assignmentDetails, lender_client_address: '20 EXAMPLE AVE, AUSTIN TX 78701-1234' },
      documents: structuredClone(documents) };
  }
  const { reportXml: _xml, pdfAddenda: _pdfs, ...publicPreview } = previewSfrepDocuments(documents, {
    accountId: context.accountId, assignmentFileId: 4, documentIds: [1, 2, 3], includeDocuments: false, formId: 'FNMA-1004-0911' });
  // Match the router's public JSON response; undefined receipt members do not
  // survive serialization and must not be required by the browser validator.
  return JSON.parse(JSON.stringify({ ok: true, ...publicPreview }));
}

test('full canonical preview JSON crosses the frontend boundary with Census, derived listing, formatting and HOA assumptions', () => {
  for (const hoa of ['true', 'false']) {
    const preview = actualPreview({ hoa });
    assert.equal(checkSfrepPreview(preview, [1, 2, 3]), preview);
    const census = preview.fields.find(field => field.fieldId === 'CensusTract');
    assert.equal(census.value, '182.06');
    assert.equal(census.provenance.origin, 'account_reference');
    assert.match(sfrepProvenanceText(census), /account Census reference.*not PDF evidence/);
    const history = preview.fields.find(field => field.fieldId === 'CurrentPriorListingDataSources');
    assert.match(history.value, /no reductions in list price, on the market for 77 days/);
    assert.equal(history.provenance.rule, 'reviewed_subject_listing_history_template_v1');
    assert.equal(history.provenance.windowStart, undefined);
    assert.equal(preview.assumptions.length, 2);
    assert.equal(preview.assumptions.find(item => item.rule === 'user_requested_hoa_workflow_proxy_v1').value, hoa);
    const checklist = sfrepSubjectChecklist(preview);
    assert.equal(checklist.find(item => item.key === 'listing-history').statusLabel, 'Derived — review');
    assert.equal(checklist.find(item => item.key === 'pud').statusLabel, 'User default — confirm');
    assert.deepEqual(checklist.find(item => item.key === 'pud').values, hoa === 'true' ? ['PUD checked'] : []);
  }
});

test('full direct-document preview JSON accepts composite-source formatting without saved report provenance', () => {
  const preview = actualPreview({ saved: false });
  assert.equal(checkSfrepPreview(preview, [1, 2, 3]), preview);
  for (const fieldId of ['StreetAddress', 'City', 'ZipCode']) {
    const field = preview.fields.find(item => item.fieldId === fieldId);
    assert.equal(field.sourceField, 'subject_property_address');
    assert.equal(field.sourceValue, '100 EXAMPLE DR, GARLAND, TX 75041-1234');
  }
});

test('all supported HOA extractor defaults survive the full saved and direct preview boundary', () => {
  for (const saved of [true, false]) {
    for (const hoaText of ['HOA: Yes', 'HOA: Mandatory', 'HOA: Required', 'HOA: None', 'HOA: No', 'HOA: Voluntary',
      'HOA Dues: $120 annually', 'HOA Fee: $30 per month', 'Association Fee: $25\nAssociation Fee Frequency: Monthly',
      'HOA Dues: $150 quarterly', 'HOA Fee: $150/qtr', 'Association Fee: $150\nAssociation Fee Frequency: Quarterly']) {
      const preview = actualPreview({ saved, hoaText });
      assert.equal(checkSfrepPreview(preview, [1, 2, 3]), preview, hoaText);
    }
  }
});

test('duplicate direct HOA observations keep actual producer assumptions, while canonical projection deduplicates them', () => {
  for (const saved of [true, false]) {
    const preview = actualPreview({ saved, duplicateHoa: true });
    assert.equal(preview.assumptions.filter(item => item.rule === 'user_requested_hoa_workflow_proxy_v1').length, saved ? 1 : 2);
    assert.equal(checkSfrepPreview(preview, [1, 2, 3]), preview);
  }
});

function mixedPudPreview(observations, saved = false) {
  const context = { accountId: 'SYNTHETIC-PUD', address: '100 Example Dr', city: 'Garland', postalCode: '75041', effectiveDate: '2026-08-31' };
  const documents = observations.map((texts, index) => {
    const extracted = texts.flatMap(text => buildUrarSubjectEvidence({ documentType: 'mls_sheet',
      pages: [`Subject Address: 100 Example Dr, Garland, TX 75041\n${text}`] }).candidates);
    return { id: index + 1, account_id: context.accountId, assignment_file_id: 4, document_type: 'mls_sheet',
      processing_status: 'reviewed', upload_date: '2026-10-02', subject_context: context,
      title: 'Synthetic PUD source', file_name: `synthetic-pud-${index + 1}.pdf`, file_size_bytes: 100,
      candidates: extracted.map((candidate, offset) => ({ ...candidate, id: (index + 1) * 100 + offset,
        document_id: index + 1, review_status: 'confirmed', confirmed_value: candidate.normalized_value })) };
  });
  if (saved) {
    const applied = mergeCustomSubjectApplication({ projection: projectCustomSubjectDocuments(documents) });
    documents[0].saved_report = { accountId: context.accountId, assignmentFileId: 4, assignmentRevision: 2,
      subject: { revision: 1, value: applied.subject }, evidence: { revision: 1, value: applied.evidence },
      assignmentDetails: applied.assignmentDetails, documents: structuredClone(documents) };
  }
  const { reportXml: _xml, pdfAddenda: _pdfs, ...publicPreview } = previewSfrepDocuments(documents, {
    accountId: context.accountId, assignmentFileId: 4, documentIds: documents.map(document => document.id),
    includeDocuments: false, formId: 'FNMA-1004-0911' });
  return JSON.parse(JSON.stringify({ ok: true, ...publicPreview }));
}

test('equal explicit PUD and HOA proxy evidence accepts both source orders and repeated same-document observations', () => {
  for (const observations of [
    [['PUD: Yes'], ['HOA: Mandatory']], [['HOA: Mandatory'], ['PUD: Yes']],
    [['PUD: Yes'], ['HOA: Mandatory', 'HOA: Mandatory']],
    [['HOA: Mandatory', 'HOA: Mandatory'], ['PUD: Yes']],
    [['PUD: Yes', 'HOA: Mandatory']], [['HOA: Mandatory', 'PUD: Yes']],
  ]) {
    for (const saved of [false, true]) {
      const preview = mixedPudPreview(observations, saved);
      const pud = preview.fields.find(field => field.fieldId === 'PropertyTypePUDCheckBox');
      assert.equal(pud.value, 'true');
      assert.deepEqual(preview.conflicts, []);
      assert.equal(preview.omitted.some(item => item.sourceField === 'pud'), false);
      if (!saved) assert.equal(preview.assumptions.filter(item => item.rule === 'user_requested_hoa_workflow_proxy_v1').length,
        observations.flat().filter(text => text.startsWith('HOA:')).length);
      assert.equal(checkSfrepPreview(preview, preview.documents.map(document => document.id)), preview);
    }
  }
});

test('mixed direct PUD allowance rejects wrong values, fields and orphan assumptions and never relaxes saved receipts', () => {
  for (const change of [
    preview => { preview.fields.find(field => field.fieldId === 'PropertyTypePUDCheckBox').value = 'false'; },
    preview => { preview.fields.find(field => field.fieldId === 'PropertyTypePUDCheckBox').type = 'TextField'; },
    preview => { const field = preview.fields.find(field => field.fieldId === 'PropertyTypePUDCheckBox'); field.sourceField = field.provenance.sourceField = 'unrelated'; },
    preview => { preview.fields = preview.fields.filter(field => field.fieldId !== 'PropertyTypePUDCheckBox'); },
    preview => { preview.assumptions.find(item => item.rule === 'user_requested_hoa_workflow_proxy_v1').value = 'false'; },
  ]) {
    const preview = mixedPudPreview([['PUD: Yes'], ['HOA: Mandatory']]);
    change(preview);
    assert.throws(() => checkSfrepPreview(preview, [1, 2]), /invalid/);
  }
  const direct = mixedPudPreview([['PUD: Yes'], ['HOA: Mandatory']]);
  const saved = mixedPudPreview([['PUD: Yes'], ['HOA: Mandatory']], true);
  assert.equal(saved.fields.find(field => field.fieldId === 'PropertyTypePUDCheckBox').provenance.rule, undefined);
  assert.equal(saved.assumptions.some(item => item.rule === 'user_requested_hoa_workflow_proxy_v1'), false);
  saved.assumptions.push(direct.assumptions.find(item => item.rule === 'user_requested_hoa_workflow_proxy_v1'));
  assert.throws(() => checkSfrepPreview(saved, [1, 2]), /invalid/);
});

test('disagreeing explicit and proxy PUD evidence remains conflict-only in both source orders', () => {
  for (const observations of [[['PUD: No'], ['HOA: Mandatory']], [['HOA: Mandatory'], ['PUD: No']]]) {
    const preview = mixedPudPreview(observations);
    assert.equal(preview.fields.some(field => field.fieldId === 'PropertyTypePUDCheckBox'), false);
    assert.ok(preview.conflicts.some(item => item.sourceField === 'pud'));
    assert.equal(checkSfrepPreview(preview, [1, 2]), preview);
    // A true assumption without an exported checkbox requires a visible
    // conflict/omission; it cannot become an unexplained affirmative claim.
    preview.conflicts = [];
    preview.omitted = preview.omitted.filter(item => item.sourceField !== 'pud');
    assert.throws(() => checkSfrepPreview(preview, [1, 2]), /invalid/);
  }
});

test('direct false HOA assumptions require PUD omission or conflict while saved suppression remains advisory only', () => {
  for (const observations of [
    [['HOA: None']], [['HOA: No']], [['HOA: Voluntary']], [['HOA: None', 'HOA: None']],
    [['PUD: No'], ['HOA: None']], [['HOA: None'], ['PUD: No']],
    [['PUD: Yes'], ['HOA: None']], [['HOA: None'], ['PUD: Yes']],
  ]) {
    const direct = mixedPudPreview(observations);
    const ids = direct.documents.map(document => document.id);
    assert.ok(direct.assumptions.some(item => item.rule === 'user_requested_hoa_workflow_proxy_v1' && item.value === 'false'));
    assert.ok(direct.omitted.some(item => item.sourceField === 'pud'));
    assert.equal(direct.fields.some(field => field.fieldId === 'PropertyTypePUDCheckBox'), false);
    assert.equal(checkSfrepPreview(direct, ids), direct);
    const altered = structuredClone(direct);
    altered.omitted = altered.omitted.filter(item => item.sourceField !== 'pud');
    altered.conflicts = altered.conflicts.filter(item => item.sourceField !== 'pud');
    assert.throws(() => checkSfrepPreview(altered, ids), /provenance is invalid/);
    altered.omitted.push({ sourceField: 'hoa_dues_amount', documentId: ids[0], candidateId: null, reason: 'Unrelated amount omission' });
    assert.throws(() => checkSfrepPreview(altered, ids), /provenance is invalid/);
    if (direct.conflicts.some(item => item.sourceField === 'pud')) {
      altered.conflicts = direct.conflicts;
      assert.equal(checkSfrepPreview(altered, ids), altered);
    }
  }
  for (const hoaText of ['HOA: None', 'HOA: No', 'HOA: Voluntary']) {
    const saved = actualPreview({ hoaText });
    assert.ok(saved.assumptions.some(item => item.rule === 'user_requested_hoa_workflow_proxy_v1' && item.value === 'false'));
    assert.equal(saved.omitted.some(item => item.sourceField === 'pud'), false);
    assert.equal(saved.conflicts.some(item => item.sourceField === 'pud'), false);
    assert.equal(checkSfrepPreview(saved, [1, 2, 3]), saved);
    const row = sfrepSubjectChecklist(saved).find(item => item.key === 'pud');
    assert.deepEqual(row.values, []);
    assert.equal(row.statusLabel, 'User default — confirm');
    assert.match(row.notes.join(' '), /An omitted checkbox is not No/);
  }
});
