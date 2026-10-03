import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmAssignmentDocumentCandidates, reviewAssignmentDocumentCandidate } from '../src/services/assignmentDocuments.js';
import { CUSTOM_SUBJECT_SECTION, CUSTOM_SUBJECT_EVIDENCE_SECTION, CUSTOM_SUBJECT_FIELD_DESCRIPTORS,
  projectCustomSubjectDocuments, mergeCustomSubjectApplication, readCustomSubjectValue,
  persistCustomSubjectApplication, readCustomSubjectDocuments } from '../src/services/customSubjectApplication.js';
import { validateReportManualSection } from '../src/util/reportManualValues.js';

const context = { accountId: '000123', address: '100 Example Dr', city: 'Garland', postalCode: '75041', effectiveDate: '2026-08-31' };
function document(id = 1, values = {}, options = {}) {
  return { id, account_id: '000123', assignment_file_id: 4, document_type: 'engagement_letter',
    processing_status: 'review_required', upload_date: '2026-10-02', subject_context: context,
    candidates: Object.entries({ subject_street_address: '100 Example Dr', subject_city: 'Garland', ...values })
      .map(([field_key, value], index) => ({ id: id * 100 + index, document_id: id, field_key,
        raw_value: value, normalized_value: value, confirmed_value: value, review_status: 'confirmed' })), ...options };
}
function fullDocument() {
  return document(1, { subject_state: 'TX', subject_zip: '75041', borrower_name: 'Example Borrower',
    owner_name: 'Example Owner', county: 'Dallas', assessor_parcel_number: '000123', tax_year: '2025',
    tax_amount: '$4,321.50', neighborhood_name: 'Example Park', legal_description: 'EXAMPLE PARK\r\nBLK 1\tLOT 2',
    property_rights: 'leasehold', offered_for_sale_prior_12_months: 'false', pud: 'false',
    assignment_type: 'refinance', lender_client_name: 'Example Bank', lender_client_address: '20 Example Ave',
    hoa_dues_amount: '$120.49', hoa_frequency: 'per_year' });
}
const merge = (documents, rest = {}) => mergeCustomSubjectApplication({ projection: projectCustomSubjectDocuments(documents), ...rest });

test('every canonical Subject/assignment descriptor round-trips exact reviewed values', () => {
  const result = merge([fullDocument()], { actorUserId: 'appraiser-1', reviewer: 'Example Appraiser' });
  assert.equal(CUSTOM_SUBJECT_FIELD_DESCRIPTORS.length, 20);
  assert.deepEqual(result.subject.legal_description.lines, ['EXAMPLE PARK\r', 'BLK 1\tLOT 2']);
  assert.equal(readCustomSubjectValue(result, 'legal_description'), 'EXAMPLE PARK\r\nBLK 1\tLOT 2');
  assert.equal(result.subject.urar_subject.tax_amount, '4321.50');
  assert.equal(result.assignmentDetails.hoa_dues_amount, '120.49');
  assert.equal(result.assignmentDetails.pud, false);
  assert.equal(result.subject.urar_subject.offered_for_sale_prior_12_months, false);
  assert.deepEqual(result.assignmentDetails.assignment_types, ['refinance']);
  assert.deepEqual(result.subject.owner.parties, []);
  for (const definition of CUSTOM_SUBJECT_FIELD_DESCRIPTORS) {
    const receipt = result.evidence.fields[definition.key];
    assert.ok(receipt, definition.key);
    assert.deepEqual(receipt.value, readCustomSubjectValue(result, definition.key));
    assert.equal(receipt.status, 'current');
    assert.equal(receipt.actorUserId, 'appraiser-1');
  }
  assert.equal(result.evidence.fields.tax_amount.reviewedSourceValue, '$4,321.50');
  assert.equal(result.evidence.fields.tax_amount.sourceValue, undefined);
});

