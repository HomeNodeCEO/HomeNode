const MAX_MONEY = 250_000_000;
const MAX_AREA = 1_000_000;
const MAX_RENT_COMPARABLES = 30;
const MAX_EXPENSE_LINES = 30;
const METHODS = new Set(["grm", "direct_capitalization", "both"]);
const CONCLUSIONS = new Set(["grm", "direct_capitalization", "reconciled"]);

function text(value, maxLength = 4_000) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function number(value, { min = 0, max = MAX_MONEY, nullable = true } = {}) {
  if (value === null || value === undefined || value === "") return nullable ? null : min;
  const parsed = typeof value === "number"
    ? value
    : Number(String(value).replace(/[$,%\s,]/g, ""));
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error("invalid_income_approach_number");
  }
  return parsed;
}

function money(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : money((sorted[middle - 1] + sorted[middle]) / 2);
}

function normalizeRentalComparable(row, index) {
  const monthlyRent = number(row?.monthly_rent) ?? 0;
  const livingArea = number(row?.living_area_sqft, { max: MAX_AREA });
  return {
    id: text(row?.id, 80) || `rent-comparable-${index + 1}`,
    selected: row?.selected !== false,
    address: text(row?.address, 400),
    mls_number: text(row?.mls_number, 100) || null,
    lease_date: text(row?.lease_date, 10) || null,
    monthly_rent: monthlyRent,
    living_area_sqft: livingArea,
    rent_per_sqft: livingArea ? money(monthlyRent / livingArea) : null,
    distance_miles: number(row?.distance_miles, { max: 1_000 }),
    source: text(row?.source, 200) || null,
    notes: text(row?.notes, 1_000) || null,
  };
}

function normalizeExpense(row, index) {
  return {
    id: text(row?.id, 80) || `income-expense-${index + 1}`,
    description: text(row?.description, 300),
    annual_amount: number(row?.annual_amount) ?? 0,
  };
}

/**
 * Normalize and recalculate an Income Approach workfile section. The browser
 * supplies only appraisal inputs; all derived annual income and value totals are
 * rebuilt here before the section can enter an assignment file or signed report.
 */
