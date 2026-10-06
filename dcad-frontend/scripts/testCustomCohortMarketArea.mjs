import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';
import * as reconciliationHelper from '../src/lib/marketStudyReconciliation.ts';

const contextRef = { context_id: '70000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const group = { binding: { accountId: 'A', assignmentFileId: '15', contextRef, selectionRevision: 7, selectionFingerprint: 'b'.repeat(64) },
  request: { selection: { revision: 7, pockets: [{ id: 'one', label: 'One', account_ids: ['A', 'B'] }] } } };
const request = { subjectAccountId: 'A', assignmentFileId: 15, areaKeys: ['exploration'], asOf: '2026-08-31', periodMonths: 24 };
const result = () => ({ subject: { account_id: 'A' }, analyses: [{ market: { key: 'exploration' } }], recommendation: {},
  exploration_binding: { context_ref: contextRef, selection_revision: 7, selection_sha256: 'b'.repeat(64) } });
function fixture(reply = result(), ordinary) {
  const calls = [], ordinaryCalls = [];
  const api = loadTrustedRepositoryCommonJs(new URL('../src/features/neighborhood/customCohortMarketArea.ts', import.meta.url), dependency => {
    if (dependency === '@/lib/api') return { runMarketConditionsAnalysis: async request => {
      ordinaryCalls.push(request); return typeof ordinary === 'function' ? ordinary(request) : ordinary;
    } };
    assert.equal(dependency, './customCohortPreviewApi');
    return { requestCustomCohortOperation: async (...args) => { calls.push(args); return typeof reply === 'function' ? reply(...args) : reply; } };
  });
  return { api, calls, ordinaryCalls };
}

test('market request uses retained membership and existing transport, with no map geometry or fresh capture', async () => {
  const reply = result(), f = fixture(reply), before = JSON.stringify(group);
  assert.equal(await f.api.runExplorationMarketAnalysis(request, group), reply);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], 'A'); assert.equal(f.calls[0][1], 'market-analysis');
  assert.deepEqual(f.calls[0][2], { assignment_file_id: '15', context_ref: contextRef,
    selection: group.request.selection, selection_sha256: group.binding.selectionFingerprint,
    area_keys: ['exploration'], as_of: '2026-08-31', period_months: 24, context_override: null });
  assert.equal(f.calls[0][3].signal.aborted, false);
  assert.equal(JSON.stringify(group), before);
});

test('foreign appraisal targets are rejected before any HTTP operation', async () => {
  const f = fixture();
  for (const change of [{ subjectAccountId: 'OTHER' }, { assignmentFileId: 16 }, { assignmentFileId: null }]) {
    await assert.rejects(f.api.runExplorationMarketAnalysis({ ...request, ...change }, group), /different appraisal file/);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.api.usableExplorationArea(null, 'A', 15), null);
});

test('old selection results, missing exploration and foreign subjects cannot be treated as current', async () => {
  for (const change of [
    { exploration_binding: { ...result().exploration_binding, selection_revision: 8 } },
    { exploration_binding: null }, { subject: { account_id: 'OTHER' } }, { analyses: [{ market: { key: 'city' } }] },
  ]) {
    const f = fixture({ ...result(), ...change });
    await assert.rejects(f.api.runExplorationMarketAnalysis(request, group), /does not match/);
  }
});

test('current selection identity changes on context, revision or membership and survives response persistence', () => {
  const f = fixture(), identity = f.api.explorationAreaIdentity(group.binding);
  assert.equal(f.api.marketExplorationIdentity(result()), identity);
  assert.equal(f.api.marketExplorationIdentity({ ...result(), exploration_binding: { ...result().exploration_binding,
    context_ref: { context_sha256: contextRef.context_sha256, context_revision: '1', context_id: contextRef.context_id } } }), identity,
    'JSON property order cannot invalidate a semantically identical context');
  for (const change of [{ selectionRevision: 8 }, { selectionFingerprint: 'c'.repeat(64) },
    { contextRef: { ...contextRef, context_sha256: 'c'.repeat(64) } }]) {
    assert.notEqual(f.api.explorationAreaIdentity({ ...group.binding, ...change }), identity);
  }
  assert.equal(f.api.marketExplorationIdentity({}), null);
  assert.equal(f.api.marketExplorationIdentity({ exploration_binding: { ...result().exploration_binding, selection_revision: -1 } }), null);
});

