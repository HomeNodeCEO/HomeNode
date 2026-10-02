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
  fields: [{ sourceField: 'contract_price', fieldId: 'SalePriceAmount', value: '200000', documentId: 21, candidateId: 41, type: 'TextField' }],
  documents: [documents[0]], omitted: [{ sourceField: 'seller_name', documentId: 21, candidateId: 42, reason: 'No verified mapping' }],
  conflicts: [{ sourceField: 'lender_client_name', documentIds: [21, 22], values: ['First bank', 'Second bank'] }], warnings: ['Review imported fields.'] });

function harness(api = {}) {
  let cursor = 0, tree, opens = 0, closes = 0, restores = 0, clicks = 0, closeRequests = 0;
  const cells = [], effects = [], cleanups = [], calls = [], revoked = [], timers = new Map();
  class Element { isConnected = true; focus() { restores++; } }
  const document = { activeElement: new Element(), body: { appendChild() {} }, createElement() { return { click() { clicks++; }, remove() {} }; } };
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
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: value => revoked.push(value) },
    window: { setTimeout(fn) { const id = timers.size + 1; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); } } } });
  const props = { accountId: 'R1', assignmentFileId: 12, documents, getEditorKey: () => 'editor', onClose: () => { closeRequests++; } };
  const render = () => {
    cursor = 0; tree = component.default(props);
    tree.props.ref.current = { showModal() { opens++; }, close() { closes++; } };
    effects.splice(0).forEach(fn => cleanups.push(fn()));
  };
  const button = label => walk(tree).find(node => node.type === 'button' && text(node) === label);
  const checkbox = label => walk(tree).filter(node => node.type === 'label').find(node => text(node).includes(label))?.props.children.flat(Infinity).find(node => node?.type === 'input');
  return { props, calls, revoked, timers, render, get tree() { return tree; }, get text() { return text(tree); },
    get opens() { return opens; }, get closes() { return closes; }, get restores() { return restores; }, get clicks() { return clicks; }, get closeRequests() { return closeRequests; },
    button, checkbox,
    click(label) { const node = button(label); assert.ok(node, label); node.props.onClick(); render(); },
    check(label, checked) { const node = checkbox(label); assert.ok(node, label); node.props.onChange({ target: { checked } }); render(); },
    async drain() { for (let i = 0; i < 10; i++) await Promise.resolve(); render(); },
    close() { cleanups.splice(0).forEach(fn => fn?.()); } };
}

test('opens accessible native modal with explicit empty selection; Escape and unmount restore focus', () => {
  const h = harness(); h.render(); h.render();
  assert.equal(h.opens, 1); assert.equal(h.calls.length, 0);
  assert.equal(h.checkbox('Contract').props.checked, false); assert.equal(h.checkbox('Include original').props.checked, true);
  assert.equal(h.button('Preview SFREP export').props.disabled, true); assert.equal(h.button('Download SFREP .rpti'), undefined);
  assert.match(h.text, /does not support UAD 3.6/); assert.match(h.text, /Other Appraisal Document/);
  assert.match(h.tree.props.className, /border-amber-300/);
  let prevented = false; h.tree.props.onCancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(h.closeRequests, 1);
  h.close(); assert.equal(h.closes, 1); assert.equal(h.restores, 1);
});

test('preview shows fields and exclusions; only explicit download sends the reviewed digest', async () => {
  const h = harness(); h.render(); h.check('Contract', true); h.click('Preview SFREP export'); await h.drain();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], 'preview');
  assert.deepEqual(h.calls[0][1], { accountId: 'R1', assignmentFileId: 12, documentIds: [21], includeDocuments: true });
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
  assert.equal(h.clicks, 1); assert.match(h.text, /Download started/);
  h.close(); assert.deepEqual(h.revoked, ['blob:test']);
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
