import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { applyReportManualValues } from '../src/lib/legacyDcadDetail.ts';
import { editablePropertyReportSectionValue } from '../src/lib/propertyReportEditableSections.ts';
import { documentApplicationMessage, mergeDocumentApplication, preserveNewerReportSections } from '../src/lib/propertyReportDocumentApplication.ts';
import * as assignmentHelpers from '../src/lib/propertyReportAssignment.ts';
import * as presentation from '../src/lib/propertyReportPresentation.ts';
import { propertyReportOwnerPresentation } from '../src/lib/propertyReportSubject.ts';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';

const sectionKey = 'report.subject_identification';
const subject = () => ({
  property_location: { address: '100 Reviewed Rd', city: 'Example', state: 'TX', postal_code: '75001', county: 'Example County', subdivision: 'EXAMPLE PARK' },
  owner: { owner_name: 'Reviewed Owner', parties: [] },
  legal_description: { lines: ['EXAMPLE PARK', 'BLK 1 LOT 2'] },
  urar_subject: { borrower_name: 'Reviewed Borrower', assessor_parcel_number: '0000001234', tax_year: '2025', tax_amount: '1234.50', property_rights: 'fee_simple', offered_for_sale_prior_12_months: false },
});
const base = () => ({
  property_location: { address: '1 CAD Rd', city: 'CAD City', state: 'TX', county: 'CAD County' },
  owner: { owner_name: 'CAD Owner', mailing_address: '2 Mailing Rd', parties: [{ owner_name: 'CAD Owner', ownership_pct: 100 }] },
  legal_description: { lines: ['CAD LEGAL'], deed_transfer_date: '2025-01-01' },
  tax_year: 2026, estimated_taxes_total: '9999', value_summary: { market_value: 500000 }, main_improvement: {}, housing_profile: null,
  additional_improvements: [], secondary_improvements: [], land_detail: [], sales_history: [], property_activity_history: [], photos: [], assignment_details: {},
});
const file = () => ({ id: 7, account_id: 'EXAMPLE', revision: 2, assignment_details: { lender_client_name: 'Saved Bank' },
  workfile: { status: 'draft' }, custom_appraisal_sections: { [sectionKey]: { value: {}, revision: 1, last_applied_session_id: null, updated_at: 'old' } } });
const application = () => ({ applied: true, account_id: 'EXAMPLE', assignment_file_id: 7,
  custom_appraisal_sections: { [sectionKey]: { value: subject(), revision: 2, last_applied_session_id: null, updated_at: 'new' } }, warnings: [] });

test('saved Subject section hydrates all report fields and seeds the same editor without touching CAD source or assignment fields', () => {
  const original = base();
  const detail = applyReportManualValues(original, { [sectionKey]: { value: subject() } }, { explicitSubjectValues: true });
  const value = editablePropertyReportSectionValue(sectionKey, { detail, improvement: undefined, housing: undefined, inspectionDetails: {}, additionalImprovements: [] });
  assert.deepEqual(value.urar_subject, subject().urar_subject);
  assert.equal(value.owner.owner_name, 'Reviewed Owner'); assert.deepEqual(value.owner.parties, []);
  assert.equal(value.property_location.address, '100 Reviewed Rd'); assert.deepEqual(value.legal_description.lines, ['EXAMPLE PARK', 'BLK 1 LOT 2']);
  assert.equal(original.property_location.address, '1 CAD Rd'); assert.equal(original.owner.owner_name, 'CAD Owner');
  assert.equal(detail.tax_year, 2026); assert.equal(detail.value_summary.market_value, 500000);
  assert.equal(detail.urar_subject.tax_year, '2025'); assert.equal(detail.urar_subject.tax_amount, '1234.50');
  assert.deepEqual(detail.assignment_details, {});
});

test('explicit selected-file blanks and empty arrays never fall back to CAD while absent leaves still do', () => {
  const value = { property_location: { address: '', state: '' }, owner: { owner_name: '', parties: [] },
    legal_description: { lines: [] }, urar_subject: { borrower_name: '', assessor_parcel_number: '', tax_year: '', tax_amount: '', property_rights: '', offered_for_sale_prior_12_months: null } };
  const detail = applyReportManualValues(base(), { [sectionKey]: { value } }, { explicitSubjectValues: true });
  assert.equal(detail.property_location.address, ''); assert.equal(detail.property_location.state, '');
  assert.equal(detail.property_location.county, 'CAD County'); assert.equal(detail.owner.owner_name, '');
  assert.deepEqual(detail.owner.parties, []); assert.deepEqual(detail.legal_description.lines, []);
  assert.deepEqual(detail.urar_subject, value.urar_subject);
  const editor = editablePropertyReportSectionValue(sectionKey, { detail, improvement: undefined, housing: undefined, inspectionDetails: {}, additionalImprovements: [] });
  assert.equal(editor.property_location.state, '', 'the editor must not restore its TX default over a saved blank');
});

