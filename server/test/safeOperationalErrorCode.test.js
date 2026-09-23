import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { safeOperationalErrorCode } from "../src/security/safeOperationalErrorCode.js";

function warningCalls(source) {
  return [...source.matchAll(/\b(?:console|logger)\??\.warn(?:\?\.)?\([\s\S]*?\);/g)].map((match) => match[0]);
}

function assertWarningCallSafe(call) {
  assert.match(call, /safeOperationalErrorCode\(/);
  const withoutSafeCalls = call.replace(
    /\bsafeOperationalErrorCode\(\s*(?:error|synchronizationError|extractionError)\s*\)/g,
    "bounded",
  );
  const withoutLabels = withoutSafeCalls
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""')
    .replace(/\b(?:error|synchronizationError|extractionError)\s*:/g, "bounded:");
  assert.doesNotMatch(withoutLabels, /\b(?:error|synchronizationError|extractionError)\b/);
}

test("logs only bounded SQLSTATE and known network diagnostic classes", () => {
  assert.equal(safeOperationalErrorCode({ code: "23505", message: "private database URL" }), "23505");
  assert.equal(safeOperationalErrorCode({ code: "42P01", message: "private table" }), "42P01");
  assert.equal(safeOperationalErrorCode({ code: "ECONNRESET", message: "private socket" }), "ECONNRESET");
  assert.equal(safeOperationalErrorCode({ code: "ETIMEDOUT" }), "ETIMEDOUT");
  for (const code of ["secret", "token\nforged-log-line", "123456", "", null, 42]) {
    assert.equal(safeOperationalErrorCode({ code, message: "private detail" }), "unknown");
  }
  assert.equal(safeOperationalErrorCode(new Error("postgresql://private-user:private-password@example/db")), "unknown");
  assert.equal(safeOperationalErrorCode(null), "unknown");
  let codeReads = 0;
  assert.equal(safeOperationalErrorCode({
    get code() {
      codeReads += 1;
      return codeReads === 1 ? "23505" : "TOKEN";
    },
  }), "23505");
  assert.equal(codeReads, 1);
  assert.equal(safeOperationalErrorCode({ get code() { throw new Error("private detail"); } }), "unknown");
});

test("unexpected router and idle-pool errors use only safe diagnostic classes", async () => {
  for (const relativePath of ["../src/modules/mobile/auth.js", "../src/modules/mobile/router.js",
    "../src/modules/uad/router.js", "../src/oldServer.js"]) {
    const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
    assert.match(source, /safeOperationalErrorCode\(error\)/);
    assert.doesNotMatch(source, /console\.error\([^\n]*,\s*error\s*\)/);
    assert.doesNotMatch(source, /console\.error\([^\n]*error\?\.message/);
  }
});

test("startup and background warning sites never print raw exception messages", async () => {
  for (const unsafeWarning of [
    'logger.warn("failure",\n  safeOperationalErrorCode(error),\n  error);',
    'logger.warn?.("failure",\n  safeOperationalErrorCode(error),\n  error);',
    'logger?.warn?.("failure",\n  safeOperationalErrorCode(error),\n  error);',
    'logger.warn("failure",\n  safeOperationalErrorCode(error),\n  error?.message);',
    'console.warn("failure",\n  safeOperationalErrorCode(error),\n  error.message);',
    'console.warn("failure", { error });',
    'console.warn("failure", safeOperationalErrorCode(error), { cause: error });',
    'console.warn("failure", safeOperationalErrorCode(error), [error]);',
  ]) {
    const calls = warningCalls(unsafeWarning);
    assert.equal(calls.length, 1);
    assert.throws(() => assertWarningCallSafe(calls[0]));
  }
  for (const relativePath of ["../src/application/startupResources.js", "../src/modules/uad/router.js",
    "../src/modules/uad/mobileEvidence.js", "../src/services/neighborhoodLandUse.js",
    "../src/services/marketConditions.js"]) {
    const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
    assert.match(source, /safeOperationalErrorCode\(/);
    const calls = warningCalls(source);
    assert.equal(calls.length, [...source.matchAll(/\b(?:console|logger)\??\.warn(?:\?\.)?\(/g)].length);
    for (const call of calls) {
      assertWarningCallSafe(call);
    }
    assert.doesNotMatch(source, /error:\s*(?:error|synchronizationError|extractionError)\??\.message\b/);
    assert.doesNotMatch(source, /\b(?:error|synchronizationError|extractionError)\??\.message\s*\|\|\s*(?:error|synchronizationError|extractionError)\b/);
  }
});
