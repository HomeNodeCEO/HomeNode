import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';

const source = new URL('../src/components/AssignmentDocumentCenter.tsx', import.meta.url);
const ACCOUNT = 'SYNTHETIC-ACCOUNT';
const EDITOR_KEY = 'synthetic-test-editor';
const getEditorKey = () => EDITOR_KEY;
const document = (id, patch = {}) => ({
  id, title: `Synthetic PDF ${id}`, document_type: 'mls_sheet',
  processing_status: 'review_required', file_size_bytes: 200, page_count: 1,
  candidates: [], ...patch,
});
const pdf = (name = 'synthetic-mls.pdf') => new File(['%PDF-1.7\nsynthetic fixture'], name, { type: 'application/pdf' });
const candidate = (id, value) => ({ id, field_key: 'county', raw_value: value, normalized_value: value,
  confirmed_value: null, review_status: 'suggested', page_number: 1, confidence: 0.9 });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const dependenciesEqual = (left, right) => left?.length === right?.length
  && left.every((value, index) => Object.is(value, right[index]));

function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join(' ');
  if (tree && typeof tree === 'object') return text(tree.props?.children);
  return typeof tree === 'string' || typeof tree === 'number' ? String(tree) : '';
}

// Load the actual checked-in component through the repository's restricted,
// file-backed test loader. Child components are deliberately not executed here:
// these tests exercise the parent authentication, scope, and async boundaries.
function harness({ props: initialProps = {}, api: overrides = {}, presentation = {}, documents = [], confirm = () => true } = {}) {
  const cells = [], effects = [], timers = new Map(), calls = [], lateStateWrites = [];
  let cursor = 0, dirty = false, tree, unmounted = false, timerId = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      cells[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [cells[index].value, update => {
        if (unmounted) lateStateWrites.push(index);
        const next = typeof update === 'function' ? update(cells[index].value) : update;
        if (!Object.is(next, cells[index].value)) { cells[index].value = next; dirty = true; }
      }];
    },
    useRef(initial) {
      const index = cursor++;
      cells[index] ??= { current: initial };
      return cells[index];
    },
    useMemo(factory, deps) {
      const index = cursor++;
      if (!cells[index] || !dependenciesEqual(cells[index].deps, deps)) {
        cells[index] = { value: factory(), deps };
      }
      return cells[index].value;
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useId() { return react.useMemo(() => `synthetic-reviewer-${cursor}`, []); },
    useEffect(fn, deps) {
      const index = cursor++, old = cells[index];
      if (old && dependenciesEqual(old.deps, deps)) return;
      const cell = { deps, cleanup: old?.cleanup };
      cells[index] = cell;
      effects.push(() => { cell.cleanup?.(); cell.cleanup = fn(); });
    },
    lazy: () => 'AssignmentPdfPreview',
    Suspense: 'Suspense',
  };
  const defaults = {
    getAssignmentDocuments: async () => documents,
    listUadDocuments: async () => documents,
    getAssignmentDocument: async id => document(id),
    getUadDocument: async (_workfile, id) => document(id),
    getAssignmentDocumentContent: async () => pdf(),
    getUadDocumentContent: async () => pdf(),
    uploadAssignmentDocument: async () => document(20),
    uploadUadDocument: async () => document(20),
  };
  const api = Object.fromEntries(Object.entries({ ...defaults, ...overrides }).map(([name, fn]) => [name,
    (...args) => { calls.push({ name, args }); return fn(...args); },
  ]));
  const imports = {
    react,
    'react/jsx-runtime': { jsx: (type, props, key) => ({ type, props, key }),
      jsxs: (type, props, key) => ({ type, props, key }), Fragment: 'Fragment' },
    '@/features/auth/ApplicationAuth': { useApplicationAuth: () => ({ session: { display_name: 'Synthetic Reviewer' } }) },
    '@/features/sfrep/SfrepExportDialog': { default: 'SfrepExportDialog', __esModule: true },
    './documents/AssignmentDocumentUploadQueue': { default: 'AssignmentDocumentUploadQueue', __esModule: true },
    '@/lib/api': api,
    '@/features/uad/api': api,
    '@/lib/propertyReportPresentation': {
      assignmentDocumentConfirmationBlocked: () => false,
      confirmedDocumentFieldApplications: () => [],
      documentSubjectAddressComparison: () => ({ matches: null }),
      ...presentation,
    },
  };
  const { default: Component } = loadTrustedRepositoryCommonJs(source, name => {
    assert.ok(Object.hasOwn(imports, name), `unexpected component dependency ${name}`);
    return imports[name];
  }, { environment: { window: {
    confirm,
    matchMedia: () => ({ matches: true }),
    setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
  } } });
  let props = { accountId: ACCOUNT, assignmentFileId: 14, embedded: true, getEditorKey, ...initialProps };
  function render(patch = {}, runEffects = true) {
    assert.equal(unmounted, false, 'unmounted harness cannot render');
    props = { ...props, ...patch }; cursor = 0; dirty = false;
    tree = Component(props);
    if (runEffects) effects.splice(0).forEach(effect => effect());
    return tree;
  }
  function flush() {
    let count = 0;
    while (dirty && !unmounted) { assert.ok(++count < 30, 'component render must settle'); render(); }
  }
  const findOne = type => {
    const found = nodes(tree, node => node.type === type);
    assert.equal(found.length, 1, `one ${type}`); return found[0];
  };
  render(); flush();
  return {
    calls, lateStateWrites, timers, render, flush,
    get tree() { return tree; },
    get queue() { return findOne('AssignmentDocumentUploadQueue'); },
    get sfrep() { return nodes(tree, node => node.type === 'SfrepExportDialog')[0] || null; },
    get sfrepButton() { return nodes(tree, node => node.type === 'button' && text(node) === 'Export to SFREP')[0] || null; },
    get preview() { return nodes(tree, node => node.type === 'AssignmentPdfPreview')[0] || null; },
    get text() { return text(tree); },
    requests: name => calls.filter(call => call.name === name),
    candidateInput(id) {
      const card = nodes(tree, node => node.type === 'div' && node.key === id)[0];
      return nodes(card, node => node.type === 'input' || node.type === 'select')[0] || null;
    },
    click(label, candidateId) {
      const root = candidateId ? nodes(tree, node => node.type === 'div' && node.key === candidateId)[0] : tree;
      const button = nodes(root, node => node.type === 'button' && text(node) === label)[0];
      assert.ok(button, `button ${label} exists`);
      assert.equal(Boolean(button.props.disabled), false, `button ${label} is enabled`);
      button.props.onClick(); flush();
    },
    select(id) {
      const button = nodes(tree, node => node.type === 'button' && node.key === id)[0];
      assert.ok(button, `document ${id} is available`); button.props.onClick(); flush();
    },
    async settle() { for (let count = 0; count < 30; count++) { await Promise.resolve(); flush(); } },
    poll() {
      assert.equal(timers.size, 1, 'one extraction poll');
      const [id, fn] = [...timers][0]; timers.delete(id); fn(); flush();
    },
    cleanup() {
      if (unmounted) return;
      unmounted = true; cells.forEach(cell => cell?.cleanup?.());
    },
  };
}

test('upload queue and SFREP export coexist with exact assignment, evidence, and authentication props', async t => {
  const evidence = [document(7), document(8)], pending = deferred();
  const h = harness({ api: { getAssignmentDocuments: () => pending.promise } });
  t.after(h.cleanup);
  assert.equal(h.sfrepButton.props.disabled, true, 'export waits for source evidence');
  assert.equal(h.queue.props.disabled, false, 'document loading does not disable upload');
  pending.resolve(evidence); await h.settle();
  const queueKey = h.queue.key;
  assert.equal(h.sfrepButton.props.disabled, false); assert.equal(h.sfrep, null);
  h.sfrepButton.props.onClick(); h.flush();
  assert.equal(h.sfrep.key, `custom:${ACCOUNT}:14`);
  assert.equal(h.sfrep.props.accountId, ACCOUNT);
  assert.equal(h.sfrep.props.assignmentFileId, 14);
  assert.deepEqual(h.sfrep.props.documents, evidence);
  assert.equal(h.sfrep.props.getEditorKey, getEditorKey);
  assert.equal(h.queue.key, queueKey, 'opening export preserves the existing upload queue');
  assert.equal(h.requests('uploadAssignmentDocument').length, 0);
  h.sfrep.props.onClose(); h.flush();
  assert.equal(h.sfrep, null); assert.equal(h.queue.key, queueKey);
});

test('locked Custom assignment keeps read-only SFREP export while disabling document mutations', async t => {
  const h = harness({ props: { readOnly: true }, documents: [document(7)] });
  t.after(h.cleanup); await h.settle();
  assert.equal(h.queue.props.disabled, true);
  assert.match(h.text, /Existing documents remain available for review and download/);
  assert.equal(h.sfrepButton.props.disabled, false);
  h.sfrepButton.props.onClick(); h.flush();
  assert.equal(h.sfrep.props.assignmentFileId, 14);
  await assert.rejects(h.queue.props.onUpload(pdf(), { title: 'Synthetic', documentType: 'other' }), /active workfile changed or is locked/);
  assert.equal(h.requests('uploadAssignmentDocument').length, 0);
});

for (const patch of [{ assignmentFileId: 15 }, { accountId: 'OTHER-ACCOUNT' }, { uadWorkfileId: 'other-uad' }]) {
  test(`scope change closes SFREP export and remounts the upload queue: ${JSON.stringify(patch)}`, async t => {
    const h = harness({ documents: [document(7)] }); t.after(h.cleanup); await h.settle();
    const oldQueueKey = h.queue.key;
    h.sfrepButton.props.onClick(); h.flush(); assert.ok(h.sfrep);
    h.render(patch); h.flush();
    assert.equal(h.sfrep, null, 'the export dialog is closed by the scope reset');
    assert.notEqual(h.queue.key, oldQueueKey);
    await h.settle();
    assert.equal(h.sfrep, null, 'loading the next scope never reopens the old export');
    if (patch.uadWorkfileId) assert.equal(h.sfrepButton, null, 'legacy SFREP export is not offered for UAD');
    else {
      h.sfrepButton.props.onClick(); h.flush();
      assert.equal(h.sfrep.key, h.queue.key);
      assert.equal(h.sfrep.props.accountId, patch.accountId || ACCOUNT);
      assert.equal(h.sfrep.props.assignmentFileId, patch.assignmentFileId || 14);
    }
  });
}

