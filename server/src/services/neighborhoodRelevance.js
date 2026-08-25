export const NEIGHBORHOOD_RELEVANCE_METHODOLOGY_VERSION = 3;

export const NEIGHBORHOOD_RELEVANCE_WEIGHTS = Object.freeze({
  age: 0.40,
  site_size: 0.30,
  proximity: 0.20,
  sale_price: 0.10,
});

// Version 1 intentionally starts with a permissive cutoff. It is exported and
// returned with every assessment so later calibration can raise or lower the
// threshold without hiding which rule produced an appraisal result.
export const NEIGHBORHOOD_RELEVANCE_EXCLUSION_THRESHOLD = 20;

export const NEIGHBORHOOD_BOUNDARY_DISCLOSURE =
  "Neighborhood boundaries describe the subject's broader geographic setting and are not treated as an automatic inclusion rule. Properties within the stated boundaries are independently screened for relevance using age, site size, proximity, and unadjusted sale-price similarity. Parcels sharing the subject's recorded subdivision or CAD neighborhood identity remain represented in the dataset and are labeled as protected neighborhood matches even when their physical characteristics differ. Dissimilar pockets outside that protected neighborhood may be excluded, while gross living area is retained as a secondary diagnostic with a wider tolerance. Roadway and zoning patterns support, but do not independently determine, the relevant market area.";

const PRIMARY_DEVIATION_THRESHOLD = 1.5;
const EXTREME_DEVIATION_THRESHOLD = 2.5;

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function rounded(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function percentile(sortedValues, ratio) {
  if (!sortedValues.length) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const position = clamp(ratio, 0, 1) * (sortedValues.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  const fraction = position - lower;
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * fraction;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  return percentile(sorted, 0.5);
}

function summarizeDistribution(values, { minimumStandardDeviation = 1 } = {}) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) {
    return {
      count: 0,
      mean: null,
      median: null,
      standard_deviation: null,
      effective_standard_deviation: null,
      winsorized_low: null,
      winsorized_high: null,
    };
  }
  const winsorizedLow = percentile(sorted, 0.05);
  const winsorizedHigh = percentile(sorted, 0.95);
  const winsorized = sorted.map((value) => clamp(value, winsorizedLow, winsorizedHigh));
  const mean = winsorized.reduce((sum, value) => sum + value, 0) / winsorized.length;
  const divisor = winsorized.length > 1 ? winsorized.length - 1 : 1;
  const variance = winsorized.reduce((sum, value) => sum + (value - mean) ** 2, 0) / divisor;
  const standardDeviation = Math.sqrt(variance);
  return {
    count: sorted.length,
    mean: rounded(mean),
    median: rounded(median(sorted)),
    standard_deviation: rounded(standardDeviation),
    effective_standard_deviation: rounded(Math.max(standardDeviation, minimumStandardDeviation)),
    winsorized_low: rounded(winsorizedLow),
    winsorized_high: rounded(winsorizedHigh),
  };
}

function standardDeviationSimilarity(value, reference, distribution) {
  const numericValue = finiteNumber(value);
  const numericReference = finiteNumber(reference);
  const deviation = positiveNumber(distribution?.effective_standard_deviation);
  if (numericValue === null || numericReference === null || deviation === null) {
    return { score: null, z_score: null, available: false };
  }
  const zScore = Math.abs(numericValue - numericReference) / deviation;
  // A normal-distribution similarity curve avoids sharp scoring cliffs. The
  // separate exclusion rules below remain explicit and reviewable.
  const score = Math.exp(-0.5 * zScore ** 2) * 100;
  return { score: rounded(score, 1), z_score: rounded(zScore, 2), available: true };
}

function proximitySimilarity(distanceMiles, maximumDistanceMiles) {
  const distance = finiteNumber(distanceMiles);
  const maximum = positiveNumber(maximumDistanceMiles);
  if (distance === null || distance < 0 || maximum === null) {
    return { score: null, ratio: null, available: false };
  }
  const ratio = distance / maximum;
  return {
    score: rounded(clamp(1 - ratio, 0, 1) * 100, 1),
    ratio: rounded(ratio, 3),
    available: true,
  };
}

function coveragePercent(count, total) {
  return total > 0 ? rounded((count / total) * 100, 1) : 0;
}

function normalizedCandidate(candidate = {}) {
  return {
    ...candidate,
    year_built: positiveNumber(candidate.year_built ?? candidate.residential_year_built),
    site_area_sqft: positiveNumber(candidate.site_area_sqft ?? candidate.parcel_area_sqft),
    sale_price: positiveNumber(candidate.sale_price),
    distance_miles: finiteNumber(candidate.distance_miles),
    gla_sqft: positiveNumber(
      candidate.gla_sqft ?? candidate.living_area_sqft ?? candidate.residential_area_sqft,
    ),
  };
}

