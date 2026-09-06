import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { automaticBoundaryRestoreState } from '../src/lib/neighborhoodBoundaryRestore.ts';
import { neighborhoodSelectionStatisticsPatch } from '../src/lib/neighborhoodCharacteristics.ts';

// Controlled execution of the actual component callback/effect bodies, without
// JSX or map mounting. These are callback/effect tests, not browser tests.
const source = readFileSync(new URL('../src/components/NeighborhoodCharacteristicsContent.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('  const [landUseAnalysis,');
const end = source.indexOf('  return (\n    <div className="space-y-3">', start);
assert.ok(start >= 0 && end > start);
const body = stripTypeScriptTypes(`function component() { ${source.slice(start, end)} }`).slice('function component() {'.length, -1);
const safetySource = stripTypeScriptTypes(readFileSync(new URL('../src/hooks/useNeighborhoodRequestSafety.ts', import.meta.url), 'utf8'));
const safetyBody = safetySource.slice(safetySource.indexOf('function analyticalContext')).replace('export function useNeighborhoodRequestSafety', 'function useNeighborhoodRequestSafety');
const createComponent = new Function('bindings', `const {
  useState, useRef, useMemo, useCallback, useEffect, useLayoutEffect,
  getNeighborhoodBoundary, runNeighborhoodBoundaryGeneration, runNeighborhoodRelevanceGeneration,
  automaticBoundaryRestoreState, applyPocketOverrides, recommendPocketSelection, summarizePockets,
  neighborhoodBoundaryReadinessErrors, parseNumber, determineNeighborhoodValuePosition,
  calculateNeighborhoodRepresentativeness, hasSavedNeighborhoodLandUseProfile, neighborhoodSelectionStatisticsPatch
} = bindings;
${safetyBody}
return function render({ accountId, assignmentFileId, assignmentDraft, marketConditionsDraft,
  onAssignmentChange: onParentAssignmentChange, onBoundarySuggestionsChange }) {
  const DISCOVERY_ENVELOPE_METHODOLOGY_VERSION = 6;
  const valuePositionContext = { concludedValue: null };
  ${body}
  return { generateSuggestedBoundary, analyzeRelevantPropertyDataset, handleCustomGeometryChange,
    setPocketIncluded, resetPocketOverrides, applyRecommendedPocketSelection,
    generatedBoundary, generatedBoundaryLoading, generatedBoundaryMessage,
    relevanceAssessment, relevanceLoading, relevanceMessage };
}`);
const geometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
const editedGeometry = { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]] };
const draft = {
  neighborhood_boundary_geometry: geometry, neighborhood_boundary_source: 'neighborhood_boundary_engine_v6',
  neighborhood_boundary_engine_assessment_id: 9, neighborhood_boundary_engine_assignment_file_id: 12,
  neighborhood_boundary_engine_methodology_version: 6, neighborhood_relevance_removed_pocket_ids: [],
  neighborhood_relevance_added_pocket_ids: [],
};
const boundary = (id = 10) => ({ id, account_id: 'account', assignment_file_id: 12,
  methodology_version: 6, generated_at: '2026-09-06', discovery_radius_miles: 3,
  boundary: geometry, evidence: { discovery: { candidate_count: 100 } } });
const relevance = (id = 20) => ({ id, account_id: 'account', assignment_file_id: 12,
  boundary_assessment_id: 9, methodology_version: 6, generated_at: '2026-09-06', confidence: {},
  summary: { candidate_count: 100, included_count: 50, excluded_count: 50, insufficient_data_count: 0,
    relevant_statistics: { included_sale_count: 10, included_property_count: 50,
      sales_profile: { sale_price: { median: 250000 } }, property_profile: {} } }, visualization: [] });

function harness({ automatic = false, initialDraft = draft } = {}) {
  const slots = [], effects = [], requests = [], assignments = [], suggestions = [];
  let cursor = 0, options = { accountId: 'account', assignmentFileId: 12 }, currentDraft = structuredClone(initialDraft), api;
  const equal = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
  const request = kind => (...args) => new Promise((resolve, reject) => requests.push({ kind, args, resolve, reject }));
  const effect = type => (callback, deps) => { const i = cursor++;
    if (!slots[i] || !equal(deps, slots[i].deps)) {
      const previous = slots[i];
      const isAutomatic = /automatic(?:Boundary|Relevance)AttemptRef\.current ===/.test(callback.toString());
      slots[i] = { deps, cleanup: previous?.cleanup, callback: !isAutomatic || automatic ? callback : null, type };
      if (!isAutomatic || automatic) effects.push(() => { previous?.cleanup?.(); slots[i].cleanup = callback(); });
    }
  };
  const component = createComponent({
    useState: initial => { const i = cursor++; slots[i] ||= { value: initial };
      return [slots[i].value, value => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; }]; },
    useRef: value => { const i = cursor++; return slots[i] ||= { current: value }; },
    useMemo: (callback, deps) => { const i = cursor++; if (!slots[i] || !equal(deps, slots[i].deps)) slots[i] = { deps, value: callback() }; return slots[i].value; },
    useCallback: (callback, deps) => { const i = cursor++; if (!slots[i] || !equal(deps, slots[i].deps)) slots[i] = { deps, value: callback }; return slots[i].value; },
    useEffect: effect('passive'), useLayoutEffect: effect('layout'),
    getNeighborhoodBoundary: request('lookup'), runNeighborhoodBoundaryGeneration: request('boundary'), runNeighborhoodRelevanceGeneration: request('relevance'),
    automaticBoundaryRestoreState, neighborhoodSelectionStatisticsPatch,
    applyPocketOverrides: (assessment, removed, added) => assessment.summary.relevant_statistics
      ? ({ ...assessment, summary: { ...assessment.summary,
        relevant_statistics: { ...assessment.summary.relevant_statistics,
          included_sale_count: assessment.summary.relevant_statistics.included_sale_count - removed.length + added.length } } })
      : assessment,
    recommendPocketSelection: () => ({ removedSystemPocketIds: ['recommended'], recommendedPocketIds: [], recommendedPocketCount: 1 }),
    summarizePockets: () => [], neighborhoodBoundaryReadinessErrors: () => [], parseNumber: () => null,
    determineNeighborhoodValuePosition: () => ({ ready: false }), calculateNeighborhoodRepresentativeness: () => ({}), hasSavedNeighborhoodLandUseProfile: () => true,
  });
  const onAssignmentChange = (key, value) => { assignments.push([options.assignmentFileId, key, value]); currentDraft = { ...currentDraft, [key]: value }; };
  const onBoundarySuggestionsChange = value => suggestions.push(value);
  const render = (updates = {}, flushEffects = true) => {
    options = { ...options, ...updates }; cursor = 0;
    api = component({ ...options, assignmentDraft: currentDraft, marketConditionsDraft: options.marketConditionsDraft || null, onAssignmentChange, onBoundarySuggestionsChange });
    if (flushEffects) while (effects.length) effects.shift()();
    return api;
  };
  render();
  return { requests, assignments, suggestions, render, get api() { return api; }, get draft() { return currentDraft; },
    changeDraft: (patch, flushEffects = true) => { currentDraft = { ...currentDraft, ...patch }; return render({}, flushEffects); },
    complete: async (request, value) => { request.resolve(value); for (let i = 0; i < 10; i++) await Promise.resolve(); },
    fail: async (request, message) => { request.reject(new Error(message)); for (let i = 0; i < 10; i++) await Promise.resolve(); },
    cancel: () => { for (const slot of slots) slot?.cleanup?.(); },
    replayEffects: () => {
      for (const slot of slots) slot?.cleanup?.();
      for (const type of ['layout', 'passive']) for (const slot of slots) {
        if (slot?.type === type && slot.callback) slot.cleanup = slot.callback();
      }
    },
  };
}

