import assert from "node:assert/strict";
import test from "node:test";
import {
  ageAtEffectiveDate,
  deduplicateTransactions,
  exactDistribution,
  finiteNumberOrNull,
  NEIGHBORHOOD_STATISTICS_LIMITS,
  summarizeNeighborhoodPopulations,
} from "../src/services/neighborhoodAssessment/statistics.js";

const scope = {
  population_id: "synthetic-selection-1",
  effective_date: "2024-06-30",
  observation_period: { start_date: "2023-07-01", end_date: "2024-06-30" },
};
const stock = (account_id, overrides = {}) => ({
  account_id, year_built: 2000, gla_sqft: 1800, site_area_sqft: 7000,
  housing_type: "one_unit", market_value: 250_000, assessment_tax_year: 2024, ...overrides,
});
const sale = (canonical_transaction_id, primary_account_id, overrides = {}) => ({
  canonical_transaction_id, primary_account_id, primary_account_verified: true,
  sale_date: "2024-03-01", sale_price: 300_000, ...overrides,
});
const summarize = (input = {}) => summarizeNeighborhoodPopulations({ ...scope, ...input });

test("numeric parsing distinguishes missing, invalid, explicit zero and DB decimal text", () => {
  for (const value of [null, undefined, "", " ", false, true, [], {}, "0x10", "NaN", Infinity, NaN]) {
    assert.equal(finiteNumberOrNull(value), null);
  }
  assert.equal(finiteNumberOrNull(" 0 "), 0);
  assert.equal(finiteNumberOrNull("12.50"), 12.5);
  assert.equal(finiteNumberOrNull(-4), -4);
  const result = exactDistribution([null, "", 0, 10]);
  assert.equal(result.median, 5);
  assert.equal(result.count, 2);
  assert.equal(result.missing_count, 2);
  assert.equal(result.coverage_percent, 50);
});

test("dates are explicit valid Gregorian dates and age is effective-year minus construction-year", () => {
  assert.equal(ageAtEffectiveDate(2000, "2024-02-29"), 24);
  assert.equal(ageAtEffectiveDate(2024, "2024-01-01"), 0);
  for (const year of [null, "", 0, 2025, 2000.5]) assert.equal(ageAtEffectiveDate(year, "2024-06-30"), null);
  for (const date of [undefined, "2026-02-31", "2023-02-29", "2024-13-01", "2024-2-01", "yesterday"]) {
    assert.throws(() => ageAtEffectiveDate(2000, date), /YYYY-MM-DD/);
  }
  assert.throws(() => summarize({ effective_date: undefined }), /effective_date/);
  assert.throws(() => summarize({ observation_period: undefined }), /start_date/);
  assert.throws(() => summarize({ observation_period: { start_date: "2025-01-01", end_date: "2024-01-01" } }), /ordered/);
  assert.throws(() => summarize({ observation_period: { start_date: "2024-01-01", end_date: "2025-01-01" } }), /effective_date/);
});

test("exact selected-member quantiles are not an average of pocket medians and never predominant", () => {
  const members = [1, 2, 100, 101, 102, 103];
  const result = exactDistribution(members);
  assert.equal(result.median, 100.5);
  assert.equal(result.q1, 26.5);
  assert.equal(result.q3, 101.75);
  assert.notEqual(result.median, (1.5 + 101.5) / 2);
  assert.deepEqual(members, [1, 2, 100, 101, 102, 103]);
  assert.equal(Object.hasOwn(result, "predominant"), false);
  assert.equal(summarize().predominant_value.state, "unsupported");
});