const requireRuntime = createRequire(new URL('../package.json', import.meta.url));
const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
const children = node => (Array.isArray(node?.props?.children) ? node.props.children : [node?.props?.children]).flat(Infinity);
const walk = node => node && typeof node === 'object' ? [node, ...children(node).flatMap(walk)] : [];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : node && typeof node === 'object' ? children(node).map(text).join('') : '';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const completeResult = () => ({ ...result(), unavailable_areas: [],
  analyses: [{ market: { key: 'exploration', scope: 'exploration', label: 'Exploration Map Area' },
    population: { eligible_sale_count: 50, mapped_sale_count: 50 }, summary: {}, statistics: {},
    period: { start: '2024-09-01', end: '2026-08-31' }, series: { monthly: [] } }],
  recommendation: { methodology_version: 3, conclusion: 'stable', ranked_studies: [], recommended_change_percent: null } });
const draft = response => ({ version: 3, accountId: 'A', assignmentFileId: 15, savedAt: '2026-10-06T00:00:00Z',
  asOfDate: request.asOf, periodMonths: 24, selectedAreaKeys: ['exploration'], contextOverride: null,
  response, reconciliation: { trendConclusion: 'stable', reliedUponAreaKeys: ['exploration'], explanation: '' } });

/** Actual component with deterministic hooks, as in the workspace harness.
 * External requests are stubbed; JSX, input handlers and effects are real. */
