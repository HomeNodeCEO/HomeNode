import assert from "node:assert/strict";
import test from "node:test";
import { buildCachedNeighborhoodInputs } from "../src/services/neighborhoodAssessment/cachedRecords.js";
import { summarizeNeighborhoodPopulations } from "../src/services/neighborhoodAssessment/statistics.js";

const temporal = { historical_support: "reconstructed", valid_from: "2023-01-01", valid_to: null };
const source = (id, rows, options = {}) => ({ id, state: rows.length ? "populated" : "present_empty",
  complete: true, revision: "capture-1", content_sha256: "a".repeat(64), captured_at: "2026-01-01T00:00:00.000Z",
  visibility: "public", scope: null, rows, ...options });
const parcel = (account_id, options = {}) => ({ account_id, residential_year_built: 2004,
  residential_area_sqft: 2000, parcel_area_sqft: 8000, land_use_category: "one_unit",
  subdivision_key: "city:plat:phase-a", current_market_value: 280_000, tax_year: 2024, ...temporal, ...options });
const transaction = (sale_id, account_id, options = {}) => ({ sale_id, source_record_id: `source-${sale_id}`,
  primary_account_id: account_id, closing_date: "2024-03-01", sale_price: 300_000,
  record_type: "closed_sale", market_eligible: true, parcel_links_complete: true, ...temporal, ...options });
const link = (sale_id, account_id, options = {}) => ({ source_record_id: `source-${sale_id}`, account_id,
  is_resolved: true, match_method: "exact", gla_sqft_at_sale: 2000, ...temporal, ...options });
function fixture() {
  return { scope: { organization_id: "org-1", appraisal_case_id: "case-1", subject_snapshot_id: "snapshot-1", account_id: "P1" },
    population_id: "selected-a", effective_date: "2024-06-30",
    observation_period: { start_date: "2023-07-01", end_date: "2024-06-30" },
    selection: { account_ids: ["P1", "P2", "P3", "P4"], eligible_housing_types: ["one_unit"], subject_subdivision_key: "city:plat:phase-a" },
    sources: {
      parcels: source("parcel-snapshot", ["P1", "P2", "P3", "P4"].map(account => parcel(account))),
      accounts: source("account-snapshot", [], { state: "absent", complete: false, revision: null, content_sha256: null }),
      transactions: source("sale-snapshot", [transaction("T1", "P1"), transaction("T2", "P1", { sale_price: 330_000 }), transaction("T3", "P3", { sale_price: 400_000 })]),
      sale_links: source("link-snapshot", [link("T1", "P1"), link("T2", "P1"), link("T3", "P3")]),
    } };
}

test("versioned captured rows produce frozen scoped kernel inputs without wall-clock calculations", () => {
  const input = fixture();
  const result = buildCachedNeighborhoodInputs(input);
  assert.equal(result.status, "ready");
  assert.ok(Object.isFrozen(result.statistics_input.stock[0]));
  const summary = summarizeNeighborhoodPopulations(result.statistics_input);
  assert.equal(summary.stock.age_at_effective_date.median, 20);
  assert.equal(summary.stock.year_built.median, 2004);
  assert.equal(summary.sales.property_sale_price.median, 330_000);
  assert.equal(summary.sales.unique_price_eligible_account_coverage_percent, 50);
  assert.equal(summary.sales.sale_price_per_sqft.median, 165);
  input.sources.parcels.rows[0].residential_area_sqft = 9999;
  assert.equal(result.statistics_input.stock.find(row => row.account_id === "P1").gla_sqft, 2000);
  assert.equal(result.source_snapshots[0].revision, "capture-1");
  assert.equal(result.source_snapshots[0].content_sha256, "a".repeat(64));
});