test('unsaved Custom assignment has a disabled queue and no SFREP export action', async t => {
  const h = harness({ props: { assignmentFileId: null }, documents: [document(7)] });
  t.after(h.cleanup); await h.settle();
  assert.equal(h.queue.props.disabled, true);
  assert.equal(h.sfrepButton, null); assert.equal(h.sfrep, null);
});

test('Custom batch upload preserves exact assignment, original File, label, type, and reviewer', async t => {
  const h = harness(); t.after(h.cleanup); await h.settle();
  const file = pdf(), metadata = { title: '513 Hardy MLS', documentType: 'mls_sheet' };
  await h.queue.props.onUpload(file, metadata); await h.settle();
  assert.deepEqual(h.requests('uploadAssignmentDocument').map(call => call.args), [
    [ACCOUNT, file, { ...metadata, uploadedBy: 'Synthetic Reviewer', assignmentFileId: 14 }, EDITOR_KEY],
  ]);
  assert.equal(h.requests('uploadAssignmentDocument')[0].args[1], file, 'bytes are not rewritten');
  assert.equal(h.requests('uploadUadDocument').length, 0);
  assert.equal(h.requests('getAssignmentDocument').length, 0, 'preview waits for the batch to finish');
});

test('UAD batch upload uses only the exact UAD workfile and does not require the legacy editor key', async t => {
  const h = harness({ props: { uadWorkfileId: 'synthetic-uad-77', getEditorKey: () => '' } });
  t.after(h.cleanup); await h.settle();
  const file = pdf(), metadata = { title: 'Engagement letter', documentType: 'engagement_letter' };
  await h.queue.props.onUpload(file, metadata); await h.settle();
  assert.deepEqual(h.requests('uploadUadDocument').map(call => call.args), [
    ['synthetic-uad-77', file, { ...metadata, uploadedBy: 'Synthetic Reviewer' }],
  ]);
  assert.equal(h.requests('uploadAssignmentDocument').length, 0);
});

for (const mode of ['missing authentication', 'locked workfile', 'newly locked workfile', 'unmounted']) {
  test(`batch upload refuses ${mode} before sending a request`, async t => {
    const h = harness({ props: mode === 'missing authentication' ? { getEditorKey: () => '' }
      : mode === 'locked workfile' ? { readOnly: true } : {} });
    t.after(h.cleanup); await h.settle();
    const upload = h.queue.props.onUpload;
    if (mode === 'newly locked workfile') h.render({ readOnly: true }, false);
    if (mode === 'unmounted') h.cleanup();
    await assert.rejects(upload(pdf(), { title: 'Synthetic', documentType: 'other' }),
      /Sign in before uploading|active workfile changed or is locked/);
    assert.equal(h.requests('uploadAssignmentDocument').length, 0);
    assert.equal(h.requests('uploadUadDocument').length, 0);
  });
}

for (const assignmentFileId of [null, undefined, 0, -1, 1.5, '14', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`Custom upload requires a resolved positive safe assignment ID: ${String(assignmentFileId)}`, async t => {
    const h = harness({ props: { assignmentFileId } }); t.after(h.cleanup); await h.settle();
    assert.equal(h.queue.props.disabled, true);
    await assert.rejects(h.queue.props.onUpload(pdf(), { title: 'Synthetic', documentType: 'other' }), /active workfile changed or is locked/);
    assert.equal(h.requests('uploadAssignmentDocument').length, 0);
  });
}

for (const patch of [{ assignmentFileId: 15 }, { accountId: 'OTHER-ACCOUNT' }, { uadWorkfileId: 'other-uad' }]) {
  test(`old upload callbacks cannot start after scope changes to ${JSON.stringify(patch)}`, async t => {
    const h = harness(); t.after(h.cleanup); await h.settle();
    const oldQueue = h.queue;
    h.render(patch, false);
    assert.notEqual(h.queue.key, oldQueue.key, 'a new scope receives an empty, keyed upload queue');
    await assert.rejects(oldQueue.props.onUpload(pdf(), { title: 'Synthetic', documentType: 'other' }), /active workfile changed/);
    await oldQueue.props.onComplete();
    assert.equal(h.requests('uploadAssignmentDocument').length, 0);
    assert.equal(h.requests('getAssignmentDocuments').length, 1, 'stale completion does not refresh either scope');
  });
}

test('late in-flight upload result never appends to or previews the new assignment', async t => {
  const pending = deferred(), h = harness({ api: { uploadAssignmentDocument: () => pending.promise } });
  t.after(h.cleanup); await h.settle();
  const oldQueue = h.queue;
  const upload = oldQueue.props.onUpload(pdf(), { title: 'Old assignment', documentType: 'mls_sheet' });
  h.render({ assignmentFileId: 15 }); await h.settle();
  const before = h.calls.length;
  pending.resolve(document(99, { title: 'Old-scope uploaded document' }));
  await upload; await oldQueue.props.onComplete(); await h.settle();
  assert.equal(h.calls.length, before);
  assert.doesNotMatch(h.text, /Old-scope uploaded document/);
  assert.equal(h.preview, null);
  await h.queue.props.onComplete(); await h.settle();
  assert.equal(h.requests('getAssignmentDocument').length, 0, 'new batch has no stale last-upload selection');
});

test('batch completion refreshes once and selects only the last successful file in the current batch', async t => {
  let nextId = 20;
  const uploaded = [];
  const h = harness({ api: {
    uploadAssignmentDocument: async () => { const item = document(nextId++); uploaded.push(item); return item; },
    getAssignmentDocuments: async () => uploaded.slice(),
  } });
  t.after(h.cleanup); await h.settle();
  await h.queue.props.onUpload(pdf('one.pdf'), { title: 'One', documentType: 'other' }); await h.settle();
  await h.queue.props.onUpload(pdf('two.pdf'), { title: 'Two', documentType: 'mls_sheet' }); await h.settle();
  assert.equal(h.requests('getAssignmentDocuments').length, 1, 'each successful upload does not reload the whole list');
  await h.queue.props.onComplete(); await h.settle();
  assert.deepEqual(h.requests('getAssignmentDocument').map(call => call.args[0]), [21]);
  assert.equal(h.requests('getAssignmentDocuments').length, 2, 'completion refreshes the list once without a selection-triggered second reload');
  assert.equal(h.preview.props.title, 'Synthetic PDF 21');
  await h.queue.props.onComplete(); await h.settle();
  assert.equal(h.requests('getAssignmentDocument').length, 1, 'completion consumes the last-upload pointer');
});

test('scope change during the completion refresh cannot open the old batch PDF', async t => {
  const pending = deferred(); let listRequests = 0;
  const h = harness({ api: { getAssignmentDocuments: () => ++listRequests === 2 ? pending.promise : Promise.resolve([]) } });
  t.after(h.cleanup); await h.settle();
  await h.queue.props.onUpload(pdf(), { title: 'One', documentType: 'other' }); await h.settle();
  const complete = h.queue.props.onComplete();
  h.render({ assignmentFileId: 15 }); await h.settle();
  pending.resolve([document(20)]); await complete; await h.settle();
  assert.equal(h.requests('getAssignmentDocument').length, 0);
  assert.equal(h.preview, null);
  assert.doesNotMatch(h.text, /Synthetic PDF 20/);
});

test('extraction polls reuse immutable source bytes and never embed the denied viewer page', async t => {
  const original = pdf();
  const h = harness({ documents: [document(7)], api: {
    getAssignmentDocument: async id => document(id, { processing_status: 'processing' }),
    getAssignmentDocumentContent: async () => original,
  } });
  t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
  assert.equal(h.preview.props.blob, original);
  assert.equal(h.preview.key, `custom:${ACCOUNT}:14:7`);
  h.poll(); await h.settle();
  assert.equal(h.requests('getAssignmentDocument').length, 2);
  assert.equal(h.requests('getAssignmentDocuments').length, 1, 'selection and metadata polls do not reload the document list');
  assert.equal(h.requests('getAssignmentDocumentContent').length, 1, 'metadata polling does not download the same PDF again');
  assert.equal(h.preview.props.blob, original);
  assert.equal(nodes(h.tree, node => node.type === 'iframe').length, 0);
  h.render({ assignmentFileId: 15 }, false);
  assert.equal(h.preview, null, 'old PDF is hidden synchronously before scope reset effects');
});

test('UAD preview uses exact-workfile bearer APIs and reuses immutable bytes during extraction polls', async t => {
  const original = pdf();
  const h = harness({ props: { uadWorkfileId: 'synthetic-uad-77', getEditorKey: () => '' },
    documents: [document(7)], api: {
      getUadDocument: async (_workfile, id) => document(id, { processing_status: 'processing' }),
      getUadDocumentContent: async () => original,
    } });
  t.after(h.cleanup); await h.settle(); h.select(7); await h.settle(); h.poll(); await h.settle();
  assert.deepEqual(h.requests('getUadDocument').map(call => call.args), [
    ['synthetic-uad-77', 7], ['synthetic-uad-77', 7],
  ]);
  assert.deepEqual(h.requests('getUadDocumentContent').map(call => call.args), [['synthetic-uad-77', 7]]);
  assert.equal(h.requests('listUadDocuments').length, 1, 'UAD selection and polling do not repeatedly reload the list');
  assert.equal(h.requests('getAssignmentDocument').length, 0);
  assert.equal(h.requests('getAssignmentDocumentContent').length, 0);
  assert.equal(h.preview.props.blob, original);
  assert.equal(h.preview.key, 'uad:synthetic-uad-77:7');
  h.render({ uadWorkfileId: 'synthetic-uad-78' }, false);
  assert.equal(h.preview, null);
});

