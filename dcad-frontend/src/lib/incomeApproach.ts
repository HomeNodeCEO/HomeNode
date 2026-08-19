export type IncomeRentalComparable = {
  id: string;
  selected: boolean;
  address: string;
  mls_number: string | null;
  lease_date: string | null;
  monthly_rent: number;
  living_area_sqft: number | null;
  rent_per_sqft: number | null;
  distance_miles: number | null;
  source: string | null;
  notes: string | null;
};

export type IncomeExpenseLine = {
  id: string;
  description: string;
  annual_amount: number;
};

export type IncomeApproachDraft = {
  schema_version: 1;
  developed: boolean;
  as_of_date: string | null;
  analysis_method: 'grm' | 'direct_capitalization' | 'both';
  conclusion_method: 'grm' | 'direct_capitalization' | 'reconciled';
  rent_source_name: string | null;
  rent_source_reference: string | null;
  rental_comparables: IncomeRentalComparable[];
  selected_rental_count: number;
  recommended_market_rent_median: number;
  recommended_market_rent_average: number;
  market_rent: number;
  other_income_monthly: number;
  potential_gross_income: number;
  vacancy_rate: number;
  vacancy_collection_loss: number;
  effective_gross_income: number;
  expense_lines: IncomeExpenseLine[];
  operating_expenses: number;
  net_operating_income: number;
  grm: number | null;
  grm_indicated_value: number;
  cap_rate: number | null;
  direct_cap_indicated_value: number;
  reconciled_indicated_value_input: number;
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

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : cents((sorted[middle - 1] + sorted[middle]) / 2);
}

export function calculateIncomeApproach(input: Partial<IncomeApproachDraft>): IncomeApproachDraft {
  const rentalComparables = (input.rental_comparables || []).map((row, index) => {
    const monthlyRent = finite(row.monthly_rent);
    const livingArea = row.living_area_sqft == null ? null : finite(row.living_area_sqft);
    return {
      ...row,
      id: row.id || `rent-comparable-${index + 1}`,
      selected: row.selected !== false,
      monthly_rent: monthlyRent,
      living_area_sqft: livingArea,
      rent_per_sqft: livingArea ? cents(monthlyRent / livingArea) : null,
    };
  });
  const selectedRents = rentalComparables.filter((row) => row.selected && row.monthly_rent > 0 && row.address.trim()).map((row) => row.monthly_rent);
  const marketRent = finite(input.market_rent);
  const otherIncome = finite(input.other_income_monthly);
  const potentialGrossIncome = cents((marketRent + otherIncome) * 12);
  const vacancyRate = finite(input.vacancy_rate);
  const vacancyLoss = cents(potentialGrossIncome * vacancyRate / 100);
  const effectiveGrossIncome = cents(Math.max(0, potentialGrossIncome - vacancyLoss));
  const expenseLines = (input.expense_lines || []).map((row, index) => ({
    ...row,
    id: row.id || `income-expense-${index + 1}`,
    annual_amount: finite(row.annual_amount),
  }));
  const operatingExpenses = cents(expenseLines.reduce((sum, row) => sum + row.annual_amount, 0));
  const netOperatingIncome = cents(Math.max(0, effectiveGrossIncome - operatingExpenses));
  const grm = input.grm == null ? null : finite(input.grm);
  const capRate = input.cap_rate == null ? null : finite(input.cap_rate);
  const grmValue = grm ? cents(marketRent * grm) : 0;
  const capValue = capRate ? cents(netOperatingIncome / (capRate / 100)) : 0;
  const conclusionMethod = input.conclusion_method || 'reconciled';
  const reconciledInput = finite(input.reconciled_indicated_value_input);
  const indicatedValue = conclusionMethod === 'grm' ? grmValue : conclusionMethod === 'direct_capitalization' ? capValue : reconciledInput;
  const rounding = finite(input.rounding_increment, 1_000) || 1_000;
  const result: IncomeApproachDraft = {
    schema_version: 1,
    developed: false,
    as_of_date: input.as_of_date || null,
    analysis_method: input.analysis_method || 'both',
    conclusion_method: conclusionMethod,
    rent_source_name: input.rent_source_name || null,
    rent_source_reference: input.rent_source_reference || null,
    rental_comparables: rentalComparables,
    selected_rental_count: selectedRents.length,
    recommended_market_rent_median: median(selectedRents),
    recommended_market_rent_average: selectedRents.length ? cents(selectedRents.reduce((sum, value) => sum + value, 0) / selectedRents.length) : 0,
    market_rent: marketRent,
    other_income_monthly: otherIncome,
    potential_gross_income: potentialGrossIncome,
    vacancy_rate: vacancyRate,
    vacancy_collection_loss: vacancyLoss,
    effective_gross_income: effectiveGrossIncome,
    expense_lines: expenseLines,
    operating_expenses: operatingExpenses,
    net_operating_income: netOperatingIncome,
    grm,
    grm_indicated_value: grmValue,
    cap_rate: capRate,
    direct_cap_indicated_value: capValue,
    reconciled_indicated_value_input: reconciledInput,
    indicated_value: indicatedValue,
    rounding_increment: rounding,
    rounded_indicated_value: Math.round(indicatedValue / rounding) * rounding,
    weight: finite(input.weight),
    methodology: input.methodology || null,
    summary: input.summary || null,
    saved_at: input.saved_at || new Date().toISOString(),
  };
  result.developed = incomeApproachReadinessErrors(result).length === 0;
  return result;
}

export function incomeApproachReadinessErrors(section: Partial<IncomeApproachDraft>): string[] {
  const errors: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(section.as_of_date || ''))) errors.push('Enter the Income Approach effective date.');
  if (!String(section.rent_source_name || '').trim()) errors.push('Identify the market-rent data source.');
  if (!(finite(section.selected_rental_count) > 0)) errors.push('Select at least one rental comparable.');
  if (!(finite(section.market_rent) > 0)) errors.push('Enter the concluded monthly market rent.');
  if (section.conclusion_method === 'grm' && section.analysis_method === 'direct_capitalization') errors.push('Develop the GRM method before selecting its indication.');
  if (section.conclusion_method === 'direct_capitalization' && section.analysis_method === 'grm') errors.push('Develop direct capitalization before selecting its indication.');
  if (['grm', 'both'].includes(section.analysis_method || 'both') && !(finite(section.grm) > 0)) errors.push('Enter a supported gross rent multiplier.');
  if (['direct_capitalization', 'both'].includes(section.analysis_method || 'both') && !(finite(section.cap_rate) > 0)) errors.push('Enter a supported capitalization rate.');
  if ((section.conclusion_method || 'reconciled') === 'reconciled' && !(finite(section.reconciled_indicated_value_input) > 0)) errors.push('Enter the reconciled Income Approach indication.');
  if (!String(section.methodology || '').trim()) errors.push('Explain the Income Approach methodology and support.');
  if (!(finite(section.indicated_value) > 0)) errors.push('The selected Income Approach indication must be positive.');
  return errors;
}