test('manual boundary response cannot write into a different exact assignment or account', async () => {
  for (const options of [{ assignmentFileId: 13 }, { accountId: 'different' }]) {
    const h = harness(); void h.api.generateSuggestedBoundary(); h.render(options, false);
    await h.complete(h.requests[0], boundary()); assert.equal(h.assignments.length, 0);
  }
});

test('manual boundary generation preserves a draw or clear before the next render', async () => {
  for (const [value, origin] of [[editedGeometry, 'manual'], [null, 'cleared']]) {
    const h = harness(); void h.api.generateSuggestedBoundary(); h.api.handleCustomGeometryChange(value, origin);
    await h.complete(h.requests[0], boundary()); assert.deepEqual(h.draft.neighborhood_boundary_geometry, value);
  }
});

test('a newer manual boundary request wins over an older same-file response', async () => {
  const h = harness(); void h.api.generateSuggestedBoundary(3); void h.api.generateSuggestedBoundary(4);
  assert.equal(h.requests.length, 2);
  await h.complete(h.requests[1], boundary(11)); await h.complete(h.requests[0], boundary(10));
  assert.equal(h.draft.neighborhood_boundary_engine_assessment_id, 11);
});

test('old-file relevance success, error, and finally cannot change current UI/data', async () => {
  const h = harness(); void h.api.analyzeRelevantPropertyDataset(); h.render({ assignmentFileId: 13 }, false);
  await h.complete(h.requests[0], relevance()); assert.equal(h.assignments.length, 0);
  const failed = harness(); void failed.api.analyzeRelevantPropertyDataset(); failed.render({ assignmentFileId: 13 });
  await failed.fail(failed.requests[0], 'old-file-error');
  assert.notEqual(failed.render().relevanceMessage, 'old-file-error');
});

