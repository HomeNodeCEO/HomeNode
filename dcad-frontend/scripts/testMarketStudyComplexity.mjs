import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';

const helper = loadTrustedRepositoryCommonJs(new URL('../src/lib/marketStudyComplexity.ts', import.meta.url), () => assert.fail('Type-only imports'));
const base = () => ({ account_id: 'A', computed_at: '2026-10-06', geography: 'suburban',
  subject: { gross_living_area_sqft: 1500, year_built: 1960 }, factors: [], warnings: [],
  spatial_context: { parcel_available: true }, source_health: [{ usable: true, serving_stale_data: false }] });
const area = (key, gla = 1500, age = 66, cv = 10, sales = 60) => ({
  market: { key, label: key }, period: { end: '2026-09-30' }, population: { eligible_sale_count: sales },
  summary: { median_living_area: gla, median_age: age }, statistics: { composite_cod: 5, composite_cv: cv, reliability_score: 80 },
});
const response = (...analyses) => ({ subject: { account_id: 'A' }, analyses });

test('complexity reuses each independent study, never pools overlapping counts or medians', () => {
  const context = base(); context.factors = [{ code: 'atypical_gla', points: 20 }, { code: 'corner_lot', points: 6 }];
  const value = helper.buildMarketStudyComplexity(context, response(area('zip', 3000), area('exploration')), ['zip', 'exploration'], 'sig');
  assert.equal(value.studies.length, 2);
  assert.equal(value.assessment.peer_statistics.peer_count, 60, 'not 120 unique sales');
  assert.equal(value.assessment.peer_statistics.gla.median, null, 'no median-of-medians');
  assert.equal(value.assessment.score, 13, 'local 6 plus weighted GLA screening 7');
  assert.equal(value.assessment.factors.some(f => f.code === 'atypical_gla'), false);
  const selected = helper.buildMarketStudyComplexity(context, response(area('zip', 3000), area('exploration')), ['exploration'], 'sig');
  assert.equal(selected.assessment.score, 6);
});

test('age follows study dates; missing measurements stay unknown and reduce confidence', () => {
  const historical = area('exploration', null, 64, null); historical.period.end = '2024-12-31';
  const value = helper.buildMarketStudyComplexity(base(), response(historical), ['exploration'], 'sig');
  assert.equal(value.studies[0].ageDifferenceYears, 0);
  assert.equal(value.studies[0].livingAreaDifferencePercent, null);
  assert.equal(value.assessment.confidence, 'limited');
  assert.match(value.assessment.warnings.join(' '), /lack measurements/);
  assert.equal(helper.buildMarketStudyComplexity(base(), response(area('exploration')), [], 'sig'), null);
  assert.equal(helper.buildMarketStudyComplexity({ ...base(), account_id: 'B' }, response(area('exploration')), ['exploration'], 'sig'), null);
});

test('local hard influences remain; appraiser review is tied to the weighted evidence', () => {
  const context = base(); context.factors = [{ code: 'commercial_proximity', points: 14, evidence: { distance_feet: 90 } }];
  const studies = response(area('zip'), area('exploration'));
  assert.equal(helper.buildMarketStudyComplexity(context, studies, ['exploration'], 'sig').assessment.automatic_complexity, 'moderate');
  context.factors = [{ code: 'commercial_adjacency', points: 30 }];
  assert.equal(helper.buildMarketStudyComplexity(context, studies, ['exploration'], 'sig').assessment.automatic_complexity, 'complex');
  const review = { complexity: 'simple', notes: 'Reviewed', sourceComputedAt: context.computed_at, reviewedAt: context.computed_at,
    evidenceKey: helper.marketComplexityEvidenceKey('sig', ['exploration']) };
  assert.equal(helper.buildMarketStudyComplexity(context, studies, ['exploration'], 'sig', review).assessment.effective_complexity, 'simple');
  assert.equal(helper.buildMarketStudyComplexity(context, studies, ['zip'], 'sig', review).review, null);
  assert.equal(helper.buildMarketStudyComplexity(context, studies, ['exploration'], 'other', review).review, null);
});

