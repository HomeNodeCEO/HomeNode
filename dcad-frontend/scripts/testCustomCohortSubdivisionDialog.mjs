import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import * as locationHelpers from '../src/features/neighborhood/customCohortSubdivisionLocationReview.ts';
const requireRuntime = createRequire(new URL('../package.json', import.meta.url));
const ts = requireRuntime('typescript');
const file = new URL('../src/features/neighborhood/components/CustomCohortSubdivisionDialog.tsx', import.meta.url);
const compiled = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const kids = n => [n?.props?.children].flat(Infinity);
const walk = n => n && typeof n === 'object' ? [n, ...kids(n).flatMap(walk)] : [];
const text = n => typeof n === 'string' || typeof n === 'number' ? String(n) : kids(n).filter(Boolean).map(text).join('');
function harness(count = 3) {
  let tree, cursor = 0, current, modalOpens = 0, modalCloses = 0, focusRestores = 0;
  const cells = [], effects = [], cleanups = [], actions = [];
  class Element { isConnected = true; focus() { focusRestores++; } }
  const prior = new Element(), document = { activeElement: prior };
  const react = {
    useRef(value) { const i = cursor++; return cells[i] ??= { current: value }; },
    useState(initial) { const i = cursor++; cells[i] ??= { value: initial }; return [cells[i].value, v => { cells[i].value = v; }]; },
    useMemo(fn, deps) { const i = cursor++; if (!cells[i] || deps.some((v, index) => !Object.is(v, cells[i].deps[index]))) cells[i] = { value: fn(), deps }; return cells[i].value; },
    useEffect(fn) { const i = cursor++; if (!cells[i]) { cells[i] = true; effects.push(fn); } },
  };
  const Inspector = () => null, module = { exports: {} };
  new Script(`(function(require,module,exports,document,HTMLElement){${compiled}\n})`).runInThisContext()(key => {
    if (key === 'react') return react;
    if (key === 'react/jsx-runtime') return requireRuntime(key);
    if (key === '../customCohortSubdivisionLocationReview') return locationHelpers;
    assert.equal(key, './CustomCohortPocketInspector'); return { default: Inspector, __esModule: true };
  }, module, module.exports, document, Element);
  const phases = Array.from({ length: count }, (_, i) => ({ id: `phase-${i}`, label: `MONICA PARK ${i + 1}`, county: 'Dallas', member_count: i + 1, account_ids: [] }));
  const props = { family: { id: 'family', label: 'MONICA PARK', county: 'Dallas', pocket_ids: phases.map(p => p.id),
    member_count: phases.reduce((n, p) => n + p.member_count, 0), basis: 'candidate_numbered_name' },
    input: { accountId: 'subject', assignmentFileId: '7', contextRef: {} }, catalog: { pockets: phases },
    included: ['phase-0'], phaseId: null, selectionDisabled: false, inspectionsPaused: false,
    previewTransport: () => assert.fail('Only the child inspector may request data'),
    onInclude: ids => actions.push(['include', [...ids]]), onExclude: ids => actions.push(['exclude', [...ids]]),
    onInspectPhase: id => actions.push(['inspect', id]), onClose: () => actions.push(['close']) };
  function render(next = current ?? props) {
    current = next; cursor = 0; tree = module.exports.default(next);
    tree.props.ref.current = { showModal() { modalOpens++; }, close() { modalCloses++; } };
    effects.splice(0).forEach(fn => cleanups.push(fn()));
  }
  const find = label => walk(tree).find(n => n.type === 'button' && (n.props['aria-label'] === label || text(n) === label));
  return { props, actions, render, get tree() { return tree; }, get text() { return text(tree); }, get modalOpens() { return modalOpens; },
    get modalCloses() { return modalCloses; }, get focusRestores() { return focusRestores; }, prior,
    button: find, click(label) { const n = find(label); assert.ok(n, label); n.props.onClick(); render(); },
    inspector: () => walk(tree).find(n => n.type === Inspector).props,
    search(value) { walk(tree).find(n => n.type === 'input').props.onChange({ target: { value } }); render(); },
    close() { cleanups.splice(0).forEach(fn => fn?.()); } };
}
test('dialog mounts once, opens no selection action, restores focus and Escape closes', () => {
  const h = harness(); h.render(); assert.equal(h.modalOpens, 1); assert.deepEqual(h.actions, []);
  h.render({ ...h.props, included: [...h.props.included] }); assert.equal(h.modalOpens, 1);
  assert.match(h.text, /Partially included/); h.tree.props.onCancel(); assert.deepEqual(h.actions, [['close']]);
  h.close(); assert.equal(h.modalCloses, 1); assert.equal(h.focusRestores, 1);
});
test('subdivision union contains all phases even when search/page display only25', () => {
  const h = harness(60); h.render(); assert.match(h.text, /Page 1 of 3/);
  assert.equal(h.inspector().pocketIds.length, 60);
  h.search('MONICA PARK 59'); assert.match(h.text, /MONICA PARK 59/);
  h.click('Include all phases'); assert.equal(h.actions[0][1].length, 60);
  assert.equal(h.inspector().pocketIds.length, 60, 'visible rows do not narrow statistics'); h.close();
});
test('phase inspection passes one exact leaf, excludes only explicit phase and can return to parent', () => {
  const h = harness(); h.render({ ...h.props, phaseId: 'phase-1' });
  assert.equal(h.inspector().pocketId, 'phase-1'); assert.equal(h.inspector().pocketIds, undefined);
  h.click('Include phase MONICA PARK 2'); assert.deepEqual(h.actions, [['include', ['phase-1']]]);
  h.click('Exclude phase MONICA PARK 1'); assert.deepEqual(h.actions.at(-1), ['exclude', ['phase-0']]);
  h.click('View whole subdivision'); assert.deepEqual(h.actions.at(-1), ['inspect', null]); h.close();
});
test('blocked state guards direct selection and inspection callbacks and preserves colors/classes', () => {
  const h = harness(); h.render({ ...h.props, phaseId: 'phase-1', selectionDisabled: true, inspectionsPaused: true });
  for (const label of ['Include all phases', 'Exclude subdivision', 'Exclude phase MONICA PARK 1', 'View whole subdivision']) {
    assert.equal(h.button(label).props.disabled, true); h.click(label);
  }
  assert.deepEqual(h.actions, []); assert.equal(h.inspector().paused, true); assert.equal(h.inspector().membersPaused, true);
  assert.match(h.tree.props.className, /border-amber-300/); assert.match(h.text, /not verified legal/); h.close();
});
test('missing raw phase details stay unavailable; property similarity is not relabelled subdivision reliability', () => {
  const h = harness(); h.render({ ...h.props, catalog: { ...h.props.catalog, recommendation: { pockets: [{ id: 'phase-0', similarity: { lower: 55, upper: 85 } }] } } });
  assert.match(h.text, /Similarity to subject property: 55.0–85.0/);
  assert.match(h.text, /Not a reliability score/); assert.match(h.text, /verified zoning are not available/);
  assert.doesNotMatch(h.text, /55.0.*subdivision similarity/); h.close();
});
