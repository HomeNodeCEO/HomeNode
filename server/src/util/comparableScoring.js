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
