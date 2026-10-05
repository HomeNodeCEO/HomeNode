import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import * as helpers from '../src/features/sfrep/sfrepTransport.ts';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';

const runtime = createRequire(new URL('../package.json', import.meta.url));
const file = new URL('../src/features/sfrep/SfrepExportDialog.tsx', import.meta.url);
const children = node => [node?.props?.children].flat(Infinity);
const walk = node => node && typeof node === 'object' ? [node, ...children(node).flatMap(walk)] : [];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : children(node).filter(child => child != null && typeof child !== 'boolean').map(text).join('');
const documents = [{ id: 21, title: 'Contract', file_name: 'contract.pdf', document_type: 'purchase_contract', processing_status: 'reviewed', file_size_bytes: 100 },
  { id: 22, title: 'Realist reference', file_name: 'realist.pdf', document_type: 'other', processing_status: 'review_required', file_size_bytes: 200 }];
const response = () => ({ ok: true, preview_digest: 'a'.repeat(64), formId: helpers.SFREP_FORM_ID, filename: 'HomeNode-test.rpti',
  fields: [{ sourceField: 'contract_price', fieldId: 'SalePriceAmount', value: '200000', documentId: 21, candidateId: 41, type: 'TextField',
    provenance: { kind: 'reviewed_document', sourceField: 'contract_price', documentId: 21, candidateId: 41, documentType: 'purchase_contract' } }],
  effectiveDateContext: { effectiveDate: null, source: null, sourceDocumentId: null, windowStart: null, windowEnd: null, calendarMonths: 12, isPlaceholder: false },
  assumptions: [], knownMissing: [],
  documents: [documents[0]], omitted: [{ sourceField: 'seller_name', documentId: 21, candidateId: 42, reason: 'No verified mapping' }],
  conflicts: [{ sourceField: 'lender_client_name', documentIds: [21, 22], values: ['First bank', 'Second bank'] }], warnings: ['Review imported fields.'] });

function harness(api = {}) {
  let cursor = 0, tree, opens = 0, closes = 0, restores = 0, clicks = 0, closeRequests = 0, urlCount = 0;
  const cells = [], effects = [], cleanups = [], calls = [], revoked = [], anchors = [], timers = new Map();
  class Element { isConnected = true; focus() { restores++; } }
  const document = { activeElement: new Element(), body: { appendChild() {} }, createElement() {
    const anchor = { click() { clicks++; api.click?.(); }, remove() { anchor.removed = true; } };
    anchors.push(anchor); return anchor;
  } };
  const react = {
    useRef(value) { const i = cursor++; return cells[i] ??= { current: value }; },
    useState(initial) { const i = cursor++; cells[i] ??= { value: initial }; return [cells[i].value, next => { cells[i].value = typeof next === 'function' ? next(cells[i].value) : next; }]; },
    useEffect(fn) { const i = cursor++; if (!cells[i]) { cells[i] = true; effects.push(fn); } },
  };
  const transport = {
    async preview(...args) { calls.push(['preview', ...args]); return api.preview ? api.preview(...args) : response(); },
    async export(...args) { calls.push(['export', ...args]); return api.export ? api.export(...args) : new Blob(['rpti']); },
  };
  const component = loadTrustedRepositoryCommonJs(file, key => {
    if (key === 'react') return react;
    if (key === 'react/jsx-runtime') return runtime(key);
    if (key === './sfrepApi') return { sfrepApi: transport };
    assert.equal(key, './sfrepTransport'); return helpers;
  }, { environment: { document, HTMLElement: Element,
    URL: { createObjectURL: () => ++urlCount === 1 ? 'blob:test' : `blob:test-${urlCount}`, revokeObjectURL: value => revoked.push(value) },
    window: { setTimeout(fn) { const id = timers.size + 1; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); } } } });
  const props = { accountId: 'R1', assignmentFileId: 12, documents, getEditorKey: () => 'editor', onClose: () => { closeRequests++; } };
  const render = () => {
    cursor = 0; tree = component.default(props);
    tree.props.ref.current = { showModal() { opens++; }, close() { closes++; } };
    effects.splice(0).forEach(fn => cleanups.push(fn()));
  };
  const button = label => walk(tree).find(node => node.type === 'button' && text(node) === label);
  const link = label => walk(tree).find(node => node.type === 'a' && text(node) === label);
  const checkbox = label => walk(tree).filter(node => node.type === 'label').find(node => text(node).includes(label)
    && node?.props.children.flat(Infinity).some(child => child?.type === 'input' && child.props.type === 'checkbox'))
    ?.props.children.flat(Infinity).find(node => node?.type === 'input' && node.props.type === 'checkbox');
  return { props, calls, revoked, anchors, timers, render, get tree() { return tree; }, get text() { return text(tree); }, get urlCount() { return urlCount; },
    get opens() { return opens; }, get closes() { return closes; }, get restores() { return restores; }, get clicks() { return clicks; }, get closeRequests() { return closeRequests; },
    button, link, checkbox,
    click(label) { const node = button(label); assert.ok(node, label); node.props.onClick(); render(); },
    check(label, checked) { const node = checkbox(label); assert.ok(node, label); node.props.onChange({ target: { checked } }); render(); },
    async drain() { for (let i = 0; i < 10; i++) await Promise.resolve(); render(); },
    close() { cleanups.splice(0).forEach(fn => fn?.()); } };
}