export function normalizeIncomeApproachSection(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("invalid_income_approach_section");
  }
  const analysisMethod = METHODS.has(String(input.analysis_method || "").trim())
    ? String(input.analysis_method).trim()
    : "both";
  const conclusionMethod = CONCLUSIONS.has(String(input.conclusion_method || "").trim())
    ? String(input.conclusion_method).trim()
    : "reconciled";
  const rentalComparables = Array.isArray(input.rental_comparables)
    ? input.rental_comparables.slice(0, MAX_RENT_COMPARABLES).map(normalizeRentalComparable)
    : [];
  const selectedRents = rentalComparables
    .filter((row) => row.selected && row.monthly_rent > 0 && row.address)
    .map((row) => row.monthly_rent);
  const recommendedMarketRentMedian = median(selectedRents);
  const recommendedMarketRentAverage = selectedRents.length
    ? money(selectedRents.reduce((sum, value) => sum + value, 0) / selectedRents.length)
    : 0;
  const marketRent = number(input.market_rent) ?? 0;
  const otherIncomeMonthly = number(input.other_income_monthly) ?? 0;
  const potentialGrossIncome = money((marketRent + otherIncomeMonthly) * 12);
  const vacancyRate = number(input.vacancy_rate, { max: 100 }) ?? 0;
  const vacancyCollectionLoss = money(potentialGrossIncome * (vacancyRate / 100));
  const effectiveGrossIncome = money(Math.max(0, potentialGrossIncome - vacancyCollectionLoss));
  const expenseLines = Array.isArray(input.expense_lines)
    ? input.expense_lines.slice(0, MAX_EXPENSE_LINES).map(normalizeExpense)
    : [];
  const operatingExpenses = money(expenseLines.reduce((sum, row) => sum + row.annual_amount, 0));
  const netOperatingIncome = money(Math.max(0, effectiveGrossIncome - operatingExpenses));
  const grm = number(input.grm, { max: 1_000 });
  const capRate = number(input.cap_rate, { max: 100 });
  const grmIndicatedValue = grm ? money(marketRent * grm) : 0;
  const directCapIndicatedValue = capRate ? money(netOperatingIncome / (capRate / 100)) : 0;
  const reconciledInput = number(input.reconciled_indicated_value_input) ?? 0;
  const indicatedValue = conclusionMethod === "grm"
    ? grmIndicatedValue
    : conclusionMethod === "direct_capitalization"
      ? directCapIndicatedValue
      : reconciledInput;
  const roundingIncrement = number(input.rounding_increment, { min: 1, max: 100_000 }) ?? 1_000;
  const roundedIndicatedValue = Math.round(indicatedValue / roundingIncrement) * roundingIncrement;
  const normalized = {
    schema_version: 1,
    developed: false,
    as_of_date: text(input.as_of_date, 10) || null,
    analysis_method: analysisMethod,
    conclusion_method: conclusionMethod,
    rent_source_name: text(input.rent_source_name, 300) || null,
    rent_source_reference: text(input.rent_source_reference, 1_000) || null,
    rental_comparables: rentalComparables,
    selected_rental_count: selectedRents.length,
    recommended_market_rent_median: recommendedMarketRentMedian,
    recommended_market_rent_average: recommendedMarketRentAverage,
    market_rent: marketRent,
    other_income_monthly: otherIncomeMonthly,
    potential_gross_income: potentialGrossIncome,
    vacancy_rate: vacancyRate,
    vacancy_collection_loss: vacancyCollectionLoss,
    effective_gross_income: effectiveGrossIncome,
    expense_lines: expenseLines,
    operating_expenses: operatingExpenses,
    net_operating_income: netOperatingIncome,
    grm,
    grm_indicated_value: grmIndicatedValue,
    cap_rate: capRate,
    direct_cap_indicated_value: directCapIndicatedValue,
    reconciled_indicated_value_input: reconciledInput,
    indicated_value: indicatedValue,
    rounding_increment: roundingIncrement,
    rounded_indicated_value: roundedIndicatedValue,
    weight: number(input.weight, { max: 100 }) ?? 0,
    methodology: text(input.methodology, 8_000) || null,
    summary: text(input.summary, 4_000) || null,
    saved_at: text(input.saved_at, 40) || new Date().toISOString(),
  };
  normalized.developed = incomeApproachReadinessErrors(normalized).length === 0;
  return normalized;
}

export function incomeApproachReadinessErrors(section = {}) {
  const errors = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(section.as_of_date || ""))) errors.push("Enter the Income Approach effective date.");
  if (!String(section.rent_source_name || "").trim()) errors.push("Identify the market-rent data source.");
  if (!(Number(section.selected_rental_count) > 0)) errors.push("Select at least one rental comparable.");
  if (!(Number(section.market_rent) > 0)) errors.push("Enter the concluded monthly market rent.");
  if (section.conclusion_method === "grm" && section.analysis_method === "direct_capitalization") errors.push("Develop the GRM method before selecting its indication.");
  if (section.conclusion_method === "direct_capitalization" && section.analysis_method === "grm") errors.push("Develop direct capitalization before selecting its indication.");
  if (["grm", "both"].includes(section.analysis_method) && !(Number(section.grm) > 0)) errors.push("Enter a supported gross rent multiplier.");
  if (["direct_capitalization", "both"].includes(section.analysis_method) && !(Number(section.cap_rate) > 0)) errors.push("Enter a supported capitalization rate.");
  if (section.conclusion_method === "reconciled" && !(Number(section.reconciled_indicated_value_input) > 0)) errors.push("Enter the reconciled Income Approach indication.");
  if (!String(section.methodology || "").trim()) errors.push("Explain the Income Approach methodology and support.");
  if (!(Number(section.indicated_value) > 0)) errors.push("The selected Income Approach indication must be positive.");
  return errors;
}
