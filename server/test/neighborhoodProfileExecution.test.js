import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  compactNeighborhoodProfileResponse,
  createNeighborhoodProfileExecutionGate,
  neighborhoodProfileRequestKey,
} from "../src/services/neighborhoodProfileExecution.js";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("identical neighborhood profile requests share one database operation", async () => {
  const gate = createNeighborhoodProfileExecutionGate({ maxConcurrent: 2, maxQueued: 2 });
  const work = deferred();
  let executions = 0;
  const operation = () => {
    executions += 1;
    return work.promise;
  };
  const first = gate.run("same-request", operation);
  const duplicate = gate.run("same-request", operation);

  assert.equal(first, duplicate);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executions, 1);
  assert.equal(gate.snapshot().active, 1);
  work.resolve({ ok: true });
  assert.deepEqual(await duplicate, { ok: true });
});

test("neighborhood profile work cannot exhaust the shared database pool", async () => {
  const gate = createNeighborhoodProfileExecutionGate({ maxConcurrent: 2, maxQueued: 1 });
  const firstWork = deferred();
  const secondWork = deferred();
  const first = gate.run("first", () => firstWork.promise);
  const second = gate.run("second", () => secondWork.promise);
  const queued = gate.run("queued", async () => "queued");

  await assert.rejects(
    () => gate.run("excess", async () => "excess"),
    /neighborhood_profile_capacity_exceeded/,
  );
  assert.deepEqual(gate.snapshot(), {
    active: 2,
    queued: 1,
    in_flight: 3,
    cached: 0,
    cache_hits: 0,
    max_concurrent: 2,
    max_queued: 1,
    completed: 0,
    failed: 0,
    saturated: true,
  });

  firstWork.resolve("first");
  assert.equal(await first, "first");
  assert.equal(await queued, "queued");
  secondWork.resolve("second");
  assert.equal(await second, "second");
});

test("completed neighborhood profiles are reused briefly but explicit refresh bypasses the cache", async () => {
  const gate = createNeighborhoodProfileExecutionGate({
    cacheTtlMs: 60_000,
    maxCacheEntries: 2,
  });
  let executions = 0;
  const operation = async () => ({ revision: ++executions });

  assert.deepEqual(await gate.run("same-request", operation), { revision: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await gate.run("same-request", operation), { revision: 1 });
  assert.equal(executions, 1);
  assert.equal(gate.snapshot().cache_hits, 1);

  assert.deepEqual(
    await gate.run("same-request", operation, { allowCached: false }),
    { revision: 2 },
  );
  assert.equal(executions, 2);
});

test("property-report neighborhood responses omit unused mapped-sale and chart payloads", () => {
  const compact = compactNeighborhoodProfileResponse({
    subject: { account_id: "123" },
    analyses: [{
      market: { key: "custom" },
      summary: { median_sale_price: 250_000 },
      series: { monthly: [{ sale_count: 1 }] },
      map_sales: [{ sale_id: 1 }],
    }],
    recommendation: { conclusion: "stable" },
  });

  assert.deepEqual(compact.analyses, [{
    market: { key: "custom" },
    summary: { median_sale_price: 250_000 },
  }]);
  assert.equal(compact.subject.account_id, "123");
});

test("neighborhood profile request keys cover every analysis input", () => {
  const base = {
    subjectAccountId: " 123 ",
    asOfDate: "2026-08-29",
    periodMonths: 12,
    customGeometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [0, 0]]] },
    marketContextOverride: { city: "Dallas" },
  };
  assert.equal(neighborhoodProfileRequestKey(base), neighborhoodProfileRequestKey({
    ...base,
    subjectAccountId: "123",
  }));
  assert.notEqual(neighborhoodProfileRequestKey(base), neighborhoodProfileRequestKey({
    ...base,
    periodMonths: 24,
  }));
});

test("the neighborhood profile route is protected by the execution gate", () => {
  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const route = source.slice(
    source.indexOf('app.post("/api/sales/neighborhood-profile"'),
    source.indexOf('app.post("/api/sales/neighborhood-land-use"'),
  );
  assert.match(route, /runNeighborhoodProfileOperation/);
  assert.match(route, /compactNeighborhoodProfileResponse/);
  assert.match(route, /allowCached: !request\.forceRefresh/);
  assert.match(route, /Retry-After/);
  assert.match(route, /status\(503\)/);
});