test('opens accessible native modal with explicit empty selection; Escape and unmount restore focus', () => {
  const h = harness(); h.render(); h.render();
  assert.equal(h.opens, 1); assert.equal(h.calls.length, 0);
  assert.equal(h.checkbox('Contract').props.checked, false); assert.equal(h.checkbox('Include original').props.checked, true);
  assert.equal(h.button('Preview SFREP export').props.disabled, false); assert.equal(h.button('Download SFREP .rpti'), undefined);
  assert.match(h.text, /Report form.*1004 URAR.*2055 Exterior Only — coming next/);
  assert.match(h.text, /1004 URAR export maps the Subject and Contract sections/);
  assert.match(h.text, /These checkboxes only choose which original PDFs/);
  const formChoices = walk(h.tree).filter(node => node.type === 'input' && node.props.type === 'radio');
  assert.equal(formChoices.length, 2);
  assert.equal(formChoices[0].props.checked, true);
  assert.equal(formChoices[1].props.disabled, true);
  assert.match(h.text, /does not support UAD 3.6/); assert.match(h.text, /Other Appraisal Document/);
  assert.match(h.tree.props.className, /border-amber-300/);
  let prevented = false; h.tree.props.onCancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(h.closeRequests, 1);
  h.close(); assert.equal(h.closes, 1); assert.equal(h.restores, 1);
});

test('preview can run without attaching any source PDFs', async () => {
  const h = harness(); h.render(); h.click('Preview SFREP export'); await h.drain();
  assert.deepEqual(h.calls[0][1].documentIds, []);
  assert.match(h.text, /Supported, reviewed evidence from this HomeNode workfile fills the form/);
  h.close();
});

test('report export waits for the active file document list', () => {
  const h = harness(); h.props.documentsLoading = true; h.render();
  assert.match(h.text, /Loading this file’s documents/);
  assert.equal(h.button('Preview SFREP export').props.disabled, true);
  h.close();
});

test('document load failure is actionable and is not presented as an empty workfile', () => {
  const h = harness(); let retries = 0;
  h.props.documents = []; h.props.documentLoadError = 'Temporary document service failure';
  h.props.onRetryDocuments = () => { retries++; };
  h.render();
  assert.match(h.text, /Documents could not be loaded: Temporary document service failure/);
  assert.doesNotMatch(h.text, /No source documents are available/);
  assert.equal(h.button('Preview SFREP export').props.disabled, true);
  h.click('Retry loading documents'); assert.equal(retries, 1);
  h.close();
});