test('verified subject MLS derives listing with unchanged date proof and a separate reviewed source', () => {
  const result = merge([document(2, { list_date: '2026-04-01' }, { document_type: 'mls_sheet' })]);
  const receipt = result.evidence.fields.offered_for_sale_prior_12_months;
  assert.equal(receipt.value, true);
  assert.equal(receipt.kind, 'derived_reviewed_document');
  assert.equal(receipt.sourceValue, '2026-04-01');
  assert.equal(receipt.reviewedSourceValue, '2026-04-01');
  assert.equal(receipt.effectiveDate, '2026-08-31');
  assert.equal(receipt.effectiveDateSource, 'assignment_effective_date');
});

for (const role of ['unknown', 'comparable', 'unready']) {
  test(`${role} sources cannot populate Subject or assignment client/type`, () => {
    const source = fullDocument();
    if (role === 'unknown') source.candidates = source.candidates.filter(item => !['subject_street_address', 'subject_city', 'subject_zip', 'assessor_parcel_number'].includes(item.field_key));
    if (role === 'comparable') source.candidates.find(item => item.field_key === 'subject_street_address').confirmed_value = '900 Other St';
    if (role === 'unready') source.processing_status = 'processing';
    source.property_role = 'subject'; // A forged shortcut cannot bypass identity.
    const result = merge([source]);
    assert.deepEqual(result.subject, {});
    assert.deepEqual(result.assignmentDetails, {});
    assert.equal(Object.keys(result.evidence.fields).length, 0);
    assert.ok(result.warnings.length);
  });
}

test('all relevant documents participate: aliases and exact cents conflict, never last-wins', () => {
  const first = document(1, { tax_amount: '4321.49', owner_name: 'First Owner' });
  const second = document(2, { real_estate_tax_amount: '4321.40', record_owner_name: 'Second Owner' });
  for (const sources of [[first, second], [second, first]]) {
    const result = merge(sources);
    assert.equal(result.subject.urar_subject?.tax_amount, undefined);
    assert.equal(result.subject.owner, undefined);
    assert.ok(result.warnings.some(value => /conflicting/i.test(value)));
  }
});

test('initial manual values, multiple assignment choices, false PUD and owner parties are preserved', () => {
  const subject = { owner: { owner_name: '', parties: [{ name: 'Manual Party' }] }, urar_subject: { borrower_name: 'Manual Borrower' },
    legal_description: { lines: ['MANUAL LEGAL'] }, other_appraiser_notes: 'Keep me' };
  const assignmentDetails = { lender_client_name: 'Manual Bank', assignment_types: ['heloc', 'refinance'], pud: false };
  const result = merge([fullDocument()], { subject, assignmentDetails });
  assert.equal(result.subject.urar_subject.borrower_name, 'Manual Borrower');
  assert.deepEqual(result.subject.owner, subject.owner);
  assert.equal(result.subject.other_appraiser_notes, 'Keep me');
  assert.equal(result.assignmentDetails.lender_client_name, 'Manual Bank');
  assert.deepEqual(readCustomSubjectValue(result, 'assignment_type'), ['heloc', 'refinance']);
  assert.equal(result.evidence.fields.borrower_name, undefined);
  assert.equal(result.evidence.fields.pud, undefined);
  assert.ok(result.warnings.some(value => /existing appraiser value/.test(value)));
});

test('changed or deliberately cleared appraiser values survive subsequent reviews', () => {
  const applied = merge([fullDocument()]);
  applied.subject.urar_subject.borrower_name = 'Corrected Borrower';
  applied.subject.legal_description.lines = [];
  applied.assignmentDetails.assignment_types = [];
  const result = merge([fullDocument()], applied);
  assert.equal(result.subject.urar_subject.borrower_name, 'Corrected Borrower');
  assert.deepEqual(result.subject.legal_description.lines, []);
  assert.deepEqual(result.assignmentDetails.assignment_types, []);
  assert.equal(result.evidence.fields.borrower_name.value, 'Example Borrower');
});

