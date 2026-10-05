import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCustomSubjectListingHistory } from '../src/services/customSubjectListingHistory.js';

const context = { effectiveDate: '2026-08-31', effectiveDateSource: 'assignment_effective_date', effectiveDateSourceDocumentId: null };
const history = (changes = [], extra = {}) => JSON.stringify({ schema_version: 1, listing_id: '77700001', list_date: '2026-05-29',
  coverage: 'complete', price_changes: changes, ...extra });
const candidate = (id, field_key, value, extra = {}) => ({ id, field_key, confirmed_value: value, review_status: 'confirmed', ...extra });
const document = (id, document_type, candidates, extra = {}) => ({ id, document_type, candidates, property_role: 'subject', processing_status: 'reviewed', ...extra });
const sources = (changes = []) => [
  document(1, 'mls_sheet', [candidate(11, 'mls_number', '77700001'), candidate(12, 'list_date', '2026-05-29'),
    candidate(13, 'original_list_price', '345000.00'), candidate(14, 'days_on_market', '77'), candidate(15, 'list_price', '345000')]),
  document(2, 'purchase_contract', [candidate(21, 'contract_date', '2026-08-25'), candidate(22, 'contract_price', '337500')]),
  document(3, 'mls_sheet', [candidate(31, 'listing_price_history', history(changes))]),
];
const change = (date, previous_price, new_price) => ({ date, previous_price, new_price, page_number: 1 });
const summarize = (documents = sources(), date = context) => buildCustomSubjectListingHistory(documents, date);
const omit = result => { assert.equal(result.field, undefined); assert.ok(result.warnings.length > 0); };

test('fixed user template uses MLS facts without copying the example DOM, status rows, or contract price', () => {
  const documents = sources();
  const before = structuredClone(documents);
  const result = summarize(documents);
  assert.equal(result.field.value, 'Subject was listed on 05/29/2026 for $345,000, no reductions in list price, on the market for 77 days, under current contract on 08/25/2026');
  assert.equal(result.field.key, 'listing_history_summary');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(documents, before);
  assert.equal(result.field.provenance.rule, 'reviewed_subject_listing_history_template_v1');
  assert.equal(result.field.provenance.effectiveDate, '2026-08-31');
  assert.equal(result.field.provenance.effectiveDateSource, 'assignment_effective_date');
  assert.deepEqual(result.field.provenance.sourceEvidence.map(item => item.candidateId), [11, 12, 13, 14, 21, 31]);
  assert.deepEqual(JSON.parse(result.field.sourceValue).sourceEvidence, result.field.provenance.sourceEvidence);
  assert.deepEqual(summarize([...documents].reverse()), result);
});

test('reduction template counts only reductions and uses the first and final price-change dates and final listing price', () => {
  const result = summarize(sources([change('2026-06-10', '345000', '340000'), change('2026-07-20', '340000', '335000')]));
  assert.equal(result.field.value, 'Subject was listed on 05/29/2026 for $345,000, the price was reduced 2 times between 06/10/2026 and 07/20/2026 to $335,000, on the market for 77 days, under current contract on 08/25/2026');
  const once = summarize(sources([change('2026-06-10', '345000', '340000.25')]));
  assert.match(once.field.value, /the price was reduced 1 times between 06\/10\/2026 and 06\/10\/2026 to \$340,000\.25,/);
});

test('same-effective-day changes use distinct validated printed timestamps, never JSON array order', () => {
  const early = { ...change('2026-06-10', '345000', '340000'), change_date: '2026-06-10', recorded_at: '2026-06-10T09:05' };
  const late = { ...change('2026-06-10', '340000', '335000'), change_date: '2026-06-10', recorded_at: '2026-06-10T14:30' };
  const result = summarize(sources([late, early]));
  assert.equal(result.field.value, 'Subject was listed on 05/29/2026 for $345,000, the price was reduced 2 times between 06/10/2026 and 06/10/2026 to $335,000, on the market for 77 days, under current contract on 08/25/2026');
  assert.equal(result.field.value, summarize(sources([early, late])).field.value);
  assert.equal(result.field.provenance.sourceEvidence.at(-1).value, history([late, early]));
  const recordedLater = { ...late, change_date: '2026-06-11', recorded_at: '2026-06-11T08:00' };
  assert.equal(summarize(sources([recordedLater, early])).field.value, result.field.value);
});