test('preview shows fields and exclusions; only explicit download sends the reviewed digest', async () => {
  const h = harness(); h.render(); h.check('Contract', true); h.click('Preview SFREP export'); await h.drain();
  assert.match(h.text, /Attaching its PDF is optional/);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], 'preview');
  assert.deepEqual(h.calls[0][1], { accountId: 'R1', assignmentFileId: 12, documentIds: [21],
    includeDocuments: true, includeDiscrepancyAddendum: false });
  assert.equal(h.calls[0][2].editorKey, 'editor');
  for (const expected of ['SalePriceAmount', '200000', 'No verified mapping', 'First bank / Second bank', 'Review imported fields.']) assert.ok(h.text.includes(expected));
  const diagnostics = walk(h.tree).filter(node => node.type === 'details');
  assert.equal(diagnostics.find(node => text(node).startsWith('Omitted fields')).props.open, false);
  assert.equal(diagnostics.find(node => text(node).startsWith('Warnings')).props.open, false);
  assert.equal(diagnostics.find(node => text(node).startsWith('Conflicting fields')).props.open, true);
  assert.match(h.text, /original PDFs as report addenda/); assert.doesNotMatch(h.text, /Candidate 41/);
  assert.equal(h.button('Download SFREP .rpti').props.disabled, false);
  h.click('Download SFREP .rpti'); await h.drain();
  assert.equal(h.calls[1][0], 'export'); assert.equal(h.calls[1][2], 'a'.repeat(64));
  assert.equal(h.clicks, 1); assert.match(h.text, /RPTI prepared/); assert.doesNotMatch(h.text, /Download started/);
  assert.equal(h.link('Save prepared RPTI').props.href, 'blob:test');
  assert.equal(h.link('Save prepared RPTI').props.download, 'HomeNode-test.rpti');
  assert.equal(h.link('Save prepared RPTI').props.onClick, undefined, 'direct browser save needs no new API request');
  assert.match(h.text, /Keep this dialog open until you have saved the file/);
  h.close(); assert.deepEqual(h.revoked, ['blob:test']);
});

test('prepared links retain only the latest blob URL until replacement or modal close', async () => {
  const h = harness(); h.render(); h.check('Contract', true); h.click('Preview SFREP export'); await h.drain();
  h.click('Download SFREP .rpti'); await h.drain();
  assert.equal(h.clicks, 1); assert.deepEqual(h.revoked, [], 'do not revoke before the browser can acquire the download');
  h.render(); h.render();
  assert.equal(h.link('Save prepared RPTI').props.href, 'blob:test', 'rerenders keep the direct save link usable');
  h.click('Download SFREP .rpti'); await h.drain();
  assert.equal(h.clicks, 2); assert.deepEqual(h.revoked, ['blob:test']);
  assert.equal(h.link('Save prepared RPTI').props.href, 'blob:test-2');
  h.close(); assert.deepEqual(h.revoked, ['blob:test', 'blob:test-2']);
  h.close(); assert.deepEqual(h.revoked, ['blob:test', 'blob:test-2']);
});

test('a failed repeat download revokes and removes the previous prepared link', async () => {
  let attempts = 0;
  const h = harness({ export: async () => { if (++attempts > 1) throw new Error('Export unavailable'); return new Blob(['rpti']); } });
  h.render(); h.check('Contract', true); h.click('Preview SFREP export'); await h.drain();
  h.click('Download SFREP .rpti'); await h.drain();
  h.click('Download SFREP .rpti'); await h.drain();
  assert.equal(h.clicks, 1); assert.deepEqual(h.revoked, ['blob:test']); assert.match(h.text, /Export unavailable/);
  assert.equal(h.urlCount, 1); assert.equal(h.link('Save prepared RPTI'), undefined); assert.doesNotMatch(h.text, /RPTI prepared/);
  h.close(); assert.deepEqual(h.revoked, ['blob:test']);
});

test('automatic click failure leaves the sanitized direct save link available', async () => {
  const h = harness({ preview: async () => ({ ...response(), filename: '../unsafe\\Sample:<QA>?\u0001.rpti' }),
    click() { throw new Error('Automatic download blocked'); } });
  h.render(); h.check('Contract', true); h.click('Preview SFREP export'); await h.drain();
  h.click('Download SFREP .rpti'); await h.drain();
  const link = h.link('Save prepared RPTI');
  assert.equal(link.props.href, 'blob:test'); assert.equal(link.props.download, 'Sample__QA___.rpti');
  assert.equal(h.anchors[0].href, link.props.href); assert.equal(h.anchors[0].download, link.props.download);
  assert.equal(h.anchors[0].removed, true); assert.deepEqual(h.revoked, []);
  assert.match(h.text, /RPTI prepared/); assert.doesNotMatch(h.text, /Download started|Automatic download blocked/);
  assert.equal(h.button('Download SFREP .rpti').props.disabled, false);
  h.close(); assert.deepEqual(h.revoked, ['blob:test']);
});