test('a changed analytical assessment rejects its earlier relevance result', async () => {
  const h = harness(); void h.api.analyzeRelevantPropertyDataset(); h.changeDraft({ neighborhood_boundary_engine_assessment_id: 10 }, false);
  await h.complete(h.requests[0], relevance()); assert.equal(h.assignments.length, 0);
});

test('latest pocket choices are used after loading, including clicks before React rerenders', async () => {
  const h = harness(); void h.api.analyzeRelevantPropertyDataset(); await h.complete(h.requests[0], relevance()); h.render();
  void h.api.analyzeRelevantPropertyDataset(); h.api.setPocketIncluded('p1', false, true);
  await h.complete(h.requests[1], relevance(21));
  assert.equal(h.draft.neighborhood_sale_count, 9);
  assert.deepEqual(h.draft.neighborhood_relevance_removed_pocket_ids, ['p1']);
});

test('unmount prevents outstanding manual and relevance writes', async () => {
  const h = harness(); void h.api.generateSuggestedBoundary(); void h.api.analyzeRelevantPropertyDataset(); h.cancel();
  await h.complete(h.requests[0], boundary()); await h.complete(h.requests[1], relevance());
  assert.equal(h.assignments.length, 0);
});

test('automatic lookup is scoped before effect cleanup and cannot start stale generation', async () => {
  const h = harness({ automatic: true }); const lookup = h.requests.find(request => request.kind === 'lookup');
  h.render({ assignmentFileId: 13 }, false); await h.complete(lookup, null);
  assert.equal(h.requests.filter(request => request.kind === 'boundary').length, 0);
});

test('boundary metadata for another assignment cannot start relevance against that file', () => {
  const h = harness({ initialDraft: { ...draft, neighborhood_boundary_engine_assignment_file_id: 99 } });
  void h.api.analyzeRelevantPropertyDataset();
  assert.equal(h.requests.length, 0);
});

test('changed engine geometry invalidates a request even when its assessment ID is unchanged', async () => {
  const h = harness(); void h.api.analyzeRelevantPropertyDataset();
  h.changeDraft({ neighborhood_boundary_geometry: editedGeometry }, false);
  await h.complete(h.requests[0], relevance()); assert.equal(h.assignments.length, 0);
});

test('a narrative-only edit retains the analytical envelope and pending relevance', async () => {
  const h = harness(); void h.api.analyzeRelevantPropertyDataset();
  h.api.handleCustomGeometryChange(editedGeometry, 'manual'); h.render();
  await h.complete(h.requests[0], relevance());
  assert.deepEqual(h.draft.neighborhood_boundary_geometry, editedGeometry);
  assert.equal(h.draft.neighborhood_boundary_engine_assessment_id, 9);
  assert.equal(h.draft.neighborhood_relevance_assessment_id, 20);
  assert.deepEqual(h.requests[0].args, ['account', { assignmentFileId: 12, boundaryAssessmentId: 9 }]);
});