test('missing, tied, malformed, rolled-over, or contradictory change timestamps remain review-required', () => {
  const early = { ...change('2026-06-10', '345000', '340000'), change_date: '2026-06-10', recorded_at: '2026-06-10T09:05' };
  const late = { ...change('2026-06-10', '340000', '335000'), change_date: '2026-06-10', recorded_at: '2026-06-10T14:30' };
  omit(summarize(sources([early, change('2026-06-10', '340000', '335000')])));
  omit(summarize(sources([early, { ...late, recorded_at: early.recorded_at }])));
  for (const recorded_at of [null, 123, '', '2026-02-30T09:05', '2025-02-29T09:05', '2026-13-01T09:05',
    '2026-06-10T24:00', '2026-06-10T14:60', '2026-06-10T9:05', '2026-06-10T14:30Z', '2026-06-10T14:30:00']) {
    omit(summarize(sources([early, { ...late, recorded_at }])));
  }
  for (const change_date of ['2026-02-30', '2026-06-11', null, 'unknown']) {
    omit(summarize(sources([early, { ...late, change_date }])));
  }
});

test('distinct-date legacy histories remain compatible with equivalent timestamp-bearing histories', () => {
  const changes = [change('2026-06-10', '345000', '340000'), change('2026-07-20', '340000', '335000')];
  const documents = sources(changes);
  documents.push(document(4, 'mls_sheet', [candidate(41, 'listing_price_history', history(changes.map(row => ({
    ...row, change_date: row.date, recorded_at: `${row.date}T09:05`,
  }))))]));
  const result = summarize(documents);
  assert.equal(result.field.value, summarize(sources(changes)).field.value);
  assert.ok(result.field.provenance.sourceEvidence.some(entry => entry.documentId === 4));
});

test('post-contract and post-effective price events do not rewrite retrospective listing facts', () => {
  const before = change('2026-07-10', '345000', '340000');
  const after = change('2026-08-26', '340000', '325000');
  const later = change('2026-09-10', '325000', '320000');
  const result = summarize(sources([before, after, later]));
  assert.match(result.field.value, /reduced 1 times between 07\/10\/2026 and 07\/10\/2026 to \$340,000,/);
  assert.equal(result.field.provenance.sourceEvidence.at(-1).value, history([before, after, later]));
  const onlyFuture = summarize(sources([after, later]));
  assert.match(onlyFuture.field.value, /no reductions in list price/);
});

test('complete matched history is required; equal LP and OLP is never proof of no reductions', () => {
  const missing = sources().slice(0, 2);
  omit(summarize(missing));
  for (const extra of [{ coverage: 'partial' }, { listing_id: '99999999' }, { list_date: '2026-05-28' }]) {
    const documents = sources();
    documents[2].candidates[0].confirmed_value = history([], extra);
    omit(summarize(documents));
  }
});

test('only current individually confirmed subject evidence can contribute', () => {
  for (const index of [0, 1, 2]) {
    for (const extra of [{ processing_status: 'processing' }, { processing_status: 'extraction_failed' }, { property_role: 'comparable' }, { property_role: 'unknown' }]) {
      const documents = sources(); Object.assign(documents[index], extra);
      const result = summarize(documents);
      assert.equal(result.field, undefined);
    }
  }
  for (const index of [0, 1, 2]) {
    const documents = sources(); documents[index].candidates[0].review_status = 'suggested';
    omit(summarize(documents));
  }
  const crossDocument = sources(); crossDocument[1].candidates[0].document_id = 1;
  omit(summarize(crossDocument));
  const noCandidateId = sources(); delete noCandidateId[1].candidates[0].id;
  omit(summarize(noCandidateId));
  const wrongContractType = sources(); wrongContractType[1].document_type = 'engagement_letter';
  omit(summarize(wrongContractType));
});

test('dates, DOM, and monetary values are validated without fabrication or calendar arithmetic', () => {
  for (const [key, invalid] of [['list_date', '2026-02-30'], ['list_date', '2026-08-26'], ['original_list_price', ''],
    ['original_list_price', '-100'], ['original_list_price', 'unknown'], ['days_on_market', '77.5'], ['days_on_market', '-1']]) {
    const documents = sources(); documents[0].candidates.find(item => item.field_key === key).confirmed_value = invalid;
    omit(summarize(documents));
  }
  for (const effectiveDate of [null, '2026-02-30', '2026-08-24', 'yesterday']) omit(summarize(sources(), { effectiveDate }));
  const source = sources(); source[1].candidates[0].confirmed_value = '';
  source[1].candidates[0].normalized_value = '2026-08-25';
  omit(summarize(source));
  const zero = sources(); zero[0].candidates.find(item => item.field_key === 'days_on_market').confirmed_value = '0';
  assert.match(summarize(zero).field.value, /on the market for 0 days/);
});

