import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { marketAreaOriginFromSource, resolveInitialMarketAreaGeometry } from '../src/lib/marketAreaGeometry.ts';

// Execute the actual trusted local handler body with controlled callbacks. This
// verifies origin and side-effect wiring, not browser interaction or saved-source
// authority. Geometry validation/admission remains with its existing owner.
const source = readFileSync(new URL('../src/components/NeighborhoodCharacteristicsContent.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('  const handleCustomGeometryChange = useCallback((');
const bodyStart = source.indexOf('  ) => {', start) + '  ) => {'.length;
const end = source.indexOf('\n  }, [\n    applyGeneratedBoundary,', bodyStart);
assert.ok(start >= 0 && bodyStart > start && end > bodyStart, 'actual boundary-change handler remains present');
const handler = new Function('bindings', 'geometry', 'origin', `const {
  generatedBoundary, applyGeneratedBoundary, onAssignmentChange, setGeneratedBoundaryMessage
} = bindings; ${source.slice(bodyStart, end)}`);
const geometry = { type: 'Polygon', coordinates: [[[-96.7, 32.8], [-96.69, 32.8], [-96.69, 32.81], [-96.7, 32.8]]] };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
freeze(geometry);
const suggestion = freeze({ id: 19, methodology_version: 6, boundary: geometry, generated_at: '2026-09-09T10:00:00.000Z' });
const prefix = 'neighborhood_boundary_';
const emptyFields = ['confirmed_at', 'streets', 'north', 'east', 'south', 'west', 'streets_source', 'streets_retrieved_at'];
const expectedKeys = ['label', 'source', 'geometry', 'saved_at', 'confirmed', ...emptyFields].map(key => prefix + key)
  .concat('neighborhood_land_use_boundary_signature').sort();
function harness(generatedBoundary = null) {
  const writes = [], applied = [], messages = [];
  return { writes, applied, messages,
    change(value, origin) { handler({ generatedBoundary, applyGeneratedBoundary: (value, options) => applied.push({ value, options }),
      onAssignmentChange: (key, value) => writes.push([key, value]), setGeneratedBoundaryMessage: value => messages.push(value) }, value, origin); },
    latest() { return Object.fromEntries(writes); },
  };
}
function resetEffects(h) {
  const patch = h.latest();
  assert.deepEqual(h.writes.map(([key]) => key).sort(), expectedKeys);
  assert.equal(patch.neighborhood_boundary_confirmed, false);
  for (const key of emptyFields) assert.equal(patch[prefix + key], '', key);
  assert.equal(patch.neighborhood_land_use_boundary_signature, '');
  assert.match(patch.neighborhood_boundary_saved_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(h.applied.length, 0); assert.equal(h.messages.length, 1);
}

test('fresh manual drawing alone receives the exact v2 marker without changing supplied geometry', () => {
  for (const generated of [null, suggestion]) {
    const h = harness(generated); h.change(geometry, 'appraiser'); resetEffects(h);
    const patch = h.latest();
    assert.equal(patch.neighborhood_boundary_source, 'appraiser_defined_area_manual_v2');
    assert.equal(patch.neighborhood_boundary_geometry, geometry);
    assert.equal(patch.neighborhood_boundary_label, 'Appraiser-edited market area');
    assert.match(h.messages[0], /Appraiser narrative boundary recorded/);
  }
});

test('automatic reset without a generated assessment keeps the exact suggested shape explicitly automatic and unverified', () => {
  const before = JSON.stringify(geometry), h = harness(); h.change(geometry, 'automatic'); resetEffects(h);
  const patch = h.latest();
  assert.equal(patch.neighborhood_boundary_source, 'neighborhood_boundary_automatic_unverified_v1');
  assert.equal(patch.neighborhood_boundary_geometry, geometry);
  assert.equal(JSON.stringify(geometry), before);
  assert.match(patch.neighborhood_boundary_label, /Suggested.*unverified/);
  assert.match(h.messages[0], /automatic and unverified/);
  assert.doesNotMatch(h.messages[0], /Appraiser narrative boundary recorded/);
  assert.equal(marketAreaOriginFromSource(patch.neighborhood_boundary_source, geometry), 'automatic');
});

test('clear always stays cleared/null and does not become fresh manual evidence', () => {
  for (const generated of [null, suggestion]) for (const supplied of [null, geometry]) {
    const h = harness(generated); h.change(supplied, 'cleared'); resetEffects(h);
    const patch = h.latest();
    assert.equal(patch.neighborhood_boundary_source, 'appraiser_defined_area_cleared');
    assert.equal(patch.neighborhood_boundary_geometry, null);
    assert.match(h.messages[0], /boundary was cleared/);
  }
});

test('reachable automatic -> clear -> reset with no generation record cannot promote retained suggested geometry to manual', () => {
  const h = harness();
  h.change(geometry, 'automatic');
  const availableSuggestedGeometry = h.latest().neighborhood_boundary_geometry;
  h.change(null, 'cleared');
  assert.equal(h.latest().neighborhood_boundary_geometry, null);
  h.change(availableSuggestedGeometry, 'automatic');
  assert.equal(h.latest().neighborhood_boundary_source, 'neighborhood_boundary_automatic_unverified_v1');
  assert.equal(h.latest().neighborhood_boundary_geometry, geometry);
  assert.equal(h.latest().neighborhood_boundary_confirmed, false);
  assert.equal(h.writes.filter(([key, value]) => key === 'neighborhood_boundary_source' && value.includes('manual')).length, 0);
  assert.equal(h.applied.length, 0);
});

test('automatic reset with generated assessment preserves existing adoption callback and its side effects exclusively', () => {
  const h = harness(suggestion); h.change(null, 'automatic');
  assert.deepEqual(h.applied, [{ value: suggestion, options: { overwriteGeometry: true,
    message: 'The automatically suggested neighborhood was restored and is ready for appraisal review.' } }]);
  assert.deepEqual(h.writes, []); assert.deepEqual(h.messages, []);
});

test('legacy manual-v1 polygons remain viewable without relabeling them as freshly drawn v2', () => {
  assert.equal(resolveInitialMarketAreaGeometry({ assignmentGeometry: geometry }), geometry);
  assert.equal(marketAreaOriginFromSource('appraiser_defined_area_manual_v1', geometry), 'appraiser');
  assert.ok(source.includes('initialCustomGeometry={assignmentDraft.neighborhood_boundary_geometry}'));
  const h = harness();
  // Reopening/rendering never invokes this explicit edit/reset handler.
  assert.deepEqual(h.writes, []);
});
