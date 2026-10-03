import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUrarSubjectEvidence } from '../src/services/urarSubjectEvidence.js';
import { extractUrarReferenceLayout } from '../src/services/urarReferenceLayouts.js';
import { buildSfrepReportExport } from '../src/services/sfrepReportExport.js';
import { isUrarPlaceholder, isUrarStateCode } from '../src/util/urarScalarValidation.js';

const extractBorrower = value => buildUrarSubjectEvidence({ documentType: 'engagement_letter', pages: [`Borrower: ${value}`] });
function exportValue(field_key, value) {
  return buildSfrepReportExport({ documents: [{ id: 1, processing_status: 'reviewed', property_role: 'subject',
    document_type: 'engagement_letter', candidates: [{ id: 1, document_id: 1, field_key, confirmed_value: value, review_status: 'confirmed' }] }] });
}

test('shared predicates do not coerce objects or change caller whitespace policies', () => {
  for (const value of [null, undefined, true, 1, {}, ['TX']]) {
    assert.equal(isUrarPlaceholder(value), false);
    assert.equal(isUrarStateCode(value), false);
  }
  assert.equal(isUrarPlaceholder('xsi:nil'), true);
  assert.equal(isUrarPlaceholder('—–_'), true);
  assert.equal(isUrarPlaceholder(' unknown '), false);
  assert.equal(isUrarStateCode('tx'), true);
  assert.equal(isUrarStateCode(' TX '), false);
});

test('exact placeholders do not become suggestions that disappear only after confirmation', () => {
  for (const value of ['—', '–', '—–_', '—.', 'unknown', 'xsi:nil', 'not applicable', 'to be confirmed']) {
    assert.equal(extractBorrower(value).candidates.some(candidate => candidate.field_key === 'borrower_name'), false, value);
    assert.equal(exportValue('borrower_name', value).fields.length, 0, value);
  }
  for (const value of ['TBD Holdings', 'N/A Partners', 'Example — Trust', 'Pending Ventures']) {
    assert.equal(extractBorrower(value).candidates.find(candidate => candidate.field_key === 'borrower_name')?.normalized_value, value);
    assert.equal(exportValue('borrower_name', value).fields.find(field => field.fieldId === 'BorrowerName')?.value, value);
  }
});

test('CAD layout neighborhood placeholders use the same exact-marker policy as labeled extraction and export', () => {
  const pagesFor = name => [[
      'DCAD: Residential Acct Detail', 'Residential Account #11111000000222222',
      'Property Location (Current 2026)', 'Address: 100 EXAMPLE DR', 'Legal Desc (Current 2026)',
      `1: ${name}`, '2: BLK 1 LT 2', '3:', '4:', '5:', 'Value',
      'https://www.dallascad.org/AcctDetailRes.aspx?ID=11111000000222222',
    ].join('\n')];
  const baseline = extractUrarReferenceLayout({ sourceKind: 'cad', pages: pagesFor('EXAMPLE PARK') });
  assert.equal(baseline.candidates.find(candidate => candidate.field_key === 'neighborhood_name')?.normalized_value, 'EXAMPLE PARK');
  for (const name of ['NOT APPLICABLE', 'TO BE CONFIRMED', 'UNASSIGNED']) {
    const pages = pagesFor(name);
    const result = extractUrarReferenceLayout({ sourceKind: 'cad', pages });
    assert.equal(result.candidates.some(candidate => candidate.field_key === 'neighborhood_name'), false, name);
    assert.equal(exportValue('neighborhood_name', name).fields.length, 0);
  }
});

test('unknown state codes cannot enter direct, composite-address or saved-report export', () => {
  for (const state of ['ZZ', 'UK', 'TE', '12', 'Texas']) {
    const extracted = buildUrarSubjectEvidence({ documentType: 'engagement_letter', pages: [`Subject State: ${state}`] });
    assert.equal(extracted.candidates.some(candidate => candidate.field_key === 'subject_state'), false, state);
    assert.equal(exportValue('subject_state', state).fields.length, 0, state);
    assert.equal(exportValue('subject_property_address', `100 Example Dr, Exampleton, ${state} 75000`).fields.length, 0, state);
    const saved = buildSfrepReportExport({ savedReportFields: [{ sourceField: 'subject_state', value: state,
      provenance: { kind: 'saved_report', sourceField: 'subject_state', documentId: null, candidateId: null } }] });
    assert.equal(saved.fields.length, 0, state);
  }
});

test('all supported US states, district and territories retain state export with case normalization', () => {
  for (const state of 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI'.split(' ')) {
    const extracted = buildUrarSubjectEvidence({ documentType: 'engagement_letter', pages: [`Subject State: ${state.toLowerCase()}`] });
    assert.equal(extracted.candidates.find(candidate => candidate.field_key === 'subject_state')?.normalized_value, state);
    const result = exportValue('subject_state', state.toLowerCase());
    assert.equal(result.fields.find(field => field.fieldId === 'State')?.value, state);
    const composite = exportValue('subject_property_address', `100 Example Dr, Exampleton, ${state.toLowerCase()} 75000`);
    assert.equal(composite.fields.find(field => field.fieldId === 'State')?.value, state);
  }
});
