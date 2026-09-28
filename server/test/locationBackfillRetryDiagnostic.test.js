import assert from "node:assert/strict";
import test from "node:test";

import { formatLocationBackfillRetry } from "../src/util/locationBackfillRetryDiagnostic.js";

const retry = {
  nextAttempt: 2,
  maximumAttempts: 3,
  batchStart: 50,
  batchSize: 25,
  delayMs: 1000,
};

test("location retry diagnostics retain bounded official DCAD codes and progress", () => {
  for (const code of [
    "dcad_parcel_query_unavailable",
    "dcad_parcel_query_http_503",
    "dcad_parcel_query_response_too_large",
    "dcad_parcel_query_400",
  ]) {
    assert.equal(
      formatLocationBackfillRetry({ ...retry, error: new Error(code) }),
      `[locations] DCAD GIS retry 2/3 for rows 51-75 in 1000ms: ${code}`,
    );
  }
});

test("location retry diagnostics never print raw or hostile exception messages", () => {
  const privateDetail = "private provider key and URL\nforged log line";
  const unexpected = formatLocationBackfillRetry({ ...retry, error: new Error(privateDetail) });
  assert.equal(unexpected, "[locations] DCAD GIS retry 2/3 for rows 51-75 in 1000ms: dcad_parcel_query_failed");
  assert.equal(unexpected.includes(privateDetail), false);
  assert.equal(formatLocationBackfillRetry({
    ...retry,
    error: { get message() { throw new Error(privateDetail); } },
  }), unexpected);
  assert.equal(formatLocationBackfillRetry({ ...retry, error: null }), unexpected);
});