test("optional absent, present-empty, populated and truncated sources remain distinguishable", () => {
  const absent = fixture();
  assert.equal(buildCachedNeighborhoodInputs(absent).source_snapshots.find(row => row.key === "accounts").state, "absent");
  const empty = fixture(); empty.sources.accounts = source("account-snapshot", []);
  assert.equal(buildCachedNeighborhoodInputs(empty).source_snapshots.find(row => row.key === "accounts").state, "present_empty");
  const populated = fixture(); populated.sources.accounts = source("account-snapshot", [parcel("P1")]);
  assert.equal(buildCachedNeighborhoodInputs(populated).source_snapshots.find(row => row.key === "accounts").state, "populated");
  const truncated = fixture(); truncated.sources.parcels.state = "truncated"; truncated.sources.parcels.complete = false;
  const result = buildCachedNeighborhoodInputs(truncated);
  assert.equal(result.status, "incomplete");
  assert.ok(result.incomplete_reasons.includes("parcels:truncated"));
  assert.equal(result.statistics_input.stock.length, 4, "no supplied member silently truncated");
  const unknown = fixture(); unknown.sources.parcels.complete = null;
  assert.ok(buildCachedNeighborhoodInputs(unknown).incomplete_reasons.includes("parcels:coverage_unknown"));
  const noSales = fixture(); noSales.sources.transactions = source("sale-snapshot", []);
  assert.equal(buildCachedNeighborhoodInputs(noSales).status, "ready", "known-empty capture is not an absent source");
  noSales.sources.transactions = { ...noSales.sources.transactions, state: "absent", complete: false, revision: null, content_sha256: null };
  assert.ok(buildCachedNeighborhoodInputs(noSales).incomplete_reasons.includes("transactions:absent"));
});

test("invalid source versions, scope, date inputs and contradictory state descriptions are rejected", () => {
  for (const mutate of [
    input => { input.sources.parcels.revision = null; },
    input => { input.sources.parcels.content_sha256 = "not-a-hash"; },
    input => { input.sources.parcels.state = "present_empty"; },
    input => { input.sources.parcels.state = "truncated"; },
    input => { delete input.sources.accounts; },
    input => { input.sources.parcels.captured_at = "2026-02-31T00:00:00.000Z"; },
    input => { input.sources.parcels.visibility = "assignment_private"; input.sources.parcels.scope = { ...input.scope, organization_id: "other-org" }; },
    input => { input.effective_date = "2024-06-31"; },
    input => { input.observation_period.end_date = "2024-07-01"; },
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => buildCachedNeighborhoodInputs(input));
  }
  const privateInput = fixture(); privateInput.sources.accounts = source("account-snapshot", [parcel("P1")], {
    visibility: "assignment_private", scope: { ...privateInput.scope },
  });
  assert.equal(buildCachedNeighborhoodInputs(privateInput).source_snapshots.find(row => row.key === "accounts").scope.appraisal_case_id, "case-1");
});

test("same subdivision preserves geographic visibility but cannot override wrong or unknown housing", () => {
  const input = fixture();
  input.sources.parcels.rows[1].land_use_category = "commercial";
  input.sources.parcels.rows[2].land_use_category = null;
  const result = buildCachedNeighborhoodInputs(input);
  const wrong = result.geographic_members.find(row => row.account_id === "P2");
  assert.equal(wrong.same_subject_subdivision, true);
  assert.equal(wrong.geographic_visibility, "retained");
  assert.equal(wrong.competitive_eligibility, "ineligible");
  assert.equal(result.geographic_members.find(row => row.account_id === "P3").competitive_eligibility, "unknown");
  assert.deepEqual([...new Set(result.statistics_input.stock.map(row => row.account_id))], ["P1", "P4"]);
  assert.equal(result.status, "incomplete");
});

test("current-only/unknown physical facts are visible but never silently used historically", () => {
  const input = fixture();
  input.sources.parcels.rows[0].historical_support = "current_only";
  delete input.sources.parcels.rows[1].valid_from;
  const result = buildCachedNeighborhoodInputs(input);
  assert.equal(result.statistics_input.stock.some(row => row.account_id === "P1"), false);
  assert.equal(result.statistics_input.stock.some(row => row.account_id === "P2"), false);
  assert.equal(result.geographic_members.find(row => row.account_id === "P1").captured_facts[0].gla_sqft, 2000);
  assert.equal(result.geographic_members.find(row => row.account_id === "P1").captured_facts[0].supported, false);
  assert.equal(result.diagnostics.unsupported_temporal_fact_rows, 2);
});

test("missing/invalid GLA and unvintaged current assessments never become zero or inferred historic values", () => {
  const input = fixture();
  input.sources.parcels.rows[0].residential_area_sqft = null;
  input.sources.parcels.rows[1].residential_area_sqft = 0;
  input.sources.parcels.rows[2].residential_area_sqft = "";
  for (const row of input.sources.parcels.rows) delete row.tax_year;
  for (const row of input.sources.sale_links.rows) delete row.gla_sqft_at_sale;
  const result = buildCachedNeighborhoodInputs(input);
  const summary = summarizeNeighborhoodPopulations(result.statistics_input);
  assert.equal(summary.stock.gla_sqft.count, 1);
  assert.equal(summary.stock.gla_sqft.median, 2000);
  assert.deepEqual(summary.stock.assessed_values_by_tax_year, []);
  assert.equal(summary.sales.sale_price_per_sqft.count, 0, "current parcel GLA cannot stand in for GLA at sale");
});