test('old relevance errors and finally cannot clear the latest request loading state', async () => {
  const h = harness(); void h.api.analyzeRelevantPropertyDataset(); void h.api.analyzeRelevantPropertyDataset();
  await h.fail(h.requests[0], 'older-failure');
  assert.equal(h.render().relevanceLoading, true);
  assert.notEqual(h.api.relevanceMessage, 'older-failure');
  await h.complete(h.requests[1], relevance(21));
  assert.equal(h.render().relevanceLoading, false);
  assert.equal(h.draft.neighborhood_relevance_assessment_id, 21);
});

test('old manual boundary errors and finally cannot clear the latest loading state', async () => {
  const h = harness(); void h.api.generateSuggestedBoundary(); void h.api.generateSuggestedBoundary();
  await h.fail(h.requests[0], 'older-boundary-failure');
  assert.equal(h.render().generatedBoundaryLoading, true);
  assert.notEqual(h.api.generatedBoundaryMessage, 'older-boundary-failure');
  await h.complete(h.requests[1], boundary(11));
  assert.equal(h.render().generatedBoundaryLoading, false);
  assert.equal(h.render().generatedBoundary.id, 11);
});

test('automatic upgrade completion cannot replace newer manual generation', async () => {
  const h = harness({ automatic: true });
  await h.complete(h.requests.find(r => r.kind === 'lookup'), { ...boundary(), methodology_version: 5 });
  const automatic = h.requests.find(r => r.kind === 'boundary');
  void h.api.generateSuggestedBoundary(4);
  const manual = h.requests.filter(r => r.kind === 'boundary').at(-1);
  await h.complete(manual, boundary(12)); await h.complete(automatic, boundary(10));
  assert.equal(h.draft.neighborhood_boundary_engine_assessment_id, 12);
});

test('file changes clear old result views and loading indicators', async () => {
  const h = harness(); void h.api.analyzeRelevantPropertyDataset(); await h.complete(h.requests[0], relevance()); h.render();
  assert.equal(h.api.relevanceAssessment.id, 20);
  h.render({ assignmentFileId: 13 }); h.render();
  assert.equal(h.api.relevanceAssessment, null);
  assert.equal(h.api.generatedBoundary, null);
  assert.equal(h.api.relevanceLoading, false);
  assert.equal(h.api.generatedBoundaryLoading, false);
});

test('rapid pocket clicks, reset, and recommendations use current overrides while a request loads', async () => {
  const h = harness(); void h.api.analyzeRelevantPropertyDataset(); await h.complete(h.requests[0], relevance()); h.render();
  void h.api.analyzeRelevantPropertyDataset();
  h.api.setPocketIncluded('p1', false, true); h.api.setPocketIncluded('p2', false, true);
  await h.complete(h.requests[1], relevance(21));
  assert.deepEqual(h.draft.neighborhood_relevance_removed_pocket_ids, ['p1', 'p2']);
  assert.equal(h.draft.neighborhood_sale_count, 8);
  h.render(); void h.api.analyzeRelevantPropertyDataset(); h.api.resetPocketOverrides();
  await h.complete(h.requests[2], relevance(22)); assert.equal(h.draft.neighborhood_sale_count, 10);
  h.render(); void h.api.analyzeRelevantPropertyDataset(); h.api.applyRecommendedPocketSelection();
  await h.complete(h.requests[3], relevance(23)); assert.equal(h.draft.neighborhood_sale_count, 9);
  assert.deepEqual(h.draft.neighborhood_relevance_removed_pocket_ids, ['recommended']);
});

test('deliberate generation still replaces an existing engine area or an already-cleared area', async () => {
  for (const initialDraft of [draft, { ...draft, neighborhood_boundary_geometry: null, neighborhood_boundary_source: 'appraiser_defined_area_cleared' }]) {
    const h = harness({ initialDraft });
    h.render({ marketConditionsDraft: { response: { analyses: [{ market: { key: 'custom', custom_geometry: geometry } }] } } });
    void h.api.generateSuggestedBoundary(4); await h.complete(h.requests[0], boundary(11));
    assert.equal(h.draft.neighborhood_boundary_engine_assessment_id, 11);
    assert.deepEqual(h.draft.neighborhood_boundary_geometry, geometry);
  }
});