test('explicit saved Subject blanks without receipts remain blank while missing fields still fill', () => {
  const subject = { property_location: { address: '', county: null }, owner: { owner_name: '' },
    legal_description: { lines: [] }, urar_subject: { borrower_name: '', tax_amount: null,
      property_rights: '', offered_for_sale_prior_12_months: null } };
  const result = merge([fullDocument()], { subject });
  for (const key of ['subject_street_address', 'county', 'owner_name', 'legal_description', 'borrower_name',
    'tax_amount', 'property_rights', 'offered_for_sale_prior_12_months']) {
    assert.deepEqual(readCustomSubjectValue(result, key), readCustomSubjectValue({ subject }, key), key);
    assert.equal(result.evidence.fields[key], undefined, key);
  }
  assert.equal(result.subject.property_location.city, 'Garland');
  assert.equal(result.subject.urar_subject.tax_year, '2025');
  assert.equal(result.subject.urar_subject.assessor_parcel_number, '000123');
});

test('initial assignment draft defaults do not block ordinary reviewed engagement population', () => {
  const result = merge([fullDocument()], { assignmentDetails: { assignment_types: [], lender_client_name: '',
    lender_client_address: null, hoa_dues_amount: '', hoa_frequency: '' } });
  assert.deepEqual(result.assignmentDetails.assignment_types, ['refinance']);
  assert.equal(result.assignmentDetails.lender_client_name, 'Example Bank');
  assert.equal(result.assignmentDetails.lender_client_address, '20 Example Ave');
  assert.equal(result.assignmentDetails.hoa_dues_amount, '120.49');
  assert.equal(result.evidence.fields.assignment_type.status, 'current');
});

test('saved owner parties take precedence after an appraiser edit without inventing names or falling back', () => {
  const applied = merge([fullDocument()]);
  applied.subject.owner.parties = [{ owner_name: ' First Appraiser Owner ' }, { name: 'Not an owner_name' },
    { owner_name: 123 }, null, { owner_name: '' }, { owner_name: 'Second Appraiser Owner' }];
  assert.equal(readCustomSubjectValue(applied, 'owner_name'), 'First Appraiser Owner / Second Appraiser Owner');
  const result = merge([fullDocument()], applied);
  assert.deepEqual(result.subject.owner.parties, applied.subject.owner.parties);
  assert.equal(readCustomSubjectValue(result, 'owner_name'), 'First Appraiser Owner / Second Appraiser Owner');
  assert.equal(result.evidence.fields.owner_name.value, 'Example Owner');
  for (const parties of [[{ owner_name: '' }, { owner_name: '  ' }, null], [{ name: 'Wrong member' }], null, {}, 'Not an array']) {
    assert.equal(readCustomSubjectValue({ subject: { owner: { owner_name: 'Stale Owner', parties } } }, 'owner_name'), '');
  }
  for (const owner of [{ owner_name: 'Saved Owner' }, { owner_name: 'Saved Owner', parties: [] }]) {
    assert.equal(readCustomSubjectValue({ subject: { owner } }, 'owner_name'), 'Saved Owner');
  }
});

test('explicit saved owner party clears without owner_name cannot be automatically refilled', () => {
  for (const parties of [[], [null, { owner_name: '' }], null, {}]) {
    const subject = { owner: { parties } };
    const result = merge([fullDocument()], { subject });
    assert.deepEqual(result.subject.owner, subject.owner);
    assert.equal(result.evidence.fields.owner_name, undefined);
  }
});

for (const change of ['rejected', 'conflicting', 'unavailable']) {
  test(`previous ${change} source retains saved value and receipt marked needs_review`, () => {
    const source = fullDocument(), applied = merge([source]);
    const documents = [source];
    if (change === 'rejected') source.candidates.find(item => item.field_key === 'tax_amount').review_status = 'rejected';
    if (change === 'conflicting') documents.push(document(2, { tax_amount: '1.00' }));
    if (change === 'unavailable') source.processing_status = 'processing';
    const result = merge(documents, applied);
    assert.equal(result.subject.urar_subject.tax_amount, '4321.50');
    assert.equal(result.evidence.fields.tax_amount.value, '4321.50');
    assert.equal(result.evidence.fields.tax_amount.status, 'needs_review');
    assert.equal(result.evidence.fields.tax_amount.documentId, 1);
  });
}

