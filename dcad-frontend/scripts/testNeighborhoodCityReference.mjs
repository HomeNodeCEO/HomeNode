import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
const root = fileURLToPath(new URL('../', import.meta.url));
const file = `${root}/src/lib/neighborhoodCityReference.ts`;
const compiled = ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file, reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
assert.deepEqual(compiled.diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error), []);
const compiledExports = {};
const executeCompiled = new Function('exports', 'require', compiled.outputText);
const rejectRuntimeImport = name => { throw new Error(`Unexpected runtime import: ${name}`); };
executeCompiled(compiledExports, rejectRuntimeImport);
const { decodeCityReference, createCityReferenceLoader, showCityReference, hideCityReference } = compiledExports;
const catalog = JSON.parse(readFileSync(`${root}/src/data/neighborhoodCityBoundaries.json`, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bytesFor = entry => readFileSync(`${root}/public/neighborhood-city-boundaries/${catalog.vintage}/${entry.geoid}.geojson`);

test('all five versioned snapshots match the catalog and retain polygon geometry', () => {
  assert.equal(catalog.vintage, '2026-01-01');
  assert.deepEqual(catalog.cities.map(entry => entry.name).sort(), ['Coppell', 'Dallas', 'Duncanville', 'Garland', 'Irving']);
  for (const entry of catalog.cities) {
    const bytes = bytesFor(entry);
    assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.sha256);
    const feature = JSON.parse(bytes);
    const result = decodeCityReference(feature, entry);
    assert.deepEqual(result.data.features[0].geometry, feature.geometry);
    assert.ok(result.bounds[0][0] < result.bounds[1][0]); assert.ok(result.bounds[0][1] < result.bounds[1][1]);
  }
  const dallas = JSON.parse(bytesFor(catalog.cities.find(entry => entry.name === 'Dallas')));
  assert.equal(dallas.geometry.type, 'MultiPolygon');
  assert.equal(dallas.geometry.coordinates.length, 3);
  assert.equal(dallas.geometry.coordinates.reduce((holes, polygon) => holes + polygon.length - 1, 0), 2);
});

test('loading is same-app, credential-free and deduplicated without live GIS requests', async () => {
  const entry = catalog.cities[0]; let calls = 0;
  const load = createCityReferenceLoader(async (url, options) => {
    calls += 1;
    assert.equal(url, `neighborhood-city-boundaries/2026-01-01/${entry.geoid}.geojson`);
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'force-cache');
    assert.equal(options.redirect, 'error');
    return new Response(bytesFor(entry));
  });
  const first = load(entry), concurrent = load(entry);
  assert.equal(first, concurrent);
  const result = await first;
  assert.equal(await load(entry), result); assert.equal(calls, 1);
});

test('invalid catalog identities and byte limits do not make a request', async () => {
  const load = createCityReferenceLoader(() => { throw new Error('Unexpected request'); });
  for (const changed of [{ geoid: '../private' }, { geoid: '4819000?url=anything' }, { sha256: 'unknown' },
    { bytes: 0 }, { bytes: 2_000_001 }, { bytes: Infinity }, { bytes: '100' }]) {
    await assert.rejects(load({ ...catalog.cities[0], ...changed }), /Invalid city catalog entry/);
  }
});

test('failure evicts only the failed cached promise and permits a retry', async () => {
  const entry = catalog.cities[0]; let calls = 0;
  const load = createCityReferenceLoader(async () => ++calls === 1
    ? new Response('offline', { status: 503 }) : new Response(bytesFor(entry)));
  await assert.rejects(load(entry), /could not be loaded/);
  assert.equal((await load(entry)).data.features[0].properties.city, entry.name);
  assert.equal(calls, 2);
});

test('incomplete, oversized and same-size altered snapshots are rejected', async () => {
  const entry = catalog.cities[0], original = new TextDecoder().decode(bytesFor(entry));
  const altered = original.replace('Coppell', 'Xoppell');
  assert.notEqual(altered, original);
  for (const [payload, expected] of [[original.slice(0, -1), /incomplete/],
    [`${original} `, /exceeds/], [altered, /verified source/]]) {
    const load = createCityReferenceLoader(async () => new Response(payload));
    await assert.rejects(load(entry), expected);
  }
});

