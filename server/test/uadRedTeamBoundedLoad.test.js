import assert from "node:assert/strict";
import test from "node:test";

import { runUadRedTeamBoundedLoad } from "../src/modules/uad/uadRedTeamBoundedLoad.js";

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

function loadFetch({ unexpectedStatus = null } = {}) {
  let phase = "load";
  let capabilities = 0;
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/api/uad/readiness") return json({ ok: true });
    capabilities += 1;
    if (unexpectedStatus && capabilities === 3) return json({ error: "unexpected" }, unexpectedStatus);
    if (phase === "recovered") {
      return json(
        { specification_release_key: "uad-3.6-test" },
        200,
        { ratelimit: "\"10-in-1sec\"; r=9; t=1", "ratelimit-policy": "\"10-in-1sec\"; q=10; w=1" },
      );
    }
    if (capabilities <= 10) {
      return json(
        { specification_release_key: "uad-3.6-test" },
        200,
        { ratelimit: `\"10-in-1sec\"; r=${10 - capabilities}; t=1`, "ratelimit-policy": "\"10-in-1sec\"; q=10; w=1" },
      );
    }
    return json(
      { error: "rate_limit_exceeded" },
      429,
      { ratelimit: "\"10-in-1sec\"; r=0; t=1", "ratelimit-policy": "\"10-in-1sec\"; q=10; w=1", "retry-after": "1" },
    );
  };
  return {
    fetchImpl,
    async sleep() {
      phase = "recovered";
    },
  };
}

test("bounded load proves 429 enforcement and post-window recovery", async () => {
  const mock = loadFetch();
  const result = await runUadRedTeamBoundedLoad({
    fetchImpl: mock.fetchImpl,
    sleep: mock.sleep,
    concurrency: 2,
    checkedAt: "2026-08-24T02:45:00.000Z",
  });
  assert.equal(result.ok, true);
  assert.equal(result.configured_limit, 10);
  assert.equal(result.load.successful_responses, 9);
  assert.ok(result.load.rate_limited_responses >= 1);
  assert.equal(result.load.unexpected_responses, 0);
  assert.equal(result.load.observed_policy_buckets, 1);
  assert.equal(result.recovery.ready, true);
  assert.doesNotMatch(JSON.stringify(result), /rate_limit_exceeded|specification_release_key/i);
});

test("bounded load tolerates a small number of rotating CI egress buckets", async () => {
  let phase = "load";
  let requestNumber = 0;
  const counts = new Map();
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/api/uad/readiness") return json({ ok: true });
    if (phase === "recovered") {
      return json(
        { specification_release_key: "uad-3.6-test" },
        200,
        { ratelimit: '"10-in-1sec"; r=9; t=1', "ratelimit-policy": '"10-in-1sec"; q=10; w=1; pk=:bucket-a:' },
      );
    }
    const bucket = requestNumber++ % 2 === 0 ? "bucket-a" : "bucket-b";
    const count = (counts.get(bucket) || 0) + 1;
    counts.set(bucket, count);
    if (count > 10) {
      return json(
        { error: "rate_limit_exceeded" },
        429,
        { ratelimit: '"10-in-1sec"; r=0; t=1', "ratelimit-policy": `"10-in-1sec"; q=10; w=1; pk=:${bucket}:`, "retry-after": "1" },
      );
    }
    return json(
      { specification_release_key: "uad-3.6-test" },
      200,
      { ratelimit: `"10-in-1sec"; r=${10 - count}; t=1`, "ratelimit-policy": `"10-in-1sec"; q=10; w=1; pk=:${bucket}:` },
    );
  };

  const result = await runUadRedTeamBoundedLoad({
    fetchImpl,
    concurrency: 2,
    sleep: async () => { phase = "recovered"; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.load.observed_policy_buckets, 2);
  assert.ok(result.load.attempted_requests > 10);
});

test("bounded load fails closed on an unexpected response", async () => {
  const mock = loadFetch({ unexpectedStatus: 500 });
  const result = await runUadRedTeamBoundedLoad({
    fetchImpl: mock.fetchImpl,
    sleep: mock.sleep,
    concurrency: 2,
  });
  assert.equal(result.ok, false);
  assert.equal(result.load.ready, false);
  assert.equal(result.load.unexpected_responses, 1);
  assert.equal(result.recovery.ready, false);
});

test("bounded load cannot target a non-red-team service", async () => {
  const mock = loadFetch();
  await assert.rejects(() => runUadRedTeamBoundedLoad({
    baseUrl: "https://homenode-api-staging.onrender.com",
    fetchImpl: mock.fetchImpl,
    sleep: mock.sleep,
  }), /invalid_uad_redteam_api_url/);
});
