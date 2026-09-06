import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

// Execute the trusted local hook with controlled React primitives/promises.
// This is hook/effect-level regression coverage, not a browser/render test.
const source = stripTypeScriptTypes(readFileSync(new URL('../src/hooks/useNeighborhoodProfile.ts', import.meta.url), 'utf8'));
const bodyStart = source.indexOf('function profileSignature(');
assert.ok(bodyStart >= 0, 'profile helper and hook remain available');
const createHook = new Function('bindings', `const {
  useState, useRef, useCallback, useEffect, getNeighborhoodProfile,
  DEFAULT_NEIGHBORHOOD_BOUNDARY_NARRATIVE, marketTrendFromChange,
  retainCurrentDraftWhenUnchanged, cloneEditorValue, hasValue, window
} = bindings; ${source.slice(bodyStart).replace('export function useNeighborhoodProfile', 'function useNeighborhoodProfile')}
return useNeighborhoodProfile;`);

const geometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
const differentGeometry = { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]] };
const customStudy = {
  market: { key: 'custom', label: 'Broad area', custom_geometry: geometry },
  summary: { minimum_sale_price: 100000, maximum_sale_price: 500000, median_sale_price: 300000,
    minimum_price_per_square_foot: 100, maximum_price_per_square_foot: 250, median_price_per_square_foot: 170,
    minimum_age: 3, maximum_age: 80, median_age: 35,
    minimum_living_area: 900, maximum_living_area: 4000, median_living_area: 2100 },
  population: { eligible_sale_count: 123 }, statistics: { annualized_change_percent: 0 },
};
const profile = {
  analyses: [customStudy, { market: { key: 'city', city: 'Garland' },
    summary: { average_sale_price: 350000 }, population: { eligible_sale_count: 456 }, period: { end: '2026-09-01' } }],
  subject: { city: 'Garland' }, boundary_streets: {
    cardinal_boundaries: { north: { primary_street: 'North Road' }, east: { primary_street: 'East Road' },
      south: { primary_street: 'South Road' }, west: { primary_street: 'West Road' } },
    source: 'cached roads', retrieved_at: '2026-09-01T00:00:00Z',
  },
};
const ordinary = { neighborhood_boundary_geometry: geometry, neighborhood_boundary_source: 'appraiser_defined_area_manual_v1' };
const selected = { ...ordinary, neighborhood_boundary_engine_assessment_id: 9, neighborhood_relevance_assessment_id: 12,
  neighborhood_relevance_removed_pocket_ids: ['p1'], neighborhood_relevance_added_pocket_ids: ['p2'],
  neighborhood_house_price_predominant: 240000, neighborhood_sale_count: 25,
  neighborhood_ppsf_predominant: 150, neighborhood_age_predominant: 41, neighborhood_gla_predominant: 1700 };

function harness(draft = ordinary, extraOptions = {}) {
  const slots = [], effects = [], requests = [], messages = [], timers = [];
  let cursor = 0, currentDraft = structuredClone(draft), api;
  const equal = (a, b) => a?.length === b?.length && a.every((item, index) => Object.is(item, b[index]));
  const slot = () => cursor++;
  const setAssignmentDraft = update => { currentDraft = typeof update === 'function' ? update(currentDraft) : update; };
  const hook = createHook({
    useRef: value => { const i = slot(); return slots[i] ||= { current: value }; },
    useState: initial => { const i = slot(); if (!slots[i]) slots[i] = { value: initial };
      return [slots[i].value, next => { slots[i].value = typeof next === 'function' ? next(slots[i].value) : next; if (typeof next === 'string') messages.push(next); }]; },
    useCallback: (callback, deps) => { const i = slot(); if (!slots[i] || !equal(deps, slots[i].deps)) slots[i] = { value: callback, deps }; return slots[i].value; },
    useEffect: (effect, deps) => { const i = slot(); if (!slots[i] || !equal(deps, slots[i].deps)) {
      const previous = slots[i]; slots[i] = { deps, cleanup: previous?.cleanup };
      effects.push(() => { previous?.cleanup?.(); slots[i].cleanup = effect(); });
    } },
    getNeighborhoodProfile: (...args) => new Promise((resolve, reject) => requests.push({ args, resolve, reject })),
    DEFAULT_NEIGHBORHOOD_BOUNDARY_NARRATIVE: 'Default narrative', marketTrendFromChange: () => 'stable',
    retainCurrentDraftWhenUnchanged: (a, b) => JSON.stringify(a) === JSON.stringify(b) ? a : b,
    cloneEditorValue: structuredClone, hasValue: value => value !== '' && value !== null && value !== undefined,
    window: { setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout: () => {} },
  });
  let options = { accountId: 'account', assignmentFileId: 12, customMarketStudy: null,
    marketConditionsDraft: { asOfDate: '2026-09-01', periodMonths: 12, savedAt: 'version-one' },
    sectionReady: false, assignmentFilesLoading: false, assignmentFilesLoaded: true, ...extraOptions };
  const render = (updates = {}, runEffects = true) => {
    options = { ...options, ...updates }; cursor = 0;
    api = hook({ ...options, assignmentDraft: currentDraft, setAssignmentDraft });
    if (runEffects) while (effects.length) effects.shift()();
    return api;
  };
  render();
  return { requests, timers, messages, render, get draft() { return currentDraft; }, get api() { return api; },
    changeDraft: (patch, runEffects = true) => { currentDraft = { ...currentDraft, ...patch }; return render({}, runEffects); },
    queueDraft: patch => { currentDraft = { ...currentDraft, ...patch }; },
    complete: async (index = 0, value = profile) => { requests[index].resolve(value); for (let i = 0; i < 8; i++) await Promise.resolve(); },
    cancel: () => { for (const item of slots) item?.cleanup?.(); },
  };
}