function marketComponent(overrides = {}) {
  let cursor = 0, tree, dirty = false, props = { subjectAccountId: 'A', assignmentFileId: 15,
    explorationArea: group, embedded: true, initialAsOfDate: request.asOf, ...overrides };
  const cells = [], pending = [], published = [], queries = [], operation = deferred();
  props.onCompletionChange = value => published.push(value);
  const react = {
    useState(initial) {
      const index = cursor++; cells[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [cells[index].value, next => { const value = typeof next === 'function' ? next(cells[index].value) : next;
        if (!Object.is(value, cells[index].value)) { cells[index].value = value; dirty = true; } }];
    },
    useRef(initial) { const index = cursor++; return cells[index] ??= { current: initial }; },
    useMemo(factory, deps) { const index = cursor++; if (!same(cells[index]?.deps, deps)) cells[index] = { deps, value: factory() }; return cells[index].value; },
    useEffect(effect, deps) { const index = cursor++; if (!same(cells[index]?.deps, deps)) pending.push(() => {
      cells[index]?.cleanup?.(); cells[index] = { deps, cleanup: effect() }; }); },
  };
  const helper = fixture().api;
  const Component = loadTrustedRepositoryCommonJs(new URL('../src/components/MarketConditionsAnalysis.tsx', import.meta.url), dependency => {
    if (dependency === 'react') return react;
    if (dependency === 'react/jsx-runtime') return requireRuntime(dependency);
    if (dependency === '@/features/auth/ApplicationAuth') return { useApplicationAuth: () => ({ session: null }) };
    if (dependency === '@/lib/api') return { getMarketConditionsContext: async () => ({ subject: { account_id: 'A' } }),
      runMarketConditionsAnalysis: () => { throw new Error('Exploration must not use the legacy market request.'); } };
    if (dependency === '@/lib/marketConditionsDraft') return { readMarketConditionsDraft: () => null, saveMarketConditionsDraft: () => assert.fail('Unexpected local save') };
    if (dependency === '@/features/neighborhood/customCohortMarketArea') return { ...helper, runMarketStudies: (...args) => { queries.push(args); return operation.promise; } };
    if (dependency === './MarketStudyPropertyContext') return { default: 'MarketStudyPropertyContext' };
    if (dependency === './ExplorationLandUsePanel') return { default: 'ExplorationLandUsePanel' };
    if (dependency === './NeighborhoodFormReviewPanel') return { default: 'NeighborhoodFormReviewPanel' };
    if (dependency === '@/lib/neighborhoodFormReview') return loadTrustedRepositoryCommonJs(new URL('../src/lib/neighborhoodFormReview.ts', import.meta.url), name => assert.fail(`Unexpected form helper import: ${name}`));
    if (dependency === '@/lib/marketStudyReconciliation') return reconciliationHelper;
    if (dependency === './MarketStudyDetermination') return loadTrustedRepositoryCommonJs(new URL('../src/components/MarketStudyDetermination.tsx', import.meta.url), name => {
      if (name === 'react/jsx-runtime') return requireRuntime(name);
      if (name === '@/lib/marketStudyReconciliation') return reconciliationHelper;
      assert.fail(`Unexpected determination import: ${name}`);
    });
    assert.fail(`Unexpected component import: ${dependency}`);
  }).default;
  function render() { let passes = 0; do { dirty = false; cursor = 0; tree = Component(props); while (pending.length) pending.shift()();
    assert.ok(++passes < 40, 'Component effects must settle'); } while (dirty); return tree; }
  async function settle() { for (let index = 0; index < 5; index++) { await Promise.resolve(); render(); } }
  return { render, settle, published, queries, operation, update(change) { props = { ...props, ...change }; return render(); },
    button(label) { const node = walk(render()).find(item => item.type === 'button' && text(item).startsWith(label)); assert.ok(node, label); return node; },
    get text() { return text(render()); },
    dispose() { for (const cell of cells) cell?.cleanup?.(); } };
}

test('actual market UI offers the exploration selection, not another drawing map', async t => {
  const h = marketComponent(); t.after(h.dispose); await h.settle();
  assert.match(h.text, /Exploration Map Area/);
  assert.doesNotMatch(h.text, /Appraiser Defined Area|Draw area|Draw boundary|Reset polygon/);
  h.button('Run 1 market study').props.onClick(); await h.settle();
  assert.equal(h.queries.length, 1); assert.equal(h.queries[0][1], group);
  assert.deepEqual(h.queries[0][0].areaKeys, ['exploration']);
  h.operation.resolve(completeResult()); await h.settle();
  assert.equal(h.published.at(-1).response.exploration_binding.selection_revision, 7);
  assert.match(h.text, /Study complete/);
  h.update({ explorationArea: { ...group, binding: { ...group.binding, selectionRevision: 8 } } });
  assert.equal(h.published.at(-1), null); assert.match(h.text, /Study required/);
});

test('all four areas remain visible in conclusion weighting, including fourth-ranked exploration', async t => {
  const value = completeResult(), keys = ['zip', 'radius_1', 'radius_2', 'exploration'];
  value.analyses = keys.map(key => ({ ...value.analyses[0], market: { key, label: key === 'exploration' ? 'Exploration Map Area' : key } }));
  value.recommendation.ranked_studies = value.analyses.map((a, index) => ({ key: a.market.key, label: a.market.label,
    rank: index + 1, reliability_score: 80, sale_count: 50, reconciliation_weight_percent: 25 }));
  const initialDraft = { ...draft(value), selectedAreaKeys: keys };
  const h = marketComponent({ initialDraft }); t.after(h.dispose); await h.settle();
  assert.doesNotMatch(h.text, /Study geography and related CAD parcels|Use as a study center|Exact CAD situs address|Reviewable market context override/);
  const tree = h.render(), nodes = walk(tree);
  const recommendation = nodes.find(n => typeof n.type === 'function' && n.type.name === 'MarketStudyDetermination');
  assert.ok(recommendation);
  assert.match(text(recommendation.type(recommendation.props)), /#4 Exploration Map Area/);
  assert.ok(nodes.find(n => n.type === 'MarketStudyPropertyContext'));
  const weight = walk(recommendation.type(recommendation.props)).find(n => n.type === 'fieldset' && text(n).includes('Studies given greatest weight'));
  assert.equal(walk(weight).filter(n => n.type === 'input' && n.props.type === 'checkbox').length, 4);
  assert.match(text(weight), /Exploration Map Area/);
});

test('a database draft arriving after lazy mount restores results and the saved complexity review once', async t => {
  const h = marketComponent({ explorationArea: null }); t.after(h.dispose); await h.settle();
  assert.match(h.text, /Study required/);
  const value = completeResult(), keys = ['zip', 'radius_1', 'radius_2', 'exploration'];
  value.analyses = keys.map(key => ({ ...value.analyses[0], market: { key, label: key } }));
  const signature = JSON.stringify({ areaKeys: [...keys].sort(), asOfDate: '2026-09-30', periodMonths: 12,
    explorationIdentity: fixture().api.explorationAreaIdentity(group.binding), contextOverride: null });
  const review = { version: 1, studySignature: signature, review: { notes: 'Saved review' } };
  const restored = { ...draft(value), selectedAreaKeys: keys, asOfDate: '2026-09-30', periodMonths: 12,
    propertyComplexity: review };
  h.update({ initialDraft: restored }); await h.settle();
  assert.match(h.text, /Study required/, 'Restored results still wait for the exact map selection');
  assert.equal(h.published.filter(Boolean).length, 0);
  const pendingContext = walk(h.render()).find(n => n.type === 'MarketStudyPropertyContext');
  assert.equal(pendingContext.props.current, false);
  assert.equal(pendingContext.props.studySignature, signature, 'The saved review keeps its completed-run identity while the map restores');
  h.update({ explorationArea: group }); await h.settle();
  assert.match(h.text, /Study complete/);
  assert.deepEqual(h.published.at(-1).selectedAreaKeys, keys);
  assert.equal(h.published.at(-1).asOfDate, '2026-09-30');
  assert.equal(h.published.at(-1).periodMonths, 12);
  assert.equal(h.published.at(-1).propertyComplexity, review);
  assert.equal(walk(h.render()).find(n => n.type === 'MarketStudyPropertyContext').props.initialScreening, review);
  assert.equal(h.queries.length, 0, 'Reopening reuses the completed market result');
  h.button('Clear').props.onClick(); await h.settle();
  h.update({ initialDraft: { ...restored, savedAt: '2026-10-06T01:00:00Z' } }); await h.settle();
  assert.equal(h.button('Run  market studies').props.disabled, true, 'A later save cannot reset current edits');
});

test('late workfile hydration cannot overwrite edits or import another appraisal file', async t => {
  const saved = draft(completeResult());
  for (const foreign of [{ ...saved, accountId: 'OTHER' }, { ...saved, assignmentFileId: 16 }]) {
    const h = marketComponent({ initialDraft: foreign }); t.after(h.dispose); await h.settle();
    assert.match(h.text, /Study required/);
    assert.equal(h.published.filter(Boolean).length, 0);
    h.update({ initialDraft: saved }); await h.settle();
    assert.match(h.text, /Study complete/, 'Only the current file draft is adopted');
  }
  const h = marketComponent(); t.after(h.dispose); await h.settle();
  h.button('Clear').props.onClick(); await h.settle();
  h.update({ initialDraft: saved }); await h.settle();
  assert.match(h.text, /Study required/);
  assert.equal(h.button('Run  market studies').props.disabled, true);
  assert.equal(h.published.filter(Boolean).length, 0);
});

test('ZIP and radius studies bypass retained exploration when it is not selected', async () => {
  const ordinary = { ...completeResult(), analyses: [{ ...completeResult().analyses[0], market: { key: 'zip' } }], exploration_binding: undefined };
  const f = fixture(() => assert.fail('No neighborhood transport'), ordinary);
  const input = { ...request, areaKeys: ['zip', 'radius_1', 'radius_2'], asOf: '2026-10-31', periodMonths: 12 };
  assert.equal(await f.api.runMarketStudies(input, null), ordinary);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.ordinaryCalls, [input]);
});

test('combined study separates ordinary areas from exploration and preserves chosen dates beyond the appraisal date', async () => {
  const standard = { ...completeResult(), analyses: [{ ...completeResult().analyses[0], market: { key: 'zip' } }], exploration_binding: undefined };
  const f = fixture(completeResult(), standard);
  const input = { ...request, areaKeys: ['zip', 'radius_1', 'radius_2', 'exploration'], asOf: '2026-10-31', periodMonths: 12 };
  const response = await f.api.runMarketStudies(input, group);
  assert.deepEqual(f.ordinaryCalls[0].areaKeys, ['zip', 'radius_1', 'radius_2']);
  assert.deepEqual(f.calls[0][2].area_keys, ['exploration']);
  for (const request of [f.ordinaryCalls[0], f.calls[0][2]]) assert.equal(request.asOf ?? request.as_of, '2026-10-31');
  assert.deepEqual(response.analyses.map(item => item.market.key), ['zip', 'exploration']);
  assert.equal(f.api.marketExplorationIdentity(response), f.api.explorationAreaIdentity(group.binding));
});

test('an exploration timeout does not discard successful ZIP/radius studies or leak a preview cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const standard = { ...completeResult(), analyses: [{ ...completeResult().analyses[0], market: { key: 'zip' } }], exploration_binding: undefined };
  const f = fixture((_id, _operation, _body, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Neighborhood preview request cancelled', 'AbortError')));
  }), standard);
  const operation = f.api.runMarketStudies({ ...request, areaKeys: ['zip', 'exploration'] }, group);
  t.mock.timers.tick(65000);
  const response = await operation;
  assert.deepEqual(response.analyses.map(item => item.market.key), ['zip']);
  assert.equal(f.api.marketExplorationIdentity(response), null);
  assert.match(response.unavailable_areas[0].reason, /took too long/);
  assert.doesNotMatch(response.unavailable_areas[0].reason, /preview request cancelled/);
});

