import assert from 'node:assert/strict';
import test from 'node:test';
import * as jsx from 'react/jsx-runtime';
import * as lifecycle from '../src/components/documents/assignmentPdfPreviewLifecycle.ts';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const children = (node) => [node?.props?.children].flat(Infinity);
const walk = (node) => node && typeof node === 'object' ? [node, ...children(node).flatMap(walk)] : [];
const text = (node) => typeof node === 'string' || typeof node === 'number' ? String(node)
  : node && typeof node === 'object' ? children(node).map(text).join(' ') : '';
const same = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));

// Uses the repository's file-backed module harness and deterministic hook
// dispatcher. Lifecycle helpers execute unchanged; no generated string eval.
function harness(initialBlob, { simulateScrollbars = false } = {}) {
  const cells = [], effects = [], loads = [], renders = [], revoked = [], created = [];
  let cursor = 0, dirty = false, tree, props = { blob: initialBlob, title: 'Contract.pdf' };
  let resizeCallback, previousWidth;
  const host = { canvas: null, style: {}, replaceChildren(canvas) { this.canvas = canvas; } };
  const container = { style: {}, get clientWidth() {
    const scrollbar = this.style.scrollbarGutter === 'stable' || (host.style.display !== 'none' && host.canvas?.height > 300);
    return simulateScrollbars && scrollbar ? 620 : 636;
  } };
  const resize = () => { if (previousWidth !== container.clientWidth) { previousWidth = container.clientWidth; resizeCallback?.(); } };
  const react = {
    useState(initial) { const i = cursor++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [cells[i].value, (next) => { const value = typeof next === 'function' ? next(cells[i].value) : next;
        if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; cells[i] ??= { current: initial }; return cells[i]; },
    useMemo(factory, deps) { const i = cursor++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { deps, value: factory() }; return cells[i].value; },
    useEffect(setup, deps) { const i = cursor++, old = cells[i]; if (old && same(old.deps, deps)) return;
      const cell = { deps, cleanup: old?.cleanup }; cells[i] = cell;
      effects.push(() => { cell.cleanup?.(); cell.cleanup = setup(); }); },
  };
  const dependencies = {
    react, 'react/jsx-runtime': jsx,
    './assignmentPdfPreviewLifecycle': lifecycle,
    'pdfjs-dist/build/pdf.worker.mjs?url': { default: '/assets/pdf.worker.mjs', __esModule: true },
    'pdfjs-dist': {
      GlobalWorkerOptions: {},
      getDocument(options) { const pending = deferred(), task = { options, pending, destroyed: 0,
        promise: pending.promise, destroy: async () => { task.destroyed++; } }; loads.push(task); return task; },
    },
  };
  const component = loadTrustedRepositoryCommonJs(new URL('../src/components/documents/AssignmentPdfPreview.tsx', import.meta.url),
    (key) => { assert.ok(Object.hasOwn(dependencies, key), `Unexpected dependency ${key}`); return dependencies[key]; }, {
      environment: {
        URL: { createObjectURL(blob) { const url = `blob:preview-${created.length}`; created.push({ blob, url }); return url; }, revokeObjectURL: (url) => revoked.push(url) },
        ResizeObserver: class { constructor(callback) { resizeCallback = callback; } observe() {} disconnect() { resizeCallback = undefined; } },
        window: { devicePixelRatio: 2, document: { createElement(tag) {
          assert.equal(tag, 'canvas');
          return { style: {}, width: 0, height: 0, setAttribute() {}, getContext: () => ({}), remove() { if (host.canvas === this) host.canvas = null; } };
        } } },
      },
    }).default;
  function render(next = props) {
    props = next; cursor = 0; dirty = false; tree = component(props);
    for (const node of walk(tree)) if (node.props.ref) {
      const element = node.props.className?.includes('max-h-') ? container : host;
      node.props.ref.current = element; element.style = node.props.style ?? {};
    }
    effects.splice(0).forEach((effect) => effect());
    resize();
  }
  function flush() { let count = 0; while (dirty) { assert.ok(++count < 30, 'preview render loop'); render(); } }
  const document = (pages = 3) => ({ numPages: pages, getPage: async (number) => ({
    getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale }),
    render({ canvas }) { const task = { number, canvas, cancelled: 0, promise: Promise.resolve(), cancel() { this.cancelled++; } }; renders.push(task); return task; },
  }) });
  render(); flush();
  return {
    loads, renders, created, revoked, host, document,
    nodes: () => walk(tree), text: () => text(tree),
    update(blob) { render({ ...props, blob }); flush(); },
    async settle() { for (let i = 0; i < 20; i++) { await Promise.resolve(); resize(); flush(); } },
    click(label) { const button = walk(tree).find((node) => node.type === 'button' && text(node) === label);
      assert.ok(button); assert.equal(button.props.disabled, false); button.props.onClick(); flush(); },
    zoom(value) { walk(tree).find((node) => node.type === 'select').props.onChange({ target: { value: String(value) } }); flush(); },
    unmount() { cells.forEach((cell) => cell.cleanup?.()); },
  };
}