test('initial automatic generation retains its view and settles without request loops', async () => {
  const h = harness({ automatic: true, initialDraft: {} });
  assert.deepEqual(h.requests.map(r => r.kind), ['lookup']);
  await h.complete(h.requests[0], null);
  assert.deepEqual(h.requests.map(r => r.kind), ['lookup', 'boundary']);
  await h.complete(h.requests[1], boundary(10));
  h.render(); h.render();
  assert.equal(h.api.generatedBoundary?.id, 10, 'own field application survives the context layout reset');
  assert.equal(h.api.generatedBoundaryLoading, false);
  assert.deepEqual(h.requests.map(r => r.kind), ['lookup', 'boundary', 'relevance']);
  await h.complete(h.requests[2], { ...relevance(), boundary_assessment_id: 10 });
  for (let i = 0; i < 5; i++) h.render();
  assert.equal(h.requests.length, 3);
  assert.equal(h.api.relevanceLoading, false);
  assert.equal(h.api.relevanceAssessment?.id, 20);
});

test('StrictMode-style effect cleanup and setup restart canceled loads without stuck indicators', async () => {
  const h = harness({ automatic: true });
  assert.deepEqual(h.requests.map(r => r.kind), ['lookup', 'relevance']);
  h.replayEffects();
  assert.deepEqual(h.requests.map(r => r.kind), ['lookup', 'relevance', 'lookup', 'relevance']);
  await h.complete(h.requests[0], boundary(99));
  await h.complete(h.requests[1], relevance(99));
  assert.equal(h.assignments.length, 0, 'the first mount requests remain canceled');
  await h.complete(h.requests[2], boundary(9));
  await h.complete(h.requests[3], relevance(20));
  for (let i = 0; i < 5; i++) h.render();
  assert.equal(h.requests.length, 4);
  assert.equal(h.api.generatedBoundaryLoading, false);
  assert.equal(h.api.relevanceLoading, false);
  assert.equal(h.api.generatedBoundary?.id, 9);
  assert.equal(h.api.relevanceAssessment?.id, 20);
});

test('explicit adoption reloads relevance exactly once when the engine ID and geometry are reused', async () => {
  const h = harness({ automatic: true, initialDraft: { ...draft,
    neighborhood_boundary_engine_disclosure: '', neighborhood_boundary_engine_warnings: [] } });
  await h.complete(h.requests[0], boundary(9)); await h.complete(h.requests[1], relevance(20));
  h.render(); h.render();
  assert.equal(h.requests.filter(r => r.kind === 'relevance').length, 1);
  h.api.handleCustomGeometryChange(geometry, 'automatic'); h.render(); h.render();
  const requests = h.requests.filter(r => r.kind === 'relevance');
  assert.equal(requests.length, 2, 'adoption must not leave a cleared relevance view without its reload');
  await h.complete(requests[1], relevance(21));
  for (let i = 0; i < 5; i++) h.render();
  assert.equal(h.requests.filter(r => r.kind === 'relevance').length, 2);
  assert.equal(h.api.relevanceAssessment?.id, 21);
  assert.equal(h.api.generatedBoundary?.id, 9);
  assert.equal(h.api.relevanceLoading, false);
});

test('the first render of a new file or account cannot expose the prior scope suggestion or pockets', async () => {
  for (const newScope of [{ assignmentFileId: 13 }, { accountId: 'another-account' }]) {
    const h = harness();
    void h.api.generateSuggestedBoundary(); await h.complete(h.requests[0], boundary(10)); h.render();
    void h.api.analyzeRelevantPropertyDataset(); await h.complete(h.requests[1], relevance(20)); h.render();
    assert.equal(h.api.generatedBoundary.id, 10);
    assert.equal(h.api.relevanceAssessment.id, 20);
    // A newly keyed map initializes from these values before parent layout effects.
    const firstRender = h.render(newScope, false);
    assert.equal(firstRender.generatedBoundary, null);
    assert.equal(firstRender.relevanceAssessment, null);
  }
});

