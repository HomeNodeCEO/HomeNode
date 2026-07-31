const EARTH_RADIUS_MILES = 3958.7613;

export const DEFAULT_COMPARABLE_SCORING = Object.freeze({
  locationWeight: 0.4,
  squareFootageWeight: 0.3,
  salesDateWeight: 0.3,
  locationScaleMiles: 1,
  squareFootageScaleRatio: 0.1,
  salesDateScaleDays: 365,
});

export const DEFAULT_RECOMMENDATION_POLICY = Object.freeze({
  count: 6,
  periodMonths: 12,
});

export const DEFAULT_OUTLIER_ANALYSIS = Object.freeze({
  scoreThreshold: 60,
  minimumSampleSize: 30,
  minimumCoverageRatio: 0.8,
  minimumDistinctSaleMonths: 6,
  standardDeviationThreshold: 2,
  robustZScoreThreshold: 3.5,
  iqrMultiplier: 1.5,
});

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function softSimilarity(value, scale) {
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(scale) || scale <= 0) {
    return null;
  }
  return 100 / (1 + value / scale);
}

function validDate(value) {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function utcDateOnly(value) {
  const parsed = validDate(value);
  return parsed
    ? new Date(Date.UTC(
        parsed.getUTCFullYear(),
        parsed.getUTCMonth(),
        parsed.getUTCDate(),
      ))
    : null;
}

function yearsBefore(value, years) {
  const result = new Date(value.getTime());
  result.setUTCFullYear(result.getUTCFullYear() - years);
  return result;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function sampleStandardDeviation(values, average = mean(values)) {
  if (values.length < 2 || average === null) return null;
  const variance = values.reduce(
    (sum, value) => sum + (value - average) ** 2,
    0,
  ) / (values.length - 1);
  return Math.sqrt(variance);
}

function sampleSkewness(values, average, standardDeviation) {
  const count = values.length;
  if (
    count < 3 ||
    average === null ||
    standardDeviation === null ||
    standardDeviation <= 0
  ) {
    return null;
  }
  const standardizedCubeSum = values.reduce(
    (sum, value) => sum + ((value - average) / standardDeviation) ** 3,
    0,
  );
  return count / ((count - 1) * (count - 2)) * standardizedCubeSum;
}

function salePricePerSquareFoot(sale) {
  const reportedRatio = finiteNumber(sale.ratio_close_price_by_living_area);
  if (reportedRatio !== null && reportedRatio > 0) return reportedRatio;
  const salePrice = finiteNumber(sale.sale_price);
  const squareFeet = finiteNumber(
    sale.comparable_square_feet ??
      sale.cad_living_area_sqft ??
      sale.mls_living_area,
  );
  if (
    salePrice === null ||
    squareFeet === null ||
    salePrice <= 0 ||
    squareFeet <= 0
  ) {
    return null;
  }
  return salePrice / squareFeet;
}

export function analyzeComparableOutliers(
  sales,
  config = DEFAULT_OUTLIER_ANALYSIS,
) {
  const analysisConfig = {
    ...DEFAULT_OUTLIER_ANALYSIS,
    ...config,
  };
  const scoreThreshold = finiteNumber(analysisConfig.scoreThreshold);
  const minimumSampleSize = Math.max(
    30,
    Math.floor(finiteNumber(analysisConfig.minimumSampleSize) ?? 30),
  );
  if (scoreThreshold === null || scoreThreshold < 0 || scoreThreshold > 100) {
    throw new Error("invalid_outlier_score_threshold");
  }

  const qualifiedSales = sales.filter((sale) =>
    sale.soldWithinOneYear === true &&
    finiteNumber(sale.comparableScore) !== null &&
    Number(sale.comparableScore) >= scoreThreshold,
  );
  const measuredSales = qualifiedSales
    .map((sale) => ({ sale, pricePerSquareFoot: salePricePerSquareFoot(sale) }))
    .filter((item) => item.pricePerSquareFoot !== null);
  const values = measuredSales.map((item) => item.pricePerSquareFoot);
  const average = mean(values);
  const center = median(values);
  const standardDeviation = sampleStandardDeviation(values, average);
  const firstQuartile = quantile(values, 0.25);
  const thirdQuartile = quantile(values, 0.75);
  const interquartileRange =
    firstQuartile === null || thirdQuartile === null
      ? null
      : thirdQuartile - firstQuartile;
  const absoluteDeviations = center === null
    ? []
    : values.map((value) => Math.abs(value - center));
  const medianAbsoluteDeviation = median(absoluteDeviations);
  const skewness = sampleSkewness(values, average, standardDeviation);
  const coverageRatio = qualifiedSales.length
    ? measuredSales.length / qualifiedSales.length
    : 0;
  const uniquePropertyCount = new Set(
    qualifiedSales.map((sale) =>
      String(
        sale.primary_account_id ??
          sale.source_record_id ??
          sale.sale_id ??
          "",
      ),
    ).filter(Boolean),
  ).size;
  const saleMonthCounts = new Map();
  for (const sale of qualifiedSales) {
    const saleDate = utcDateOnly(sale.closing_date);
    if (!saleDate) continue;
    const month = saleDate.toISOString().slice(0, 7);
    saleMonthCounts.set(month, (saleMonthCounts.get(month) || 0) + 1);
  }
  const distinctSaleMonths = saleMonthCounts.size;
  const largestMonthCount = Math.max(0, ...saleMonthCounts.values());
  const largestMonthShare = qualifiedSales.length
    ? largestMonthCount / qualifiedSales.length
    : 0;

  const warnings = [];
  if (qualifiedSales.length < minimumSampleSize) {
    warnings.push({
      code: "minimum_sample_not_met",
      message: `At least ${minimumSampleSize} one-year sales scoring ${scoreThreshold} or higher are required.`,
    });
  }
  if (measuredSales.length < minimumSampleSize) {
    warnings.push({
      code: "measured_sample_not_met",
      message: `Only ${measuredSales.length} qualified sales have usable price-per-square-foot data.`,
    });
  }
  if (uniquePropertyCount < minimumSampleSize) {
    warnings.push({
      code: "effective_sample_not_met",
      message: `Only ${uniquePropertyCount} distinct properties are represented; at least ${minimumSampleSize} are required to limit repeated-property bias.`,
    });
  }
  if (coverageRatio < analysisConfig.minimumCoverageRatio) {
    warnings.push({
      code: "low_data_coverage",
      message: `Price-per-square-foot coverage is ${round(coverageRatio * 100, 1)}%; at least ${round(analysisConfig.minimumCoverageRatio * 100, 0)}% is required.`,
    });
  }
  if (distinctSaleMonths < analysisConfig.minimumDistinctSaleMonths) {
    warnings.push({
      code: "limited_time_coverage",
      message: `Qualified sales span ${distinctSaleMonths} distinct sale months; at least ${analysisConfig.minimumDistinctSaleMonths} are required.`,
    });
  }
  if (standardDeviation === null || standardDeviation <= 0) {
    warnings.push({
      code: "no_distribution_spread",
      message: "The qualified sales do not have enough price-per-square-foot variation for an outlier test.",
    });
  }
  if (largestMonthShare > 0.35) {
    warnings.push({
      code: "time_concentration",
      message: `${round(largestMonthShare * 100, 1)}% of qualified sales closed in a single month.`,
    });
  }
  if (skewness !== null && Math.abs(skewness) > 1) {
    warnings.push({
      code: "skewed_distribution",
      message: "The price-per-square-foot distribution is skewed, so robust median and IQR checks receive additional weight.",
    });
  }

  const sampleSufficient =
    qualifiedSales.length >= minimumSampleSize &&
    measuredSales.length >= minimumSampleSize &&
    uniquePropertyCount >= minimumSampleSize &&
    coverageRatio >= analysisConfig.minimumCoverageRatio &&
    distinctSaleMonths >= analysisConfig.minimumDistinctSaleMonths &&
    largestMonthShare <= 0.35 &&
    standardDeviation !== null &&
    standardDeviation > 0;
  const highConfidence =
    sampleSufficient &&
    measuredSales.length >= 50 &&
    coverageRatio >= 0.9 &&
    distinctSaleMonths >= 9 &&
    largestMonthShare <= 0.25 &&
    (skewness === null || Math.abs(skewness) <= 1);

  const lowerFence =
    firstQuartile === null || interquartileRange === null
      ? null
      : firstQuartile - analysisConfig.iqrMultiplier * interquartileRange;
  const upperFence =
    thirdQuartile === null || interquartileRange === null
      ? null
      : thirdQuartile + analysisConfig.iqrMultiplier * interquartileRange;
  const measurements = new Map();
  let outlierCount = 0;
  for (const item of measuredSales) {
    const standardZScore =
      standardDeviation && average !== null
        ? (item.pricePerSquareFoot - average) / standardDeviation
        : null;
    const robustZScore =
      medianAbsoluteDeviation && center !== null
        ? 0.6745 * (item.pricePerSquareFoot - center) /
          medianAbsoluteDeviation
        : null;
    const methods = [];
    if (
      standardZScore !== null &&
      Math.abs(standardZScore) >= analysisConfig.standardDeviationThreshold
    ) {
      methods.push("standard_deviation");
    }
    if (
      robustZScore !== null &&
      Math.abs(robustZScore) >= analysisConfig.robustZScoreThreshold
    ) {
      methods.push("median_absolute_deviation");
    }
    if (
      lowerFence !== null &&
      upperFence !== null &&
      (item.pricePerSquareFoot < lowerFence || item.pricePerSquareFoot > upperFence)
    ) {
      methods.push("interquartile_range");
    }
    const statisticalOutlier = sampleSufficient && methods.length >= 2;
    if (statisticalOutlier) outlierCount += 1;
    measurements.set(item.sale, {
      price_per_square_foot: round(item.pricePerSquareFoot, 2),
      price_per_square_foot_zscore:
        standardZScore === null ? null : round(standardZScore, 2),
      price_per_square_foot_robust_zscore:
        robustZScore === null ? null : round(robustZScore, 2),
      statistical_outlier: statisticalOutlier,
      statistical_outlier_direction: statisticalOutlier
        ? item.pricePerSquareFoot >= center ? "high" : "low"
        : null,
      statistical_outlier_methods: statisticalOutlier ? methods : [],
      outlier_analysis_eligible: true,
    });
  }

  return {
    sales: sales.map((sale) => ({
      ...sale,
      price_per_square_foot: salePricePerSquareFoot(sale) === null
        ? null
        : round(salePricePerSquareFoot(sale), 2),
      price_per_square_foot_zscore: null,
      price_per_square_foot_robust_zscore: null,
      statistical_outlier: false,
      statistical_outlier_direction: null,
      statistical_outlier_methods: [],
      outlier_analysis_eligible: false,
      ...(measurements.get(sale) || {}),
    })),
    analysis: {
      score_threshold: scoreThreshold,
      minimum_sample_size: minimumSampleSize,
      qualified_sale_count: qualifiedSales.length,
      measured_sale_count: measuredSales.length,
      effective_sample_size: uniquePropertyCount,
      duplicate_observation_count:
        Math.max(0, qualifiedSales.length - uniquePropertyCount),
      coverage_ratio: round(coverageRatio, 4),
      distinct_sale_months: distinctSaleMonths,
      largest_month_share: round(largestMonthShare, 4),
      sample_sufficient: sampleSufficient,
      confidence: highConfidence
        ? "high"
        : sampleSufficient ? "moderate" : "insufficient",
      mean_price_per_square_foot:
        average === null ? null : round(average, 2),
      median_price_per_square_foot:
        center === null ? null : round(center, 2),
      standard_deviation_price_per_square_foot:
        standardDeviation === null ? null : round(standardDeviation, 2),
      first_quartile_price_per_square_foot:
        firstQuartile === null ? null : round(firstQuartile, 2),
      third_quartile_price_per_square_foot:
        thirdQuartile === null ? null : round(thirdQuartile, 2),
      interquartile_range_price_per_square_foot:
        interquartileRange === null ? null : round(interquartileRange, 2),
      median_absolute_deviation_price_per_square_foot:
        medianAbsoluteDeviation === null
          ? null
          : round(medianAbsoluteDeviation, 2),
      skewness: skewness === null ? null : round(skewness, 3),
      lower_fence_price_per_square_foot:
        lowerFence === null ? null : round(lowerFence, 2),
      upper_fence_price_per_square_foot:
        upperFence === null ? null : round(upperFence, 2),
      outlier_count: outlierCount,
      methods: [
        "sample_standard_deviation",
        "median_absolute_deviation",
        "interquartile_range",
      ],
      warnings,
    },
  };
}

function dateOnlyString(value) {
  return value.toISOString().slice(0, 10);
}

export function analysisWindow(
  referenceDate = new Date(),
  periodMonths = DEFAULT_RECOMMENDATION_POLICY.periodMonths,
) {
  const reference = utcDateOnly(referenceDate);
  const parsedPeriodMonths = Number(periodMonths);
  if (
    !reference ||
    ![12, 24, 36].includes(parsedPeriodMonths)
  ) {
    return null;
  }

  const absoluteMonth =
    reference.getUTCFullYear() * 12 +
    reference.getUTCMonth() -
    parsedPeriodMonths;
  const targetYear = Math.floor(absoluteMonth / 12);
  const targetMonth = ((absoluteMonth % 12) + 12) % 12;
  const finalDayOfTargetMonth = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate();
  const targetDay = Math.min(reference.getUTCDate(), finalDayOfTargetMonth);
  const start = new Date(Date.UTC(targetYear, targetMonth, targetDay));

  return {
    analysisAsOf: dateOnlyString(reference),
    analysisStartDate: dateOnlyString(start),
    periodMonths: parsedPeriodMonths,
  };
}

export function classifySaleAge(closingDate, referenceDate = new Date()) {
  const saleDate = utcDateOnly(closingDate);
  const reference = utcDateOnly(referenceDate);
  if (!saleDate || !reference) {
    return {
      saleAgeDays: null,
      soldWithinOneYear: false,
      soldOverOneYear: false,
      soldOverTwoYears: false,
    };
  }

  const oneYearCutoff = yearsBefore(reference, 1);
  const twoYearCutoff = yearsBefore(reference, 2);
  return {
    saleAgeDays: Math.max(
      0,
      Math.floor((reference.getTime() - saleDate.getTime()) / 86_400_000),
    ),
    soldWithinOneYear: saleDate >= oneYearCutoff && saleDate <= reference,
    soldOverOneYear: saleDate < oneYearCutoff,
    soldOverTwoYears: saleDate < twoYearCutoff,
  };
}

export function applyRecommendationPolicy(
  rankedSales,
  {
    referenceDate = new Date(),
    policy = DEFAULT_RECOMMENDATION_POLICY,
  } = {},
) {
  const periodMonths = Number(
    policy.periodMonths ?? DEFAULT_RECOMMENDATION_POLICY.periodMonths,
  );
  const window = analysisWindow(referenceDate, periodMonths);
  if (!window) {
    throw new Error("invalid_analysis_period");
  }
  const analysisStart = utcDateOnly(window.analysisStartDate);
  const analysisEnd = utcDateOnly(window.analysisAsOf);
  const classifiedSales = rankedSales.map((sale) => ({
    ...sale,
    ...classifySaleAge(sale.closing_date, referenceDate),
    insideAnalysisPeriod: (() => {
      const saleDate = utcDateOnly(sale.closing_date);
      return Boolean(
        saleDate &&
        analysisStart &&
        analysisEnd &&
        saleDate >= analysisStart &&
        saleDate <= analysisEnd,
      );
    })(),
  }));
  const eligibleSales = classifiedSales.filter(
    (sale) => sale.insideAnalysisPeriod,
  );
  const recommendedSales = eligibleSales.slice(
    0,
    policy.count ?? DEFAULT_RECOMMENDATION_POLICY.count,
  );
  const recommendationRanks = new Map(
    recommendedSales.map((sale, index) => [sale, index + 1]),
  );

  const sales = classifiedSales.map((sale) => {
    const recommendationRank = recommendationRanks.get(sale) ?? null;
    return {
      ...sale,
      recommended: recommendationRank !== null,
      recommendationRank,
      recommendationExclusionReason:
        !sale.insideAnalysisPeriod
          ? "outside_analysis_period"
          : null,
    };
  });

  const recentHighScoreCount = sales.filter(
    (sale) =>
      sale.soldWithinOneYear &&
      finiteNumber(sale.comparableScore) > 70,
  ).length;
  const scoreAboveThresholdCount = sales.filter(
    (sale) => finiteNumber(sale.comparableScore) > 70,
  ).length;

  return {
    sales,
    recommendedSales: sales.filter((sale) => sale.recommended),
    policy: {
      ...policy,
      periodMonths,
      analysisAsOf: window.analysisAsOf,
      analysisStartDate: window.analysisStartDate,
      referenceDate: `${window.analysisAsOf}T00:00:00.000Z`,
      olderThanOneYearCount: sales.filter(
        (sale) => sale.insideAnalysisPeriod && sale.soldOverOneYear,
      ).length,
      outsideAnalysisPeriodCount: sales.filter(
        (sale) => !sale.insideAnalysisPeriod,
      ).length,
      expandedHistoricalPeriod: periodMonths > 12,
      // Retained temporarily for compatibility with older deployed clients.
      recentYears: 1,
      olderThanYears: 1,
      highScoreThreshold: 70,
      recentHighScoreCount,
      scoreAboveThresholdCount,
      olderSaleExclusionApplied: periodMonths === 12,
    },
  };
}

export function haversineMiles(latitudeA, longitudeA, latitudeB, longitudeB) {
  const latA = finiteNumber(latitudeA);
  const lonA = finiteNumber(longitudeA);
  const latB = finiteNumber(latitudeB);
  const lonB = finiteNumber(longitudeB);
  if ([latA, lonA, latB, lonB].some((value) => value === null)) return null;

  const toRadians = (degrees) => degrees * Math.PI / 180;
  const deltaLatitude = toRadians(latB - latA);
  const deltaLongitude = toRadians(lonB - lonA);
  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(toRadians(latA)) *
      Math.cos(toRadians(latB)) *
      Math.sin(deltaLongitude / 2) ** 2;
  return EARTH_RADIUS_MILES * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function scoreComparable(
  {
    subjectLatitude,
    subjectLongitude,
    comparableLatitude,
    comparableLongitude,
    subjectSquareFeet,
    comparableSquareFeet,
    closingDate,
    referenceDate = new Date(),
  },
  config = DEFAULT_COMPARABLE_SCORING,
) {
  const subjectSqft = finiteNumber(subjectSquareFeet);
  const comparableSqft = finiteNumber(comparableSquareFeet);
  const distanceMiles = haversineMiles(
    subjectLatitude,
    subjectLongitude,
    comparableLatitude,
    comparableLongitude,
  );

  if (
    distanceMiles === null ||
    subjectSqft === null ||
    comparableSqft === null ||
    subjectSqft <= 0 ||
    comparableSqft <= 0
  ) {
    return null;
  }

  const squareFootageDifference = Math.abs(comparableSqft - subjectSqft);
  const squareFootageDifferenceRatio = squareFootageDifference / subjectSqft;
  const locationScore = softSimilarity(distanceMiles, config.locationScaleMiles);
  const squareFootageScore = softSimilarity(
    squareFootageDifferenceRatio,
    config.squareFootageScaleRatio,
  );
  const saleAge = classifySaleAge(closingDate, referenceDate);
  const salesDateScore = softSimilarity(
    saleAge.saleAgeDays,
    config.salesDateScaleDays,
  );
  const totalWeight =
    config.locationWeight +
    config.squareFootageWeight +
    config.salesDateWeight;
  if (
    locationScore === null ||
    squareFootageScore === null ||
    salesDateScore === null ||
    !Number.isFinite(totalWeight) ||
    totalWeight <= 0
  ) {
    return null;
  }

  const comparableScore =
    (
      locationScore * config.locationWeight +
      squareFootageScore * config.squareFootageWeight +
      salesDateScore * config.salesDateWeight
    ) / totalWeight;

  return {
    comparableScore: round(comparableScore, 1),
    distanceMiles: round(distanceMiles, 3),
    locationScore: round(locationScore, 1),
    squareFootageScore: round(squareFootageScore, 1),
    salesDateScore: round(salesDateScore, 1),
    saleAgeDays: saleAge.saleAgeDays,
    soldWithinOneYear: saleAge.soldWithinOneYear,
    soldOverOneYear: saleAge.soldOverOneYear,
    soldOverTwoYears: saleAge.soldOverTwoYears,
    squareFootageDifference: round(squareFootageDifference, 0),
    squareFootageDifferenceRatio: round(squareFootageDifferenceRatio, 4),
    squareFootageDifferencePercent: round(squareFootageDifferenceRatio * 100, 1),
  };
}

export function filterComparablesForMarket(
  comparables,
  subject,
  breakdown,
) {
  if (!breakdown) return [...comparables];
  const subjectCity = String(subject?.city || "").trim().toLowerCase();
  const subjectZip = String(subject?.postal_code || "")
    .replace(/\D/g, "")
    .slice(0, 5);

  return comparables.filter((comparable) => {
    if (breakdown.scope === "city") {
      return Boolean(subjectCity) &&
        String(comparable.city || "").trim().toLowerCase() === subjectCity;
    }
    if (breakdown.scope === "zip") {
      const comparableZip = String(comparable.zip || "")
        .replace(/\D/g, "")
        .slice(0, 5);
      return Boolean(subjectZip) && comparableZip === subjectZip;
    }
    return breakdown.scope === "radius" &&
      Number.isFinite(Number(comparable.distanceMiles)) &&
      Number(comparable.distanceMiles) <= breakdown.radiusMiles;
  });
}

function ringCentroid(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  let crossSum = 0;
  let longitudeSum = 0;
  let latitudeSum = 0;

  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    const currentLongitude = finiteNumber(current?.[0]);
    const currentLatitude = finiteNumber(current?.[1]);
    const nextLongitude = finiteNumber(next?.[0]);
    const nextLatitude = finiteNumber(next?.[1]);
    if (
      currentLongitude === null ||
      currentLatitude === null ||
      nextLongitude === null ||
      nextLatitude === null
    ) {
      continue;
    }
    const cross = currentLongitude * nextLatitude - nextLongitude * currentLatitude;
    crossSum += cross;
    longitudeSum += (currentLongitude + nextLongitude) * cross;
    latitudeSum += (currentLatitude + nextLatitude) * cross;
  }

  if (Math.abs(crossSum) < 1e-14) return null;
  return {
    longitude: longitudeSum / (3 * crossSum),
    latitude: latitudeSum / (3 * crossSum),
    signedArea: crossSum / 2,
  };
}

export function polygonCentroid(rings) {
  if (!Array.isArray(rings) || !rings.length) return null;
  const centroids = rings.map(ringCentroid).filter(Boolean);
  if (centroids.length) {
    const signedArea = centroids.reduce((sum, item) => sum + item.signedArea, 0);
    if (Math.abs(signedArea) >= 1e-14) {
      return {
        longitude:
          centroids.reduce(
            (sum, item) => sum + item.longitude * item.signedArea,
            0,
          ) / signedArea,
        latitude:
          centroids.reduce(
            (sum, item) => sum + item.latitude * item.signedArea,
            0,
          ) / signedArea,
        area: Math.abs(signedArea),
      };
    }
  }

  const points = rings
    .flat()
    .filter(
      (point) =>
        Array.isArray(point) &&
        finiteNumber(point[0]) !== null &&
        finiteNumber(point[1]) !== null,
    );
  if (!points.length) return null;
  const longitudes = points.map((point) => Number(point[0]));
  const latitudes = points.map((point) => Number(point[1]));
  return {
    longitude: (Math.min(...longitudes) + Math.max(...longitudes)) / 2,
    latitude: (Math.min(...latitudes) + Math.max(...latitudes)) / 2,
    area: 0,
  };
}
