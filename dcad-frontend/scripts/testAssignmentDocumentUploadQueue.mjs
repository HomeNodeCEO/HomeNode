import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addDocumentUploadFiles,
  createDocumentUploadRunner,
  DOCUMENT_UPLOAD_LIMITS,
  DOCUMENT_UPLOAD_TYPES,
} from '../src/components/documents/documentUploadQueue.ts';
import * as uploadQueue from '../src/components/documents/documentUploadQueue.ts';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';

const pdf = (name, overrides = {}) => ({ name, type: 'application/pdf', size: 100, lastModified: 10, ...overrides });
const queue = (...files) => addDocumentUploadFiles([], files, 'other', (() => { let id = 0; return () => String(++id); })()).items;
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

test('selection retains original files, original labels, and each selected default type', () => {
  const original = pdf('513 Hardy — MLS.PDF');
  const first = addDocumentUploadFiles([], [original], 'mls_sheet', () => 'first');
  const second = addDocumentUploadFiles(first.items, [pdf('Contract.pdf')], 'purchase_contract', () => 'second');
  assert.equal(first.items[0].file, original);
  assert.equal(first.items[0].title, original.name);
  assert.equal(first.items[0].documentType, 'mls_sheet');
  assert.equal(second.items[0], first.items[0]);
  assert.equal(second.items[1].documentType, 'purchase_contract');
  assert.equal(first.items.length, 1, 'adding files never mutates the previous queue');
  assert.deepEqual(DOCUMENT_UPLOAD_TYPES.map(([value]) => value), [
    'zoning_map', 'zoning_ordinance', 'purchase_contract', 'engagement_letter', 'mls_sheet', 'map', 'other',
  ]);
});

test('PDF validation accepts empty MIME only with a PDF extension and rejects empty or oversized files', () => {
  const result = addDocumentUploadFiles([], [
    pdf('accepted.PDF', { type: '' }), pdf('image.jpg', { type: 'image/jpeg' }),
    pdf('unknown', { type: '' }), pdf('empty.pdf', { size: 0 }),
    pdf('too-large.pdf', { size: DOCUMENT_UPLOAD_LIMITS.fileBytes + 1 }),
    pdf('maximum.pdf', { size: DOCUMENT_UPLOAD_LIMITS.fileBytes }),
  ], 'other');
  assert.deepEqual(result.items.map(item => item.file.name), ['accepted.PDF', 'maximum.pdf']);
  assert.equal(result.messages.length, 4);
});

test('queue limits count existing files and retain later files that fit the remaining byte budget', () => {
  const twenty = addDocumentUploadFiles([], Array.from({ length: 21 }, (_, i) => pdf(`${i}.pdf`)), 'other');
  assert.equal(twenty.items.length, 20);
  assert.match(twenty.messages[0], /20 files/);
  const full = queue(...Array.from({ length: 4 }, (_, i) => pdf(`${i}.pdf`, { size: DOCUMENT_UPLOAD_LIMITS.fileBytes })));
  const rejected = addDocumentUploadFiles(full, [pdf('overflow.pdf')], 'other');
  assert.equal(rejected.items.length, 4);
  assert.match(rejected.messages[0], /100 MiB/);
  const almostFull = queue(...Array.from({ length: 4 }, (_, i) => pdf(`${i}.pdf`, { size: DOCUMENT_UPLOAD_LIMITS.fileBytes - 1 })));
  const mixed = addDocumentUploadFiles(almostFull, [pdf('large.pdf', { size: 5 }), pdf('small.pdf', { size: 4 })], 'other');
  assert.equal(mixed.items.at(-1).file.name, 'small.pdf');
  assert.equal(mixed.items.length, 5);
});

test('duplicate selection retains failed and uploaded outcomes and recognizes duplicates within one drop', () => {
  const existing = queue(pdf('failed.pdf'), pdf('done.pdf'));
  existing[0] = { ...existing[0], status: 'failed', title: 'Edited label', error: 'Connection lost' };
  existing[1] = { ...existing[1], status: 'uploaded' };
  const result = addDocumentUploadFiles(existing, [pdf('failed.pdf'), pdf('done.pdf'), pdf('new.pdf'), pdf('new.pdf')], 'mls_sheet');
  assert.equal(result.items.length, 3);
  assert.equal(result.items[0], existing[0]);
  assert.equal(result.items[1], existing[1]);
  assert.equal(result.messages.length, 3);
});

