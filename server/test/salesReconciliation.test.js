import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSalesReconciliationUpdate } from "../src/services/salesReconciliation.js";

test("sales reconciliation requires a valid CAD account and normalizes audit fields", () => {
  assert.deepEqual(
    normalizeSalesReconciliationUpdate({
      account_id: " 00000416188000000 ",
      notes: " Confirmed against DCAD. ",
      reviewer: " Jordan ",
    }),
    {
      accountId: "00000416188000000",
      notes: "Confirmed against DCAD.",
      reviewer: "Jordan",
    },
  );
  assert.throws(
    () => normalizeSalesReconciliationUpdate({ account_id: "123" }),
    /invalid_account_id/,
  );
});
