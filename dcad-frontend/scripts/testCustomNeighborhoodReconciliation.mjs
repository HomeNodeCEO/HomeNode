import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { applyCustomAppraisalRemoteConflicts, reconcileCustomAppraisalDraft } from '../src/lib/customAppraisalAutosave.ts';
import { assignmentDraftFromDetail } from '../src/lib/propertyReportAssignment.ts';

const base = {
  neighborhood_boundary_geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 1], [0, 0]]] },
  neighborhood_boundary_confirmed: true,
  neighborhood_relevance_removed_pocket_ids: [],
  neighborhood_sale_count: 12,
  neighborhood_house_price_predominant: 240000,
  neighborhood_all_gla_predominant: 1500,
  neighborhood_value_conclusion: 'Appraiser explanation for the original population',
  neighborhood_value_conclusion_signature: 'original population signature',
  client_name: 'Client', neighborhood_city_sale_count: 100, neighborhood_market_trend: 'stable',
};
const groupKeys = Object.keys(base).filter(key => !['client_name', 'neighborhood_city_sale_count', 'neighborhood_market_trend'].includes(key));

test('disjoint edits to area and statistics require one complete neighborhood decision', () => {
  const local = { ...base, neighborhood_relevance_removed_pocket_ids: ['pocket-1'], client_name: 'Local client' };
  const remote = { ...base, neighborhood_sale_count: 20, neighborhood_house_price_predominant: 300000,
    neighborhood_value_conclusion: 'Different saved population', neighborhood_city_sale_count: 110 };
  const before = structuredClone({ base, local, remote });
  const result = reconcileCustomAppraisalDraft(base, local, remote);
  assert.deepEqual(new Set(result.conflictKeys), new Set(groupKeys));
  for (const key of groupKeys) assert.deepEqual(result.rebased[key], local[key], key);
  assert.equal(result.rebased.client_name, 'Local client');
  assert.equal(result.rebased.neighborhood_city_sale_count, 110);
  assert.deepEqual(result.localChangedKeys, ['neighborhood_relevance_removed_pocket_ids', 'client_name']);
  assert.deepEqual({ base, local, remote }, before, 'inputs are not mutated');
});

test('one-sided neighborhood changes retain the whole selected group without a conflict', () => {
  const changed = { ...base, neighborhood_sale_count: 0, neighborhood_boundary_confirmed: false,
    neighborhood_value_conclusion: '', neighborhood_all_gla_predominant: null };
  for (const [local, remote] of [[changed, { ...base, client_name: 'Remote' }], [{ ...base, client_name: 'Local' }, changed]]) {
    const result = reconcileCustomAppraisalDraft(base, local, remote);
    assert.deepEqual(result.conflictKeys, []);
    for (const key of groupKeys) assert.deepEqual(result.rebased[key], changed[key], key);
  }
});

test('identical concurrent neighborhood changes need no appraiser decision', () => {
  const local = { ...base, neighborhood_sale_count: 18 };
  const remote = { ...structuredClone(local), client_name: 'Remote client' };
  const result = reconcileCustomAppraisalDraft(base, local, remote);
  assert.deepEqual(result.conflictKeys, []);
  assert.deepEqual(result.rebased, remote);
});

test('a partially overlapping group change still conflicts when its other members differ', () => {
  const local = { ...base, neighborhood_sale_count: 18 };
  const remote = { ...base, neighborhood_sale_count: 18, neighborhood_all_gla_predominant: 2000 };
  const result = reconcileCustomAppraisalDraft(base, local, remote);
  assert.deepEqual(new Set(result.conflictKeys), new Set(groupKeys));
  assert.equal(result.rebased.neighborhood_all_gla_predominant, 1500);
});