test('changing document clears its predecessor immediately, and content failure keeps only new metadata', async t => {
  const pending = deferred();
  const h = harness({ documents: [document(7), document(8)], api: {
    getAssignmentDocumentContent: id => id === 8 ? pending.promise : Promise.resolve(pdf()),
  } });
  t.after(h.cleanup); await h.settle(); h.select(7); await h.settle(); assert.ok(h.preview);
  h.select(8); assert.equal(h.preview, null, 'old bytes are not shown while the next file loads');
  pending.reject(new Error('synthetic preview unavailable')); await h.settle();
  assert.equal(h.preview, null);
  assert.match(h.text, /Document information loaded for review/);
  assert.match(h.text, /synthetic preview unavailable/);
  assert.equal(nodes(h.tree, node => node.type === 'button' && node.key === 8)[0].props['aria-pressed'], true);
});

test('retrying the same PDF after a preview failure preserves reviewer drafts and refreshes untouched candidates', async t => {
  const pending = deferred(); let metadataRequests = 0, contentRequests = 0;
  const h = harness({ documents: [document(7)], api: {
    getAssignmentDocument: async id => document(id, { candidates: ++metadataRequests === 1
      ? [candidate(701, 'First suggestion'), candidate(702, 'Clear this'), candidate(703, 'Old untouched'), candidate(705, 'Removed candidate')]
      : [candidate(701, 'Changed suggestion'), candidate(702, 'Changed clear suggestion'), candidate(703, 'Fresh untouched'), candidate(704, 'New candidate')] }),
    getAssignmentDocumentContent: () => ++contentRequests === 1 ? Promise.reject(new Error('synthetic preview unavailable')) : pending.promise,
  } });
  t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
  assert.equal(h.preview, null); assert.ok(h.candidateInput(701));
  h.candidateInput(701).props.onChange({ target: { value: 'Unsaved reviewer correction' } });
  h.candidateInput(702).props.onChange({ target: { value: '' } }); h.flush();
  h.select(7);
  assert.equal(h.candidateInput(701)?.props.value, 'Unsaved reviewer correction', 'same-document PDF retry must not clear the review form');
  h.candidateInput(701).props.onChange({ target: { value: 'Correction during retry' } }); h.flush();
  pending.resolve(pdf()); await h.settle();
  assert.equal(h.candidateInput(701).props.value, 'Correction during retry');
  assert.equal(h.candidateInput(702).props.value, '', 'an intentional empty draft also survives');
  assert.equal(h.candidateInput(703).props.value, 'Fresh untouched');
  assert.equal(h.candidateInput(704).props.value, 'New candidate');
  assert.equal(h.candidateInput(705), null);
  assert.ok(h.preview); assert.equal(contentRequests, 2);
});

for (const mode of ['Custom', 'UAD']) for (const draft of ['B', '']) {
  test(`${mode} explicit edit intent survives server A-to-draft-to-C polling for ${JSON.stringify(draft)}`, async t => {
    let request = 0;
    const metadata = id => document(id, { processing_status: 'processing',
      candidates: [candidate(701, ['A', draft, 'C'][Math.min(request++, 2)])] });
    const h = harness({ props: mode === 'UAD' ? { uadWorkfileId: 'synthetic-uad-77' } : {}, documents: [document(7)], api: {
      getAssignmentDocument: async id => metadata(id), getUadDocument: async (_workfile, id) => metadata(id),
    } });
    t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
    assert.equal(h.candidateInput(701).props.value, 'A');
    h.candidateInput(701).props.onChange({ target: { value: draft } }); h.flush();
    h.poll(); await h.settle(); assert.equal(h.candidateInput(701).props.value, draft);
    h.poll(); await h.settle();
    assert.equal(h.candidateInput(701).props.value, draft, 'a matching server value must not revoke explicit edit intent');
  });
}

for (const mode of ['Custom', 'UAD']) for (const action of ['Confirm', 'Reject']) {
  test(`${mode} successful ${action} clears only the submitted candidate edit`, async t => {
    let serverValue = 'A';
    const metadata = id => document(id, { processing_status: 'processing',
      candidates: [candidate(701, serverValue), candidate(702, serverValue)] });
    const save = async () => { serverValue = 'B'; return {}; };
    const h = harness({ props: mode === 'UAD' ? { uadWorkfileId: 'synthetic-uad-77' } : {}, documents: [document(7)], api: {
      getAssignmentDocument: async id => metadata(id), getUadDocument: async (_workfile, id) => metadata(id),
      reviewAssignmentDocumentCandidate: save, reviewUadDocumentCandidate: save,
      applyUadDocumentCandidate: async () => ({ applied: false }),
    } });
    t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
    h.candidateInput(701).props.onChange({ target: { value: '' } });
    h.candidateInput(702).props.onChange({ target: { value: 'Unsaved other field' } }); h.flush();
    h.click(action, 701); await h.settle();
    const saved = h.requests(mode === 'UAD' ? 'reviewUadDocumentCandidate' : 'reviewAssignmentDocumentCandidate')[0];
    assert.equal(saved.args[mode === 'UAD' ? 3 : 2].confirmedValue, '', 'an empty draft is not replaced before submission');
    assert.equal(h.candidateInput(701).props.value, 'B', 'the submitted edit is acknowledged on success');
    serverValue = 'C'; h.poll(); await h.settle();
    assert.equal(h.candidateInput(701).props.value, 'C');
    assert.equal(h.candidateInput(702).props.value, 'Unsaved other field');
  });
}

for (const mode of ['Custom', 'UAD']) {
  test(`${mode} failed review preserves explicit edit intent through later matching polls`, async t => {
    let serverValue = 'A';
    const metadata = id => document(id, { processing_status: 'processing', candidates: [candidate(701, serverValue)] });
    const fail = async () => { throw new Error('synthetic review failed'); };
    const h = harness({ props: mode === 'UAD' ? { uadWorkfileId: 'synthetic-uad-77' } : {}, documents: [document(7)], api: {
      getAssignmentDocument: async id => metadata(id), getUadDocument: async (_workfile, id) => metadata(id),
      reviewAssignmentDocumentCandidate: fail, reviewUadDocumentCandidate: fail,
    } });
    t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
    h.candidateInput(701).props.onChange({ target: { value: 'B' } }); h.flush();
    h.click('Confirm', 701); await h.settle(); assert.match(h.text, /synthetic review failed/);
    serverValue = 'B'; h.poll(); await h.settle();
    serverValue = 'C'; h.poll(); await h.settle();
    assert.equal(h.candidateInput(701).props.value, 'B');
  });
}

const saveRoutes = [
  { name: 'Custom single review', apiName: 'reviewAssignmentDocumentCandidate', button: 'Confirm', candidateId: 701, single: true },
  { name: 'UAD single review', apiName: 'reviewUadDocumentCandidate', button: 'Confirm', candidateId: 701, single: true, uad: true },
  { name: 'Custom approve-all', apiName: 'confirmAllAssignmentDocumentCandidates', button: 'Approve All (1)' },
  { name: 'UAD purchase-contract approve-all', apiName: 'confirmAllUadPurchaseContractCandidates', button: 'Approve All (1)', uad: true, contract: true },
  { name: 'UAD iterative approve-all', apiName: 'reviewUadDocumentCandidate', button: 'Approve All (1)', uad: true, single: true },
  { name: 'Custom mismatch override', apiName: 'confirmAssignmentDocumentDespiteSubjectMismatch', button: 'Upload Anyway', override: true },
  { name: 'UAD mismatch override', apiName: 'confirmUadDocumentDespiteSubjectMismatch', button: 'Upload Anyway', uad: true, override: true },
];

test('stale approve-all completion cannot replace a newly selected document or its draft', async t => {
  const pending = deferred(), applied = [];
  const metadata = id => document(id, { candidates: [candidate(id * 100 + 1, `Document ${id}`)] });
  const h = harness({ props: { onCustomAssignmentApplied: value => applied.push(value) }, documents: [document(7), document(8)], api: {
    getAssignmentDocument: async id => metadata(id),
    confirmAllAssignmentDocumentCandidates: () => pending.promise,
  } });
  t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
  h.click('Approve All (1)'); h.select(8); await h.settle();
  h.candidateInput(801).props.onChange({ target: { value: 'Document B draft' } }); h.flush();
  const before = h.calls.length;
  pending.resolve({ document: metadata(7), assignmentApplication: { applied: true } }); await h.settle();
  assert.equal(h.candidateInput(801)?.props.value, 'Document B draft');
  assert.deepEqual(applied, []);
  assert.equal(h.calls.length, before, 'stale completion starts no refresh');
});

for (const reviewStatus of ['confirmed', 'rejected']) {
  test(`real ${reviewStatus} response cannot hide a newer edit because the submitted input is locked`, async t => {
    const pending = deferred(); let saved = false;
    const metadata = id => document(id, { candidates: [{ ...candidate(701, 'A'),
      confirmed_value: saved && reviewStatus === 'confirmed' ? 'B' : null,
      review_status: saved ? reviewStatus : 'suggested' }, candidate(702, 'Unrelated')] });
    const h = harness({ documents: [document(7)], api: {
      getAssignmentDocument: async id => metadata(id), reviewAssignmentDocumentCandidate: () => pending.promise,
    } });
    t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
    h.candidateInput(701).props.onChange({ target: { value: 'B' } }); h.flush();
    const staleChange = h.candidateInput(701).props.onChange;
    h.click(reviewStatus === 'confirmed' ? 'Confirm' : 'Reject', 701);
    assert.equal(h.candidateInput(701).props.disabled, true);
    assert.match(h.text, /Saving/);
    staleChange({ target: { value: 'C' } }); h.flush();
    assert.equal(h.candidateInput(701).props.value, 'B');
    assert.equal(h.candidateInput(702).props.disabled, false);
    h.candidateInput(702).props.onChange({ target: { value: 'Editable unrelated draft' } }); h.flush();
    saved = true; pending.resolve({}); await h.settle();
    assert.equal(h.candidateInput(701), null, 'the saved candidate becomes a reviewed card');
    assert.equal(h.candidateInput(702).props.value, 'Editable unrelated draft');
  });
}