test("empty, sparse, zero and invalid measurements retain explicit insufficient/missing states", () => {
  const empty = summarize();
  assert.equal(empty.state, "insufficient");
  assert.equal(empty.stock.gla_sqft.median, null);
  assert.equal(empty.sales.unique_sold_account_coverage_percent, null);
  assert.equal(exactDistribution([0, 0]).cod_percent, null);
  assert.equal(exactDistribution([100], { minimum_count: 3 }).state, "insufficient");
  assert.equal(exactDistribution([100], { minimum_count: 3 }).median, 100);
  assert.throws(() => exactDistribution([], { minimum_count: 0 }), /positive integer/);
  assert.throws(() => summarize({ minimum_sale_count: 1.5 }), /positive integer/);
  const values = summarize({ stock: [stock("a", { gla_sqft: null, site_area_sqft: 0, year_built: 2024, market_value: 0 })] });
  assert.equal(values.stock.gla_sqft.count, 0);
  assert.equal(values.stock.site_area_sqft.median, 0);
  assert.equal(values.stock.age_at_effective_date.median, 0);
  assert.equal(values.stock.year_built.median, 2024);
  assert.equal(values.stock.assessed_values_by_tax_year[0].median, 0);
});

test("sales period includes endpoints but excludes future, invalid and older outcomes", () => {
  const result = summarize({ stock: [stock("a")], sales: [
    sale("start", "a", { sale_date: scope.observation_period.start_date, sale_price: 100 }),
    sale("end", "a", { sale_date: scope.effective_date, sale_price: 300 }),
    sale("future", "a", { sale_date: "2025-01-01", sale_price: 900 }),
    sale("old", "a", { sale_date: "2023-06-30", sale_price: 10 }),
    sale("bad", "a", { sale_date: "2024-02-31", sale_price: 200 }),
  ] });
  assert.equal(result.sales.transaction_count, 2);
  assert.equal(result.sales.property_sale_price.median, 200);
  assert.equal(result.sales.diagnostics.future_transactions, 1);
  assert.equal(result.sales.diagnostics.outside_period_transactions, 1);
  assert.equal(result.sales.diagnostics.invalid_date_transactions, 1);
  assert.equal(result.sales.property_sale_price.observation_period.bounds, "inclusive");
});

test("canonical identity deduplicates observations but retains repeated transactions and bounded unique-property coverage", () => {
  const first = sale("t1", "R-001", { sale_price: 100 });
  const result = summarize({ stock: [stock("R-001"), stock("b")], sales: [
    first, { ...first }, sale("t2", "R-001", { sale_price: 200 }), sale("t3", "R-001", { sale_price: 300 }),
  ] });
  assert.equal(result.sales.transaction_count, 3);
  assert.equal(result.sales.diagnostics.duplicate_records, 1);
  assert.equal(result.sales.unique_sold_account_count, 1);
  assert.equal(result.sales.unique_sold_account_coverage_percent, 50);
  assert.equal(result.sales.property_sale_price.median, 200);
  assert.equal(result.state, "ready");
  assert.equal(result.sales.property_price_members[0].account_id, "R-001");
  const missing = deduplicateTransactions([{ source_record_id: "not-canonical", sale_price: 10 }]);
  assert.equal(missing.transactions.length, 0);
  assert.equal(missing.diagnostics.missing_identity_records, 1);
});

test("conflicting duplicate transactions are withheld and input order cannot choose a favorable price", () => {
  const evidence = [sale("t1", "a", { sale_price: 100 }), sale("t1", "a", { sale_price: 200 }), sale("t2", "a")];
  const forward = summarize({ stock: [stock("a")], sales: evidence });
  const reverse = summarize({ stock: [stock("a")], sales: evidence.toReversed() });
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.sales.diagnostics.conflicting_transaction_ids, ["t1"]);
  assert.equal(forward.sales.transaction_count, 1);
});

test("unverified parcel matches and explicit nonmarket transfers cannot populate property prices", () => {
  const result = summarize({ stock: [stock("a")], sales: [
    sale("unverified", "a", { primary_account_verified: false }),
    sale("nonmarket", "a", { market_eligible: false }),
    sale("outside", "b"),
    sale("zero", "a", { sale_price: 0 }),
  ] });
  assert.equal(result.sales.property_price_observation_count, 0);
  assert.equal(result.sales.diagnostics.unresolved_parcel_transactions, 1);
  assert.equal(result.sales.diagnostics.nonmarket_transactions, 1);
  assert.equal(result.sales.diagnostics.outside_population_transactions, 1);
  assert.equal(result.sales.diagnostics.nonpositive_or_missing_price_transactions, 1);
  assert.equal(result.sales.recorded_transaction_price.median, 0);
});