export function buildNeighborhoodRelevanceDistributions(subject = {}, candidates = []) {
  const normalized = candidates.map(normalizedCandidate);
  const subjectYearBuilt = positiveNumber(subject.year_built ?? subject.residential_year_built);
  const subjectSiteArea = positiveNumber(subject.site_area_sqft ?? subject.parcel_area_sqft);
  const salePrices = normalized.map((candidate) => candidate.sale_price).filter(Boolean);
  const saleReference = positiveNumber(subject.reference_sale_price) ?? median(salePrices);
  return {
    age: summarizeDistribution(
      normalized.map((candidate) => candidate.year_built).filter(Boolean),
      { minimumStandardDeviation: 5 },
    ),
    site_size: summarizeDistribution(
      normalized.map((candidate) => candidate.site_area_sqft).filter(Boolean),
      { minimumStandardDeviation: Math.max((subjectSiteArea || median(
        normalized.map((candidate) => candidate.site_area_sqft).filter(Boolean),
      ) || 0) * 0.15, 500) },
    ),
    sale_price: summarizeDistribution(
      salePrices,
      { minimumStandardDeviation: Math.max((saleReference || 0) * 0.10, 25_000) },
    ),
    references: {
      year_built: subjectYearBuilt,
      site_area_sqft: subjectSiteArea,
      sale_price: saleReference,
      sale_price_source: positiveNumber(subject.reference_sale_price)
        ? "subject_reference"
        : salePrices.length
          ? "candidate_median"
          : "unavailable",
    },
  };
}

export function scoreNeighborhoodCandidate({
  subject = {},
  candidate = {},
  distributions,
  maximumDistanceMiles,
} = {}) {
  const normalized = normalizedCandidate(candidate);
  const factors = {
    age: standardDeviationSimilarity(
      normalized.year_built,
      distributions?.references?.year_built,
      distributions?.age,
    ),
    site_size: standardDeviationSimilarity(
      normalized.site_area_sqft,
      distributions?.references?.site_area_sqft,
      distributions?.site_size,
    ),
    proximity: proximitySimilarity(normalized.distance_miles, maximumDistanceMiles),
    sale_price: standardDeviationSimilarity(
      normalized.sale_price,
      distributions?.references?.sale_price,
      distributions?.sale_price,
    ),
  };
  const availableFactors = Object.entries(factors)
    .filter(([, result]) => result.available)
    .map(([key, result]) => ({ key, result, weight: NEIGHBORHOOD_RELEVANCE_WEIGHTS[key] }));
  const availableWeight = availableFactors.reduce((sum, factor) => sum + factor.weight, 0);
  const weightedScore = availableWeight > 0
    ? availableFactors.reduce(
      (sum, factor) => sum + factor.result.score * factor.weight,
      0,
    ) / availableWeight
    : null;
  const primaryZScores = [factors.age.z_score, factors.site_size.z_score, factors.sale_price.z_score]
    .filter((value) => value !== null);
  const deviationCount = primaryZScores.filter(
    (value) => value >= PRIMARY_DEVIATION_THRESHOLD,
  ).length;
  const extremeDeviationCount = primaryZScores.filter(
    (value) => value >= EXTREME_DEVIATION_THRESHOLD,
  ).length;
  const supportingBoundaryEvidence =
    candidate.zoning_transition === true ||
    ["strong", "high"].includes(String(candidate.road_boundary_strength || "").toLowerCase());
  const potentialDissimilar = deviationCount >= 2 ||
    (extremeDeviationCount >= 1 && supportingBoundaryEvidence);
  const subjectGla = positiveNumber(subject.gla_sqft ?? subject.living_area_sqft);
  const insufficientData = availableWeight < 0.70;
  const excludedByScore = !insufficientData && weightedScore <
    NEIGHBORHOOD_RELEVANCE_EXCLUSION_THRESHOLD;
  const statisticalClassification = insufficientData
    ? "insufficient_data"
    : excludedByScore
      ? "excluded_low_relevance"
      : potentialDissimilar
        ? "potential_dissimilar_cluster_member"
        : "relevant_candidate";
  const protectedNeighborhoodMatch = candidate.same_subject_neighborhood === true;
  return {
    candidate_id: candidate.account_id ?? candidate.id ?? null,
    parcel_object_id: candidate.parcel_object_id == null
      ? null
      : Number(candidate.parcel_object_id),
    account_id: candidate.account_id ?? null,
    address: candidate.address ?? null,
    land_use_category: candidate.land_use_category ?? null,
    point: candidate.point ?? null,
    distance_miles: normalized.distance_miles,
    year_built: normalized.year_built,
    site_area_sqft: normalized.site_area_sqft,
    sale_price: normalized.sale_price,
    score: rounded(weightedScore, 1),
    available_weight_percent: rounded(availableWeight * 100, 0),
    factors: Object.fromEntries(Object.entries(factors).map(([key, result]) => [key, {
      weight_percent: NEIGHBORHOOD_RELEVANCE_WEIGHTS[key] * 100,
      score: result.score,
      z_score: result.z_score ?? null,
      available: result.available,
    }])),
    sale_price_time_adjusted: false,
    sale_price_date: candidate.sale_date ?? null,
    primary_deviation_count: deviationCount,
    extreme_deviation_count: extremeDeviationCount,
    supporting_boundary_evidence: supportingBoundaryEvidence,
    exclusion_threshold_percent: NEIGHBORHOOD_RELEVANCE_EXCLUSION_THRESHOLD,
    subdivision_name: candidate.subdivision_name ?? null,
    neighborhood_code: candidate.neighborhood_code ?? null,
    same_subject_neighborhood: protectedNeighborhoodMatch,
    protected_inclusion_reason: protectedNeighborhoodMatch
      ? "same_subject_legal_neighborhood"
      : null,
    excluded: protectedNeighborhoodMatch ? false : excludedByScore,
    statistical_classification: protectedNeighborhoodMatch
      ? "protected_subject_neighborhood"
      : statisticalClassification,
    exclusion_requires_contiguous_cluster: !protectedNeighborhoodMatch &&
      !excludedByScore && potentialDissimilar,
    gla_diagnostic: {
      subject_gla_sqft: subjectGla,
      candidate_gla_sqft: normalized.gla_sqft,
      difference_percent:
        subjectGla && normalized.gla_sqft
          ? rounded(((normalized.gla_sqft - subjectGla) / subjectGla) * 100, 1)
          : null,
      contributes_to_score: false,
    },
  };
}

