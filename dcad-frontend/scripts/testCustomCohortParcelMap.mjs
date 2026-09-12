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
// Execute the actual new pure presentation helper. Only the existing catalog
// constant is substituted; score/label logic is not replicated in this harness.
const presentationFile = fileURLToPath(new URL('../src/features/neighborhood/customCohortMapPresentation.ts', import.meta.url));
const presentationModule = { exports: {} };
const presentationCompiled = ts.transpileModule(readFileSync(presentationFile, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});
new Script(`(function(require,module,exports){${presentationCompiled.outputText}\n})`, { filename: presentationFile }).runInThisContext()(name => {
  assert.match(name, /customCohortPocketCatalog(?:\.ts)?$/);
  return { CUSTOM_COHORT_UNASSIGNED_GROUP: 'discovery:unassigned' };
}, presentationModule, presentationModule.exports);
const { buildCustomCohortMapPresentation } = presentationModule.exports;
const contextRef = { context_id: 'context', context_revision: '1', context_sha256: 'a'.repeat(64) };
const polygon = x => ({ type: 'Polygon', coordinates: [[[x, 32], [x + .01, 32], [x + .01, 32.01], [x, 32]],
  [[x + .003, 32.003], [x + .005, 32.003], [x + .005, 32.004], [x + .003, 32.003]]] });
