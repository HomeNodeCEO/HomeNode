/** Exact, side-effect-free summaries over explicit selected members.
 * Adapters must supply canonical sale identity and verified parcel links. This
 * module does not infer matches, trim prices, select comparables, or rate a market.
 */

// Safety budgets are not cohort-size targets. Oversized work is rejected as a
// whole so an adapter can use an exact bounded DB aggregation; never sample it.
export const NEIGHBORHOOD_STATISTICS_LIMITS = Object.freeze({
  input_records: 100_000,
  measurement_values: 250_000,
  parcel_links: 250_000,
  source_references: 250_000,
  total_measurement_work: 2_000_000,
});

function assertLimit(observed, limit, resource) {
  if (observed <= limit) return;
  const error = new RangeError(`Neighborhood statistics work limit exceeded: ${resource}`);
  Object.assign(error, { code: "NEIGHBORHOOD_STATISTICS_WORK_LIMIT", state: "incomplete", resource, observed, limit });
  throw error;
}

function boundedArray(values, resource, limit) {
  if (!Array.isArray(values)) throw new TypeError(`${resource} must be an array`);
  assertLimit(values.length, limit, resource);
}

const compareCodeUnits = (left, right) => left < right ? -1 : left > right ? 1 : 0;

export function finiteNumberOrNull(value) {
  if (typeof value === "string") {
    if (value.length > 128) return null;
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return null;
    value = Number(value);
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonnegative(value) {
  const number = finiteNumberOrNull(value);
  return number !== null && number >= 0 ? number : null;
}

function positive(value) {
  const number = finiteNumberOrNull(value);
  return number !== null && number > 0 ? number : null;
}

function identity(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return typeof value === "string" && value.length <= 1024 && value.trim() ? value.trim() : null;
}

function missing(value) {
  return value === null || value === undefined || (typeof value === "string" && !value.trim());
}

function dateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
    ? value : null;
}

function requireDate(value, field) {
  const date = dateOnly(value);
  if (!date) throw new TypeError(`${field} must be a valid YYYY-MM-DD date`);
  return date;
}

function validYear(value, maximum) {
  const year = positive(value);
  // Retain potentially valid historic CAD records without accepting year 1 as
  // a plausible construction/assessment year or inventing future construction.
  return Number.isSafeInteger(year) && year >= 1600 && year <= maximum ? year : null;
}

/** Calendar-year difference, not inferred completion anniversary or effective age. */
export function ageAtEffectiveDate(yearBuilt, effectiveDate) {
  const year = Number(requireDate(effectiveDate, "effective_date").slice(0, 4));
  const built = validYear(yearBuilt, year);
  return built === null ? null : year - built;
}

function quantile(sorted, fraction) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] * (1 - (position - lower)) + sorted[upper] * (position - lower);
}

/** No rounding or median-of-medians: Type-7 quantiles from every supplied member. */
export function exactDistribution(values, { minimum_count = 1 } = {}) {
  boundedArray(values, "values", NEIGHBORHOOD_STATISTICS_LIMITS.measurement_values);
  if (!Number.isSafeInteger(minimum_count) || minimum_count < 1) {
    throw new TypeError("minimum_count must be a positive integer");
  }
  const sorted = values.map(finiteNumberOrNull).filter((value) => value !== null).sort((a, b) => a - b);
  const count = sorted.length;
  const median = quantile(sorted, 0.5);
  const mean = count ? sorted.reduce((sum, value) => sum + value / count, 0) : null;
  const absoluteDeviation = count ? sorted.reduce((sum, value) => sum + Math.abs(value - median) / count, 0) : null;
  const numericIssues = [];
  const finiteResult = (value, field) => {
    if (value === null || Number.isFinite(value)) return value;
    numericIssues.push(field);
    return null;
  };
  const metrics = {
    low: count ? sorted[0] : null,
    q1: finiteResult(quantile(sorted, 0.25), "q1"),
    median: finiteResult(median, "median"),
    q3: finiteResult(quantile(sorted, 0.75), "q3"),
    high: count ? sorted[count - 1] : null,
    mean: finiteResult(mean, "mean"),
    // Descriptive dispersion only: a low COD does not establish reliability.
    cod_percent: finiteResult(median !== null && median !== 0 ? absoluteDeviation / Math.abs(median) * 100 : null, "cod_percent"),
  };
  finiteResult(absoluteDeviation, "absolute_deviation");
  return {
    state: numericIssues.length ? "incomplete" : count >= minimum_count ? "ready" : "insufficient",
    reason: numericIssues.length ? "numeric_overflow" : count === 0 ? "no_observations" : count < minimum_count ? "below_minimum_count" : null,
    numeric_issues: numericIssues,
    estimator: "exact_member_type_7_quantiles",
    member_count: values.length,
    count,
    missing_count: values.length - count,
    coverage_percent: values.length ? count / values.length * 100 : null,
    minimum_count,
    ...metrics,
  };
}

