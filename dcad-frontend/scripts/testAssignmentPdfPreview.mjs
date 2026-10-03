import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadPdfPreview, renderPdfPreviewPage, pdfPreviewGeometry,
  PDF_PREVIEW_MAX_DIMENSION, PDF_PREVIEW_MAX_PIXELS,
} from '../src/components/documents/assignmentPdfPreviewLifecycle.ts';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('PDF preview uses the original Blob bytes and releases its loading task once', async () => {
  const blob = new Blob([new Uint8Array([37, 80, 68, 70])]);
  const document = { numPages: 3 };
  let destroyed = 0;
  const ready = [], errors = [];
  const stop = loadPdfPreview(blob, (bytes) => {
    assert.deepEqual([...bytes], [37, 80, 68, 70]);
    return { promise: Promise.resolve(document), destroy: async () => { destroyed++; } };
  }, (pdf) => ready.push(pdf), () => errors.push(true));
  await settle();
  assert.deepEqual(ready, [document]);
  assert.deepEqual(errors, []);
  stop(); stop();
  assert.equal(destroyed, 1);
});

test('PDF preview cancellation before bytes resolve never creates a worker', async () => {
  const bytes = deferred();
  let created = 0, notified = 0;
  const stop = loadPdfPreview({ arrayBuffer: () => bytes.promise }, () => { created++; }, () => { notified++; }, () => { notified++; });
  stop();
  bytes.resolve(new ArrayBuffer(4));
  await settle();
  assert.equal(created, 0);
  assert.equal(notified, 0);
});

for (const outcome of ['resolve', 'reject']) test(`PDF preview ignores stale worker ${outcome} after replacement`, async () => {
  const pending = deferred();
  let destroyed = 0, notified = 0;
  const stop = loadPdfPreview(new Blob(['pdf']), () => ({ promise: pending.promise, destroy: async () => { destroyed++; } }),
    () => { notified++; }, () => { notified++; });
  await settle();
  stop();
  pending[outcome](outcome === 'resolve' ? { numPages: 4 } : new Error('cancelled'));
  await settle();
  assert.equal(destroyed, 1);
  assert.equal(notified, 0);
});

test('PDF preview reports a load failure and contains task-destruction rejection', async () => {
  let notified = 0, destroyed = 0;
  const stop = loadPdfPreview(new Blob(['bad']), () => ({
    promise: Promise.reject(new Error('sensitive parser details')),
    destroy: async () => { destroyed++; throw new Error('worker already gone'); },
  }), () => assert.fail('invalid PDF was accepted'), (...args) => { notified++; assert.deepEqual(args, []); });
  await settle(); stop();
  assert.equal(notified, 1);
  assert.equal(destroyed, 1);
});

test('PDF preview rejects invalid page counts', async () => {
  for (const numPages of [0, -1, NaN, Infinity, 1.5]) {
    let failed = false, destroyed = false;
    loadPdfPreview(new Blob(['pdf']), () => ({ promise: Promise.resolve({ numPages }), destroy: async () => { destroyed = true; } }),
      () => assert.fail('invalid page count accepted'), () => { failed = true; });
    await settle();
    assert.equal(failed, true);
    assert.equal(destroyed, true);
  }
});

test('PDF canvas dimensions and pixel area remain bounded at large sizes and high DPI', () => {
  for (const [width, height] of [[612, 792], [100_000, 100_000], [1, 1e10], [1e10, 1], [1e100, 1e100]]) {
    for (const zoom of [0.5, 1, 3]) {
      const geometry = pdfPreviewGeometry(width, height, 4000, zoom, 4);
      assert.ok(geometry.canvasWidth <= PDF_PREVIEW_MAX_DIMENSION);
      assert.ok(geometry.canvasHeight <= PDF_PREVIEW_MAX_DIMENSION);
      assert.ok(geometry.canvasWidth * geometry.canvasHeight <= PDF_PREVIEW_MAX_PIXELS);
      assert.ok(geometry.canvasWidth >= 1 && geometry.canvasHeight >= 1);
      assert.ok(Object.values(geometry).every(Number.isFinite));
    }
  }
  const fit = pdfPreviewGeometry(612, 792, 612, 1, 1);
  assert.equal(fit.displayWidth, 612);
  assert.equal(fit.displayHeight, 792);
  assert.equal(pdfPreviewGeometry(612, 792, 612, 2, 1).displayWidth, 1224);
  for (const bad of [0, -1, NaN, Infinity]) assert.throws(() => pdfPreviewGeometry(bad, 792, 600, 1, 1));
});

function renderHarness() {
  const pageRequest = deferred(), render = deferred();
  let draws = 0, cancelled = 0, ready = 0, errors = 0;
  const canvas = { width: 0, height: 0, style: {}, getContext: () => ({}) };
  const pdfPage = {
    getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale, scale }),
    render: ({ canvas: target }) => { assert.equal(target, canvas); draws++; return { promise: render.promise, cancel: () => { cancelled++; } }; },
  };
  const stop = renderPdfPreviewPage({ getPage: (number) => { assert.equal(number, 2); return pageRequest.promise; } }, canvas,
    { page: 2, availableWidth: 612, zoom: 1, pixelRatio: 2 }, () => { ready++; }, () => { errors++; });
  return { pageRequest, render, canvas, pdfPage, stop, counts: () => ({ draws, cancelled, ready, errors }) };
}

test('PDF rendering does not touch a canvas after a stale page request resolves', async () => {
  const h = renderHarness();
  h.stop(); h.pageRequest.resolve(h.pdfPage);
  await settle();
  assert.deepEqual(h.counts(), { draws: 0, cancelled: 0, ready: 0, errors: 0 });
  assert.equal(h.canvas.width, 0);
});

for (const outcome of ['resolve', 'reject']) test(`PDF render cancellation suppresses stale ${outcome} and stops the render task`, async () => {
  const h = renderHarness();
  h.pageRequest.resolve(h.pdfPage); await settle();
  h.stop(); h.render[outcome](outcome === 'reject' ? new Error('RenderingCancelledException') : undefined);
  await settle();
  assert.deepEqual(h.counts(), { draws: 1, cancelled: 1, ready: 0, errors: 0 });
});

test('PDF rendering signals readiness only after paint and uses bounded high-DPI dimensions', async () => {
  const h = renderHarness();
  h.pageRequest.resolve(h.pdfPage); await settle();
  assert.equal(h.counts().ready, 0);
  assert.equal(h.canvas.width, 1224);
  assert.equal(h.canvas.height, 1584);
  assert.equal(h.canvas.style.width, '612px');
  h.render.resolve(); await settle();
  assert.deepEqual(h.counts(), { draws: 1, cancelled: 0, ready: 1, errors: 0 });
});

test('PDF rendering exposes a generic failure for an active failed paint', async () => {
  const h = renderHarness();
  h.pageRequest.resolve(h.pdfPage); await settle();
  h.render.reject(new Error('sensitive parser information')); await settle();
  assert.deepEqual(h.counts(), { draws: 1, cancelled: 0, ready: 0, errors: 1 });
});
