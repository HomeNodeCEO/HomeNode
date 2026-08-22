import assert from "node:assert/strict";
import test from "node:test";

import {
  auditFuzzySalesAddressCandidates,
  rankFuzzyAddressCandidates,
} from "../src/services/salesFuzzyAddressAudit.js";
import { parseStructuredAddress } from "../src/util/structuredAddress.js";

test("fuzzy address audit recognizes suite and number variants without writes", async () => {
  let candidateQuerySeen = false;
  const pool = {
    async query(sql, params) {
      const statement = String(sql);
      if (
        statement.includes("CREATE TABLE IF NOT EXISTS app.sales_auto_reconciliation_history") ||
        statement.includes("CREATE TABLE IF NOT EXISTS app.account_address_aliases")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.includes("ORDER BY source.close_date DESC NULLS LAST")) {
        return {
          rows: [{
            source_record_id: 51992,
            listing_id: "21156236",
            source_name: "NTREIS Irving two-year sales 2026-08-18",
            source_files: ["Irving Two Year Sales 08.18.26.csv"],
            source_filename: "Irving Two Year Sales 08.18.26.csv",
            source_row_number: 2483,
            raw_payload: {
              Address: "4831 Fuller Court #1104",
              City: "Irving",
              PostalCode: "75038",
            },
            parcel_number_raw: "000",
          }],
          rowCount: 1,
        };
      }
      if (statement.includes("JOIN LATERAL")) {
        candidateQuerySeen = true;
        const requested = JSON.parse(params[0]);
        assert.deepEqual(requested[0], {
          request_id: "51992",
          house_number: "4831",
          city_key: "IRVING",
          postal_code5: "75038",
        });
        return {
          rows: [{
            request_id: "51992",
            account_id: "321234500A1104000",
            raw_address: "4831 FULLER CT SUITE: 1104",
            raw_city: "IRVING",
            city_key: "IRVING",
            county_key: "DALLAS",
            postal_code5: "75038",
            candidate_source: "account_alias",
            account_ready: true,
          }],
          rowCount: 1,
        };
      }
      if (statement.includes("FROM app.dcad_residential_targets target")) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`unexpected query: ${statement.slice(0, 100)}`);
    },
  };
  pool.connect = async () => {
    throw new Error("dry-run fuzzy audit must never open a write transaction");
  };

  const result = await auditFuzzySalesAddressCandidates(pool, { sampleSize: 20 });
  assert.equal(candidateQuerySeen, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.writes_performed, 0);
  assert.equal(result.sample_size, 1);
  assert.equal(result.high_confidence, 1);
  assert.equal(result.sample[0].proposed_account_id, "321234500A1104000");
  assert.ok(result.sample[0].score > 0.99);
});

test("pending Dallas targets surface the matching condo unit as review evidence", async () => {
  const pool = {
    async query(sql) {
      const statement = String(sql);
      if (
        statement.includes("CREATE TABLE IF NOT EXISTS app.sales_auto_reconciliation_history") ||
        statement.includes("CREATE TABLE IF NOT EXISTS app.account_address_aliases")
      ) return { rows: [], rowCount: 0 };
      if (statement.includes("ORDER BY source.close_date DESC NULLS LAST")) {
        return {
          rows: [{
            source_record_id: 51992,
            listing_id: "21156236",
            source_name: "NTREIS Irving two-year sales 2026-08-18",
            source_files: ["Irving Two Year Sales 08.18.26.csv"],
            source_filename: "Irving Two Year Sales 08.18.26.csv",
            source_row_number: 2483,
            raw_payload: { Address: "4831 Fuller Court #1104", City: "Irving" },
            parcel_number_raw: "000",
          }],
          rowCount: 1,
        };
      }
      if (statement.includes("JOIN LATERAL")) return { rows: [], rowCount: 0 };
      if (statement.includes("FROM app.dcad_residential_targets target")) {
        return {
          rows: [1101, 1102, 1103, 1104, 1105, 1106].map((unit) => ({
            request_id: "51992",
            account_id: `32C1292000000${unit}`,
            raw_address: "4831 FULLER CT",
            raw_city: "IRVING",
            city_key: "IRVING",
            county_key: "DALLAS",
            postal_code5: null,
            candidate_source: "dcad_residential_target",
            account_ready: false,
            target_completed_at: null,
          })),
          rowCount: 6,
        };
      }
      throw new Error(`unexpected query: ${statement.slice(0, 100)}`);
    },
  };
  pool.connect = async () => {
    throw new Error("dry-run fuzzy audit must never open a write transaction");
  };

  const result = await auditFuzzySalesAddressCandidates(pool, { sampleSize: 20 });
  assert.equal(result.writes_performed, 0);
  assert.equal(result.sample[0].proposed_account_id, "32C12920000001104");
  assert.equal(result.sample[0].confidence, "review");
  assert.equal(result.sample[0].resolution_state, "awaiting_cad_account_scrape");
  assert.equal(
    result.sample[0].top_candidates[0].secondary_evidence_source,
    "account_id_suffix_review_hint",
  );
});

test("a repeated unit number across buildings stays ambiguous without building evidence", () => {
  const item = {
    source_components: parseStructuredAddress("100 Main Street Apt 12"),
    evidence: { city_key: "IRVING", county_key: "DALLAS", postal_code5: "75038" },
  };
  const candidates = [1, 2].map((building) => ({
    account_id: `ACCOUNT-${building}`,
    raw_address: `100 MAIN ST BUILDING ${building} SUITE 12`,
    raw_city: "IRVING",
    city_key: "IRVING",
    county_key: "DALLAS",
    postal_code5: "75038",
  }));
  const result = rankFuzzyAddressCandidates(item, candidates);
  assert.equal(result.confidence, "review");
  assert.equal(result.score_margin, 0);
  assert.equal(result.eligible_candidate_count, 2);
  assert.equal(result.top_candidates[0].secondary_incomplete, true);
});

test("explicit building evidence selects the correct repeated unit", () => {
  const item = {
    source_components: parseStructuredAddress("100 Main Street Bldg 1 Apt 12"),
    evidence: { city_key: "IRVING", county_key: "DALLAS", postal_code5: "75038" },
  };
  const candidates = [1, 2].map((building) => ({
    account_id: `ACCOUNT-${building}`,
    raw_address: `100 MAIN ST BUILDING ${building} SUITE 12`,
    raw_city: "IRVING",
    city_key: "IRVING",
    county_key: "DALLAS",
    postal_code5: "75038",
  }));
  const result = rankFuzzyAddressCandidates(item, candidates);
  assert.equal(result.confidence, "high");
  assert.equal(result.proposed_account_id, "ACCOUNT-1");
  assert.equal(result.eligible_candidate_count, 1);
});