test('same-value save or unrelated document review cannot clear a stale receipt; source re-review can', () => {
  const applied = merge([fullDocument()]);
  applied.evidence.fields.tax_amount.status = 'needs_review';
  assert.equal(merge([fullDocument()], applied).evidence.fields.tax_amount.status, 'needs_review');
  assert.equal(merge([fullDocument()], { ...applied, reviewedDocumentId: 2 }).evidence.fields.tax_amount.status, 'needs_review');
  assert.equal(merge([fullDocument()], { ...applied, reviewedDocumentId: 1 }).evidence.fields.tax_amount.status, 'current');
});

test('fee-simple assumption remains stale without a review and is restored explicitly as a user default', () => {
  const source = document(), applied = merge([source]);
  applied.evidence.fields.property_rights.status = 'needs_review';
  assert.equal(merge([source], applied).evidence.fields.property_rights.status, 'needs_review');
  const reviewed = merge([source], { ...applied, reviewedDocumentId: 1 });
  assert.equal(reviewed.evidence.fields.property_rights.status, 'current');
  assert.equal(reviewed.evidence.fields.property_rights.kind, 'user_default');
  assert.equal(reviewed.evidence.fields.property_rights.documentId, null);
});

test('bounded projection fails closed instead of applying a truncated source set', () => {
  assert.throws(() => projectCustomSubjectDocuments(Array.from({ length: 51 }, (_, index) => document(index + 1))), /evidence_limit/);
  const source = document();
  source.candidates = Array.from({ length: 201 }, () => source.candidates[0]);
  assert.throws(() => projectCustomSubjectDocuments([source]), /evidence_limit/);
});

test('new manual Subject values are typed while existing extension fields remain compatible', () => {
  assert.equal(validateReportManualSection(CUSTOM_SUBJECT_SECTION, { county: 'Dallas', notes: 'Legacy extension',
    urar_subject: { tax_amount: '4321.50', tax_year: '2025', property_rights: 'fee_simple', offered_for_sale_prior_12_months: null } }), true);
  for (const value of [{ tax_amount: 123 }, { tax_year: '202X' }, { tax_amount: '1.234' }, { property_rights: 'guessed' },
    { offered_for_sale_prior_12_months: 'false' }, { source_provenance: { kind: 'reviewed_document' } }]) {
    assert.throws(() => validateReportManualSection(CUSTOM_SUBJECT_SECTION, { urar_subject: value }), /invalid_report_section_value/);
  }
  assert.throws(() => validateReportManualSection(CUSTOM_SUBJECT_EVIDENCE_SECTION, { version: 1, fields: {} }), /invalid_report_section_value/);
});