test("unallocated multi-parcel transactions are retained once but not copied to per-property statistics", () => {
  const result = summarize({ stock: [stock("a"), stock("b")], sales: [sale("package", "a", {
    sale_price: 600_000,
    parcels: [{ account_id: "a", verified: true }, { account_id: "b", verified: true }],
  })] });
  assert.equal(result.sales.transaction_count, 1);
  assert.equal(result.sales.unique_sold_account_count, 2);
  assert.equal(result.sales.unique_sold_account_coverage_percent, 100);
  assert.equal(result.sales.recorded_transaction_price.count, 1);
  assert.equal(result.sales.property_sale_price.count, 0);
  assert.equal(result.sales.diagnostics.unresolved_allocation_transactions, 1);
  assert.equal(result.state, "insufficient");
});

test("verified complete allocations use only selected parcels and count the original transaction once", () => {
  const packageSale = sale("package", "a", { sale_price: 600_000, parcels: [
    { account_id: "a", verified: true, allocation_verified: true, allocated_sale_price: 100_000 },
    { account_id: "b", verified: true, allocation_verified: true, allocated_sale_price: 200_000 },
    { account_id: "outside", verified: true, allocation_verified: true, allocated_sale_price: 300_000 },
  ] });
  const result = summarize({ stock: [stock("a"), stock("b")], sales: [packageSale, { ...packageSale }] });
  assert.equal(result.sales.price_eligible_transaction_count, 1);
  assert.equal(result.sales.property_sale_price.count, 2);
  assert.equal(result.sales.property_sale_price.median, 150_000);
  assert.equal(result.sales.recorded_transaction_price.median, 600_000);
  assert.equal(result.sales.unique_price_eligible_account_coverage_percent, 100);
  assert.equal(result.sales.transaction_sufficiency.state, "insufficient");
});

test("partial, unverified or inconsistent allocations cannot pass as allocated prices", () => {
  const variants = [
    { parcel_count: 3, parcels: [{ account_id: "a", verified: true }] },
    { parcels: [{ account_id: "a", verified: true }, { account_id: "b", verified: false }] },
    { parcels: [{ account_id: "a", verified: true, allocated_sale_price: 100 }, { account_id: "b", verified: true, allocated_sale_price: 200 }] },
    { parcels: [{ account_id: "a", verified: true, allocation_verified: true, allocated_sale_price: 100 }, { account_id: "b", verified: true, allocation_verified: true, allocated_sale_price: 199 }] },
  ];
  for (const variant of variants) {
    const result = summarize({ stock: [stock("a"), stock("b")], sales: [sale("t", "a", { sale_price: 300, ...variant })] });
    assert.equal(result.sales.property_sale_price.count, 0);
  }
});

test("assessor market values remain separate by tax year and never become sale prices", () => {
  const result = summarize({ stock: [
    stock("a", { tax_year: 2023, assessment_tax_year: null, market_value: 100 }),
    stock("a", { assessment_tax_year: 2024, market_value: 200 }),
    stock("b", { assessment_tax_year: null, market_value: 500 }),
    stock("c", { assessment_tax_year: 2025, market_value: 1000 }),
  ] });
  assert.equal(result.stock.property_count, 3);
  assert.equal(result.stock.assessment_tax_year_missing_count, 2);
  assert.deepEqual(result.stock.assessed_values_by_tax_year.map((year) => [year.tax_year, year.count, year.median]), [
    [2023, 1, 100], [2024, 1, 200],
  ]);
  assert.equal(result.sales.property_sale_price.count, 0);
  assert.match(result.stock.assessed_values_by_tax_year[0].definition, /not_sale_price/);
});