test('new owner-name-only evidence drops obsolete CAD parties; unknown fields are not reflected', () => {
  const detail = applyReportManualValues(base(), { [sectionKey]: { value: { owner: { owner_name: 'Corrected Owner' }, urar_subject: { borrower_name: 'Borrower', property_rights: 'invalid', offered_for_sale_prior_12_months: 'false', receipt: 'private' } } } }, { explicitSubjectValues: true });
  assert.equal(detail.owner.owner_name, 'Corrected Owner'); assert.deepEqual(detail.owner.parties, []);
  assert.deepEqual(detail.urar_subject, { borrower_name: 'Borrower' });
});

test('explicit saved ownership parties govern the report while remaining editable and preserving their source values', () => {
  const owner = { owner_name: 'Alternate Name', parties: [
    { owner_name: ' First Reviewed Owner ', ownership_pct: '60' },
    { owner_name: 'Second Reviewed Owner', ownership_pct: 40 },
    { owner_name: ' ' },
  ] };
  const detail = applyReportManualValues(base(), { [sectionKey]: { value: { owner } } }, { explicitSubjectValues: true });
  const resolved = propertyReportOwnerPresentation(detail.owner, owner);
  assert.equal(resolved.ownerName, 'First Reviewed Owner / Second Reviewed Owner');
  assert.deepEqual(resolved.ownerParties, [
    { owner_name: 'First Reviewed Owner', ownership_pct: '60' },
    { owner_name: 'Second Reviewed Owner', ownership_pct: 40 },
  ]);
  const editor = editablePropertyReportSectionValue(sectionKey, { detail, improvement: undefined, housing: undefined, inspectionDetails: {}, additionalImprovements: [] });
  assert.deepEqual(editor.owner.parties, owner.parties);
  assert.equal(editor.owner.owner_name, 'Alternate Name');
  assert.equal(owner.parties[0].owner_name, ' First Reviewed Owner ');
  assert.equal(propertyReportOwnerPresentation(base().owner, { parties: [{ owner_name: 'Repeated' }, { owner_name: 'Repeated' }] }).ownerName, 'Repeated / Repeated');
});

test('saved owner-name and empty-party corrections never revive inherited CAD parties', () => {
  for (const owner of [{ owner_name: 'Corrected Owner' }, { owner_name: 'Corrected Owner', parties: [] }]) {
    assert.deepEqual(propertyReportOwnerPresentation(base().owner, owner), { ownerName: 'Corrected Owner', ownerParties: [] });
  }
  assert.deepEqual(propertyReportOwnerPresentation(base().owner, { owner_name: '', parties: [] }), { ownerName: '', ownerParties: [] });
  assert.deepEqual(propertyReportOwnerPresentation(base().owner, { parties: [] }), { ownerName: undefined, ownerParties: [] });
  assert.equal(propertyReportOwnerPresentation(base().owner, undefined).ownerName, 'CAD Owner');
});

test('malformed or allblank explicit saved parties cannot fall back to an alternate or CAD owner', () => {
  for (const parties of [null, 'Invalid', {}, [{ owner_name: '' }], [{ owner_name: '  ' }], [null, false, 'Name', {}]]) {
    const resolved = propertyReportOwnerPresentation(base().owner, { owner_name: 'Must not display', parties });
    assert.deepEqual(resolved, { ownerName: '', ownerParties: [] });
    assert.equal(presentation.displayValue(resolved.ownerName), 'Not reported');
  }
});

test('section-only document applications update the exact file without resetting its assignment draft or exposing receipts', () => {
  const original = file(), incoming = application();
  incoming.custom_appraisal_sections['report.subject_evidence'] = { value: { receipt: 'server only' }, revision: 1 };
  const merged = mergeDocumentApplication(original, incoming);
  assert.equal(merged.assignmentUpdated, false); assert.equal(merged.sectionsUpdated, true);
  assert.equal(merged.file.assignment_details, original.assignment_details); assert.equal(merged.file.revision, 2);
  assert.deepEqual(merged.file.custom_appraisal_sections[sectionKey].value, subject());
  assert.equal(merged.file.custom_appraisal_sections['report.subject_evidence'], undefined);
  assert.deepEqual(original.custom_appraisal_sections[sectionKey].value, {});
});