export function assessNeighborhoodRelevanceConfidence({
  candidates = [],
  scoredCandidates = [],
  sourceHealth = [],
} = {}) {
  const normalized = candidates.map(normalizedCandidate);
  const total = normalized.length;
  const counts = {
    candidates: total,
    year_built: normalized.filter((candidate) => candidate.year_built).length,
    site_size: normalized.filter((candidate) => candidate.site_area_sqft).length,
    coordinates: normalized.filter((candidate) => candidate.distance_miles !== null).length,
    sales: normalized.filter((candidate) => candidate.sale_price).length,
  };
  const coverage = {
    year_built_percent: coveragePercent(counts.year_built, total),
    site_size_percent: coveragePercent(counts.site_size, total),
    coordinate_percent: coveragePercent(counts.coordinates, total),
    sale_price_percent: coveragePercent(counts.sales, total),
  };
  const staleSources = sourceHealth.filter(
    (source) => source?.serving_stale_data || source?.status === "failed",
  );
  const insufficientScores = scoredCandidates.filter(
    (candidate) => candidate.statistical_classification === "insufficient_data",
  ).length;
  const physicalCoverage = Math.min(coverage.year_built_percent, coverage.site_size_percent);
  let confidence = "limited";
  if (
    total >= 50 && counts.sales >= 30 && physicalCoverage >= 80 &&
    coverage.coordinate_percent >= 90 && staleSources.length === 0 &&
    insufficientScores <= total * 0.10
  ) {
    confidence = "high";
  } else if (
    total >= 25 && counts.sales >= 15 && physicalCoverage >= 60 &&
    coverage.coordinate_percent >= 70
  ) {
    confidence = "moderate";
  }
  const actions = [];
  if (counts.sales < 15) actions.push("extend_sale_history_to_36_months");
  else if (counts.sales < 30) actions.push("extend_sale_history_to_24_months");
  if (total < 25 || coverage.coordinate_percent < 70) actions.push("expand_discovery_radius");
  if (physicalCoverage < 60) actions.push("review_physical_characteristic_coverage");
  if (staleSources.length) actions.push("review_stale_source_warning");
  return {
    confidence,
    counts,
    coverage,
    stale_source_keys: staleSources.map((source) => source.source_key).filter(Boolean),
    automatic_actions: [...new Set(actions)],
    appraiser_review_required: confidence === "limited",
  };
}

export function buildNeighborhoodRelevanceAssessment({
  subject = {},
  candidates = [],
  maximumDistanceMiles,
  sourceHealth = [],
} = {}) {
  const distributions = buildNeighborhoodRelevanceDistributions(subject, candidates);
  const scoredCandidates = candidates.map((candidate) => scoreNeighborhoodCandidate({
    subject,
    candidate,
    distributions,
    maximumDistanceMiles,
  }));
  const confidence = assessNeighborhoodRelevanceConfidence({
    candidates,
    scoredCandidates,
    sourceHealth,
  });
  return {
    methodology_version: NEIGHBORHOOD_RELEVANCE_METHODOLOGY_VERSION,
    weights: Object.fromEntries(Object.entries(NEIGHBORHOOD_RELEVANCE_WEIGHTS).map(
      ([key, value]) => [key, value * 100],
    )),
    exclusion_threshold_percent: NEIGHBORHOOD_RELEVANCE_EXCLUSION_THRESHOLD,
    sale_price_time_adjusted: false,
    broad_boundary_is_inclusion_rule: false,
    disclosure: NEIGHBORHOOD_BOUNDARY_DISCLOSURE,
    distributions,
    confidence,
    candidates: scoredCandidates.sort((left, right) => (right.score ?? -1) - (left.score ?? -1)),
  };
}
