import type { NeighborhoodRelevanceAssessment } from './neighborhoodRelevanceTypes';

type Candidate = NonNullable<NeighborhoodRelevanceAssessment['visualization']>[number];

function numeric(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^-?\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

export function summarizePocketValues(values: unknown[], allowZero = false) {
  const known = values.map(numeric).filter((value): value is number =>
    value !== null && (allowZero ? value >= 0 : value > 0),
  ).sort((left, right) => left - right);
  const middle = Math.floor(known.length / 2);
  return {
    count: known.length,
    missing: values.length - known.length,
    low: known[0] ?? null,
    median: !known.length ? null : known.length % 2
      ? known[middle] : (known[middle - 1] + known[middle]) / 2,
    high: known.at(-1) ?? null,
  };
}

function breakdown(values: Array<string | null | undefined>) {
  const counts = new Map<string, number>();
  for (const value of values) {
    const label = value?.replace(/\s+/g, ' ').trim().toUpperCase() || 'NOT AVAILABLE';
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts].map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function saleRecords(candidate: Candidate) {
  // Preserve every supplied transaction, not just the most recent sale.
  return candidate.sales?.length ? candidate.sales : [{
    sale_price: candidate.sale_price,
    sale_date: candidate.sale_date,
    days_on_market: null,
  }];
}

/** Inspection only: never changes cohort membership or substitutes for report statistics. */
export function buildNeighborhoodPocketDetails(
  assessment: NeighborhoodRelevanceAssessment,
  pocketId: string,
) {
  const properties = (assessment.visualization || []).filter((candidate) =>
    (candidate.pocket_id || candidate.cluster_id) === pocketId,
  );
  if (!properties.length) return null;
  const asOf = new Date(assessment.generated_at);
  const asOfYear = Number.isFinite(asOf.getTime()) ? asOf.getUTCFullYear() : null;
  const sales = properties.flatMap((candidate) => saleRecords(candidate)
    .filter((sale) => (numeric(sale.sale_price) ?? 0) > 0)
    .map((sale) => ({ ...sale, gla: numeric(candidate.gla_sqft) })));
  const months = new Map<string, unknown[]>();
  for (const sale of sales) {
    const date = typeof sale.sale_date === 'string' ? sale.sale_date : '';
    const month = /^(\d{4}-(?:0[1-9]|1[0-2]))-\d{2}(?:T|$)/.exec(date)?.[1];
    if (!month) continue;
    const prices = months.get(month) || [];
    prices.push(sale.sale_price);
    months.set(month, prices);
  }
  return {
    id: pocketId,
    generatedAt: assessment.generated_at,
    saleHistoryMonths: assessment.summary.sale_history_months,
    asOfYear,
    properties,
    includedCount: properties.filter((candidate) => candidate.primary_population).length,
    containsSubjectNeighborhood: properties.some((candidate) => candidate.same_subject_neighborhood),
    subdivisions: breakdown(properties.map((candidate) => candidate.subdivision_name)),
    propertyTypes: breakdown(properties.map((candidate) => candidate.land_use_category)),
    metrics: {
      gla: summarizePocketValues(properties.map((candidate) => candidate.gla_sqft)),
      yearBuilt: summarizePocketValues(properties.map((candidate) => candidate.year_built)),
      age: summarizePocketValues(properties.map((candidate) => {
        const year = numeric(candidate.year_built);
        return asOfYear !== null && year !== null && year > 0 && year <= asOfYear
          ? asOfYear - year : null;
      }), true),
      site: summarizePocketValues(properties.map((candidate) => candidate.site_area_sqft)),
      cadValue: summarizePocketValues(properties.map((candidate) => candidate.market_value)),
      similarity: summarizePocketValues(properties.map((candidate) => candidate.score), true),
      salePrice: summarizePocketValues(sales.map((sale) => sale.sale_price)),
      salePpsf: summarizePocketValues(sales.map((sale) =>
        sale.gla !== null && sale.gla > 0 ? Number(sale.sale_price) / sale.gla : null,
      )),
      marketingDays: summarizePocketValues(sales.map((sale) => sale.days_on_market), true),
    },
    monthlySales: [...months].sort(([left], [right]) => left.localeCompare(right))
      .map(([month, prices]) => ({ month, ...summarizePocketValues(prices) })),
  };
}

export type NeighborhoodPocketDetails = NonNullable<ReturnType<typeof buildNeighborhoodPocketDetails>>;