test('identity, open rings, invalid coordinates and unknown geometry are not repaired', () => {
  const entry = catalog.cities[0], original = JSON.parse(bytesFor(entry));
  for (const mutate of [value => { value.properties.GEOID = '4819000'; }, value => { value.properties.STATE = '49'; },
    value => { value.geometry.type = 'LineString'; }, value => { value.geometry.coordinates[0].pop(); },
    value => { value.geometry.coordinates[0][0][0] = 181; }, value => { value.geometry.coordinates = []; }]) {
    const feature = structuredClone(original); mutate(feature);
    assert.throws(() => decodeCityReference(feature, entry));
  }
});

test('city layer and viewport updates never mutate the analytical selection or its source', () => {
  const entry = catalog.cities[0], city = decodeCityReference(JSON.parse(bytesFor(entry)), entry);
  const sources = new Map([['custom-boundary', { selected: true }]]), layers = new Set(), fits = [];
  const map = {
    getSource: id => sources.has(id) ? { setData: data => sources.set(id, data) } : undefined,
    addSource: (id, source) => sources.set(id, source.data), getLayer: id => layers.has(id),
    addLayer: layer => { assert.equal(layer.type, 'line'); layers.add(layer.id); },
    fitBounds: bounds => fits.push(bounds),
    getCenter: () => ({ lng: -96.63, lat: 32.88 }), getZoom: () => 13,
    getBearing: () => 0, getPitch: () => 0, jumpTo: () => {},
  };
  showCityReference(map, city); showCityReference(map, city);
  assert.equal(layers.size, 2); assert.deepEqual(fits, [city.bounds, city.bounds]);
  hideCityReference(map);
  assert.deepEqual(sources.get('custom-boundary'), { selected: true });
  assert.equal(sources.get('homenode-city-reference').features.length, 0);
});

for (const boundaryState of ['not drawn', 'cleared while viewing a city']) {
  test(`return restores the analytical camera when the boundary is ${boundaryState}`, () => {
    const originalCamera = { center: [-96.63, 32.88], zoom: 13.5, bearing: 12, pitch: 25 };
    let camera = structuredClone(originalCamera);
    const sources = new Map(), layers = new Set();
    const selection = { accounts: ['subject'], reliability: 82 };
    const baselineSelection = structuredClone(selection);
    const map = {
      getSource: id => sources.has(id) ? { setData: data => sources.set(id, data) } : undefined,
      addSource: (id, source) => sources.set(id, source.data), getLayer: id => layers.has(id),
      addLayer: layer => layers.add(layer.id),
      getCenter: () => ({ lng: camera.center[0], lat: camera.center[1] }),
      getZoom: () => camera.zoom, getBearing: () => camera.bearing, getPitch: () => camera.pitch,
      fitBounds: bounds => { camera = { center: [...bounds[0]], zoom: 8, bearing: 0, pitch: 0 }; },
      jumpTo: value => { camera = structuredClone(value); },
    };
    for (const entry of catalog.cities.slice(0, 2)) {
      showCityReference(map, decodeCityReference(JSON.parse(bytesFor(entry)), entry));
      assert.notDeepEqual(camera, originalCamera);
    }
    if (boundaryState.startsWith('cleared')) sources.set('custom-boundary', { features: [] });
    const analyticalSource = sources.get('custom-boundary');
    hideCityReference(map);
    assert.deepEqual(camera, originalCamera);
    assert.equal(sources.get('custom-boundary'), analyticalSource);
    assert.deepEqual(selection, baselineSelection);
    camera.zoom = 14;
    hideCityReference(map);
    assert.equal(camera.zoom, 14, 'A second hide must not replay an old camera.');
    const nextView = structuredClone(camera);
    const entry = catalog.cities[0];
    showCityReference(map, decodeCityReference(JSON.parse(bytesFor(entry)), entry));
    hideCityReference(map);
    assert.deepEqual(camera, nextView, 'A later reference view captures the new analytical camera.');
  });
}

