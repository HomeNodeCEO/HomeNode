import test from "node:test";
import assert from "node:assert/strict";

import {
  COMPARABLE_SEARCH_PROFILES,
  DEFAULT_COMPARABLE_SEARCH_PROFILE_KEY,
  resolveComparableSearchProfile,
} from "../src/util/comparableSearchProfiles.js";

test("comparable search profiles provide progressively broader radii", () => {
  assert.equal(COMPARABLE_SEARCH_PROFILES.length, 12);
  assert.deepEqual(
    COMPARABLE_SEARCH_PROFILES
      .filter((profile) => profile.geography === "suburban")
      .map((profile) => profile.radiusMiles),
    [2, 5, 10],
  );
  assert.deepEqual(
    COMPARABLE_SEARCH_PROFILES
      .filter((profile) => profile.geography === "rural")
      .map((profile) => profile.radiusMiles),
    [10, 25, 50],
  );
});

test("profile resolution accepts labels and keeps a compatible API default", () => {
  assert.equal(DEFAULT_COMPARABLE_SEARCH_PROFILE_KEY, "suburban_simple");
  assert.equal(resolveComparableSearchProfile().key, "suburban_simple");
  assert.equal(resolveComparableSearchProfile("Semi-Rural - Moderate").radiusMiles, 10);
  assert.equal(resolveComparableSearchProfile("unsupported"), null);
  assert.equal(resolveComparableSearchProfile("", { useDefault: false }), null);
});

