import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { buildCachedSourceCaptures, buildFrozenCadSourceCaptures, CACHED_SOURCE_CAPTURE_LIMITS,
  DENSE_CAD_SOURCE_CAPTURE_LIMITS } from '../src/services/neighborhoodAssessment/cachedSourceCaptures.js';
import { canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { ASSESSMENT_SCOPE } from './fixtures/neighborhoodAssessmentFixture.js';

const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function input(count = 1001, content = 'geometry-observation') {
  const records = Array.from({ length: count }, (_, index) => ({ record_id: `parcel:${count - index}`,
    data: { original: `${index}:${content}`, nil: null, zero: 0, values: [false, 'é', '𝛼'], year: 1951 + index % 56 } }));
  return { scope: { ...ASSESSMENT_SCOPE }, captures: [{
    upstream: { id: 'synthetic-cad', key: 'parcels', state: records.length ? 'populated' : 'present_empty',
      complete: true, revision: 'synthetic-v1', content_sha256: 'a'.repeat(64), captured_at: '2026-09-10T00:00:00.000Z',
      visibility: 'assignment_private', scope: { ...ASSESSMENT_SCOPE }, row_count: records.length },
    metadata: { id: 'synthetic-cad', provider: 'synthetic', revision: 'v1', valid_from: null, valid_to: null,
      observed_at: '2026-09-10T00:00:00.000Z', historical_availability: 'unknown' },
    projection: { id: 'synthetic', revision: 'v1', definition: { role: 'parcels', complete_roster: true },
      input_row_count: records.length, output_record_count: records.length, complete: true }, records,
  }] };
}
for (const count of [0, 1, 125, 1000, 1001, 2400]) test(`batched construction retains exact prior canonical output for ${count} records`, async () => {
  const source = freeze(input(count));
  const expected = buildCachedSourceCaptures(source), actual = await buildFrozenCadSourceCaptures(source);
  assert.deepEqual(actual, expected);
  assert.equal(canonicalAssessmentJson(actual.source_snapshots), canonicalAssessmentJson(expected.source_snapshots));
  assert.ok(Object.isFrozen(actual));
  if (count) {
    const record = actual.sources[0].payload.records[0];
    const original = source.captures[0].records.find(row => row.record_id === record.record_id);
    assert.equal(record.data, original.data, 'immutable large wrappers are shared, not duplicated');
    assert.notEqual(expected.sources[0].payload.records[0].data, original.data, 'default builder still detaches caller inputs');
  }
});
test('frozen wrapper with mutable nested values is refused before async construction', async () => {
  const source = input(1); Object.freeze(source);
  await assert.rejects(buildFrozenCadSourceCaptures(source), /frozen_input_required/);
});
test('accessors in a frozen graph are refused without running them', async () => {
  const source = input(1); let called = false;
  Object.defineProperty(source.captures[0].records[0].data, 'bad', { enumerable: true, get() { called = true; return 1; } });
  // Freeze descriptors without reading the accessor.
  const protect = value => { if (value && typeof value === 'object') {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if ('value' in descriptor) protect(descriptor.value);
    Object.freeze(value);
  } };
  protect(source);
  await assert.rejects(buildFrozenCadSourceCaptures(source), /frozen_input_required/); assert.equal(called, false);
});
test('other request work runs between batches and cancellation returns no partial sources', async () => {
  const source = freeze(input(2400)); let work = false;
  const progress = tick().then(() => { work = true; });
  await buildFrozenCadSourceCaptures(source); await progress; assert.equal(work, true);
  const controller = new AbortController();
  const abort = tick().then(() => controller.abort());
  await assert.rejects(buildFrozenCadSourceCaptures(source, { check: () => controller.signal.throwIfAborted() }), { name: 'AbortError' });
  await abort;
});
test('old ceilings and per-row/per-chunk guards remain unchanged', async () => {
  assert.equal(CACHED_SOURCE_CAPTURE_LIMITS.input_bytes, 32_000_000);
  assert.equal(CACHED_SOURCE_CAPTURE_LIMITS.input_records, 100_000);
  for (const key of ['records_per_chunk', 'payload_nodes', 'payload_bytes', 'envelope_bytes', 'output_captures']) {
    assert.equal(DENSE_CAD_SOURCE_CAPTURE_LIMITS[key], CACHED_SOURCE_CAPTURE_LIMITS[key]);
  }
  await assert.rejects(buildFrozenCadSourceCaptures(freeze(input(1, 'x'.repeat(1_500_001)))), { code: 'NEIGHBORHOOD_CAPTURE_LIMIT' });
});
test('unknown/truncated evidence stays unavailable, including after a batch yield', async () => {
  const source = input(200); source.captures[0].upstream.complete = false;
  const result = await buildFrozenCadSourceCaptures(freeze(source));
  assert.equal(result.status, 'incomplete'); assert.deepEqual(result.sources, []);
});