// Transaction fake models committed versus pending rows, so a failure after
// candidate/assignment/Subject writes proves the public confirmation rolls all
// of them back. No live database or private PDF data is used by these tests.
function database({ documents = [fullDocument()], assignmentDetails = {}, sections = {}, failHistory = null } = {}) {
  let committed = { documents: structuredClone(documents), assignment: { id: 4, account_id: '000123', file_number: 'SYNTHETIC-1',
    assignment_details: assignmentDetails, revision: 3, workfile_status: 'draft' }, sections: structuredClone(sections), history: [] };
  let pending;
  const calls = [];
  const client = { async query(sql, values = []) {
    calls.push({ sql, values });
    if (sql === 'BEGIN') { pending = structuredClone(committed); return { rows: [] }; }
    if (sql === 'ROLLBACK') { pending = null; return { rows: [] }; }
    if (sql === 'COMMIT') { committed = pending; pending = null; return { rows: [] }; }
    const state = pending || committed;
    if (/SELECT account_id, assignment_file_id/.test(sql)) return { rows: [state.documents.find(item => item.id === values[0])] };
    if (/SELECT id, file_number FROM app.assignment_files/.test(sql)) return { rows: [state.assignment] };
    if (/INSERT INTO app.custom_appraisal_workfiles/.test(sql)) return { rows: [] };
    if (/FOR UPDATE OF workfile/.test(sql)) return { rows: [{ status: 'draft', has_signed_snapshot: false }] };
    if (/SELECT \* FROM app.assignment_documents WHERE/.test(sql)) return { rows: [structuredClone(state.documents.find(item => item.id === values[0]))] };
    if (/SELECT \* FROM app.assignment_document_field_candidates/.test(sql)) return { rows: structuredClone(state.documents.find(item => item.id === values[0]).candidates) };
    if (/UPDATE app.assignment_document_field_candidates/.test(sql)) {
      const source = state.documents.find(item => item.id === values[0]);
      const candidate = source.candidates.find(item => item.id === values[1]);
      const single = /CASE WHEN/.test(sql);
      candidate.review_status = single ? values[2] : 'confirmed';
      candidate.confirmed_value = single ? (values[2] === 'confirmed' ? values[3] || candidate.raw_value : null) : values[2];
      return { rows: [structuredClone(candidate)] };
    }
    if (/INSERT INTO app.assignment_document_candidate_reviews/.test(sql)) { state.history.push(['candidate', ...values]); return { rows: [] }; }
    if (/SELECT COUNT/.test(sql)) return { rows: [{ count: state.documents.find(item => item.id === values[0]).candidates.filter(item => item.review_status === 'suggested').length }] };
    if (/FROM app.assignment_files assignment_file/.test(sql)) return { rows: [structuredClone(state.assignment)] };
    if (/FROM app.assignment_documents document/.test(sql)) return { rows: structuredClone(state.documents) };
    if (/FROM app.custom_appraisal_sections/.test(sql)) return { rows: Object.values(structuredClone(state.sections)) };
    if (/UPDATE app.assignment_files/.test(sql)) { state.assignment.assignment_details = JSON.parse(values[0]); state.assignment.revision = values[2]; return { rows: [] }; }
    if (/INSERT INTO app.assignment_file_history/.test(sql)) { state.history.push(['assignment', ...values]); return { rows: [] }; }
    if (/INSERT INTO app.custom_appraisal_sections/.test(sql)) {
      const row = { section_key: values[1], section_value: JSON.parse(values[2]), revision: (state.sections[values[1]]?.revision || 0) + 1, updated_at: '2026-10-02T00:00:00Z' };
      state.sections[values[1]] = row;
      return { rows: [structuredClone(row)] };
    }
    if (/INSERT INTO app.custom_appraisal_section_history/.test(sql)) {
      if (values[1] === failHistory) throw new Error('synthetic_history_failure');
      state.history.push(['section', ...values]); return { rows: [] };
    }
    if (/UPDATE app.assignment_documents/.test(sql)) { state.documents.find(item => item.id === values[0]).processing_status = 'reviewed'; return { rows: [] }; }
    throw new Error(`Unexpected SQL: ${sql}`);
  }, release() {} };
  return { client, calls, get state() { return structuredClone(committed); },
    pool: { query: async () => ({ rows: [] }), connect: async () => client } };
}

test('public confirmation atomically persists scoped report, assignment and receipts with revision history', async () => {
  const source = fullDocument();
  source.candidates.forEach(item => { item.review_status = 'suggested'; item.confirmed_value = null; });
  const db = database({ documents: [source] });
  const response = await confirmAssignmentDocumentCandidates(db.pool, { documentId: 1, reviewer: 'Example Appraiser', actorUserId: 'user-1' });
  const application = response.assignment_application;
  assert.equal(application.applied, true);
  assert.equal(application.account_id, '000123');
  assert.equal(application.assignment_file_id, 4);
  assert.equal(application.revision, 4);
  assert.equal(application.custom_appraisal_sections[CUSTOM_SUBJECT_SECTION].value.urar_subject.tax_amount, '4321.50');
  assert.equal(application.custom_appraisal_sections[CUSTOM_SUBJECT_EVIDENCE_SECTION].value.fields.tax_amount.actorUserId, 'user-1');
  assert.equal(db.state.history.filter(item => item[0] === 'section').length, 2);
  const position = pattern => db.calls.findIndex(item => pattern.test(item.sql));
  assert.ok(position(/SELECT id, file_number FROM app.assignment_files/) < position(/FOR UPDATE OF workfile/));
  assert.match(db.calls[position(/SELECT id, file_number FROM app.assignment_files/)].sql, /FOR UPDATE/);
  assert.ok(position(/FOR UPDATE OF workfile/) < position(/SELECT \* FROM app.assignment_documents WHERE/));
  assert.ok(position(/SELECT \* FROM app.assignment_documents WHERE/) < position(/FROM app.custom_appraisal_sections/));
  assert.equal(db.calls.some(item => /UPDATE core.accounts/.test(item.sql)), false);
});

