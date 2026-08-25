import assert from "node:assert/strict";
import test from "node:test";

import { recoverStaleUadArtifactGenerations } from "../src/modules/uad/uadArtifactRecovery.js";

test("startup recovery marks only stale generating artifacts retryable", async () => {
  const calls = [];
  const warnings = [];
  const result = await recoverStaleUadArtifactGenerations({
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount: 2, rows: [{ id: "one" }, { id: "two" }] };
    },
  }, {
    staleAfterMinutes: 10,
    logger: { warn(message) { warnings.push(message); } },
  });
  assert.deepEqual(result, { recovered: 2, stale_after_minutes: 10 });
  assert.deepEqual(calls[0].params, [10]);
  assert.match(calls[0].sql, /generation_status = 'generating'/);
  assert.match(calls[0].sql, /generation_started_at/);
  assert.match(calls[0].sql, /uad_artifact_generation_interrupted/);
  assert.equal(warnings.length, 1);
});

test("startup recovery has a five-minute minimum to avoid taking over active work", async () => {
  let params;
  const result = await recoverStaleUadArtifactGenerations({
    async query(_sql, values) {
      params = values;
      return { rowCount: 0, rows: [] };
    },
  }, { staleAfterMinutes: 1, logger: {} });
  assert.deepEqual(params, [5]);
  assert.equal(result.recovered, 0);
});