test('initial broad population still fills ordinary statistics and missing road text', async () => {
  const h = harness(); const run = h.api.refreshProfile(); await h.complete(); await run;
  assert.equal(h.draft.neighborhood_house_price_predominant, 300000);
  assert.equal(h.draft.neighborhood_sale_count, 123);
  assert.equal(h.draft.neighborhood_boundary_north, 'North Road');
  assert.equal(h.draft.neighborhood_city_average_sale_price, 350000);
});

test('background and explicit refresh preserve saved pocket statistics and overrides', async () => {
  for (const automatic of [false, true]) {
    const h = harness(selected, { sectionReady: automatic });
    if (!automatic) void h.api.refreshProfile();
    await h.complete();
    for (const key of Object.keys(selected)) assert.deepEqual(h.draft[key], selected[key], key);
    assert.equal(h.draft.neighborhood_city_average_sale_price, 350000);
    assert.equal(h.draft.neighborhood_boundary_north, 'North Road');
  }
});

test('pocket selection completed while profile loads remains authoritative', async () => {
  const h = harness(); void h.api.refreshProfile(); h.changeDraft(selected);
  await h.complete();
  assert.equal(h.draft.neighborhood_house_price_predominant, 240000);
  assert.equal(h.draft.neighborhood_sale_count, 25);
  assert.deepEqual(h.draft.neighborhood_relevance_removed_pocket_ids, ['p1']);
});

test('manual boundary identity and confirmation are not rewritten by profile refresh', async () => {
  const saved = { ...ordinary, neighborhood_boundary_label: 'Reviewed neighborhood',
    neighborhood_boundary_saved_at: 'saved-time', neighborhood_boundary_confirmed: true,
    neighborhood_boundary_confirmed_at: 'confirmed-time', neighborhood_boundary_streets: 'Reviewed road description',
    neighborhood_boundary_north: 'Appraiser north', neighborhood_boundary_streets_source: 'Appraiser' };
  const h = harness(saved); void h.api.refreshProfile(); await h.complete();
  for (const key of Object.keys(saved)) assert.deepEqual(h.draft[key], saved[key], key);
});

test('late response cannot hydrate another file of the same account', async () => {
  for (const runEffects of [true, false]) {
    const h = harness(); void h.api.refreshProfile();
    h.render({ assignmentFileId: 13 }, runEffects);
    await h.complete(); assert.deepEqual(h.draft, ordinary);
  }
});