test("conflicting duplicate stock characteristics become unknown without duplicating accounts", () => {
  const result = summarize({ stock: [stock("a", { gla_sqft: 1000 }), stock("a", { gla_sqft: 2000 }), stock("b")] });
  assert.equal(result.stock.property_count, 2);
  assert.equal(result.stock.gla_sqft.missing_count, 1);
  assert.equal(result.stock.gla_sqft.median, 1800);
  assert.equal(result.stock.diagnostics.conflicting_field_count, 1);
  assert.equal(result.stock.diagnostics.duplicate_account_records, 1);
});

test("every selected eligible price including extremes remains, with source refs distinct from veracity", () => {
  const records = [
    sale("a", "a", { sale_price: 1, source_references: ["source:one"] }),
    sale("b", "b", { sale_price: 100 }),
    sale("c", "c", { sale_price: 1_000_000_000 }),
  ];
  const original = structuredClone(records);
  const result = summarize({ stock: [stock("a"), stock("b"), stock("c")], sales: records });
  assert.equal(result.sales.property_sale_price.low, 1);
  assert.equal(result.sales.property_sale_price.high, 1_000_000_000);
  assert.equal(result.sales.property_sale_price.count, 3);
  assert.equal(result.sales.property_sale_price.median, 100);
  assert.equal(result.sales.transaction_veracity, "not_assessed_by_this_module");
  assert.equal(result.sales.property_price_members[0].provenance_state, "references_supplied_by_adapter");
  assert.equal(result.sales.property_price_members[1].provenance_state, "absent");
  assert.equal(Object.hasOwn(result, "reliability_score"), false);
  assert.deepEqual(records, original);
});

test("acceptance 4: frozen effective date excludes July outcome and keeps 2004 construction age at 20", () => {
  const baseline = summarize({ stock: [stock("P1", { year_built: 2004 })], sales: [
    sale("start", "P1", { sale_date: "2023-07-01", sale_price: 100 }),
    sale("end", "P1", { sale_date: "2024-06-30", sale_price: 300 }),
    sale("old", "P1", { sale_date: "2023-06-30", sale_price: 5 }),
  ] });
  const future = summarize({ stock: [stock("P1", { year_built: 2004 })], sales: [
    sale("start", "P1", { sale_date: "2023-07-01", sale_price: 100 }),
    sale("end", "P1", { sale_date: "2024-06-30", sale_price: 300 }),
    sale("old", "P1", { sale_date: "2023-06-30", sale_price: 5 }),
    sale("future", "P1", { sale_date: "2024-07-01", sale_price: 10_000_000 }),
  ] });
  assert.equal(baseline.stock.age_at_effective_date.median, 20);
  assert.equal(baseline.stock.year_built.median, 2004);
  assert.equal(baseline.sales.transaction_count, 2);
  assert.deepEqual(baseline.sales.property_price_members, future.sales.property_price_members);
  assert.deepEqual(baseline.sales.property_sale_price, future.sales.property_sale_price);
});

