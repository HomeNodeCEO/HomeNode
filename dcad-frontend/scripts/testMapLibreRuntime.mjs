import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';

function environment({ withDocument = true } = {}) {
  const timers = new Map();
  const imports = [];
  let nextTimer = 0;
  let resolvePackage;
  let rejectPackage;
  const packageLoad = new Promise((resolve, reject) => {
    resolvePackage = resolve;
    rejectPackage = reject;
  });
  const window = {
    setTimeout(fn, delay) { timers.set(++nextTimer, { fn, delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  };
  const loaded = loadTrustedRepositoryCommonJs(
    new URL('../src/lib/mapLibreRuntime.ts', import.meta.url),
    (name) => {
      imports.push(name);
      if (name === 'maplibre-gl') return packageLoad;
      if (name === 'maplibre-gl/dist/maplibre-gl.css') return {};
      if (name === 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url') return { default: '/assets/map-worker.js' };
      throw new Error(`Unexpected map runtime dependency: ${name}`);
    },
    { environment: { window, document: withDocument ? {} : undefined } },
  );
  return { ...loaded, imports, timers, resolvePackage, rejectPackage };
}

test('same-origin JavaScript and CSS share one lazy in-flight import', async () => {
  const e = environment();
  const first = e.loadMapLibreRuntime();
  const second = e.loadMapLibreRuntime();
  assert.equal(first, second);
  assert.equal([...e.timers.values()][0].delay, 15_000);
  const workerUrls = [];
  const runtime = { Map: class {}, setWorkerUrl(url) { workerUrls.push(url); } };
  e.resolvePackage(runtime);
  assert.equal(await first, runtime);
  assert.deepEqual(e.imports.sort(), ['maplibre-gl', 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', 'maplibre-gl/dist/maplibre-gl.css'].sort());
  assert.deepEqual(workerUrls, ['/assets/map-worker.js']);
  assert.equal(e.timers.size, 0);
  assert.equal(await e.loadMapLibreRuntime(), runtime);
  assert.equal(e.imports.length, 3);
  assert.equal(e.MAPLIBRE_BASE_STYLE, 'https://tiles.openfreemap.org/styles/bright');
});

test('a stalled map bundle has a finite deadline and an explicit retry path', async () => {
  const e = environment();
  const first = e.loadMapLibreRuntime();
  [...e.timers.values()][0].fn();
  await assert.rejects(first, /map_load_timeout/);
  assert.equal(e.timers.size, 0);
  const second = e.loadMapLibreRuntime();
  assert.notEqual(second, first);
  e.resolvePackage({ Map: class {}, setWorkerUrl() {} });
  await second;
});

test('missing or failed bundled runtime fails closed', async () => {
  const missing = environment();
  const first = missing.loadMapLibreRuntime();
  missing.resolvePackage({});
  await assert.rejects(first, /map_runtime_unavailable/);
  assert.equal(missing.timers.size, 0);

  const failed = environment();
  const second = failed.loadMapLibreRuntime();
  failed.rejectPackage(new Error('bundle_download_failed'));
  await assert.rejects(second, /bundle_download_failed/);
  assert.equal(failed.timers.size, 0);
});

test('map loading requires a browser document', async () => {
  const e = environment({ withDocument: false });
  await assert.rejects(e.loadMapLibreRuntime(), /map_browser_required/);
  assert.equal(e.imports.length, 0);
});