test('PDF component revokes old URLs and never reuses a destroyed A proxy after A→B→A', async () => {
  const a = new Blob(['a']), b = new Blob(['b']), h = harness(a);
  await h.settle(); h.loads[0].pending.resolve(h.document()); await h.settle();
  assert.ok(h.host.canvas);
  assert.equal(h.nodes().some((node) => node.type === 'iframe'), false);
  h.update(b); await h.settle();
  assert.equal(h.loads[0].destroyed, 1);
  assert.deepEqual(h.revoked, ['blob:preview-0']);
  h.update(a); await h.settle();
  assert.equal(h.loads.length, 3);
  assert.equal(h.host.canvas, null);
  h.loads[1].pending.resolve(h.document()); await h.settle();
  assert.equal(h.host.canvas, null);
  h.loads[2].pending.resolve(h.document(2)); await h.settle();
  assert.ok(h.host.canvas);
  const link = h.nodes().find((node) => node.type === 'a' && text(node) === 'Open PDF');
  assert.equal(link.props.href, 'blob:preview-2');
  assert.equal(link.props.rel, 'noopener noreferrer');
  h.unmount();
  assert.deepEqual(h.revoked, ['blob:preview-0', 'blob:preview-1', 'blob:preview-2']);
  assert.deepEqual(h.loads.map((task) => task.destroyed), [1, 1, 1]);
});

test('PDF component navigates and zooms using separate canvases and resets selection for a new Blob', async () => {
  const h = harness(new Blob(['a']));
  await h.settle(); h.loads[0].pending.resolve(h.document(2)); await h.settle();
  const first = h.host.canvas;
  h.click('Next page'); await h.settle();
  assert.notEqual(h.host.canvas, first);
  assert.equal(h.renders.at(-1).number, 2);
  assert.equal(h.nodes().find((node) => node.type === 'button' && text(node) === 'Next page').props.disabled, true);
  h.zoom(2); await h.settle();
  assert.equal(h.host.canvas.style.width, '1224px');
  assert.equal(h.host.canvas.style.height, '1584px');
  assert.equal(h.host.canvas.style.maxWidth, 'none', 'global responsive canvas rule must not clamp a zoomed page');
  assert.equal(parseFloat(h.host.canvas.style.width) / parseFloat(h.host.canvas.style.height), 612 / 792);
  h.update(new Blob(['b'])); await h.settle(); h.loads[1].pending.resolve(h.document(5)); await h.settle();
  assert.equal(h.renders.at(-1).number, 1);
  assert.equal(h.host.canvas.style.width, '612px');
  h.unmount();
});

test('PDF component preserves open/download fallback on a generic load error', async () => {
  const h = harness(new Blob(['bad']));
  await h.settle(); h.loads[0].pending.reject(new Error('private parser details')); await h.settle();
  assert.ok(h.nodes().some((node) => node.props.role === 'alert'));
  assert.doesNotMatch(h.text(), /private parser details/);
  assert.equal(h.nodes().filter((node) => node.type === 'a').length, 2);
  assert.equal(h.nodes().find((node) => node.type === 'a' && text(node) === 'Download PDF').props.download, 'Contract.pdf');
  h.unmount();
});

test('PDF preview reaches ready state when a tall page would otherwise toggle scrollbars', async () => {
  const h = harness(new Blob(['a']), { simulateScrollbars: true });
  await h.settle(); h.loads[0].pending.resolve(h.document()); await h.settle();
  assert.equal(h.nodes().some((node) => node.props.role === 'status'), false);
  assert.equal(h.host.style.visibility, 'visible');
  assert.ok(h.renders.length < 4, 'scrollbar changes repeatedly restarted rendering');
  h.zoom(2); await h.settle();
  assert.equal(h.nodes().some((node) => node.props.role === 'status'), false);
  assert.equal(h.host.style.visibility, 'visible');
  h.unmount();
});
