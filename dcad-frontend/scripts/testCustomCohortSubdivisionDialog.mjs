import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import * as locationHelpers from '../src/features/neighborhood/customCohortSubdivisionLocationReview.ts';
import * as familyHelpers from '../src/features/neighborhood/customCohortSubdivisionFamilies.ts';
import * as inspectionHelpers from '../src/features/neighborhood/customCohortSubdivisionInspection.ts';
import * as comparisonHelpers from '../src/features/neighborhood/customCohortStockCompositionComparison.ts';
import { checkCustomCohortStockComposition } from '../src/features/neighborhood/customCohortStockComposition.ts';
import { STOCK_COMPOSITION_DEFINITION, STOCK_COMPOSITION_PROFILE } from '../src/features/neighborhood/customCohortStockCompositionDefinition.ts';
const requireRuntime = createRequire(new URL('../package.json', import.meta.url));
const ts = requireRuntime('typescript');
const file = new URL('../src/features/neighborhood/components/CustomCohortSubdivisionDialog.tsx', import.meta.url);
const compiled = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const kids = n => [n?.props?.children].flat(Infinity);
const walk = n => n && typeof n === 'object' ? [n, ...kids(n).flatMap(walk)] : [];
const text = n => typeof n === 'string' || typeof n === 'number' ? String(n) : kids(n).filter(Boolean).map(text).join('');
const phaseId = i => `recorded-cad:phase-${i}`;
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
  const Inspector = () => null, Comparison = () => null, module = { exports: {} };
  new Script(`(function(require,module,exports,document,HTMLElement){${compiled}\n})`).runInThisContext()(key => {
    if (key === 'react') return react;
    if (key === 'react/jsx-runtime') return requireRuntime(key);
    if (key === '../customCohortSubdivisionLocationReview') return locationHelpers;
    if (key === '../customCohortSubdivisionFamilies') return familyHelpers;
    if (key === '../customCohortSubdivisionInspection') return inspectionHelpers;
    if (key === '../customCohortStockCompositionComparison.ts') return comparisonHelpers;
    if (key === './CustomCohortStockCompositionComparison') return { default: Comparison, __esModule: true };
    assert.equal(key, './CustomCohortPocketInspector'); return { default: Inspector, __esModule: true };
  }, module, module.exports, document, Element);
  const phases = Array.from({ length: count }, (_, i) => ({ id: phaseId(i), label: `MONICA PARK ${i + 1}`, county: 'Dallas', member_count: i + 1,
    account_ids: Array.from({ length: i + 1 }, (_, j) => `synthetic-${i}-${j}`) }));
  const total = phases.reduce((n, p) => n + p.member_count, 0), contextRef = { context_id: 'context', context_revision: '1', context_sha256: 'a'.repeat(64) };
  const catalog = { catalog_version: 1, status: 'review_only', binding: { context_ref: contextRef, selection_revision: 1 }, pockets: phases,
    unassigned: { member_count: 0, account_ids: [], reason_counts: [] },
    coverage: { discovery_member_count: total, assigned_account_count: total, unassigned_account_count: 0 },
    subject_membership: { account_id: phases[0].account_ids[0], assigned_pocket_id: phases[0].id, recorded_label_match_only: true } };
  const family = familyHelpers.buildCustomCohortSubdivisionFamilies(catalog).families[0];
  const props = { family, input: { accountId: phases[0].account_ids[0], assignmentFileId: '7', contextRef }, catalog,
    included: [phaseId(0)], phaseId: null, selectionDisabled: false, inspectionsPaused: false,
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
    comparison: () => walk(tree).find(n => n.type === Comparison).props.comparison,
    search(value) { walk(tree).find(n => n.type === 'input').props.onChange({ target: { value } }); render(); },
    close() { cleanups.splice(0).forEach(fn => fn?.()); } };
}
test('dialog mounts once, opens no selection action, restores focus and Escape closes', () => {
  const h = harness(); h.render(); assert.equal(h.modalOpens, 1); assert.deepEqual(h.actions, []);
  h.render({ ...h.props, included: [...h.props.included] }); assert.equal(h.modalOpens, 1);
  assert.match(h.text, /Partially included/); h.tree.props.onCancel(); assert.deepEqual(h.actions, [['close']]);
  h.close(); assert.equal(h.modalCloses, 1); assert.equal(h.focusRestores, 1);
});

