import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { automaticBoundaryRestoreState } from '../src/lib/neighborhoodBoundaryRestore.ts';

// Run only this trusted local effect body with controlled promises. This keeps
// the regression tied to the actual callback wiring without mounting the map.
// This is effect-level coverage, not a browser/render or persistence test.
const source = readFileSync(new URL('../src/components/NeighborhoodCharacteristicsContent.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('  useEffect(() => {\n    if (!accountId) return;\n    const attemptSignature =');
const end = source.indexOf('  }, [accountId, assignmentFileId]);', start);
assert.ok(start >= 0 && end > start, 'automatic boundary effect exists');
const effectBody = source.slice(start + '  useEffect(() => {'.length, end);
const effect = new Function('bindings', `const {
  accountId, assignmentFileId, automaticBoundaryAttemptRef, automaticBoundaryContextRef,
  setGeneratedBoundaryLoading, setGeneratedBoundaryMessage, getNeighborhoodBoundary,
  runNeighborhoodBoundaryGeneration, DISCOVERY_ENVELOPE_METHODOLOGY_VERSION,
  applyGeneratedBoundaryRef, automaticBoundaryRestoreState
} = bindings; ${effectBody}`);
const geometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
const suggestion = { id: 7, methodology_version: 6, evidence: { discovery: { candidate_count: 30 } }, boundary: geometry };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
function harness(current) {
  const lookup = deferred(), generated = deferred();
  const applied = [], messages = [], loading = [], calls = [];
  const context = { current };
  const cancel = effect({
    accountId: 'account', assignmentFileId: 12,
    automaticBoundaryAttemptRef: { current: '' }, automaticBoundaryContextRef: context,
    setGeneratedBoundaryLoading: value => loading.push(value),
    setGeneratedBoundaryMessage: value => messages.push(value),
    getNeighborhoodBoundary: (...args) => { calls.push(['get', ...args]); return lookup.promise; },
    runNeighborhoodBoundaryGeneration: (...args) => { calls.push(['generate', ...args]); return generated.promise; },
    DISCOVERY_ENVELOPE_METHODOLOGY_VERSION: 6,
    automaticBoundaryRestoreState,
    applyGeneratedBoundaryRef: { current: (result, options) => applied.push({ result, options }) },
  });
  return { lookup, generated, applied, messages, loading, calls, context, cancel };
}

test('automatic adoption depends on current geometry/clear state, not its source label', () => {
  for (const source of ['neighborhood_boundary_engine_v6', 'appraiser_defined_area_manual_v1', 'other_source', '']) {
    assert.equal(automaticBoundaryRestoreState({ geometry, source }).mayAdopt, false);
  }
  assert.equal(automaticBoundaryRestoreState({ geometry: null, source: '' }).mayAdopt, true);
  assert.equal(automaticBoundaryRestoreState({ geometry: null, source: 'APPRAISER_DEFINED_AREA_CLEARED' }).mayAdopt, false);
});

test('reopening a saved automatic boundary never resets its selected pockets or confirmation', async () => {
  const h = harness({ geometry, source: 'neighborhood_boundary_engine_v6', savedCustomGeometry: null });
  h.lookup.resolve(suggestion); await flush();
  assert.equal(h.applied.length, 1);
  assert.equal(h.applied[0].options.overwriteGeometry, false);
});

test('reopening saved manual or market-study geometry preserves the existing area', async () => {
  for (const current of [
    { geometry, source: 'appraiser_defined_area_manual_v1', savedCustomGeometry: null },
    { geometry: null, source: '', savedCustomGeometry: geometry },
  ]) {
    const h = harness(current); h.lookup.resolve(suggestion); await flush();
    assert.equal(h.applied[0].options.overwriteGeometry, false);
  }
});

test('a genuinely empty, uncleared file can adopt its first suggestion', async () => {
  const h = harness({ geometry: null, source: '', savedCustomGeometry: null });
  h.lookup.resolve(null); await flush();
  assert.deepEqual(h.calls, [['get', 'account', 12], ['generate', 'account', { assignmentFileId: 12 }]]);
  h.generated.resolve(suggestion); await flush();
  assert.equal(h.applied[0].options.overwriteGeometry, true);
});

test('an intentionally cleared area stays empty even if an older market geometry exists', async () => {
  const h = harness({ geometry: null, source: 'appraiser_defined_area_cleared', savedCustomGeometry: geometry });
  h.lookup.resolve(suggestion); await flush();
  assert.equal(h.applied[0].options.overwriteGeometry, false);
  assert.equal(h.calls.length, 1);
});

test('edits and clearing while a suggestion loads are checked at completion', async () => {
  for (const current of [
    { geometry, source: 'appraiser_defined_area_manual_v1', savedCustomGeometry: null },
    { geometry: null, source: 'appraiser_defined_area_cleared', savedCustomGeometry: null },
  ]) {
    const h = harness({ geometry: null, source: '', savedCustomGeometry: null });
    h.context.current = current;
    h.lookup.resolve(suggestion); await flush();
    assert.equal(h.applied[0].options.overwriteGeometry, false);
  }
});

test('drawing or clearing while generation is pending is also preserved', async () => {
  for (const current of [
    { geometry, source: 'appraiser_defined_area_manual_v1', savedCustomGeometry: null },
    { geometry: null, source: 'appraiser_defined_area_cleared', savedCustomGeometry: null },
    { geometry: null, source: '', savedCustomGeometry: geometry },
  ]) {
    const h = harness({ geometry: null, source: '', savedCustomGeometry: null });
    h.lookup.resolve(null); await flush();
    h.context.current = current;
    h.generated.resolve(suggestion); await flush();
    assert.equal(h.applied[0].options.overwriteGeometry, false);
  }
});

test('clearing during lookup does not start automatic generation afterward', async () => {
  const h = harness({ geometry: null, source: '', savedCustomGeometry: null });
  h.context.current = { geometry: null, source: 'appraiser_defined_area_cleared', savedCustomGeometry: null };
  h.lookup.resolve(null); await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.applied.length, 0);
  assert.match(h.messages.at(-1), /intentionally cleared/);
});

test('a methodology upgrade is available for review but does not replace the saved selection', async () => {
  const h = harness({ geometry, source: 'neighborhood_boundary_engine_v5', savedCustomGeometry: null });
  h.lookup.resolve({ ...suggestion, methodology_version: 5 }); await flush();
  assert.equal(h.calls.at(-1)[0], 'generate');
  h.generated.resolve({ ...suggestion, id: 8 }); await flush();
  assert.equal(h.applied[0].result.id, 8);
  assert.equal(h.applied[0].options.overwriteGeometry, false);
});

test('cancellation after switching assignment prevents stale UI application', async () => {
  const h = harness({ geometry: null, source: '', savedCustomGeometry: null });
  h.cancel(); h.lookup.resolve(suggestion); await flush();
  assert.equal(h.applied.length, 0);
  assert.deepEqual(h.loading, [true]);
});

test('cancellation prevents follow-on generation and ignores already-pending generation', async () => {
  const h = harness({ geometry: null, source: '', savedCustomGeometry: null });
  h.cancel(); h.lookup.resolve(null); await flush();
  assert.equal(h.calls.length, 1);
  const pending = harness({ geometry: null, source: '', savedCustomGeometry: null });
  pending.lookup.resolve(null); await flush();
  pending.cancel(); pending.generated.resolve(suggestion); await flush();
  assert.equal(pending.applied.length, 0);
  assert.deepEqual(pending.loading, [true]);
});

test('explicit Reset to Suggested Area still deliberately adopts the suggestion', () => {
  const resetStart = source.indexOf('    if (origin === "automatic" && generatedBoundary) {');
  const resetEnd = source.indexOf('\n    const now = new Date().toISOString();', resetStart);
  assert.ok(resetStart >= 0 && resetEnd > resetStart);
  const reset = new Function('origin', 'generatedBoundary', 'applyGeneratedBoundary', source.slice(resetStart, resetEnd));
  const calls = [];
  reset('automatic', suggestion, (result, options) => calls.push({ result, options }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].result, suggestion);
  assert.equal(calls[0].options.overwriteGeometry, true);
});