test('document applications reject other files, locked files and older revisions while independently merging current sections', () => {
  for (const change of [item => { item.account_id = 'OTHER'; }, item => { item.assignment_file_id = 8; }, item => { delete item.account_id; }, item => { delete item.assignment_file_id; }]) {
    const incoming = application(); change(incoming); assert.equal(mergeDocumentApplication(file(), incoming), null);
  }
  for (const status of ['signed', 'archived']) assert.equal(mergeDocumentApplication({ ...file(), workfile: { status } }, application()), null);
  const incoming = { ...application(), revision: 1, assignment_details: { lender_client_name: 'Old Bank' } };
  const merged = mergeDocumentApplication(file(), incoming);
  assert.equal(merged.file.assignment_details.lender_client_name, 'Saved Bank'); assert.equal(merged.sectionsUpdated, true);
  incoming.revision = 3;
  assert.equal(mergeDocumentApplication(file(), incoming).assignmentUpdated, true);
  incoming.custom_appraisal_sections[sectionKey].revision = 1; delete incoming.assignment_details;
  assert.equal(mergeDocumentApplication(file(), incoming), null);
});

test('approval messages distinguish saved supported fields from evidence-only approval and bound warnings', () => {
  const message = documentApplicationMessage('6 fields approved.', { ...application(), warnings: ['Owner conflicts require review.', 'Tax source omitted.'] });
  assert.match(message, /6 fields approved.*Supported report fields were saved/);
  assert.match(message, /Owner conflicts require review.*Tax source omitted/);
  assert.doesNotMatch(message, /all.*applied|synchronized with Assignment Details/);
  assert.match(documentApplicationMessage('Approved.', { ...application(), applied: false }), /report fields may be unchanged/);
});

test('queued document and assignment completions retain a newer manual Subject revision from the same React batch', () => {
  const snapshot = file();
  const incoming = application();
  assert.equal(mergeDocumentApplication(snapshot, incoming).file.custom_appraisal_sections[sectionKey].revision, 2);
  const manual = { ...snapshot, custom_appraisal_sections: {
    [sectionKey]: { value: { ...subject(), urar_subject: { ...subject().urar_subject, borrower_name: '', tax_amount: '5000.49' } }, revision: 3 },
    'report.land_details': { value: { land_detail: [] }, revision: 4 },
  } };
  const afterDocument = mergeDocumentApplication(manual, incoming)?.file || manual;
  assert.equal(afterDocument, manual, 'the updater must use the latest state rather than the captured snapshot');
  const afterAssignment = preserveNewerReportSections(afterDocument, { ...snapshot, revision: 3, assignment_details: { lender_client_name: 'Updated Bank' } });
  assert.equal(afterAssignment.assignment_details.lender_client_name, 'Updated Bank');
  assert.equal(afterAssignment.custom_appraisal_sections[sectionKey].revision, 3);
  assert.equal(afterAssignment.custom_appraisal_sections[sectionKey].value.urar_subject.borrower_name, '');
  assert.equal(afterAssignment.custom_appraisal_sections[sectionKey].value.urar_subject.tax_amount, '5000.49');
  assert.equal(afterAssignment.custom_appraisal_sections['report.land_details'].revision, 4);
  assert.equal(preserveNewerReportSections(manual, { ...snapshot, id: 8 }), manual);
  assert.equal(preserveNewerReportSections(manual, { ...snapshot, account_id: 'OTHER' }), manual);
  const source = readFileSync(new URL('../src/pages/PropertyReport.tsx', import.meta.url), 'utf8');
  assert.match(source, /setActiveAssignmentFile\(\(current\) => \{[\s\S]*?mergeDocumentApplication\(current, application\)/);
  assert.match(source, /preserveNewerReportSections\(current, updatedFile\)/);
});

function editorHarness(initialValue = subject()) {
  let cursor = 0, tree;
  const states = [];
  const react = { useState(initial) { const index = cursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
    return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next; }]; } };
  const jsx = (type, props, key) => ({ type, props, key });
  const component = loadTrustedRepositoryCommonJs(new URL('../src/components/ReportSectionEditor.tsx', import.meta.url), name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
    if (name === '@/lib/propertyReportAssignment') return assignmentHelpers;
    throw new Error(`Unexpected dependency ${name}`);
  });
  const props = { section: { key: sectionKey, title: 'Subject' }, initialValue, saving: false, onCancel() {}, onSave(value) { props.saved = value; } };
  const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' ? [node, ...nodes(node.props?.children)] : [];
  const text = node => Array.isArray(node) ? node.map(text).join(' ') : node && typeof node === 'object' ? text(node.props?.children) : typeof node === 'string' ? node : '';
  const render = patch => { Object.assign(props, patch); cursor = 0; tree = component.default(props); };
  render();
  return { props, render, get tree() { return tree; }, nodes: () => nodes(tree),
    input(label) { const element = nodes(tree).find(node => node.type === 'label' && text(node).includes(label)); return nodes(element).find(node => ['input', 'select', 'textarea'].includes(node.type)); },
    save() { nodes(tree).find(node => node.type === 'button' && text(node) === 'Save Changes').props.onClick(); },
  };
}

