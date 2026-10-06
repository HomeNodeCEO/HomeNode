import type { MarketConditionsResponse, MarketConditionsStudyAreaKey, PropertyComplexityAssessment, PropertyComplexityFactor, PropertyComplexityLevel } from './api';

export type MarketComplexityReview = { complexity: PropertyComplexityLevel; notes: string; reviewedAt: string; sourceComputedAt: string; evidenceKey: string };
export type MarketComplexityStudy = {
  key: MarketConditionsStudyAreaKey; label: string; used: boolean; sales: number;
  medianLivingArea: number | null; medianAge: number | null; livingAreaDifferencePercent: number | null;
  ageDifferenceYears: number | null; cod: number | null; cv: number | null; reliability: number | null;
};
export type MarketStudyComplexity = {
  version: 1; studySignature: string; assessment: PropertyComplexityAssessment;
  studies: MarketComplexityStudy[]; review: MarketComplexityReview | null;
};

const numeric = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const round = (value: number) => Math.round(value * 10) / 10;
const positive = (value: unknown) => { const n = numeric(value); return n !== null && n > 0 ? n : null; };
const oldPeerFactors = new Set(['atypical_gla', 'atypical_age', 'atypical_site_size', 'uncommon_pool']);
export const marketComplexityEvidenceKey = (signature: string, keys: readonly MarketConditionsStudyAreaKey[]) => JSON.stringify([signature, [...new Set(keys)].sort()]);

/** Screening, not a pooled statistic or value opinion. Each independent study
 * retains its own population, dates and medians. Average screening points once
 * per factor (reliability-weighted), never add overlapping sales as unique peers.
 * GLA deviation: 10%/25%; age deviation: 10/20 years; composite CV: 25%/40%.
 * Existing 20/45 complexity thresholds and hard local influence floors remain.
 * Missing measurements stay unknown, not zero or a fabricated percentile. */