test('equivalent MLS evidence is deterministic while duplicate base contracts require selection', () => {
  const documents = sources();
  documents.push(document(4, 'mls_sheet', [candidate(41, 'mls_number', '77700001'), candidate(42, 'list_date', '05/29/2026'),
    candidate(43, 'original_list_price', '$345,000'), candidate(44, 'days_on_market', '077')]));
  const result = summarize(documents);
  assert.ok(result.field);
  assert.deepEqual(result.field.provenance.sourceEvidence.map(item => item.candidateId), [11, 12, 13, 14, 21, 31, 41, 42, 43, 44]);
  assert.deepEqual(summarize([...documents].reverse()), result);
  documents.push(document(5, 'purchase_contract', [candidate(51, 'contract_date', '08/25/2026')]));
  omit(summarize(documents));
  documents.at(-1).candidates[0].confirmed_value = '2026-08-24';
  omit(summarize(documents));
});

test('conflicting MLS fields and conflicting reviewed histories do not pick arbitrary winners', () => {
  for (const [key, conflicting] of [['mls_number', '99999999'], ['list_date', '2026-06-01'], ['original_list_price', '350000'], ['days_on_market', '75']]) {
    const documents = sources(); documents[0].candidates.push(candidate(19, key, conflicting));
    omit(summarize(documents));
  }
  const documents = sources();
  documents.push(document(4, 'other', [candidate(41, 'listing_price_history', history([change('2026-07-01', '345000', '340000')]))]));
  omit(summarize(documents));
});

test('current listing is the most recent unambiguous listing before the subject contract', () => {
  const documents = sources();
  documents.push(document(4, 'mls_sheet', [candidate(41, 'mls_number', '11111111'), candidate(42, 'list_date', '2025-04-01'),
    candidate(43, 'original_list_price', '200000'), candidate(44, 'days_on_market', '40')]));
  const result = summarize(documents);
  assert.equal(result.field.value, summarize().field.value);
  assert.equal(result.field.provenance.sourceEvidence.some(entry => entry.documentId === 4), false);
  documents[3].candidates[1].confirmed_value = '2026-05-29';
  omit(summarize(documents));
});

test('incoherent chains, ambiguous dates and mixed increases never produce a misleading fixed template', () => {
  for (const changes of [
    [change('2026-05-20', '345000', '340000')],
    [change('2026-06-01', '350000', '340000')],
    [change('2026-06-01', '345000', '340000'), change('2026-07-01', '330000', '325000')],
    [change('2026-06-01', '345000', '340000'), change('2026-06-01', '340000', '335000')],
    [change('2026-06-01', '345000', '340000'), change('2026-07-01', '340000', '344000')],
  ]) omit(summarize(sources(changes)));
  for (const bad of ['{', history([], { schema_version: 99 }), history([], { price_changes: [{}] }), history([], { price_changes: 'none' })]) {
    const documents = sources(); documents[2].candidates[0].confirmed_value = bad;
    omit(summarize(documents));
  }
});

test('retrospective source changes are visible in the receipt even when the rendered sentence is unchanged', () => {
  const first = summarize();
  const documents = sources();
  documents[2].candidates[0].confirmed_value = history([change('2026-09-01', '345000', '340000')]);
  const next = summarize(documents);
  assert.equal(first.field.value, next.field.value);
  assert.notDeepEqual(first.field.provenance.sourceEvidence, next.field.provenance.sourceEvidence);
  const changedDate = summarize(sources(), { ...context, effectiveDate: '2026-09-01' });
  assert.equal(changedDate.field.value, first.field.value);
  assert.notEqual(changedDate.field.provenance.effectiveDate, first.field.provenance.effectiveDate);
});

test('unsupported input bounds fail safely without coercing arbitrary objects', () => {
  for (const input of [null, {}, Array(51).fill(sources()[0]), [null], [{ id: {}, candidates: [] }], [sources()[0], sources()[0]]]) omit(summarize(input));
  assert.deepEqual(summarize([]), { warnings: [] });
  const documents = sources(); documents[0].candidates = Array(201).fill(documents[0].candidates[0]);
  omit(summarize(documents));
});