test('Subject editor keeps corrections through unrelated hydration and saves the same draft', () => {
  const h = editorHarness();
  h.input('Borrower').props.onChange({ target: { value: 'Appraiser Correction' } }); h.render({});
  h.render({ initialValue: { ...subject(), urar_subject: { ...subject().urar_subject, borrower_name: 'Background Update' } } });
  assert.equal(h.input('Borrower').props.value, 'Appraiser Correction'); h.save();
  assert.equal(h.props.saved.urar_subject.borrower_name, 'Appraiser Correction');
});

test('Subject editor preserves unknown versus explicit No, exact taxes, rights, and saved blank APN', () => {
  const value = subject(); value.urar_subject.offered_for_sale_prior_12_months = null;
  const h = editorHarness(value);
  assert.equal(h.input('Offered for Sale').props.value, '');
  h.input('Offered for Sale').props.onChange({ target: { value: 'false' } });
  h.input('Property Rights').props.onChange({ target: { value: 'leasehold' } });
  h.input('Real Estate Taxes').props.onChange({ target: { value: '4119.49' } });
  h.input('Assessor Parcel').props.onChange({ target: { value: '' } }); h.render({}); h.save();
  assert.equal(h.props.saved.urar_subject.offered_for_sale_prior_12_months, false);
  assert.equal(h.props.saved.urar_subject.property_rights, 'leasehold');
  assert.equal(h.props.saved.urar_subject.tax_amount, '4119.49'); assert.equal(h.props.saved.urar_subject.assessor_parcel_number, '');
  h.input('Offered for Sale').props.onChange({ target: { value: '' } }); h.render({}); h.save();
  assert.equal(h.props.saved.urar_subject.offered_for_sale_prior_12_months, null);
  h.render({ readOnly: true }); assert.ok(h.nodes().some(node => node.type === 'fieldset' && node.props.disabled));
});

test('Subject display uses the single saved section and labels account identity separately from APN', () => {
  const source = readFileSync(new URL('../src/pages/PropertyReport.tsx', import.meta.url), 'utf8');
  const summary = readFileSync(new URL('../src/components/PropertyReportSubjectSummary.tsx', import.meta.url), 'utf8');
  for (const label of ['Assessor Parcel Number (APN)', 'HomeNode Account Number', 'Borrower', 'Real Estate Tax Year', 'Real Estate Taxes', 'Property Rights Appraised', 'Offered for Sale in Prior 12 Months']) assert.ok(summary.includes(`label="${label}"`), label);
  assert.equal((source.match(/<PropertyReportSubjectSummary/g) || []).length, 1);
  assert.match(source, /propertyReportOwnerPresentation\(detail\?\.owner, savedSubject\?\.owner\)/);
  assert.match(source, /key=\{editingSessionKey\}/);
  assert.match(source, /if \(!merged\.assignmentUpdated\)/);
});

test('Subject summary shows exact saved tax cents, separate account identity, and unknown versus No', () => {
  const jsx = (type, props, key) => ({ type, props, key });
  const component = loadTrustedRepositoryCommonJs(new URL('../src/components/PropertyReportSubjectSummary.tsx', import.meta.url), name => {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
    if (name === '@/lib/propertyReportPresentation') return presentation;
    if (name === '@/components/PropertyReportControls') return { SummaryField: 'SummaryField' };
    throw new Error(`Unexpected dependency ${name}`);
  });
  const detail = { ...base(), ...subject() };
  const render = () => component.default({ detail, accountId: 'ACCOUNT-ONLY', ownerParties: [], ownerName: 'Reviewed Owner',
    primaryZoningDisplay: 'Unknown', censusLookupLoading: false, censusLookupMessage: '', onLookUpCensusTract() {} });
  const field = label => render().props.children.find(item => item.props.label === label).props.value;
  assert.equal(field('Real Estate Taxes'), '1234.50');
  assert.equal(field('HomeNode Account Number'), 'ACCOUNT-ONLY');
  assert.equal(field('Assessor Parcel Number (APN)'), '0000001234');
  assert.equal(field('Owner Name'), 'Reviewed Owner');
  assert.equal(field('Offered for Sale in Prior 12 Months'), 'No');
  detail.urar_subject.offered_for_sale_prior_12_months = null;
  detail.urar_subject.assessor_parcel_number = '';
  assert.equal(field('Offered for Sale in Prior 12 Months'), 'Unknown / not reported');
  assert.equal(field('Assessor Parcel Number (APN)'), 'Not reported');
});