test('an unavailable map does not block ordinary market studies', async () => {
  const f = fixture(() => assert.fail('No map selection'), { ...completeResult(), exploration_binding: undefined });
  const response = await f.api.runMarketStudies({ ...request, areaKeys: ['zip', 'exploration'] }, null);
  assert.equal(f.calls.length, 0);
  assert.equal(response.unavailable_areas[0].key, 'exploration');
});

test('actual mixed-area UI lets ZIP studies run while the exploration map is unavailable', async t => {
  const initialDraft = { ...draft(completeResult()), selectedAreaKeys: ['zip', 'exploration'] };
  const h = marketComponent({ initialDraft, explorationArea: null }); t.after(h.dispose); await h.settle();
  assert.equal(h.button('Run 2 market studies').props.disabled, false);
  h.button('Run 2 market studies').props.onClick(); await h.settle();
  assert.deepEqual(h.queries[0][0].areaKeys, ['zip', 'exploration']);
  assert.equal(h.queries[0][1], null);
  h.operation.resolve({ ...completeResult(), exploration_binding: undefined,
    analyses: [{ ...completeResult().analyses[0], market: { key: 'zip', label: 'ZIP', scope: 'zip' } }],
    unavailable_areas: [{ key: 'exploration', label: 'Exploration Map Area', reason: 'Select subdivisions first.' }] });
  await h.settle();
  assert.match(h.text, /Completed studies are shown below/);
  assert.doesNotMatch(h.text, /changed after the last calculation/);
  assert.equal(h.published.filter(Boolean).length, 0, 'An incomplete exploration cannot publish a complete report study');
});

