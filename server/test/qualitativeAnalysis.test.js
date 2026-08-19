import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateQualitativeAnalysis,
  normalizeSalesComparisonQualitativeAnalysis,
} from "../src/util/qualitativeAnalysis.js";

const comparables = [
  { sale: { source_record_id: "A", address: "1 Lower St", sale_price: 200_000 }, indicatedValue: 240_000 },
  { sale: { source_record_id: "B", address: "2 Similar St", sale_price: 250_000 }, indicatedValue: 275_000 },
  { sale: { source_record_id: "C", address: "3 Upper St", sale_price: 300_000 }, indicatedValue: 310_000 },
];

test("reconciles similar evidence inside a consistent qualitative bracket", () => {
  const result = calculateQualitativeAnalysis({
    applied: true,
    selections: [
      { comparable_key: "sale:A", classification: "inferior" },
      { comparable_key: "sale:B", classification: "similar" },
      { comparable_key: "sale:C", classification: "superior" },
    ],
  }, comparables);
  assert.equal(result.conclusion.lower_bound, 240_000);
  assert.equal(result.conclusion.upper_bound, 310_000);
  assert.equal(result.conclusion.recommended_value, 275_000);
  assert.equal(result.applied, true);
});

test("blocks an inconsistent bracket from replacing the value conclusion", () => {
  const result = calculateQualitativeAnalysis({
    applied: true,
    selections: [
      { comparable_key: "sale:C", classification: "inferior" },
      { comparable_key: "sale:A", classification: "superior" },
    ],
  }, comparables);
  assert.equal(result.conclusion.bracket_consistent, false);
  assert.equal(result.conclusion.recommended_value, null);
  assert.equal(result.applied, false);
});

test("requires at least two classified indications before application", () => {
  const result = calculateQualitativeAnalysis({
    applied: true,
    selections: [{ comparable_key: "sale:A", classification: "similar" }],
  }, comparables);
  assert.equal(result.applied, false);
  assert.match(result.conclusion.warnings.join(" "), /at least two/i);
});

test("recalculates a saved workfile conclusion instead of trusting browser totals", () => {
  const section = normalizeSalesComparisonQualitativeAnalysis({
    comparables,
    opinionOfValue: 999_999,
    workspace: {
      qualitativeAnalysis: {
        applied: true,
        conclusion: { recommended_value: 999_999 },
        selections: [
          { comparable_key: "sale:A", classification: "inferior" },
          { comparable_key: "sale:C", classification: "superior" },
        ],
      },
    },
  });
  assert.equal(section.workspace.qualitativeAnalysis.conclusion.recommended_value, 275_000);
  assert.equal(section.workspace.qualitativeAnalysis.applied, true);
  assert.equal(section.opinionOfValue, 275_000);
});
