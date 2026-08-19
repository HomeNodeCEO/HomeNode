import assert from "node:assert/strict";
import test from "node:test";

import type { TargetFieldDefinition } from "../src/api/client";
import { editableTargetValue, targetFieldChange } from "../src/targetFields/model";

function field(overrides: Partial<TargetFieldDefinition> = {}): TargetFieldDefinition {
  return {
    field_path: "property_tax_protest.subject.condition_rating",
    group: "Subject",
    label: "Condition",
    value_type: "enum",
    target_reference: { kind: "property_tax_protest", target_path: ["subject", "condition_rating"] },
    options: ["C3", "C4"],
    units: [],
    required: false,
    minimum: null,
    maximum: null,
    maximum_length: null,
    multiline: false,
    ...overrides,
  };
}

test("target fields preserve typed observations and explicit clearing", () => {
  assert.deepEqual(targetFieldChange(field(), "C3"), { exists: true, value: "C3" });
  assert.deepEqual(targetFieldChange(field(), ""), { exists: false });
  assert.deepEqual(targetFieldChange(field({ value_type: "boolean", options: [] }), "false"), {
    exists: true,
    value: false,
  });
  assert.deepEqual(targetFieldChange(field({
    value_type: "number",
    options: [],
    minimum: 0,
    maximum: 100,
  }), "2.5"), { exists: true, value: 2.5 });
});

test("target fields validate official choices, measurements, and required values", () => {
  assert.throws(() => targetFieldChange(field(), "C6"), /unsupported selection/);
  assert.throws(() => targetFieldChange(field({ required: true }), ""), /required/);
  assert.deepEqual(targetFieldChange(field({
    value_type: "measurement",
    options: [],
    units: ["SquareFeet", "Acres"],
  }), "2450 SquareFeet"), {
    exists: true,
    value: { amount: 2450, unit: "SquareFeet" },
  });
  assert.throws(() => targetFieldChange(field({
    value_type: "measurement",
    options: [],
    units: ["SquareFeet"],
  }), "2450 sqft"), /requires a number followed by/);
});

test("target display values round-trip arrays and measurements", () => {
  assert.equal(editableTargetValue({ exists: true, value: ["A", "B"] }), "A, B");
  assert.equal(editableTargetValue({ exists: true, value: { amount: 2, unit: "Acres" } }), "2 Acres");
  assert.equal(editableTargetValue({ exists: false }), "");
});