for (const [label, checked] of [['Contract', false], ['Realist reference', true], ['Include original', false],
  ['Include one combined evidence-discrepancy addendum', true]]) {
  test(`${label} change revokes the prepared URL and requires a fresh preview`, async () => {
    const h = harness(); h.render(); h.check('Contract', true); h.click('Preview SFREP export'); await h.drain();
    h.click('Download SFREP .rpti'); await h.drain();
    h.check(label, checked);
    assert.deepEqual(h.revoked, ['blob:test']); assert.equal(h.link('Save prepared RPTI'), undefined);
    assert.equal(h.button('Download SFREP .rpti'), undefined); assert.doesNotMatch(h.text, /RPTI prepared/);
    h.close(); assert.deepEqual(h.revoked, ['blob:test']);
  });
}

for (const operation of ['preview', 'export']) {
  test(`starting a new ${operation} removes the previous link before its response arrives`, async () => {
    let attempts = 0, resolve;
    const next = operation === 'preview' ? response : () => new Blob(['rpti']);
    const h = harness({ [operation]: () => ++attempts === 1 ? next() : new Promise(done => { resolve = done; }) });
    h.render(); h.check('Contract', true); h.click('Preview SFREP export'); await h.drain();
    h.click('Download SFREP .rpti'); await h.drain();
    h.click(operation === 'preview' ? 'Preview SFREP export' : 'Download SFREP .rpti');
    assert.deepEqual(h.revoked, ['blob:test']); assert.equal(h.link('Save prepared RPTI'), undefined);
    assert.doesNotMatch(h.text, /RPTI prepared/);
    resolve(next()); await h.drain();
    if (operation === 'preview') assert.equal(h.link('Save prepared RPTI'), undefined);
    else assert.equal(h.link('Save prepared RPTI').props.href, 'blob:test-2');
    h.close();
  });
}

test('a failed refresh cannot restore the previous prepared package or preview', async () => {
  let attempts = 0;
  const h = harness({ preview: async () => { if (++attempts > 1) throw new Error('Preview unavailable'); return response(); } });
  h.render(); h.check('Contract', true); h.click('Preview SFREP export'); await h.drain();
  h.click('Download SFREP .rpti'); await h.drain();
  h.click('Preview SFREP export'); await h.drain();
  assert.match(h.text, /Preview unavailable/); assert.equal(h.link('Save prepared RPTI'), undefined);
  assert.equal(h.button('Download SFREP .rpti'), undefined); assert.deepEqual(h.revoked, ['blob:test']);
  h.close();
});

test('Subject checklist exposes gaps and rerun guidance without claiming a completed report', async () => {
  const h = harness(); h.render(); h.check('Contract', true); h.click('Preview SFREP export'); await h.drain();
  const checklist = walk(h.tree).find(node => node.props?.['aria-label'] === '1004 Subject export checklist');
  const rows = walk(checklist).filter(node => node.type === 'tr');
  assert.equal(rows.length, 20); // Header plus all 19 Subject items.
  for (const expected of ['Street address', 'City', 'State', 'ZIP code', 'Borrower', 'Public-record owner', 'County',
    'Assessor parcel number', 'Tax year', 'Real estate taxes', 'Neighborhood', 'PUD status', 'Property rights / fee simple',
    'Assignment type', 'Lender / client', 'Lender / client address', 'Offered for sale in prior 12 months', 'Census tract', 'Listing history']) assert.ok(text(checklist).includes(expected), expected);
  assert.match(text(checklist), /Missing — not exported/); assert.match(text(checklist), /Review conflict/);
  assert.match(h.text, /Effective date unavailable — review needed/);
  assert.match(h.text, /not a completed appraisal/); assert.match(h.text, /existing SFREP values may remain/);
  assert.match(h.text, /HOA dues or membership do not establish PUD eligibility/);
  assert.match(h.text, /No MLS evidence is not a No answer/);
  assert.match(h.text, /For documents uploaded before this update, use Re-run extraction and review the new suggestions\./);
  assert.match(h.text, /Reviewed document evidence/);
  const mapped = walk(h.tree).find(node => node.type === 'details' && text(node).startsWith('Mapped fields and provenance'));
  assert.notEqual(mapped.props.open, true); h.close();
});