for (const route of saveRoutes) for (const result of ['saved', 'failed', 'edit attempted during save']) {
  test(`${route.name} preserves correct dirty state when ${result}`, async t => {
    const pending = deferred(); let serverValue = 'A';
    const metadata = id => document(id, { processing_status: 'processing',
      document_type: route.override ? 'engagement_letter' : route.contract ? 'purchase_contract' : 'mls_sheet',
      candidates: [{ ...candidate(701, serverValue), field_key: route.override ? 'subject_property_address' : 'county' }] });
    const h = harness({ props: route.uad ? { uadWorkfileId: 'synthetic-uad-77' } : {}, documents: [document(7)],
      presentation: route.override ? {
        assignmentDocumentConfirmationBlocked: () => true,
        documentSubjectAddressComparison: () => ({ matches: false, documentAddress: 'Synthetic A', reportAddress: 'Synthetic B' }),
      } : {}, api: {
        getAssignmentDocument: async id => metadata(id), getUadDocument: async (_workfile, id) => metadata(id),
        [route.apiName]: () => pending.promise,
        applyUadDocumentCandidate: async () => ({ applied: false }),
      } });
    t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
    h.candidateInput(701).props.onChange({ target: { value: 'B' } }); h.flush();
    h.click(route.button, route.candidateId);
    assert.equal(h.requests(route.apiName).length, 1);
    if (result === 'edit attempted during save') {
      assert.equal(h.candidateInput(701).props.disabled, true);
      h.candidateInput(701).props.onChange({ target: { value: 'Newer draft' } }); h.flush();
      assert.equal(h.candidateInput(701).props.value, 'B', 'queued changes cannot alter a submitted value');
    }
    serverValue = 'B';
    if (result === 'failed') pending.reject(new Error('synthetic save failed'));
    else pending.resolve(route.single ? {} : route.override ? metadata(7) : { document: metadata(7), application: {} });
    await h.settle();
    if (result === 'failed') assert.match(h.text, /synthetic save failed/);
    assert.equal(h.candidateInput(701).props.value, 'B');
    serverValue = 'C'; h.poll(); await h.settle();
    assert.equal(h.candidateInput(701).props.value, result === 'failed' ? 'B' : 'C',
      'failed saves retain drafts; successful saves acknowledge the locked submitted value');
  });
}

const mismatchPresentation = {
  assignmentDocumentConfirmationBlocked: () => true,
  documentSubjectAddressComparison: () => ({ matches: false }),
};
function reviewedResponse(route, item) {
  const reviewed = { ...item, candidates: item.candidates.map(value => ({ ...value, review_status: 'confirmed', confirmed_value: 'B' })) };
  return route.single ? { assignment_application: { applied: true } }
    : route.override ? reviewed : { document: reviewed, application: { applied: true }, assignmentApplication: { applied: true } };
}

for (const route of saveRoutes) for (const transition of ['document', 'round trip', 'scope', 'unmount', 'newer review', ...(route.uad ? [] : ['account'])]) {
  for (const outcome of ['success', 'failure']) {
    test(`${route.name} ignores stale ${outcome} after ${transition}`, async t => {
      const pending = deferred(), newer = deferred(), applied = []; let saves = 0;
      const metadata = id => document(id, {
        document_type: route.override ? 'engagement_letter' : route.contract ? 'purchase_contract' : 'mls_sheet',
        candidates: [{ ...candidate(id * 100 + 1, `Document ${id}`), field_key: route.override ? 'subject_property_address' : 'county' }],
      });
      const h = harness({ props: { ...(route.uad ? { uadWorkfileId: 'synthetic-uad-77' } : {}),
        onCustomAssignmentApplied: value => applied.push(value), onUadApplied: value => applied.push(value),
        onApplyConfirmedCandidate: value => applied.push(value) }, documents: [document(7), document(8)],
        presentation: { ...(route.override ? mismatchPresentation : {}),
          confirmedDocumentFieldApplications: values => values.filter(value => value.review_status === 'confirmed')
            .map(value => ({ fieldKey: value.field_key, value: value.confirmed_value })),
        }, api: {
          getAssignmentDocument: async id => metadata(id), getUadDocument: async (_workfile, id) => metadata(id),
          [route.apiName]: () => ++saves === 1 ? pending.promise : newer.promise,
          applyUadDocumentCandidate: async () => ({ applied: true }),
        } });
      t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
      h.click(route.button, route.candidateId);
      let selectedId = 8;
      if (transition === 'unmount') h.cleanup();
      else {
        if (transition === 'scope' || transition === 'account') {
          h.render(transition === 'account' ? { accountId: 'OTHER-ACCOUNT' }
            : route.uad ? { uadWorkfileId: 'synthetic-uad-78' } : { assignmentFileId: 15 }); await h.settle();
          selectedId = 7;
        } else h.select(8);
        await h.settle();
        if (transition === 'round trip') selectedId = 7;
        if (selectedId === 7) { h.select(7); await h.settle(); }
        h.candidateInput(selectedId * 100 + 1).props.onChange({ target: { value: 'Current draft' } }); h.flush();
        if (transition === 'newer review') h.click(route.button, route.candidateId ? selectedId * 100 + 1 : undefined);
      }
      const before = h.calls.length;
      if (outcome === 'failure') pending.reject(new Error('stale save failed'));
      else pending.resolve(reviewedResponse(route, metadata(7)));
      await h.settle();
      assert.equal(h.calls.length, before, 'stale saves start no reload, apply, or subsequent iterative review');
      assert.deepEqual(applied, []);
      assert.deepEqual(h.lateStateWrites, []);
      if (transition !== 'unmount') {
        assert.equal(h.candidateInput(selectedId * 100 + 1)?.props.value, transition === 'round trip' ? 'Document 7' : 'Current draft');
        assert.doesNotMatch(h.text, /stale save failed/);
        assert.equal(h.candidateInput(selectedId * 100 + 1).props.disabled, transition === 'newer review');
        if (transition === 'newer review') {
          assert.match(h.text, /Saving this field/);
          newer.reject(new Error('current save failed')); await h.settle();
          assert.match(h.text, /current save failed/);
          assert.equal(h.candidateInput(selectedId * 100 + 1).props.disabled, false);
        }
      }
    });
  }
}

for (const route of saveRoutes) {
  test(`${route.name} keeps submitted fields locked through polls and real confirmed status`, async t => {
    const pending = deferred(); let saved = false, pollAddsCandidate = false;
    const metadata = id => document(id, { processing_status: 'processing',
      document_type: route.override ? 'engagement_letter' : route.contract ? 'purchase_contract' : 'mls_sheet',
      candidates: [{ ...candidate(701, 'A'), field_key: route.override ? 'subject_property_address' : 'county',
        review_status: saved ? 'confirmed' : 'suggested', confirmed_value: saved ? 'B' : null },
      ...(pollAddsCandidate ? [candidate(702, 'New unrelated suggestion')] : [])],
    });
    const h = harness({ props: route.uad ? { uadWorkfileId: 'synthetic-uad-77' } : {}, documents: [document(7)],
      presentation: route.override ? mismatchPresentation : {}, api: {
        getAssignmentDocument: async id => metadata(id), getUadDocument: async (_workfile, id) => metadata(id),
        [route.apiName]: () => pending.promise, applyUadDocumentCandidate: async () => ({ applied: false }),
      } });
    t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
    h.candidateInput(701).props.onChange({ target: { value: 'B' } }); h.flush();
    const staleChange = h.candidateInput(701).props.onChange;
    h.click(route.button, route.candidateId);
    pollAddsCandidate = true; h.poll(); await h.settle();
    assert.equal(h.candidateInput(701).props.disabled, true, 'poll cleanup must not unlock an explicit save');
    const description = h.candidateInput(701).props['aria-describedby'];
    assert.ok(nodes(h.tree, node => node.props?.id === description && node.props.role === 'status').length);
    assert.equal(h.candidateInput(702).props.disabled, false, 'only submitted IDs are locked');
    h.candidateInput(702).props.onChange({ target: { value: 'Unrelated draft' } }); staleChange({ target: { value: 'C' } }); h.flush();
    assert.equal(h.candidateInput(701).props.value, 'B');
    saved = true;
    pending.resolve(route.single ? {} : route.override ? metadata(7) : { document: metadata(7), application: {} });
    await h.settle();
    assert.equal(h.candidateInput(701), null, 'real saved fields render as reviewed cards');
    assert.equal(h.candidateInput(702)?.props.value, 'Unrelated draft');
    assert.equal(h.candidateInput(702).props.disabled, false);
  });
}

for (const transition of ['same-document retry', 'A-B-A']) {
  test(`${transition} retains the original save lock until its request settles`, async t => {
    const pending = deferred();
    const metadata = id => document(id, { candidates: [candidate(id * 100 + 1, 'A')] });
    const h = harness({ documents: [document(7), document(8)], api: {
      getAssignmentDocument: async id => metadata(id), reviewAssignmentDocumentCandidate: () => pending.promise,
    } });
    t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
    h.click('Confirm', 701);
    if (transition === 'A-B-A') {
      h.select(8); await h.settle(); assert.equal(h.candidateInput(801).props.disabled, false);
    }
    h.select(7); await h.settle();
    assert.equal(h.candidateInput(701).props.disabled, true, 'navigation cannot cancel the already-sent save');
    h.candidateInput(701).props.onChange({ target: { value: 'C' } }); h.flush();
    assert.equal(h.candidateInput(701).props.value, 'A');
    pending.resolve({}); await h.settle();
    assert.equal(h.candidateInput(701).props.disabled, false);
  });
}

