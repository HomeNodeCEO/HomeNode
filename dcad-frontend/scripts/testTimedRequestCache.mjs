import assert from "node:assert/strict";
import test from "node:test";

import {
  createInFlightRequestCache,
  createTimedRequestCache,
} from "../src/lib/timedRequestCache.ts";

test("concurrent and recent requests share one promise", async () => {
  const cache = createTimedRequestCache(1000);
  let calls = 0;
  const request = async () => ({ call: ++calls });
  const first = cache.load("75044", request, { now: 100 });
  const second = cache.load("75044", request, { now: 200 });
  assert.equal(first, second);
  assert.deepEqual(await second, { call: 1 });
});

test("forced and expired requests refresh cached data", async () => {
  const cache = createTimedRequestCache(1000);
  let calls = 0;
  const request = async () => ++calls;
  assert.equal(await cache.load("Garland:TX", request, { now: 0 }), 1);
  assert.equal(await cache.load("Garland:TX", request, { force: true, now: 100 }), 2);
  assert.equal(await cache.load("Garland:TX", request, { now: 1200 }), 3);
});

test("failed requests are evicted so a retry can succeed", async () => {
  const cache = createTimedRequestCache(1000);
  let calls = 0;
  const request = async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary failure");
    return "recovered";
  };
  await assert.rejects(cache.load("Dallas:TX", request, { now: 0 }), /temporary failure/);
  assert.equal(await cache.load("Dallas:TX", request, { now: 1 }), "recovered");
});

test("in-flight requests are coalesced without caching completed data", async () => {
  const cache = createInFlightRequestCache();
  let calls = 0;
  let release;
  const first = cache.load("ACCOUNT:1", () => new Promise((resolve) => {
    calls += 1;
    release = resolve;
  }));
  const second = cache.load("ACCOUNT:1", () => Promise.resolve("unexpected"));

  assert.equal(first, second);
  assert.equal(calls, 1);
  release("first result");
  assert.equal(await first, "first result");

  assert.equal(await cache.load("ACCOUNT:1", async () => {
    calls += 1;
    return "fresh result";
  }), "fresh result");
  assert.equal(calls, 2);
});

test("failed in-flight requests are released for retry", async () => {
  const cache = createInFlightRequestCache();
  await assert.rejects(
    cache.load("ACCOUNT:2", async () => { throw new Error("temporary"); }),
    /temporary/,
  );
  assert.equal(await cache.load("ACCOUNT:2", async () => "recovered"), "recovered");
});