for (const [reviewedValue, canonical] of [
  ['Bridge Loan', 'bridge_loan'], ['bridge-loan', 'bridge_loan'],
  ['New Construction', 'new_construction'], ['new-construction', 'new_construction'],
]) {
  test(`approving edited Other purpose ${reviewedValue} persists its supported canonical value`, async () => {
    const source = document(1, { assignment_type: 'refinance', lender_client_name: 'Example Bank' });
    const purpose = source.candidates.find(item => item.field_key === 'assignment_type');
    purpose.review_status = 'suggested'; purpose.confirmed_value = null;
    const db = database({ documents: [source] });
    const result = await confirmAssignmentDocumentCandidates(db.pool, { documentId: 1, reviewer: 'Example Appraiser',
      candidateValues: { [purpose.id]: reviewedValue } });
    assert.deepEqual(result.assignment_application.assignment_details.assignment_types, [canonical]);
    assert.deepEqual(db.state.assignment.assignment_details.assignment_types, [canonical]);
    assert.equal(db.state.documents[0].processing_status, 'reviewed');
    const receipt = result.assignment_application.custom_appraisal_sections[CUSTOM_SUBJECT_EVIDENCE_SECTION].value.fields.assignment_type;
    assert.equal(receipt.value, canonical);
    assert.equal(receipt.reviewedSourceValue, reviewedValue);
    assert.equal(receipt.candidateId, purpose.id);
    assert.equal(receipt.status, 'current');
    assert.ok(db.calls.some(item => item.sql === 'COMMIT'));
    assert.equal(db.calls.some(item => item.sql === 'ROLLBACK'), false);
  });
}

test('Other purpose normalization does not invent unsupported purposes or pick a conflicting source', () => {
  for (const value of ['Other', 'Bridge Finance', 'New Construction Maybe', 'New\tConstruction', '']) {
    const projected = projectCustomSubjectDocuments([document(1, { assignment_type: value })]);
    assert.equal(projected.fields.some(field => field.key === 'assignment_type'), false, value);
  }
  const equivalent = projectCustomSubjectDocuments([
    document(1, { assignment_type: 'Bridge Loan' }), document(2, { assignment_type: 'bridge-loan' }),
  ]);
  assert.equal(equivalent.fields.find(field => field.key === 'assignment_type')?.value, 'bridge_loan');
  assert.equal(equivalent.conflicts.length, 0);
  const conflicting = projectCustomSubjectDocuments([
    document(1, { assignment_type: 'Bridge Loan' }), document(2, { assignment_type: 'New Construction' }),
  ]);
  assert.equal(conflicting.fields.some(field => field.key === 'assignment_type'), false);
  assert.ok(conflicting.conflicts.some(conflict => conflict.sourceField === 'assignment_type'));
});

for (const failure of [CUSTOM_SUBJECT_SECTION, CUSTOM_SUBJECT_EVIDENCE_SECTION]) {
  test(`history failure for ${failure} rolls back candidate, assignment and all report writes`, async () => {
    const source = fullDocument();
    source.candidates.forEach(item => { item.review_status = 'suggested'; item.confirmed_value = null; });
    const db = database({ documents: [source], failHistory: failure });
    const before = db.state;
    await assert.rejects(confirmAssignmentDocumentCandidates(db.pool, { documentId: 1, reviewer: 'Example Appraiser' }), /synthetic_history_failure/);
    assert.deepEqual(db.state, before);
    assert.ok(db.calls.some(item => item.sql === 'ROLLBACK'));
    assert.equal(db.calls.some(item => item.sql === 'COMMIT'), false);
  });
}

