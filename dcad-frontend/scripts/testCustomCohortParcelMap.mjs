import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';

const requireRuntime = createRequire(new URL('../package.json', import.meta.url));
const { renderToStaticMarkup } = requireRuntime('react-dom/server');
// Execute the actual new pure presentation helper. Only the existing catalog
// constant is substituted; score/label logic is not replicated in this harness.
const presentationModule = loadTrustedRepositoryCommonJs(
  new URL('../src/features/neighborhood/customCohortMapPresentation.ts', import.meta.url),
  name => {
  assert.match(name, /customCohortPocketCatalog(?:\.ts)?$/);
  return { CUSTOM_COHORT_UNASSIGNED_GROUP: 'discovery:unassigned' };
  },
);
const { buildCustomCohortMapPresentation } = presentationModule;
const familiesModule = loadTrustedRepositoryCommonJs(
  new URL('../src/features/neighborhood/customCohortSubdivisionFamilies.ts', import.meta.url),
  name => { throw new Error(`Unexpected subdivision-family dependency: ${name}`); },
);
const { buildCustomCohortSubdivisionFamilies, buildCustomCohortSubdivisionPhases } = familiesModule;
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
function familyFixture({ largerSecondChild = false } = {}) {
  const props = fixture(), [first, second] = props.catalog.pockets;
  first.label = 'Alpha PHASE 1'; second.label = 'Alpha PHASE 2';
  if (largerSecondChild) {
    second.account_ids.push('D'); second.member_count++;
    props.catalog.coverage.discovery_member_count++; props.catalog.coverage.assigned_account_count++;
    props.group.parcel_map.geojson.features.push({ type: 'Feature', id: 'gis.dcad_parcels:4',
      properties: { object_id: '4', account_id: 'D', selected: false }, geometry: polygon(-96.6) });
  }
  // Use the real projection, detached only so refusal tests can tamper with it.
  props.subdivisionFamilies = structuredClone(buildCustomCohortSubdivisionFamilies(props.catalog));
  props.subdivisionFamilies.families[0].pocket_ids.reverse(); // Anchor choice must not rely on caller order.
  return props;
}
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
function harness({ rejectLoad = false, delayedLoad = false, throwPaint = false, throwQuery = false } = {}) {
  const cells = [], effects = [], layouts = [], maps = [], timers = new Map(), inspections = [];
  let cursor = 0, dirty = false, props, tree, nextTimer = 0, loadCount = 0, presentationCount = 0, resolveLoad;
  let phasePreparationCount = 0, phaseReadCount = 0, standalonePhaseReadCount = 0;
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
      assert.ok(JSON.stringify(options) === JSON.stringify({ layers: ['custom-cohort-subject-parcels-text', 'custom-cohort-group-labels-text'] })
        || JSON.stringify(options) === JSON.stringify({ layers: ['custom-cohort-subject-parcels-text'] }));
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
  // Child effects/network are covered by its own tests. Here its exact current
  // props let us exercise the map owner's real city-camera callback.
  function CityReferenceStub() { return null; }
  const loaded = loadTrustedRepositoryCommonJs(
    new URL('../src/features/neighborhood/components/CustomCohortParcelMap.tsx', import.meta.url),
    name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return requireRuntime(name);
    if (/\/customCohortMapPresentation(?:\.ts)?$/.test(name)) return { ...presentationModule,
      buildCustomCohortMapPresentation(...args) { presentationCount++; return buildCustomCohortMapPresentation(...args); } };
    if (name.endsWith('/NeighborhoodCityReferenceControl')) return { default: CityReferenceStub };
    if (name.endsWith('/customCohortPocketCatalog')) return { CUSTOM_COHORT_UNASSIGNED_GROUP: 'discovery:unassigned' };
    if (name.endsWith('/customCohortSubdivisionFamilies')) return { ...familiesModule,
      createCustomCohortSubdivisionPhaseReader(...args) {
        phasePreparationCount++; const read = familiesModule.createCustomCohortSubdivisionPhaseReader(...args);
        return family => { phaseReadCount++; return read(family); };
      },
      buildCustomCohortSubdivisionPhases(...args) {
        standalonePhaseReadCount++; return familiesModule.buildCustomCohortSubdivisionPhases(...args);
      } };
    assert.equal(name, '../../../lib/mapLibreRuntime');
    return { MAPLIBRE_BASE_STYLE: 'pinned-style', loadMapLibreRuntime() { loadCount++;
      return rejectLoad ? Promise.reject(new Error('load failed')) : delayedLoad ? runtimePromise : Promise.resolve(runtime); } };
    },
    { environment: { window, ResizeObserver } },
  );
  const Component = loaded.default;
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
    get phasePreparationCount() { return phasePreparationCount; }, get phaseReadCount() { return phaseReadCount; },
    get standalonePhaseReadCount() { return standalonePhaseReadCount; },
    node, cityProps: () => node(n => n.type === CityReferenceStub)?.props ?? null,
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
  assert.equal(map.layers.length, 4); assert.equal(map.layers[0].type, 'fill');
  assert.equal(map.layers[3].id, 'custom-cohort-subject-parcels-text');
  data.features.forEach((f, i) => assert.equal(f.geometry, props.group.parcel_map.geojson.features[i].geometry));
  assert.equal(data.features[0].geometry.coordinates.length, 2);
  assert.equal(data.features[2].geometry.coordinates.length, 2);
  assert.equal(map.fits.length, 1); assert.equal(map.options.attributionControl, true);
  assert.deepEqual(map.fits[0].bounds, [[-97, 32], [-96.78, 32.01]]);
  assert.match(h.html(), /Included · red outline/);
  assert.doesNotMatch(h.html(), /Color parcels by/);
  assert.match(h.html(), /not legal subdivision or neighborhood boundaries/); assert.doesNotMatch(h.html(), /Loading parcel map/);
});
test('optional presentation refusal retains the original geometry bounds and map', async () => {
  const props = fixture(), h = harness();
  props.group.parcel_map.geojson.features[0].properties.account_id = 'UNMATCHED';
  await h.ready(props);
  assert.equal(h.maps.length, 1);
  assert.deepEqual(h.maps[0].fits[0].bounds, [[-97, 32], [-96.78, 32.01]]);
  assert.match(h.html(), /Recorded labels and similarity colors are unavailable/);
});
test('recorded labels explicitly use the OpenFreeMap font across toggles and remounts', async () => {
  const props = fixture(), h = harness(); await h.ready(props);
  const assertFont = map => assert.deepEqual(map.getLayer('custom-cohort-group-labels-text').layout['text-font'], ['Noto Sans Regular']);
  assertFont(h.maps[0]);
  h.showLabels(false); h.showLabels(true);
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
  assert.ok(JSON.stringify(h.maps[0].layers).includes('#dc2626'));
  assert.match(h.html(), /Included · red outline/);
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
test('single similarity view leaves unsupported scores unknown and keeps inclusion in the red outline', async () => {
  const props = fixture(), before = JSON.stringify(props), h = harness(); await h.ready(props);
  assert.deepEqual(['A', 'B', 'C'].map(a => painted(h.maps[0], a).fillColor), ['#94a3b8', '#94a3b8', '#94a3b8']);
  assert.equal(painted(h.maps[0], 'A').selected, true);
  assert.equal(painted(h.maps[0], 'C').selected, true);
  const outline = h.maps[0].getLayer('custom-cohort-parcels-outline').paint;
  assert.ok(JSON.stringify(outline).includes('#dc2626'));
  assert.equal(outline['line-color'][2], '#dc2626', 'included red stays ahead of inspection color');
  assert.deepEqual(outline['line-width'].slice(0, 3), ['case', ['all',
    ['coalesce', ['feature-state', 'selected'], ['get', 'selected']],
    ['coalesce', ['feature-state', 'inspected'], ['get', 'inspected']]], 4]);
  assert.equal(h.node(n => n.type === 'select' && n.props['aria-label'] === 'Map color mode'), null);
  assert.match(h.html(), /unknown/i); assert.match(h.html(), /group/i);
  assert.equal(JSON.stringify(props), before); assert.equal(h.maps[0].fits.length, 1); assert.equal(h.loadCount, 1);
});
test('similarity uses exact fixed lower-bound bins, preserves selected flags and never scores unassigned parcels', async () => {
  const props = scoredFixture(), h = harness(); await h.ready(props);
  const original = h.maps[0].getSource('custom-cohort-parcels').data;
  const selected = original.features.map(f => f.properties.selected);
  const map = h.maps[0];
  assert.deepEqual(['A', 'B', 'C', 'D', 'E', 'F'].map(a => painted(map, a).fillColor),
    ['#15803d', '#84cc16', '#eab308', '#ea580c', '#94a3b8', '#94a3b8']);
  assert.deepEqual(['A', 'B', 'C', 'D', 'E', 'F'].map(a => painted(map, a).selected), selected);
  assert.equal(map.getSource('custom-cohort-parcels').data, original); assert.equal(map.fits.length, 1);
  assert.deepEqual(map.getLayer('custom-cohort-parcels-fill').paint['fill-color'], ['coalesce', ['feature-state', 'fillColor'], ['get', 'fillColor']]);
  assert.deepEqual(map.getLayer('custom-cohort-parcels-fill').paint['fill-opacity'], ['case', ['coalesce', ['feature-state', 'selected'], ['get', 'selected']], .72, .38]);
  assert.equal(painted(map, 'F').fillColor, '#94a3b8');
  assert.equal(h.maps.length, 1); assert.equal(h.loadCount, 1); assert.equal(map.fits.length, 1);
});
test('lower bounds immediately below a threshold stay in the preceding fixed bin', async () => {
  const h = harness(); await h.ready(scoredFixture([74.999, 49.999, 24.999, 0, null]));
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
  const h = harness(); await h.ready(props); const map = h.maps[0];
  assert.equal(painted(map, 'A').fillColor, '#84cc16'); assert.equal(painted(map, 'B').fillColor, '#84cc16');
  assert.equal(painted(map, 'A').selected, true); assert.equal(painted(map, 'B').selected, false);
  assert.equal(painted(map, 'A').subject, true); assert.equal(painted(map, 'B').subject, false);
  assert.equal(map.fits.length, 1); assert.equal(h.loadCount, 1);
});
test('insufficient recommendation leaves every similarity color unknown without changing inclusion', async () => {
  const props = scoredFixture(); props.catalog.recommendation.status = 'insufficient_observations';
  const h = harness(); await h.ready(props);
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
test('label visibility never reloads map/geometry, moves camera or calls selection/capture/save callbacks', async () => {
  const calls = [], props = { ...scoredFixture(), onInspectPocket: id => calls.push(id), onInspectAccount: id => calls.push(id),
    onSelectionChange: () => calls.push('selection'), onCapture: () => calls.push('capture'), onSave: () => calls.push('save') };
  const h = harness(); await h.ready(props); const map = h.maps[0], data = map.getSource('custom-cohort-parcels').data;
  h.showLabels(false); assert.deepEqual(map.getSource('custom-cohort-group-labels').data, { type: 'FeatureCollection', features: [] });
  h.showLabels(true); h.showLabels(false);
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
  h.emit('idle'); h.showLabels(false); h.showLabels(true);
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
    const parcelQuery = { point, options: { layers: ['custom-cohort-subject-parcels-text', 'custom-cohort-group-labels-text'] } };
    const labelQuery = { point, options: { layers: ['custom-cohort-subject-parcels-text'] } };
    assert.deepEqual(map.queries, order === 'parcel_first' ? [parcelQuery, labelQuery] : [labelQuery, parcelQuery]);
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
  h.emit('idle'); h.showLabels(false); h.showLabels(true);
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

test('activation reads live zoom at each click: below 15 subdivision, at and above 15 phase', async () => {
  const calls = [], legacy = [], props = { ...familyFixture(), onActivatePocket: (...args) => calls.push(args),
    onInspectPocket: id => legacy.push(id) }, h = harness(); await h.ready(props);
  const map = h.maps[0];
  assert.match(h.html(), /Subdivision view: clicks include all captured related phases/);
  for (const [zoom, mode] of [[14.999, 'subdivision'], [15, 'phase'], [15.001, 'phase'], [12, 'subdivision']]) {
    // Deliberately do not emit zoom or rerender: the callback must not use the
    // last React display mode, even when the camera changed moments ago.
    map.camera.zoom = zoom;
    h.emit('click', { features: [{ properties: { account_id: 'B' } }] }, 'custom-cohort-parcels-fill');
    h.emit('click', { features: [{ properties: { pocket_id: 'recorded-cad:alpha' } }] }, 'custom-cohort-group-labels-text');
    assert.deepEqual(calls.slice(-2), [['recorded-cad:beta', mode], ['recorded-cad:alpha', mode]]);
  }
  assert.deepEqual(legacy, []); assert.equal(map.states.length, 0);
  assert.equal(map.getSource('custom-cohort-parcels').replacements.length, 0);
});

test('right-click requests exclusion at live zoom without opening inspection or changing the map locally', async () => {
  const excluded = [], activated = [], props = { ...familyFixture(),
    onExcludePocket: (...args) => excluded.push(args), onActivatePocket: (...args) => activated.push(args) };
  const h = harness(); await h.ready(props); const map = h.maps[0]; let prevented = 0;
  const originalEvent = { preventDefault() { prevented++; } };
  map.camera.zoom = 14;
  h.emit('contextmenu', { originalEvent, features: [{ properties: { account_id: 'B' } }] }, 'custom-cohort-parcels-fill');
  map.camera.zoom = 15;
  h.emit('contextmenu', { originalEvent, features: [{ properties: { account_id: 'A' } }] }, 'custom-cohort-parcels-fill');
  h.emit('contextmenu', { originalEvent, features: [{ properties: { subject_marker: true,
    parcel_id: 'gis.dcad_parcels:1' } }] }, 'custom-cohort-subject-parcels-text');
  assert.deepEqual(excluded, [['recorded-cad:beta', 'subdivision'], ['recorded-cad:alpha', 'phase'],
    ['recorded-cad:alpha', 'phase']]);
  assert.equal(prevented, 3); assert.deepEqual(activated, []);
  assert.equal(map.states.length, 0); assert.equal(map.getSource('custom-cohort-parcels').replacements.length, 0);
});

test('zoom changes only interaction display and never reselects an excluded phase or replaces either source', async () => {
  const calls = [], props = { ...familyFixture(), onActivatePocket: (...args) => calls.push(args),
    onInspectPocket: id => calls.push(id), onInspectAccount: id => calls.push(id) }, original = JSON.stringify(props), h = harness();
  await h.ready(props); const map = h.maps[0], source = map.getSource('custom-cohort-parcels'), labels = map.getSource('custom-cohort-group-labels');
  const parcelData = source.data, labelData = labels.data;
  for (const zoom of [16, 14, 15, 14.999, 10, 17]) {
    map.camera.zoom = zoom; h.emit('zoom');
    assert.match(h.html(), zoom < 15 ? /data-map-interaction-mode="subdivision"/ : /data-map-interaction-mode="phase"/);
  }
  assert.equal(painted(map, 'B').selected, false); assert.deepEqual(calls, []);
  assert.equal(source.data, parcelData); assert.equal(labels.data, labelData);
  assert.equal(source.replacements.length, 0); assert.equal(labels.replacements.length, 0);
  assert.equal(map.states.length, 0); assert.equal(map.fits.length, 1); assert.equal(h.presentationCount, 1);
  assert.equal(JSON.stringify(props), original); assert.equal(h.loadCount, 1);
  assert.match(h.html(), /Zooming does not change your choices/);
  assert.match(h.html(), /not verified legal phases or coverage outside this capture/);
});

for (const largerSecondChild of [false, true]) test(`parent label keeps exact retained ${largerSecondChild ? 'largest child' : 'ID tie-break child'} anchor`, async () => {
  const props = familyFixture({ largerSecondChild }), original = JSON.stringify(props), h = harness(); await h.ready(props);
  const map = h.maps[0], labels = map.getSource('custom-cohort-group-labels').data.features;
  const expected = buildCustomCohortMapPresentation(props).labels.features;
  const parent = labels.filter(label => label.properties.subdivision_label);
  assert.equal(parent.length, 1);
  const chosenId = largerSecondChild ? 'recorded-cad:beta' : 'recorded-cad:alpha';
  const chosen = expected.find(label => label.properties.pocket_id === chosenId);
  assert.equal(parent[0].properties.pocket_id, chosenId); assert.equal(parent[0].properties.subdivision_label, 'Alpha');
  assert.equal(parent[0].properties.label, chosen.properties.label, 'raw phase name remains the close-view label');
  assert.deepEqual(parent[0].geometry, chosen.geometry);
  assert.equal(parent[0].properties.parcel_id, chosen.properties.parcel_id);
  assert.equal(parent[0].properties.account_id, chosen.properties.account_id);
  assert.equal(parent[0].properties.anchor_basis, 'retained_exterior_ring_vertex');
  labels.forEach((label, index) => assert.deepEqual(label.geometry, expected[index].geometry));
  assert.deepEqual(map.getLayer('custom-cohort-group-labels-text').layout['text-field'],
    ['step', ['zoom'], ['coalesce', ['get', 'subdivision_label'], ['get', 'label']], 15,
      ['coalesce', ['get', 'phase_label'], ['get', 'label']]]);
  assert.equal(JSON.stringify(props), original);
});

test('family highlight changes all child outlines using feature state, preserving excluded colors and original geometry', async () => {
  const props = familyFixture({ largerSecondChild: true }), h = harness(); await h.ready(props); const map = h.maps[0];
  const before = JSON.stringify(props), source = map.getSource('custom-cohort-parcels'), labels = map.getSource('custom-cohort-group-labels');
  h.render({ ...props, inspectedPocketId: 'discovery:unassigned', inspectedPocketIds: ['recorded-cad:alpha', 'recorded-cad:beta'] });
  assert.deepEqual(['A', 'B', 'C', 'D'].map(account => painted(map, account).inspected), [true, true, false, true]);
  assert.deepEqual(['A', 'B', 'C', 'D'].map(account => painted(map, account).selected), [true, false, true, false]);
  assert.equal(painted(map, 'B').fillColor, '#94a3b8');
  assert.equal(source.replacements.length, 0); assert.equal(labels.replacements.length, 0); assert.equal(map.fits.length, 1);
  source.data.features.forEach((feature, index) => assert.equal(feature.geometry, props.group.parcel_map.geojson.features[index].geometry));
  h.render({ ...props, inspectedPocketId: 'discovery:unassigned', inspectedPocketIds: [] });
  assert.ok(['A', 'B', 'C', 'D'].every(account => !painted(map, account).inspected), 'explicit empty set does not resurrect legacy highlight');
  assert.equal(JSON.stringify(props), before); assert.equal(h.presentationCount, 1);
});

for (const order of ['parcel_first', 'label_first']) test(`broad parent label wins once over another leaf footprint in ${order} order`, async () => {
  const calls = [], props = { ...familyFixture(), onActivatePocket: (...args) => calls.push(args),
    onInspectAccount: id => calls.push(['account', id]) }, h = harness(); await h.ready(props); const map = h.maps[0];
  map.camera.zoom = 14;
  const point = { x: 100, y: 150 }, label = { properties: { pocket_id: 'recorded-cad:alpha' } };
  map.renderedLabelHits = [label];
  const parcel = () => h.emit('click', { point, features: [{ properties: { account_id: 'B' } }] }, 'custom-cohort-parcels-fill');
  const text = () => h.emit('click', { point, features: [label] }, 'custom-cohort-group-labels-text');
  if (order === 'parcel_first') { parcel(); text(); } else { text(); parcel(); }
  assert.deepEqual(calls, [['recorded-cad:alpha', 'subdivision']]);
});

test('a hidden close-view label cannot suppress broad footprint activation, and becomes valid at zoom 15', async () => {
  const calls = [], props = { ...familyFixture(), onActivatePocket: (...args) => calls.push(args) }, h = harness(); await h.ready(props);
  const map = h.maps[0], point = { x: 1, y: 1 }, label = { properties: { pocket_id: 'recorded-cad:beta' } };
  map.renderedLabelHits = [label]; map.camera.zoom = 14;
  h.emit('click', { point, features: [label] }, 'custom-cohort-group-labels-text');
  h.emit('click', { point, features: [{ properties: { account_id: 'B' } }] }, 'custom-cohort-parcels-fill');
  assert.deepEqual(calls, [['recorded-cad:beta', 'subdivision']]);
  map.camera.zoom = 15;
  h.emit('click', { point, features: [label] }, 'custom-cohort-group-labels-text');
  h.emit('click', { point, features: [{ properties: { account_id: 'A' } }] }, 'custom-cohort-parcels-fill');
  assert.deepEqual(calls, [['recorded-cad:beta', 'subdivision'], ['recorded-cad:beta', 'phase']]);
});

for (const corruption of ['context', 'version', 'foreign_child', 'duplicate_child', 'missing_child', 'foreign_index']) {
  test(`a ${corruption} family model cannot relabel the current exact catalog`, async () => {
    const props = familyFixture(), model = props.subdivisionFamilies;
    if (corruption === 'context') model.context_ref.context_sha256 = 'f'.repeat(64);
    if (corruption === 'version') model.profile_version = 2;
    if (corruption === 'foreign_child') model.families[0].pocket_ids[0] = 'recorded-cad:foreign';
    if (corruption === 'duplicate_child') model.families[0].pocket_ids[0] = model.families[0].pocket_ids[1];
    if (corruption === 'missing_child') model.families[0].pocket_ids.pop();
    if (corruption === 'foreign_index') model.family_id_by_pocket_id['recorded-cad:alpha'] = 'family:foreign';
    const h = harness(); await h.ready(props);
    assert.deepEqual(h.maps[0].getSource('custom-cohort-group-labels').data, buildCustomCohortMapPresentation(props).labels);
  });
}

test('legacy inspection callbacks remain available at both zoom levels when activation is absent', async () => {
  const calls = [], props = { ...familyFixture(), onInspectPocket: id => calls.push(id) }, h = harness(); await h.ready(props);
  for (const zoom of [14, 15, 17]) {
    h.maps[0].camera.zoom = zoom;
    h.emit('click', { features: [{ properties: { account_id: 'B' } }] }, 'custom-cohort-parcels-fill');
  }
  assert.deepEqual(calls, ['recorded-cad:beta', 'recorded-cad:beta', 'recorded-cad:beta']);
});

for (const zoom of [NaN, Infinity, undefined]) test(`unavailable live zoom (${String(zoom)}) refuses activation without guessing a mode`, async () => {
  const calls = [], props = { ...familyFixture(), onActivatePocket: (...args) => calls.push(args), onInspectAccount: id => calls.push(id) };
  const h = harness(); await h.ready(props); h.maps[0].camera.zoom = zoom;
  h.emit('zoom');
  h.emit('click', { features: [{ properties: { account_id: 'B' } }] }, 'custom-cohort-parcels-fill');
  h.emit('click', { features: [{ properties: { pocket_id: 'recorded-cad:alpha' } }] }, 'custom-cohort-group-labels-text');
  assert.deepEqual(calls, []); assert.match(h.html(), /data-map-interaction-mode="unavailable"/);
});

test('latest activation callback replaces the old callback without remounting and disposed camera events do nothing', async () => {
  const calls = [], props = { ...familyFixture(), onActivatePocket: (...args) => calls.push(['old', ...args]) }, h = harness(); await h.ready(props);
  const map = h.maps[0]; h.render({ ...props, onActivatePocket: (...args) => calls.push(['new', ...args]) });
  map.camera.zoom = 16;
  h.emit('click', { features: [{ properties: { account_id: 'B' } }] }, 'custom-cohort-parcels-fill');
  assert.deepEqual(calls, [['new', 'recorded-cad:beta', 'phase']]); assert.equal(h.maps.length, 1);
  h.unmount(); map.camera.zoom = 12; map.emit('zoom');
  map.emit('click', { features: [{ properties: { account_id: 'A' } }] }, 'custom-cohort-parcels-fill');
  assert.deepEqual(calls, [['new', 'recorded-cad:beta', 'phase']]); assert.equal(h.timers.size, 0);
});

test('SUBJECT marker uses an exact subject exterior vertex, not another group member or a computed centroid', async () => {
  const props = fixture(), original = JSON.stringify(props), h = harness(); await h.ready(props); const map = h.maps[0];
  const marker = map.getSource('custom-cohort-subject-parcels').data.features;
  assert.equal(marker.length, 1);
  assert.deepEqual(marker[0], { type: 'Feature', id: 'gis.dcad_parcels:1',
    geometry: { type: 'Point', coordinates: props.group.parcel_map.geojson.features[0].geometry.coordinates[0][0] },
    properties: { subject_marker: true, account_id: 'A', parcel_id: 'gis.dcad_parcels:1', anchor_basis: 'retained_exterior_ring_vertex' } });
  const layer = map.getLayer('custom-cohort-subject-parcels-text');
  assert.equal(layer.layout['text-field'], 'SUBJECT\n▼');
  assert.equal(layer.layout['text-allow-overlap'], true); assert.equal(layer.layout['text-ignore-placement'], true);
  assert.equal(layer.paint['text-color'], '#7e22ce');
  assert.match(h.html(), /Subject pointer/);
  assert.doesNotMatch(h.html(), /SUBJECT marks the retained subject parcel/); assert.equal(JSON.stringify(props), original);
});

test('every disjoint subject parcel receives its own retained marker, including a MultiPolygon parcel', async () => {
  const props = fixture(), first = props.group.parcel_map.geojson.features[0];
  props.group.parcel_map.geojson.features.push({ ...first, id: 'gis.dcad_parcels:91',
    properties: { ...first.properties, object_id: '91', selected: false },
    geometry: { type: 'MultiPolygon', coordinates: [polygon(-96.2).coordinates, polygon(-96.1).coordinates] } });
  const h = harness(); await h.ready(props); const map = h.maps[0], markers = map.getSource('custom-cohort-subject-parcels').data.features;
  assert.equal(markers.length, 2); assert.deepEqual(markers.map(marker => marker.properties.parcel_id), ['gis.dcad_parcels:1', 'gis.dcad_parcels:91']);
  assert.deepEqual(markers[1].geometry.coordinates, [-96.2, 32]); assert.ok(markers.every(marker => marker.properties.account_id === 'A'));
  assert.match(h.html(), /Subject pointer/);
  assert.equal(map.getSource('custom-cohort-parcels').data.features.length, 4);
});

test('SUBJECT marker is independent of group-label visibility, zoom, inspection and selection styling', async () => {
  const calls = [], props = { ...familyFixture(), onActivatePocket: (...args) => calls.push(args) }, h = harness(); await h.ready(props);
  const map = h.maps[0], source = map.getSource('custom-cohort-subject-parcels'), data = source.data;
  h.showLabels(false);
  map.camera.zoom = 17; h.emit('zoom'); map.camera.zoom = 12; h.emit('zoom');
  const next = { ...props, inspectedPocketIds: ['recorded-cad:beta'], group: { ...props.group,
    parcel_map: { ...props.group.parcel_map, geojson: { type: 'FeatureCollection', features: props.group.parcel_map.geojson.features.map(feature => ({
      ...feature, properties: { ...feature.properties, selected: false } })) } } } };
  h.render(next); h.emit('idle');
  assert.equal(source.data, data); assert.equal(source.replacements.length, 0); assert.equal(data.features.length, 1);
  assert.equal(painted(map, 'A').selected, false); assert.equal(painted(map, 'B').inspected, true);
  assert.deepEqual(calls, []); assert.equal(map.fits.length, 1); assert.equal(h.loadCount, 1);
});

test('missing subject geometry has an explicit omitted marker, never a peer parcel fallback', async () => {
  const props = fixture(); props.group.parcel_map.geojson.features = props.group.parcel_map.geojson.features.filter(feature => feature.properties.account_id !== 'A');
  const h = harness(); await h.ready(props);
  assert.deepEqual(h.maps[0].getSource('custom-cohort-subject-parcels').data.features, []);
  assert.match(h.html(), /Subject pointer unavailable because captured subject geometry is missing/);
});

test('invalid subject vertex does not become a guessed point, while valid retained parcels stay unchanged', async () => {
  const props = fixture(); props.group.parcel_map.geojson.features[0].geometry.coordinates[0][0] = [NaN, 200];
  const h = harness(); await h.ready(props);
  assert.deepEqual(h.maps[0].getSource('custom-cohort-subject-parcels').data.features, []);
  assert.equal(h.maps[0].getSource('custom-cohort-parcels').data.features[1].geometry, props.group.parcel_map.geojson.features[1].geometry);
});

for (const zoom of [14, 15]) test(`subject marker click wins once over an overlapping phase label and parcel at zoom ${zoom}`, async () => {
  for (const order of [['parcel', 'label', 'subject'], ['subject', 'label', 'parcel'], ['label', 'parcel', 'subject']]) {
    const calls = [], props = { ...familyFixture(), onActivatePocket: (...args) => calls.push(args),
      onInspectAccount: account => calls.push(['account', account]) }, h = harness(); await h.ready(props);
    const map = h.maps[0], marker = map.getSource('custom-cohort-subject-parcels').data.features[0], point = { x: 1, y: 1 };
    map.camera.zoom = zoom; map.renderedLabelHits = [marker, { properties: { pocket_id: 'recorded-cad:beta' } }];
    const actions = {
      parcel: () => h.emit('click', { point, features: [{ properties: { account_id: 'B' } }] }, 'custom-cohort-parcels-fill'),
      label: () => h.emit('click', { point, features: [{ properties: { pocket_id: 'recorded-cad:alpha' } }] }, 'custom-cohort-group-labels-text'),
      subject: () => h.emit('click', { point, features: [marker] }, 'custom-cohort-subject-parcels-text'),
    };
    order.forEach(action => actions[action]());
    assert.deepEqual(calls, [['recorded-cad:alpha', zoom < 15 ? 'subdivision' : 'phase'], ['account', 'A']]);
    h.unmount();
  }
});

test('foreign subject marker cannot activate or suppress an admitted parcel, and disposed marker cannot act', async () => {
  const calls = [], props = { ...familyFixture(), onActivatePocket: (...args) => calls.push(args) }, h = harness(); await h.ready(props);
  const map = h.maps[0], point = { x: 1, y: 1 }, foreign = { properties: { subject_marker: true, account_id: 'A', parcel_id: 'foreign' } };
  map.renderedLabelHits = [foreign];
  h.emit('click', { point, features: [foreign] }, 'custom-cohort-subject-parcels-text');
  h.emit('click', { point, features: [{ properties: { account_id: 'B' } }] }, 'custom-cohort-parcels-fill');
  assert.deepEqual(calls, [['recorded-cad:beta', 'subdivision']]);
  const marker = map.getSource('custom-cohort-subject-parcels').data.features[0];
  h.unmount(); map.emit('click', { point, features: [marker] }, 'custom-cohort-subject-parcels-text');
  assert.equal(calls.length, 1);
});

test('a changed retained subject geometry replaces its point exactly, while removed subject identity refuses stale marker clicks', async () => {
  const calls = [], props = { ...familyFixture(), onActivatePocket: (...args) => calls.push(args) }, h = harness(); await h.ready(props);
  const map = h.maps[0], source = map.getSource('custom-cohort-subject-parcels'), previous = source.data.features[0];
  const features = [...props.group.parcel_map.geojson.features];
  features[0] = { ...features[0], id: 'gis.dcad_parcels:99', properties: { ...features[0].properties, object_id: '99' }, geometry: polygon(-95.5) };
  h.render({ ...props, group: { ...props.group, parcel_map: { ...props.group.parcel_map, geojson: { type: 'FeatureCollection', features } } } });
  assert.equal(source.replacements.length, 1); assert.deepEqual(source.data.features[0].geometry.coordinates, [-95.5, 32]);
  h.emit('click', { features: [previous] }, 'custom-cohort-subject-parcels-text'); assert.deepEqual(calls, []);
  h.emit('click', { features: [source.data.features[0]] }, 'custom-cohort-subject-parcels-text');
  assert.deepEqual(calls, [['recorded-cad:alpha', 'subdivision']]);
});

function mixedWillowMapFixture() {
  const props = fixture(), id = number => `recorded-cad:${String(number).padStart(64, '0')}`;
  const rows = [['WILLOW RUN NO 5', 1], ['WILLOW RUN 3', 1], ['WILLOW RUN 5', 145],
    ['WILLOW RUN PH 2', 67], ['WILLOW RUN 4', 26], ['WILLOW RUN PH 1', 65], ['WILLOW RUN PH 3', 3]];
  props.catalog.pockets = rows.map(([label, member_count], index) => ({ id: id(index + 1), label,
    county: index % 2 ? 'DALLAS COUNTY' : 'Dallas', member_count,
    account_ids: Array.from({ length: member_count }, (_, member) => index === 2 && member === 0 ? 'A' : `Willow-${index}-${member}`) }));
  props.catalog.unassigned = { account_ids: [], member_count: 0, reason_counts: [] };
  props.catalog.coverage = { discovery_member_count: 308, assigned_account_count: 308, unassigned_account_count: 0 };
  props.catalog.subject_membership.assigned_pocket_id = id(3);
  props.group.parcel_map.geojson.features = props.catalog.pockets.flatMap(pocket => pocket.account_ids).map((account_id, index) => ({
    type: 'Feature', id: `gis.dcad_parcels:${index + 1}`, properties: { object_id: String(index + 1), account_id, selected: account_id === 'A' },
    geometry: polygon(-97 + index / 10_000),
  }));
  props.subdivisionFamilies = buildCustomCohortSubdivisionFamilies(props.catalog);
  return { props, id };
}

test('mixed bare/PH Willow map retains one 307-account broad family, standalone NO 5, and distinct raw 3 versus PH 3 near labels', async t => {
  const { props, id } = mixedWillowMapFixture(), before = JSON.stringify(props), h = harness(); t.after(() => h.unmount());
  await h.ready(props);
  const family = props.subdivisionFamilies.families.find(item => item.label === 'WILLOW RUN');
  assert.ok(family); assert.equal(family.basis, 'candidate_numbered_name'); assert.equal(family.member_count, 307);
  assert.deepEqual([...family.pocket_ids].sort(), [2, 3, 4, 5, 6, 7].map(id));
  const separate = props.subdivisionFamilies.families.find(item => item.pocket_ids.includes(id(1)));
  assert.equal(separate.basis, 'standalone'); assert.equal(separate.member_count, 1);
  const map = h.maps[0], labels = map.getSource('custom-cohort-group-labels').data.features;
  const broad = labels.filter(label => label.properties.subdivision_label === 'WILLOW RUN');
  assert.equal(broad.length, 1); assert.equal(broad[0].properties.pocket_id, id(3), 'largest original 145-account leaf anchors the broad label');
  assert.equal(broad[0].properties.label, 'WILLOW RUN 5', 'the broad alias never overwrites the retained raw name');
  assert.equal(labels.find(label => label.properties.pocket_id === id(1)).properties.subdivision_label, 'WILLOW RUN NO 5');
  const phases = buildCustomCohortSubdivisionPhases(props.catalog, family);
  assert.equal(phases.length, 6);
  assert.deepEqual(Object.fromEntries(phases.map(phase => [phase.label, phase.member_count])), {
    'WILLOW RUN 3': 1, 'WILLOW RUN 5': 145, 'WILLOW RUN PH 2': 67,
    'WILLOW RUN 4': 26, 'WILLOW RUN PH 1': 65, 'WILLOW RUN PH 3': 3,
  });
  for (const pocket of props.catalog.pockets) {
    const label = labels.find(item => item.properties.pocket_id === pocket.id);
    assert.equal(label.properties.phase_label, pocket.label); assert.equal(label.properties.label, pocket.label);
  }
  assert.deepEqual(phases.find(phase => phase.label === 'WILLOW RUN 3').pocket_ids, [id(2)]);
  assert.deepEqual(phases.find(phase => phase.label === 'WILLOW RUN PH 3').pocket_ids, [id(7)]);
  const originalLabels = buildCustomCohortMapPresentation(props).labels.features;
  labels.forEach((label, index) => assert.deepEqual(label.geometry, originalLabels[index].geometry));
  assert.equal(map.getSource('custom-cohort-parcels').data.features.length, 308);
  assert.equal(JSON.stringify(props), before, 'display grouping does not rewrite original parcels or catalog membership');
});

test('mixed bare/PH Willow actual broad and near map clicks emit original leaf IDs without collapsing equal-number raw phases', async t => {
  const { props, id } = mixedWillowMapFixture(), calls = [], h = harness(); t.after(() => h.unmount());
  props.onActivatePocket = (...args) => calls.push(args);
  await h.ready(props); const map = h.maps[0];
  const click = pocketId => h.emit('click', { features: [{ properties: { pocket_id: pocketId } }] }, 'custom-cohort-group-labels-text');
  map.camera.zoom = 14; click(id(3)); assert.deepEqual(calls, [[id(3), 'subdivision']]);
  map.camera.zoom = 15; click(id(2)); click(id(7));
  assert.deepEqual(calls.slice(1), [[id(2), 'phase'], [id(7), 'phase']]);
  map.camera.zoom = 14; click(id(1)); assert.deepEqual(calls.at(-1), [id(1), 'subdivision']);
  assert.equal(map.getSource('custom-cohort-parcels').replacements.length, 0);
  assert.equal(map.getSource('custom-cohort-group-labels').replacements.length, 0);
});

function countyAliasPhaseFixture() {
  const props = fixture();
  props.catalog.pockets[0].label = 'MONICA PARK 1'; props.catalog.pockets[1].label = 'MONICA PARK 2';
  props.catalog.pockets.push({ id: 'recorded-cad:alpha-large', label: 'MONICA PARK 1', county: 'DALLAS COUNTY',
    account_ids: ['D', 'E', 'F'], member_count: 3 },
  { id: 'recorded-cad:beta-tiny', label: 'MONICA PARK 2', county: 'DALLAS COUNTY', account_ids: ['G'], member_count: 1 });
  props.catalog.coverage.assigned_account_count = 6; props.catalog.coverage.discovery_member_count = 7;
  for (const [i, account_id] of ['D', 'E', 'F', 'G'].entries()) props.group.parcel_map.geojson.features.push({
    type: 'Feature', id: `gis.dcad_parcels:${i + 4}`, properties: { object_id: String(i + 4), account_id, selected: false },
    geometry: polygon(-96.5 + i / 100) });
  props.subdivisionFamilies = buildCustomCohortSubdivisionFamilies(props.catalog);
  assert.equal(props.subdivisionFamilies.families.length, 1, 'real helper groups duplicate phase suffixes under supported county aliases');
  return props;
}

test('near labels consolidate county-alias phase contributions using the largest retained anchor and stable leaf-ID tie break', async () => {
  const props = countyAliasPhaseFixture(), original = JSON.stringify(props), h = harness(); await h.ready(props);
  const map = h.maps[0], labels = map.getSource('custom-cohort-group-labels').data.features;
  const phases = buildCustomCohortSubdivisionPhases(props.catalog, props.subdivisionFamilies.families[0]);
  assert.equal(phases.length, 2); assert.deepEqual(phases.map(phase => phase.member_count), [4, 2]);
  const near = labels.filter(label => label.properties.phase_label);
  assert.deepEqual(near.map(label => [label.properties.pocket_id, label.properties.phase_label]),
    [['recorded-cad:alpha-large', 'MONICA PARK 1'], ['recorded-cad:beta', 'MONICA PARK 2']]);
  assert.equal(labels.filter(label => label.properties.subdivision_label).length, 1);
  assert.equal(labels.find(label => label.properties.subdivision_label).properties.pocket_id, 'recorded-cad:alpha-large', 'far anchor remains largest original child');
  const originalLabels = buildCustomCohortMapPresentation(props).labels.features;
  near.forEach(label => {
    const retained = originalLabels.find(candidate => candidate.properties.pocket_id === label.properties.pocket_id);
    assert.deepEqual(label.geometry, retained.geometry);
    assert.equal(label.properties.account_id, retained.properties.account_id); assert.equal(label.properties.parcel_id, retained.properties.parcel_id);
    assert.equal(label.properties.label, retained.properties.label, 'literal original label is not overwritten');
  });
  assert.equal(JSON.stringify(props), original);
});

test('near phase highlight covers large and tiny county counterparts while preserving each leaf inclusion color', async () => {
  const props = countyAliasPhaseFixture(), h = harness(); await h.ready(props);
  const phase = buildCustomCohortSubdivisionPhases(props.catalog, props.subdivisionFamilies.families[0])
    .find(row => row.pocket_ids.includes('recorded-cad:alpha'));
  assert.equal(phase.pocket_ids.length, 2);
  const map = h.maps[0], labels = map.getSource('custom-cohort-group-labels'), labelData = labels.data;
  h.render({ ...props, inspectedPocketIds: phase.pocket_ids });
  assert.deepEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(account => painted(map, account).inspected), [true, false, false, true, true, true, false]);
  assert.deepEqual(['A', 'D', 'E', 'F'].map(account => painted(map, account).selected), [true, false, false, false]);
  assert.equal(painted(map, 'D').fillColor, '#94a3b8');
  assert.equal(labels.data, labelData); assert.equal(labels.replacements.length, 0);
  assert.equal(map.getSource('custom-cohort-parcels').replacements.length, 0); assert.equal(map.fits.length, 1);
});

for (const order of ['parcel_first', 'label_first']) test(`consolidated phase label activates once over tiny counterpart in ${order} order`, async () => {
  const calls = [], props = { ...countyAliasPhaseFixture(), onActivatePocket: (...args) => calls.push(args),
    onInspectPocket: id => calls.push(['legacy', id]), onInspectAccount: id => calls.push(['account', id]),
    onSave: () => assert.fail('Map must not write selections') }, h = harness(); await h.ready(props);
  const map = h.maps[0], point = { x: 1, y: 1 }, label = { properties: { pocket_id: 'recorded-cad:alpha-large' } };
  map.camera.zoom = 15; map.renderedLabelHits = [label];
  const parcel = () => h.emit('click', { point, features: [{ properties: { account_id: 'A' } }] }, 'custom-cohort-parcels-fill');
  const text = () => h.emit('click', { point, features: [label] }, 'custom-cohort-group-labels-text');
  if (order === 'parcel_first') { parcel(); text(); } else { text(); parcel(); }
  assert.deepEqual(calls, [['recorded-cad:alpha-large', 'phase']], 'one original leaf callback, not a synthetic phase ID or a duplicate inclusion request');
  const phase = buildCustomCohortSubdivisionPhases(props.catalog, props.subdivisionFamilies.families[0])
    .find(candidate => candidate.pocket_ids.includes(calls[0][0]));
  assert.deepEqual(new Set(phase.pocket_ids), new Set(['recorded-cad:alpha', 'recorded-cad:alpha-large']));
  assert.equal(phase.member_count, 4);
});

test('hidden duplicate phase label is not clickable and cannot suppress its valid original footprint', async () => {
  const calls = [], props = { ...countyAliasPhaseFixture(), onActivatePocket: (...args) => calls.push(args) }, h = harness(); await h.ready(props);
  const map = h.maps[0], point = { x: 2, y: 2 }, hidden = { properties: { pocket_id: 'recorded-cad:alpha' } };
  map.camera.zoom = 15; map.renderedLabelHits = [hidden];
  h.emit('click', { point, features: [hidden] }, 'custom-cohort-group-labels-text');
  h.emit('click', { point, features: [{ properties: { account_id: 'A' } }] }, 'custom-cohort-parcels-fill');
  assert.deepEqual(calls, [['recorded-cad:alpha', 'phase']]);
  map.camera.zoom = 12; h.emit('zoom'); map.camera.zoom = 17; h.emit('zoom');
  assert.equal(calls.length, 1); assert.equal(map.getSource('custom-cohort-group-labels').replacements.length, 0);
});

test('many map families share one actual phase metadata preparation per projection, with none on zoom or highlight', async () => {
  const props = fixture(), count = 64;
  props.catalog.pockets = Array.from({ length: count }, (_, i) => ({ id: `recorded-cad:separate-${String(i).padStart(3, '0')}`,
    label: `Separate ${i} North`, county: 'Dallas', account_ids: [i === 0 ? 'A' : `X${i}`], member_count: 1 }));
  props.catalog.coverage = { discovery_member_count: count + 1, assigned_account_count: count, unassigned_account_count: 1 };
  props.catalog.subject_membership.assigned_pocket_id = props.catalog.pockets[0].id;
  props.group.parcel_map.geojson.features = [...props.catalog.pockets.map((pocket, i) => ({ type: 'Feature', id: `gis.dcad_parcels:${i + 1}`,
    properties: { object_id: String(i + 1), account_id: pocket.account_ids[0], selected: true }, geometry: polygon(-97 + i / 1000) })),
  { type: 'Feature', id: 'gis.dcad_parcels:65', properties: { object_id: '65', account_id: 'C', selected: false }, geometry: polygon(-96.9) }];
  props.subdivisionFamilies = buildCustomCohortSubdivisionFamilies(props.catalog);
  assert.equal(props.subdivisionFamilies.families.length, count);
  const h = harness(); await h.ready(props); const map = h.maps[0];
  assert.equal(h.phasePreparationCount, 1); assert.equal(h.phaseReadCount, count);
  assert.equal(h.standalonePhaseReadCount, 0, 'the per-family convenience builder must not reprepare the whole catalog');
  const labelData = map.getSource('custom-cohort-group-labels').data;
  map.camera.zoom = 17; h.emit('zoom'); map.camera.zoom = 12; h.emit('zoom');
  h.render({ ...props, inspectedPocketIds: props.catalog.pockets.slice(0, 3).map(pocket => pocket.id) });
  assert.equal(h.phasePreparationCount, 1); assert.equal(h.phaseReadCount, count);
  assert.equal(map.getSource('custom-cohort-group-labels').data, labelData);
  assert.equal(map.getSource('custom-cohort-parcels').replacements.length, 0);
  const catalog = structuredClone(props.catalog);
  h.render({ ...props, catalog, subdivisionFamilies: buildCustomCohortSubdivisionFamilies(catalog) });
  assert.equal(h.phasePreparationCount, 2); assert.equal(h.phaseReadCount, count * 2, 'a new projection receives one independent prepared reader');
  assert.equal(h.standalonePhaseReadCount, 0);
});
