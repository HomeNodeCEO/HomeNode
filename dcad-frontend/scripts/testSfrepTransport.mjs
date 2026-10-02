import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSfrepPreview, createSfrepTransport, SFREP_FORM_ID, sfrepDownloadFilename, sfrepNoticeText, sfrepProvenanceText, sfrepSubjectChecklist } from '../src/features/sfrep/sfrepTransport.ts';

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
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
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

test('invalid selection, absent digest and already-aborted calls do not issue a request', async () => {
  const h = harness();
  for (const documentIds of [[], [21, 21], [NaN], Array.from({ length: 11 }, (_, i) => i + 1)]) {
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

test('Subject checklist distinguishes coverage, defaults, missing narrative, and unsafe inferences', () => {
  const value = preview();
  value.fields.push(field('subject_city', 'City', 'Dallas'), field('hoa_dues', 'AssessmentAmount', '75'), feeSimple());
  value.assumptions = [assumption()];
  value.conflicts = [{ sourceField: 'lender_client_name', documentIds: [21], values: ['First bank', 'Second bank'] }];
  value.omitted = [{ sourceField: 'is_pud', documentId: 21, candidateId: null, reason: 'An unchecked PUD checkbox is not exported.' }];
  const rows = sfrepSubjectChecklist(checkSfrepPreview(value, [21]));
  const row = key => rows.find(item => item.key === key);
  assert.equal(rows.length, 17);
  assert.equal(row('city').status, 'included'); assert.deepEqual(row('city').values, ['Dallas']);
  assert.equal(row('property-rights').status, 'review'); assert.match(row('property-rights').statusLabel, /User default/);
  assert.equal(row('pud').status, 'review'); assert.deepEqual(row('pud').values, []);
  assert.match(row('pud').notes.join(' '), /HOA dues or membership do not establish PUD/);
  assert.equal(row('listing').status, 'missing'); assert.deepEqual(row('listing').values, []);
  assert.match(row('listing').notes.join(' '), /No MLS evidence is not a No/);
  assert.match(row('lender').statusLabel, /Review conflict/);
  assert.equal(row('borrower').status, 'missing'); assert.equal(row('owner').status, 'missing');
  const listing = sfrepSubjectChecklist(checkSfrepPreview(listingPreview(), [21])).find(item => item.key === 'listing');
  assert.equal(listing.status, 'review'); assert.deepEqual(listing.values, ['Yes']);
  assert.match(listing.notes.join(' '), /Complete the prior-listing data-source narrative/);
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