test('uploads run sequentially, preserve edited metadata, and continue after a failure without retrying it', async () => {
  let current = queue(pdf('first.pdf'), pdf('bad.pdf'), pdf('last.pdf'));
  current[0] = { ...current[0], documentType: 'mls_sheet', title: 'Subject MLS' };
  const firstFile = current[0].file;
  const waiting = deferred();
  const calls = [];
  const updates = [];
  const runner = createDocumentUploadRunner();
  const pending = runner.run(current, {
    mode: 'queued', blocked: () => false,
    update: item => { updates.push([item.file.name, item.status]); current = current.map(row => row.id === item.id ? item : row); },
    upload: async (file, metadata) => {
      calls.push({ file, metadata });
      if (file.name === 'first.pdf') await waiting.promise;
      if (file.name === 'bad.pdf') throw new Error('Connection interrupted');
    },
  });
  assert.equal(calls.length, 1, 'the second request waits for the first');
  assert.equal(calls[0].file, firstFile);
  assert.deepEqual(calls[0].metadata, { documentType: 'mls_sheet', title: 'Subject MLS' });
  waiting.resolve();
  assert.deepEqual(await pending, { started: true, uploaded: 2, failed: 1, cancelled: false });
  assert.deepEqual(current.map(item => item.status), ['uploaded', 'failed', 'uploaded']);
  assert.equal(current[1].error, 'Connection interrupted');
  assert.deepEqual(updates, [
    ['first.pdf', 'uploading'], ['first.pdf', 'uploaded'], ['bad.pdf', 'uploading'],
    ['bad.pdf', 'failed'], ['last.pdf', 'uploading'], ['last.pdf', 'uploaded'],
  ]);
  const rerun = [];
  await runner.run(current, { mode: 'queued', blocked: () => false, update() {}, upload: async file => { rerun.push(file.name); } });
  assert.deepEqual(rerun, [], 'starting queued uploads never retries failures or successes');
  await runner.run(current, { mode: 'failed', blocked: () => false, update() {}, upload: async file => { rerun.push(file.name); } });
  assert.deepEqual(rerun, ['bad.pdf'], 'an explicit retry includes only failed files');
});

test('a synchronous runner lock prevents duplicate starts before the pending upload settles', async () => {
  const waiting = deferred();
  const runner = createDocumentUploadRunner();
  const items = queue(pdf('one.pdf'));
  let calls = 0;
  const options = { mode: 'queued', blocked: () => false, update() {}, upload: async () => { calls += 1; await waiting.promise; } };
  const first = runner.run(items, options);
  assert.equal((await runner.run(items, options)).started, false);
  assert.equal(calls, 1);
  waiting.resolve();
  assert.equal((await first).uploaded, 1);
});

for (const reason of ['disabled', 'unmounted']) {
  test(`${reason} cancellation stops pending files while retaining the in-flight success`, async () => {
    const runner = createDocumentUploadRunner();
    const waiting = deferred();
    const calls = [];
    let blocked = false;
    let current = queue(pdf('first.pdf'), pdf('later.pdf'));
    const pending = runner.run(current, {
      mode: 'queued', blocked: () => blocked,
      update: item => { current = current.map(row => row.id === item.id ? item : row); },
      upload: async file => { calls.push(file.name); await waiting.promise; },
    });
    if (reason === 'disabled') blocked = true;
    else runner.cancel();
    waiting.resolve();
    assert.deepEqual(await pending, { started: true, uploaded: 1, failed: 0, cancelled: true });
    assert.deepEqual(calls, ['first.pdf']);
    assert.deepEqual(current.map(item => item.status), ['uploaded', 'queued']);
  });
}

test('read-only queues issue no requests or status updates and cancellation persists through unlock until the next start', async () => {
  const runner = createDocumentUploadRunner();
  const blocked = await runner.run(queue(pdf('one.pdf')), {
    mode: 'queued', blocked: () => true,
    update() { assert.fail('read-only queue must not start'); }, upload: async () => { assert.fail('read-only upload'); },
  });
  assert.equal(blocked.started, false);
  let current = queue(pdf('first.pdf'), pdf('second.pdf'));
  const waiting = deferred();
  const pending = runner.run(current, {
    mode: 'queued', blocked: () => false,
    update: item => { current = current.map(row => row.id === item.id ? item : row); },
    upload: async () => waiting.promise,
  });
  runner.cancel();
  waiting.resolve();
  assert.equal((await pending).cancelled, true);
  const sent = [];
  await runner.run(current, { mode: 'queued', blocked: () => false, update() {}, upload: async file => { sent.push(file.name); } });
  assert.deepEqual(sent, ['second.pdf']);
});

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const nodeText = node => Array.isArray(node) ? node.map(nodeText).join('')
  : node && typeof node === 'object' ? nodeText(node.props?.children) : node == null ? '' : String(node);