test('collapsed advisory receives exact parent/phase and saved selected unions without making requests or selection writes', () => {
  const h = harness(), original = h.props.catalog;
  const population = n => [n, Array.from({ length: 3 }, () => [[n, 0, 0, 0, 0], [0, 0, 0, n]]),
    [[n, 0, 0, 0, 0], [n, 0, 0, 0, 0, 0, 0]]];
  const stock = checkCustomCohortStockComposition({ composition_version: 1, profile: STOCK_COMPOSITION_PROFILE,
    binding: { context_ref: original.binding.context_ref, captured_at: '2026-09-06T08:00:00.123Z' }, status: 'available', reason: null,
    mapping_version: 4, housing_profile: STOCK_COMPOSITION_DEFINITION.housing_profiles[0], definition: STOCK_COMPOSITION_DEFINITION,
    bin_cuts: [[2000, 2000, 2000], [2000, 2000, 2000], [2000, 2000, 2000]], subject: {
      numeric: [['observed', 2100, 'saved_subject'], ['observed', 1999, 'saved_subject'], ['missing', null, 'saved_subject']],
      housing: ['missing', null, 'current_subject_cad'], recorded_group_id: phaseId(0), group_reason: null },
    all: population(6), pockets: original.pockets.map(p => [p.id, ...population(p.member_count)]) }, original);
  const catalog = { ...original, recommendation: { pockets: [], stock_composition_v1: stock } };
  h.render({ ...h.props, catalog });
  assert.equal(h.comparison().reference.member_count, 6); assert.equal(h.comparison().inspected.member_count, 6);
  assert.equal(h.comparison().selected.member_count, 1); assert.deepEqual(h.actions, []);
  h.render({ ...h.props, catalog, phaseId: phaseId(1), included: [] });
  assert.deepEqual(h.comparison().inspected.pocket_ids, [phaseId(1)]); assert.equal(h.comparison().inspected.member_count, 2);
  assert.equal(h.comparison().selected.member_count, 0); assert.deepEqual(h.actions, []);
  h.render({ ...h.props, catalog: original }); assert.equal(h.comparison().reason, 'composition_unavailable'); h.close();
});
test('subdivision union contains all phases even when search/page display only25', () => {
  const h = harness(60); h.render(); assert.match(h.text, /Page 1 of 3/);
  assert.equal(h.inspector().pocketIds.length, 60);
  h.search('MONICA PARK 59'); assert.match(h.text, /MONICA PARK 59/);
  h.click('Include all phases'); assert.equal(h.actions[0][1].length, 60);
  assert.equal(h.inspector().pocketIds.length, 60, 'visible rows do not narrow statistics'); h.close();
});
test('phase inspection passes one exact leaf, excludes only explicit phase and can return to parent', () => {
  const h = harness(); h.render({ ...h.props, phaseId: phaseId(1) });
  assert.equal(h.inspector().pocketId, phaseId(1)); assert.equal(h.inspector().pocketIds, undefined);
  h.click('Include phase MONICA PARK 2'); assert.deepEqual(h.actions, [['include', [phaseId(1)]]]);
  h.click('Exclude phase MONICA PARK 1'); assert.deepEqual(h.actions.at(-1), ['exclude', [phaseId(0)]]);
  h.click('View whole subdivision'); assert.deepEqual(h.actions.at(-1), ['inspect', null]); h.close();
});

test('parent and phase views share one complete inspection selection; private and capacity fallback keep independent inspection', () => {
  const h = harness(); h.render(); const batch = h.inspector().inspectionSelection;
  assert.equal(batch.pockets.length, 3); assert.equal(h.inspector().inspectedPocketId, undefined);
  h.render({ ...h.props, phaseId: phaseId(1) });
  assert.equal(h.inspector().inspectionSelection, batch); assert.equal(h.inspector().inspectedPocketId, phaseId(1));
  assert.deepEqual(h.actions, []); h.inspector().onBatchUnavailable(); h.render();
  assert.equal(h.inspector().inspectionSelection, undefined); assert.equal(h.inspector().pocketId, phaseId(1)); h.close();
  const privateView = harness(); privateView.render({ ...privateView.props, catalog: { ...privateView.props.catalog, private_sales: {} } });
  assert.equal(privateView.inspector().inspectionSelection, undefined); privateView.close();
});
test('blocked state guards direct selection and inspection callbacks and preserves colors/classes', () => {
  const h = harness(); h.render({ ...h.props, phaseId: phaseId(1), selectionDisabled: true, inspectionsPaused: true });
  for (const label of ['Include all phases', 'Exclude subdivision', 'Exclude phase MONICA PARK 1', 'View whole subdivision']) {
    assert.equal(h.button(label).props.disabled, true); h.click(label);
  }
  assert.deepEqual(h.actions, []); assert.equal(h.inspector().paused, true); assert.equal(h.inspector().membersPaused, true);
  assert.match(h.tree.props.className, /border-amber-300/); assert.match(h.text, /not verified legal/); h.close();
});
test('missing raw phase details stay unavailable; property similarity is not relabelled subdivision reliability', () => {
  const h = harness(); h.render({ ...h.props, catalog: { ...h.props.catalog, recommendation: { pockets: [{ id: phaseId(0), similarity: { lower: 55, upper: 85 } }] } } });
  assert.match(h.text, /Similarity to subject property: 55.0–85.0/);
  assert.match(h.text, /Not a reliability score/); assert.match(h.text, /verified zoning are not available/);
  assert.doesNotMatch(h.text, /55.0.*subdivision similarity/); h.close();
});
test('equivalent county-name leaves show one phase and partial selection; inspection and buttons use the complete original ID union', () => {
  const h = harness(), original = h.props.catalog, alias = { ...original.pockets[0], id: 'recorded-cad:alias', county: 'DALLAS COUNTY',
    account_ids: ['synthetic-alias'], member_count: 1 };
  const catalog = { ...original, pockets: [...original.pockets, alias], coverage: { ...original.coverage,
    discovery_member_count: original.coverage.discovery_member_count + 1, assigned_account_count: original.coverage.assigned_account_count + 1 } };
  const family = familyHelpers.buildCustomCohortSubdivisionFamilies(catalog).families[0];
  h.render({ ...h.props, family, catalog, phaseId: alias.id });
  const union = [alias.id, phaseId(0)].sort();
  assert.deepEqual([...h.inspector().pocketIds].sort(), union); assert.match(h.text, /Partially included/);
  assert.match(h.text, /2 equivalent recorded county-name groups/);
  h.click('Exclude phase MONICA PARK 1'); assert.deepEqual([...h.actions.at(-1)[1]].sort(), union);
  h.click('Include phase MONICA PARK 1'); assert.deepEqual([...h.actions.at(-1)[1]].sort(), union); h.close();
});