const statisticFields = [
  'neighborhood_sale_count', 'neighborhood_all_property_count',
  ...['', 'all_'].flatMap(prefix => ['house_price', 'ppsf', 'age', 'gla'].flatMap(measure =>
    ['low', 'high', 'predominant'].map(range => `neighborhood_${prefix}${measure}_${range}`))),
  ...['value', 'ppsf', 'age', 'gla'].map(measure => `neighborhood_all_${measure}_count`),
];
const automaticValueFields = ['position', 'difference', 'difference_pct', 'conclusion',
  'conclusion_auto', 'conclusion_signature', 'conclusion_generated_at', 'source']
  .map(field => `neighborhood_value_${field}`);
const populatedDraft = {
  ...draft, ...Object.fromEntries(statisticFields.map(field => [field, 123])),
  ...Object.fromEntries(automaticValueFields.map(field => [field, 'old automatic value'])),
  subject_concluded_value: 300000, neighborhood_city_house_price_low: 222,
  neighborhood_land_use_one_unit_pct: 80, neighborhood_market_trend: 'stable',
};

test('explicit analytical replacement invalidates old statistics and generated value companions together', async () => {
  const h = harness({ initialDraft: populatedDraft });
  void h.api.generateSuggestedBoundary(4); await h.complete(h.requests[0], boundary());
  for (const field of [...statisticFields, ...automaticValueFields]) assert.equal(h.draft[field], '', field);
  for (const field of ['subject_concluded_value', 'neighborhood_city_house_price_low',
    'neighborhood_land_use_one_unit_pct', 'neighborhood_market_trend']) {
    assert.equal(h.draft[field], populatedDraft[field], field);
  }
  assert.equal(h.draft.neighborhood_boundary_engine_assessment_id, 10);
});

test('replacement preserves the exact appraiser-written value explanation but invalidates its automatic basis', async () => {
  const manual = '  My inspection supports this conclusion.\nReview against the new area.  ';
  const h = harness({ initialDraft: { ...populatedDraft, neighborhood_value_conclusion: manual } });
  void h.api.generateSuggestedBoundary(4); await h.complete(h.requests[0], boundary());
  assert.equal(h.draft.neighborhood_value_conclusion, manual);
  assert.equal(h.draft.neighborhood_value_conclusion_auto, '');
  assert.equal(h.draft.neighborhood_value_conclusion_signature, '');
});

test('narrative-only edits and non-adopted suggestions do not invalidate the selected statistics', async () => {
  const h = harness({ automatic: true, initialDraft: populatedDraft });
  await h.complete(h.requests.find(r => r.kind === 'lookup'), boundary());
  h.api.handleCustomGeometryChange(editedGeometry, 'manual');
  for (const field of [...statisticFields, ...automaticValueFields]) assert.equal(h.draft[field], populatedDraft[field], field);
});

test('a replacement result without statistics cannot keep old measurements or an old generated explanation', async () => {
  const h = harness({ initialDraft: populatedDraft });
  void h.api.analyzeRelevantPropertyDataset();
  const result = relevance(); delete result.summary.relevant_statistics;
  await h.complete(h.requests[0], result);
  for (const field of [...statisticFields, ...automaticValueFields]) assert.equal(h.draft[field], '', field);
});

test('partial profiles replace the old group without converting unreported metric counts to zero', async () => {
  const h = harness({ initialDraft: populatedDraft });
  void h.api.analyzeRelevantPropertyDataset();
  const result = relevance();
  result.summary.relevant_statistics = { included_sale_count: 0, included_property_count: 50,
    property_profile: { market_value: { low: 100000, median: 200000, high: 300000, count: 0 } } };
  await h.complete(h.requests[0], result);
  assert.equal(h.draft.neighborhood_sale_count, 0);
  assert.equal(h.draft.neighborhood_all_property_count, 50);
  assert.equal(h.draft.neighborhood_all_house_price_predominant, 200000);
  assert.equal(h.draft.neighborhood_all_value_count, 0);
  assert.equal(h.draft.neighborhood_all_ppsf_count, '');
  assert.equal(h.draft.neighborhood_house_price_predominant, '');
  assert.equal(h.draft.neighborhood_value_conclusion, '');
});
