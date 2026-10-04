import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import pg from "pg";
import { rollbackWithDiscardReason } from "../src/database/transactionCleanup.js";

const failureCode = "pool_contract_rollback_failed";
const testOptions = { timeout: 5_000 };

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Only the transport is synthetic: acquisition, queuing, release and removal use
// the installed pg.Pool. This does not model PostgreSQL transaction durability,
// ambiguous COMMIT outcomes, or the integration of any application owner.
function fixture(t, queryResult = () => Promise.resolve({ command: "ROLLBACK" })) {
  const clients = [];
  const events = [];
  const states = new Map();
  class SyntheticClient extends EventEmitter {
    constructor() {
      super();
      this._queryable = true;
      this._ending = false;
      this.queries = [];
      this.endCalls = 0;
      clients.push(this);
    }

    connect(callback) { queueMicrotask(() => callback(null)); }

    query(...args) {
      this.queries.push(args);
      return queryResult(this);
    }

    end(callback) {
      this.endCalls += 1;
      this._ending = true;
      events.push({ type: "end", client: this });
      queueMicrotask(() => {
        this.emit("end");
        callback?.();
      });
    }
  }

  // The injected constructor never creates pg.Client, sockets or reads config.
  const pool = new pg.Pool({
    Client: SyntheticClient, max: 1, idleTimeoutMillis: 0,
    maxLifetimeSeconds: 0, connectionTimeoutMillis: 1_000,
  });
  pool.on("acquire", (client) => { states.set(client, "acquired"); });
  pool.on("release", (error, client) => {
    states.set(client, "released");
    events.push({ type: "release", error, client });
  });
  pool.on("remove", (client) => { events.push({ type: "remove", client }); });
  pool.on("error", (error, client) => { events.push({ type: "error", error, client }); });

  t.after(async () => {
    // Assertion failures must not leave a checked-out client or throwing test
    // listener behind. Only public APIs/events are used; no pool state mutation.
    pool.removeAllListeners("release");
    for (const client of clients) {
      if (client.endCalls) continue;
      const cleanupError = new Error("pool_contract_fixture_cleanup");
      if (states.get(client) === "acquired") client.release(cleanupError);
      else if (pool.idleCount === 0) client.emit("error", cleanupError);
    }
    await bounded(pool.end(), "pool teardown");
    assert.equal(pool.totalCount, 0);
    assert.equal(pool.idleCount, 0);
    assert.equal(pool.waitingCount, 0);
    for (const client of clients) assert.equal(client.endCalls, 1);
  });

  return {
    pool, clients, events,
    checkout: () => bounded(pool.connect(), "pool checkout"),
  };
}

function assertMarker(marker, raw) {
  assert.ok(marker instanceof Error);
  assert.notEqual(marker, raw);
  assert.equal(marker.message, failureCode);
  assert.equal(Object.hasOwn(marker, "cause"), false);
  assert.equal(marker.stack.includes(raw.message), false);
}

test("successful rollback releases a reusable client through the real pool", testOptions, async (t) => {
  const f = fixture(t);
  const first = await f.checkout();
  const marker = await rollbackWithDiscardReason(first, failureCode);
  assert.equal(marker, null);
  assert.deepEqual(first.queries, [["ROLLBACK"]]);
  first.release(marker ?? undefined);
  assert.deepEqual(f.events, [{ type: "release", error: undefined, client: first }]);
  assert.equal(f.pool.totalCount, 1);
  assert.equal(f.pool.idleCount, 1);
  const next = await f.checkout();
  assert.equal(next, first);
  assert.equal(f.clients.length, 1);
  assert.equal(first.endCalls, 0);
  next.release();
});

test("negative control: failed rollback without the discard marker reuses the same client", testOptions, async (t) => {
  const raw = new Error("private negative-control rollback detail");
  const f = fixture(t, () => Promise.reject(raw));
  const first = await f.checkout();
  assertMarker(await rollbackWithDiscardReason(first, failureCode), raw);
  // Deliberately omit the marker: the pool cannot infer the query's failure.
  first.release();
  const next = await f.checkout();
  assert.equal(next, first);
  assert.equal(first.endCalls, 0);
  assert.equal(f.events.some(({ type }) => type === "remove"), false);
  next.release();
});

