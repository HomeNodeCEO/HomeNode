export type CostApproachLine = {
  id: string;
  description: string;
  quantity: number;
  unit: 'sf' | 'lf' | 'ea' | 'lump_sum';
  unit_cost: number;
  total_cost?: number;
};

export type CostApproachDraft = {
  schema_version: 1;
  calculation_method: 'replacement_cost';
  developed: boolean;
  as_of_date: string | null;
  source_name: string | null;
  source_reference: string | null;
  living_area_sqft: number | null;
  cost_per_sqft: number | null;
  local_multiplier: number;
  dwelling_base_cost: number;
  other_improvements: CostApproachLine[];
  other_improvements_total: number;
  direct_cost_before_incentive: number;
  entrepreneurial_incentive_percent: number;
  entrepreneurial_incentive: number;
  replacement_cost_new: number;
  effective_age: number | null;
  economic_life: number | null;
  physical_depreciation_override_percent: number | null;
  physical_depreciation_percent: number;
  curable_physical_deterioration: number;
  incurable_physical_depreciation: number;
  physical_depreciation: number;
  functional_obsolescence: number;
  external_obsolescence: number;
  total_depreciation: number;
  depreciated_improvement_value: number;
  site_value: number;
  site_improvements_value: number;
  indicated_value: number;
  rounding_increment: number;
  rounded_indicated_value: number;
  weight: number;
  methodology: string | null;
  summary: string | null;
  saved_at: string;
};

function finite(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[$,%\s,]/g, ''));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function cents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function calculateCostApproach(input: Partial<CostApproachDraft>): CostApproachDraft {
  const livingArea = input.living_area_sqft == null ? null : finite(input.living_area_sqft);
  const costPerSqft = input.cost_per_sqft == null ? null : finite(input.cost_per_sqft);
  const localMultiplier = finite(input.local_multiplier, 1) || 1;
  const incentivePercent = finite(input.entrepreneurial_incentive_percent);
  const effectiveAge = input.effective_age == null ? null : finite(input.effective_age);
  const economicLife = input.economic_life == null ? null : finite(input.economic_life);
  const override = input.physical_depreciation_override_percent == null
    ? null
    : Math.min(100, finite(input.physical_depreciation_override_percent));
  const ageLife = effectiveAge != null && economicLife
    ? Math.min(100, cents((effectiveAge / economicLife) * 100))
    : 0;
  const depreciationPercent = override ?? ageLife;
  const lines = (input.other_improvements || []).map((line, index) => ({
    ...line,
    id: line.id || `cost-line-${index + 1}`,
    quantity: finite(line.quantity),
    unit_cost: finite(line.unit_cost),
    total_cost: cents(finite(line.quantity) * finite(line.unit_cost)),
  }));
  const dwellingBase = cents((livingArea || 0) * (costPerSqft || 0) * localMultiplier);
  const otherTotal = cents(lines.reduce((sum, line) => sum + (line.total_cost || 0), 0));
  const directCost = cents(dwellingBase + otherTotal);
  const incentive = cents(directCost * (incentivePercent / 100));
  const replacementCost = cents(directCost + incentive);
  const curable = Math.min(finite(input.curable_physical_deterioration), replacementCost);
  const incurable = cents(Math.max(0, replacementCost - curable) * (depreciationPercent / 100));
  const physical = cents(curable + incurable);
  const functional = finite(input.functional_obsolescence);
  const external = finite(input.external_obsolescence);
  const totalDepreciation = cents(Math.min(replacementCost, physical + functional + external));
  const depreciatedImprovement = cents(Math.max(0, replacementCost - totalDepreciation));
  const siteValue = finite(input.site_value);
  const siteImprovements = finite(input.site_improvements_value);
  const indicated = cents(depreciatedImprovement + siteValue + siteImprovements);
  const rounding = finite(input.rounding_increment, 1_000) || 1_000;
  const result: CostApproachDraft = {
    schema_version: 1,
    calculation_method: 'replacement_cost',
    developed: false,
    as_of_date: input.as_of_date || null,
    source_name: input.source_name || null,
    source_reference: input.source_reference || null,
    living_area_sqft: livingArea,
    cost_per_sqft: costPerSqft,
    local_multiplier: localMultiplier,
    dwelling_base_cost: dwellingBase,
    other_improvements: lines,
    other_improvements_total: otherTotal,
    direct_cost_before_incentive: directCost,
    entrepreneurial_incentive_percent: incentivePercent,
    entrepreneurial_incentive: incentive,
    replacement_cost_new: replacementCost,
    effective_age: effectiveAge,
    economic_life: economicLife,
    physical_depreciation_override_percent: override,
    physical_depreciation_percent: depreciationPercent,
    curable_physical_deterioration: curable,
    incurable_physical_depreciation: incurable,
    physical_depreciation: physical,
    functional_obsolescence: functional,
    external_obsolescence: external,
    total_depreciation: totalDepreciation,
    depreciated_improvement_value: depreciatedImprovement,
    site_value: siteValue,
    site_improvements_value: siteImprovements,
    indicated_value: indicated,
    rounding_increment: rounding,
    rounded_indicated_value: Math.round(indicated / rounding) * rounding,
    weight: finite(input.weight),
    methodology: input.methodology || null,
    summary: input.summary || null,
    saved_at: input.saved_at || new Date().toISOString(),
  };
  result.developed = costApproachReadinessErrors(result).length === 0;
  return result;
}

export function costApproachReadinessErrors(section: Partial<CostApproachDraft>): string[] {
  const errors: string[] = [];
  if (!(finite(section.living_area_sqft) > 0)) errors.push('Enter the subject living area.');
  if (!(finite(section.cost_per_sqft) > 0)) errors.push('Enter a replacement-cost rate per square foot.');
  if (!String(section.source_name || '').trim()) errors.push('Identify the cost-data source.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(section.as_of_date || ''))) errors.push('Enter the cost-data effective date.');
  if (!(finite(section.economic_life) > 0)) errors.push('Enter the total economic life.');
  if (section.effective_age == null) errors.push('Enter the effective age.');
  if (!String(section.methodology || '').trim()) errors.push('Explain the Cost Approach methodology and support.');
  if (!(finite(section.indicated_value) > 0)) errors.push('The calculated Cost Approach indication must be positive.');
  return errors;
}