for (const mode of ['Custom', 'UAD']) for (const reload of ['document', 'list']) for (const outcome of ['success', 'failure']) {
  test(`${mode} stale action-owned ${reload} reload ignores ${outcome} after navigation`, async t => {
    const pending = deferred(); let metadataRequests = 0, listRequests = 0;
    const metadata = id => document(id, { document_type: reload === 'list' ? 'purchase_contract' : 'mls_sheet',
      candidates: [candidate(id * 100 + 1, `Document ${id}`)] });
    const get = async id => id === 7 && ++metadataRequests === 2 && reload === 'document' ? pending.promise : metadata(id);
    const list = async () => ++listRequests === 2 && reload === 'list' ? pending.promise : [document(7), document(8)];
    const h = harness({ props: mode === 'UAD' ? { uadWorkfileId: 'synthetic-uad-77' } : {}, api: {
      getAssignmentDocuments: list, listUadDocuments: list,
      getAssignmentDocument: get, getUadDocument: async (_workfile, id) => get(id),
      reviewAssignmentDocumentCandidate: async () => ({}), reviewUadDocumentCandidate: async () => ({}),
      applyUadDocumentCandidate: async () => ({ applied: false }),
      confirmAllAssignmentDocumentCandidates: async () => ({ document: metadata(7) }),
      confirmAllUadPurchaseContractCandidates: async () => ({ document: metadata(7), application: {} }),
    } });
    t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
    h.click(reload === 'list' ? 'Approve All (1)' : 'Confirm', reload === 'document' ? 701 : undefined); await h.settle();
    assert.equal(reload === 'list' ? listRequests : metadataRequests, 2, 'save reached its nested refresh');
    h.select(8); await h.settle();
    h.candidateInput(801).props.onChange({ target: { value: 'Current draft' } }); h.flush();
    const before = h.calls.length;
    if (outcome === 'failure') pending.reject(new Error('stale reload failed'));
    else pending.resolve(reload === 'list' ? [metadata(7)] : metadata(7));
    await h.settle();
    assert.equal(h.candidateInput(801)?.props.value, 'Current draft');
    assert.doesNotMatch(h.text, /stale reload failed/);
    assert.equal(h.calls.length, before, 'stale nested reload does not continue to another refresh');
  });
}

for (const route of saveRoutes) {
  test(`${route.name} stops follow-on application when the workfile becomes read-only`, async t => {
    const pending = deferred(), applied = [];
    const metadata = id => document(id, { document_type: route.override ? 'engagement_letter' : route.contract ? 'purchase_contract' : 'mls_sheet',
      candidates: [{ ...candidate(701, 'A'), field_key: route.override ? 'subject_property_address' : 'county' }] });
    const h = harness({ props: { ...(route.uad ? { uadWorkfileId: 'synthetic-uad-77' } : {}),
      onCustomAssignmentApplied: value => applied.push(value), onUadApplied: value => applied.push(value),
      onApplyConfirmedCandidate: value => applied.push(value) }, documents: [document(7)],
      presentation: route.override ? mismatchPresentation : {}, api: {
        getAssignmentDocument: async id => metadata(id), getUadDocument: async (_workfile, id) => metadata(id),
        [route.apiName]: () => pending.promise, applyUadDocumentCandidate: async () => ({ applied: true }),
      } });
    t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
    h.click(route.button, route.candidateId); h.render({ readOnly: true }); h.flush();
    const before = h.calls.length;
    pending.resolve(reviewedResponse(route, metadata(7))); await h.settle();
    assert.deepEqual(applied, []); assert.equal(h.calls.length, before);
    assert.equal(h.candidateInput(701).props.disabled, true);
  });
}

for (const route of saveRoutes.filter(route => route.uad && !route.contract)) for (const transition of ['navigation', 'read-only']) {
  test(`${route.name} stops after an in-flight UAD apply loses ${transition} authority`, async t => {
    const pending = deferred(), applied = [];
    const metadata = id => document(id, { document_type: route.override ? 'engagement_letter' : 'mls_sheet',
      candidates: [{ ...candidate(id * 100 + 1, 'A'), field_key: route.override ? 'subject_property_address' : 'county' }, candidate(id * 100 + 2, 'Other')] });
    const h = harness({ props: { uadWorkfileId: 'synthetic-uad-77', onUadApplied: value => applied.push(value) }, documents: [document(7), document(8)],
      presentation: route.override ? mismatchPresentation : {}, api: {
        getUadDocument: async (_workfile, id) => metadata(id),
        [route.apiName]: async () => reviewedResponse(route, metadata(7)),
        applyUadDocumentCandidate: () => pending.promise,
      } });
    t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
    h.click(route.button.replace('(1)', '(2)'), route.candidateId); await h.settle();
    assert.equal(h.requests('applyUadDocumentCandidate').length, 1);
    if (transition === 'navigation') { h.select(8); await h.settle(); }
    else { h.render({ readOnly: true }); h.flush(); }
    const before = h.calls.length;
    pending.resolve({ applied: true }); await h.settle();
    assert.deepEqual(applied, []); assert.equal(h.calls.length, before, 'no next candidate save, apply, or reload');
  });
}

for (const mode of ['Custom', 'UAD']) for (const path of ['poll', 'reopened document', 'failed save reload']) {
  for (const status of ['confirmed', 'rejected']) for (const draft of ['Recover this draft', '']) {
    test(`${mode} reviewed ${status} card preserves ${JSON.stringify(draft)} after ${path}`, async t => {
      const pending = deferred(); let saved = false, requests = 0;
      const metadata = id => document(id, { processing_status: 'processing', candidates: [{ ...candidate(id * 100 + 1, 'A'),
        review_status: saved && id === 7 ? status : 'suggested', confirmed_value: saved && status === 'confirmed' ? 'Server B' : null }] });
      const get = async id => {
        if (id === 7 && ++requests === 2 && path === 'failed save reload') throw new Error('synthetic metadata refresh failed');
        return metadata(id);
      };
      const h = harness({ props: mode === 'UAD' ? { uadWorkfileId: 'synthetic-uad-77' } : {}, documents: [document(7), document(8)], api: {
        getAssignmentDocument: get, getUadDocument: async (_workfile, id) => get(id),
        reviewAssignmentDocumentCandidate: () => pending.promise, reviewUadDocumentCandidate: () => pending.promise,
        applyUadDocumentCandidate: async () => ({ applied: false }),
      } });
      t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
      if (path !== 'poll') {
        h.click(status === 'confirmed' ? 'Confirm' : 'Reject', 701);
        if (path === 'reopened document') { h.select(8); await h.settle(); h.select(7); await h.settle(); }
        saved = true; pending.resolve({}); await h.settle();
      }
      h.candidateInput(701).props.onChange({ target: { value: draft } }); h.flush();
      saved = true;
      if (path === 'failed save reload') h.select(7);
      else h.poll();
      await h.settle();
      assert.equal(h.candidateInput(701), null);
      const note = nodes(h.tree, node => node.props?.['aria-label'] === 'Unsaved local edit')[0];
      assert.ok(note, 'the local draft is visible, not only retained in memory');
      assert.match(text(note), /not submitted or applied/);
      assert.ok(text(note).includes(draft === '' ? '(empty draft)' : draft));
      assert.ok(nodes(h.tree, node => node.type === 'details' && node.props.open === true).length, 'recoverable edits are expanded');
      if (status === 'confirmed') assert.match(h.text, /Server B/, 'server-approved value remains separately visible');
      assert.doesNotMatch(h.text, /Review complete/);
      const before = h.calls.length; await h.settle(); assert.equal(h.calls.length, before, 'draft recovery does not apply anything');
    });
  }
}

test('pending review blocks competing mutation handlers but leaves unrelated edits usable', async t => {
  const pending = deferred();
  const h = harness({ documents: [document(7)], api: {
    getAssignmentDocument: async id => document(id, { candidates: [candidate(701, 'A'), candidate(702, 'Other')] }),
    reviewAssignmentDocumentCandidate: () => pending.promise,
  } });
  t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
  const handlers = nodes(h.tree, node => node.type === 'button' && ['Re-run Extraction', 'Delete From File', 'Approve All (2)', 'Confirm'].includes(text(node)))
    .map(button => button.props.onClick);
  h.click('Confirm', 701);
  for (const handler of handlers) handler(); await h.settle();
  assert.equal(h.requests('reviewAssignmentDocumentCandidate').length, 1);
  assert.equal(h.requests('reprocessAssignmentDocument').length, 0);
  assert.equal(h.requests('deleteAssignmentDocument').length, 0);
  assert.equal(h.requests('confirmAllAssignmentDocumentCandidates').length, 0);
  h.candidateInput(702).props.onChange({ target: { value: 'Unrelated draft' } }); h.flush();
  assert.equal(h.candidateInput(702).props.value, 'Unrelated draft');
  pending.reject(new Error('synthetic save failed')); await h.settle();
  assert.equal(h.candidateInput(701).props.disabled, false);
});

test('submitted select inputs reject queued changes while review is pending', async t => {
  const pending = deferred();
  const h = harness({ documents: [document(7)], api: {
    getAssignmentDocument: async id => document(id, { candidates: [{ ...candidate(701, 'Yes'), field_key: 'contract_personal_property_included' }] }),
    reviewAssignmentDocumentCandidate: () => pending.promise,
  } });
  t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
  h.candidateInput(701).props.onChange({ target: { value: 'No' } }); h.flush();
  const queued = h.candidateInput(701).props.onChange; h.click('Confirm', 701);
  assert.equal(h.candidateInput(701).type, 'select'); assert.equal(h.candidateInput(701).props.disabled, true);
  queued({ target: { value: 'Yes' } }); h.flush(); assert.equal(h.candidateInput(701).props.value, 'No');
  pending.reject(new Error('synthetic save failed')); await h.settle();
  assert.equal(h.candidateInput(701).props.value, 'No'); assert.equal(h.candidateInput(701).props.disabled, false);
});