test("acceptance 5: additional dwelling parcel on a package goes from 50% to 75% eligible coverage only with allocation", () => {
  const dwellings = ["P1", "P2", "P3", "P4"].map((id) => stock(id));
  const packageSale = sale("package", "L", { sale_price: 500_000, parcels: [
    { account_id: "L", verified: true }, { account_id: "P2", verified: true },
  ] });
  const records = [
    sale("first", "P1", { sale_price: 300_000 }),
    sale("first", "P1", { sale_price: 300_000 }),
    sale("second", "P1", { sale_price: 330_000 }),
    sale("third", "P3", { sale_price: 400_000 }),
    packageSale,
  ];
  const baseline = summarize({ stock: dwellings, sales: records });
  assert.equal(baseline.sales.price_eligible_transaction_count, 3);
  assert.equal(baseline.sales.unique_price_eligible_account_count, 2);
  assert.equal(baseline.sales.unique_price_eligible_account_coverage_percent, 50);
  assert.equal(baseline.sales.property_sale_price.median, 330_000);
  const allocated = summarize({ stock: dwellings, sales: records.map((record) => record === packageSale ? {
    ...record, source_references: ["reviewed-allocation:fixture-1"], parcels: [
      { account_id: "L", verified: true, allocation_verified: true, allocated_sale_price: 100_000 },
      { account_id: "P2", verified: true, allocation_verified: true, allocated_sale_price: 400_000 },
    ],
  } : record) });
  assert.equal(allocated.sales.unique_price_eligible_account_count, 3);
  assert.equal(allocated.sales.unique_price_eligible_account_coverage_percent, 75);
  assert.equal(allocated.sales.property_price_members.find((member) => member.account_id === "P2").sale_price, 400_000);
  assert.deepEqual(allocated.sales.property_price_members.find((member) => member.account_id === "P2").source_references, ["reviewed-allocation:fixture-1"]);
});

test("acceptance 6: six dwelling GLA observations yield two valid measurements and supported sale $/sf", () => {
  const dwellings = [2000, 2200, null, 0, undefined, ""].map((gla_sqft, index) => stock(`P${index}`, {
    gla_sqft, market_value: index === 0 ? 300_000 : null,
  }));
  const result = summarize({ stock: dwellings, sales: [
    sale("one", "P0", { sale_price: 300_000, gla_sqft_at_sale: 2000 }),
    sale("two", "P1", { sale_price: 440_000, gla_sqft_at_sale: 2200 }),
    sale("unknown", "P2", { sale_price: 350_000 }),
  ] });
  assert.equal(result.stock.gla_sqft.count, 2);
  assert.equal(result.stock.gla_sqft.median, 2100);
  assert.deepEqual(result.stock.gla_sqft.missing_reasons, { missing: 3, invalid: 1, conflicting: 0 });
  assert.equal(result.stock.assessed_values_by_tax_year[0].count, 1);
  assert.equal(result.sales.sale_price_per_sqft.count, 2);
  assert.equal(result.sales.sale_price_per_sqft.median, 175);
  assert.equal(result.sales.sale_price_per_sqft.missing_count, 1);
  assert.equal(exactDistribution([0, null]).count, 1); // Explicit zero dues remain known.
});

test("acceptance 7: seven pooled sale prices yield 200000 median, not 225000 or predominant", () => {
  const prices = [100_000, 100_000, 100_000, 200_000, 300_000, 400_000, 500_000];
  const rows = prices.map((sale_price, index) => sale(`t${index}`, `P${index}`, { sale_price }));
  const properties = prices.map((_, index) => stock(`P${index}`, { market_value: 600_000 }));
  const result = summarize({ stock: properties, sales: rows });
  const regrouped = summarize({ stock: properties.toReversed(), sales: [...rows.slice(3), ...rows.slice(0, 3)] });
  assert.equal(result.sales.property_sale_price.median, 200_000);
  assert.notEqual(result.sales.property_sale_price.median, 225_000);
  assert.deepEqual(result.sales.property_sale_price, regrouped.sales.property_sale_price);
  assert.equal(result.predominant_value.value, null);
  assert.equal(result.stock.assessed_values_by_tax_year[0].median, 600_000);
});

test("acceptance 8: changing sales mix changes raw median but cannot establish underlying appreciation", () => {
  const properties = Array.from({ length: 10 }, (_, index) => stock(`P${index}`));
  const periods = [
    { start_date: "2023-07-01", end_date: "2023-12-31", smaller: 8 },
    { start_date: "2024-01-01", end_date: "2024-06-30", smaller: 2 },
  ];
  const observations = periods.flatMap((period, p) => properties.map((property, index) => sale(`t${p}-${index}`, property.account_id, {
    sale_date: period.start_date, sale_price: index < period.smaller ? 300_000 : 500_000,
  })));
  const results = periods.map(({ start_date, end_date }) => summarize({ stock: properties, sales: observations, observation_period: { start_date, end_date } }));
  assert.equal(results[0].sales.property_sale_price.median, 300_000);
  assert.equal(results[1].sales.property_sale_price.median, 500_000);
  for (const result of results) {
    assert.equal(result.sales.property_sale_price.count, 10);
    assert.equal(result.market_trend.state, "unsupported");
    assert.equal(result.market_trend.appreciation_rate_percent, null);
    assert.match(result.market_trend.composition_sensitivity, /requires_consistent_product_bands/);
  }
});