function uniqueKnown(values) {
  return [...new Set(values.filter((value) => value !== null))];
}

function agreed(values) {
  const known = uniqueKnown(values);
  return known.length === 1 ? known[0] : null;
}

function stockMembers(records, effectiveDate) {
  const maximumYear = Number(effectiveDate.slice(0, 4));
  const grouped = new Map();
  let missingIdentity = 0;
  for (const record of records) {
    const account = identity(record?.account_id);
    if (!account) { missingIdentity += 1; continue; }
    const rows = grouped.get(account) || [];
    rows.push({
      year_built: validYear(record.year_built ?? record.residential_year_built, maximumYear),
      gla_sqft: positive(record.gla_sqft ?? record.living_area_sqft),
      gla_raw_present: !missing(record.gla_sqft ?? record.living_area_sqft),
      site_area_sqft: nonnegative(record.site_area_sqft),
      housing_type: identity(record.housing_type ?? record.land_use_category),
      assessment: {
        value: nonnegative(record.assessed_value ?? record.market_value),
        tax_year: validYear(record.assessment_tax_year ?? record.tax_year, maximumYear),
      },
    });
    grouped.set(account, rows);
  }
  let conflictingFields = 0;
  const members = [...grouped].sort(([a], [b]) => compareCodeUnits(a, b)).map(([account_id, rows]) => {
    const member = { account_id };
    for (const key of Object.keys(rows[0]).filter((key) => key !== "assessment" && key !== "gla_raw_present")) {
      const values = rows.map((row) => row[key]);
      if (uniqueKnown(values).length > 1) conflictingFields += 1;
      member[key] = agreed(values);
    }
    member.gla_missing_reason = member.gla_sqft !== null ? null
      : uniqueKnown(rows.map((row) => row.gla_sqft)).length > 1 ? "conflicting"
        : rows.some((row) => row.gla_raw_present) ? "invalid" : "missing";
    const assessments = new Map();
    for (const row of rows) {
      if (row.assessment.tax_year === null) continue;
      const values = assessments.get(row.assessment.tax_year) || [];
      values.push(row.assessment.value);
      assessments.set(row.assessment.tax_year, values);
    }
    member.assessments = [...assessments].sort(([a], [b]) => a - b).map(([tax_year, values]) => {
      if (uniqueKnown(values).length > 1) conflictingFields += 1;
      return { tax_year, value: agreed(values) };
    });
    member.age_at_effective_date = ageAtEffectiveDate(member.year_built, effectiveDate);
    return member;
  });
  return { members, diagnostics: {
    input_records: records.length,
    missing_account_identity_records: missingIdentity,
    duplicate_account_records: records.length - missingIdentity - members.length,
    conflicting_field_count: conflictingFields,
  } };
}

function normalizeParcels(record) {
  const parcels = Array.isArray(record.parcels) ? record.parcels.map((parcel) => ({
    account_id: identity(parcel?.account_id),
    verified: parcel?.verified === true,
    allocated_sale_price: positive(parcel?.allocated_sale_price),
    allocation_verified: parcel?.allocation_verified === true,
    gla_sqft_at_sale: positive(parcel?.gla_sqft_at_sale),
  })) : [];
  const primary = identity(record.primary_account_id ?? record.account_id);
  if (primary && !parcels.some((parcel) => parcel.account_id === primary)) {
    parcels.push({ account_id: primary, verified: record.primary_account_verified === true, allocated_sale_price: null, allocation_verified: false, gla_sqft_at_sale: positive(record.gla_sqft_at_sale) });
  }
  return parcels;
}

/** sale_id is a canonical internal ID, never an MLS/source-record ID. Missing
 * identity and conflicting duplicates are withheld rather than guessed/merged.
 */