test('placeholder dates, fee-simple defaults, and derived listing provenance are explicit in the preview', async () => {
  const result = response(); result.conflicts = []; result.omitted = [];
  result.effectiveDateContext = { effectiveDate: '2026-10-01', source: 'document_upload_date_placeholder', sourceDocumentId: 21,
    windowStart: '2025-10-01', windowEnd: '2026-10-01', calendarMonths: 12, isPlaceholder: true };
  result.fields.push({ sourceField: 'property_rights', fieldId: 'PropertyRightsAppraisedFeeSimpleCheckBox', value: 'true',
    documentId: null, candidateId: null, type: 'CheckBoxField', provenance: { kind: 'user_default', sourceField: 'property_rights',
      documentId: null, candidateId: null, rule: 'user_requested_fee_simple_default' } },
  { sourceField: 'list_date', fieldId: 'CurrentPriorListingYesCheckBox', value: 'true', type: 'CheckBoxField', documentId: 21, candidateId: 42,
    provenance: { kind: 'derived_reviewed_document', sourceField: 'list_date', documentId: 21, candidateId: 42, documentType: 'mls_sheet',
      rule: 'subject_mls_list_date_within_preceding_12_calendar_months', sourceValue: '2026-09-15', effectiveDate: '2026-10-01',
      effectiveDateSource: 'document_upload_date_placeholder', effectiveDateSourceDocumentId: 21, windowStart: '2025-10-01', windowEnd: '2026-10-01' } });
  result.assumptions = [{ fieldId: 'PropertyRightsAppraisedFeeSimpleCheckBox', value: 'true', rule: 'user_requested_fee_simple_default', reason: 'User-requested fee simple default; confirm property rights.' }];
  result.knownMissing = [{ fieldId: 'CurrentPriorListingDataSources', reason: 'Complete the prior-listing data-source narrative in SFREP.' }];
  const h = harness({ preview: async () => helpers.checkSfrepPreview(result, [21]) });
  h.render(); h.check('Contract', true); h.click('Preview SFREP export'); await h.drain();
  assert.match(h.text, /Placeholder effective date — review required: 2026-10-01/);
  assert.match(h.text, /document upload date \(UTC\), not a confirmed inspection or appraisal effective date/);
  assert.match(h.text, /Date source: Contract/);
  assert.match(h.text, /Prior 12-calendar-month window: 2025-10-01 through 2026-10-01/);
  const assumptions = walk(h.tree).find(node => node.props?.['aria-label'] === 'Assumptions requiring confirmation');
  assert.equal(assumptions, undefined);
  assert.doesNotMatch(h.text, /confirm property rights|User default — confirm/);
  assert.match(h.text, /Included — user default/); assert.match(h.text, /No source document \(user default\)/);
  assert.match(h.text, /not document evidence/); assert.match(h.text, /Derived — review/);
  assert.match(h.text, /Derived from reviewed MLS listing date 2026-09-15/);
  assert.match(h.text, /Complete the prior-listing data-source narrative in SFREP/);
  assert.equal(h.button('Download SFREP .rpti').props.disabled, false); h.close();
});

test('formatted money and legal fields show the export value, original source, and rule as separate review text', async () => {
  const result = response(); result.conflicts = []; result.omitted = [];
  result.fields = [
    ['tax_amount', 'RealEstateTaxAmount', '$1,234.50', '1235', 'uad_whole_dollars_half_up'],
    ['hoa_dues_amount', 'AssessmentAmount', '75.49', '75', 'uad_whole_dollars_half_up'],
    ['legal_description', 'LegalDescription', 'EXAMPLE PARK\nBLK 7\tLOT 9', 'EXAMPLE PARK BLK 7 LOT 9', 'single_line_legal_description'],
  ].map(([sourceField, fieldId, sourceValue, value, formattingRule], index) => ({
    sourceField, fieldId, sourceValue, value, formattingRule, documentId: 21, candidateId: 41 + index, type: 'TextField',
    provenance: { kind: 'reviewed_document', sourceField, documentId: 21, candidateId: 41 + index, documentType: 'other' },
  }));
  const h = harness({ preview: async () => helpers.checkSfrepPreview(result, [21]) });
  h.render(); h.check('Contract', true); h.click('Preview SFREP export'); await h.drain();
  const checklist = walk(h.tree).find(node => node.props?.['aria-label'] === '1004 Subject export checklist');
  assert.match(text(checklist), /Formatted — review/);
  assert.match(text(checklist), /Original reviewed value: "\$1,234\.50"/);
  assert.match(text(checklist), /whole dollars, half up/);
  const mapped = walk(h.tree).find(node => node.type === 'details' && text(node).startsWith('Mapped fields and provenance'));
  for (const item of result.fields) {
    const row = walk(mapped).find(node => node.type === 'tr' && text(node).includes(item.fieldId));
    const cells = walk(row).filter(node => node.type === 'td');
    assert.equal(text(cells[0]), item.value);
    assert.ok(text(cells[1]).includes(JSON.stringify(item.sourceValue)));
    assert.match(text(cells[1]), /Source evidence is unchanged/);
  }
  assert.match(text(mapped), /line breaks and tabs replaced by spaces/);
  assert.equal(h.button('Download SFREP .rpti').props.disabled, false); h.close();
});

