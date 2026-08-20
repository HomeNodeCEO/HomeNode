const MAX_MONEY = 250_000_000;
const DEFAULT_CERTIFICATION = "I certify that, to the best of my knowledge and belief, the statements of fact contained in this report are true and correct; the analyses, opinions, and conclusions are limited only by the reported assumptions and limiting conditions; and I have no undisclosed present or prospective interest in the property that is the subject of this report.";

function text(value, maxLength = 8_000) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function number(value, { min = 0, max = MAX_MONEY, nullable = true } = {}) {
  if (value === null || value === undefined || value === "") return nullable ? null : min;
  const parsed = typeof value === "number"
    ? value
    : Number(String(value).replace(/[$,%\s,]/g, ""));
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error("invalid_final_reconciliation_number");
  }
  return parsed;
}

function money(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function approachValue(section, keys) {
  for (const key of keys) {
    const value = number(section?.[key]);
    if (value && value > 0) return value;
  }
  return 0;
}

function sourceApproaches(sections = {}) {
  const sales = sections.sales_comparison || {};
  const income = sections.income_approach || {};
  const cost = sections.cost_approach || {};
  const salesValue = approachValue(sales, ["opinionAfterCostToCure", "opinionOfValue"]);
  const incomeValue = income.developed
    ? approachValue(income, ["rounded_indicated_value", "indicated_value"])
    : 0;
  const costValue = cost.developed
    ? approachValue(cost, ["rounded_indicated_value", "indicated_value"])
    : 0;
  return {
    sales_comparison: {
      developed: salesValue > 0,
      indicated_value: salesValue,
      source_revision: Number(sections.sales_comparison_revision || 0),
    },
    income_approach: {
      developed: incomeValue > 0,
      indicated_value: incomeValue,
      source_revision: Number(sections.income_approach_revision || 0),
    },
    cost_approach: {
      developed: costValue > 0,
      indicated_value: costValue,
      source_revision: Number(sections.cost_approach_revision || 0),
    },
  };
}

function requestedWeight(input, key, fallback = 0) {
  const direct = input?.weights?.[key];
  const legacy = input?.[`${key}_weight`];
  return number(direct ?? legacy, { max: 100 }) ?? fallback;
}

/**
 * Rebuild the final approach reconciliation from the authoritative workfile
 * sections. Browser-supplied approach indications are intentionally ignored.
 */
export function normalizeFinalReconciliationSection(input = {}, sections = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("invalid_final_reconciliation_section");
  }
  const approaches = sourceApproaches(sections);
  const salesWeight = approaches.sales_comparison.developed
    ? requestedWeight(input, "sales_comparison", 100)
    : 0;
  const incomeWeight = approaches.income_approach.developed
    ? requestedWeight(input, "income_approach")
    : 0;
  const costWeight = approaches.cost_approach.developed
    ? requestedWeight(input, "cost_approach")
    : 0;
  const weightTotal = money(salesWeight + incomeWeight + costWeight);
  const weightedValue = money(
    approaches.sales_comparison.indicated_value * (salesWeight / 100) +
    approaches.income_approach.indicated_value * (incomeWeight / 100) +
    approaches.cost_approach.indicated_value * (costWeight / 100),
  );
  const roundingIncrement = number(input.rounding_increment, { min: 1, max: 100_000 }) ?? 1_000;
  const roundedWeightedValue = Math.round(weightedValue / roundingIncrement) * roundingIncrement;
  const concludedInput = number(input.concluded_value_input);
  const finalValue = concludedInput && concludedInput > 0 ? concludedInput : roundedWeightedValue;
  const variancePercent = weightedValue > 0
    ? money(((finalValue - weightedValue) / weightedValue) * 100)
    : 0;
  const normalized = {
    schema_version: 1,
    developed: false,
    effective_date: text(input.effective_date, 10) ||
      text(sections.sales_comparison?.workspace?.search?.asOfDate, 10) || null,
    approaches,
    weights: {
      sales_comparison: salesWeight,
      income_approach: incomeWeight,
      cost_approach: costWeight,
    },
    weight_total: weightTotal,
    calculated_weighted_value: weightedValue,
    rounding_increment: roundingIncrement,
    rounded_weighted_value: roundedWeightedValue,
    concluded_value_input: concludedInput,
    final_value: finalValue,
    variance_from_weighted_percent: variancePercent,
    explanation: text(input.explanation) || null,
    override_explanation: text(input.override_explanation, 4_000) || null,
    certification: text(input.certification, 8_000) || DEFAULT_CERTIFICATION,
    certification_confirmed: input.certification_confirmed === true,
    saved_at: text(input.saved_at, 40) || new Date().toISOString(),
  };
  normalized.developed = finalReconciliationReadinessErrors(normalized).length === 0;
  return normalized;
}

export function finalReconciliationReadinessErrors(section = {}) {
  const errors = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(section.effective_date || ""))) {
    errors.push("Enter the appraisal effective date.");
  }
  if (!(Number(section.approaches?.sales_comparison?.indicated_value) > 0)) {
    errors.push("Develop and save a positive Sales Comparison Approach indication.");
  }
  if (Math.abs(Number(section.weight_total || 0) - 100) > 0.01) {
    errors.push("Approach reconciliation weights must total 100%.");
  }
  if (!(Number(section.final_value) > 0)) {
    errors.push("Enter a positive final opinion of value.");
  }
  if (!String(section.explanation || "").trim()) {
    errors.push("Explain the final reconciliation and the relative weight given to each approach.");
  }
  if (Math.abs(Number(section.variance_from_weighted_percent || 0)) > 10 &&
      !String(section.override_explanation || "").trim()) {
    errors.push("Explain why the final opinion differs from the weighted indication by more than 10%.");
  }
  if (!String(section.certification || "").trim()) {
    errors.push("The appraiser certification is required.");
  }
  if (section.certification_confirmed !== true) {
    errors.push("Confirm the appraiser certification before finalization.");
  }
  return errors;
}

export { DEFAULT_CERTIFICATION };