const requireRuntime = createRequire(new URL('../package.json', import.meta.url));
const componentFile = `${root}/src/components/NeighborhoodCityReferenceControl.tsx`;
const componentCode = ts.transpileModule(readFileSync(componentFile, 'utf8').replace('import.meta.env.BASE_URL', "'/base/'"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const children = node => (Array.isArray(node?.props?.children) ? node.props.children : [node?.props?.children]).flat(Infinity);
const walk = node => node && typeof node === 'object' ? [node, ...children(node).flatMap(walk)] : [];
const nodeText = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : node && typeof node === 'object' ? children(node).map(nodeText).join('') : '';
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
function controlHarness(initialMap = referenceMap()) {
  const cells = [], effects = [], calls = [], events = [], requests = new Set(); let cursor = 0, dirty = false, tree, props;
  const react = {
    useId: () => 'city-reference-test',
    useState(initial) { const i = cursor++; cells[i] ??= { value: initial }; return [cells[i].value, value => {
      if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true; }
    }]; },
    useRef(value) { const i = cursor++; cells[i] ??= { current: value }; return cells[i]; },
    useEffect(fn, deps) { const i = cursor++, old = cells[i]; if (!old || !sameDeps(old.deps, deps)) {
      cells[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { cells[i].cleanup?.(); cells[i].cleanup = fn(); });
    } },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'fetch', componentCode)(name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return requireRuntime(name);
    if (name === '@/data/neighborhoodCityBoundaries.json') return { default: catalog };
    assert.equal(name, '@/lib/neighborhoodCityReference');
    return { ...compiledExports, createCityReferenceLoader(fetcher) {
      const load = createCityReferenceLoader(fetcher);
      return entry => { const pending = load(entry); requests.add(pending);
        void pending.then(() => requests.delete(pending), () => requests.delete(pending)); return pending; };
    } };
  }, module, module.exports, (url, options) => new Promise((resolve, reject) => calls.push({ url, options, resolve, reject })));
  function render(next = props) { props = next; cursor = 0; dirty = false; tree = module.exports.default(props); effects.splice(0).forEach(fn => fn()); }
  function flush() { let n = 0; while (dirty) { assert.ok(++n < 15, 'No control render loop'); render(); } }
  const h = { calls, events, map: initialMap,
    render(next) { render(next); flush(); }, get props() { return props; }, get tree() { return tree; }, text: () => nodeText(tree),
    button(label) { const node = walk(tree).find(n => n.type === 'button' && nodeText(n) === label); assert.ok(node, label); return node; },
    click(label) { const node = this.button(label); if (!node.props.disabled) node.props.onClick(); flush(); },
    select(index = 0) { const node = walk(tree).find(n => n.type === 'select'); node.props.onChange({ target: { value: catalog.cities[index].geoid } }); flush(); },
    async drain() { for (let i = 0; i < 12; i++) await Promise.resolve(); flush(); },
    async complete(index = calls.length - 1, status = 200) {
      const entry = catalog.cities.find(c => calls[index].url.endsWith(`/${c.geoid}.geojson`)); assert.ok(entry);
      calls[index].resolve(new Response(status === 200 ? bytesFor(entry) : 'Unavailable', { status }));
      await Promise.allSettled([...requests]); await this.drain();
    },
    unmount() { cells.forEach(cell => cell?.cleanup?.()); },
  };
  h.render({ map: initialMap, onViewChange: active => events.push(active) }); return h;
}
function referenceMap() {
  const originalCamera = { center: [-96.63, 32.88], zoom: 13.5, bearing: 12, pitch: 25 };
  let camera = structuredClone(originalCamera);
  const sources = new Map([['custom-cohort-parcels', { unchanged: true }]]), layers = new Map(), fits = [];
  return { originalCamera, sources, layers, fits,
    getSource: id => sources.has(id) ? { setData: data => sources.set(id, data) } : undefined,
    addSource: (id, source) => sources.set(id, source.data), getLayer: id => layers.get(id), addLayer: layer => layers.set(layer.id, layer),
    getCenter: () => ({ lng: camera.center[0], lat: camera.center[1] }), getZoom: () => camera.zoom,
    getBearing: () => camera.bearing, getPitch: () => camera.pitch,
    fitBounds: bounds => { fits.push(bounds); camera = { center: [...bounds[0]], zoom: 8, bearing: 0, pitch: 0 }; },
    jumpTo: value => { camera = structuredClone(value); }, camera: () => camera,
  };
}

