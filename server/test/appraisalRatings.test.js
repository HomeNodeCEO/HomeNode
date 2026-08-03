import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeAppraisalRatingUpdate,
  normalizeEffectiveDate,
} from "../src/util/appraisalRatings.js";

test("normalizes UAD full and half-grade ranges", () => {
  assert.deepEqual(
    normalizeAppraisalRatingUpdate({
      condition_rating: " c4-c3 ",
      quality_rating: "q4",
      expected_revision: 2,
    }),
    {
      conditionRating: "C4-C3",
      qualityRating: "Q4",
      notes: null,
      reviewer: "HomeNode editor",
      expectedRevision: 2,
    },
  );
});

test("rejects invalid ratings and missing updates", () => {
  assert.throws(
    () => normalizeAppraisalRatingUpdate({ condition_rating: "C7" }),
    /invalid_condition_rating/,
  );
  assert.throws(() => normalizeAppraisalRatingUpdate({}), /missing_appraisal_rating/);
  assert.equal(
    normalizeAppraisalRatingUpdate({ clear: true }).conditionRating,
    null,
  );
});

test("validates a real calendar effective date", () => {
  assert.equal(normalizeEffectiveDate("2026-08-02"), "2026-08-02");
  assert.throws(() => normalizeEffectiveDate("2026-02-30"), /invalid_effective_date/);
});
