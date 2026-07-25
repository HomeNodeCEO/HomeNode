import test from "node:test";
import assert from "node:assert/strict";
import {
  GROUPED_ANALYSIS_BREAKDOWNS,
  parseGroupedAnalysisBreakdowns,
} from "../src/util/groupedAnalysisBreakdowns.js";

test("grouped analysis defaults to the existing citywide study", () => {
  assert.deepEqual(
    parseGroupedAnalysisBreakdowns(undefined).map((item) => item.key),
    ["city"],
  );
});

test("grouped analysis accepts any unique combination in the requested order", () => {
  const parsed = parseGroupedAnalysisBreakdowns(
    "zip,radius_1,radius_3,zip,city",
  );
  assert.deepEqual(
    parsed.map((item) => [item.key, item.scope, item.radiusMiles]),
    [
      ["zip", "zip", null],
      ["radius_1", "radius", 1],
      ["radius_3", "radius", 3],
      ["city", "city", null],
    ],
  );
});

test("all supported breakdowns cover city, ZIP, and radii through five miles", () => {
  assert.deepEqual(
    GROUPED_ANALYSIS_BREAKDOWNS.map((item) => item.key),
    [
      "city",
      "zip",
      "radius_1",
      "radius_2",
      "radius_3",
      "radius_4",
      "radius_5",
    ],
  );
});

test("unknown grouped analysis breakdowns are rejected", () => {
  assert.throws(
    () => parseGroupedAnalysisBreakdowns("city,radius_6"),
    /invalid_grouped_analysis_breakdown/,
  );
});
