import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
