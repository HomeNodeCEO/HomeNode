export type FinalReconciliationApproachKey =
  | 'sales_comparison'
  | 'income_approach'
  | 'cost_approach';

export type FinalReconciliationApproach = {
  developed: boolean;
  indicated_value: number;
  source_revision: number;
};

export type FinalReconciliationDraft = {
  schema_version: 1;
  developed: boolean;
  effective_date: string | null;
  approaches: Record<FinalReconciliationApproachKey, FinalReconciliationApproach>;
  weights: Record<FinalReconciliationApproachKey, number>;
  weight_total: number;
  calculated_weighted_value: number;
  rounding_increment: number;
  rounded_weighted_value: number;
  concluded_value_input: number | null;
  final_value: number;
  variance_from_weighted_percent: number;
  explanation: string | null;
  override_explanation: string | null;
  certification: string;
  certification_confirmed: boolean;
  saved_at: string;
};

export const DEFAULT_APPRAISER_CERTIFICATION =
  'I certify that, to the best of my knowledge and belief, the statements of fact contained in this report are true and correct; the analyses, opinions, and conclusions are limited only by the reported assumptions and limiting conditions; and I have no undisclosed present or prospective interest in the property that is the subject of this report.';

function finite(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number'
    ? value
    : Number(String(value ?? '').replace(/[$,%\s,]/g, ''));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function calculateFinalReconciliation(
  input: Partial<FinalReconciliationDraft>,
  approaches: FinalReconciliationDraft['approaches'],
): FinalReconciliationDraft {
  const salesWeight = approaches.sales_comparison.developed
    ? finite(input.weights?.sales_comparison, 100)
    : 0;
  const incomeWeight = approaches.income_approach.developed
    ? finite(input.weights?.income_approach)
    : 0;
  const costWeight = approaches.cost_approach.developed
    ? finite(input.weights?.cost_approach)
    : 0;
  const weightTotal = money(salesWeight + incomeWeight + costWeight);
  const calculatedWeightedValue = money(
    approaches.sales_comparison.indicated_value * (salesWeight / 100) +
    approaches.income_approach.indicated_value * (incomeWeight / 100) +
    approaches.cost_approach.indicated_value * (costWeight / 100),
  );
  const roundingIncrement = finite(input.rounding_increment, 1_000) || 1_000;
  const roundedWeightedValue =
    Math.round(calculatedWeightedValue / roundingIncrement) * roundingIncrement;
  const concludedInput = input.concluded_value_input == null
    ? null
    : finite(input.concluded_value_input);
  const finalValue = concludedInput && concludedInput > 0
    ? concludedInput
    : roundedWeightedValue;
  const result: FinalReconciliationDraft = {
    schema_version: 1,
    developed: false,
    effective_date: input.effective_date || null,
    approaches,
    weights: {
      sales_comparison: salesWeight,
      income_approach: incomeWeight,
      cost_approach: costWeight,
    },
    weight_total: weightTotal,
    calculated_weighted_value: calculatedWeightedValue,
    rounding_increment: roundingIncrement,
    rounded_weighted_value: roundedWeightedValue,
    concluded_value_input: concludedInput,
    final_value: finalValue,
    variance_from_weighted_percent: calculatedWeightedValue > 0
      ? money(((finalValue - calculatedWeightedValue) / calculatedWeightedValue) * 100)
      : 0,
    explanation: input.explanation || null,
    override_explanation: input.override_explanation || null,
    certification: input.certification || DEFAULT_APPRAISER_CERTIFICATION,
    certification_confirmed: input.certification_confirmed === true,
    saved_at: input.saved_at || new Date().toISOString(),
  };
  result.developed = finalReconciliationReadinessErrors(result).length === 0;
  return result;
}

export function finalReconciliationReadinessErrors(
  section: Partial<FinalReconciliationDraft>,
): string[] {
  const errors: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(section.effective_date || ''))) {
    errors.push('Enter the appraisal effective date.');
  }
  if (!(finite(section.approaches?.sales_comparison?.indicated_value) > 0)) {
    errors.push('Develop and save a positive Sales Comparison Approach indication.');
  }
  if (Math.abs(finite(section.weight_total) - 100) > 0.01) {
    errors.push('Approach reconciliation weights must total 100%.');
  }
  if (!(finite(section.final_value) > 0)) {
    errors.push('Enter a positive final opinion of value.');
  }
  if (!String(section.explanation || '').trim()) {
    errors.push('Explain the final reconciliation and the relative weight given to each approach.');
  }
  if (Math.abs(Number(section.variance_from_weighted_percent || 0)) > 10 &&
      !String(section.override_explanation || '').trim()) {
    errors.push('Explain why the final opinion differs from the weighted indication by more than 10%.');
  }
  if (!String(section.certification || '').trim()) {
    errors.push('The appraiser certification is required.');
  }
  if (section.certification_confirmed !== true) {
    errors.push('Confirm the appraiser certification before finalization.');
  }
  return errors;
}
