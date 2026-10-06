import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';
import * as helpers from '../src/lib/neighborhoodSummaryTemplate.ts';
import * as builder from '../src/lib/subjectNeighborhoodSummary.ts';
const runtime = createRequire(import.meta.url)('react/jsx-runtime');
const walk = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(walk)];
const input = { subdivision: 'MONICA PARK 4', city: 'Garland', effectiveDate: '2026-08-31', locationType: 'suburban' };
const group = { summary: { selected: { stock: { metrics: { year_built: { count: 100, median: 1960 } } } } } };

function harness() {
  const cells = [], pending = [], generated = []; let cursor = 0, tree, props, dirty = false;
  const react = {
    lazy: () => function LazyStub() {}, Suspense: function SuspenseStub() {},
    useState(initial) { const i = cursor++; cells[i] ??= { value: initial };
      return [cells[i].value, value => { cells[i].value = value; dirty = true; }]; },
    useCallback(fn, deps) { const i = cursor++; if (!cells[i] || !deps.every((v, j) => Object.is(v, cells[i].deps[j]))) cells[i] = { value: fn, deps };
      return cells[i].value; },
    useEffect(fn, deps) { const i = cursor++; if (!cells[i] || !deps.every((value, j) => Object.is(value, cells[i][j]))) {
      cells[i] = deps; pending.push(fn);
    } },
  };
  const Section = loadTrustedRepositoryCommonJs(new URL('../src/features/neighborhood/components/CustomNeighborhoodCharacteristicsSection.tsx', import.meta.url), key => {
    if (key === 'react') return react;
    if (key === 'react/jsx-runtime') return runtime;
    if (key === '@/components/PropertyReportControls') return { SummarySection: function SummarySectionStub() {} };
    if (key === '@/lib/neighborhoodSummaryTemplate') return helpers;
    throw new Error(`Unexpected import ${key}`);
  }).default;
  const render = () => {
    let steps = 0;
    do { assert.ok(++steps < 10, 'no regeneration/autosave loop'); dirty = false; cursor = 0; tree = Section(props);
      pending.splice(0).forEach(fn => fn()); } while (dirty);
  };
  props = { neighborhoodSummary: builder.buildSubjectNeighborhoodSummary(input), summaryInput: input,
    workspace: { hostProps: {} }, acceptedNeighborhood: null, summaryReadOnly: false,
    onNeighborhoodSummaryChange: value => { props = { ...props, neighborhoodSummary: value }; render(); },
    onGeneratedSummary: (value, reviewItems) => { generated.push({ value, reviewItems });
      props = { ...props, neighborhoodSummary: value, summaryTemplate: value }; dirty = true; },
    onLocationTypeChange: value => { props = { ...props, summaryInput: { ...props.summaryInput, locationType: value } }; render(); },
  };
  props.summaryTemplate = props.neighborhoodSummary;
  render();
  return { generated, nodes: () => walk(tree), props: () => props,
    update(extra) { props = { ...props, ...extra }; render(); },
    select(value, townhomes) { walk(tree).find(node => node.props?.onAnalysisSelection).props.onAnalysisSelection(value, townhomes); render(); } };
}

test('actual section removes summary caption and updates the template once for a coherent selection', () => {
  const h = harness(); assert.equal(h.generated.length, 0); h.select(group);
  assert.equal(h.generated.length, 1); assert.match(h.props().neighborhoodSummary, /past 66 years/);
  h.update({ summaryInput: { ...input } }); assert.equal(h.generated.length, 1);
  const text = JSON.stringify(h.nodes().map(node => node.props?.children));
  assert.doesNotMatch(text, /A source-limited starting description/);
  assert.deepEqual(h.generated[0].reviewItems, helpers.NEIGHBORHOOD_TEMPLATE_REVIEW_ITEMS);
});

test('actual classification input changes the paragraph without changing workspace membership', () => {
  const h = harness(); h.select(group);
  const control = h.nodes().find(node => node.props?.['aria-label'] === 'Neighborhood location classification');
  control.props.onChange({ target: { value: 'rural' } });
  assert.match(h.props().neighborhoodSummary, /residential rural lots/);
  assert.match(h.props().neighborhoodSummary, /past 66 years/);
  assert.deepEqual(h.props().workspace.hostProps, {});
});

test('manual textarea edits and signed reports cannot be overwritten by selection updates', () => {
  const h = harness(); h.select(group); const calls = h.generated.length;
  h.nodes().find(node => node.type === 'textarea').props.onChange({ target: { value: 'My reviewed description.' } });
  h.select({ ...group, summary: {} }); assert.equal(h.props().neighborhoodSummary, 'My reviewed description.');
  assert.equal(h.generated.length, calls);
  const signed = harness(); signed.update({ summaryReadOnly: true }); signed.select(group);
  assert.equal(signed.generated.length, 0);
  assert.equal(signed.nodes().find(node => node.type === 'textarea').props.disabled, true);
});

test('an explicit Use template action can replace older/manual prose with the selected-area template', () => {
  const h = harness(); h.select(group); h.update({ neighborhoodSummary: 'My older paragraph.', summaryTemplate: undefined });
  const action = h.nodes().find(node => node.type === 'button' && node.props.children === 'Use template');
  assert.ok(action); action.props.onClick();
  assert.match(h.props().neighborhoodSummary, /^The subject immediate subdivision is known as Monica Park/);
  assert.match(h.props().neighborhoodSummary, /past 66 years/);
});

test('captured townhomes are included only when the current selected composition reports them', () => {
  const h = harness(); h.select(group, true); assert.match(h.props().neighborhoodSummary, /homes and townhomes/);
  h.select(group, false); assert.doesNotMatch(h.props().neighborhoodSummary, /and townhomes/);
});

test('summary seeding never writes signed, archived, or unestablished workfile state', () => {
  const hook = loadTrustedRepositoryCommonJs(new URL('../src/hooks/useSubjectNeighborhoodSummary.ts', import.meta.url), key => {
    if (key === 'react') return { useRef: () => ({ current: null }), useEffect: fn => fn() };
    if (key === '@/lib/subjectNeighborhoodSummary') return builder;
    if (key === '@/lib/neighborhoodSummaryTemplate') return helpers;
    if (key === './useNearbySchool') return { useNearbySchool: () => null };
    throw new Error(`Unexpected import ${key}`);
  }).useSubjectSummary;
  for (const status of ['signed', 'archived', undefined, 'draft']) {
    let writes = 0, dirty = 0;
    hook('synthetic-account', { id: 1, effective_date: '2026-08-31', workfile: { status } },
      { subdivision: 'EXAMPLE PARK', city: 'Example' }, 1960, 'single_family',
      () => { writes++; }, {}, () => { dirty++; });
    assert.equal(writes, status === 'draft' ? 1 : 0);
    assert.equal(dirty, status === 'draft' ? 1 : 0);
  }
});
