import assert from "node:assert/strict";
import test from "node:test";

import {
  auditSalesAutoReconciliation,
  cityHintFromSalesSource,
  runSalesAutoReconciliationBatch,
  salesAddressMatchEvidence,
} from "../src/services/salesAutoReconciliation.js";

test("sales address evidence canonicalizes MLS suffixes and place names", () => {
  assert.deepEqual(
    salesAddressMatchEvidence({
      Address: "3901 Greensboro Circle, Garland, TX 75044",
      County: "Dallas County",
    }),
    {
      address_hint: "3901 Greensboro Circle, Garland, TX 75044",
      address_key: "3901 GREENSBORO CIR",
      city_key: "GARLAND",
      city_source: "address",
      county_key: "DALLAS",
      postal_code5: "75044",
    },
  );
});

test("sales source filenames supply a conservative city fallback", () => {
  assert.equal(
    cityHintFromSalesSource("MLS sales export", ["University Park Two Year Sales.csv"]),
    "UNIVERSITY PARK",
  );
  assert.equal(cityHintFromSalesSource("MLS sales export", ["unknown.csv"]), null);
});

test("unit fragments are not mistaken for a city", () => {
  const evidence = salesAddressMatchEvidence({
    Address: "4831 Fuller Court, #1104, Irving, TX 75038",
  });
  assert.equal(evidence.city_key, "IRVING");
  assert.equal(evidence.city_source, "address");
});

function auditPool() {
  return {
    async query(sql, params) {
      const statement = String(sql);
      if (
        statement.includes("CREATE TABLE IF NOT EXISTS app.sales_auto_reconciliation_history") ||
        statement.includes("CREATE TABLE IF NOT EXISTS app.account_address_aliases")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.includes("source.has_unresolved_parcel = true")) {
        return {
          rows: [{
            source_record_id: 3901,
            primary_account_id: "26572500130160000",
            match_status: "address",
            parcel_number_raw: "265725500130160000",
          }],
          rowCount: 1,
        };
      }
      if (statement.includes("source.match_status = 'unmatched'")) {
        return {
          rows: [
            {
              source_record_id: 44,
              match_status: "unmatched",
              parcel_number_raw: "000",
              raw_payload: { Address: "100 Main Street", City: "Garland" },
            },
            {
              source_record_id: 45,
              match_status: "unmatched",
              parcel_number_raw: "BAD-ID",
              raw_payload: { Address: "200 Oak Road", City: "Garland" },
            },
          ],
          rowCount: 2,
        };
      }
      if (statement.includes("app.account_address_aliases")) {
        const requested = JSON.parse(params[0]);
        assert.equal(requested[0].address_key, "100 MAIN ST");
        assert.equal(requested[1].address_key, "200 OAK RD");
        return {
          rows: [{ request_id: "44", account_id: "00000000000000044" }],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected query: ${statement.slice(0, 80)}`);
    },
  };
}

test("dry-run audit separates trusted links from unique exact address matches", async () => {
  const result = await auditSalesAutoReconciliation(auditPool(), { batchSize: 25 });
  assert.equal(result.dry_run, true);
  assert.equal(result.trusted_existing_links, 1);
  assert.equal(result.unique_exact_addresses, 1);
  assert.equal(result.inspected_unmatched_addresses, 2);
  assert.equal(result.total_auto_resolvable, 2);
  assert.deepEqual(
    result.sample.map((item) => item.resolution_method),
    ["trusted_existing_link", "unique_exact_address"],
  );
});

test("batch dry run never opens a write transaction", async () => {
  const pool = auditPool();
  pool.connect = async () => {
    throw new Error("dry run must not connect for writes");
  };
  const result = await runSalesAutoReconciliationBatch(pool, {
    batchSize: 25,
    dryRun: true,
  });
  assert.equal(result.resolved, 0);
  assert.equal(result.remaining_candidate_count, 2);
});