test('single rejection preserves report value but invalidates its receipt in the same transaction', async () => {
  const source = fullDocument(), applied = merge([source]);
  const sections = Object.fromEntries([[CUSTOM_SUBJECT_SECTION, applied.subject], [CUSTOM_SUBJECT_EVIDENCE_SECTION, applied.evidence]]
    .map(([key, value]) => [key, { section_key: key, section_value: value, revision: 1 }]));
  const db = database({ documents: [source], assignmentDetails: applied.assignmentDetails, sections });
  const response = await reviewAssignmentDocumentCandidate(db.pool, { documentId: 1,
    candidateId: source.candidates.find(item => item.field_key === 'tax_amount').id, reviewStatus: 'rejected', reviewer: 'Example Appraiser' });
  const saved = response.assignment_application.custom_appraisal_sections;
  assert.equal(saved[CUSTOM_SUBJECT_SECTION].value.urar_subject.tax_amount, '4321.50');
  assert.equal(saved[CUSTOM_SUBJECT_EVIDENCE_SECTION].value.fields.tax_amount.status, 'needs_review');
  assert.equal(saved[CUSTOM_SUBJECT_SECTION].revision, 1);
  assert.equal(saved[CUSTOM_SUBJECT_EVIDENCE_SECTION].revision, 2);
});

test('stale processing source cannot promote old evidence through a new review', async () => {
  const source = fullDocument(); source.processing_status = 'processing';
  const db = database({ documents: [source] }), before = db.state;
  await assert.rejects(reviewAssignmentDocumentCandidate(db.pool, { documentId: 1,
    candidateId: source.candidates[0].id, reviewStatus: 'confirmed', reviewer: 'Example Appraiser' }), /document_not_processable/);
  assert.deepEqual(db.state, before);
});

test('contract-specific legacy values persist without overriding engagement/appraiser lender or purpose', async () => {
  const source = document(1, {}, { document_type: 'purchase_contract' });
  const db = database({ documents: [source], assignmentDetails: { assignment_types: ['refinance'], lender_client_name: 'Appraiser Bank' } });
  const result = await persistCustomSubjectApplication(db.client, { assignmentFile: db.state.assignment, sourceDocument: source,
    legacyAssignmentDetails: { assignment_types: ['refinance', 'purchase_transaction'], lender_client_name: 'Contract Bank',
      contract_price: '300000', subject_under_contract: true } });
  assert.deepEqual(result.assignment_details.assignment_types, ['refinance']);
  assert.equal(result.assignment_details.lender_client_name, 'Appraiser Bank');
  assert.equal(result.assignment_details.contract_price, '300000');
  assert.equal(result.assignment_details.subject_under_contract, true);
});

test('scoped read has bounded candidates, exact file/account and organization-qualified case dates', async () => {
  let query;
  await readCustomSubjectDocuments({ query: async (sql, values) => { query = { sql, values }; return { rows: [] }; } }, { accountId: '000123', assignmentFileId: 4 });
  assert.deepEqual(query.values, ['000123', 4]);
  assert.match(query.sql, /LIMIT 201/);
  assert.match(query.sql, /LIMIT 51/);
  assert.match(query.sql, /report_file.organization_id IS NOT DISTINCT FROM assignment.organization_id/);
  assert.match(query.sql, /appraisal_case.organization_id IS NOT DISTINCT FROM assignment.organization_id/);
  assert.match(query.sql, /document.uad_workfile_id IS NULL AND document.tax_protest_file_id IS NULL/);
  await assert.rejects(readCustomSubjectDocuments({ query: async () => ({ rows: [{ account_id: 'other', assignment_file_id: 4 }] }) },
    { accountId: '000123', assignmentFileId: 4 }), /document_scope_changed/);
});

test('persistence rejects signed and cross-scope sources before reading or writing sections', async () => {
  const client = { query() { throw new Error('unexpected_query'); } }, source = fullDocument();
  const assignment = { id: 4, account_id: '000123', workfile_status: 'draft' };
  await assert.rejects(persistCustomSubjectApplication(client, { assignmentFile: { ...assignment, workfile_status: 'signed' }, sourceDocument: source }), /workfile_signed/);
  await assert.rejects(persistCustomSubjectApplication(client, { assignmentFile: assignment, sourceDocument: { ...source, assignment_file_id: 5 } }), /scope_changed/);
  await assert.rejects(persistCustomSubjectApplication(client, { assignmentFile: assignment, sourceDocument: { ...source, uad_workfile_id: 'other' } }), /scope_changed/);
});