function componentHarness(initialProps = {}) {
  const slots = [];
  let cursor = 0, effects = [], tree, writes = 0;
  let props = { disabled: false, onUpload: async () => {}, ...initialProps };
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], next => { writes++; slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useId() { const index = cursor++; return `queue-${index}`; },
    useEffect(effect, dependencies) {
      const index = cursor++, previous = slots[index];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        const record = { dependencies, cleanup: undefined };
        slots[index] = record;
        effects.push(() => { previous?.cleanup?.(); record.cleanup = effect(); });
      }
    },
  };
  const jsx = (type, nodeProps, key) => ({ type, props: nodeProps, key });
  const imports = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: Symbol.for('test.fragment') },
    './documentUploadQueue': uploadQueue,
  };
  const Component = loadTrustedRepositoryCommonJs(
    new URL('../src/components/documents/AssignmentDocumentUploadQueue.tsx', import.meta.url),
    key => { assert.ok(Object.hasOwn(imports, key), `unexpected dependency: ${key}`); return imports[key]; },
  ).default;
  const harness = {
    render(next = {}) {
      props = { ...props, ...next }; cursor = 0; effects = [];
      tree = Component(props);
      effects.forEach(effect => effect());
      return harness;
    },
    all(predicate) {
      const found = [];
      const visit = node => {
        if (Array.isArray(node)) node.forEach(visit);
        else if (node && typeof node === 'object') {
          if (predicate(node)) found.push(node);
          visit(node.props?.children);
        }
      };
      visit(tree); return found;
    },
    find(predicate) { const selected = harness.all(predicate); assert.equal(selected.length, 1); return selected[0]; },
    button(label) { return harness.find(node => node.type === 'button' && nodeText(node).startsWith(label)); },
    add(files) {
      const input = harness.find(node => node.type === 'input' && node.props.type === 'file');
      assert.equal(input.props.multiple, true);
      const target = { files, value: 'C:\\fakepath\\document.pdf' };
      input.props.onChange({ target });
      assert.equal(target.value, '', 'selection is cleared so the same files can be chosen again');
      return harness.render();
    },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
    get writes() { return writes; },
    get text() { return nodeText(tree); },
  };
  return harness.render();
}

for (const fails of [false, true]) {
  test(`upload notice has an empty live region before announcing ${fails ? 'failure' : 'completion'}`, async () => {
    const waiting = deferred();
    const h = componentHarness({ onUpload: async () => {
      await waiting.promise;
      if (fails) throw new Error('Connection lost');
    } });
    const notice = () => h.find(node => node.props.role === 'status');
    const assertEmptyNotice = () => {
      const region = notice();
      assert.equal(region.type, 'p');
      assert.equal(region.props['aria-live'], 'polite');
      assert.equal(region.props['aria-atomic'], 'true');
      assert.equal(nodeText(region), '');
      assert.match(region.props.className, /\bsr-only\b/);
      assert.equal(region.props.hidden, undefined);
      assert.equal(region.props['aria-hidden'], undefined);
    };
    assertEmptyNotice();
    h.add([pdf('document.pdf')]);
    assertEmptyNotice();
    h.button('Upload 1').props.onClick();
    h.render();
    assertEmptyNotice();
    waiting.resolve(); await settle(); h.render();
    const completed = notice();
    assert.equal(completed.props['aria-live'], 'polite');
    assert.equal(completed.props['aria-atomic'], 'true');
    assert.equal(nodeText(completed), fails ? '0 uploaded; 1 failed.' : '1 uploaded.');
    assert.doesNotMatch(completed.props.className, /\bsr-only\b/);
    h.unmount();
  });
}

