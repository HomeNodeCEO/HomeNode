import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSalesReconciliationUpdate,
  salesSourceLocationEvidence,
} from "../src/services/salesReconciliation.js";

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

test("sales reconciliation preserves normalized MLS address and coordinate evidence", () => {
  assert.deepEqual(
    salesSourceLocationEvidence({
      "Property Address": "10010 Strait Ln, Dallas, TX 75229",
      "Property Latitude": "32.88701",
      "Property Longitude": "-96.83420",
    }),
    {
      address_hint: "10010 Strait Ln, Dallas, TX 75229",
      source_latitude: 32.88701,
      source_longitude: -96.8342,
      location_evidence_status: "coordinate_ready",
    },
  );
  assert.equal(
    salesSourceLocationEvidence({ nested: { UnparsedAddress: "1909 Snowmass Ln" } })
      .location_evidence_status,
    "address_ready",
  );
  assert.deepEqual(salesSourceLocationEvidence({ Latitude: "not-a-coordinate" }), {
    address_hint: null,
    source_latitude: null,
    source_longitude: null,
    location_evidence_status: "manual_review",
  });
});
