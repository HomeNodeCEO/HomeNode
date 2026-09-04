import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  clearCustomAppraisalSignatureEventId,
  getOrCreateCustomAppraisalSignatureEventId,
} from "../src/lib/customAppraisalSigning.ts";

test("Custom Appraisal signing keeps one event ID until success is confirmed", () => {
  const values = new Map();
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  });
  try {
    const first = getOrCreateCustomAppraisalSignatureEventId("ACCOUNT-1", 41);
    const retry = getOrCreateCustomAppraisalSignatureEventId("ACCOUNT-1", 41);
    assert.match(first, /^[0-9a-f-]{36}$/);
    assert.equal(retry, first);

    clearCustomAppraisalSignatureEventId("ACCOUNT-1", 41, crypto.randomUUID());
    assert.equal(getOrCreateCustomAppraisalSignatureEventId("ACCOUNT-1", 41), first);

    clearCustomAppraisalSignatureEventId("ACCOUNT-1", 41, first);
    assert.notEqual(getOrCreateCustomAppraisalSignatureEventId("ACCOUNT-1", 41), first);
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, "localStorage", originalDescriptor);
    } else {
      delete globalThis.localStorage;
    }
  }
});

test("Custom Appraisal signing replaces a malformed persisted event ID", () => {
  const values = new Map([["homenode:custom-appraisal-signature:ACCOUNT-2:42", "malformed"]]);
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  });
  try {
    const eventId = getOrCreateCustomAppraisalSignatureEventId("ACCOUNT-2", 42);
    assert.match(eventId, /^[0-9a-f-]{36}$/);
    assert.notEqual(eventId, "malformed");
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, "localStorage", originalDescriptor);
    } else {
      delete globalThis.localStorage;
    }
  }
});

test("the shared signing API retains and submits the event ID until success", () => {
  const source = fs.readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function signCustomAppraisalWorkfile(");
  const end = source.indexOf("/** Fetch the named database workfile", start);
  const signingApi = source.slice(start, end);
  assert.match(signingApi, /getOrCreateCustomAppraisalSignatureEventId\(id, assignmentFileId\)/);
  assert.match(signingApi, /signature_event_id: signatureEventId/);
  assert.doesNotMatch(signingApi, /retryTransient: true/);
  assert.ok(
    signingApi.indexOf("clearCustomAppraisalSignatureEventId")
      > signingApi.indexOf("await fetchJSON"),
  );
});
