import assert from "node:assert/strict";
import test from "node:test";

import {
  assignmentDocumentCandidateReviewKey,
  assignmentDocumentRetryDelayMs,
  retainedAssignmentDocumentReview,
} from "../src/services/assignmentDocuments.js";

test("document extraction retries use bounded exponential backoff", () => {
  assert.equal(assignmentDocumentRetryDelayMs(1), 30_000);
  assert.equal(assignmentDocumentRetryDelayMs(2), 60_000);
  assert.equal(assignmentDocumentRetryDelayMs(5), 480_000);
  assert.equal(assignmentDocumentRetryDelayMs(50), 6 * 60 * 60 * 1_000);
});

test("candidate identity follows the field and normalized source value", () => {
  assert.equal(
    assignmentDocumentCandidateReviewKey({
      field_key: "contract_price",
      raw_value: "$425,000",
      normalized_value: "425000.00",
    }),
    "contract_price\u0000425000.00",
  );
});

test("reprocessing retains an exact appraiser review but not a changed extraction", () => {
  const reviews = [{
    field_key: "contract_price",
    raw_value: "$425,000",
    normalized_value: "425000.00",
    review_status: "confirmed",
    confirmed_value: "425000",
    reviewer: "Appraiser Example",
    reviewed_at: "2026-08-19T12:00:00.000Z",
  }];
  assert.deepEqual(
    retainedAssignmentDocumentReview(reviews, {
      field_key: "contract_price",
      raw_value: "$425,000.00",
      normalized_value: "425000.00",
    }),
    {
      review_status: "confirmed",
      confirmed_value: "425000",
      reviewer: "Appraiser Example",
      reviewed_at: "2026-08-19T12:00:00.000Z",
    },
  );
  assert.equal(
    retainedAssignmentDocumentReview(reviews, {
      field_key: "contract_price",
      raw_value: "$430,000",
      normalized_value: "430000.00",
    }).review_status,
    "suggested",
  );
});
