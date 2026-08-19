const MAX_UNIT_COST = 5_000_000;

function number(value, { min = 0, max = MAX_UNIT_COST } = {}) {
  const parsed = typeof value === "number"
    ? value
    : Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error("invalid_depreciated_cost_number");
  }
  return parsed;
}

function text(value, maxLength = 300) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function rounded(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Develop one adjustment unit from replacement cost new less depreciation.
 * The server recalculates every amount so a browser cannot persist unsupported
 * derived values in the appraisal workfile.
 */
export function calculateDepreciatedCostAdjustment(input = {}) {
  const description = text(input.description);
  if (!description) throw new Error("depreciated_cost_description_required");
  const target = String(input.target_dimension || "").trim().toLowerCase();
  if (!["living_area", "garage", "pool"].includes(target)) {
    throw new Error("invalid_depreciated_cost_target");
  }
  const unitCost = number(input.unit_cost, { min: 0.01 });
  const localMultiplier = number(input.local_multiplier ?? 1, { min: 0.1, max: 10 });
  const incentivePercent = number(input.entrepreneurial_incentive_percent ?? 0, { max: 100 });
  const depreciationPercent = number(input.depreciation_percent ?? 0, { max: 100 });
  const factorPercent = number(input.factor_percent ?? 100, { max: 500 });
  const sourceName = text(input.source_name, 500) || null;
  const sourceReference = text(input.source_reference, 1_000) || null;
  const asOfDate = text(input.as_of_date, 10) || null;
  if (asOfDate && !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    throw new Error("invalid_depreciated_cost_date");
  }

  const directCostPerUnit = unitCost * localMultiplier;
  const replacementCostNewPerUnit = directCostPerUnit * (1 + incentivePercent / 100);
  const depreciationPerUnit = replacementCostNewPerUnit * (depreciationPercent / 100);
  const depreciatedCostPerUnit = Math.max(0, replacementCostNewPerUnit - depreciationPerUnit);
  const factoredAmount = depreciatedCostPerUnit * (factorPercent / 100);
  const perSquareFoot = target === "living_area";

  return {
    schema_version: 1,
    methodology: "replacement_cost_new_less_depreciation",
    target_dimension: target,
    description,
    source_name: sourceName,
    source_reference: sourceReference,
    as_of_date: asOfDate,
    unit_cost: rounded(unitCost),
    local_multiplier: rounded(localMultiplier, 4),
    entrepreneurial_incentive_percent: rounded(incentivePercent),
    depreciation_percent: rounded(depreciationPercent),
    factor_percent: rounded(factorPercent),
    direct_cost_per_unit: rounded(directCostPerUnit),
    replacement_cost_new_per_unit: rounded(replacementCostNewPerUnit),
    depreciation_per_unit: rounded(depreciationPerUnit),
    depreciated_cost_per_unit: perSquareFoot
      ? rounded(depreciatedCostPerUnit)
      : Math.round(depreciatedCostPerUnit / 100) * 100,
    recommended_adjustment: perSquareFoot
      ? rounded(factoredAmount)
      : Math.round(factoredAmount / 100) * 100,
    unit: perSquareFoot ? "per_square_foot" : target === "garage" ? "per_garage_space" : "per_feature",
    formula: "unit_cost × local_multiplier × (1 + entrepreneurial_incentive_percent) × (1 − depreciation_percent) × factor_percent",
  };
}

export function depreciatedCostAdjustmentErrorStatus(message) {
  if (String(message || "").startsWith("invalid_") || String(message || "").endsWith("_required")) return 400;
  return 500;
}