test('split response reconciliation exactly matches the existing server recommendation', async () => {
  const { buildMarketTrendRecommendation } = await import('../../server/src/services/marketConditions.js');
  const f = fixture();
  for (const changes of [[], [0], [-1.25, 2.5], [2, 7, -3], [null, 1.001, -7.112, 4.665]]) {
    const analyses = changes.map((change, index) => ({ market: { key: ['zip', 'radius_1', 'radius_2', 'exploration'][index], label: String(index) },
      population: { eligible_sale_count: 25 + index }, statistics: { annualized_change_percent: change, sample_sufficient: index % 2 === 0,
        reliability_score: 50 + index, composite_cod: 15, composite_cv: 20 } }));
    const response = f.api.mergeMarketStudyResponses([{ ...completeResult(), analyses: analyses.slice(0, 2) }, { ...completeResult(), analyses: analyses.slice(2) }]);
    assert.deepEqual(response.recommendation, buildMarketTrendRecommendation(analyses));
  }
});

test('split exploration and ordinary studies rank by COD/CV consistency, not sample sufficiency', async () => {
  const { calculateMarketStudyStatistics, buildMarketTrendRecommendation } = await import('../../server/src/services/marketConditions.js');
  const f = fixture();
  const study = (key, cod, cv, count) => ({ market: { key, label: key }, population: { eligible_sale_count: count },
    statistics: calculateMarketStudyStatistics({ monthlySeries: [
      { period_start: '2025-01-01', median_sale_price: 100 }, { period_start: '2025-12-01', median_sale_price: 110 },
    ], eligibleSaleCount: count, periodMonths: 12, congruencyFactors: { living_area: { count, cod, cv } } }) });
  for (const analyses of [
    [study('radius_2', 24, 30, 1000), study('zip', 18, 24, 400), study('radius_1', 21, 27, 250), study('exploration', 10, 14, 80)],
    [study('zip', 10.01, 14, 1000), study('exploration', 10, 14, 20)],
    [study('zip', null, 14, 1000), study('exploration', 100, 140, 20)],
    [study('zip', null, null, 1000), study('exploration', null, null, 20)],
  ]) {
    const merged = f.api.mergeMarketStudyResponses([
      { ...completeResult(), analyses: analyses.filter(a => a.market.key !== 'exploration') },
      { ...completeResult(), analyses: analyses.filter(a => a.market.key === 'exploration') },
    ]);
    assert.deepEqual(merged.recommendation, buildMarketTrendRecommendation(analyses));
    assert.equal(merged.recommendation.methodology_version, 3);
  }
  const earlier = { ...completeResult(), recommendation: { ...completeResult().recommendation, methodology_version: 2 } };
  assert.equal(f.api.mergeMarketStudyResponses([earlier, completeResult()]).recommendation.methodology_version, 2,
    'Mixed-version results cannot claim the new scoring method');
});

