import assert from "node:assert/strict";
import test from "node:test";

import { knownErrorCode, logBoundedFailure } from "../src/security/boundedRouteErrors.js";

test("bounded route logging preserves diagnostic class without exposing the exception", () => {
  const calls = [];
  const logger = {
    error(...args) { calls.push(["error", ...args]); },
    warn(...args) { calls.push(["warn", ...args]); },
  };
  const error = { code: "23505", message: "postgresql://private-secret" };

  logBoundedFailure(logger, "read failed", error);
  logBoundedFailure(logger, "optional read failed", error, "warn");
  logBoundedFailure(logger, "fallback failed", error, "arbitrary");

  assert.deepEqual(calls, [
    ["error", "read failed", "23505"],
    ["warn", "optional read failed", "23505"],
    ["error", "fallback failed", "23505"],
  ]);
});

test("broken loggers and hostile error getters never escape a route boundary", () => {
  const logger = { error() { throw new Error("logging failed"); } };
  const hostileLogger = { get error() { throw new Error("logger getter failed"); } };
  const hostileError = { get code() { throw new Error("private detail"); } };
  assert.doesNotThrow(() => logBoundedFailure(logger, "read failed", hostileError));
  assert.doesNotThrow(() => logBoundedFailure(hostileLogger, "read failed", hostileError));
  assert.doesNotThrow(() => logBoundedFailure(null, "read failed", hostileError));
});

test("known route errors admit only explicitly allowed messages", () => {
  const allowed = new Set(["invalid_assignment_file_id"]);
  assert.equal(knownErrorCode(new Error("invalid_assignment_file_id"), allowed), "invalid_assignment_file_id");
  assert.equal(knownErrorCode(new Error("postgresql://private-secret"), allowed), null);
  assert.equal(knownErrorCode({ get message() { throw new Error("private detail"); } }, allowed), null);
  assert.equal(knownErrorCode(null, allowed), null);
});