export function buildMarketStudyComplexity(context: PropertyComplexityAssessment, response: MarketConditionsResponse,
  reliedUpon: readonly MarketConditionsStudyAreaKey[], studySignature: string, review: MarketComplexityReview | null = null): MarketStudyComplexity | null {
  if (context.account_id !== response.subject.account_id || !studySignature) return null;
  const subjectGla = positive(context.subject.gross_living_area_sqft);
  const studies = response.analyses.map(analysis => {
    const endYear = Number(analysis.period.end?.slice(0, 4));
    const subjectAge = positive(context.subject.year_built) && endYear >= Number(context.subject.year_built)
      ? endYear - Number(context.subject.year_built) : null;
    const gla = positive(analysis.summary.median_living_area), age = numeric(analysis.summary.median_age);
    return { key: analysis.market.key, label: analysis.market.label, used: reliedUpon.includes(analysis.market.key),
      sales: analysis.population.eligible_sale_count, medianLivingArea: gla, medianAge: age,
      livingAreaDifferencePercent: subjectGla !== null && gla !== null ? round((subjectGla - gla) / gla * 100) : null,
      ageDifferenceYears: subjectAge !== null && age !== null ? round(subjectAge - age) : null,
      cod: numeric(analysis.statistics.composite_cod), cv: numeric(analysis.statistics.composite_cv),
      reliability: numeric(analysis.statistics.reliability_score) };
  });
  const used = studies.filter(study => study.used && study.sales > 0);
  if (!used.length) return null;
  const factors = context.factors.filter(factor => !oldPeerFactors.has(factor.code) && !factor.code.startsWith('market_study_'));
  const warnings = context.warnings.filter(warning => !warning.startsWith('Fewer than 20 nearby residential properties'));
  const add = (code: string, label: string, read: (study: MarketComplexityStudy) => number | null,
    pointsFor: (value: number) => number, detail: string) => {
    const measured = used.flatMap(study => { const value = read(study); return value === null ? [] : [{ study, value }]; });
    if (measured.length < used.length) warnings.push(`${label}: one or more weighted studies lack measurements.`);
    const weight = (study: MarketComplexityStudy) => Math.max(1, study.reliability ?? 1);
    const denominator = measured.reduce((sum, item) => sum + weight(item.study), 0);
    const points = denominator ? round(measured.reduce((sum, item) => sum + pointsFor(Math.abs(item.value)) * weight(item.study), 0) / denominator) : 0;
    if (points > 0) factors.push({ code: `market_study_${code}`, label, severity: points >= 12 ? 'high' : points >= 4 ? 'moderate' : 'low', points, detail } as PropertyComplexityFactor);
  };
  add('gla', 'Living area versus studied markets', study => study.livingAreaDifferencePercent,
    value => value >= 25 ? 14 : value >= 10 ? 8 : 0, 'Subject living area differs from the independently measured study medians.');
  add('age', 'Age versus studied markets', study => study.ageDifferenceYears,
    value => value >= 20 ? 8 : value >= 10 ? 4 : 0, 'Subject age is compared at each study end date, not today.');
  add('dispersion', 'Market characteristic dispersion', study => study.cv,
    value => value >= 40 ? 14 : value >= 25 ? 8 : 0, 'The weighted study populations show variation in their measured housing characteristics.');
  if (used.some(study => study.sales < 30)) warnings.push('One or more weighted studies have fewer than 30 eligible sales.');
  warnings.push('Site-size and amenity prevalence are not measured in these sales studies; they are not inferred from the old radius sample.');
  const score = round(Math.min(100, factors.reduce((sum, factor) => sum + factor.points, 0)));
  let level: PropertyComplexityLevel = score >= 45 ? 'complex' : score >= 20 ? 'moderate' : 'simple';
  if (factors.some(factor => factor.code.endsWith('_adjacency') || ['special_flood_hazard_area', 'zoning_use_mismatch'].includes(factor.code))) level = 'complex';
  else if (level === 'simple' && factors.some(factor =>
    ['measured_traffic_influence', 'railroad_influence'].includes(factor.code) && factor.points >= 16
    || factor.code === 'major_road_influence' && factor.points >= 12
    || factor.code.endsWith('_proximity') && typeof factor.evidence?.distance_feet === 'number' && factor.evidence.distance_feet <= 100)) level = 'moderate';
  const activeReview = review?.sourceComputedAt === context.computed_at && review.evidenceKey === marketComplexityEvidenceKey(studySignature, reliedUpon) ? review : null;
  const effective = activeReview?.complexity ?? level;
  const fullMeasurements = used.every(study => study.livingAreaDifferencePercent !== null && study.ageDifferenceYears !== null && study.cv !== null);
  const confidence = fullMeasurements && used.every(study => study.sales >= 50) && context.spatial_context.parcel_available
    && context.source_health.length > 0 && context.source_health.every(source => source.usable && !source.serving_stale_data) ? 'high'
    : fullMeasurements && used.every(study => study.sales >= 30) ? 'moderate' : 'limited';
  return { version: 1, studySignature, studies, review: activeReview, assessment: { ...context,
    methodology_version: 3, score, automatic_complexity: level, effective_complexity: effective, confidence,
    recommended_search_profile: `${context.geography}_${effective}`, factors, warnings: [...new Set(warnings)],
    peer_statistics: { peer_count: Math.max(...used.map(study => study.sales)), context: 'market_studies', radius_miles: null,
      gla: { count: 0, median: null, percentile: null }, age: { count: 0, median: null, percentile: null },
      site_area: { count: 0, median: null, percentile: null }, pool_prevalence_percent: null },
    spatial_context: { ...context.spatial_context, site_percentile: null, site_comparison_count: 0 },
    review_status: activeReview ? effective === level ? 'reviewed' : 'overridden' : 'automatic',
    appraiser_complexity: activeReview?.complexity ?? null, appraiser_notes: activeReview?.notes ?? null,
    reviewed_at: activeReview?.reviewedAt ?? null, reviewer: activeReview ? context.reviewer : null } };
}