const documentActions = [
  { name: 'reprocess', button: 'Re-run Extraction', custom: 'reprocessAssignmentDocument', uad: 'reprocessUadDocument' },
  { name: 'delete', button: 'Delete From File', custom: 'deleteAssignmentDocument', uad: 'deleteUadDocument' },
];
for (const action of documentActions) for (const mode of ['Custom', 'UAD']) {
  test(`${mode} stale ${action.name} completion preserves the new document draft and preview`, async t => {
    const pending = deferred();
    const metadata = id => document(id, { candidates: [candidate(id * 100 + 1, `Document ${id}`)] });
    const apiName = mode === 'UAD' ? action.uad : action.custom;
    const h = harness({ props: mode === 'UAD' ? { uadWorkfileId: 'synthetic-uad-77' } : {}, documents: [document(7), document(8)], api: {
      getAssignmentDocument: async id => metadata(id), getUadDocument: async (_workfile, id) => metadata(id),
      [apiName]: () => pending.promise,
    } });
    t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
    h.click(action.button); assert.equal(h.requests(apiName).length, 1);
    h.select(8); await h.settle();
    h.candidateInput(801).props.onChange({ target: { value: 'Current B draft' } }); h.flush();
    const before = h.calls.length;
    pending.resolve(action.name === 'reprocess' ? metadata(7) : undefined); await h.settle();
    assert.equal(h.candidateInput(801)?.props.value, 'Current B draft');
    assert.equal(h.preview?.props.title, 'Synthetic PDF 8');
    assert.equal(h.calls.length, before, 'stale actions do not start nested refreshes');
  });
}

for (const action of documentActions) for (const mode of ['Custom', 'UAD']) {
  for (const transition of ['round trip', 'scope', 'read-only', 'unmount', 'newer review', ...(mode === 'Custom' ? ['account'] : [])]) {
    for (const outcome of ['success', 'failure']) {
      test(`${mode} ${action.name} ignores stale ${outcome} after ${transition}`, async t => {
        const pending = deferred(), newer = deferred();
        const metadata = id => document(id, { candidates: [candidate(id * 100 + 1, `Document ${id}`)] });
        const apiName = mode === 'UAD' ? action.uad : action.custom;
        const h = harness({ props: mode === 'UAD' ? { uadWorkfileId: 'synthetic-uad-77' } : {}, documents: [document(7), document(8)], api: {
          getAssignmentDocument: async id => metadata(id), getUadDocument: async (_workfile, id) => metadata(id),
          [apiName]: () => pending.promise,
          reviewAssignmentDocumentCandidate: () => newer.promise, reviewUadDocumentCandidate: () => newer.promise,
        } });
        t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
        h.candidateInput(701).props.onChange({ target: { value: 'Current draft' } }); h.flush(); h.click(action.button);
        let selectedId = 7;
        if (transition === 'unmount') h.cleanup();
        else if (transition === 'read-only') { h.render({ readOnly: true }); h.flush(); }
        else {
          if (transition === 'scope' || transition === 'account') {
            h.render(transition === 'account' ? { accountId: 'OTHER-ACCOUNT' }
              : mode === 'UAD' ? { uadWorkfileId: 'synthetic-uad-78' } : { assignmentFileId: 15 }); await h.settle();
            h.select(7); await h.settle();
          } else {
            h.select(8); await h.settle(); selectedId = 8;
            if (transition === 'round trip') { h.select(7); await h.settle(); selectedId = 7; }
          }
          h.candidateInput(selectedId * 100 + 1).props.onChange({ target: { value: 'Current draft' } }); h.flush();
          if (transition === 'newer review') h.click('Confirm', 801);
        }
        const before = h.calls.length;
        if (outcome === 'failure') pending.reject(new Error('stale document action failed'));
        else pending.resolve(action.name === 'reprocess' ? metadata(7) : undefined);
        await h.settle();
        assert.equal(h.calls.length, before, 'stale actions do not refresh or apply anything');
        assert.deepEqual(h.lateStateWrites, []);
        if (transition !== 'unmount') {
          assert.equal(h.candidateInput(selectedId * 100 + 1)?.props.value, 'Current draft');
          assert.equal(h.preview?.props.title, `Synthetic PDF ${selectedId}`);
          assert.doesNotMatch(h.text, /stale document action failed|Extraction completed|permanently deleted/);
          if (transition === 'newer review') {
            assert.equal(h.candidateInput(801).props.disabled, true, 'old finally cannot release a newer operation');
            newer.reject(new Error('current review failed')); await h.settle();
            assert.equal(h.candidateInput(801).props.disabled, false);
          }
        }
      });
    }
  }
}

for (const mode of ['Custom', 'UAD']) {
  test(`${mode} current reprocess preserves drafts, refreshes suggestions, and finishes its own lifecycle`, async t => {
    let refreshed = false;
    const original = pdf();
    const metadata = id => document(id, { candidates: [candidate(701, refreshed ? 'Fresh server suggestion' : 'Original'),
      ...(refreshed ? [candidate(702, 'New extracted field')] : [])] });
    const reprocess = async () => { refreshed = true; return metadata(7); };
    const h = harness({ props: mode === 'UAD' ? { uadWorkfileId: 'synthetic-uad-77' } : {}, documents: [document(7)], api: {
      getAssignmentDocument: async id => metadata(id), getUadDocument: async (_workfile, id) => metadata(id),
      getAssignmentDocumentContent: async () => original, getUadDocumentContent: async () => original,
      reprocessAssignmentDocument: reprocess, reprocessUadDocument: reprocess,
    } });
    t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
    h.candidateInput(701).props.onChange({ target: { value: 'Local draft' } }); h.flush(); h.click('Re-run Extraction'); await h.settle();
    assert.equal(h.candidateInput(701).props.value, 'Local draft');
    assert.equal(h.candidateInput(702).props.value, 'New extracted field');
    assert.equal(h.preview.props.blob, original);
    assert.match(h.text, /Extraction completed with the current document rules/);
    assert.equal(h.requests(mode === 'UAD' ? 'getUadDocument' : 'getAssignmentDocument').length, mode === 'UAD' ? 2 : 1);
    assert.equal(h.requests(mode === 'UAD' ? 'getUadDocumentContent' : 'getAssignmentDocumentContent').length, 1);
    const button = nodes(h.tree, node => node.type === 'button' && text(node) === 'Re-run Extraction')[0];
    assert.equal(button.props.disabled, false, 'the UAD nested refresh does not invalidate its own cleanup');
  });

  test(`${mode} current delete clears only its document and supports selecting the next PDF`, async t => {
    let confirmed = 0;
    const metadata = id => document(id, { candidates: [candidate(id * 100 + 1, `Document ${id}`)] });
    const h = harness({ props: mode === 'UAD' ? { uadWorkfileId: 'synthetic-uad-77' } : {}, documents: [document(7), document(8)],
      confirm: () => { confirmed++; return true; }, api: {
        getAssignmentDocument: async id => metadata(id), getUadDocument: async (_workfile, id) => metadata(id),
        deleteAssignmentDocument: async () => {}, deleteUadDocument: async () => {},
      } });
    t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
    h.candidateInput(701).props.onChange({ target: { value: 'Old draft' } }); h.flush(); h.click('Delete From File'); await h.settle();
    assert.equal(confirmed, 1); assert.equal(h.preview, null); assert.equal(h.candidateInput(701), null);
    assert.equal(nodes(h.tree, node => node.type === 'button' && node.key === 7).length, 0);
    assert.match(h.text, /Synthetic PDF 7.*permanently deleted/);
    h.select(8); await h.settle();
    assert.equal(h.candidateInput(801).props.value, 'Document 8'); assert.equal(h.preview.props.title, 'Synthetic PDF 8');
    assert.equal(nodes(h.tree, node => node.type === 'button' && text(node) === 'Delete From File')[0].props.disabled, false);
  });
}

test('cancelled delete starts no operation and preserves the selected document', async t => {
  const h = harness({ documents: [document(7)], confirm: () => false });
  t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
  const before = h.calls.length; h.click('Delete From File'); await h.settle();
  assert.equal(h.calls.length, before); assert.equal(h.preview.props.title, 'Synthetic PDF 7');
});

const manualUadActions = [
  { name: 'contract synchronization', button: 'Sync Approved Contract to UAD 3.6', api: 'synchronizeUadPurchaseContract' },
  { name: 'confirmed-field application', button: 'Apply Confirmed Fields', api: 'applyUadDocumentCandidate' },
];
function manualUadDocument(action, id) {
  if (id !== 7) return document(id, { candidates: [candidate(id * 100 + 1, `Document ${id}`)] });
  return document(id, {
    document_type: action.name === 'contract synchronization' ? 'purchase_contract' : 'engagement_letter',
    extraction_summary: { subject_address_override: { acknowledged: true, reviewer: 'Synthetic Reviewer' } },
    candidates: [{ ...candidate(701, '123 Synthetic Road'), field_key: 'subject_property_address', review_status: 'confirmed', confirmed_value: '123 Synthetic Road' },
      { ...candidate(702, 'Synthetic county'), review_status: 'confirmed', confirmed_value: 'Synthetic county' }],
  });
}
for (const action of manualUadActions) {
  test(`stale manual UAD ${action.name} stops callbacks and further writes after navigation`, async t => {
    const pending = deferred(), applied = [];
    const h = harness({ props: { uadWorkfileId: 'synthetic-uad-77', onUadApplied: value => applied.push(value) }, documents: [document(7), document(8)],
      presentation: { documentSubjectAddressComparison: () => ({ matches: false }) }, api: {
        getUadDocument: async (_workfile, id) => manualUadDocument(action, id), [action.api]: () => pending.promise,
      } });
    t.after(h.cleanup); await h.settle(); h.select(7); await h.settle(); h.click(action.button);
    assert.equal(h.requests(action.api).length, 1); h.select(8); await h.settle();
    h.candidateInput(801).props.onChange({ target: { value: 'Current B draft' } }); h.flush();
    const before = h.calls.length;
    pending.resolve({ applied: true, changed_field_count: 1 }); await h.settle();
    assert.deepEqual(applied, []); assert.equal(h.calls.length, before);
    assert.equal(h.candidateInput(801).props.value, 'Current B draft');
    assert.doesNotMatch(h.text, /Reapplied|contract information synchronized/);
  });
}