test('a formatted value inconsistent with the reviewed source never becomes a downloadable preview', async () => {
  const result = response(); result.conflicts = []; result.omitted = [];
  result.fields = [{ sourceField: 'tax_amount', fieldId: 'RealEstateTaxAmount', value: '1234', sourceValue: '1234.50',
    formattingRule: 'uad_whole_dollars_half_up', documentId: 21, candidateId: 41, type: 'TextField',
    provenance: { kind: 'reviewed_document', sourceField: 'tax_amount', documentId: 21, candidateId: 41, documentType: 'other' } }];
  const h = harness({ preview: async () => helpers.checkSfrepPreview(result, [21]) });
  h.render(); h.check('Contract', true); h.click('Preview SFREP export'); await h.drain();
  assert.match(h.text, /preview response is invalid/);
  assert.equal(h.button('Download SFREP .rpti'), undefined); assert.equal(h.clicks, 0); h.close();
});

test('selection and original-PDF choices invalidate previews before another download', async () => {
  const h = harness(); h.render(); h.check('Contract', true); h.click('Preview SFREP export'); await h.drain();
  h.check('Realist reference', true); assert.equal(h.button('Download SFREP .rpti'), undefined);
  h.click('Preview SFREP export'); await h.drain();
  h.check('Include original', false); assert.equal(h.button('Download SFREP .rpti'), undefined);
  h.click('Preview SFREP export'); await h.drain();
  assert.equal(h.calls.at(-1)[1].includeDocuments, false); assert.match(h.text, /0 original PDF/); h.close();
});

test('duplicate requests are blocked synchronously; unmount aborts and late success cannot download', async () => {
  let resolve;
  const h = harness({ export: () => new Promise(r => { resolve = r; }) });
  h.render(); h.check('Contract', true); h.click('Preview SFREP export'); await h.drain();
  const download = h.button('Download SFREP .rpti'); download.props.onClick(); download.props.onClick(); h.render();
  assert.equal(h.calls.filter(call => call[0] === 'export').length, 1);
  h.check('Realist reference', true); assert.equal(h.checkbox('Realist reference').props.checked, false);
  const signal = h.calls.at(-1)[3].signal; h.close(); assert.equal(signal.aborted, true);
  resolve(new Blob(['late'])); await h.drain(); assert.equal(h.clicks, 0);
  assert.equal(h.urlCount, 0); assert.equal(h.link('Save prepared RPTI'), undefined);
});

for (const operation of ['preview', 'export']) {
  test(`a late ${operation} rejection after close cannot revive a prepared link or error`, async () => {
    let attempts = 0, reject;
    const next = operation === 'preview' ? response : () => new Blob(['rpti']);
    const h = harness({ [operation]: () => ++attempts === 1 ? next() : new Promise((_done, fail) => { reject = fail; }) });
    h.render(); h.check('Contract', true); h.click('Preview SFREP export'); await h.drain();
    h.click('Download SFREP .rpti'); await h.drain();
    h.click(operation === 'preview' ? 'Preview SFREP export' : 'Download SFREP .rpti');
    h.close(); reject(new Error('Late rejection')); await h.drain();
    assert.equal(h.link('Save prepared RPTI'), undefined); assert.doesNotMatch(h.text, /RPTI prepared|Late rejection/);
    assert.deepEqual(h.revoked, ['blob:test']); assert.equal(h.urlCount, 1);
  });
}