export function deduplicateTransactions(records) {
  boundedArray(records, "sales", NEIGHBORHOOD_STATISTICS_LIMITS.input_records);
  let parcelWork = 0;
  let sourceWork = 0;
  // Check nested input work before constructing any normalized copies.
  for (const record of records) {
    parcelWork += (Array.isArray(record?.parcels) ? record.parcels.length : 0)
      + (identity(record?.primary_account_id ?? record?.account_id) ? 1 : 0);
    sourceWork += Array.isArray(record?.source_references) ? record.source_references.length : 0;
    assertLimit(parcelWork, NEIGHBORHOOD_STATISTICS_LIMITS.parcel_links, "parcel_links");
    assertLimit(sourceWork, NEIGHBORHOOD_STATISTICS_LIMITS.source_references, "source_references");
  }
  const grouped = new Map();
  const diagnostics = { input_records: records.length, missing_identity_records: 0, duplicate_records: 0, conflicting_transaction_ids: [] };
  for (const record of records) {
    const id = identity(record?.canonical_transaction_id ?? record?.sale_id);
    if (!id) { diagnostics.missing_identity_records += 1; continue; }
    const rows = grouped.get(id) || [];
    rows.push(record);
    grouped.set(id, rows);
  }
  const transactions = [];
  for (const [canonical_transaction_id, rows] of [...grouped].sort(([a], [b]) => compareCodeUnits(a, b))) {
    diagnostics.duplicate_records += rows.length - 1;
    const prices = uniqueKnown(rows.map((row) => nonnegative(row.sale_price)));
    const dates = uniqueKnown(rows.map((row) => dateOnly(row.sale_date ?? row.closing_date)));
    if (prices.length > 1 || dates.length > 1) {
      diagnostics.conflicting_transaction_ids.push(canonical_transaction_id);
      continue;
    }
    const groupedParcels = new Map();
    let unidentifiedParcel = false;
    for (const parcel of rows.flatMap(normalizeParcels)) {
      if (!parcel.account_id) { unidentifiedParcel = true; continue; }
      const links = groupedParcels.get(parcel.account_id) || [];
      links.push(parcel);
      groupedParcels.set(parcel.account_id, links);
    }
    const parcels = [...groupedParcels].sort(([a], [b]) => compareCodeUnits(a, b)).map(([account_id, links]) => ({
      account_id,
      verified: links.some((link) => link.verified),
      allocated_sale_price: agreed(links.filter((link) => link.verified && link.allocation_verified).map((link) => link.allocated_sale_price)),
      gla_sqft_at_sale: agreed(links.filter((link) => link.verified).map((link) => link.gla_sqft_at_sale)),
    }));
    const declaredCounts = rows.map((row) => positive(row.parcel_count)).filter(Number.isSafeInteger);
    const expectedCount = declaredCounts.reduce((maximum, value) => Math.max(maximum, value), parcels.length);
    transactions.push({
      canonical_transaction_id,
      sale_date: dates[0] ?? null,
      sale_price: prices[0] ?? null,
      parcels,
      unresolved_parcel_links: unidentifiedParcel || expectedCount !== parcels.length || !parcels.length || parcels.some((parcel) => !parcel.verified),
      // An omitted/null/malformed observation cannot approve a market transfer.
      // One explicit veto wins; otherwise every observation must approve it.
      market_eligible: rows.some((row) => row.market_eligible === false) ? false
        : rows.every((row) => row.market_eligible === true) ? true : null,
      source_references: [...new Set(rows.flatMap((row) => Array.isArray(row.source_references)
        ? row.source_references.map(identity).filter(Boolean) : []))].sort(),
    });
  }
  return { transactions, diagnostics };
}

function measure(values, definition, unit, context, options) {
  return { ...context, definition, unit, ...exactDistribution(values, options) };
}

/** Inputs are already the selected housing-eligible stock and sale evidence.
 * Current physical values are not claimed to be historical values at sale.
 * No current-date fallback, DB access, or price-based member exclusion exists.
 */