test('all normalized boundary, selection, population, and value companions conflict together', () => {
  const normalized = assignmentDraftFromDetail();
  const result = reconcileCustomAppraisalDraft(normalized,
    { ...normalized, neighborhood_boundary_confirmed: true },
    { ...normalized, neighborhood_sale_count: 25 });
  const expected = Object.keys(normalized).filter(key =>
    /^neighborhood_(boundary_|relevance_|value_)/u.test(key) ||
    /^neighborhood_(?:all_)?(?:house_price|ppsf|age|gla)_(?:low|high|predominant)$/u.test(key) ||
    /^neighborhood_all_(?:value|ppsf|age|gla)_count$/u.test(key) ||
    ['neighborhood_sale_count', 'neighborhood_all_property_count'].includes(key));
  assert.equal(expected.length, 69, 'review new normalized companion fields explicitly');
  assert.deepEqual(new Set(result.conflictKeys), new Set(expected));
  assert.equal(result.conflictKeys.includes('neighborhood_market_trend'), false);
});

test('missing local group fields cannot fall back to another saved population', () => {
  const local = { neighborhood_sale_count: 0, client_name: 'Local' };
  const remote = { ...base, neighborhood_all_value_count: 8 };
  const result = reconcileCustomAppraisalDraft(base, local, remote);
  assert.equal(Object.hasOwn(result.rebased, 'neighborhood_all_value_count'), false);
  assert.equal(Object.hasOwn(result.rebased, 'neighborhood_boundary_geometry'), false);
  assert.equal(result.rebased.neighborhood_sale_count, 0);
  assert.equal(result.conflictKeys.includes('neighborhood_all_value_count'), true);
});

test('independent market, land-use, and client conflicts retain existing field-level handling', () => {
  const current = { ...base, neighborhood_land_use_boundary_signature: 'land-area', subject_concluded_value: 280000 };
  const local = { ...current, neighborhood_market_trend: 'increasing', client_name: 'Local' };
  const remote = { ...current, neighborhood_market_trend: 'declining', client_name: 'Remote',
    neighborhood_land_use_boundary_signature: 'new-land-area', subject_concluded_value: 290000 };
  const result = reconcileCustomAppraisalDraft(current, local, remote);
  assert.deepEqual(new Set(result.conflictKeys), new Set(['neighborhood_market_trend', 'client_name']));
  assert.equal(result.rebased.neighborhood_land_use_boundary_signature, 'new-land-area');
  assert.equal(result.rebased.subject_concluded_value, 290000);
});

