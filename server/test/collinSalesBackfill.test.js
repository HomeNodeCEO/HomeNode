import test from "node:test";
import assert from "node:assert/strict";

import {
  addressAgreement,
  backfillCollinSalesQueue,
  collinBackfillErrorCode,
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

test("reports only recognized reconciliation codes or bounded SQLSTATEs", () => {
  assert.equal(collinBackfillErrorCode(new Error("database_url_required")), "database_url_required");
  assert.equal(collinBackfillErrorCode(new Error("source_record_already_verified")), "source_record_already_verified");
  assert.equal(collinBackfillErrorCode({ code: "23505", message: "duplicate key value contains private data" }), "database_sqlstate_23505");
  assert.equal(collinBackfillErrorCode({ code: "secret-token", message: "password=private" }), "collin_sales_backfill_failed");
  assert.equal(collinBackfillErrorCode(new Error("connection failed: password=private")), "collin_sales_backfill_failed");
  assert.equal(collinBackfillErrorCode({ get message() { throw new Error("private"); }, get code() { throw new Error("private"); } }), "collin_sales_backfill_failed");
});

test("does not include a raw database exception in the printed backfill summary", async () => {
  const pool = {
    async query(sql) {
      if (sql.includes("FROM core.sales_source_records source")) {
        return { rows: [{
          id: 1,
          parcel_number_raw: "R-1234-567-89",
          parcel_number2_raw: null,
          raw_payload: { "Property Address": "100 Main St" },
        }] };
      }
      return { rows: [{ ...account, lookup_key: "123456789" }] };
    },
    async connect() {
      throw new Error("database failed with password=private");
    },
  };
  const summary = await backfillCollinSalesQueue(pool, { apply: true, maximumRows: 1 });
  assert.equal(summary.scanned, 1);
  assert.equal(summary.eligible, 1);
  assert.equal(summary.applied, 0);
  assert.deepEqual(summary.errors, { collin_sales_backfill_failed: 1 });
  assert.doesNotMatch(JSON.stringify(summary), /private/);
});