function fixture() {
  const group = { binding: { accountId: 'A', assignmentFileId: '9007199254740993', contextRef, selectionRevision: 1, selectionFingerprint: 'b'.repeat(64) },
    summary: {}, apply: { status: 'blocked', reasons: [] }, parcel_map: { status: 'available', geojson: { type: 'FeatureCollection',
      features: ['A', 'B', 'C'].map((account_id, i) => ({ type: 'Feature', id: `gis.dcad_parcels:${i + 1}`,
        properties: { object_id: String(i + 1), account_id, selected: i !== 1 },
        geometry: i === 2 ? { type: 'MultiPolygon', coordinates: [polygon(-96.8).coordinates, polygon(-96.79).coordinates] } : polygon(-97 + i / 10) })) } } };
  const catalog = { catalog_version: 1, status: 'review_only', binding: { context_ref: contextRef, selection_revision: 1 },
    pockets: [{ id: 'recorded-cad:alpha', label: 'Alpha', county: 'Dallas', account_ids: ['A'], member_count: 1 },
      { id: 'recorded-cad:beta', label: 'Beta', county: 'Dallas', account_ids: ['B'], member_count: 1 }],
    unassigned: { account_ids: ['C'], member_count: 1, reason_counts: [] },
    coverage: { discovery_member_count: 3, assigned_account_count: 2, unassigned_account_count: 1 },
    subject_membership: { account_id: 'A', assigned_pocket_id: 'recorded-cad:alpha' } };
  return { group, catalog, freshness: 'current' };
}
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
function harness({ rejectLoad = false, delayedLoad = false, throwPaint = false, throwQuery = false } = {}) {
  const cells = [], effects = [], layouts = [], maps = [], timers = new Map(), inspections = [];
  let cursor = 0, dirty = false, props, tree, nextTimer = 0, loadCount = 0, presentationCount = 0, resolveLoad;
  const runtimePromise = new Promise(resolve => { resolveLoad = resolve; });
  const hook = (fn, deps, queue) => {
    const i = cursor++, old = cells[i];
    if (!old || !same(old.deps, deps)) { cells[i] = { deps, cleanup: old?.cleanup }; queue.push(() => {
      cells[i].cleanup?.(); cells[i].cleanup = fn();
    }); }
  };
  const react = {
    useRef(value) { const i = cursor++; cells[i] ??= { current: value }; return cells[i]; },
    useState(value) { const i = cursor++; cells[i] ??= { value: typeof value === 'function' ? value() : value }; return [cells[i].value, v => {
      const next = typeof v === 'function' ? v(cells[i].value) : v;
      if (!Object.is(next, cells[i].value)) { cells[i].value = next; dirty = true; }
    }]; },
    useMemo(fn, deps) { const i = cursor++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { value: fn(), deps }; return cells[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) { hook(fn, deps, effects); }, useLayoutEffect(fn, deps) { hook(fn, deps, layouts); },
  };
  class FakeMap {
    constructor(options) { this.options = options; this.events = new Map(); this.sources = new Map(); this.layers = [];
      this.states = []; this.renderedStates = []; this.fits = []; this.jumps = []; this.queries = []; this.renderedLabelHits = [];
      this.camera = { center: [0, 0], zoom: 1, bearing: 0, pitch: 0 };
      this.canvas = { style: {} }; this.removed = false; this.resizeCount = 0; maps.push(this); }
    on(name, layer, fn) { this.events.set(`${name}:${typeof layer === 'string' ? layer : ''}`, fn ?? layer); }
    emit(name, event, layer = '') { this.events.get(`${name}:${layer}`)?.(event); }
    addSource(id, source) { this.sources.set(id, { options: { ...source }, data: source.data, replacements: [],
      setData(data) { this.data = data; this.replacements.push(data); } }); }
    getSource(id) { return this.sources.get(id); }
    addLayer(layer) { this.layers.push(layer); }
    getLayer(id) { return this.layers.find(layer => layer.id === id); }
    queryRenderedFeatures(point, options) { this.queries.push({ point, options });
      assert.deepEqual(options, { layers: ['custom-cohort-group-labels-text'] });
      if (throwQuery) throw new Error('synthetic renderer query failure'); return this.renderedLabelHits; }
    setFeatureState(feature, state) {
      if (throwPaint) throw new Error('render unavailable'); this.states.push({ feature, state });
      // Model the opaque-string GeoJSON identity path: calling setFeatureState
      // is not evidence it visibly applied. Without a matching promoted ID the
      // original feature properties remain rendered, as found in browser QA.
      const source = this.sources.get(feature.source), promoted = source?.options.promoteId;
      if (typeof promoted === 'string' && source.data.features.some(f => f.properties[promoted] === feature.id)) {
        this.renderedStates.push({ feature, state });
      }
    }
    getCanvas() { return this.canvas; }
    fitBounds(bounds, options) { this.fits.push({ bounds, options }); }
    getCenter() { return { lng: this.camera.center[0], lat: this.camera.center[1] }; }
    getZoom() { return this.camera.zoom; }
    getBearing() { return this.camera.bearing; }
    getPitch() { return this.camera.pitch; }
    jumpTo(options) { this.jumps.push(options); this.camera = { ...this.camera, ...options }; }
    resize() { this.resizeCount++; }
    remove() { this.removed = true; }
  }
  const runtime = { Map: FakeMap }, window = { setTimeout(fn, delay) { timers.set(++nextTimer, { fn, delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); }, addEventListener() {}, removeEventListener() {} };
  const observers = [];
  class ResizeObserver { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } }
  const module = { exports: {} };
  // Child effects/network are covered by its own tests. Here its exact current
  // props let us exercise the map owner's real city-camera callback.
  function CityReferenceStub() { return null; }
  new Script(`(function(require,module,exports,window,ResizeObserver){${compiled.outputText}\n})`, { filename: file }).runInThisContext()(name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return requireRuntime(name);
    if (/\/customCohortMapPresentation(?:\.ts)?$/.test(name)) return { ...presentationModule.exports,
      buildCustomCohortMapPresentation(...args) { presentationCount++; return buildCustomCohortMapPresentation(...args); } };
    if (name.endsWith('/NeighborhoodCityReferenceControl')) return { default: CityReferenceStub };
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
  function node(predicate, current = tree) {
    if (!current || typeof current !== 'object') return null;
    if (predicate(current)) return current;
    for (const child of [current.props?.children].flat(Infinity)) { const found = node(predicate, child ?? null); if (found) return found; }
    return null;
  }
  return { maps, timers, inspections, observers, get loadCount() { return loadCount; },
    get presentationCount() { return presentationCount; },
    node, cityProps: () => node(n => n.type === CityReferenceStub)?.props ?? null,
    changeColor(value) { const select = node(n => n.type === 'select' && n.props['aria-label'] === 'Map color mode');
      assert.ok(select, 'actual map color select'); select.props.onChange({ target: { value }, currentTarget: { value } }); flush(); },
    showLabels(checked) { const input = node(n => n.type === 'input' && n.props.type === 'checkbox');
      assert.ok(input, 'actual recorded label checkbox'); input.props.onChange({ target: { checked }, currentTarget: { checked } }); flush(); },
    cityView(active) { const props = this.cityProps(); assert.ok(props, 'actual city reference child'); props.onViewChange(active); flush(); },
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
  assert.equal(map.layers.length, 3); assert.equal(map.layers[0].type, 'fill');
  data.features.forEach((f, i) => assert.equal(f.geometry, props.group.parcel_map.geojson.features[i].geometry));
  assert.equal(data.features[0].geometry.coordinates.length, 2);
  assert.equal(data.features[2].geometry.coordinates.length, 2);
  assert.equal(map.fits.length, 1); assert.equal(map.options.attributionControl, true);
  assert.match(h.html(), /Colors describe inclusion, not similarity or reliability/);
  assert.match(h.html(), /not legal subdivision or neighborhood boundaries/); assert.doesNotMatch(h.html(), /Loading parcel map/);
});
test('recorded labels explicitly use the OpenFreeMap font across toggles and remounts', async () => {
  const props = fixture(), h = harness(); await h.ready(props);
  const assertFont = map => assert.deepEqual(map.getLayer('custom-cohort-group-labels-text').layout['text-font'], ['Noto Sans Regular']);
  assertFont(h.maps[0]);
  h.showLabels(false); h.showLabels(true); h.changeColor('similarity');
  assertFont(h.maps[0]); assert.equal(h.loadCount, 1);
  h.render({ ...props, group: { ...props.group, binding: { ...props.group.binding, assignmentFileId: '18' } } });
  await h.drain(); h.emit('load'); h.emit('idle');
  assert.equal(h.maps.length, 2); assertFont(h.maps[1]);
  h.unmount(); assert.equal(h.timers.size, 0);
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

function painted(map, account) {
  const feature = map.getSource('custom-cohort-parcels').data.features.find(f => f.properties.account_id === account);
  assert.ok(feature);
  return paintedFeature(map, feature);
}
const paintedFeature = (map, feature) => map.renderedStates.filter(row => row.feature.id === feature.id)
  .reduce((value, row) => ({ ...value, ...row.state }), { ...feature.properties });
function scoredFixture(scores = [75, 50, 25, 0, null]) {
  const f = fixture(), accounts = ['A', 'B', 'C', 'D', 'E', 'F'];
  f.catalog.pockets = scores.map((_, i) => ({ id: `recorded-cad:group-${i}`, label: `Group ${i}`, county: 'Dallas',
    account_ids: [accounts[i]], member_count: 1 }));
  f.catalog.unassigned = { account_ids: ['F'], member_count: 1, reason_counts: [] };
  f.catalog.coverage = { discovery_member_count: 6, assigned_account_count: 5, unassigned_account_count: 1 };
  f.catalog.subject_membership.assigned_pocket_id = f.catalog.pockets[0].id;
  f.catalog.recommendation = { status: 'recommendation_for_review', pockets: [
    ...f.catalog.pockets.map((p, i) => ({ id: p.id, member_count: 1, similarity: scores[i] === null
      ? { lower: 0, upper: 100, known_weight_percent: 0 }
      : { lower: scores[i], upper: scores[i], known_weight_percent: 100 } })),
    { id: 'discovery:unassigned', member_count: 1, similarity: { lower: 90, upper: 90, known_weight_percent: 100 } },
  ] };
  f.group.parcel_map.geojson.features = accounts.map((account_id, i) => ({ type: 'Feature', id: `gis.dcad_parcels:${i + 1}`,
    properties: { object_id: String(i + 1), account_id, selected: i % 2 === 0 }, geometry: polygon(-97 + i / 20) }));
  return f;
}
function refreshedGeometry(props, suffix = 'c') {
  return { ...props, group: { ...props.group, binding: { ...props.group.binding, selectionFingerprint: suffix.repeat(64) },
    parcel_map: { ...props.group.parcel_map, geojson: structuredClone(props.group.parcel_map.geojson) } } };
}
test('default mode remains selection; similarity without a recommendation is explicitly unknown', async () => {
  const props = fixture(), before = JSON.stringify(props), h = harness(); await h.ready(props);
  assert.equal(h.node(n => n.type === 'select' && n.props['aria-label'] === 'Map color mode').props.value, 'selection');
  assert.deepEqual(['A', 'B', 'C'].map(a => painted(h.maps[0], a).fillColor), ['#15803d', '#94a3b8', '#d97706']);
  h.changeColor('similarity');
  assert.deepEqual(['A', 'B', 'C'].map(a => painted(h.maps[0], a).fillColor), ['#94a3b8', '#94a3b8', '#94a3b8']);
  assert.match(h.html(), /unknown/i); assert.match(h.html(), /group/i);
  assert.equal(JSON.stringify(props), before); assert.equal(h.maps[0].fits.length, 1); assert.equal(h.loadCount, 1);
});
test('similarity uses exact fixed lower-bound bins, preserves selected flags and never scores unassigned parcels', async () => {
  const props = scoredFixture(), h = harness(); await h.ready(props);
  const original = h.maps[0].getSource('custom-cohort-parcels').data;
  const selected = original.features.map(f => f.properties.selected);
  h.changeColor('similarity'); const map = h.maps[0];
  assert.deepEqual(['A', 'B', 'C', 'D', 'E', 'F'].map(a => painted(map, a).fillColor),
    ['#15803d', '#84cc16', '#eab308', '#ea580c', '#94a3b8', '#94a3b8']);
  assert.deepEqual(['A', 'B', 'C', 'D', 'E', 'F'].map(a => painted(map, a).selected), selected);
  assert.equal(map.getSource('custom-cohort-parcels').data, original); assert.equal(map.fits.length, 1);
  assert.deepEqual(map.getLayer('custom-cohort-parcels-fill').paint['fill-color'], ['coalesce', ['feature-state', 'fillColor'], ['get', 'fillColor']]);
  assert.deepEqual(map.getLayer('custom-cohort-parcels-fill').paint['fill-opacity'], ['case', ['coalesce', ['feature-state', 'selected'], ['get', 'selected']], .55, .2]);
  h.changeColor('selection'); assert.equal(painted(map, 'F').fillColor, '#d97706');
  assert.equal(h.maps.length, 1); assert.equal(h.loadCount, 1); assert.equal(map.fits.length, 1);
});
test('lower bounds immediately below a threshold stay in the preceding fixed bin', async () => {
  const h = harness(); await h.ready(scoredFixture([74.999, 49.999, 24.999, 0, null])); h.changeColor('similarity');
  assert.deepEqual(['A', 'B', 'C', 'D'].map(a => painted(h.maps[0], a).fillColor), ['#84cc16', '#eab308', '#ea580c', '#ea580c']);
});
test('all parcels in one recorded group share its mean even when inclusion and subject flags differ', async () => {
  const props = fixture(); props.catalog.pockets[0].account_ids = ['A', 'B']; props.catalog.pockets[0].member_count = 2;
  props.catalog.pockets[1].account_ids = []; props.catalog.pockets[1].member_count = 0;
  props.catalog.recommendation = { status: 'recommendation_for_review', pockets: [
    { id: 'recorded-cad:alpha', member_count: 2, similarity: { lower: 65, upper: 85, known_weight_percent: 80 } },
    { id: 'recorded-cad:beta', member_count: 0, similarity: { lower: null, upper: null, known_weight_percent: null } },
    { id: 'discovery:unassigned', member_count: 1, similarity: { lower: 80, upper: 80, known_weight_percent: 100 } },
  ] };
  const h = harness(); await h.ready(props); h.changeColor('similarity'); const map = h.maps[0];
  assert.equal(painted(map, 'A').fillColor, '#84cc16'); assert.equal(painted(map, 'B').fillColor, '#84cc16');
  assert.equal(painted(map, 'A').selected, true); assert.equal(painted(map, 'B').selected, false);
  assert.equal(painted(map, 'A').subject, true); assert.equal(painted(map, 'B').subject, false);
  assert.equal(map.fits.length, 1); assert.equal(h.loadCount, 1);
});
test('insufficient recommendation leaves every similarity color unknown without changing inclusion', async () => {
  const props = scoredFixture(); props.catalog.recommendation.status = 'insufficient_observations';
  const h = harness(); await h.ready(props); h.changeColor('similarity');
  assert.ok(['A', 'B', 'C', 'D', 'E', 'F'].every(a => painted(h.maps[0], a).fillColor === '#94a3b8'));
  assert.equal(painted(h.maps[0], 'A').selected, true);
});

test('recorded label source equals actual helper output and is added after both exact parcel layers', async () => {
  const props = fixture(), expected = buildCustomCohortMapPresentation(props), h = harness(); await h.ready(props); h.showLabels(true);
  const map = h.maps[0];
  assert.deepEqual(map.layers.slice(0, 3).map(l => l.id), [
    'custom-cohort-parcels-fill', 'custom-cohort-parcels-outline', 'custom-cohort-group-labels-text']);
  assert.equal(map.layers[2].source, 'custom-cohort-group-labels'); assert.equal(map.layers[2].type, 'symbol');
  assert.deepEqual(map.getSource('custom-cohort-group-labels').data, expected.labels);
  assert.equal(expected.labels.features.length, 2); assert.ok(expected.labels.features.every(l => l.geometry.type === 'Point'));
  assert.equal(map.getSource('custom-cohort-parcels').replacements.length, 0);
  assert.equal(map.fits.length, 1);
});
test('label visibility and color switches never reload map/geometry, move camera or call selection/capture/save callbacks', async () => {
  const calls = [], props = { ...scoredFixture(), onInspectPocket: id => calls.push(id), onInspectAccount: id => calls.push(id),
    onSelectionChange: () => calls.push('selection'), onCapture: () => calls.push('capture'), onSave: () => calls.push('save') };
  const h = harness(); await h.ready(props); const map = h.maps[0], data = map.getSource('custom-cohort-parcels').data;
  h.showLabels(false); assert.deepEqual(map.getSource('custom-cohort-group-labels').data, { type: 'FeatureCollection', features: [] });
  h.changeColor('similarity'); h.showLabels(true); h.changeColor('selection'); h.showLabels(false);
  assert.equal(map.getSource('custom-cohort-parcels').data, data); assert.equal(map.getSource('custom-cohort-parcels').replacements.length, 0);
  assert.equal(map.fits.length, 1); assert.equal(map.jumps.length, 0); assert.equal(h.loadCount, 1); assert.equal(h.maps.length, 1);
  assert.deepEqual(calls, []);
});
test('label clicks inspect only a currently admitted exact named group and never select accounts', async () => {
  const calls = [], props = { ...fixture(), onInspectPocket: id => calls.push(['group', id]), onInspectAccount: id => calls.push(['account', id]) };
  const h = harness(); await h.ready(props); h.showLabels(true);
  const click = pocket_id => h.emit('click', { features: [{ properties: { pocket_id } }] }, 'custom-cohort-group-labels-text');
  click('recorded-cad:alpha'); click('foreign'); click('discovery:unassigned'); click(123);
  assert.deepEqual(calls, [['group', 'recorded-cad:alpha']]);
  h.showLabels(false); click('recorded-cad:alpha'); assert.equal(calls.length, 1);
  h.showLabels(true);
  const next = structuredClone(props.catalog); next.pockets[0].id = 'recorded-cad:renamed'; next.subject_membership.assigned_pocket_id = 'recorded-cad:renamed';
  h.render({ ...props, catalog: next }); click('recorded-cad:alpha'); click('recorded-cad:renamed');
  assert.deepEqual(calls, [['group', 'recorded-cad:alpha'], ['group', 'recorded-cad:renamed']]);
  assert.equal(h.maps[0].fits.length, 1); assert.equal(h.maps[0].states.length, 0);
});

test('city control receives only the live loaded map and camera observation does not mutate any analysis input', async () => {
  const props = fixture(), original = JSON.stringify(props), h = harness(); h.render(props);
  assert.equal(h.cityProps()?.map ?? null, null); await h.drain();
  assert.equal(h.cityProps()?.map ?? null, null, 'constructed runtime is not loaded yet');
  h.emit('load'); h.emit('idle'); assert.equal(h.cityProps().map, h.maps[0]);
  h.cityView(true); assert.equal(JSON.stringify(props), original); assert.equal(h.maps[0].states.length, 0);
  h.cityView(false); assert.equal(h.maps[0].fits.length, 1);
});
test('geometry refresh while city view is active updates real parcel source without refitting the reference camera', async () => {
  const props = fixture(), h = harness(); await h.ready(props); const map = h.maps[0];
  h.cityView(true); map.jumpTo({ center: [-96.5, 33], zoom: 9, bearing: 15, pitch: 10 });
  const camera = structuredClone(map.camera); h.render(refreshedGeometry(props));
  assert.equal(map.getSource('custom-cohort-parcels').replacements.length, 1);
  assert.equal(map.fits.length, 1); assert.deepEqual(map.camera, camera); assert.equal(map.jumps.length, 1);
  h.emit('idle'); h.changeColor('similarity'); h.showLabels(false); h.showLabels(true);
  assert.equal(map.fits.length, 1); assert.deepEqual(map.camera, camera); assert.equal(h.maps.length, 1);
  h.cityView(false); h.render(refreshedGeometry(props, 'd'));
  assert.equal(map.fits.length, 2, 'normal geometry refresh can fit after city reference is released');
});
test('new target disposes/clears the city map and late old city callbacks cannot hold the replacement camera', async () => {
  const props = fixture(), h = harness(); await h.ready(props); const oldMap = h.maps[0], oldCity = h.cityProps();
  h.cityView(true);
  const next = { ...props, group: { ...props.group, binding: { ...props.group.binding, assignmentFileId: '18' } } };
  h.render(next); assert.equal(oldMap.removed, true); assert.equal(h.cityProps()?.map ?? null, null);
  oldCity.onViewChange(true); await h.drain(); h.emit('load'); h.emit('idle'); const replacement = h.maps[1];
  assert.equal(h.cityProps().map, replacement); assert.equal(replacement.fits.length, 1);
  h.render(refreshedGeometry(next)); assert.equal(replacement.fits.length, 2, 'old callback does not retain city mode on new target');
  h.unmount(); assert.equal(replacement.removed, true); assert.equal(h.timers.size, 0);
});
test('unavailable geometry clears city-map props and label callbacks cannot inspect disposed data', async () => {
  const calls = [], props = { ...fixture(), onInspectPocket: id => calls.push(id) }, h = harness(); await h.ready(props);
  h.showLabels(true); h.cityView(true); const map = h.maps[0];
  h.render({ ...props, group: { ...props.group, parcel_map: { status: 'unavailable', reason: 'missing_parcel_geometry' } } });
  assert.equal(map.removed, true); assert.equal(h.cityProps()?.map ?? null, null);
  map.emit('click', { features: [{ properties: { pocket_id: 'recorded-cad:alpha' } }] }, 'custom-cohort-group-labels-text');
  assert.deepEqual(calls, []); assert.equal(h.timers.size, 0);
});

for (const order of ['parcel_first', 'label_first']) for (const account of ['B', 'C']) {
  test(`overlapping label click wins once over ${account === 'C' ? 'unassigned' : 'other-group'} parcel in ${order} dispatch order`, async () => {
    const calls = [], props = { ...fixture(), onInspectPocket: id => calls.push(['group', id]), onInspectAccount: id => calls.push(['account', id]) };
    const h = harness(); await h.ready(props); h.showLabels(true);
    const map = h.maps[0], point = { x: 100, y: 150 };
    const label = { properties: { pocket_id: 'recorded-cad:alpha' }, layer: { id: 'custom-cohort-group-labels-text' } };
    map.renderedLabelHits = [label];
    const parcel = () => h.emit('click', { point, features: [{ properties: { account_id: account } }] }, 'custom-cohort-parcels-fill');
    const text = () => h.emit('click', { point, features: [label] }, 'custom-cohort-group-labels-text');
    if (order === 'parcel_first') { parcel(); text(); } else { text(); parcel(); }
    assert.deepEqual(calls, [['group', 'recorded-cad:alpha']]);
    assert.deepEqual(map.queries, [{ point, options: { layers: ['custom-cohort-group-labels-text'] } }]);
    assert.equal(map.states.length, 0); assert.equal(map.fits.length, 1);
  });
}
for (const reason of ['hidden', 'foreign']) test(`${reason} label hit cannot suppress ordinary exact parcel inspection`, async () => {
  const calls = [], props = { ...fixture(), onInspectPocket: id => calls.push(['group', id]), onInspectAccount: id => calls.push(['account', id]) };
  const h = harness(); await h.ready(props); h.showLabels(reason !== 'hidden');
  const label = { properties: { pocket_id: reason === 'hidden' ? 'recorded-cad:alpha' : 'recorded-cad:foreign' } };
  h.maps[0].renderedLabelHits = [label]; const point = { x: 100, y: 150 };
  h.emit('click', { point, features: [label] }, 'custom-cohort-group-labels-text');
  h.emit('click', { point, features: [{ properties: { account_id: 'B' } }] }, 'custom-cohort-parcels-fill');
  assert.deepEqual(calls, [['group', 'recorded-cad:beta'], ['account', 'B']]);
});
test('rendered-label query failure does not guess an underlying parcel inspection or leak renderer details', async () => {
  const calls = [], props = { ...fixture(), onInspectPocket: id => calls.push(id), onInspectAccount: id => calls.push(id) };
  const h = harness({ throwQuery: true }); await h.ready(props); h.showLabels(true);
  h.emit('click', { point: { x: 100, y: 150 }, features: [{ properties: { account_id: 'B' } }] }, 'custom-cohort-parcels-fill');
  assert.deepEqual(calls, []); assert.equal(h.maps[0].queries.length, 1); assert.doesNotMatch(h.html(), /synthetic renderer/);
});

test('selection-only updates with shared geometry reuse actual presentation rather than scanning all rings again', async () => {
  const props = scoredFixture(), h = harness(); await h.ready(props);
  const map = h.maps[0], initialLabels = map.getSource('custom-cohort-group-labels').data;
  assert.equal(h.presentationCount, 1);
  const changed = { ...props, group: { ...props.group, binding: { ...props.group.binding,
    selectionRevision: 2, selectionFingerprint: 'c'.repeat(64) }, parcel_map: { ...props.group.parcel_map,
    geojson: { type: 'FeatureCollection', features: props.group.parcel_map.geojson.features.map(f => ({
      ...f, properties: { ...f.properties, selected: !f.properties.selected },
    })) } } } };
  h.render(changed); assert.equal(h.presentationCount, 1);
  assert.equal(map.getSource('custom-cohort-group-labels').data, initialLabels);
  assert.equal(painted(map, 'A').selected, false); assert.equal(painted(map, 'B').selected, true);
  h.emit('idle'); h.changeColor('similarity'); h.showLabels(false); h.showLabels(true);
  h.render({ ...changed, freshness: 'stale', inspectedPocketId: 'recorded-cad:group-1' });
  assert.equal(h.presentationCount, 1); assert.equal(painted(map, 'B').fillColor, '#84cc16');
  assert.equal(map.fits.length, 1); assert.equal(h.loadCount, 1);
});
for (const kind of ['catalog', 'geometry_identity', 'ordered_parcel_ids', 'parcel_id', 'account_id', 'context', 'file', 'subject']) {
  test(`presentation cache invalidates on ${kind} change, executing the real helper`, async () => {
    const props = fixture(), h = harness(); await h.ready(props);
    assert.equal(h.presentationCount, 1);
    let next = { ...props };
    if (kind === 'catalog') next.catalog = structuredClone(props.catalog);
    else if (kind === 'context') next.group = { ...props.group, binding: { ...props.group.binding,
      contextRef: { ...contextRef, context_sha256: 'f'.repeat(64) } } };
    else if (kind === 'file') next.group = { ...props.group, binding: { ...props.group.binding, assignmentFileId: '18' } };
    else if (kind === 'subject') next.group = { ...props.group, binding: { ...props.group.binding, accountId: 'B' } };
    else {
      const features = [...props.group.parcel_map.geojson.features];
      if (kind === 'ordered_parcel_ids') features.reverse();
      else if (kind === 'geometry_identity') features[0] = { ...features[0], geometry: structuredClone(features[0].geometry) };
      else if (kind === 'parcel_id') features[0] = { ...features[0], id: 'gis.dcad_parcels:99',
        properties: { ...features[0].properties, object_id: '99' } };
      else {
        features[0] = { ...features[0], properties: { ...features[0].properties, account_id: 'B' } };
        features[1] = { ...features[1], properties: { ...features[1].properties, account_id: 'A' } };
      }
      next.group = { ...props.group, parcel_map: { ...props.group.parcel_map, geojson: { type: 'FeatureCollection', features } } };
    }
    h.render(next); assert.equal(h.presentationCount, 2);
    h.render(next); assert.equal(h.presentationCount, 2, 'ordinary render does not rescan unchanged input');
    h.unmount();
  });
}
test('same parcel IDs with changed coordinates in a new geometry never reuse the old label anchor', async () => {
  const props = fixture(), h = harness(); await h.ready(props); const map = h.maps[0];
  const before = map.getSource('custom-cohort-group-labels').data.features.find(f => f.properties.pocket_id === 'recorded-cad:alpha');
  const features = [...props.group.parcel_map.geojson.features];
  features[0] = { ...features[0], geometry: { type: 'Polygon',
    coordinates: features[0].geometry.coordinates.map(ring => ring.map(([x, y]) => [x - 1, y])) } };
  const next = { ...props, group: { ...props.group, parcel_map: { ...props.group.parcel_map,
    geojson: { type: 'FeatureCollection', features } } } };
  h.render(next); assert.equal(h.presentationCount, 2);
  const actual = map.getSource('custom-cohort-group-labels').data;
  assert.deepEqual(actual, buildCustomCohortMapPresentation(next).labels);
  const after = actual.features.find(f => f.properties.pocket_id === 'recorded-cad:alpha');
  assert.equal(after.id, before.id); assert.equal(after.properties.parcel_id, before.properties.parcel_id);
  assert.deepEqual(after.geometry.coordinates, [before.geometry.coordinates[0] - 1, before.geometry.coordinates[1]]);
  assert.equal(map.getSource('custom-cohort-parcels').replacements.length, 1);
});

test('parcel source promotes exact opaque parcel IDs and never generates array-index or account identity', async () => {
  const props = fixture(), h = harness();
  const extra = { ...props.group.parcel_map.geojson.features[0], id: 'gis.dcad_parcels:91',
    properties: { ...props.group.parcel_map.geojson.features[0].properties, object_id: '91' } };
  props.group.parcel_map.geojson.features.push(extra); const captured = JSON.stringify(props);
  await h.ready(props); const source = h.maps[0].getSource('custom-cohort-parcels');
  assert.equal(source.options.type, 'geojson'); assert.equal(source.options.promoteId, 'map_feature_id');
  assert.equal(source.options.generateId, undefined);
  assert.deepEqual(source.data.features.map(f => f.properties.map_feature_id),
    ['gis.dcad_parcels:1', 'gis.dcad_parcels:2', 'gis.dcad_parcels:3', 'gis.dcad_parcels:91']);
  source.data.features.forEach((feature, i) => {
    assert.equal(feature.properties.map_feature_id, props.group.parcel_map.geojson.features[i].id);
    assert.equal(feature.id, feature.properties.map_feature_id);
    assert.notEqual(feature.properties.map_feature_id, feature.properties.account_id);
    assert.notEqual(feature.properties.map_feature_id, String(i));
  });
  assert.equal(new Set(source.data.features.map(f => f.properties.map_feature_id)).size, 4, 'two parcels for one account remain distinct');
  assert.equal(JSON.stringify(props), captured);
  assert.equal(h.maps[0].getSource('custom-cohort-group-labels').options.promoteId, undefined);
});
test('every rendered feature-state ID matches its promoted parcel after reordering and geometry/source updates', async () => {
  const props = scoredFixture(), h = harness(); await h.ready(props); const map = h.maps[0];
  h.changeColor('similarity');
  assert.equal(painted(map, 'B').fillColor, '#84cc16', 'modeled rendered color changes through the promoted identity');
  const reversed = { ...props, group: { ...props.group, binding: { ...props.group.binding, selectionRevision: 2 },
    parcel_map: { ...props.group.parcel_map, geojson: { type: 'FeatureCollection', features: [...props.group.parcel_map.geojson.features].reverse() } } } };
  h.render(reversed); h.emit('idle');
  const features = reversed.group.parcel_map.geojson.features.map(f => ({ ...f, properties: { ...f.properties, selected: true },
    geometry: structuredClone(f.geometry) }));
  const firstA = features.find(f => f.properties.account_id === 'A');
  features.push({ ...firstA, id: 'gis.dcad_parcels:91', properties: { ...firstA.properties, object_id: '91' } });
  const begin = map.states.length, updated = { ...props, group: { ...props.group, binding: { ...props.group.binding, selectionRevision: 3 },
    parcel_map: { ...props.group.parcel_map, geojson: { type: 'FeatureCollection', features } } } };
  h.render(updated); const source = map.getSource('custom-cohort-parcels'), applied = map.states.slice(begin);
  assert.equal(source.options.promoteId, 'map_feature_id'); assert.equal(source.replacements.length, 2);
  assert.equal(applied.length, 7); assert.equal(map.renderedStates.length, map.states.length, 'all submitted states resolve to promoted IDs');
  const ids = source.data.features.map(f => f.properties.map_feature_id);
  assert.deepEqual(applied.map(row => row.feature.id), ids);
  applied.forEach(row => {
    assert.equal(row.feature.source, 'custom-cohort-parcels');
    const feature = source.data.features.find(f => f.properties.map_feature_id === row.feature.id); assert.ok(feature);
    assert.equal(feature.id, row.feature.id); assert.equal(paintedFeature(map, feature).selected, true);
  });
  const sameAccount = source.data.features.filter(f => f.properties.account_id === 'A');
  assert.equal(sameAccount.length, 2); assert.notEqual(sameAccount[0].properties.map_feature_id, sameAccount[1].properties.map_feature_id);
  assert.ok(sameAccount.every(f => paintedFeature(map, f).fillColor === '#15803d'));
  assert.equal(h.maps.length, 1); assert.equal(h.loadCount, 1);
});
