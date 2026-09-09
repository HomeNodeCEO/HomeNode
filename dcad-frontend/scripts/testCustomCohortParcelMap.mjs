import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';

const requireRuntime = createRequire(new URL('../package.json', import.meta.url));
const ts = requireRuntime('typescript'), { renderToStaticMarkup } = requireRuntime('react-dom/server');
const file = fileURLToPath(new URL('../src/features/neighborhood/components/CustomCohortParcelMap.tsx', import.meta.url));
const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
});
const contextRef = { context_id: 'context', context_revision: '1', context_sha256: 'a'.repeat(64) };
const polygon = x => ({ type: 'Polygon', coordinates: [[[x, 32], [x + .01, 32], [x + .01, 32.01], [x, 32]],
  [[x + .003, 32.003], [x + .005, 32.003], [x + .005, 32.004], [x + .003, 32.003]]] });
function fixture() {
  const group = { binding: { accountId: 'A', assignmentFileId: '9007199254740993', contextRef, selectionRevision: 1, selectionFingerprint: 'b'.repeat(64) },
    summary: {}, apply: { status: 'blocked', reasons: [] }, parcel_map: { status: 'available', geojson: { type: 'FeatureCollection',
      features: ['A', 'B', 'C'].map((account_id, i) => ({ type: 'Feature', id: `gis.dcad_parcels:${i + 1}`,
        properties: { object_id: String(i + 1), account_id, selected: i !== 1 },
        geometry: i === 2 ? { type: 'MultiPolygon', coordinates: [polygon(-96.8).coordinates, polygon(-96.79).coordinates] } : polygon(-97 + i / 10) })) } } };
  const catalog = { status: 'review_only', binding: { context_ref: contextRef, selection_revision: 1 },
    pockets: [{ id: 'recorded-cad:alpha', label: 'Alpha', county: 'Dallas', account_ids: ['A'], member_count: 1 },
      { id: 'recorded-cad:beta', label: 'Beta', county: 'Dallas', account_ids: ['B'], member_count: 1 }],
    unassigned: { account_ids: ['C'], member_count: 1, reason_counts: [] },
    subject_membership: { account_id: 'A', assigned_pocket_id: 'recorded-cad:alpha' } };
  return { group, catalog, freshness: 'current' };
}
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
function harness({ rejectLoad = false, delayedLoad = false, throwPaint = false } = {}) {
  const cells = [], effects = [], layouts = [], maps = [], timers = new Map(), inspections = [];
  let cursor = 0, dirty = false, props, tree, nextTimer = 0, loadCount = 0, resolveLoad;
  const runtimePromise = new Promise(resolve => { resolveLoad = resolve; });
  const hook = (fn, deps, queue) => {
    const i = cursor++, old = cells[i];
    if (!old || !same(old.deps, deps)) { cells[i] = { deps, cleanup: old?.cleanup }; queue.push(() => {
      cells[i].cleanup?.(); cells[i].cleanup = fn();
    }); }
  };
  const react = {
    useRef(value) { const i = cursor++; cells[i] ??= { current: value }; return cells[i]; },
    useState(value) { const i = cursor++; cells[i] ??= { value }; return [cells[i].value, v => {
      const next = typeof v === 'function' ? v(cells[i].value) : v;
      if (!Object.is(next, cells[i].value)) { cells[i].value = next; dirty = true; }
    }]; },
    useMemo(fn, deps) { const i = cursor++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { value: fn(), deps }; return cells[i].value; },
    useEffect(fn, deps) { hook(fn, deps, effects); }, useLayoutEffect(fn, deps) { hook(fn, deps, layouts); },
  };
  class FakeMap {
    constructor(options) { this.options = options; this.events = new Map(); this.sources = new Map(); this.layers = [];
      this.states = []; this.fits = []; this.canvas = { style: {} }; this.removed = false; this.resizeCount = 0; maps.push(this); }
    on(name, layer, fn) { this.events.set(`${name}:${typeof layer === 'string' ? layer : ''}`, fn ?? layer); }
    emit(name, event, layer = '') { this.events.get(`${name}:${layer}`)?.(event); }
    addSource(id, source) { this.sources.set(id, { data: source.data, replacements: [], setData(data) { this.data = data; this.replacements.push(data); } }); }
    getSource(id) { return this.sources.get(id); }
    addLayer(layer) { this.layers.push(layer); }
    setFeatureState(feature, state) { if (throwPaint) throw new Error('render unavailable'); this.states.push({ feature, state }); }
    getCanvas() { return this.canvas; }
    fitBounds(bounds, options) { this.fits.push({ bounds, options }); }
    resize() { this.resizeCount++; }
    remove() { this.removed = true; }
  }
  const runtime = { Map: FakeMap }, window = { setTimeout(fn, delay) { timers.set(++nextTimer, { fn, delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); }, addEventListener() {}, removeEventListener() {} };
  const observers = [];
  class ResizeObserver { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } }
  const module = { exports: {} };
  new Script(`(function(require,module,exports,window,ResizeObserver){${compiled.outputText}\n})`, { filename: file }).runInThisContext()(name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return requireRuntime(name);
    if (name.endsWith('/customCohortPocketCatalog')) return { CUSTOM_COHORT_UNASSIGNED_GROUP: 'discovery:unassigned' };
    assert.equal(name, '../../../lib/mapLibreRuntime');
    return { MAPLIBRE_BASE_STYLE: 'pinned-style', loadMapLibreRuntime() { loadCount++;
      return rejectLoad ? Promise.reject(new Error('load failed')) : delayedLoad ? runtimePromise : Promise.resolve(runtime); } };
  }, module, module.exports, window, ResizeObserver);
  const Component = module.exports.default;
  function attach(node) {
    if (!node || typeof node !== 'object') return;
    if (node.props?.ref) node.props.ref.current ??= {};
    const children = node.props?.children;
    (Array.isArray(children) ? children : [children]).flat(Infinity).forEach(attach);
  }
  function render(value = props) {
    props = value; dirty = false; cursor = 0; tree = Component(props); attach(tree);
    layouts.splice(0).forEach(fn => fn()); effects.splice(0).forEach(fn => fn());
  }
  function flush() { let attempts = 0; while (dirty) { assert.ok(++attempts < 20, 'render loop'); render(); } }
  return { maps, timers, inspections, observers, get loadCount() { return loadCount; },
    render(value) { render(value); flush(); }, html: () => renderToStaticMarkup(tree),
    async drain() { for (let i = 0; i < 8; i++) await Promise.resolve(); flush(); },
    async ready(value = fixture()) { this.render(value); await this.drain(); maps.at(-1)?.emit('load'); flush(); maps.at(-1)?.emit('idle'); flush(); },
    emit(name, event, layer = '') { maps.at(-1).emit(name, event, layer); flush(); },
    unmount() { cells.forEach(c => c?.cleanup?.()); }, resolve() { resolveLoad(runtime); },
    timeout() { [...timers.values()].forEach(t => t.fn()); flush(); },
  };
}
test('renders exact retained Polygon holes and disconnected MultiPolygons, never a hull/circle', async () => {
  const props = fixture(), h = harness(); await h.ready(props);
  const map = h.maps[0], data = map.getSource('custom-cohort-parcels').data;
  assert.equal(map.layers.length, 2); assert.equal(map.layers[0].type, 'fill');
  data.features.forEach((f, i) => assert.equal(f.geometry, props.group.parcel_map.geojson.features[i].geometry));
  assert.equal(data.features[0].geometry.coordinates.length, 2);
  assert.equal(data.features[2].geometry.coordinates.length, 2);
  assert.equal(map.fits.length, 1); assert.equal(map.options.attributionControl, true);
  assert.match(h.html(), /Colors describe inclusion, not similarity or reliability/);
  assert.match(h.html(), /not legal subdivision or neighborhood boundaries/); assert.doesNotMatch(h.html(), /Loading parcel map/);
});
test('selection color flags come from the coherent group, unresolved membership stays explicit', async () => {
  const h = harness(); await h.ready(); const data = h.maps[0].getSource('custom-cohort-parcels').data;
  assert.deepEqual(data.features.map(f => [f.properties.selected, f.properties.unresolved, f.properties.subject]),
    [[true, false, true], [false, false, false], [true, true, false]]);
  assert.ok(JSON.stringify(h.maps[0].layers).includes('#15803d'));
  assert.match(h.html(), /included unresolved parcel has a green outline/);
});
test('parcel clicks emit only exact recorded group/account callbacks, including unresolved accounts', async () => {
  const calls = [], props = { ...fixture(), onInspectPocket: id => calls.push(['group', id]), onInspectAccount: id => calls.push(['account', id]) };
  const h = harness(); await h.ready(props);
  h.emit('click', { features: [{ properties: { account_id: 'B' } }] }, 'custom-cohort-parcels-fill');
  h.emit('click', { features: [{ properties: { account_id: 'C' } }] }, 'custom-cohort-parcels-fill');
  h.emit('click', { features: [{ properties: { account_id: 'OUTSIDE' } }] }, 'custom-cohort-parcels-fill');
  h.emit('click', { features: [{ properties: { account_id: 123 } }] }, 'custom-cohort-parcels-fill');
  assert.deepEqual(calls, [['group', 'recorded-cad:beta'], ['account', 'B'], ['group', 'discovery:unassigned'], ['account', 'C']]);
  assert.equal(h.loadCount, 1); assert.equal(h.maps[0].states.length, 0, 'inspection does not mutate selection');
});
test('a stale pending selection preserves old colors without rerendering geometry or changing the camera', async () => {
  const h = harness(), props = fixture(); await h.ready(props);
  const map = h.maps[0], initial = map.getSource('custom-cohort-parcels').data;
  h.render({ ...props, freshness: 'stale' });
  assert.equal(map.getSource('custom-cohort-parcels').data, initial); assert.equal(map.states.length, 0);
  assert.equal(map.fits.length, 1); assert.match(h.html(), /previous map and statistics together/);
});
test('accepting an empty selection restyles exact geometry and waits for draw completion without refitting', async () => {
  const h = harness(), props = fixture(); await h.ready(props);
  const group = { ...props.group, binding: { ...props.group.binding, selectionRevision: 2 }, parcel_map: { ...props.group.parcel_map,
    geojson: { type: 'FeatureCollection', features: props.group.parcel_map.geojson.features.map(f => ({ ...f, properties: { ...f.properties, selected: false } })) } } };
  h.render({ ...props, group }); const map = h.maps[0];
  assert.equal(h.maps.length, 1); assert.equal(map.fits.length, 1); assert.equal(map.getSource('custom-cohort-parcels').replacements.length, 0);
  assert.equal(map.states.length, 2); assert.ok(map.states.every(change => change.state.selected === false));
  assert.match(h.html(), /Drawing the matching parcel selection/);
  h.emit('idle'); assert.doesNotMatch(h.html(), /Drawing the matching parcel selection/);
  assert.match(h.html(), /data-selection-revision="2"/);
});
test('inspection changes only outline state, not selected inclusion or geometry', async () => {
  const h = harness(), props = fixture(); await h.ready(props); h.render({ ...props, inspectedPocketId: 'recorded-cad:beta' });
  const map = h.maps[0]; assert.equal(map.states.length, 1); assert.equal(map.states[0].state.inspected, true);
  assert.equal(map.states[0].state.selected, false); assert.equal(map.fits.length, 1);
});
test('context mismatch never mounts a map or allows cross-context parcel inspection', async () => {
  const h = harness(), props = fixture(); props.catalog = { ...props.catalog, binding: { ...props.catalog.binding,
    context_ref: { ...contextRef, context_sha256: 'other' } } };
  await h.ready(props); assert.equal(h.maps.length, 0); assert.equal(h.loadCount, 0);
  assert.match(h.html(), /different captured context/);
});
test('new target disposes the old map and resize observer before building its own', async () => {
  const h = harness(), props = fixture(); await h.ready(props);
  const next = { ...props, group: { ...props.group, binding: { ...props.group.binding, assignmentFileId: '18' } } };
  h.render(next); assert.equal(h.maps[0].removed, true); assert.equal(h.observers[0].disconnected, true);
  await h.drain(); assert.equal(h.maps.length, 2); h.unmount(); assert.equal(h.maps[1].removed, true); assert.equal(h.timers.size, 0);
});
test('equivalent context object insertion order does not remount the map or reset its camera', async () => {
  const h = harness(), props = fixture(); await h.ready(props);
  const contextRef = props.group.binding.contextRef;
  h.render({ ...props, group: { ...props.group, binding: { ...props.group.binding,
    contextRef: { context_sha256: contextRef.context_sha256, context_revision: contextRef.context_revision, context_id: contextRef.context_id } } } });
  await h.drain(); assert.equal(h.loadCount, 1); assert.equal(h.maps.length, 1);
  assert.equal(h.maps[0].removed, false); assert.equal(h.maps[0].fits.length, 1);
});
test('unavailable geometry removes the old map and shows no invented replacement', async () => {
  const h = harness(), props = fixture(); await h.ready(props);
  h.render({ ...props, group: { ...props.group, parcel_map: { status: 'unavailable', reason: 'missing_parcel_geometry' } } });
  assert.equal(h.maps[0].removed, true); assert.match(h.html(), /Parcel map unavailable: missing_parcel_geometry/);
  assert.doesNotMatch(h.html(), /Interactive parcel map/); assert.equal(h.timers.size, 0);
});
test('a late runtime after unmount cannot create a map', async () => {
  const h = harness({ delayedLoad: true }); h.render(fixture()); h.unmount(); h.resolve(); await h.drain();
  assert.equal(h.maps.length, 0); assert.equal(h.timers.size, 0);
});
test('runtime failure and draw failure use an opaque fallback instead of partially painted old data', async () => {
  const h = harness({ rejectLoad: true }); h.render(fixture()); await h.drain();
  assert.match(h.html(), /absolute inset-0[^\"]*bg-white/); assert.match(h.html(), /no substitute boundary/);
  const p = harness({ throwPaint: true }), props = fixture(); await p.ready(props);
  p.render({ ...props, inspectedPocketId: 'recorded-cad:beta' }); assert.match(p.html(), /map could not be displayed/);
});
test('hung map drawing times out; tile errors are explicit without changing observations', async () => {
  const h = harness(); h.render(fixture()); await h.drain(); h.emit('load'); h.timeout();
  assert.match(h.html(), /map could not be displayed/);
  const e = harness(); await e.ready(); e.emit('error'); assert.match(e.html(), /Some basemap resources could not load/);
  assert.equal(e.maps[0].states.length, 0);
});
