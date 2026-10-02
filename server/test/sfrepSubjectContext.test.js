import assert from 'node:assert/strict';
import test from 'node:test';
import { sfrepDocumentPropertyRole, sfrepSubjectContext } from '../src/services/sfrepSubjectContext.js';

const context = () => ({ accountId: '00001234567890000', address: '100 Example Dr', city: 'Garland', postalCode: '75041', effectiveDate: null, inspectionDate: null });
const candidate = (field_key, confirmed_value, change = {}) => ({ document_id: 2, field_key, confirmed_value, review_status: 'confirmed', ...change });
const document = (candidates = [], change = {}) => ({ id: 2, processing_status: 'reviewed', subject_context: context(), candidates, ...change });

test('SFREP identity requires exact reviewed street and locality or exact parcel number', () => {
  assert.equal(sfrepDocumentPropertyRole(document([candidate('subject_property_address', '100 Example Drive, Garland, TX 75041')])), 'subject');
  assert.equal(sfrepDocumentPropertyRole(document([candidate('subject_street_address', '100 Example DR'), candidate('subject_city', 'Garland')])), 'subject');
  assert.equal(sfrepDocumentPropertyRole(document([candidate('assessor_parcel_number', '00001234567890000')])), 'subject');
  assert.equal(sfrepDocumentPropertyRole(document([candidate('subject_street_address', '100 Example DR')])), 'unknown');
  assert.equal(sfrepDocumentPropertyRole(document([candidate('subject_city', 'Garland')])), 'unknown');
  assert.equal(sfrepDocumentPropertyRole(document([candidate('subject_property_address', '100 Example Dr, Garland, TX 75041', { review_status: 'suggested' })])), 'unknown');
  assert.equal(sfrepDocumentPropertyRole(document([candidate('subject_property_address', '100 Example Dr, Garland, TX 75041', { document_id: 3 })])), 'unknown');
});

test('conflicting identity, units and comparable documents cannot populate the subject', () => {
  for (const address of ['102 Example Dr, Garland, TX 75041', '100 Example Dr #2, Garland, TX 75041', '100 Example Dr, Dallas, TX 75041', '100 Example Dr, Garland, TX 75201']) {
    assert.equal(sfrepDocumentPropertyRole(document([candidate('subject_property_address', address)])), 'comparable', address);
  }
  assert.equal(sfrepDocumentPropertyRole(document([candidate('assessor_parcel_number', '00001234567890000'), candidate('subject_property_address', '102 Example Dr, Garland, TX 75041')])), 'comparable');
  assert.equal(sfrepDocumentPropertyRole(document([candidate('subject_property_address', '100 Example Dr, Garland, TX 75041'), candidate('assessor_parcel_number', '99991234567890000')])), 'comparable');
  const condo = { ...context(), address: '100 Example Dr Building 1 Apt 2' };
  assert.equal(sfrepDocumentPropertyRole(document([candidate('subject_property_address', '100 Example Drive Bldg 1 Suite 2, Garland, TX 75041')], { subject_context: condo })), 'subject');
  assert.equal(sfrepDocumentPropertyRole(document([candidate('subject_property_address', '100 Example Drive Bldg 2 Suite 2, Garland, TX 75041')], { subject_context: condo })), 'comparable');
});

test('blank confirmations never revert to a machine suggestion for identity', () => {
  assert.equal(sfrepDocumentPropertyRole(document([candidate('subject_property_address', '', { normalized_value: '100 Example Dr, Garland, TX 75041' })])), 'unknown');
});

test('lossy secondary-identifier normalization cannot prove subject identity', () => {
  for (const [canonical, supplied] of [
    ['100 Example Dr Apt 1-2', '100 Example Dr Apt 12'],
    ['100 Example Dr Apt 12', '100 Example Dr Apt 1-2'],
    ['100 Example Dr Bldg A-1 Apt 2', '100 Example Dr Building A1 Unit 2'],
    ['100 Example Dr Bldg A1 Apt 2', '100 Example Dr Building A-1 Unit 2'],
    ['100 Example Dr Floor 12', '100 Example Dr Floor 1/2'],
  ]) {
    const record = document([candidate('subject_property_address', `${supplied}, Garland, TX 75041`)],
      { subject_context: { ...context(), address: canonical } });
    assert.equal(sfrepDocumentPropertyRole(record), 'unknown', `${canonical} / ${supplied}`);
    record.candidates.push(candidate('assessor_parcel_number', context().accountId));
    assert.equal(sfrepDocumentPropertyRole(record), 'unknown', 'APN must not bypass ambiguous unit identity');
  }
});

test('locality tails in street fields are validated instead of discarded', () => {
  const wrongCity = document([candidate('subject_street_address', '100 Example Dr, Dallas, TX 75041'), candidate('subject_city', 'Garland')]);
  assert.equal(sfrepDocumentPropertyRole(wrongCity), 'comparable');
  const wrongZip = document([candidate('subject_street_address', '100 Example Dr, Garland, TX 75201'), candidate('subject_city', 'Garland')]);
  assert.equal(sfrepDocumentPropertyRole(wrongZip), 'comparable');
  for (const address of ['100 Example Dr, Dallas', '100 Example Dr, unknown locality', '100 Example Dr, Garland TX']) {
    assert.equal(sfrepDocumentPropertyRole(document([candidate('subject_street_address', address), candidate('subject_city', 'Garland')])), 'unknown', address);
  }
  assert.equal(sfrepDocumentPropertyRole(document([candidate('subject_street_address', '100 Example Dr, Garland, TX 75041')])), 'subject');
});