export function summarizeNeighborhoodPopulations({
  population_id, effective_date, observation_period, stock = [], sales = [], minimum_sale_count = 3,
}) {
  const populationId = identity(population_id);
  if (!populationId) throw new TypeError("population_id is required");
  const effectiveDate = requireDate(effective_date, "effective_date");
  const start = requireDate(observation_period?.start_date, "observation_period.start_date");
  const end = requireDate(observation_period?.end_date, "observation_period.end_date");
  if (start > end || end > effectiveDate) throw new RangeError("observation period must be ordered and end on or before effective_date");
  boundedArray(stock, "stock", NEIGHBORHOOD_STATISTICS_LIMITS.input_records);
  boundedArray(sales, "sales", NEIGHBORHOOD_STATISTICS_LIMITS.input_records);
  const normalizedStock = stockMembers(stock, effectiveDate);
  const members = normalizedStock.members;
  const byAccount = new Map(members.map((member) => [member.account_id, member]));
  const normalizedSales = deduplicateTransactions(sales);
  const diagnostics = {
    ...normalizedSales.diagnostics, invalid_date_transactions: 0, future_transactions: 0,
    outside_period_transactions: 0, nonmarket_transactions: 0, unknown_market_eligibility_transactions: 0,
    outside_population_transactions: 0,
    unresolved_parcel_transactions: 0, unresolved_allocation_transactions: 0, nonpositive_or_missing_price_transactions: 0,
  };
  const recordedPrices = [];
  const priceMembers = [];
  const soldAccounts = new Set();
  let inPeriodTransactions = 0;
  let eligibleTransactions = 0;
  for (const sale of normalizedSales.transactions) {
    if (!sale.sale_date) { diagnostics.invalid_date_transactions += 1; continue; }
    if (sale.sale_date > effectiveDate) { diagnostics.future_transactions += 1; continue; }
    if (sale.sale_date < start || sale.sale_date > end) { diagnostics.outside_period_transactions += 1; continue; }
    if (sale.market_eligible === false) { diagnostics.nonmarket_transactions += 1; continue; }
    if (sale.market_eligible !== true) { diagnostics.unknown_market_eligibility_transactions += 1; continue; }
    const inStock = sale.parcels.filter((parcel) => parcel.verified && byAccount.has(parcel.account_id));
    if (!inStock.length) {
      diagnostics[sale.unresolved_parcel_links ? "unresolved_parcel_transactions" : "outside_population_transactions"] += 1;
      continue;
    }
    inPeriodTransactions += 1;
    recordedPrices.push(sale.sale_price);
    inStock.forEach((parcel) => soldAccounts.add(parcel.account_id));
    if (sale.unresolved_parcel_links) { diagnostics.unresolved_parcel_transactions += 1; continue; }
    if (positive(sale.sale_price) === null) { diagnostics.nonpositive_or_missing_price_transactions += 1; continue; }
    if (sale.parcels.length > 1) {
      const allocated = sale.parcels.map((parcel) => parcel.allocated_sale_price);
      const sum = allocated.reduce((total, value) => total + (value ?? 0), 0);
      if (allocated.includes(null) || Math.abs(sum - sale.sale_price) > 0.01) {
        diagnostics.unresolved_allocation_transactions += 1;
        continue;
      }
    }
    eligibleTransactions += 1;
    for (const parcel of inStock) {
      priceMembers.push({
        canonical_transaction_id: sale.canonical_transaction_id,
        account_id: parcel.account_id,
        sale_date: sale.sale_date,
        sale_price: sale.parcels.length === 1 ? sale.sale_price : parcel.allocated_sale_price,
        price_basis: sale.parcels.length === 1 ? "recorded_single_parcel" : "verified_parcel_allocation",
        gla_sqft_at_sale: parcel.gla_sqft_at_sale,
        source_references: sale.source_references,
        provenance_state: sale.source_references.length ? "references_supplied_by_adapter" : "absent",
      });
    }
  }
  const context = { population_id: populationId, effective_date: effectiveDate };
  const saleContext = { ...context, observation_period: { start_date: start, end_date: end, bounds: "inclusive" } };
  const stockMeasure = (field, definition, unit) => measure(members.map((member) => member[field]), definition, unit, context);
  const assessedByYear = new Map();
  for (const member of members) {
    for (const assessment of member.assessments) {
      const yearly = assessedByYear.get(assessment.tax_year) || new Map();
      yearly.set(member.account_id, assessment.value);
      assessedByYear.set(assessment.tax_year, yearly);
    }
  }
  assertLimit(members.length * (4 + assessedByYear.size) + recordedPrices.length + priceMembers.length * 2,
    NEIGHBORHOOD_STATISTICS_LIMITS.total_measurement_work, "total_measurement_work");
  const priceAccounts = new Set(priceMembers.map((member) => member.account_id));
  const pricePerSqftValues = priceMembers.map((member) => member.gla_sqft_at_sale === null
    ? null : member.sale_price / member.gla_sqft_at_sale);
  const ppsfOverflowCount = pricePerSqftValues.filter((value) => value !== null && !Number.isFinite(value)).length;
  const pricePerSqft = measure(pricePerSqftValues, "property_sale_price_divided_by_supported_gla_at_sale", "USD_per_square_foot", saleContext, { minimum_count: minimum_sale_count });
  if (ppsfOverflowCount) {
    Object.assign(pricePerSqft, {
      state: "incomplete", reason: "numeric_overflow", arithmetic_overflow_count: ppsfOverflowCount,
      numeric_issues: [...pricePerSqft.numeric_issues, "division_overflow"],
    });
  }
  const result = {
    ...saleContext,
    state: members.length && eligibleTransactions >= minimum_sale_count ? "ready" : "insufficient",
    population_semantics: "explicit_selected_stock_and_verified_transactions",
    age_convention: "calendar_year_difference_at_effective_date_not_effective_age",
    price_adjustments: "none",
    market_trend: {
      state: "unsupported", appreciation_rate_percent: null,
      reason: "raw_price_distributions_do_not_establish_underlying_market_change",
      composition_sensitivity: "not_evaluated_requires_consistent_product_bands_or_characteristic_control",
    },
    predominant_value: { state: "unsupported", value: null, reason: "a_median_is_not_a_predominant_estimate" },
    stock: {
      property_count: members.length,
      year_built: stockMeasure("year_built", "construction_year", "year"),
      age_at_effective_date: stockMeasure("age_at_effective_date", "chronological_age_at_effective_date", "years"),
      gla_sqft: {
        ...stockMeasure("gla_sqft", "gross_living_area", "square_feet"),
        missing_reasons: Object.fromEntries(["missing", "invalid", "conflicting"].map((reason) => [
          reason, members.filter((member) => member.gla_missing_reason === reason).length,
        ])),
      },
      site_area_sqft: stockMeasure("site_area_sqft", "site_area", "square_feet"),
      housing_type_missing_count: members.filter((member) => member.housing_type === null).length,
      assessment_tax_year_missing_count: members.filter((member) => !member.assessments.length).length,
      assessed_values_by_tax_year: [...assessedByYear].sort(([a], [b]) => a - b).map(([tax_year, byAccountForYear]) => ({
        tax_year, ...measure(members.map((member) => byAccountForYear.get(member.account_id) ?? null),
          "assessor_market_assessment_not_sale_price", "USD", context),
      })),
      diagnostics: normalizedStock.diagnostics,
      provenance_state: "source_verification_not_performed_member_inputs_only",
    },
    sales: {
      transaction_count: inPeriodTransactions,
      price_eligible_transaction_count: eligibleTransactions,
      transaction_sufficiency: { state: eligibleTransactions >= minimum_sale_count ? "ready" : "insufficient", minimum_count: minimum_sale_count },
      transaction_veracity: "not_assessed_by_this_module",
      property_price_observation_count: priceMembers.length,
      unique_sold_account_count: soldAccounts.size,
      unique_price_eligible_account_count: priceAccounts.size,
      stock_account_denominator: members.length,
      unique_sold_account_coverage_percent: members.length ? soldAccounts.size / members.length * 100 : null,
      unique_price_eligible_account_coverage_percent: members.length ? priceAccounts.size / members.length * 100 : null,
      recorded_transaction_price: measure(recordedPrices, "recorded_total_transaction_price_not_per_property", "USD", saleContext, { minimum_count: minimum_sale_count }),
      property_sale_price: measure(priceMembers.map((member) => member.sale_price), "recorded_price_with_verified_account_link_or_verified_allocation", "USD", saleContext, { minimum_count: minimum_sale_count }),
      sale_price_per_sqft: pricePerSqft,
      property_price_members: priceMembers,
      diagnostics,
    },
  };
  const distributions = [result.stock.year_built, result.stock.age_at_effective_date, result.stock.gla_sqft,
    result.stock.site_area_sqft, ...result.stock.assessed_values_by_tax_year, result.sales.recorded_transaction_price,
    result.sales.property_sale_price, result.sales.sale_price_per_sqft];
  const incompleteReasons = [];
  if (diagnostics.unknown_market_eligibility_transactions) incompleteReasons.push("market_eligibility_unknown");
  if (distributions.some((distribution) => distribution.state === "incomplete")) incompleteReasons.push("numeric_overflow");
  if (incompleteReasons.length) {
    result.state = "incomplete";
    result.incomplete_reasons = incompleteReasons;
  }
  return result;
}