test('document approval cannot queue autosave while a reconciliation conflict is unresolved', () => {
  const source = readFileSync(new URL('../src/pages/PropertyReport.tsx', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('const applyConfirmedDocumentApplication ='), source.indexOf('const importCustomMarketArea ='));
  assert.match(body, /setAssignmentAutosaveState\(reconciliation\.conflictKeys\.length\s*\?\s*"conflict"\s*:\s*reconciliation\.localChangedKeys\.length\s*\?\s*"pending"\s*:\s*"saved"\)/u);
});

test('Keep Mine retains the local group; Use Newer Saved Values replaces it as a whole', () => {
  const local = { ...base, neighborhood_relevance_removed_pocket_ids: ['pocket-1'], client_name: 'Local client' };
  const remote = { ...base, neighborhood_sale_count: 0, neighborhood_value_conclusion: 'Reviewed remote explanation',
    neighborhood_city_sale_count: 110 };
  const result = reconcileCustomAppraisalDraft(base, local, remote);
  const keepMine = structuredClone(result.rebased);
  const keepRemote = applyCustomAppraisalRemoteConflicts(result.rebased, remote, result.conflictKeys);
  for (const key of groupKeys) {
    assert.deepEqual(keepMine[key], local[key], `Keep Mine: ${key}`);
    assert.deepEqual(keepRemote[key], remote[key], `Use Newer: ${key}`);
  }
  assert.equal(keepRemote.client_name, 'Local client');
  assert.equal(keepRemote.neighborhood_city_sale_count, 110);
  assert.deepEqual(result.rebased, keepMine, 'conflict resolution does not mutate the displayed draft');
});

test('remote resolution deletes absent members and preserves explicit empty, false, null, and zero values', () => {
  const current = { ...base, neighborhood_all_value_count: 15 };
  const remote = { neighborhood_sale_count: 0, neighborhood_boundary_confirmed: false,
    neighborhood_value_conclusion: '', neighborhood_boundary_geometry: null, neighborhood_value_source: undefined };
  const keys = [...groupKeys, 'neighborhood_all_value_count', 'neighborhood_value_source'];
  const restored = applyCustomAppraisalRemoteConflicts(current, remote, keys);
  assert.equal(Object.hasOwn(restored, 'neighborhood_all_value_count'), false);
  assert.equal(Object.hasOwn(restored, 'neighborhood_value_conclusion_signature'), false);
  for (const key of Object.keys(remote)) {
    assert.equal(Object.hasOwn(restored, key), true);
    assert.deepEqual(restored[key], remote[key], key);
  }
  assert.equal(restored.client_name, current.client_name);
});

test('the report uses the tested remote-resolution helper and avoids a misleading edited-field count', () => {
  const source = readFileSync(new URL('../src/pages/PropertyReport.tsx', import.meta.url), 'utf8');
  assert.match(source, /applyCustomAppraisalRemoteConflicts\(assignmentDraftRef\.current, remoteDraft, assignmentConflictKeys\)/u);
  assert.match(source, /Neighborhood selections and statistics stay together\./u);
  assert.doesNotMatch(source, /changed \{assignmentConflictKeys\.length\} of the same report/u);
});

test('an unrelated document update cannot silently resolve an outstanding neighborhood conflict', () => {
  const local = { ...base, neighborhood_relevance_removed_pocket_ids: ['pocket-1'] };
  const remote = { ...base, neighborhood_sale_count: 20 };
  const first = reconcileCustomAppraisalDraft(base, local, remote);
  const approved = { ...remote, client_name: 'Approved document client' };
  const second = reconcileCustomAppraisalDraft(remote, first.rebased, approved, first.conflictKeys);
  assert.deepEqual(new Set(second.conflictKeys), new Set(first.conflictKeys));
  for (const key of groupKeys) assert.deepEqual(second.rebased[key], local[key], key);
  assert.equal(second.rebased.client_name, 'Approved document client');
  const resolved = applyCustomAppraisalRemoteConflicts(second.rebased, approved, second.conflictKeys);
  for (const key of groupKeys) assert.deepEqual(resolved[key], approved[key], key);
});

test('pending ordinary field choices also survive an unrelated document update', () => {
  const original = { occupancy: 'owner', client_name: 'Client' };
  const remote = { ...original, occupancy: 'vacant' };
  const first = reconcileCustomAppraisalDraft(original, { ...original, occupancy: 'tenant' }, remote);
  const next = reconcileCustomAppraisalDraft(remote, first.rebased,
    { ...remote, client_name: 'Approved client' }, first.conflictKeys);
  assert.deepEqual(next.conflictKeys, ['occupancy']);
  assert.equal(next.rebased.occupancy, 'tenant');
  assert.equal(next.rebased.client_name, 'Approved client');
});

test('pending-choice state is visible to asynchronous approval before the next render', () => {
  // Execute the trusted local hook body with controlled React primitives. The
  // state setter is deliberately queued, so only the synchronous ref is current.
  const source = stripTypeScriptTypes(readFileSync(new URL('../src/hooks/useAssignmentConflictKeys.ts', import.meta.url), 'utf8'));
  const body = source.slice(source.indexOf('export function')).replace('export function', 'function');
  const load = new Function('useState', 'useRef', 'useCallback', `${body}; return useAssignmentConflictKeys;`);
  const queued = [];
  const hook = load(initial => [initial, value => queued.push(value)], initial => ({ current: initial }), callback => callback);
  const [displayed, setKeys, ref] = hook();
  const pending = ['neighborhood_sale_count'];
  setKeys(pending);
  assert.deepEqual(displayed, [], 'React has not rendered the new state yet');
  assert.equal(ref.current, pending);
  setKeys([]);
  assert.deepEqual(ref.current, [], 'explicit resolution or file reset clears it synchronously');
  assert.deepEqual(queued, [pending, []]);
  const page = readFileSync(new URL('../src/pages/PropertyReport.tsx', import.meta.url), 'utf8');
  const approval = page.slice(page.indexOf('const applyConfirmedDocumentApplication ='), page.indexOf('const importCustomMarketArea ='));
  assert.match(approval, /remoteDraft,\s*assignmentConflictKeysRef\.current,/u);
});
