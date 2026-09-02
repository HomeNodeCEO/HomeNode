import { calculateNumericGroupedAdjustment } from './comparableAdjustments.ts';

export type SharedNumericFeature =
  | 'living_area_sqft'
  | 'site_size_sqft'
  | 'bath_count'
  | 'garage_spaces'
  | 'age_years';

export type SharedBinaryFeature = 'pool' | 'solar_panels';

export interface AdjustmentSource {
  name: string;
  reference?: string | null;
  effectiveDate?: string | null;
}

export interface SharedComparableFacts {
  saleId: string;
  salePrice: number;
  concessions?: number | null;
  numeric: Partial<Record<SharedNumericFeature, number | null>>;
  binary?: Partial<Record<SharedBinaryFeature, boolean | null>>;
}

export interface SharedSubjectFacts {
  numeric: Partial<Record<SharedNumericFeature, number | null>>;
  binary?: Partial<Record<SharedBinaryFeature, boolean | null>>;
}

export interface NumericAdjustmentRule {
  feature: SharedNumericFeature;
  amountPerUnit: number;
  source: AdjustmentSource;
}

export interface BinaryAdjustmentRule {
  feature: SharedBinaryFeature;
  amount: number;
  source: AdjustmentSource;
}

export interface ManualComparableAdjustment {
  key: string;
  label: string;
  amount: number;
  source: AdjustmentSource;
}

export interface ComparableAdjustmentLine {
  key: string;
  label: string;
  amount: number;
  source: AdjustmentSource;
  calculation: string;
}

export interface SharedComparableIndication {
  saleId: string;
  salePrice: number;
  adjustmentLines: ComparableAdjustmentLine[];
  netAdjustment: number;
  grossAdjustment: number;
  adjustedSalePrice: number;
}

export interface SharedComparableAnalysisInput {
  subject: SharedSubjectFacts;
  comparable: SharedComparableFacts;
  numericRules?: NumericAdjustmentRule[];
  binaryRules?: BinaryAdjustmentRule[];
  manualAdjustments?: ManualComparableAdjustment[];
}

const FEATURE_LABELS: Record<SharedNumericFeature | SharedBinaryFeature, string> = {
  living_area_sqft: 'Gross living area',
  site_size_sqft: 'Site size',
  bath_count: 'Bathroom count',
  garage_spaces: 'Garage spaces',
  age_years: 'Age',
  pool: 'Pool',
  solar_panels: 'Solar panels',
};

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function rounded(value: number): number {
  const result = Math.round(value);
  return Object.is(result, -0) ? 0 : result;
}

/**
 * Calculate one comparable indication without knowing which product owns it.
 *
 * The function is intentionally persistence-free. Custom Appraisal, Property
 * Tax, and UAD adapters may call it, but file identifiers and workflow records
 * never enter this calculation boundary.
 */
export function calculateSharedComparableIndication(
  input: SharedComparableAnalysisInput,
): SharedComparableIndication {
  if (!input.comparable.saleId.trim()) throw new Error('comparable_sale_id_required');
  if (!Number.isFinite(input.comparable.salePrice) || input.comparable.salePrice <= 0) {
    throw new Error('comparable_sale_price_required');
  }

  const adjustmentLines: ComparableAdjustmentLine[] = [];
  const concessions = finite(input.comparable.concessions);
  if (concessions !== null && concessions > 0) {
    adjustmentLines.push({
      key: 'concessions',
      label: 'Concessions',
      amount: -rounded(concessions),
      source: { name: 'Verified sale concessions' },
      calculation: `-${rounded(concessions)}`,
    });
  }

  for (const rule of input.numericRules || []) {
    const subjectValue = finite(input.subject.numeric[rule.feature]);
    const comparableValue = finite(input.comparable.numeric[rule.feature]);
    if (subjectValue === null || comparableValue === null || subjectValue === comparableValue) continue;

    // Reuse the same universal per-unit calculation currently used by the
    // Custom Appraisal grid. A negative rate is valid for characteristics such
    // as age where an increase generally contributes less value.
    const amount = calculateNumericGroupedAdjustment(
      [{
        dimensionKey: rule.feature,
        fromGroupValue: 0,
        toGroupValue: 1,
        amount: rule.amountPerUnit,
      }],
      rule.feature,
      subjectValue,
      comparableValue,
    );
    if (!amount) continue;
    adjustmentLines.push({
      key: rule.feature,
      label: FEATURE_LABELS[rule.feature],
      amount,
      source: rule.source,
      calculation: `(${subjectValue} - ${comparableValue}) × ${rule.amountPerUnit}`,
    });
  }

  for (const rule of input.binaryRules || []) {
    const subjectValue = input.subject.binary?.[rule.feature];
    const comparableValue = input.comparable.binary?.[rule.feature];
    if (typeof subjectValue !== 'boolean' || typeof comparableValue !== 'boolean'
        || subjectValue === comparableValue) continue;
    const amount = subjectValue ? rounded(rule.amount) : -rounded(rule.amount);
    if (!amount) continue;
    adjustmentLines.push({
      key: rule.feature,
      label: FEATURE_LABELS[rule.feature],
      amount,
      source: rule.source,
      calculation: `${subjectValue ? 'subject' : 'comparable'} has feature × ${rounded(rule.amount)}`,
    });
  }

  for (const manual of input.manualAdjustments || []) {
    if (!manual.key.trim() || !manual.label.trim() || !Number.isFinite(manual.amount)) continue;
    const amount = rounded(manual.amount);
    if (!amount) continue;
    adjustmentLines.push({
      key: manual.key,
      label: manual.label,
      amount,
      source: manual.source,
      calculation: 'Market-supported supplied adjustment',
    });
  }

  const netAdjustment = adjustmentLines.reduce((total, line) => total + line.amount, 0);
  const grossAdjustment = adjustmentLines.reduce((total, line) => total + Math.abs(line.amount), 0);
  return {
    saleId: input.comparable.saleId,
    salePrice: rounded(input.comparable.salePrice),
    adjustmentLines,
    netAdjustment,
    grossAdjustment,
    adjustedSalePrice: rounded(input.comparable.salePrice + netAdjustment),
  };
}

export function medianComparableIndication(
  indications: readonly SharedComparableIndication[],
): number | null {
  const values = indications
    .map((indication) => indication.adjustedSalePrice)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  if (!values.length) return null;
  const midpoint = Math.floor(values.length / 2);
  return rounded(values.length % 2
    ? values[midpoint]
    : (values[midpoint - 1] + values[midpoint]) / 2);
}
