import assert from 'node:assert/strict';
import test from 'node:test';
import { runNeighborhoodParcelPrecompute, NEIGHBORHOOD_PRECOMPUTE_SQL } from
  '../src/services/neighborhoodAssessment/neighborhoodParcelPrecompute.js';

function fixture({ locked = true, batches = [], removed = [0], failBatch = false } = {}) {
  const calls = [];
  let batch = 0, prune = 0, released = false;
  const client = {
    async query(input, values) {
      const text = typeof input === 'string' ? input : input.text;
      calls.push({ text, values: values ?? input.values });
      if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked }] };
      if (text === NEIGHBORHOOD_PRECOMPUTE_SQL.batch) {
        if (failBatch) throw Object.assign(new Error('database failure'), { code: '57014' });
        return { rows: [batches[batch++] ?? { last_object_id: '2', scanned: 0, refreshed: 0 }] };
      }
      if (text === NEIGHBORHOOD_PRECOMPUTE_SQL.prune) return { rows: [{ removed: removed[prune++] ?? 0 }] };
      return { rows: [] };
    },
    release() { released = true; },
  };
  return { pool: { async connect() { return client; } }, calls, get released() { return released; } };
}

test('precomputes changed CAD geometry in bounded batches and marks completion', async () => {
  const f = fixture({ batches: [
    { last_object_id: '2', scanned: 2, refreshed: 2 },
    { last_object_id: '3', scanned: 1, refreshed: 0 },
    { last_object_id: '3', scanned: 0, refreshed: 0 },
  ], removed: [1] });
  const result = await runNeighborhoodParcelPrecompute(f.pool, { batchSize: 2, logger: { info() {} } });
  assert.deepEqual(result, { status: 'complete', scanned: 3, refreshed: 2, removed: 1 });
  assert.deepEqual(f.calls.filter(call => call.text === NEIGHBORHOOD_PRECOMPUTE_SQL.batch)
    .map(call => call.values), [['-9223372036854775808', 2], ['2', 2], ['3', 2]]);
  assert.ok(f.calls.some(call => call.text.includes("SET status='complete'")));
  assert.ok(f.calls.some(call => call.text.includes('pg_advisory_unlock')));
  assert.equal(f.released, true);
});

test('overlapping worker exits without touching state or CAD', async () => {
  const f = fixture({ locked: false });
  const result = await runNeighborhoodParcelPrecompute(f.pool);
  assert.equal(result.status, 'already_running');
  assert.equal(f.calls.length, 1);
  assert.equal(f.released, true);
});

test('failure records bounded code and always unlocks its session', async () => {
  const f = fixture({ failBatch: true });
  await assert.rejects(runNeighborhoodParcelPrecompute(f.pool), { code: '57014' });
  assert.ok(f.calls.some(call => call.text.includes("SET status='failed'") && call.values[2] === '57014'));
  assert.ok(f.calls.some(call => call.text.includes('pg_advisory_unlock')));
  assert.equal(f.released, true);
});

test('rejects unsafe budgets before acquiring a connection', async () => {
  const f = fixture();
  await assert.rejects(runNeighborhoodParcelPrecompute(f.pool, { batchSize: 100000 }), /invalid_neighborhood_precompute:batch_size/);
  await assert.rejects(runNeighborhoodParcelPrecompute(f.pool, { maximumRuntimeMinutes: 0 }), /invalid_neighborhood_precompute:maximum_runtime_minutes/);
  assert.equal(f.calls.length, 0);
});

test('cache is a guarded performance hint, not a replacement CAD evidence source', () => {
  const sql = NEIGHBORHOOD_PRECOMPUTE_SQL.batch;
  assert.match(sql, /FROM gis\.dcad_parcels parcel/);
  assert.match(sql, /parcel\.xmin::text AS row_xmin/);
  assert.match(sql, /ST_AsEWKB\(geom\) AS ewkb/);
  assert.match(sql, /encode\(sha256\(ewkb\), 'hex'\)/);
  assert.doesNotMatch(sql, /core\.sales|raw_payload|appraisal_cases/i);
});
