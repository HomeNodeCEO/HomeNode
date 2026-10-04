import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCustomSubjectIdentity, customSubjectLenderPreset } from '../src/services/customSubjectIdentity.js';
import { projectCustomSubjectDocuments, mergeCustomSubjectApplication } from '../src/services/customSubjectApplication.js';

const context = { accountId: '000123', address: '100 EXAMPLE DR', city: 'Garland', postalCode: '75041',
  canonicalIdentity: { accountId: '000123', address: '100 EXAMPLE DR', city: 'GARLAND',
    postalCode: '75041-1234', county: 'DALLAS COUNTY', assessorParcelNumber: '000123' } };
const source = (values, extra = {}) => ({ id: 1, account_id: '000123', assignment_file_id: 4,
  document_type: 'engagement_letter', processing_status: 'review_required', subject_context: context,
  candidates: Object.entries({ subject_street_address: '100 Example Dr', subject_city: 'Garland', ...values })
    .map(([field_key, value], index) => ({ id: 100 + index, document_id: 1, field_key,
      normalized_value: value, raw_value: value, confirmed_value: value, review_status: 'confirmed' })), ...extra });

test('canonical account identity retains its primary county source without invented state', () => {
  const fields = buildCustomSubjectIdentity(context);
  assert.equal(fields.find(f => f.key === 'subject_street_address').value, '100 Example Dr');
  assert.equal(fields.find(f => f.key === 'county').value, 'Dallas');
  assert.equal(fields.find(f => f.key === 'subject_zip').value, '75041');
  assert.equal(fields.find(f => f.key === 'subject_state'), undefined);
  assert.ok(fields.every(f => f.provenance.kind === 'account_reference' && f.provenance.documentId === null));
  assert.equal(fields.find(f => f.key === 'subject_zip').provenance.sourceValue, '75041-1234');
  assert.deepEqual(buildCustomSubjectIdentity({ ...context, accountId: 'other' }), []);
  assert.deepEqual(buildCustomSubjectIdentity({ ...context, canonicalIdentity: undefined }), []);
});

test('canonical identity is not replaced by reviewed document identity and manual report edits survive', () => {
  const projection = projectCustomSubjectDocuments([source({ subject_zip: '75041', county: 'Dallas' })]);
  assert.equal(projection.fields.find(f => f.key === 'county').provenance.kind, 'account_reference');
  const saved = mergeCustomSubjectApplication({ projection,
    subject: { property_location: { address: '100 Example Dr Unit A' } }, reviewedDocumentId: 1 });
  assert.equal(saved.subject.property_location.address, '100 Example Dr Unit A');
  assert.equal(saved.subject.property_location.county, 'Dallas');
  const discrepancy = projectCustomSubjectDocuments([source({ county: 'Tarrant' })]);
  assert.equal(discrepancy.fields.find(f => f.key === 'county').value, 'Dallas');
  assert.ok(discrepancy.warnings.some(w => w.startsWith('County:')));
  assert.ok(!projection.warnings.some(w => w.startsWith('County:')));
});

test('UWM preset is tied to the reviewed lender and never represented as extracted PDF address', () => {
  const projection = projectCustomSubjectDocuments([source({ lender_client_name: 'United Wholesale Mortgage' })]);
  const address = projection.fields.find(f => f.key === 'lender_client_address');
  assert.equal(address.value, '585 S Blvd E, Pontiac, MI 48341');
  assert.equal(address.provenance.kind, 'user_default');
  assert.equal(address.provenance.rule, 'user_requested_lender_address_v1');
  assert.equal(address.provenance.sourceValue, 'United Wholesale Mortgage');
  assert.equal(address.provenance.sourceEvidence[0].sourceField, 'lender_client_name');
  const manual = mergeCustomSubjectApplication({ projection, assignmentDetails: { lender_client_address: 'Manual address' } });
  assert.equal(manual.assignmentDetails.lender_client_address, 'Manual address');
  assert.equal(customSubjectLenderPreset([{ key: 'lender_client_name', value: 'Other Bank', provenance: { kind: 'reviewed_document' } }]), null);
  assert.equal(customSubjectLenderPreset([{ key: 'lender_client_name', value: 'United Wholesale Mortgage', provenance: { kind: 'suggested' } }]), null);
  assert.equal(customSubjectLenderPreset([...projection.fields]), null);
});

test('explicit confirmation fills previously unfilled saved leaves but background refresh does not', () => {
  const projection = projectCustomSubjectDocuments([source({ borrower_name: 'Example Borrower', tax_amount: '16089' })]);
  const subject = { urar_subject: { borrower_name: '', tax_amount: null } };
  const background = mergeCustomSubjectApplication({ projection, subject });
  assert.equal(background.subject.urar_subject.borrower_name, '');
  const unrelated = mergeCustomSubjectApplication({ projection, subject, reviewedDocumentId: 2 });
  assert.equal(unrelated.subject.urar_subject.borrower_name, '');
  const confirmed = mergeCustomSubjectApplication({ projection, subject, reviewedDocumentId: 1 });
  assert.equal(confirmed.subject.urar_subject.borrower_name, 'Example Borrower');
  assert.equal(confirmed.subject.urar_subject.tax_amount, '16089.00');
  confirmed.subject.urar_subject.borrower_name = '';
  const deliberatelyCleared = mergeCustomSubjectApplication({ ...confirmed, projection, reviewedDocumentId: 1 });
  assert.equal(deliberatelyCleared.subject.urar_subject.borrower_name, '');
});