function unknownHistorySources(propertyAddress = '100 Example Dr Garland', listingId = '77700001') {
  const documents = sources();
  documents[0].subject_context = { accountId: 'SYNTHETIC-ACCOUNT', address: '100 EXAMPLE DRIVE', city: 'Garland', postalCode: '75041', state: 'TX' };
  documents[0].candidates.push(candidate(16, 'subject_street_address', '100 Example Dr'), candidate(17, 'subject_city', 'Garland'),
    candidate(18, 'subject_state', 'TX'));
  documents[2].property_role = 'unknown';
  documents[2].candidates[0].confirmed_value = history([], { property_address: propertyAddress, listing_id: listingId });
  return documents;
}

test('reviewed unknown-role history may bind to a verified subject MLS only by both listing ID and exact street/city', () => {
  for (const address of ['100 Example Dr Garland', '100 EXAMPLE DRIVE GARLAND', '100 Example Drive, Garland', '100 Example Dr, Garland, TX 75041']) {
    const documents = unknownHistorySources(address), before = structuredClone(documents);
    const result = summarize(documents);
    assert.equal(result.field.value, summarize().field.value, address);
    assert.deepEqual(documents, before);
    assert.equal(documents[2].property_role, 'unknown');
    assert.equal(result.field.provenance.sourceEvidence.at(-1).value, history([], { property_address: address, listing_id: '77700001' }));
  }
});

test('a matching MLS number alone cannot bind another address, city, unit, state, missing header or conflicting role', () => {
  for (const address of ['102 Example Dr Garland', '100 Example Dr Dallas', '100 Example Dr Garland, OK 75041', '100 Example Dr Garland, TX 75042',
    '100 Example Dr Apt 2 Garland', '100 Example Dr', '100 Example Dr Garland Heights', '', '100 Example Dr\u0000 Garland']) {
    omit(summarize(unknownHistorySources(address)));
  }
  omit(summarize(unknownHistorySources('100 Example Dr Garland', '99999999')));
  for (const property_role of ['comparable', 'conflicting', null]) {
    const documents = unknownHistorySources(); documents[2].property_role = property_role;
    omit(summarize(documents));
  }
  const noCanonical = unknownHistorySources(); delete noCanonical[0].subject_context;
  omit(summarize(noCanonical));
  const wrongSource = unknownHistorySources(); wrongSource[0].property_role = 'unknown';
  assert.equal(summarize(wrongSource).field, undefined);
});

test('history binding never overrides conflicting individually reviewed identities or grants its other fields Subject authority', () => {
  for (const [field, value] of [['subject_street_address', '102 Example Dr'], ['subject_city', 'Dallas'], ['subject_zip', '75201'],
    ['assessor_parcel_number', '99999999999999999'], ['mls_number', '99999999']]) {
    const documents = unknownHistorySources(); documents[2].candidates.push(candidate(32, field, value));
    omit(summarize(documents));
  }
  const documents = unknownHistorySources();
  documents[2].candidates.push(candidate(32, 'borrower_name', 'Unrelated Person'));
  const result = summarize(documents);
  assert.ok(result.field);
  assert.equal(result.field.provenance.sourceEvidence.some(entry => entry.sourceField === 'borrower_name'), false);
  assert.equal(documents[2].property_role, 'unknown');
  documents[2].candidates[0].review_status = 'suggested';
  omit(summarize(documents));
});

test('same-listing history address disagreement blocks even when another reviewed history matches', () => {
  const documents = unknownHistorySources();
  documents.push(document(4, 'other', [candidate(41, 'listing_price_history', history([], { property_address: '102 Example Dr Garland' }))], { property_role: 'unknown' }));
  omit(summarize(documents));
  const subjectRoleConflict = unknownHistorySources('102 Example Dr Garland'); subjectRoleConflict[2].property_role = 'subject';
  omit(summarize(subjectRoleConflict));
});

test('unknown history cannot override conflicting subject MLS listing identities', () => {
  const documents = unknownHistorySources(); documents[0].candidates.push(candidate(19, 'mls_number', '99999999'));
  omit(summarize(documents));
  const unresolvedDates = unknownHistorySources();
  unresolvedDates.push(document(4, 'mls_sheet', [candidate(41, 'mls_number', '99999999'), candidate(42, 'list_date', '2026-05-29')],
    { subject_context: unresolvedDates[0].subject_context }));
  omit(summarize(unresolvedDates));
});