test('changed geometry or market period rejects late results, even before effect cleanup', async () => {
  for (const updates of [
    { marketConditionsDraft: { asOfDate: '2026-09-01', periodMonths: 24, savedAt: 'version-one' } },
    { marketConditionsDraft: { asOfDate: '2025-09-01', periodMonths: 12, savedAt: 'version-one' } },
    { marketConditionsDraft: { asOfDate: '2026-09-01', periodMonths: 12, savedAt: 'version-one', contextOverride: 'rural' } },
    { accountId: 'different-account' },
  ]) {
    const h = harness(); void h.api.refreshProfile(); h.render(updates, false);
    await h.complete(); assert.deepEqual(h.draft, ordinary);
  }
  const h = harness(); void h.api.refreshProfile(); h.changeDraft({ neighborhood_boundary_geometry: differentGeometry }, false);
  await h.complete(); assert.deepEqual(h.draft, { ...ordinary, neighborhood_boundary_geometry: differentGeometry });
});

test('explicit clear prevents market-geometry fallback and rejects pending results', async () => {
  const cleared = { neighborhood_boundary_geometry: null, neighborhood_boundary_source: 'appraiser_defined_area_cleared' };
  const empty = harness(cleared, { customMarketStudy: customStudy, sectionReady: true });
  void empty.api.refreshProfile(); assert.equal(empty.requests.length, 0);
  const h = harness(ordinary, { customMarketStudy: customStudy }); void h.api.refreshProfile();
  h.changeDraft(cleared, false); await h.complete(); assert.deepEqual(h.draft, cleared);
});

test('an uncleared empty file may still adopt its existing market-study area', async () => {
  const h = harness({}, { customMarketStudy: customStudy }); void h.api.refreshProfile(); await h.complete();
  assert.deepEqual(h.draft.neighborhood_boundary_geometry, geometry);
  assert.equal(h.draft.neighborhood_sale_count, 123);
});

test('cleanup cancellation prevents writes and retry scheduling', async () => {
  const h = harness(); void h.api.refreshProfile(); h.cancel(); await h.complete(); assert.deepEqual(h.draft, ordinary);
  const failed = harness(); void failed.api.refreshProfile(); failed.cancel();
  failed.requests[0].reject(new Error('late request error'));
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(failed.timers.length, 0);
});

test('each existing relevance marker protects even partial or empty selected statistics', async () => {
  for (const marker of [
    { neighborhood_boundary_engine_assessment_id: 9 }, { neighborhood_relevance_assessment_id: 12 },
    { neighborhood_relevance_generated_at: 'generated' }, { neighborhood_relevance_override_updated_at: 'edited' },
    { neighborhood_relevance_removed_pocket_ids: ['p1'] }, { neighborhood_relevance_added_pocket_ids: ['p2'] },
  ]) {
    const saved = { ...ordinary, ...marker, neighborhood_house_price_predominant: '', neighborhood_sale_count: 0 };
    const h = harness(saved); void h.api.refreshProfile(); await h.complete();
    assert.equal(h.draft.neighborhood_house_price_predominant, '');
    assert.equal(h.draft.neighborhood_sale_count, 0);
    assert.equal(h.draft.neighborhood_city_sale_count, 456);
  }
});

test('functional update rechecks queued changes that have not rendered yet', async () => {
  const h = harness(); void h.api.refreshProfile(); h.queueDraft(selected); await h.complete();
  assert.equal(h.draft.neighborhood_house_price_predominant, 240000);
  for (const patch of [
    { neighborhood_boundary_geometry: differentGeometry },
    { neighborhood_boundary_geometry: null, neighborhood_boundary_source: 'appraiser_defined_area_cleared' },
  ]) {
    const pending = harness(); void pending.api.refreshProfile(); pending.queueDraft(patch);
    await pending.complete(); assert.deepEqual(pending.draft, { ...ordinary, ...patch });
  }
});

test('the next assignment gets its own automatic request while the old response is ignored', async () => {
  const h = harness(ordinary, { sectionReady: true }); h.render({ assignmentFileId: 13 });
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].args[0].assignmentFileId, 12);
  assert.equal(h.requests[1].args[0].assignmentFileId, 13);
  await h.complete(0); assert.deepEqual(h.draft, ordinary);
  await h.complete(1); assert.equal(h.draft.neighborhood_sale_count, 123);
});

test('an old-file error does not surface or retry on the new assignment', async () => {
  const h = harness(); void h.api.refreshProfile(); h.render({ assignmentFileId: 13 }, false);
  h.requests[0].reject(new Error('wrong-file-error'));
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(h.messages.includes('wrong-file-error'), false);
  assert.equal(h.timers.length, 0);
});