test("R1: assessment coverage for each tax year retains the entire selected-stock denominator", () => {
  const result = summarize({ stock: [
    stock("A", { market_value: 300_000, assessment_tax_year: 2024 }),
    stock("B", { market_value: null, assessment_tax_year: null }),
    stock("C", { market_value: null, assessment_tax_year: null }),
  ] });
  const assessment = result.stock.assessed_values_by_tax_year[0];
  assert.equal(assessment.member_count, 3);
  assert.equal(assessment.count, 1);
  assert.equal(assessment.missing_count, 2);
  assert.equal(assessment.coverage_percent, 1 / 3 * 100);
  assert.equal(assessment.median, 300_000);
  const differing = summarize({ stock: [
    stock("A", { market_value: 300_000, assessment_tax_year: 2024 }),
    stock("B", { market_value: 250_000, assessment_tax_year: 2023 }),
    stock("C", { market_value: null, assessment_tax_year: null }),
  ] });
  assert.deepEqual(differing.stock.assessed_values_by_tax_year.map((year) => ({
    year: year.tax_year, population: year.member_count, known: year.count, missing: year.missing_count,
    coverage: year.coverage_percent, median: year.median,
  })), [
    { year: 2023, population: 3, known: 1, missing: 2, coverage: 1 / 3 * 100, median: 250_000 },
    { year: 2024, population: 3, known: 1, missing: 2, coverage: 1 / 3 * 100, median: 300_000 },
  ]);
});

test("canonical ordering uses code units rather than locale-sensitive collation", () => {
  const ids = ["á", "a", "A", "Z", "0"];
  const result = deduplicateTransactions(ids.map((id) => sale(id, "P1")));
  assert.deepEqual(result.transactions.map((record) => record.canonical_transaction_id), ["0", "A", "Z", "a", "á"]);
  const links = deduplicateTransactions([sale("t", "a", { parcels: ids.map((account_id) => ({ account_id, verified: true })) })]);
  assert.deepEqual(links.transactions[0].parcels.map((parcel) => parcel.account_id), ["0", "A", "Z", "a", "á"]);
});

test("record, nested-link, source-reference and measurement budgets fail explicitly without truncation", () => {
  const limitError = (resource) => (error) => error.code === "NEIGHBORHOOD_STATISTICS_WORK_LIMIT"
    && error.state === "incomplete" && error.resource === resource && error.observed > error.limit;
  assert.throws(() => exactDistribution(new Array(NEIGHBORHOOD_STATISTICS_LIMITS.measurement_values + 1)), limitError("values"));
  assert.throws(() => summarize({ stock: new Array(NEIGHBORHOOD_STATISTICS_LIMITS.input_records + 1) }), limitError("stock"));
  assert.throws(() => deduplicateTransactions(new Array(NEIGHBORHOOD_STATISTICS_LIMITS.input_records + 1)), limitError("sales"));
  assert.throws(() => deduplicateTransactions([sale("t", "a", {
    parcels: new Array(NEIGHBORHOOD_STATISTICS_LIMITS.parcel_links + 1),
  })]), limitError("parcel_links"));
  assert.throws(() => deduplicateTransactions([sale("t", "a", {
    source_references: new Array(NEIGHBORHOOD_STATISTICS_LIMITS.source_references + 1),
  })]), limitError("source_references"));
  const manyYears = Array.from({ length: 5000 }, (_, index) => stock(`p${index}`, {
    assessment_tax_year: 1600 + index % 410,
  }));
  assert.throws(() => summarize({ stock: manyYears }), limitError("total_measurement_work"));
  const unsampled = summarize({ stock: [stock("a")], sales: Array.from({ length: 100 }, (_, index) => sale(`t${index}`, "a")) });
  assert.equal(unsampled.sales.property_sale_price.count, 100);
});

