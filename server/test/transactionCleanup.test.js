import assert from "node:assert/strict";
import test from "node:test";
import { rollbackWithDiscardReason } from "../src/database/transactionCleanup.js";

const defaultCode = "transaction_rollback_failed";

function fixture(queryResult) {
  const queries = [];
  const ownershipCalls = [];
  const client = {
    query(...args) {
      queries.push({ receiver: this, args });
      return queryResult();
    },
    connect() { ownershipCalls.push("connect"); },
    release() { ownershipCalls.push("release"); },
    end() { ownershipCalls.push("end"); },
  };
  return { client, queries, ownershipCalls };
}

function assertOnlyRollback(f) {
  assert.equal(f.queries.length, 1, "rollback is attempted exactly once");
  assert.equal(f.queries[0].receiver, f.client, "query retains its client binding");
  assert.deepEqual(f.queries[0].args, ["ROLLBACK"]);
  assert.deepEqual(f.ownershipCalls, [], "the caller retains acquisition and release ownership");
}

function assertMarker(marker, code = defaultCode) {
  assert.ok(marker instanceof Error);
  assert.equal(marker.message, code);
  assert.equal(Object.hasOwn(marker, "cause"), false);
  assert.equal(marker.cause, undefined);
}

for (const [name, queryResult] of [
  ["synchronous result", () => ({ command: "ROLLBACK" })],
  ["undefined result", () => undefined],
  ["fulfilled promise", () => Promise.resolve({ command: "ROLLBACK" })],
]) {
  test(`rollback succeeds with a ${name} and leaves the client reusable`, async () => {
    const f = fixture(queryResult);
    assert.equal(await rollbackWithDiscardReason(f.client), null);
    assertOnlyRollback(f);
  });
}

for (const [name, queryResult] of [
  ["synchronous throw", () => { throw new Error("private rollback connection detail"); }],
  ["promise rejection", () => Promise.reject(new Error("private rollback connection detail"))],
  ["throwing then getter", () => ({ get then() { throw new Error("private then detail"); } })],
  ["primitive rejection", () => Promise.reject(null)],
]) {
  test(`rollback converts a ${name} into a sanitized default discard reason`, async () => {
    const f = fixture(queryResult);
    const marker = await rollbackWithDiscardReason(f.client);
    assertMarker(marker);
    assert.equal(marker.stack.includes("private"), false);
    assertOnlyRollback(f);
  });
}

test("each failed rollback gets a fresh marker without copying or inspecting raw error details", async () => {
  let detailReads = 0;
  const raw = Object.freeze({
    get message() { detailReads += 1; throw new Error("must not inspect raw message"); },
    get stack() { detailReads += 1; throw new Error("must not inspect raw stack"); },
    get cause() { detailReads += 1; throw new Error("must not inspect raw cause"); },
    privateDetail: "private rollback connection detail",
  });
  const first = fixture(() => { throw raw; });
  const second = fixture(() => Promise.reject(raw));
  const firstMarker = await rollbackWithDiscardReason(first.client, "owned_transaction_failed");
  const secondMarker = await rollbackWithDiscardReason(second.client, "owned_transaction_failed");
  for (const marker of [firstMarker, secondMarker]) {
    assertMarker(marker, "owned_transaction_failed");
    assert.notEqual(marker, raw);
    assert.equal(marker.privateDetail, undefined);
    assert.equal(marker.stack.includes(raw.privateDetail), false);
  }
  assert.notEqual(firstMarker, secondMarker);
  assert.equal(detailReads, 0);
  assertOnlyRollback(first);
  assertOnlyRollback(second);
});

for (const code of ["a", "a1_b2", "housing_profile_rollback_failed", "a".repeat(96)]) {
  test(`valid internal failure code of length ${code.length} is preserved`, async () => {
    const f = fixture(() => Promise.reject(new Error("private rollback connection detail")));
    assertMarker(await rollbackWithDiscardReason(f.client, code), code);
    assertOnlyRollback(f);
  });
}

const malformedCodes = [
  ["empty", ""], ["oversize", "a".repeat(97)],
  ["uppercase start", "Bad_code"], ["uppercase suffix", "bad_Code"],
  ["numeric start", "1bad_code"], ["underscore start", "_bad_code"],
  ["hyphen", "bad-code"], ["space", "bad code"],
  ["trailing newline", "bad_code\n"], ["trailing CRLF", "bad_code\r\n"],
  ["embedded NUL", "bad\0code"], ["non-ASCII", "bad_codé"],
  ["null", null], ["undefined", undefined], ["number", 123],
  ["boolean", true], ["symbol", Symbol("bad_code")],
  ["array", ["bad_code"]], ["boxed string", new String("bad_code")],
];

for (const [name, code] of malformedCodes) {
  test(`malformed ${name} failure code falls back without preventing rollback`, async () => {
    for (const fails of [false, true]) {
      const f = fixture(() => fails ? Promise.reject(new Error("private rollback detail")) : undefined);
      const result = await rollbackWithDiscardReason(f.client, code);
      if (fails) assertMarker(result);
      else assert.equal(result, null);
      assertOnlyRollback(f);
    }
  });
}

test("non-string failure codes are never coerced or inspected", async () => {
  let coercions = 0;
  const hostile = {
    toString() { coercions += 1; throw new Error("must not stringify"); },
    valueOf() { coercions += 1; throw new Error("must not convert"); },
    [Symbol.toPrimitive]() { coercions += 1; throw new Error("must not coerce"); },
  };
  const proxy = new Proxy({}, {
    get() { coercions += 1; throw new Error("must not inspect"); },
  });
  for (const code of [hostile, proxy]) {
    const f = fixture(() => { throw new Error("private rollback detail"); });
    assertMarker(await rollbackWithDiscardReason(f.client, code));
    assertOnlyRollback(f);
  }
  assert.equal(coercions, 0);
});

for (const fails of [false, true]) {
  test(`helper waits for rollback ${fails ? "rejection" : "completion"} before settling`, async () => {
    let resolveQuery;
    let rejectQuery;
    const query = new Promise((resolve, reject) => { resolveQuery = resolve; rejectQuery = reject; });
    const f = fixture(() => query);
    let settled = false;
    const result = rollbackWithDiscardReason(f.client, "deferred_rollback_failed").then((marker) => {
      settled = true;
      return marker;
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(settled, false);
    assertOnlyRollback(f);
    if (fails) rejectQuery(new Error("private deferred rollback detail"));
    else resolveQuery({ command: "ROLLBACK" });
    const marker = await result;
    assert.equal(settled, true);
    if (fails) assertMarker(marker, "deferred_rollback_failed");
    else assert.equal(marker, null);
    assertOnlyRollback(f);
  });
}
