import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';

const requireRuntime = createRequire(new URL('../package.json', import.meta.url));
const ts = requireRuntime('typescript');
const file = fileURLToPath(new URL('../src/lib/mapLibreRuntime.ts', import.meta.url));
const code = ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function environment({ existing = false, loaded = false } = {}) {
  const elements = [], timers = new Map(); let next = 0;
  function element(tagName) {
    const listeners = new Map();
    return { tagName, dataset: {}, listeners,
      addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
      emit(type) { [...(listeners.get(type) ?? [])].forEach(fn => fn()); },
      remove() { elements.splice(elements.indexOf(this), 1); },
    };
  }
  if (existing) { const script = element('script'); script.dataset.homenodeMapScript = 'maplibre'; elements.push(script); }
  const runtime = { Map: class {} };
  const window = { setTimeout(fn, delay) { timers.set(++next, { fn, delay }); return next; }, clearTimeout(id) { timers.delete(id); } };
  if (loaded) window.maplibregl = runtime;
  const document = { head: { appendChild(e) { elements.push(e); } }, createElement: element,
    querySelector(selector) { return elements.find(e => e.tagName === (selector.startsWith('link') ? 'link' : 'script')) ?? null; } };
  const module = { exports: {} };
  new Script(`(function(module,exports,window,document){${code}\n})`, { filename: file }).runInThisContext()(module, module.exports, window, document);
  return { ...module.exports, elements, window, timers, runtime,
    script: () => elements.find(e => e.tagName === 'script'),
    finish() { window.maplibregl = runtime; this.script().emit('load'); },
  };
}
test('the pinned runtime shares the existing map DOM keys and one in-flight promise', async () => {
  const e = environment(), first = e.loadMapLibreRuntime(), second = e.loadMapLibreRuntime();
  assert.equal(first, second); assert.equal(e.elements.length, 2);
  assert.equal(e.script().src, 'https://unpkg.com/maplibre-gl@5.12.0/dist/maplibre-gl.js');
  assert.equal(e.elements[0].href, 'https://unpkg.com/maplibre-gl@5.12.0/dist/maplibre-gl.css');
  assert.equal(e.elements[0].dataset.homenodeMapStyle, 'maplibre');
  assert.equal(e.MAPLIBRE_BASE_STYLE, 'https://tiles.openfreemap.org/styles/bright');
  e.finish(); assert.equal(await first, e.runtime); assert.equal(e.timers.size, 0);
  assert.equal(e.script().listeners.get('load').size, 0); assert.equal(e.script().listeners.get('error').size, 0);
  assert.equal(await e.loadMapLibreRuntime(), e.runtime); assert.equal(e.elements.length, 2);
});
test('a pre-existing report map script is reused instead of creating a second runtime', async () => {
  const e = environment({ existing: true }), previous = e.script(), pending = e.loadMapLibreRuntime();
  assert.equal(e.script(), previous); assert.equal(e.elements.filter(v => v.tagName === 'script').length, 1);
  e.finish(); assert.equal(await pending, e.runtime); assert.equal(e.timers.size, 0);
});
test('a loaded global requires no script and still ensures the shared stylesheet', async () => {
  const e = environment({ loaded: true }); assert.equal(await e.loadMapLibreRuntime(), e.runtime);
  assert.equal(e.elements.length, 1); assert.equal(e.elements[0].tagName, 'link'); assert.equal(e.timers.size, 0);
});
for (const existing of [true, false]) {
  test(`both new and pre-existing script loading have a finite timeout (${existing})`, async () => {
    const e = environment({ existing }), pending = e.loadMapLibreRuntime();
    assert.equal([...e.timers.values()][0].delay, 15_000);
    [...e.timers.values()][0].fn(); await assert.rejects(pending, /map_load_timeout/);
    assert.equal(e.timers.size, 0); assert.equal(e.script().dataset.homenodeMapFailed, 'true');
    assert.equal(e.script().listeners.get('load').size, 0);
    // No automatic retry or background loop; only an explicit later caller retries.
    const previous = e.script(), next = e.loadMapLibreRuntime(); assert.notEqual(e.script(), previous);
    assert.equal(e.elements.filter(v => v.tagName === 'script').length, 1); e.finish(); await next;
  });
}
test('script load with no runtime fails closed and removes event listeners', async () => {
  const e = environment(), pending = e.loadMapLibreRuntime(); e.script().emit('load');
  await assert.rejects(pending, /map_runtime_unavailable/); assert.equal(e.timers.size, 0);
  assert.equal(e.script().listeners.get('error').size, 0);
});
test('network failure has no retry and can be retried explicitly', async () => {
  const e = environment(), pending = e.loadMapLibreRuntime(); e.script().emit('error');
  await assert.rejects(pending, /map_load_failed/); assert.equal(e.timers.size, 0);
  const next = e.loadMapLibreRuntime(); e.finish(); await next;
});
