import assert from "node:assert/strict";
import test from "node:test";
import { assertNeighborhoodJsonbStorage, NEIGHBORHOOD_JSONB_STORAGE_MAX_BYTES } from "../src/services/neighborhoodAssessment/jsonbStorage.js";
import { canonicalAssessmentJson } from "../src/services/neighborhoodAssessment/contract.js";

const errorCode = code => error => error instanceof TypeError && error.code === `neighborhood_jsonb_storage_${code}`;

test("storage byte estimate counts PostgreSQL separators separately from compact canonical evidence", () => {
  const value = { a: [1, 2, null, true, false], b: { text: "test" } };
  assert.equal(assertNeighborhoodJsonbStorage(value), Buffer.byteLength('{"a": [1, 2, null, true, false], "b": {"text": "test"}}'));
  assert.ok(assertNeighborhoodJsonbStorage(value) > Buffer.byteLength(canonicalAssessmentJson(value)));
  assert.equal(assertNeighborhoodJsonbStorage({}), 2);
  assert.equal(assertNeighborhoodJsonbStorage([]), 2);
  assert.equal(assertNeighborhoodJsonbStorage(null), 4);
});

test("common separator expansion just beyond the canonical ceiling remains within the explicit storage ceiling", () => {
  const value = { padding: "x".repeat(1_469_990), values: Array(10000).fill(0) };
  assert.equal(Buffer.byteLength(canonicalAssessmentJson(value)), 1_490_015);
  assert.equal(assertNeighborhoodJsonbStorage(value), 1_500_017);
  assert.equal(NEIGHBORHOOD_JSONB_STORAGE_MAX_BYTES, 2_000_000);
});

test("finite exponent-form numbers are counted as expanded decimal tokens without materializing them", () => {
  for (const [value, bytes] of [
    [1e308, 309], [-1e308, 310], [Number.MAX_VALUE, 309], [-Number.MAX_VALUE, 310],
    [5e-324, 326], [-5e-324, 327], [1.23e-100, 104], [1.25e21, 22], [1e-7, 9],
    [1e-6, 8], [12.5, 4], [-0, 1], [0, 1], [Number.MAX_SAFE_INTEGER, 16],
  ]) assert.equal(assertNeighborhoodJsonbStorage(value), bytes, String(value));
});

test("small canonical numeric arrays with huge PostgreSQL decimal expansion fail before database work", () => {
  for (const value of [1e308, 5e-324, -Number.MAX_VALUE]) {
    const payload = { values: Array(10000).fill(value) };
    assert.ok(Buffer.byteLength(canonicalAssessmentJson(payload)) < 1_500_000);
    assert.throws(() => assertNeighborhoodJsonbStorage(payload), errorCode("limit"));
  }
});

test("JSON escaping and UTF-8 widths are counted for both keys and values", () => {
  for (const text of ['quote"slash\\', "\b\t\n\f\r", "\u0001\u000b\u001f", "é漢😀", "\u007f", "\u2028\u2029"]) {
    assert.equal(assertNeighborhoodJsonbStorage(text), Buffer.byteLength(JSON.stringify(text)));
    assert.equal(assertNeighborhoodJsonbStorage({ [text]: text }), 2 + 2 * Buffer.byteLength(JSON.stringify(text)) + 2);
  }
});

test("PostgreSQL-incompatible NUL and unpaired surrogates are rejected rather than silently changed", () => {
  for (const text of ["\u0000", "prefix\u0000suffix", "\ud800", "\udc00", "\ud800x", "x\udfff"]) {
    assert.throws(() => assertNeighborhoodJsonbStorage(text), errorCode("invalid"));
    assert.throws(() => assertNeighborhoodJsonbStorage({ [text]: "value" }), errorCode("invalid"));
    assert.throws(() => assertNeighborhoodJsonbStorage({ field: text }), errorCode("invalid"));
  }
  assert.equal(assertNeighborhoodJsonbStorage("\ud83d\ude00"), 6);
});

test("storage ceiling is explicit and does not replace the smaller canonical JSON contract limit", () => {
  assert.equal(assertNeighborhoodJsonbStorage("x".repeat(NEIGHBORHOOD_JSONB_STORAGE_MAX_BYTES - 2)), NEIGHBORHOOD_JSONB_STORAGE_MAX_BYTES);
  assert.throws(() => assertNeighborhoodJsonbStorage("x".repeat(NEIGHBORHOOD_JSONB_STORAGE_MAX_BYTES - 1)), errorCode("limit"));
  assert.throws(() => canonicalAssessmentJson("x".repeat(1_500_000)), /json_bytes/);
});

test("node/depth work limits, cycles, sparse arrays and non-JSON values reject explicitly", () => {
  const cycle = {}; cycle.self = cycle;
  for (const value of [undefined, NaN, Infinity, -Infinity, 1n, () => 1, new Date(), cycle, Array(1)]) {
    assert.throws(() => assertNeighborhoodJsonbStorage(value), errorCode("invalid"));
  }
  assert.throws(() => assertNeighborhoodJsonbStorage(Array(100000).fill(null)), errorCode("limit"));
  let nested = null;
  for (let i = 0; i < 42; i++) nested = [nested];
  assert.throws(() => assertNeighborhoodJsonbStorage(nested), errorCode("limit"));
});

test("estimation leaves caller input unchanged and permits shared acyclic JSON subtrees", () => {
  const child = Object.freeze({ year: 2004, gla_sqft: null });
  const input = Object.freeze({ a: child, b: child });
  const before = canonicalAssessmentJson(input);
  assert.equal(assertNeighborhoodJsonbStorage(input), assertNeighborhoodJsonbStorage(JSON.parse(before)));
  assert.equal(canonicalAssessmentJson(input), before);
});
