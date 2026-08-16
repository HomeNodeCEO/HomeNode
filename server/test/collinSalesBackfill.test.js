import test from "node:test";
import assert from "node:assert/strict";

import {
  addressAgreement,
  normalizedSitusAddress,
  selectCollinSalesCandidate,
} from "../src/services/collinSalesBackfill.js";

const account = {
  normalized_account_id: "123456789",
  native_account_id: "R-1234-567-89",
  account_id: "998877",
  address: "100 Main Street, Plano, TX 75024",
};

test("normalizes MLS and CAD street suffixes without retaining city text", () => {
  assert.equal(normalizedSitusAddress("100 Main Street, Plano TX 75024"), "100 MAIN ST");
  assert.equal(normalizedSitusAddress("100 MAIN ST"), "100 MAIN ST");
  assert.equal(addressAgreement("100 Main St, Plano", account.address), "match");
});

test("retains unit identifiers when normalizing addresses", () => {
  assert.equal(normalizedSitusAddress("100 Main St Unit 4, Plano TX"), "100 MAIN ST UNIT 4");
  assert.equal(addressAgreement("100 Main St Unit 4", "100 Main St Unit 5"), "conflict");
});

test("matches a Collin MLS parcel with omitted R and dashes", () => {
  const aliases = new Map([["123456789", [account]]]);
  const result = selectCollinSalesCandidate({
    parcel_number_raw: "123456789",
    parcel_number2_raw: null,
    raw_payload: { "Unparsed Address": "100 Main St, Plano TX 75024" },
  }, aliases);
  assert.equal(result.reason, null);
  assert.equal(result.candidate.account_id, "998877");
  assert.equal(result.candidate.native_account_id, "R-1234-567-89");
  assert.equal(result.candidate.address_agreement, "match");
});

test("keeps an explicit address conflict in manual review", () => {
  const aliases = new Map([["123456789", [account]]]);
  const result = selectCollinSalesCandidate({
    parcel_number_raw: "R-1234-567-89",
    raw_payload: { "Property Address": "200 Other Rd, Plano TX" },
  }, aliases);
  assert.equal(result.candidate, null);
  assert.equal(result.reason, "address_conflict");
});

test("keeps distinct multi-parcel accounts in manual review", () => {
  const aliases = new Map([
    ["123456789", [account]],
    ["777", [{ ...account, normalized_account_id: "777", account_id: "112233" }]],
  ]);
  const result = selectCollinSalesCandidate({
    parcel_number_raw: "R-1234-567-89",
    parcel_number2_raw: "R-777",
    raw_payload: { "Property Address": "100 Main St" },
  }, aliases);
  assert.equal(result.candidate, null);
  assert.equal(result.reason, "multiple_parcel_accounts");
});