for (const action of manualUadActions) for (const transition of ['round trip', 'scope', 'read-only', 'unmount', 'newer review']) {
  for (const outcome of ['success', 'failure']) {
    test(`manual UAD ${action.name} ignores stale ${outcome} after ${transition}`, async t => {
      const pending = deferred(), newer = deferred(), applied = [];
      const h = harness({ props: { uadWorkfileId: 'synthetic-uad-77', onUadApplied: value => applied.push(value) }, documents: [document(7), document(8)],
        presentation: { documentSubjectAddressComparison: () => ({ matches: false }) }, api: {
          getUadDocument: async (_workfile, id) => manualUadDocument(action, id), [action.api]: () => pending.promise,
          reviewUadDocumentCandidate: () => newer.promise,
        } });
      t.after(h.cleanup); await h.settle(); h.select(7); await h.settle(); h.click(action.button);
      if (transition === 'unmount') h.cleanup();
      else if (transition === 'read-only') { h.render({ readOnly: true }); h.flush(); }
      else if (transition === 'scope') { h.render({ uadWorkfileId: 'synthetic-uad-78' }); await h.settle(); h.select(7); await h.settle(); }
      else {
        h.select(8); await h.settle();
        if (transition === 'round trip') { h.select(7); await h.settle(); }
        else h.click('Confirm', 801);
      }
      const before = h.calls.length;
      if (outcome === 'failure') pending.reject(new Error('stale manual UAD action failed'));
      else pending.resolve({ applied: true, changed_field_count: 1 });
      await h.settle();
      assert.deepEqual(applied, []); assert.deepEqual(h.lateStateWrites, []);
      assert.equal(h.calls.length, before, 'a stale apply loop cannot start the next field or any reload');
      if (transition !== 'unmount') {
        assert.doesNotMatch(h.text, /stale manual UAD action failed|Reapplied|contract information synchronized/);
        if (transition === 'newer review') {
          assert.equal(h.candidateInput(801).props.disabled, true);
          newer.reject(new Error('current review failed')); await h.settle();
          assert.equal(h.candidateInput(801).props.disabled, false);
        }
      }
    });
  }
}

for (const action of manualUadActions) for (const outcome of ['success', 'failure']) {
  test(`current manual UAD ${action.name} handles ${outcome} and releases its busy state`, async t => {
    const applied = [];
    const h = harness({ props: { uadWorkfileId: 'synthetic-uad-77', onUadApplied: value => applied.push(value) }, documents: [document(7)],
      presentation: { documentSubjectAddressComparison: () => ({ matches: false }) }, api: {
        getUadDocument: async (_workfile, id) => manualUadDocument(action, id),
        [action.api]: async () => {
          if (outcome === 'failure') throw new Error('current manual action failed');
          return { applied: true, changed_field_count: 1 };
        },
      } });
    t.after(h.cleanup); await h.settle(); h.select(7); await h.settle(); h.click(action.button); await h.settle();
    if (outcome === 'failure') { assert.match(h.text, /current manual action failed/); assert.deepEqual(applied, []); }
    else {
      assert.equal(applied.length, action.name === 'contract synchronization' ? 1 : 2);
      assert.match(h.text, action.name === 'contract synchronization' ? /contract information synchronized/ : /Reapplied 2 confirmed/);
    }
    const button = nodes(h.tree, node => node.type === 'button' && text(node) === action.button)[0];
    assert.ok(button); assert.equal(button.props.disabled, false);
  });
}

test('Custom Apply Confirmed Fields still applies current reviewed values synchronously', async t => {
  const applied = [], action = manualUadActions[1];
  const h = harness({ props: { onApplyConfirmedCandidate: (...args) => applied.push(args) }, documents: [document(7)],
    presentation: { documentSubjectAddressComparison: () => ({ matches: false }),
      confirmedDocumentFieldApplications: values => values.filter(value => value.review_status === 'confirmed')
        .map(value => ({ fieldKey: value.field_key, value: value.confirmed_value })),
    }, api: { getAssignmentDocument: async id => manualUadDocument(action, id) } });
  t.after(h.cleanup); await h.settle(); h.select(7); await h.settle(); h.click('Apply Confirmed Fields'); await h.settle();
  assert.equal(applied.length, 2); assert.equal(applied[0][1], '123 Synthetic Road');
  assert.match(h.text, /Confirmed engagement fields were reapplied/);
  assert.equal(nodes(h.tree, node => node.type === 'button' && text(node) === 'Apply Confirmed Fields')[0].props.disabled, false);
});

for (const mode of ['Custom', 'UAD']) for (const boundary of ['list', ...(mode === 'UAD' ? ['document'] : [])]) {
  for (const transition of ['navigation', 'read-only']) for (const outcome of ['success', 'failure']) {
    test(`${mode} reprocess owns its nested ${boundary} reload across ${transition} and ${outcome}`, async t => {
      const pending = deferred(); let gets = 0, lists = 0;
      const metadata = id => document(id, { candidates: [candidate(id * 100 + 1, `Document ${id}`)] });
      const get = async id => id === 7 && ++gets === 2 && boundary === 'document' ? pending.promise : metadata(id);
      const list = async () => ++lists === 2 && boundary === 'list' ? pending.promise : [document(7), document(8)];
      const h = harness({ props: mode === 'UAD' ? { uadWorkfileId: 'synthetic-uad-77' } : {}, api: {
        getAssignmentDocuments: list, listUadDocuments: list, getAssignmentDocument: get, getUadDocument: async (_workfile, id) => get(id),
        reprocessAssignmentDocument: async () => metadata(7), reprocessUadDocument: async () => metadata(7),
      } });
      t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
      h.click('Re-run Extraction'); await h.settle(); assert.equal(boundary === 'list' ? lists : gets, 2);
      let selectedId = 7;
      if (transition === 'navigation') { h.select(8); await h.settle(); selectedId = 8; }
      h.candidateInput(selectedId * 100 + 1).props.onChange({ target: { value: 'Keep current draft' } }); h.flush();
      if (transition === 'read-only') { h.render({ readOnly: true }); h.flush(); }
      const before = h.calls.length;
      if (outcome === 'failure') pending.reject(new Error('stale nested reprocess reload failed'));
      else pending.resolve(boundary === 'list' ? [metadata(7)] : metadata(7));
      await h.settle();
      assert.equal(h.candidateInput(selectedId * 100 + 1)?.props.value, 'Keep current draft');
      assert.equal(h.preview?.props.title, `Synthetic PDF ${selectedId}`);
      assert.doesNotMatch(h.text, /stale nested reprocess reload failed|Extraction completed/);
      assert.equal(h.calls.length, before);
    });
  }
}

for (const mode of ['Custom', 'UAD']) {
  test(`${mode} successful delete invalidates an older metadata poll before it can resurrect the PDF`, async t => {
    const deletion = deferred(), poll = deferred(); let requests = 0;
    const metadata = id => document(id, { processing_status: 'processing', candidates: [candidate(701, 'Original')] });
    const get = async id => ++requests === 2 ? poll.promise : metadata(id);
    const h = harness({ props: mode === 'UAD' ? { uadWorkfileId: 'synthetic-uad-77' } : {}, documents: [document(7)], api: {
      getAssignmentDocument: get, getUadDocument: async (_workfile, id) => get(id),
      deleteAssignmentDocument: () => deletion.promise, deleteUadDocument: () => deletion.promise,
    } });
    t.after(h.cleanup); await h.settle(); h.select(7); await h.settle(); h.click('Delete From File'); h.poll(); await h.settle();
    deletion.resolve(); await h.settle(); assert.equal(h.preview, null);
    poll.resolve(metadata(7)); await h.settle();
    assert.equal(h.preview, null); assert.equal(h.candidateInput(701), null);
    assert.equal(nodes(h.tree, node => node.type === 'button' && node.key === 7).length, 0);
    assert.match(h.text, /permanently deleted/); assert.equal(h.timers.size, 0);
  });
}

test('partially failed UAD approve-all acknowledges only successfully reviewed candidates', async t => {
  let serverValue = 'A';
  const h = harness({ props: { uadWorkfileId: 'synthetic-uad-77' }, documents: [document(7)], api: {
    getUadDocument: async (_workfile, id) => document(id, { processing_status: 'processing',
      candidates: [candidate(701, serverValue), candidate(702, serverValue)] }),
    reviewUadDocumentCandidate: async (_workfile, _document, id) => {
      if (id === 702) throw new Error('synthetic second save failed');
      return {};
    },
    applyUadDocumentCandidate: async () => ({ applied: false }),
  } });
  t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
  h.candidateInput(701).props.onChange({ target: { value: 'B' } });
  h.candidateInput(702).props.onChange({ target: { value: '' } }); h.flush();
  h.click('Approve All (2)'); await h.settle(); assert.match(h.text, /synthetic second save failed/);
  assert.equal(h.requests('reviewUadDocumentCandidate')[1].args[3].confirmedValue, '');
  serverValue = 'C'; h.poll(); await h.settle();
  assert.equal(h.candidateInput(701).props.value, 'C');
  assert.equal(h.candidateInput(702).props.value, '');
});