test('new Custom control is a manual dated reference with no load until explicit Show', async () => {
  const h = controlHarness(); await h.drain(); assert.equal(h.calls.length, 0);
  assert.equal(h.button('Show city limits').props.disabled, true);
  h.select(); assert.equal(h.calls.length, 0); h.click('Show city limits'); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, '/base/neighborhood-city-boundaries/2026-01-01/4816612.geojson');
  assert.equal(h.calls[0].options.credentials, 'omit'); await h.complete();
  assert.match(h.text(), /Showing Coppell/); assert.match(h.text(), /2026-01-01/);
  assert.match(h.text(), /does not establish the subject's jurisdiction/); assert.match(h.text(), /do not expand parcel\/sales coverage/);
  assert.match(h.tree.props.className, /print:hidden/); assert.deepEqual(h.map.sources.get('custom-cohort-parcels'), { unchanged: true });
  assert.equal(h.map.layers.size, 2); h.unmount();
});

test('equivalent callback churn does not reset the shown city or saved camera', async () => {
  const h = controlHarness(); h.select(); h.click('Show city limits'); await h.complete();
  h.render({ ...h.props, onViewChange: active => h.events.push(active) });
  assert.match(h.text(), /Showing Coppell/); assert.equal(h.map.fits.length, 1); assert.equal(h.calls.length, 1);
  h.click('Return to analysis area'); assert.deepEqual(h.map.camera(), h.map.originalCamera);
  assert.equal(h.map.sources.get('homenode-city-reference').features.length, 0); assert.equal(h.events.at(-1), false);
  h.unmount();
});

test('hide during load suppresses a late city and preserves the analysis viewport', async () => {
  const h = controlHarness(); h.select(); h.click('Show city limits'); h.click('Return to analysis area');
  await h.complete(); assert.equal(h.map.fits.length, 0); assert.deepEqual(h.map.camera(), h.map.originalCamera);
  assert.doesNotMatch(h.text(), /Showing Coppell/); h.unmount();
});

test('a changed or disposed map never receives a late overlay; replacement starts unchosen', async () => {
  const h = controlHarness(); h.select(); h.click('Show city limits'); const second = referenceMap();
  h.render({ ...h.props, map: second }); await h.complete();
  assert.equal(h.map.fits.length, 0); assert.equal(second.fits.length, 0); assert.equal(h.button('Show city limits').props.disabled, true);
  h.select(1); h.click('Show city limits'); h.unmount(); await h.complete(1);
  assert.equal(second.fits.length, 0); assert.equal(h.events.at(-1), false);
});

test('failed city switch retains the previous view and cannot change analytic sources', async () => {
  const h = controlHarness(); h.select(); h.click('Show city limits'); await h.complete();
  const previous = h.map.sources.get('homenode-city-reference'), camera = structuredClone(h.map.camera());
  h.select(1); h.click('Show city limits'); await h.complete(1, 503);
  assert.equal(h.map.sources.get('homenode-city-reference'), previous); assert.deepEqual(h.map.camera(), camera);
  assert.match(h.text(), /Showing Coppell/); assert.match(h.text(), /could not be loaded/);
  assert.deepEqual(h.map.sources.get('custom-cohort-parcels'), { unchanged: true }); h.click('Return to analysis area');
  assert.deepEqual(h.map.camera(), h.map.originalCamera); h.unmount();
});

test('a map must be ready before Show and the city is never inferred from subject data', () => {
  const h = controlHarness(null); h.select(); assert.equal(h.button('Show city limits').props.disabled, true); assert.equal(h.calls.length, 0);
  h.render({ ...h.props, map: referenceMap() }); assert.equal(h.button('Show city limits').props.disabled, true);
  assert.ok(!Object.hasOwn(h.props, 'subjectCity')); h.unmount();
});