test("repeated sales and duplicate cache representations retain canonical identities with no price duplication", () => {
  const input = fixture(); input.sources.transactions.rows.push({ ...input.sources.transactions.rows[0] });
  const result = buildCachedNeighborhoodInputs(input);
  const summary = summarizeNeighborhoodPopulations(result.statistics_input);
  assert.equal(summary.sales.transaction_count, 3);
  assert.equal(summary.sales.diagnostics.duplicate_records, 1);
  assert.equal(summary.sales.unique_price_eligible_account_count, 2);
  assert.deepEqual([...new Set(result.statistics_input.sales.map(row => row.canonical_transaction_id))].sort(), ["T1", "T2", "T3"]);
});

test("verified additional parcel is included when the primary account is an unselected lot; allocation remains explicit", () => {
  const input = fixture();
  input.sources.transactions.rows.push(transaction("PACKAGE", "LOT", { sale_price: 500_000 }));
  input.sources.sale_links.rows.push(link("PACKAGE", "LOT"), link("PACKAGE", "P2"));
  const unresolved = summarizeNeighborhoodPopulations(buildCachedNeighborhoodInputs(input).statistics_input);
  assert.equal(unresolved.sales.diagnostics.unresolved_allocation_transactions, 1);
  assert.equal(unresolved.sales.unique_price_eligible_account_coverage_percent, 50);
  for (const row of input.sources.sale_links.rows.filter(row => row.source_record_id === "source-PACKAGE")) {
    row.allocation_verified = true;
    row.allocation_evidence_ref = "reviewed:allocation-v1";
    row.allocated_sale_price = row.account_id === "P2" ? 400_000 : 100_000;
  }
  const allocated = buildCachedNeighborhoodInputs(input);
  const summary = summarizeNeighborhoodPopulations(allocated.statistics_input);
  assert.equal(summary.sales.unique_price_eligible_account_coverage_percent, 75);
  assert.equal(summary.sales.property_price_members.find(row => row.account_id === "P2").sale_price, 400_000);
  assert.ok(summary.sales.property_price_members.find(row => row.account_id === "P2").source_references.includes("reviewed:allocation-v1"));
});

test("missing/truncated link enumeration does not fall back to a primary-only house price", () => {
  const input = fixture(); input.sources.sale_links = source("link-snapshot", [], {
    state: "absent", complete: false, revision: null, content_sha256: null,
  });
  input.sources.transactions.rows[0].primary_account_verified = true;
  const result = buildCachedNeighborhoodInputs(input);
  assert.equal(result.statistics_input.sales.length, 0);
  assert.equal(result.diagnostics.unresolved_membership_transaction_rows, 3);
  assert.ok(result.transaction_evidence.every(row => row.disposition === "parcel_membership_incomplete"));
  input.sources.transactions.rows[0].parcel_count = 1;
  const explicit = buildCachedNeighborhoodInputs(input);
  assert.equal(explicit.statistics_input.sales.length, 1);
  assert.equal(explicit.status, "incomplete", "missing required source still disclosed despite known single-parcel evidence");
});

test("explicit incomplete parcel membership overrides a complete envelope and a matching declared count", () => {
  for (const count of [undefined, 1]) {
    const input = fixture();
    Object.assign(input.sources.transactions.rows[0], { parcel_links_complete: false, parcel_count: count });
    const result = buildCachedNeighborhoodInputs(input);
    assert.equal(result.status, "incomplete");
    assert.ok(result.incomplete_reasons.includes("parcel_membership_incomplete"));
    assert.equal(result.statistics_input.sales.some(row => row.canonical_transaction_id === "T1"), false);
    assert.equal(result.transaction_evidence.find(row => row.canonical_transaction_id === "T1").disposition, "parcel_membership_incomplete");
    assert.equal(result.diagnostics.unresolved_membership_transaction_rows, 1);
  }
});

