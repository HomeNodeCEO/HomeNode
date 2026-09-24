import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';

const requireRuntime = createRequire(new URL('../package.json', import.meta.url));
const family = { id: 'family', label: 'MONICA PARK', pocket_ids: ['phase-1', 'phase-2'] };
const catalog = { pockets: [{ id: 'phase-1', label: 'MONICA PARK 1' }, { id: 'phase-2', label: 'MONICA PARK 2' }] };
function harness() {
  const cells = []; let cursor = 0, closes = 0;
  const react = {
    useRef(initial) { const index = cursor++; cells[index] ??= { current: initial }; return cells[index]; },
    useState(initial) { const index = cursor++; cells[index] ??= { value: initial };
      return [cells[index].value, value => { cells[index].value = typeof value === 'function' ? value(cells[index].value) : value; }]; },
  };
  const loaded = loadTrustedRepositoryCommonJs(new URL('../src/features/neighborhood/components/CustomCohortMapSnapshot.tsx', import.meta.url), key => {
    if (key === 'react') return react;
    if (key === 'react/jsx-runtime') return requireRuntime(key);
    if (key === '../customCohortSubdivisionFamilies') return { buildCustomCohortSubdivisionPhases: () => [
      { id: 'phase-one', label: 'MONICA PARK 1', pocket_ids: ['phase-1'] },
      { id: 'phase-two', label: 'MONICA PARK 2', pocket_ids: ['phase-2'] },
    ] };
    if (key === './CustomCohortPocketInspector') return { __esModule: true, default: () => null };
    assert.fail(`Unexpected dependency ${key}`);
  });
  const props = { family, catalog, input: { accountId: 'A', assignmentFileId: '4', contextRef: {} },
    included: ['phase-1'], paused: false, previewTransport() {}, onClose() { closes++; } };
  return { render(phaseId = null) { cursor = 0; return loaded.default({ ...props, phaseId }); }, get closes() { return closes; } };
}

test('small nonmodal area snapshot keeps an exact family or phase comparison inside the map', () => {
  const h = harness(), parent = h.render(), phase = h.render('phase-2');
  assert.equal(parent.props['aria-modal'], 'false'); assert.equal(parent.props.style.maxHeight, 'calc(100% - 1rem)');
  assert.match(parent.props.children[0].props.children[0].props.children[1].props.children.join(''), /Partly included/);
  assert.deepEqual(parent.props.children[1].props.children.props.pocketIds, family.pocket_ids);
  assert.deepEqual(phase.props.children[1].props.children.props.pocketIds, ['phase-2']);
  assert.equal(phase.props.children[1].props.children.props.compact, true);
});

test('snapshot drag clamps within map dimensions and Escape closes without changing inclusion', () => {
  const h = harness(), card = h.render(), handle = card.props.children[0];
  card.props.ref.current = { parentElement: { clientWidth: 500, clientHeight: 440 }, offsetWidth: 300, offsetHeight: 320 };
  const target = { setPointerCapture() {}, hasPointerCapture() { return true; }, releasePointerCapture() {} };
  let stopped = 0;
  handle.props.onPointerDown({ button: 0, pointerId: 1, clientX: 30, clientY: 30,
    currentTarget: target, preventDefault() {}, stopPropagation() { stopped++; } });
  handle.props.onPointerMove({ clientX: 900, clientY: 900 });
  const moved = h.render(); assert.equal(moved.props.style.left, 200); assert.equal(moved.props.style.top, 120);
  assert.equal(stopped, 1); assert.equal(h.closes, 0);
  moved.props.onKeyDown({ key: 'Escape' }); assert.equal(h.closes, 1);
});