for (const route of saveRoutes.filter(route => !route.single)) {
  test(`${route.name} does not acknowledge a dirty candidate already reviewed by the server`, async t => {
    let stage = 0;
    const metadata = id => document(id, { processing_status: 'processing',
      document_type: route.override ? 'engagement_letter' : route.contract ? 'purchase_contract' : 'mls_sheet',
      candidates: [
        { ...candidate(701, stage === 0 ? 'A' : 'Server change'),
          field_key: route.override ? 'subject_property_address' : 'county',
          review_status: stage === 1 ? 'confirmed' : 'suggested' },
        candidate(702, 'Other value'),
      ] });
    const save = async () => route.override ? metadata(7) : { document: metadata(7), application: {} };
    const h = harness({ props: route.uad ? { uadWorkfileId: 'synthetic-uad-77' } : {}, documents: [document(7)],
      presentation: route.override ? {
        assignmentDocumentConfirmationBlocked: () => true,
        documentSubjectAddressComparison: () => ({ matches: false }),
      } : {}, api: {
        getAssignmentDocument: async id => metadata(id), getUadDocument: async (_workfile, id) => metadata(id),
        [route.apiName]: save, applyUadDocumentCandidate: async () => ({ applied: false }),
      } });
    t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
    h.candidateInput(701).props.onChange({ target: { value: 'Unsaved local edit' } }); h.flush();
    stage = 1; h.poll(); await h.settle(); assert.equal(h.candidateInput(701), null);
    h.click(route.button); await h.settle(); assert.equal(h.requests(route.apiName).length, 1);
    stage = 2; h.poll(); await h.settle();
    assert.equal(h.candidateInput(701).props.value, 'Unsaved local edit',
      'bulk endpoints save only suggested candidates, not every entry in candidateValues');
  });
}

test('removed candidates lose old edit intent even if the ID reappears in a later extraction', async t => {
  let stage = 0;
  const h = harness({ documents: [document(7)], api: {
    getAssignmentDocument: async id => document(id, { processing_status: 'processing',
      candidates: stage === 1 ? [] : [candidate(701, stage === 0 ? 'A' : `Fresh ${stage}`)] }),
  } });
  t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
  h.candidateInput(701).props.onChange({ target: { value: 'Old edit' } }); h.flush();
  stage = 1; h.poll(); await h.settle(); assert.equal(h.candidateInput(701), null);
  stage = 2; h.poll(); await h.settle(); assert.equal(h.candidateInput(701).props.value, 'Fresh 2');
  stage = 3; h.poll(); await h.settle(); assert.equal(h.candidateInput(701).props.value, 'Fresh 3');
});

test('a select input keeps explicit edits when the server first matches and then changes', async t => {
  let serverValue = 'Yes';
  const h = harness({ documents: [document(7)], api: {
    getAssignmentDocument: async id => document(id, { processing_status: 'processing',
      candidates: [{ ...candidate(701, serverValue), field_key: 'contract_personal_property_included' }] }),
  } });
  t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
  assert.equal(h.candidateInput(701).type, 'select');
  h.candidateInput(701).props.onChange({ target: { value: 'No' } }); h.flush();
  serverValue = 'No'; h.poll(); await h.settle();
  serverValue = 'Yes'; h.poll(); await h.settle();
  assert.equal(h.candidateInput(701).props.value, 'No');
});

for (const mode of ['Custom', 'UAD']) {
  test(`${mode} processing polls keep failed-preview drafts and errors without re-requesting PDF bytes`, async t => {
    let metadataRequests = 0, contentRequests = 0;
    const metadata = id => document(id, { processing_status: ++metadataRequests < 3 ? 'processing' : 'review_required',
      candidates: [candidate(701, 'Initial suggestion'), candidate(702, `Untouched ${metadataRequests}`)] });
    const content = async () => {
      if (++contentRequests === 1) throw new Error('synthetic PDF denied');
      return pdf();
    };
    const h = harness({ props: mode === 'UAD' ? { uadWorkfileId: 'synthetic-uad-77' } : {}, documents: [document(7)], api: {
      getAssignmentDocument: async id => metadata(id), getAssignmentDocumentContent: content,
      getUadDocument: async (_workfile, id) => metadata(id), getUadDocumentContent: content,
    } });
    t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
    h.candidateInput(701).props.onChange({ target: { value: 'Retain my correction' } }); h.flush();
    h.poll();
    assert.equal(h.candidateInput(701).props.value, 'Retain my correction');
    assert.match(h.text, /synthetic PDF denied/);
    await h.settle();
    assert.equal(h.preview, null); assert.equal(contentRequests, 1);
    assert.equal(h.candidateInput(701).props.value, 'Retain my correction');
    assert.equal(h.candidateInput(702).props.value, 'Untouched 2');
    assert.match(h.text, /synthetic PDF denied/);
    h.poll(); await h.settle();
    assert.equal(h.timers.size, 0, 'processing-to-ready transition stops polling');
    assert.equal(contentRequests, 1);
    h.select(7); await h.settle();
    assert.equal(contentRequests, 2, 'explicit same-document selection retries the failed PDF');
    assert.ok(h.preview); assert.doesNotMatch(h.text, /synthetic PDF denied/);
    assert.equal(h.candidateInput(701).props.value, 'Retain my correction');
  });
}

test('a stale extraction timer cannot supersede a newer document request or restore its drafts', async t => {
  const pending = deferred();
  const h = harness({ documents: [document(7), document(8)], api: {
    getAssignmentDocument: async id => document(id, { processing_status: id === 7 ? 'processing' : 'review_required',
      candidates: [candidate(701, `Document ${id} suggestion`)] }),
    getAssignmentDocumentContent: id => id === 8 ? pending.promise : Promise.resolve(pdf()),
  } });
  t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
  h.candidateInput(701).props.onChange({ target: { value: 'Old document correction' } }); h.flush();
  const staleTimer = [...h.timers.values()][0];
  h.select(8);
  assert.equal(h.candidateInput(701), null, 'a different document clears the previous review form');
  const before = h.requests('getAssignmentDocument').length;
  staleTimer(); await h.settle();
  assert.equal(h.requests('getAssignmentDocument').length, before, 'a stale timer is rejected before it starts work');
  pending.resolve(pdf('new.pdf')); await h.settle();
  assert.equal(h.preview.props.title, 'Synthetic PDF 8', 'the newer request generation still wins');
  assert.equal(h.candidateInput(701).props.value, 'Document 8 suggestion');
});

test('an earlier poll timer cannot supersede an explicit retry of the same failed PDF', async t => {
  const pending = deferred(); let contentRequests = 0;
  const h = harness({ documents: [document(7)], api: {
    getAssignmentDocument: async id => document(id, { processing_status: 'processing', candidates: [candidate(701, 'Suggestion')] }),
    getAssignmentDocumentContent: () => ++contentRequests === 1 ? Promise.reject(new Error('synthetic PDF denied')) : pending.promise,
  } });
  t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
  const staleTimer = [...h.timers.values()][0];
  h.candidateInput(701).props.onChange({ target: { value: 'Unsaved correction' } }); h.flush();
  h.select(7); staleTimer(); await h.settle();
  assert.equal(h.requests('getAssignmentDocument').length, 2);
  pending.resolve(pdf()); await h.settle();
  assert.ok(h.preview, 'the explicit retry response is still current');
  assert.equal(h.candidateInput(701).props.value, 'Unsaved correction');
});

test('candidate drafts do not cross assignment scope even when document and candidate IDs repeat', async t => {
  let sourceValue = 'First assignment';
  const h = harness({ documents: [document(7)], api: {
    getAssignmentDocument: async id => document(id, { candidates: [candidate(701, sourceValue)] }),
  } });
  t.after(h.cleanup); await h.settle(); h.select(7); await h.settle();
  h.candidateInput(701).props.onChange({ target: { value: 'Old assignment correction' } }); h.flush();
  sourceValue = 'Second assignment'; h.render({ assignmentFileId: 15 }); h.flush();
  assert.equal(h.candidateInput(701), null);
  await h.settle(); h.select(7); await h.settle();
  assert.equal(h.candidateInput(701).props.value, 'Second assignment');
});

test('newer document selection wins even when the old metadata/content resolves later', async t => {
  const pending = deferred();
  const h = harness({ documents: [document(7), document(8)], api: {
    getAssignmentDocumentContent: id => id === 7 ? pending.promise : Promise.resolve(pdf('new.pdf')),
  } });
  t.after(h.cleanup); await h.settle(); h.select(7); h.select(8); await h.settle();
  assert.equal(h.preview.props.title, 'Synthetic PDF 8');
  pending.resolve(pdf('old.pdf')); await h.settle();
  assert.equal(h.preview.props.title, 'Synthetic PDF 8');
  assert.equal(h.preview.props.blob.name, 'new.pdf');
});

for (const pendingOperation of ['list', 'document', 'upload']) {
  test(`unmount ignores late ${pendingOperation} results without state writes`, async () => {
    const pending = deferred();
    const api = pendingOperation === 'list' ? { getAssignmentDocuments: () => pending.promise }
      : pendingOperation === 'document' ? { getAssignmentDocumentContent: () => pending.promise }
        : { uploadAssignmentDocument: () => pending.promise };
    const h = harness({ documents: [document(7)], api });
    await h.settle();
    let operation;
    if (pendingOperation === 'document') h.select(7);
    if (pendingOperation === 'upload') operation = h.queue.props.onUpload(pdf(), { title: 'Synthetic', documentType: 'other' });
    h.cleanup();
    pending.resolve(pendingOperation === 'list' ? [document(7)] : pendingOperation === 'document' ? pdf() : document(20));
    await operation; await h.settle();
    assert.deepEqual(h.lateStateWrites, []);
    assert.equal(h.timers.size, 0);
  });
}
