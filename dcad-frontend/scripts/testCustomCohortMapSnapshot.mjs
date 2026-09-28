import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';

const requireRuntime = createRequire(new URL('../package.json', import.meta.url));
const family = { id: 'family', label: 'MONICA PARK', pocket_ids: ['phase-1', 'phase-2'] };
const catalog = { pockets: [{ id: 'phase-1', label: 'MONICA PARK 1' }, { id: 'phase-2', label: 'MONICA PARK 2' }] };
const children = node => [node?.props?.children].flat(Infinity);
const walk = node => node && typeof node === 'object' ? [node, ...children(node).flatMap(walk)] : [];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : node && typeof node === 'object' ? children(node).map(text).join('') : '';
function harness() {
  const cells = []; let cursor = 0, closes = 0;
  const react = {
    useRef(initial) { const index = cursor++; cells[index] ??= { current: initial }; return cells[index]; },
    useState(initial) { const index = cursor++; cells[index] ??= { value: initial };
      return [cells[index].value, value => { cells[index].value = typeof value === 'function' ? value(cells[index].value) : value; }]; },
  };
  function InspectorStub() { return null; }
  const loaded = loadTrustedRepositoryCommonJs(new URL('../src/features/neighborhood/components/CustomCohortMapSnapshot.tsx', import.meta.url), key => {
    if (key === 'react') return react;
    if (key === 'react/jsx-runtime') return requireRuntime(key);
    if (key === '../customCohortSubdivisionFamilies') return { buildCustomCohortSubdivisionPhases: () => [
      { id: 'phase-one', label: 'MONICA PARK 1', pocket_ids: ['phase-1'] },
      { id: 'phase-two', label: 'MONICA PARK 2', pocket_ids: ['phase-2'] },
    ] };
    if (key === './CustomCohortPocketInspector') return { __esModule: true, default: InspectorStub };
    assert.fail(`Unexpected dependency ${key}`);
  });
  const props = { family, catalog, input: { accountId: 'A', assignmentFileId: '4', contextRef: {} },
    included: ['phase-1'], paused: false, previewTransport() {}, onClose() { closes++; } };
  return { props, inspector: tree => walk(tree).find(node => node.type === InspectorStub)?.props,
    render(overrides = {}) { cursor = 0; return loaded.default({ ...props, ...overrides }); },
    get closes() { return closes; } };
}

test('area snapshot keeps the exact combined subdivision input at every view level', () => {
  const h = harness(), parent = h.render();
  assert.equal(parent.props['aria-label'], 'MONICA PARK area snapshot');
  assert.notEqual(parent.props.role, 'dialog'); assert.notEqual(parent.props['aria-modal'], true);
  assert.match(text(parent), /Partly included/);
  assert.equal(h.inspector(parent).pocketIds, family.pocket_ids);
  assert.equal(h.inspector(parent).pocketId, 'phase-1'); assert.equal(h.inspector(parent).label, 'MONICA PARK');
  for (const tree of [parent]) {
    const inspector = h.inspector(tree);
    assert.equal(inspector.input, h.props.input); assert.equal(inspector.catalog, h.props.catalog);
    assert.equal(inspector.previewTransport, h.props.previewTransport);
    assert.equal(inspector.paused, false); assert.equal(inspector.compact, true);
  }
  assert.equal(h.inspector(h.render({ paused: true })).paused, true);
  assert.equal(h.closes, 0);
});

test('snapshot fills normal document flow with a static header and no map coordinates or dragging', () => {
  const card = harness().render(), nodes = walk(card), header = nodes.find(node => node.type === 'header');
  assert.equal(card.type, 'section', 'a normal block section spans the available workspace width');
  assert.equal(card.props.style?.width, undefined);
  assert.doesNotMatch(card.props.className, /(?:^|\s)(?:w-\[|w-\d|max-w-)/, 'no former fixed-width map-card cap');
  for (const node of nodes) {
    assert.doesNotMatch(node.props.className ?? '', /\b(?:absolute|fixed|cursor-move|touch-none)\b/);
    assert.equal(node.props.onPointerMove, undefined); assert.equal(node.props.onPointerUp, undefined);
    assert.equal(node.props.onPointerCancel, undefined);
    for (const key of ['left', 'top', 'right', 'bottom', 'transform']) assert.equal(node.props.style?.[key], undefined);
    assert.notEqual(node.props.style?.position, 'absolute'); assert.notEqual(node.props.style?.position, 'fixed');
  }
  assert.ok(header); assert.equal(header.props.onPointerDown, undefined);
  assert.match(nodes.map(node => node.props.className ?? '').join(' '), /amber/);
  assert.match(nodes.map(node => node.props.className ?? '').join(' '), /violet/);
  assert.ok(nodes.some(node => /overflow-y-auto/.test(node.props.className ?? '')), 'inspector content can scroll without covering the map');
});

test('Close and Escape still dismiss the panel without mutating accepted inclusion or inspector inputs', () => {
  const h = harness(), before = JSON.stringify(h.props), card = h.render();
  const close = walk(card).find(node => node.type === 'button' && node.props['aria-label'] === 'Close area snapshot');
  assert.ok(close); assert.equal(close.props.type, 'button');
  card.props.onKeyDown({ key: 'Enter' }); assert.equal(h.closes, 0);
  card.props.onKeyDown({ key: 'Escape' }); assert.equal(h.closes, 1);
  close.props.onClick(); assert.equal(h.closes, 2);
  assert.equal(JSON.stringify(h.props), before);
});