test('actual component accepts multiple selection and drop, sends per-file edits, and blocks duplicate clicks', async () => {
  const waiting = deferred(), calls = [];
  const h = componentHarness({ onUpload: async (file, metadata) => { calls.push({ file, metadata }); if (calls.length === 1) await waiting.promise; } });
  h.find(node => node.type === 'select').props.onChange({ target: { value: 'mls_sheet' } });
  h.render().add([pdf('MLS.pdf'), pdf('Contract.pdf')]);
  h.all(node => node.type === 'select')[2].props.onChange({ target: { value: 'purchase_contract' } });
  h.render().all(node => node.type === 'input' && !node.props.type)[1].props.onChange({ target: { value: 'Signed purchase agreement' } });
  h.render();
  const drop = h.find(node => typeof node.props.onDrop === 'function');
  let prevented = false;
  drop.props.onDrop({ preventDefault() { prevented = true; }, dataTransfer: { files: [pdf('Map.pdf')] } });
  assert.equal(prevented, true);
  h.render();
  const upload = h.button('Upload 3');
  upload.props.onClick(); upload.props.onClick();
  assert.equal(calls.length, 1);
  waiting.resolve(); await settle(); h.render();
  assert.deepEqual(calls.map(({ file, metadata }) => [file.name, metadata]), [
    ['MLS.pdf', { documentType: 'mls_sheet', title: 'MLS.pdf' }],
    ['Contract.pdf', { documentType: 'purchase_contract', title: 'Signed purchase agreement' }],
    ['Map.pdf', { documentType: 'mls_sheet', title: 'Map.pdf' }],
  ]);
  assert.match(h.text, /3 uploaded/);
  h.unmount();
});

test('actual component requires an explicit retry acknowledgement and never resends uploaded rows', async () => {
  const calls = []; let rejectFirst = true, completed = 0;
  const h = componentHarness({
    onUpload: async file => { calls.push(file.name); if (file.name === 'failed.pdf' && rejectFirst) throw new Error('Connection lost'); },
    onComplete: () => { completed++; },
  });
  h.add([pdf('failed.pdf'), pdf('saved.pdf')]);
  h.button('Upload 2').props.onClick(); await settle(); h.render();
  assert.deepEqual(calls, ['failed.pdf', 'saved.pdf']);
  assert.match(h.text, /Check the attached document list before retrying/);
  assert.equal(h.button('Retry failed').props.disabled, true);
  h.button('Retry failed').props.onClick(); await settle();
  assert.equal(calls.length, 2, 'the handler itself also requires acknowledgement');
  h.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } });
  h.render(); rejectFirst = false;
  h.button('Retry failed').props.onClick(); await settle(); h.render();
  assert.deepEqual(calls, ['failed.pdf', 'saved.pdf', 'failed.pdf']);
  assert.equal(completed, 2);
  assert.match(h.text, /2 uploaded/);
  assert.equal(h.all(node => node.type === 'button' && nodeText(node).startsWith('Retry failed')).length, 0);
  h.unmount();
});

test('actual read-only transition cancels later uploads even if unlocked before the active request settles', async () => {
  const waiting = deferred(), calls = [];
  const h = componentHarness({ onUpload: async file => { calls.push(file.name); await waiting.promise; } });
  h.add([pdf('first.pdf'), pdf('second.pdf')]);
  h.button('Upload 2').props.onClick();
  h.render({ disabled: true });
  h.find(node => typeof node.props.onDrop === 'function').props.onDrop({ preventDefault() {}, dataTransfer: { files: [pdf('locked.pdf')] } });
  h.render({ disabled: false });
  waiting.resolve(); await settle(); h.render();
  assert.deepEqual(calls, ['first.pdf']);
  assert.doesNotMatch(h.text, /locked.pdf/);
  assert.match(h.text, /remaining files are still queued/);
  h.button('Upload 1').props.onClick(); await settle();
  assert.deepEqual(calls, ['first.pdf', 'second.pdf']);
  h.unmount();
});

test('actual unmount stops later uploads and prevents completion callbacks and late state writes', async () => {
  const waiting = deferred(), calls = [];
  const h = componentHarness({
    onUpload: async file => { calls.push(file.name); await waiting.promise; },
    onComplete: () => assert.fail('unmounted queue cannot refresh another assignment'),
  });
  h.add([pdf('first.pdf'), pdf('second.pdf')]); h.button('Upload 2').props.onClick();
  h.unmount(); const writes = h.writes;
  waiting.resolve(); await settle();
  assert.deepEqual(calls, ['first.pdf']);
  assert.equal(h.writes, writes);
});