test('a late preview success after close cannot publish obsolete download controls', async () => {
  let resolve;
  const h = harness({ preview: () => new Promise(done => { resolve = done; }) });
  h.render(); h.check('Contract', true); h.click('Preview SFREP export');
  h.close(); resolve(response()); await h.drain();
  assert.equal(h.button('Download SFREP .rpti'), undefined); assert.equal(h.link('Save prepared RPTI'), undefined);
  assert.equal(h.urlCount, 0);
});

test('a timed-out export that ignores abort cannot publish a late prepared package', async () => {
  let resolve;
  const h = harness({ export: () => new Promise(done => { resolve = done; }) });
  h.render(); h.check('Contract', true); h.click('Preview SFREP export'); await h.drain();
  h.click('Download SFREP .rpti');
  for (const timeout of h.timers.values()) timeout();
  resolve(new Blob(['late'])); await h.drain();
  assert.equal(h.link('Save prepared RPTI'), undefined); assert.equal(h.urlCount, 0); assert.equal(h.clicks, 0);
  assert.doesNotMatch(h.text, /RPTI prepared|Download started/); assert.equal(h.timers.size, 0); h.close();
});

test('server refusals clear reviewed previews and never show download success', async () => {
  const h = harness({ export: async () => { throw new Error('The source evidence changed.'); } });
  h.render(); h.check('Contract', true); h.click('Preview SFREP export'); await h.drain();
  h.click('Download SFREP .rpti'); await h.drain();
  assert.match(h.text, /source evidence changed/); assert.doesNotMatch(h.text, /Download started/);
  assert.equal(h.button('Download SFREP .rpti'), undefined); assert.equal(h.clicks, 0); h.close();
});

test('reference-only export works with PDFs and is disabled without fields or PDFs', async () => {
  const h = harness({ preview: async () => ({ ...response(), fields: [] }) });
  h.render(); h.check('Contract', true); h.click('Preview SFREP export'); await h.drain();
  assert.match(h.text, /reference PDFs only/); assert.equal(h.button('Download SFREP .rpti').props.disabled, false);
  h.check('Include original', false); h.click('Preview SFREP export'); await h.drain();
  assert.equal(h.button('Download SFREP .rpti').props.disabled, true);
  h.click('Download SFREP .rpti'); assert.equal(h.calls.filter(call => call[0] === 'export').length, 0); h.close();
});

test('preview failures remain actionable and never reveal download controls', async () => {
  const h = harness({ preview: async () => { throw new Error('Forbidden assignment'); } });
  h.render(); h.check('Contract', true); h.click('Preview SFREP export'); await h.drain();
  assert.match(h.text, /Forbidden assignment/); assert.equal(h.button('Download SFREP .rpti'), undefined);
  assert.equal(h.button('Preview SFREP export').props.disabled, false); h.close();
});

test('document selection never exceeds ten sources', () => {
  const h = harness(); h.props.documents = Array.from({ length: 11 }, (_, index) => ({ ...documents[0], id: index + 1, title: `Source ${index + 1}` }));
  h.render();
  for (let i = 1; i <= 10; i++) h.check(`Source ${i}`, true);
  assert.equal(h.checkbox('Source 11').props.disabled, true);
  h.check('Source 11', true); assert.equal(h.checkbox('Source 11').props.checked, false);
  assert.match(h.text, /10\/10/); h.close();
});

test('a timed-out request clears its busy state and remains retryable', async () => {
  const h = harness({ preview: (_selection, io) => new Promise((_resolve, reject) => {
    io.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  }) });
  h.render(); h.check('Contract', true); h.click('Preview SFREP export');
  for (const timeout of h.timers.values()) timeout();
  await h.drain(); assert.match(h.text, /timed out/);
  assert.equal(h.button('Preview SFREP export').props.disabled, false); assert.equal(h.timers.size, 0); h.close();
});

test('document center exposes export only for saved custom assignments and scopes the modal', () => {
  const source = readFileSync(new URL('../src/components/AssignmentDocumentCenter.tsx', import.meta.url), 'utf8');
  assert.match(source, /!isUad && assignmentFileId \? <div/);
  assert.match(source, /sfrepOpen && !isUad && assignmentFileId \? <SfrepExportDialog key=\{scopeKey\}/);
  assert.match(source, /setSfrepOpen\(false\)/);
});