for (const synchronous of [true, false]) {
  test(`${synchronous ? "synchronous" : "rejected"} rollback failure retires the real pool client before another checkout`, testOptions, async (t) => {
    const raw = new Error("private driver connection detail");
    const f = fixture(t, () => {
      if (synchronous) throw raw;
      return Promise.reject(raw);
    });
    const first = await f.checkout();
    const marker = await rollbackWithDiscardReason(first, failureCode);
    assertMarker(marker, raw);
    assert.deepEqual(first.queries, [["ROLLBACK"]]);
    first.release(marker);
    await setImmediate();
    assert.deepEqual(f.events, [
      { type: "release", error: marker, client: first },
      { type: "end", client: first },
      { type: "remove", client: first },
    ]);
    assert.equal(first.endCalls, 1);
    assert.equal(f.pool.totalCount, 0);
    assert.equal(f.pool.idleCount, 0);
    const next = await f.checkout();
    assert.notEqual(next, first);
    assert.equal(f.clients.length, 2);
    next.release();
  });
}

for (const fails of [false, true]) {
  test(`queued borrower waits for deferred rollback ${fails ? "failure and retirement" : "success and release"}`, testOptions, async (t) => {
    const gate = deferred();
    const raw = new Error("private deferred rollback detail");
    const f = fixture(t, () => gate.promise);
    const first = await f.checkout();
    f.pool.on("acquire", (client) => { f.events.push({ type: "borrow", client }); });
    let cleanupSettled = false;
    let borrowerSettled = false;
    const cleanup = rollbackWithDiscardReason(first, failureCode).then((marker) => {
      first.release(marker ?? undefined);
      cleanupSettled = true;
      return marker;
    });
    const borrower = f.checkout().then((client) => {
      borrowerSettled = true;
      return client;
    });
    // Attach rejection handlers immediately and drain both even if an assertion
    // fails, so no queued borrower or unresolved gate survives fixture teardown.
    const settled = Promise.allSettled([cleanup, borrower]);
    try {
      await setImmediate();
      assert.equal(cleanupSettled, false);
      assert.equal(borrowerSettled, false);
      assert.equal(f.pool.waitingCount, 1);
      assert.equal(f.pool.totalCount, 1);
      assert.equal(f.pool.idleCount, 0);
      assert.equal(f.clients.length, 1);
      assert.deepEqual(first.queries, [["ROLLBACK"]]);
      assert.deepEqual(f.events, []);
      if (fails) gate.reject(raw);
      else gate.resolve({ command: "ROLLBACK" });
      const marker = await bounded(cleanup, "rollback cleanup");
      if (fails) assertMarker(marker, raw);
      else assert.equal(marker, null);
      const next = await borrower;
      assert.equal(cleanupSettled, true);
      assert.equal(borrowerSettled, true);
      assert.equal(f.pool.waitingCount, 0);
      assert.equal(next === first, !fails);
      assert.equal(first.endCalls, fails ? 1 : 0);
      assert.deepEqual(f.events.map(({ type }) => type), fails ? ["release", "end", "remove", "borrow"] : ["release", "borrow"]);
      assert.equal(f.events[0].error, marker ?? undefined);
      assert.equal(f.events[0].client, first);
      assert.equal(f.events.at(-1).client, next);
      next.release();
    } finally {
      gate.resolve({ command: "ROLLBACK" });
      await bounded(settled, "deferred tasks");
    }
  });
}

test("throwing release listener propagates exactly and can prevent error-driven removal", testOptions, async (t) => {
  const raw = new Error("private listener-case rollback detail");
  const f = fixture(t, () => Promise.reject(raw));
  const first = await f.checkout();
  const marker = await rollbackWithDiscardReason(first, failureCode);
  assertMarker(marker, raw);
  const listenerFailure = Object.freeze({ source: "test release listener" });
  const listener = () => { throw listenerFailure; };
  f.pool.on("release", listener);
  assert.throws(() => first.release(marker), (error) => error === listenerFailure);
  assert.deepEqual(f.events, [{ type: "release", error: marker, client: first }]);
  assert.equal(first.endCalls, 0);
  assert.equal(f.pool.totalCount, 1);
  assert.equal(f.pool.idleCount, 0);
  assert.throws(() => first.release(marker), /already been released/);
  assert.equal(f.events.length, 1, "release is not retried after a listener throws");

  // Synthetic fixture recovery only: normal release above did NOT retire it.
  // pg-pool's attached idle-error handler can dispose it through a public event.
  f.pool.off("release", listener);
  const cleanupError = new Error("pool_contract_listener_fixture_cleanup");
  first.emit("error", cleanupError);
  await setImmediate();
  assert.equal(first.endCalls, 1);
  assert.equal(f.pool.totalCount, 0);
  assert.equal(f.pool.idleCount, 0);
  assert.deepEqual(f.events.map(({ type }) => type), ["release", "end", "error", "remove"]);
  assert.equal(f.events[2].error, cleanupError);
  assert.equal(f.events[2].client, first);
});