const requireRuntime = createRequire(new URL('../package.json', import.meta.url));
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function component(overrides = {}) {
  let cursor = 0, tree, dirty = false;
  const cells = [], effects = [], queries = [], published = [], saves = [], operation = deferred(), saveOperation = deferred();
  let props = { accountId: 'A', assignmentFileId: 7, response: response(area('exploration')), current: true,
    studySignature: 'sig', studyRevision: 0, geography: 'suburban', reliedUpon: ['exploration'],
    ...overrides, onChange: value => published.push(value) };
  const react = {
    useState(initial) { const i = cursor++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [cells[i].value, next => { const value = typeof next === 'function' ? next(cells[i].value) : next;
        if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; return cells[i] ??= { current: initial }; },
    useMemo(factory, deps) { const i = cursor++; if (!same(cells[i]?.deps, deps)) cells[i] = { deps, value: factory() }; return cells[i].value; },
    useEffect(effect, deps) { const i = cursor++; if (!same(cells[i]?.deps, deps)) effects.push(() => {
      cells[i]?.cleanup?.(); cells[i] = { deps, cleanup: effect() }; }); },
  };
  const Component = loadTrustedRepositoryCommonJs(new URL('../src/components/MarketStudyPropertyContext.tsx', import.meta.url), dependency => {
    if (dependency === 'react') return react;
    if (dependency === 'react/jsx-runtime') return requireRuntime(dependency);
    if (dependency === '@/lib/marketStudyComplexity') return helper;
    if (dependency === './PropertyContextSection') return { default: 'PropertyContextSection' };
    if (dependency === '@/lib/api') return { analyzePropertyContext: (...args) => { queries.push(args); return operation.promise; },
      savePropertyContextReview: (...args) => { saves.push(args); return saveOperation.promise; } };
    assert.fail(dependency);
  }).default;
  function render() { let passes = 0; do { dirty = false; cursor = 0; tree = Component(props);
    while (effects.length) effects.shift()(); assert.ok(++passes < 40, 'Effects settle without save loops'); } while (dirty); return tree; }
  async function settle() { for (let i = 0; i < 6; i++) { await Promise.resolve(); render(); } }
  return { render, settle, queries, published, saves, operation, saveOperation,
    update(change) { props = { ...props, ...change }; return render(); },
    get view() { return render().props.children.props; }, dispose() { for (const cell of cells) cell?.cleanup?.(); } };
}

test('completed studies automatically load only local context; weighting reuses results and persistence settles', async t => {
  const h = component(); t.after(h.dispose); await h.settle();
  assert.equal(h.queries.length, 1);
  assert.deepEqual(h.queries[0], ['A', { assignmentFileId: 7, geography: 'suburban', marketStudyContextOnly: true }]);
  h.operation.resolve(base()); await h.settle();
  assert.equal(h.published.at(-1).assessment.automatic_complexity, 'simple');
  assert.equal(h.view.peerSummary, '1 independent study areas');
  h.update({ reliedUpon: [] }); await h.settle();
  assert.equal(h.published.at(-1), null);
  assert.equal(h.queries.length, 1, 'no fixed-radius peer or sales rerun');
});

test('stale studies cannot trigger or publish context; saved current evidence reopens without another query', async t => {
  const h = component({ current: false }); t.after(h.dispose); await h.settle(); assert.equal(h.queries.length, 0);
  h.update({ current: true }); await h.settle(); assert.equal(h.queries.length, 1);
  h.update({ current: false }); h.operation.resolve(base()); await h.settle(); assert.equal(h.published.at(-1), null);
  const saved = helper.buildMarketStudyComplexity(base(), response(area('exploration')), ['exploration'], 'sig');
  const restored = component({ initialScreening: saved }); t.after(restored.dispose); await restored.settle();
  assert.equal(restored.queries.length, 0); assert.equal(restored.published.at(-1).studySignature, 'sig');
  const changedGeography = component({ initialScreening: saved, geography: 'rural' }); t.after(changedGeography.dispose);
  await changedGeography.settle(); assert.equal(changedGeography.queries.length, 1);
  assert.equal(changedGeography.published.at(-1), null, 'saved suburban screening cannot masquerade as rural');
});

test('review response cannot overwrite changed weighting or another file', async t => {
  for (const changed of [{ reliedUpon: [] }, { assignmentFileId: 8 }, { studyRevision: 1 }]) {
    const h = component(); t.after(h.dispose); await h.settle(); h.operation.resolve(base()); await h.settle();
    h.view.onComplexityChange('complex'); h.view.onNotesChange('Appraiser review'); await h.settle(); h.view.onSave();
    assert.equal(h.saves.length, 1); h.update(changed);
    h.saveOperation.resolve({ ...base(), reviewed_at: '2026-10-06' }); await h.settle();
    assert.notEqual(h.published.at(-1)?.review?.complexity, 'complex');
  }
});
