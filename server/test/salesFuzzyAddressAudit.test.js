import assert from "node:assert/strict";
import test from "node:test";

import {
  auditFuzzySalesAddressCandidates,
  rankFuzzyAddressCandidates,
  runFuzzySalesAddressReconciliationBatch,
  selectFuzzyAutoResolutions,
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
        assert.match(statement, /candidate\.city_key = request\.city_key/);
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

function safeFuzzySample(overrides = {}) {
  return {
    source_record_id: 44,
    proposed_account_id: "00000000000000044",
    confidence: "high",
    resolution_state: "candidate_ready",
    score: 0.98,
    score_margin: 0.2,
    eligible_candidate_count: 1,
    previous_match_status: "unmatched",
    raw_parcel_number: "BAD-ID",
    source_components: { base_address_key: "100 MAIN ST" },
    locality_evidence: { city_key: "GARLAND" },
    top_candidates: [{
      account_id: "00000000000000044",
      cad_address: "100 MAIN ST",
      cad_city: "GARLAND",
      cad_postal_code: "75040",
      street_score: 1,
      locality_score: 1,
      candidate_source: "account_alias",
      account_ready: true,
      secondary_incomplete: false,
      secondary_evidence_source: null,
      reasons: [],
    }],
    ...overrides,
  };
}

test("guarded fuzzy selection accepts only a unique complete canonical account", () => {
  const safe = safeFuzzySample();
  const pending = safeFuzzySample({
    source_record_id: 45,
    resolution_state: "awaiting_cad_account_scrape",
    top_candidates: [{
      ...safe.top_candidates[0],
      account_id: "00000000000000045",
      candidate_source: "dcad_residential_target",
      account_ready: false,
    }],
    proposed_account_id: "00000000000000045",
  });
  const inferredUnit = safeFuzzySample({
    source_record_id: 46,
    top_candidates: [{
      ...safe.top_candidates[0],
      account_id: "00000000000000046",
      secondary_evidence_source: "account_id_suffix_review_hint",
    }],
    proposed_account_id: "00000000000000046",
  });
  const ambiguous = safeFuzzySample({
    source_record_id: 47,
    eligible_candidate_count: 2,
  });
  const truncated = safeFuzzySample({
    source_record_id: 48,
    candidate_search_truncated: true,
  });

  const result = selectFuzzyAutoResolutions([
    safe,
    pending,
    inferredUnit,
    ambiguous,
    truncated,
  ]);
  assert.equal(result.eligible.length, 1);
  assert.equal(result.eligible[0].resolution_method, "unique_fuzzy_address");
  assert.equal(result.eligible[0].account_id, "00000000000000044");
  assert.equal(result.eligible[0].evidence.thresholds.minimum_street_score, 0.9);
  assert.equal(result.rejected.length, 4);
  assert.ok(result.rejected[0].reasons.includes("account_not_ready"));
  assert.ok(result.rejected[1].reasons.includes("inferred_secondary_evidence"));
  assert.ok(result.rejected[2].reasons.includes("not_unique"));
  assert.ok(result.rejected[3].reasons.includes("candidate_search_truncated"));
});

test("one-character street typos can auto-resolve only with unique locality evidence", () => {
  const candidate = {
    account_id: "26572500130160000",
    raw_address: "3901 GREENSBORO CIR",
    raw_city: "GARLAND",
    city_key: "GARLAND",
    county_key: "DALLAS",
    postal_code5: "75044",
    candidate_source: "account_alias",
    account_ready: true,
    candidate_pool_count: 1,
    candidate_pool_truncated: false,
  };
  const ranked = rankFuzzyAddressCandidates({
    source_components: parseStructuredAddress("3901 Greensbro Circle"),
    evidence: { city_key: "GARLAND", county_key: "DALLAS", postal_code5: "75044" },
  }, [candidate]);
  const result = selectFuzzyAutoResolutions([safeFuzzySample({
    ...ranked,
    proposed_account_id: candidate.account_id,
    top_candidates: ranked.top_candidates,
  })]);
  assert.equal(ranked.confidence, "high");
  assert.ok(ranked.top_candidates[0].street_score >= 0.9);
  assert.equal(result.eligible.length, 1);
});

test("guarded fuzzy batch remains read-only without the explicit write opt-in", async () => {
  let stratifiedQuerySeen = false;
  const pool = {
    async query(sql) {
      const statement = String(sql);
      if (
        statement.includes("CREATE TABLE IF NOT EXISTS app.sales_auto_reconciliation_history") ||
        statement.includes("CREATE TABLE IF NOT EXISTS app.account_address_aliases")
      ) return { rows: [], rowCount: 0 };
      if (statement.includes("ORDER BY source.close_date DESC NULLS LAST")) {
        stratifiedQuerySeen = statement.includes("WITH ranked_sources");
        return {
          rows: [{
            source_record_id: 44,
            source_name: "Garland sales",
            source_files: ["Garland.csv"],
            source_filename: "Garland.csv",
            raw_payload: { Address: "100 Main Street", City: "Garland", PostalCode: "75040" },
            parcel_number_raw: "BAD-ID",
            match_status: "unmatched",
          }],
          rowCount: 1,
        };
      }
      if (statement.includes("JOIN LATERAL")) {
        return {
          rows: [{
            request_id: "44",
            account_id: "00000000000000044",
            raw_address: "100 MAIN ST",
            raw_city: "GARLAND",
            city_key: "GARLAND",
            county_key: "DALLAS",
            postal_code5: "75040",
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
    async connect() {
      throw new Error("fuzzy dry run must not open a write transaction");
    },
  };

  const result = await runFuzzySalesAddressReconciliationBatch(pool, {
    batchSize: 20,
    stratified: true,
    dryRun: true,
  });
  assert.equal(result.dry_run, true);
  assert.equal(result.writes_performed, 0);
  assert.equal(result.auto_eligible, 1);
  assert.equal(result.resolved, 0);
  assert.equal(stratifiedQuerySeen, true);
});

const FUZZY_APPLY_WRITES = [
  ["parcel_update", "UPDATE core.sale_parcels parcel"],
  ["parcel_insert", "INSERT INTO core.sale_parcels ("],
  ["source_update", "UPDATE core.sales_source_records source"],
  ["sale_update", "UPDATE core.sales sale"],
  ["sale_insert", "INSERT INTO core.sales ("],
  ["history_insert", "INSERT INTO app.sales_auto_reconciliation_history ("],
];
const FUZZY_TRANSACTION_STEPS = ["BEGIN", "source_lock", ...FUZZY_APPLY_WRITES.map(([name]) => name), "COMMIT"];

function fuzzyTransactionHarness({
  ids = [44], lockedIds = ids, eligible = true, failAt = null,
  primaryError = new Error("synthetic private primary failure"), rollbackFails = false,
  auditFailureAt = null, checkoutError = null, releaseThrows = false, releaseError,
  rollbackThrows = false, beforeRollback = () => undefined, releaseReturn,
} = {}) {
  const auditQueries = [], clientQueries = [], releases = [];
  let checkouts = 0;
  const rollbackError = Object.assign(new Error("synthetic private rollback detail " + "sensitive-value ".repeat(50)), {
    detail: "synthetic-private-sql", code: "SYNTHETIC_PRIVATE_CODE",
  });
  const sourceRows = ids.map(id => ({
    source_record_id: id, listing_id: `SYNTHETIC-${id}`, source_name: "Synthetic Garland sales",
    source_files: ["Synthetic Garland.csv"], source_filename: "Synthetic Garland.csv", source_row_number: id,
    raw_payload: { Address: `${id + 56} Main Street`, City: "Garland", PostalCode: "75040", County: "Dallas County" },
    parcel_number_raw: `BAD-${id}`, match_status: "unmatched",
  }));
  const client = {
    query(sql, params) {
      const statement = String(sql).trim();
      const step = ["BEGIN", "COMMIT", "ROLLBACK"].includes(statement) ? statement
        : statement.includes("FOR UPDATE OF source") ? "source_lock"
          : FUZZY_APPLY_WRITES.find(([, fragment]) => statement.includes(fragment))?.[0];
      assert.ok(step, `unexpected owned-client query: ${statement.slice(0, 90)}`);
      clientQueries.push({ step, statement, params });
      if (step === "ROLLBACK") {
        if (rollbackThrows) throw rollbackError;
        return Promise.resolve(beforeRollback()).then(() => {
          if (rollbackFails) throw rollbackError;
          return { rows: [], rowCount: 0 };
        });
      }
      if (step === failAt) return Promise.reject(primaryError);
      if (step === "source_lock") return Promise.resolve({ rows: lockedIds.map(id => ({ id })), rowCount: lockedIds.length });
      if (step === "source_update") return Promise.resolve({ rows: lockedIds.map(id => ({ id })), rowCount: lockedIds.length });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release(...args) {
      releases.push(args);
      if (releaseThrows) throw releaseError;
      return releaseReturn;
    },
  };
  const pool = {
    async query(sql, params) {
      const statement = String(sql);
      const step = statement.includes("CREATE TABLE IF NOT EXISTS app.sales_auto_reconciliation_history") ? "reconciliation_schema"
        : statement.includes("CREATE TABLE IF NOT EXISTS app.account_address_aliases") ? "alias_schema"
          : statement.includes("ORDER BY source.close_date DESC NULLS LAST") ? "source_audit"
            : statement.includes("JOIN LATERAL") ? "alias_candidates"
              : statement.includes("FROM app.dcad_residential_targets target") ? "pending_candidates" : null;
      assert.ok(step, `unexpected audit query: ${statement.slice(0, 90)}`);
      auditQueries.push({ step, statement, params });
      if (step === auditFailureAt) throw primaryError;
      if (step === "source_audit") return { rows: sourceRows, rowCount: sourceRows.length };
      if (step === "alias_candidates") {
        const requested = JSON.parse(params[0]);
        const rows = eligible ? requested.map(item => ({
          request_id: item.request_id, account_id: String(item.request_id).padStart(17, "0"),
          raw_address: `${Number(item.request_id) + 56} MAIN ST`, raw_city: "GARLAND",
          city_key: "GARLAND", county_key: "DALLAS", postal_code5: "75040",
          candidate_source: "account_alias", account_ready: true,
          candidate_pool_count: 1, candidate_pool_truncated: false,
        })) : [];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      checkouts++;
      if (checkoutError) throw checkoutError;
      return client;
    },
  };
  return { pool, auditQueries, clientQueries, releases, primaryError, rollbackError,
    get checkouts() { return checkouts; },
    get steps() { return clientQueries.map(query => query.step); },
  };
}

function expectedFuzzyResolution(id) {
  return {
    source_record_id: id, account_id: String(id).padStart(17, "0"), resolution_method: "unique_fuzzy_address",
    previous_match_status: "unmatched", raw_parcel_number: `BAD-${id}`,
    address_key: `${id + 56} MAIN ST`, city_key: "GARLAND", match_score: 1, score_margin: 1,
    evidence: { candidate_source: "account_alias", cad_address: `${id + 56} MAIN ST`, cad_city: "GARLAND",
      cad_postal_code: "75040", street_score: 1, locality_score: 1, reasons: ["street_exact"],
      thresholds: { minimum_score: 0.94, minimum_street_score: 0.9, minimum_locality_score: 0.7, minimum_margin: 0.08 } },
  };
}

function assertReusableClient(harness) {
  assert.equal(harness.releases.length, 1, "the owning batch releases its client exactly once");
  assert.ok(harness.releases[0].length <= 1);
  assert.equal(harness.releases[0][0], undefined, "successful commit or rollback leaves the client reusable");
}

for (const failAt of FUZZY_TRANSACTION_STEPS) for (const rollbackFails of [false, true]) {
  test(`fuzzy reconciliation ${failAt} failure preserves primary error with ${rollbackFails ? "failed" : "successful"} rollback`, async () => {
    const h = fuzzyTransactionHarness({ failAt, rollbackFails });
    await assert.rejects(runFuzzySalesAddressReconciliationBatch(h.pool, { dryRun: false }), error => {
      assert.equal(error, h.primaryError, "rollback failure must not replace the original thrown object");
      return true;
    });
    assert.equal(h.checkouts, 1);
    assert.deepEqual(h.steps, [...FUZZY_TRANSACTION_STEPS.slice(0, FUZZY_TRANSACTION_STEPS.indexOf(failAt) + 1), "ROLLBACK"]);
    assert.equal(h.releases.length, 1);
    if (!rollbackFails) {
      assertReusableClient(h);
      return;
    }
    assert.equal(h.releases[0].length, 1);
    const discard = h.releases[0][0];
    assert.ok(discard instanceof Error, "an uncertain transaction client must be retired, not returned to the pool");
    assert.notEqual(discard, h.primaryError);
    assert.notEqual(discard, h.rollbackError);
    assert.equal(discard.message, "sales_fuzzy_reconciliation_rollback_failed");
    assert.equal(Object.hasOwn(discard, "cause"), false);
    assert.deepEqual(Object.keys(discard), [], "the retirement marker carries no SQL, connection details, or raw error fields");
    assert.doesNotMatch(String(discard.stack), /synthetic private|sensitive-value|synthetic-private-sql|SYNTHETIC_PRIVATE_CODE/);
  });
}

for (const { name, failAt, rollbackFails, releaseError } of [
  { name: "successful commit", failAt: null, rollbackFails: false, releaseError: new Error("synthetic release failure") },
  { name: "primary failure and successful rollback", failAt: "COMMIT", rollbackFails: false, releaseError: Symbol("synthetic release value") },
  { name: "primary failure and failed rollback", failAt: "sale_update", rollbackFails: true, releaseError: Object.freeze({ release: "synthetic failure" }) },
]) {
  test(`fuzzy reconciliation preserves synchronous release throw after ${name}`, async () => {
    const h = fuzzyTransactionHarness({ failAt, rollbackFails, releaseThrows: true, releaseError });
    await assert.rejects(runFuzzySalesAddressReconciliationBatch(h.pool, { dryRun: false }), error => {
      assert.equal(error, releaseError, "the exact value thrown by release must escape the public wrapper");
      return true;
    });
    assert.equal(h.checkouts, 1);
    assert.deepEqual(h.steps, failAt
      ? [...FUZZY_TRANSACTION_STEPS.slice(0, FUZZY_TRANSACTION_STEPS.indexOf(failAt) + 1), "ROLLBACK"]
      : FUZZY_TRANSACTION_STEPS, "a release throw must not retry, roll back a committed transaction, or repeat cleanup");
    assert.equal(h.releases.length, 1);
    assert.equal(h.releases[0].length, 1);
    if (!rollbackFails) {
      assert.equal(h.releases[0][0], undefined);
      return;
    }
    const discard = h.releases[0][0];
    assert.ok(discard instanceof Error);
    assert.equal(discard.message, "sales_fuzzy_reconciliation_rollback_failed");
    assert.notEqual(discard, h.primaryError);
    assert.notEqual(discard, h.rollbackError);
    assert.notEqual(discard, releaseError);
    assert.equal(Object.hasOwn(discard, "cause"), false);
    assert.deepEqual(Object.keys(discard), []);
    assert.doesNotMatch(String(discard.stack), /synthetic private|sensitive-value|synthetic-private-sql|SYNTHETIC_PRIVATE_CODE/);
  });
}

test("fuzzy reconciliation successful transaction retains all six apply writes, guarded lock, and decision payload", async () => {
  const h = fuzzyTransactionHarness({ ids: [44, 45] });
  const result = await runFuzzySalesAddressReconciliationBatch(h.pool, { batchSize: 20, candidatesPerSale: 25, stratified: true, dryRun: false });
  assert.deepEqual(h.steps, FUZZY_TRANSACTION_STEPS);
  assertReusableClient(h);
  assert.equal(h.checkouts, 1);
  assert.deepEqual({
    dry_run: result.dry_run, selection_mode: result.selection_mode, sample_size: result.sample_size,
    high_confidence: result.high_confidence, review: result.review, low_confidence: result.low_confidence,
    auto_eligible: result.auto_eligible, rejected: result.rejected, resolved: result.resolved, writes_performed: result.writes_performed,
    source_summary: result.source_summary,
  }, {
    dry_run: false, selection_mode: "source_stratified", sample_size: 2, high_confidence: 2, review: 0, low_confidence: 0,
    auto_eligible: 2, rejected: 0, resolved: 2, writes_performed: 2,
    source_summary: { "Synthetic Garland.csv": { high: 2, review: 0, low: 0 } },
  });
  assert.deepEqual(result.sample.map(item => [item.source_record_id, item.proposed_account_id, item.confidence]), [
    [44, "00000000000000044", "high"], [45, "00000000000000045", "high"],
  ]);
  const lock = h.clientQueries[1];
  assert.match(lock.statement, /FOR UPDATE OF source/);
  assert.match(lock.statement, /source\.match_status <> 'manual_verified'/);
  assert.match(lock.statement, /source\.match_status = 'unmatched'/);
  assert.match(lock.statement, /source\.primary_account_id IS NULL/);
  assert.match(lock.statement, /account\.canonical_account_id IS NULL/);
  assert.match(lock.statement, /NULLIF\(btrim\(account\.address\), ''\) IS NOT NULL/);
  for (const query of h.clientQueries.slice(1, -1)) {
    assert.equal(query.params.length, 1);
    assert.deepEqual(JSON.parse(query.params[0]), [expectedFuzzyResolution(44), expectedFuzzyResolution(45)]);
  }
});

test("fuzzy reconciliation commits an empty lock without apply writes and returns zero resolved", async () => {
  const h = fuzzyTransactionHarness({ lockedIds: [] });
  const result = await runFuzzySalesAddressReconciliationBatch(h.pool, { dryRun: false });
  assert.deepEqual(h.steps, ["BEGIN", "source_lock", "COMMIT"]);
  assertReusableClient(h);
  assert.equal(result.auto_eligible, 1);
  assert.equal(result.resolved, 0);
  assert.equal(result.writes_performed, 0);
});

test("fuzzy reconciliation filters every apply payload to the source rows actually locked", async () => {
  const h = fuzzyTransactionHarness({ ids: [44, 45], lockedIds: [45] });
  const result = await runFuzzySalesAddressReconciliationBatch(h.pool, { dryRun: false });
  assert.deepEqual(h.steps, FUZZY_TRANSACTION_STEPS);
  assertReusableClient(h);
  assert.deepEqual(JSON.parse(h.clientQueries[1].params[0]), [expectedFuzzyResolution(44), expectedFuzzyResolution(45)]);
  for (const query of h.clientQueries.slice(2, -1)) assert.deepEqual(JSON.parse(query.params[0]), [expectedFuzzyResolution(45)]);
  assert.equal(result.auto_eligible, 2);
  assert.equal(result.resolved, 1);
  assert.equal(result.writes_performed, 1);
});

for (const dryRun of [undefined, true, false]) {
  test(`fuzzy reconciliation without eligible candidates owns no client (dryRun=${String(dryRun)})`, async () => {
    const h = fuzzyTransactionHarness({ eligible: false });
    const result = await runFuzzySalesAddressReconciliationBatch(h.pool, dryRun === undefined ? {} : { dryRun });
    assert.equal(result.dry_run, dryRun !== false);
    assert.equal(result.auto_eligible, 0); assert.equal(result.rejected, 1);
    assert.equal(result.resolved, 0); assert.equal(result.writes_performed, 0);
    assert.deepEqual(result.auto_eligible_sample, []);
    assert.equal(h.checkouts, 0); assert.deepEqual(h.clientQueries, []); assert.deepEqual(h.releases, []);
  });
}

for (const options of [{}, { dryRun: true }]) {
  test(`eligible fuzzy ${Object.hasOwn(options, "dryRun") ? "explicit" : "default"} dry run owns no client`, async () => {
    const h = fuzzyTransactionHarness();
    const result = await runFuzzySalesAddressReconciliationBatch(h.pool, options);
    assert.equal(result.dry_run, true); assert.equal(result.auto_eligible, 1);
    assert.equal(result.resolved, 0); assert.equal(result.writes_performed, 0);
    assert.deepEqual(result.auto_eligible_sample, [expectedFuzzyResolution(44)]);
    assert.equal(h.checkouts, 0); assert.deepEqual(h.clientQueries, []); assert.deepEqual(h.releases, []);
  });
}

for (const auditFailureAt of ["reconciliation_schema", "alias_schema", "source_audit", "alias_candidates", "pending_candidates"]) {
  test(`fuzzy ${auditFailureAt} failure does not release a client it never acquired`, async () => {
    const h = fuzzyTransactionHarness({ auditFailureAt });
    await assert.rejects(runFuzzySalesAddressReconciliationBatch(h.pool, { dryRun: false }), error => error === h.primaryError);
    assert.equal(h.checkouts, 0); assert.deepEqual(h.clientQueries, []); assert.deepEqual(h.releases, []);
  });
}

test("fuzzy checkout failure preserves the error without querying or releasing an unowned client", async () => {
  const checkoutError = new Error("synthetic checkout failure");
  const h = fuzzyTransactionHarness({ checkoutError });
  await assert.rejects(runFuzzySalesAddressReconciliationBatch(h.pool, { dryRun: false }), error => error === checkoutError);
  assert.equal(h.checkouts, 1); assert.deepEqual(h.clientQueries, []); assert.deepEqual(h.releases, []);
});

function assertFuzzyDiscard(h) {
  assert.equal(h.checkouts, 1);
  assert.equal(h.releases.length, 1);
  assert.equal(h.releases[0].length, 1);
  const [marker] = h.releases[0];
  assert.ok(marker instanceof Error);
  assert.equal(marker.message, "sales_fuzzy_reconciliation_rollback_failed");
  assert.notEqual(marker, h.primaryError);
  assert.notEqual(marker, h.rollbackError);
  assert.equal(Object.hasOwn(marker, "cause"), false);
  assert.deepEqual(Object.keys(marker), []);
  assert.doesNotMatch(marker.stack, /synthetic private|sensitive-value|synthetic-private-sql|SYNTHETIC_PRIVATE_CODE/);
}

for (const failAt of FUZZY_TRANSACTION_STEPS) {
  test(`fuzzy reconciliation ${failAt} failure survives a synchronous rollback throw`, async () => {
    const h = fuzzyTransactionHarness({ failAt, rollbackThrows: true });
    await assert.rejects(runFuzzySalesAddressReconciliationBatch(h.pool, { dryRun: false }), error => error === h.primaryError);
    assert.deepEqual(h.steps, [...FUZZY_TRANSACTION_STEPS.slice(0, FUZZY_TRANSACTION_STEPS.indexOf(failAt) + 1), "ROLLBACK"]);
    assertFuzzyDiscard(h);
  });
}

for (const rollbackFails of [false, true]) {
  test(`fuzzy reconciliation awaits rollback ${rollbackFails ? "failure" : "success"} before releasing or rejecting`, async () => {
    let finishRollback;
    const gate = new Promise(resolve => { finishRollback = resolve; });
    const h = fuzzyTransactionHarness({ failAt: "history_insert", rollbackFails, beforeRollback: () => gate });
    let settled = false;
    const pending = runFuzzySalesAddressReconciliationBatch(h.pool, { dryRun: false }).then(
      value => { settled = true; return { value }; },
      error => { settled = true; return { error }; },
    );
    try {
      await new Promise(resolve => setImmediate(resolve));
      const completedAudit = h.auditQueries.slice();
      assert.equal(completedAudit.length, 5);
      assert.equal(h.checkouts, 1);
      assert.deepEqual(h.steps, [...FUZZY_TRANSACTION_STEPS.slice(0, -1), "ROLLBACK"]);
      assert.deepEqual(h.releases, []);
      assert.equal(settled, false);
      finishRollback();
      assert.equal((await pending).error, h.primaryError);
      assert.deepEqual(h.auditQueries, completedAudit, "cleanup must not replay pre-checkout audit work");
      assert.deepEqual(h.steps, [...FUZZY_TRANSACTION_STEPS.slice(0, -1), "ROLLBACK"]);
      assert.equal(h.checkouts, 1);
      if (rollbackFails) assertFuzzyDiscard(h);
      else assertReusableClient(h);
    } finally {
      finishRollback();
      await pending;
    }
  });
}

test("fuzzy reconciliation leaves synchronous release return values unobserved", async () => {
  let thenReads = 0;
  const releaseReturn = { get then() { thenReads += 1; throw new Error("release return must remain unobserved"); } };
  for (const options of [{}, { failAt: "COMMIT" }, { failAt: "COMMIT", rollbackFails: true }]) {
    const h = fuzzyTransactionHarness({ ...options, releaseReturn });
    if (options.failAt) {
      await assert.rejects(runFuzzySalesAddressReconciliationBatch(h.pool, { dryRun: false }), error => error === h.primaryError);
    } else assert.equal((await runFuzzySalesAddressReconciliationBatch(h.pool, { dryRun: false })).resolved, 1);
    assert.equal(thenReads, 0);
    assert.equal(h.checkouts, 1);
    assert.deepEqual(h.steps, [...FUZZY_TRANSACTION_STEPS, ...(options.failAt ? ["ROLLBACK"] : [])]);
    if (options.rollbackFails) assertFuzzyDiscard(h);
    else assertReusableClient(h);
  }
});