test("unsafe identifiers and implausible/future years become unknown rather than rounded identities or ages", () => {
  assert.equal(ageAtEffectiveDate(1600, "2024-06-30"), 424);
  for (const year of [1, 0, 1599, 2025, Number.MAX_SAFE_INTEGER + 1, "2004.25", true, "9".repeat(500)]) {
    assert.equal(ageAtEffectiveDate(year, "2024-06-30"), null);
  }
  const result = deduplicateTransactions([sale(Number.MAX_SAFE_INTEGER + 1, "a")]);
  assert.equal(result.diagnostics.missing_identity_records, 1);
  const accounts = summarize({ stock: [stock(Number.MAX_SAFE_INTEGER + 1)] });
  assert.equal(accounts.stock.property_count, 0);
  assert.equal(accounts.stock.diagnostics.missing_account_identity_records, 1);
});

test("overflowing arithmetic produces explicit incomplete diagnostics and no nonfinite output", () => {
  const result = exactDistribution([-Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE]);
  assert.equal(result.median, -Number.MAX_VALUE);
  assert.equal(result.cod_percent, null);
  assert.equal(result.state, "incomplete");
  assert.equal(result.reason, "numeric_overflow");
  assert.ok(result.numeric_issues.includes("cod_percent"));
  for (const value of Object.values(result)) {
    if (typeof value === "number") assert.ok(Number.isFinite(value));
  }
  const ppsf = summarize({ stock: [stock("a")], sales: [sale("t", "a", {
    sale_price: Number.MAX_VALUE, gla_sqft_at_sale: Number.MIN_VALUE,
  })], minimum_sale_count: 1 });
  assert.equal(ppsf.state, "incomplete");
  assert.equal(ppsf.sales.sale_price_per_sqft.median, null);
  assert.equal(ppsf.sales.sale_price_per_sqft.reason, "numeric_overflow");
  assert.equal(ppsf.sales.sale_price_per_sqft.arithmetic_overflow_count, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(ppsf)), ppsf);
});

test("duplicate metadata disagreements withhold dates/allocations/denominators conservatively", () => {
  const dates = deduplicateTransactions([sale("t", "a"), sale("t", "a", { sale_date: "2024-04-01" })]);
  assert.deepEqual(dates.diagnostics.conflicting_transaction_ids, ["t"]);
  const gla = summarize({ stock: [stock("a")], sales: [
    sale("t", "a", { gla_sqft_at_sale: 2000 }), sale("t", "a", { gla_sqft_at_sale: 2500 }),
  ] });
  assert.equal(gla.sales.property_sale_price.count, 1);
  assert.equal(gla.sales.sale_price_per_sqft.count, 0);
  const allocation = (priceA, priceB) => sale("package", "a", { sale_price: 300, parcels: [
    { account_id: "a", verified: true, allocation_verified: true, allocated_sale_price: priceA },
    { account_id: "b", verified: true, allocation_verified: true, allocated_sale_price: priceB },
  ] });
  const packages = [allocation(100, 200), allocation(150, 150)];
  const result = summarize({ stock: [stock("a"), stock("b")], sales: packages });
  assert.equal(result.sales.property_sale_price.count, 0);
  assert.equal(result.sales.diagnostics.unresolved_allocation_transactions, 1);
  assert.deepEqual(result, summarize({ stock: [stock("b"), stock("a")], sales: packages.toReversed() }));
  const market = summarize({ stock: [stock("a")], sales: [sale("t", "a"), sale("t", "a", { market_eligible: false })] });
  assert.equal(market.sales.diagnostics.nonmarket_transactions, 1);
});