test("an absent membership claim cannot use a complete selected-account envelope as full transaction enumeration", () => {
  const input = fixture();
  delete input.sources.transactions.rows[0].parcel_links_complete;
  const incomplete = buildCachedNeighborhoodInputs(input);
  assert.equal(incomplete.status, "incomplete");
  assert.equal(incomplete.statistics_input.sales.some(row => row.canonical_transaction_id === "T1"), false);
  input.sources.transactions.rows[0].parcel_count = 2;
  assert.equal(buildCachedNeighborhoodInputs(input).status, "incomplete", "unselected co-parcel is not present in the envelope");
  input.sources.sale_links.rows.push(link("T1", "UNSELECTED-LOT"));
  const fullCountEvidence = buildCachedNeighborhoodInputs(input);
  assert.equal(fullCountEvidence.status, "ready");
  const packageSale = fullCountEvidence.statistics_input.sales.find(row => row.canonical_transaction_id === "T1");
  assert.equal(packageSale.parcel_count, 2);
  assert.deepEqual(packageSale.parcels.map(row => row.account_id), ["P1", "UNSELECTED-LOT"]);
  const summary = summarizeNeighborhoodPopulations(fullCountEvidence.statistics_input);
  assert.equal(summary.sales.diagnostics.unresolved_allocation_transactions, 1, "membership completeness does not invent per-property price allocation");
  assert.equal(summary.sales.property_sale_price.median, 365_000);
});

test("malformed or contradictory membership metadata cannot certify complete parcel membership", () => {
  for (const changes of [
    { parcel_links_complete: "true" }, { parcel_links_complete: "false", parcel_count: 1 },
    { parcel_count: 0 }, { parcel_count: -1 }, { parcel_count: 1.5 }, { parcel_count: "" }, { parcel_count: 2 },
  ]) {
    const input = fixture(); Object.assign(input.sources.transactions.rows[0], changes);
    const result = buildCachedNeighborhoodInputs(input);
    assert.equal(result.status, "incomplete");
    assert.equal(result.statistics_input.sales.some(row => row.canonical_transaction_id === "T1"), false);
  }
  const unknownLink = fixture(); unknownLink.sources.sale_links.rows.push(link("T1", null));
  assert.equal(buildCachedNeighborhoodInputs(unknownLink).status, "incomplete");
});

test("unknown transaction kinds remain incomplete, distinct from supported non-sale exclusions", () => {
  for (const kind of [undefined, null, "", " ", "closed_sal", "Closed_Sale", "pending", 0, false]) {
    const input = fixture();
    if (kind === undefined) delete input.sources.transactions.rows[0].record_type;
    else input.sources.transactions.rows[0].record_type = kind;
    const result = buildCachedNeighborhoodInputs(input);
    assert.equal(result.status, "incomplete");
    assert.ok(result.incomplete_reasons.includes("transaction_kind_unknown"));
    assert.equal(result.diagnostics.unknown_transaction_kind_rows, 1);
    assert.equal(result.diagnostics.nonclosed_transaction_rows, 0);
    assert.equal(result.transaction_evidence.find(row => row.canonical_transaction_id === "T1").disposition, "transaction_kind_unknown");
    assert.equal(result.statistics_input.sales.some(row => row.canonical_transaction_id === "T1"), false);
  }
  const listing = fixture(); listing.sources.transactions.rows[0].record_type = "listing";
  const known = buildCachedNeighborhoodInputs(listing);
  assert.equal(known.status, "ready");
  assert.equal(known.diagnostics.unknown_transaction_kind_rows, 0);
  assert.equal(known.diagnostics.nonclosed_transaction_rows, 1);
  assert.deepEqual(known.incomplete_reasons, []);
});

test("future outcomes, latest listing status and unknown market eligibility stay outside historical sales", () => {
  const input = fixture();
  input.sources.transactions.rows.push(transaction("FUTURE", "P1", { closing_date: "2024-07-01" }),
    transaction("LISTING", "P1", { record_type: "listing" }),
    transaction("UNKNOWN", "P1", { market_eligible: undefined }),
    transaction("OLD", "P1", { closing_date: "2023-06-30" }));
  const result = buildCachedNeighborhoodInputs(input);
  assert.equal(result.statistics_input.sales.length, 3);
  assert.equal(result.diagnostics.future_transaction_rows, 1);
  assert.equal(result.diagnostics.nonclosed_transaction_rows, 1);
  assert.equal(result.diagnostics.unknown_transaction_eligibility_rows, 1);
  assert.equal(result.diagnostics.outside_period_transaction_rows, 1);
});