test('the recommendation describes consistency scoring and flags older saved scores', async t => {
  for (const version of [2, 3]) {
    const value = completeResult(); value.recommendation.methodology_version = version;
    const h = marketComponent({ initialDraft: draft(value) }); t.after(h.dispose); await h.settle();
    const node = walk(h.render()).find(n => typeof n.type === 'function' && n.type.name === 'MarketStudyDetermination');
    const rendered = text(node.type(node.props));
    assert.match(rendered, version === 3 ? /Lower average COD\/CV ranks higher/ : /Rerun market studies for COD\/CV ranking/);
    assert.doesNotMatch(rendered, /ranked by sample sufficiency/);
  }
});

test('ranked-card selection applies new numbers and explanation without another request or modifying the study results', async t => {
  const value = completeResult(), keys = ['zip', 'radius_1', 'exploration'];
  value.analyses = keys.map((key, index) => ({ ...value.analyses[0], market: { key, label: key },
    statistics: { annualized_change_percent: [10, 80, -20][index], sample_sufficient: index !== 0 } }));
  value.recommendation.ranked_studies = value.analyses.map((a, index) => ({ key: a.market.key, label: a.market.label,
    rank: index + 1, reliability_score: 80, sale_count: 50, annualized_change_percent: a.statistics.annualized_change_percent }));
  const h = marketComponent({ initialDraft: { ...draft(value), selectedAreaKeys: keys,
    reconciliation: { trendConclusion: 'increasing', reliedUponAreaKeys: keys, explanation: 'Appraiser original' } } });
  t.after(h.dispose); await h.settle();
  const determination = () => walk(h.render()).find(n => typeof n.type === 'function' && n.type.name === 'MarketStudyDetermination');
  determination().props.onToggle('radius_1'); await h.settle();
  assert.equal(h.published.at(-1).reconciliation.explanation, 'Appraiser original', 'checkboxes alone do not overwrite an appraiser explanation');
  determination().props.onApply(); await h.settle();
  const chosen = h.published.at(-1);
  assert.deepEqual(chosen.reconciliation.reliedUponAreaKeys, ['zip', 'exploration']);
  assert.equal(chosen.reconciliation.trendConclusion, 'decreasing');
  assert.match(chosen.reconciliation.explanation, /-5.0% reconciled annualized/);
  assert.equal(chosen.response, value);
  assert.equal(h.queries.length, 0);
  assert.match(text(determination().type(determination().props)), /-5.0% reconciled annualized change/);
  assert.match(text(determination().type(determination().props)), /Provisional.*insufficient sales sample: zip/);
  assert.match(chosen.reconciliation.explanation, /Provisional estimate: zip/);
});

test('an analysis finishing after another map click cannot publish an old selection', async t => {
  const h = marketComponent(); t.after(h.dispose); await h.settle();
  h.button('Run 1 market study').props.onClick(); await h.settle();
  h.update({ explorationArea: { ...group, binding: { ...group.binding, selectionFingerprint: 'c'.repeat(64) } } });
  h.operation.resolve(completeResult()); await h.settle();
  assert.equal(h.published.filter(Boolean).length, 0); assert.match(h.text, /Study required/);
});

test('saved exploration results require the same active context, not just the same date and area key', async t => {
  for (const [response, explorationArea, expectedCurrent] of [
    [completeResult(), group, true], [completeResult(), null, false],
    [{ ...completeResult(), exploration_binding: null }, null, false],
    [completeResult(), { ...group, binding: { ...group.binding, selectionFingerprint: 'c'.repeat(64) } }, false],
  ]) {
    const h = marketComponent({ initialDraft: draft(response), explorationArea }); t.after(h.dispose); await h.settle();
    assert.equal(Boolean(h.published.at(-1)), expectedCurrent);
    if (!explorationArea) assert.equal(h.button('Run 1 market study').props.disabled, true);
  }
});