test('comma-delimited secondary components are preserved alongside a valid locality', () => {
  const condoContext = { ...context(), address: '100 Example Dr Building A Floor 2 Apt 4' };
  const matching = document([candidate('subject_property_address', '100 Example Drive, Bldg A, Floor 2, Unit 4, Garland, TX 75041')], { subject_context: condoContext });
  assert.equal(sfrepDocumentPropertyRole(matching), 'subject');
  matching.candidates[0].confirmed_value = '100 Example Drive, Bldg A, Floor 2, Unit 5, Garland, TX 75041';
  assert.equal(sfrepDocumentPropertyRole(matching), 'comparable');
});

test('state assertions are checked when canonical state is supplied and contradictory states cannot be ignored', () => {
  const withState = { ...context(), state: 'TX' };
  for (const field of ['subject_property_address', 'subject_street_address']) {
    assert.equal(sfrepDocumentPropertyRole(document([candidate(field, '100 Example Dr, Garland, OK 75041')], { subject_context: withState })), 'comparable');
  }
  assert.equal(sfrepDocumentPropertyRole(document([candidate('subject_street_address', '100 Example Dr'), candidate('subject_city', 'Garland'), candidate('subject_state', 'OK')], { subject_context: withState })), 'comparable');
  assert.equal(sfrepDocumentPropertyRole(document([candidate('subject_property_address', '100 Example Dr, Garland, TX 75041'), candidate('subject_state', 'OK')])), 'unknown');
});

test('saved effective and inspection dates precede explicitly identified upload placeholder', () => {
  const record = document([], { property_role: 'subject', upload_date: '2026-10-02' });
  assert.deepEqual(sfrepSubjectContext([record]), { effectiveDate: '2026-10-02', effectiveDateSource: 'document_upload_date_placeholder', effectiveDateSourceDocumentId: 2, feeSimpleDefault: true });
  record.subject_context.inspectionDate = '2026-08-31';
  assert.equal(sfrepSubjectContext([record]).effectiveDateSource, 'inspection_date');
  assert.equal(sfrepSubjectContext([record]).effectiveDate, '2026-08-31');
  record.subject_context.effectiveDate = '2024-08-31';
  assert.equal(sfrepSubjectContext([record]).effectiveDateSource, 'assignment_effective_date');
  assert.equal(sfrepSubjectContext([record]).effectiveDate, '2024-08-31');
});

test('placeholder is stable for selection order and does not use a comparable upload', () => {
  const older = document([], { id: 1, property_role: 'subject', upload_date: '2026-09-30' });
  const newer = document([], { property_role: 'subject', upload_date: '2026-10-02' });
  const comp = document([], { id: 3, property_role: 'comparable', upload_date: '2026-01-01' });
  assert.deepEqual(sfrepSubjectContext([newer, comp, older]), sfrepSubjectContext([older, newer, comp]));
  assert.equal(sfrepSubjectContext([newer, comp, older]).effectiveDate, '2026-09-30');
  assert.equal(sfrepSubjectContext([comp]).effectiveDate, null);
  assert.equal(sfrepSubjectContext([]).effectiveDate, null);
});

test('only review-ready documents can establish a subject role from confirmed candidates', () => {
  for (const processing_status of ['uploaded', 'processing', 'ocr_required', 'extraction_failed', undefined, null, 'unknown']) {
    const record = document([candidate('subject_property_address', '100 Example Dr, Garland, TX 75041'),
      candidate('assessor_parcel_number', context().accountId)], { processing_status });
    assert.equal(sfrepDocumentPropertyRole(record), 'unknown', String(processing_status));
  }
  for (const processing_status of ['review_required', 'reviewed']) {
    assert.equal(sfrepDocumentPropertyRole(document([candidate('subject_property_address', '100 Example Dr, Garland, TX 75041')], { processing_status })), 'subject');
  }
});

test('stale-status documents never supply the upload placeholder even with a cached subject role', () => {
  const ready = document([], { id: 2, property_role: 'subject', upload_date: '2026-10-02' });
  for (const processing_status of ['uploaded', 'processing', 'ocr_required', 'extraction_failed', undefined, null]) {
    const stale = document([candidate('subject_property_address', '100 Example Dr, Garland, TX 75041', { document_id: 1 })],
      { id: 1, property_role: 'subject', processing_status, upload_date: '2024-01-01' });
    const result = sfrepSubjectContext([stale, ready]);
    assert.equal(result.effectiveDate, '2026-10-02', String(processing_status));
    assert.equal(result.effectiveDateSourceDocumentId, 2);
    assert.deepEqual(result, sfrepSubjectContext([ready, stale]));
    assert.equal(sfrepSubjectContext([stale]).effectiveDate, null);
  }
  const partiallyReviewed = document([], { id: 3, property_role: 'subject', processing_status: 'review_required', upload_date: '2026-09-30' });
  assert.equal(sfrepSubjectContext([ready, partiallyReviewed]).effectiveDateSourceDocumentId, 3);
});

test('saved assignment dates remain available without a review-ready upload fallback', () => {
  const record = document([], { processing_status: 'processing', property_role: 'subject', upload_date: '2024-01-01' });
  record.subject_context.inspectionDate = '2026-09-15';
  assert.equal(sfrepSubjectContext([record]).effectiveDate, '2026-09-15');
  assert.equal(sfrepSubjectContext([record]).effectiveDateSource, 'inspection_date');
  record.subject_context.effectiveDate = '2026-09-01';
  assert.equal(sfrepSubjectContext([record]).effectiveDate, '2026-09-01');
  assert.equal(sfrepSubjectContext([record]).effectiveDateSource, 'assignment_effective_date');
});
