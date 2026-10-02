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
function harness({ props: initialProps = {}, api: overrides = {}, documents = [] } = {}) {
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
    },
  };
  const { default: Component } = loadTrustedRepositoryCommonJs(source, name => {
    assert.ok(Object.hasOwn(imports, name), `unexpected component dependency ${name}`);
    return imports[name];
  }, { environment: { window: {
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
