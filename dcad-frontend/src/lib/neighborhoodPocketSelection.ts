import type { NeighborhoodRelevanceAssessment } from './neighborhoodRelevanceTypes';

export type NeighborhoodRelevanceCandidate = NonNullable<
  NeighborhoodRelevanceAssessment['visualization']
>[number];

type MetricSummary = {
  count: number;
  low: number | null;
  high: number | null;
  median: number | null;
  average: number | null;
  cod: number | null;
  cv: number | null;
};

function finiteValues(values: Array<number | null | undefined>): number[] {
  return values.map(Number).filter(Number.isFinite);
}

function rounded(value: number | null, digits = 2): number | null {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function percentile(values: number[], ratio: number): number | null {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const position = Math.max(0, Math.min(1, ratio)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * (position - lower));
}

function summarize(values: Array<number | null | undefined>): MetricSummary {
  const numeric = finiteValues(values);
  if (!numeric.length) {
    return { count: 0, low: null, high: null, median: null, average: null, cod: null, cv: null };
  }
  const average = numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
  const median = percentile(numeric, 0.5) as number;
  const divisor = numeric.length > 1 ? numeric.length - 1 : 1;
  const standardDeviation = Math.sqrt(
    numeric.reduce((sum, value) => sum + ((value - average) ** 2), 0) / divisor,
  );
  return {
    count: numeric.length,
    low: rounded(Math.min(...numeric)),
    high: rounded(Math.max(...numeric)),
    median: rounded(median),
    average: rounded(average),
    cod: median
      ? rounded(numeric.reduce((sum, value) => sum + Math.abs(value - median), 0) /
          numeric.length / Math.abs(median) * 100)
      : null,
    cv: average ? rounded(standardDeviation / Math.abs(average) * 100) : null,
  };
}

export function calculatePocketStatistics(candidates: NeighborhoodRelevanceCandidate[]) {
  const included = candidates.filter((candidate) => candidate.primary_population);
  const sales = included.flatMap((candidate) => {
    if (candidate.sales?.length) {
      return candidate.sales
        .filter((sale) => Number(sale.sale_price) > 0)
        .map((sale) => ({
          ...candidate,
          sale_price: sale.sale_price,
          sale_date: sale.sale_date,
        }));
    }
    return Number(candidate.sale_price) > 0 ? [candidate] : [];
  });
  const salesPpsf = sales.map((candidate) => {
    const gla = Number(candidate.gla_sqft);
    return gla > 0 ? Number(candidate.sale_price) / gla : null;
  });
  const propertyPpsf = included.map((candidate) => {
    const gla = Number(candidate.gla_sqft);
    return gla > 0 && Number(candidate.market_value) > 0
      ? Number(candidate.market_value) / gla
      : null;
  });
  const propertyProfile = {
    market_value: summarize(included.map((candidate) => candidate.market_value)),
    value_per_square_foot: summarize(propertyPpsf),
    age: summarize(included.map((candidate) => candidate.year_built)),
    site_size: summarize(included.map((candidate) => candidate.site_area_sqft)),
    gla: summarize(included.map((candidate) => candidate.gla_sqft)),
    similarity_score: summarize(included.map((candidate) => candidate.score)),
  };
  const salesProfile = {
    sale_price: summarize(sales.map((candidate) => candidate.sale_price)),
    price_per_square_foot: summarize(salesPpsf),
    age: summarize(sales.map((candidate) => candidate.year_built)),
    site_size: summarize(sales.map((candidate) => candidate.site_area_sqft)),
    gla: summarize(sales.map((candidate) => candidate.gla_sqft)),
    similarity_score: summarize(sales.map((candidate) => candidate.score)),
  };
  const dispersion = [
    salesProfile.sale_price.cod,
    salesProfile.price_per_square_foot.cod,
    salesProfile.age.cod,
    salesProfile.gla.cod,
  ].filter((value): value is number => Number.isFinite(value));
  const compositeCod = dispersion.length
    ? dispersion.reduce((sum, value) => sum + value, 0) / dispersion.length
    : null;
  const saleCoverage = included.length ? sales.length / included.length * 100 : 0;
  const reliability = compositeCod === null
    ? 0
    : Math.max(0, Math.min(100,
        100 - Math.min(70, compositeCod * 1.5) + Math.min(20, saleCoverage / 5),
      ));
  return {
    population_rule: 'all_system_relevant_pockets' as const,
    reviewable_property_count: candidates.filter((candidate) => !candidate.excluded).length,
    included_property_count: included.length,
    included_sale_count: sales.length,
    sale_coverage_percent: rounded(saleCoverage, 1) as number,
    composite_cod: rounded(compositeCod),
    reliability_score: rounded(reliability, 1) as number,
    property_profile: propertyProfile,
    sales_profile: salesProfile,
  };
}

export function applyPocketOverrides(
  assessment: NeighborhoodRelevanceAssessment,
  removedPocketIds: string[] = [],
  addedPocketIds: string[] = [],
): NeighborhoodRelevanceAssessment {
  const removed = new Set(removedPocketIds);
  const added = new Set(addedPocketIds);
  const visualization = (assessment.visualization || []).map((candidate) => {
    const pocketId = candidate.pocket_id || candidate.cluster_id;
    const systemSelected = candidate.system_selected ?? candidate.primary_population;
    const appraiserOverride: NeighborhoodRelevanceCandidate['appraiser_override'] =
      pocketId && added.has(pocketId)
      ? 'included'
      : pocketId && removed.has(pocketId)
        ? 'removed'
        : null;
    return {
      ...candidate,
      primary_population: appraiserOverride === 'included' ||
        (appraiserOverride !== 'removed' && systemSelected),
      appraiser_override: appraiserOverride,
    };
  });
  const relevantStatistics = calculatePocketStatistics(visualization);
  const pocketIds = new Set(visualization
    .filter((candidate) => candidate.primary_population)
    .map((candidate) => candidate.pocket_id || candidate.cluster_id)
    .filter((value): value is string => Boolean(value)));
  return {
    ...assessment,
    summary: {
      ...assessment.summary,
      primary_population_sale_count: relevantStatistics.included_sale_count,
      selected_pocket_count: pocketIds.size,
      relevant_statistics: relevantStatistics,
    },
    visualization,
  };
}

export function summarizePockets(candidates: NeighborhoodRelevanceCandidate[]) {
  const pockets = new Map<string, {
    id: string;
    systemSelected: boolean;
    appraiserIncluded: boolean;
    appraiserRemoved: boolean;
    propertyCount: number;
    saleCount: number;
    scoreTotal: number;
    scoreCount: number;
    containsSubjectSubdivision: boolean;
  }>();
  for (const candidate of candidates) {
    const id = candidate.pocket_id || candidate.cluster_id;
    if (!id) continue;
    const pocket = pockets.get(id) || {
      id,
      systemSelected: candidate.system_selected ?? candidate.primary_population,
      appraiserIncluded: false,
      appraiserRemoved: false,
      propertyCount: 0,
      saleCount: 0,
      scoreTotal: 0,
      scoreCount: 0,
      containsSubjectSubdivision: false,
    };
    pocket.propertyCount += 1;
    pocket.saleCount += candidate.sales?.length || (Number(candidate.sale_price) > 0 ? 1 : 0);
    if (Number.isFinite(Number(candidate.score))) {
      pocket.scoreTotal += Number(candidate.score);
      pocket.scoreCount += 1;
    }
    pocket.appraiserIncluded ||= candidate.appraiser_override === 'included';
    pocket.appraiserRemoved ||= candidate.appraiser_override === 'removed';
    pocket.containsSubjectSubdivision ||= candidate.same_subject_neighborhood === true;
    pockets.set(id, pocket);
  }
  return [...pockets.values()]
    .map((pocket) => ({
      ...pocket,
      averageScore: pocket.scoreCount ? Math.round(pocket.scoreTotal / pocket.scoreCount) : null,
      currentlyIncluded: pocket.appraiserIncluded ||
        (pocket.systemSelected && !pocket.appraiserRemoved),
    }))
    .sort((left, right) =>
      Number(right.currentlyIncluded) - Number(left.currentlyIncluded) ||
      Number(right.containsSubjectSubdivision) - Number(left.containsSubjectSubdivision) ||
      (right.averageScore || 0) - (left.averageScore || 0) ||
      right.propertyCount - left.propertyCount,
    );
}
