const MAX_MONEY = 250_000_000;
const MAX_AREA = 1_000_000;
const MAX_LINES = 40;
const VALID_UNITS = new Set(["sf", "lf", "ea", "lump_sum"]);

function text(value, maxLength = 4_000) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function number(value, { min = 0, max = MAX_MONEY, nullable = true } = {}) {
  if (value === null || value === undefined || value === "") return nullable ? null : min;
  const parsed = typeof value === "number"
    ? value
    : Number(String(value).replace(/[$,%\s,]/g, ""));
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error("invalid_cost_approach_number");
  }
  return parsed;
}

function roundedMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normalizeLine(line, index) {
  const quantity = number(line?.quantity, { max: MAX_AREA, nullable: false });
  const unitCost = number(line?.unit_cost, { nullable: false });
  const unit = VALID_UNITS.has(String(line?.unit || "").trim().toLowerCase())
    ? String(line.unit).trim().toLowerCase()
    : "lump_sum";
  return {
    id: text(line?.id, 80) || `cost-line-${index + 1}`,
    description: text(line?.description, 300),
    quantity,
    unit,
    unit_cost: unitCost,
    total_cost: roundedMoney(quantity * unitCost),
  };
}

/**
 * Normalize and recalculate a Cost Approach workfile section. Derived values are
 * never trusted from the browser, which keeps saved files and signed PDFs auditable.
 */
export function normalizeCostApproachSection(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("invalid_cost_approach_section");
  }
  const livingArea = number(input.living_area_sqft, { max: MAX_AREA });
  const costPerSqft = number(input.cost_per_sqft, { max: 25_000 });
  const localMultiplier = number(input.local_multiplier, { min: 0.1, max: 10 }) ?? 1;
  const entrepreneurialPercent = number(input.entrepreneurial_incentive_percent, { max: 100 }) ?? 0;
  const effectiveAge = number(input.effective_age, { max: 300 });
  const economicLife = number(input.economic_life, { min: 1, max: 300 });
  const overrideDepreciation = number(input.physical_depreciation_override_percent, { max: 100 });
  const ageLifePercent = effectiveAge !== null && economicLife !== null
    ? Math.min(100, roundedMoney((effectiveAge / economicLife) * 100))
    : 0;
  const physicalDepreciationPercent = overrideDepreciation ?? ageLifePercent;
  const curablePhysical = number(input.curable_physical_deterioration) ?? 0;
  const functionalObsolescence = number(input.functional_obsolescence) ?? 0;
  const externalObsolescence = number(input.external_obsolescence) ?? 0;
  const siteValue = number(input.site_value) ?? 0;
  const siteImprovementsValue = number(input.site_improvements_value) ?? 0;
  const weight = number(input.weight, { max: 100 }) ?? 0;
  const roundingIncrement = number(input.rounding_increment, { min: 1, max: 100_000 }) ?? 1_000;
  const otherImprovements = Array.isArray(input.other_improvements)
    ? input.other_improvements.slice(0, MAX_LINES).map(normalizeLine)
    : [];

  const dwellingBaseCost = roundedMoney((livingArea || 0) * (costPerSqft || 0) * localMultiplier);
  const otherImprovementsTotal = roundedMoney(otherImprovements.reduce((sum, line) => sum + line.total_cost, 0));
  const directCostBeforeIncentive = roundedMoney(dwellingBaseCost + otherImprovementsTotal);
  const entrepreneurialIncentive = roundedMoney(directCostBeforeIncentive * (entrepreneurialPercent / 100));
  const replacementCostNew = roundedMoney(directCostBeforeIncentive + entrepreneurialIncentive);
  const boundedCurablePhysical = Math.min(curablePhysical, replacementCostNew);
  const incurablePhysical = roundedMoney(
    Math.max(0, replacementCostNew - boundedCurablePhysical) * (physicalDepreciationPercent / 100),
  );
  const physicalDepreciation = roundedMoney(boundedCurablePhysical + incurablePhysical);
  const totalDepreciation = roundedMoney(Math.min(
    replacementCostNew,
    physicalDepreciation + functionalObsolescence + externalObsolescence,
  ));
  const depreciatedImprovementValue = roundedMoney(Math.max(0, replacementCostNew - totalDepreciation));
  const indicatedValue = roundedMoney(depreciatedImprovementValue + siteValue + siteImprovementsValue);
  const roundedIndicatedValue = Math.round(indicatedValue / roundingIncrement) * roundingIncrement;

  const normalized = {
    schema_version: 1,
    calculation_method: "replacement_cost",
    developed: false,
    as_of_date: text(input.as_of_date, 10) || null,
    source_name: text(input.source_name, 300) || null,
    source_reference: text(input.source_reference, 1_000) || null,
    living_area_sqft: livingArea,
    cost_per_sqft: costPerSqft,
    local_multiplier: localMultiplier,
    dwelling_base_cost: dwellingBaseCost,
    other_improvements: otherImprovements,
    other_improvements_total: otherImprovementsTotal,
    direct_cost_before_incentive: directCostBeforeIncentive,
    entrepreneurial_incentive_percent: entrepreneurialPercent,
    entrepreneurial_incentive: entrepreneurialIncentive,
    replacement_cost_new: replacementCostNew,
    effective_age: effectiveAge,
    economic_life: economicLife,
    physical_depreciation_override_percent: overrideDepreciation,
    physical_depreciation_percent: physicalDepreciationPercent,
    curable_physical_deterioration: boundedCurablePhysical,
    incurable_physical_depreciation: incurablePhysical,
    physical_depreciation: physicalDepreciation,
    functional_obsolescence: functionalObsolescence,
    external_obsolescence: externalObsolescence,
    total_depreciation: totalDepreciation,
    depreciated_improvement_value: depreciatedImprovementValue,
    site_value: siteValue,
    site_improvements_value: siteImprovementsValue,
    indicated_value: indicatedValue,
    rounding_increment: roundingIncrement,
    rounded_indicated_value: roundedIndicatedValue,
    weight,
    methodology: text(input.methodology, 8_000) || null,
    summary: text(input.summary, 4_000) || null,
    saved_at: text(input.saved_at, 40) || new Date().toISOString(),
  };
  normalized.developed = costApproachReadinessErrors(normalized).length === 0;
  return normalized;
}

export function costApproachReadinessErrors(section = {}) {
  const errors = [];
  if (!(Number(section.living_area_sqft) > 0)) errors.push("Enter the subject living area.");
  if (!(Number(section.cost_per_sqft) > 0)) errors.push("Enter a replacement-cost rate per square foot.");
  if (!String(section.source_name || "").trim()) errors.push("Identify the cost-data source.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(section.as_of_date || ""))) errors.push("Enter the cost-data effective date.");
  if (!(Number(section.economic_life) > 0)) errors.push("Enter the total economic life.");
  if (section.effective_age === null || section.effective_age === undefined) errors.push("Enter the effective age.");
  if (!String(section.methodology || "").trim()) errors.push("Explain the Cost Approach methodology and support.");
  if (!(Number(section.indicated_value) > 0)) errors.push("The calculated Cost Approach indication must be positive.");
  return errors;
}

