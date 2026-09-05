import assert from "node:assert/strict";
import test from "node:test";

import {
  countyFromNativeAccountId,
  findAccountByCountyIdentifier,
  homeNodeCollinAccountIdFromPropertyId,
  isSalesSourceRecordReconciliationEligible,
  normalizedCountyAccountKey,
  normalizeSalesReconciliationUpdate,
  reconcileSalesSourceRecord,
  salesSourceLocationEvidence,
  validateSalesReconciliationAccountId,
} from "../src/services/salesReconciliation.js";

test("sales reconciliation requires a valid CAD account and normalizes audit fields", () => {
  assert.deepEqual(
    normalizeSalesReconciliationUpdate({
      account_id: " 00000416188000000 ",
      notes: " Confirmed against DCAD. ",
      reviewer: " Forged browser identity ",
    }, { reviewer: " Jordan " }),
    {
      accountId: "00000416188000000",
      linkedAccountId: null,
      notes: "Confirmed against DCAD.",
      reviewer: "Jordan",
    },
  );
  assert.throws(
    () => normalizeSalesReconciliationUpdate({ account_id: "123" }),
    /invalid_account_id/,
  );
});

test("sales reconciliation preserves authoritative Collin CAD punctuation", () => {
  assert.deepEqual(
    normalizeSalesReconciliationUpdate({
      account_id: " R-13743-00L-0900-1 ",
      linked_account_id: "2965620",
    }),
    {
      accountId: "R-13743-00L-0900-1",
      linkedAccountId: "2965620",
      notes: null,
      reviewer: "HomeNode platform administrator",
    },
  );
  assert.equal(countyFromNativeAccountId("R-13743-00L-0900-1"), "COLLIN");
  assert.equal(
    normalizedCountyAccountKey("R-13743-00L-0900-1", "Collin County"),
    "1374300L09001",
  );
  assert.equal(
    normalizedCountyAccountKey("R1374300L09001", "Collin"),
    "1374300L09001",
  );
});

test("reconciliation eligibility exactly matches the unresolved queue invariant", () => {
  const base = {
    record_type: "closed_sale",
    match_status: "exact",
    primary_account_id: "ACCOUNT_1",
    has_unresolved_parcel: false,
  };
  assert.equal(isSalesSourceRecordReconciliationEligible(base), false);
  assert.equal(isSalesSourceRecordReconciliationEligible({ ...base, primary_account_id: null }), true);
  assert.equal(isSalesSourceRecordReconciliationEligible({ ...base, match_status: "unmatched" }), true);
  assert.equal(isSalesSourceRecordReconciliationEligible({ ...base, match_status: "multiple" }), true);
  assert.equal(isSalesSourceRecordReconciliationEligible({ ...base, has_unresolved_parcel: true }), true);
  assert.equal(isSalesSourceRecordReconciliationEligible({ ...base, match_status: "manual_verified" }), false);
  assert.equal(isSalesSourceRecordReconciliationEligible({ ...base, record_type: "listing" }), false);
});

function lockedSalesSourcePool(source) {
  const queries = [];
  const client = {
    async query(sql) {
      const statement = String(sql).trim();
      queries.push(statement);
      if (statement.startsWith("SELECT *") && statement.includes("core.sales_source_records")) {
        return { rows: [source], rowCount: 1 };
      }
      if (["BEGIN", "ROLLBACK"].includes(statement)) return { rows: [], rowCount: 0 };
      assert.fail(`reconciliation state guard allowed query: ${statement}`);
    },
    release() { queries.push("RELEASE"); },
  };
  return { queries, pool: { connect: async () => client } };
}

test("the locked mutation rejects verified and otherwise resolved sales before writes", async () => {
  const base = {
    id: 55,
    record_type: "closed_sale",
    primary_account_id: "ACCOUNT_1",
    has_unresolved_parcel: false,
  };
  for (const [source, code] of [
    [{ ...base, match_status: "manual_verified" }, "source_record_already_verified"],
    [{ ...base, match_status: "exact" }, "source_record_not_reconcilable"],
  ]) {
    const { pool, queries } = lockedSalesSourcePool(source);
    await assert.rejects(
      () => reconcileSalesSourceRecord(pool, "55", { account_id: "00000416188000000" }),
      new RegExp(code),
    );
    assert.ok(queries.includes("BEGIN"));
    assert.ok(queries.some((query) => query.includes("FOR UPDATE")));
    assert.ok(queries.includes("ROLLBACK"));
    assert.ok(queries.includes("RELEASE"));
    assert.equal(queries.some((query) => /^(UPDATE|INSERT)/.test(query)), false);
  }
});

test("Collin open-data property IDs map to the existing zero-padded HomeNode key", () => {
  assert.equal(
    homeNodeCollinAccountIdFromPropertyId("37"),
    "00000000000000037",
  );
  assert.equal(
    homeNodeCollinAccountIdFromPropertyId("00000000002965620"),
    "00000000002965620",
  );
  assert.equal(homeNodeCollinAccountIdFromPropertyId("R-0002-00A-0030-1"), null);
});

test("county rules keep Dallas strict and require the Collin R prefix", () => {
  assert.equal(
    validateSalesReconciliationAccountId("26272500060150000", "Dallas"),
    "26272500060150000",
  );
  assert.throws(
    () => validateSalesReconciliationAccountId("2627250006015", "Dallas"),
    /invalid_dallas_account_id/,
  );
  assert.throws(
    () => validateSalesReconciliationAccountId("13743-00L-0900-1", "Collin"),
    /invalid_collin_account_id/,
  );
  assert.throws(
    () => validateSalesReconciliationAccountId("R1374300L09001", "Collin"),
    /invalid_collin_account_id/,
  );
  assert.throws(
    () => validateSalesReconciliationAccountId("R-13743-00L-0900-1", "Dallas"),
    /invalid_dallas_account_id/,
  );
});

test("Collin lookup resolves an undashed MLS reference through the official alias", async () => {
  const calls = [];
  const queryable = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (String(sql).includes("FROM core.accounts requested")) {
        if (params[0] === "R1374300L09001") return { rows: [], rowCount: 0 };
        return {
          rows: [{
            requested_account_id: "2965620",
            account_id: "2965620",
            address: "1808 SHEFFIELD CT",
            city: "CELINA",
            postal_code: "75009",
            county: "Collin",
          }],
          rowCount: 1,
        };
      }
      if (String(sql).includes("app.county_account_identifiers")) {
        assert.deepEqual(params, ["1374300L09001"]);
        return { rows: [{ account_id: "2965620" }], rowCount: 1 };
      }
      throw new Error("unexpected_query");
    },
  };
  const account = await findAccountByCountyIdentifier(
    queryable,
    "R1374300L09001",
  );
  assert.equal(account.account_id, "2965620");
  assert.equal(account.county, "Collin");
  assert.equal(calls.length, 3);
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