test("canonical IDs are never invented from source records and conflicting mappings remain unresolved", () => {
  const input = fixture();
  delete input.sources.transactions.rows[0].sale_id;
  input.sources.transactions.rows[1].source_record_id = "ambiguous-source";
  input.sources.transactions.rows[2].source_record_id = "ambiguous-source";
  input.sources.sale_links.rows.push({ ...link("T2", "P1"), source_record_id: "ambiguous-source" });
  const result = buildCachedNeighborhoodInputs(input);
  assert.equal(result.diagnostics.missing_canonical_transaction_rows, 1);
  assert.equal(result.diagnostics.ambiguous_source_record_links, 1);
  assert.equal(result.statistics_input.sales.some(row => row.canonical_transaction_id === "source-T1"), false);
});

test("input order does not affect captured identity but source revision/context changes do", () => {
  const input = fixture();
  const result = buildCachedNeighborhoodInputs(input);
  input.selection.account_ids.reverse();
  for (const source of Object.values(input.sources)) source.rows.reverse();
  const reordered = buildCachedNeighborhoodInputs(input);
  assert.equal(result.captured_input_sha256, reordered.captured_input_sha256);
  assert.deepEqual(result.statistics_input, reordered.statistics_input);
  input.sources.transactions.revision = "capture-2";
  assert.notEqual(result.captured_input_sha256, buildCachedNeighborhoodInputs(input).captured_input_sha256);
  input.sources.transactions.revision = "capture-1";
  input.scope.appraisal_case_id = "case-2";
  assert.notEqual(result.captured_input_sha256, buildCachedNeighborhoodInputs(input).captured_input_sha256);
});

test("conflicting canonical metadata cannot be sanitized by date, kind, membership or eligibility filtering", () => {
  for (const changes of [{ closing_date: "2024-07-01" }, { market_eligible: false }, { market_eligible: undefined }, { sale_price: 900_000 },
    { record_type: "listing" }, { record_type: undefined }, { parcel_links_complete: false }, { parcel_count: 2 }]) {
    const input = fixture(); input.sources.transactions.rows.push({ ...input.sources.transactions.rows[0], ...changes });
    const result = buildCachedNeighborhoodInputs(input);
    assert.equal(result.statistics_input.sales.some(row => row.canonical_transaction_id === "T1"), false);
    assert.equal(result.status, "incomplete");
    assert.equal(result.diagnostics.conflicting_canonical_transaction_rows, 2);
    assert.ok(result.transaction_evidence.filter(row => row.canonical_transaction_id === "T1")
      .every(row => row.disposition === "conflicting_canonical_metadata"));
  }
});

test("duplicate link representations and shuffled package rows preserve parcel counts and input identity", () => {
  const input = fixture();
  input.sources.transactions.rows = [transaction("package", "P1", { sale_price: 600_000 })];
  input.sources.sale_links.rows = [link("package", "P1", { allocated_sale_price: 300_000, allocation_verified: true, allocation_evidence_ref: "allocation:1" }),
    link("package", "P2", { allocated_sale_price: 300_000, allocation_verified: true, allocation_evidence_ref: "allocation:1" })];
  input.sources.sale_links.rows.push({ ...input.sources.sale_links.rows[0] });
  const result = buildCachedNeighborhoodInputs(input);
  const stats = summarizeNeighborhoodPopulations(result.statistics_input);
  assert.equal(stats.sales.property_sale_price.count, 2);
  assert.equal(stats.sales.diagnostics.unresolved_parcel_transactions, 0);
  input.sources.sale_links.rows.reverse();
  assert.equal(result.captured_input_sha256, buildCachedNeighborhoodInputs(input).captured_input_sha256);
});

test("account enrichment may fill blanks but contradictory supported housing stays unknown", () => {
  const input = fixture(); input.sources.parcels.rows[0].residential_area_sqft = null;
  input.sources.accounts = source("account-snapshot", [parcel("P1", { residential_area_sqft: 2100 })]);
  const enriched = summarizeNeighborhoodPopulations(buildCachedNeighborhoodInputs(input).statistics_input);
  assert.equal(enriched.stock.gla_sqft.count, 4);
  assert.equal(enriched.stock.gla_sqft.high, 2100);
  input.sources.accounts.rows[0].land_use_category = "multi_family";
  const conflicting = buildCachedNeighborhoodInputs(input);
  assert.equal(conflicting.diagnostics.conflicting_housing_accounts, 1);
  assert.equal(conflicting.statistics_input.stock.some(row => row.account_id === "P1"), false);
});
