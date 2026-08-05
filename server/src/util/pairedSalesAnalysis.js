const MAX_PAIR_DISTANCE_MILES = 2;
const MAX_PAIR_DATE_DIFFERENCE_DAYS = 365;
const MAX_PAIR_AGE_DIFFERENCE_YEARS = 10;
const MAX_PAIR_SITE_DIFFERENCE_RATIO = 0.25;
const MAX_CONTROL_GLA_DIFFERENCE_RATIO = 0.1;
const MIN_LIVING_AREA_DIFFERENCE = 100;
const MAX_LIVING_AREA_DIFFERENCE = 599;
const MAX_COMPARISONS_PER_SALE = 120;
const MAX_PAIRS_PER_RANGE = 40;

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sampleStandardDeviation(values, average) {
  if (values.length < 2 || !Number.isFinite(average)) return null;
  const squaredDifferences = values.map((value) => (value - average) ** 2);
  return Math.sqrt(
    squaredDifferences.reduce((sum, value) => sum + value, 0) /
      (values.length - 1),
  );
}

function reliabilityFor(sampleSize) {
  if (sampleSize >= 30) return "strong";
  if (sampleSize >= 10) return "moderate";
  return "limited";
}

function statistics(values, unit) {
  if (!values.length) {
    return {
      sampleSize: 0,
      mean: null,
      median: null,
      standardDeviation: null,
      coefficientOfVariation: null,
      coefficientOfDispersion: null,
      recommendedAdjustment: null,
      reliability: "limited",
    };
  }
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const middle = median(values);
  const standardDeviation = sampleStandardDeviation(values, average);
  const coefficientOfVariation =
    standardDeviation === null || Math.abs(average) < 0.000001
      ? null
      : (standardDeviation / Math.abs(average)) * 100;
  const coefficientOfDispersion =
    middle === null || Math.abs(middle) < 0.000001
      ? null
      : (
          values.reduce((sum, value) => sum + Math.abs(value - middle), 0) /
          values.length /
          Math.abs(middle)
        ) * 100;
  const recommendedAdjustment =
    middle === null
      ? null
      : unit === "per_square_foot"
        ? Math.round(middle)
        : Math.round(middle / 100) * 100;
  return {
    sampleSize: values.length,
    mean: round(average, 2),
    median: round(middle, 2),
    standardDeviation: round(standardDeviation, 2),
    coefficientOfVariation: round(coefficientOfVariation, 2),
    coefficientOfDispersion: round(coefficientOfDispersion, 2),
    recommendedAdjustment,
    reliability: reliabilityFor(values.length),
  };
}

function normalizeBoolean(value) {
  if (value === true || value === false) return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["true", "t", "yes", "y", "1"].includes(normalized)) return true;
  if (["false", "f", "no", "n", "0"].includes(normalized)) return false;
  return null;
}

function lotSizeSquareFeet(value) {
  const area = positiveNumber(value);
  if (area === null) return null;
  return area < 100 ? area * 43_560 : area;
}

function normalizeHousingType(housingType, attachmentType, structuralStyle) {
  const primary = [attachmentType, housingType]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
  const combined = [attachmentType, housingType, structuralStyle]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
  if (!combined) return "unknown";
  if (/condo|minium/.test(combined)) return "condominium";
  if (/town\s*home|town\s*house/.test(combined)) return "townhome";
  if (/duplex|triplex|fourplex|multi[ -]?family/.test(combined)) {
    return "multi-family";
  }
  if (/attached|patio home|zero[ -]?lot/.test(combined)) return "attached";
  if (/detached|single[ -]?family/.test(combined)) return "detached";
  return primary || "unknown";
}

function dateMilliseconds(value) {
  const milliseconds = Date.parse(String(value || ""));
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function saleIdentity(row, index) {
  return String(
    row.source_record_id || row.sale_id || row.primary_account_id || `sale-${index}`,
  );
}

function normalizeSale(row, index) {
  const garageSpaces = finiteNumber(row.garage_spaces);
  const sale = {
    id: saleIdentity(row, index),
    saleId: row.sale_id == null ? null : String(row.sale_id),
    sourceRecordId:
      row.source_record_id == null ? null : String(row.source_record_id),
    accountId: row.primary_account_id || null,
    address: row.address || null,
    city: row.city || null,
    closingDate: row.closing_date || null,
    salePrice: positiveNumber(row.sale_price),
    bedrooms: finiteNumber(row.bedrooms),
    bathrooms: finiteNumber(row.bathrooms),
    garageSpaces:
      garageSpaces === null ? null : Math.max(0, Math.round(garageSpaces)),
    pool: normalizeBoolean(row.pool_yn),
    livingArea: positiveNumber(row.living_area),
    siteSize: lotSizeSquareFeet(row.site_size),
    yearBuilt: positiveNumber(row.year_built),
    housingType: normalizeHousingType(
      row.housing_type,
      row.attachment_type,
      row.structural_style,
    ),
    latitude: finiteNumber(row.latitude),
    longitude: finiteNumber(row.longitude),
    closingMilliseconds: dateMilliseconds(row.closing_date),
  };
  if (
    sale.salePrice === null ||
    sale.livingArea === null ||
    sale.latitude === null ||
    sale.longitude === null ||
    sale.closingMilliseconds === null
  ) {
    return null;
  }
  return sale;
}

function greatCircleMiles(left, right) {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const leftLatitude = radians(left.latitude);
  const rightLatitude = radians(right.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) *
      Math.cos(rightLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 3958.7613 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function relativeDifference(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  const average = (Math.abs(left) + Math.abs(right)) / 2;
  return average > 0 ? Math.abs(left - right) / average : 0;
}

function exactControlKey(sale, dimension) {
  if (sale.housingType === "unknown" || !Number.isFinite(sale.bedrooms)) {
    return null;
  }
  if (dimension !== "bathrooms" && !Number.isFinite(sale.bathrooms)) {
    return null;
  }
  if (dimension !== "garage" && !Number.isFinite(sale.garageSpaces)) {
    return null;
  }
  if (dimension !== "pool" && typeof sale.pool !== "boolean") {
    return null;
  }
  const controls = [sale.housingType, sale.bedrooms ?? "unknown"];
  if (dimension !== "bathrooms") controls.push(sale.bathrooms ?? "unknown");
  if (dimension !== "garage") controls.push(sale.garageSpaces ?? "unknown");
  if (dimension !== "pool") controls.push(sale.pool ?? "unknown");
  return controls.join("|");
}

function targetDifference(left, right, dimension) {
  if (dimension === "bathrooms") {
    if (!Number.isFinite(left.bathrooms) || !Number.isFinite(right.bathrooms)) return null;
    const difference = Math.abs(left.bathrooms - right.bathrooms);
    return difference > 0 && difference <= 1 ? difference : null;
  }
  if (dimension === "garage") {
    if (!Number.isFinite(left.garageSpaces) || !Number.isFinite(right.garageSpaces)) return null;
    return Math.abs(left.garageSpaces - right.garageSpaces) === 1 ? 1 : null;
  }
  if (dimension === "pool") {
    return typeof left.pool === "boolean" &&
      typeof right.pool === "boolean" &&
      left.pool !== right.pool
      ? 1
      : null;
  }
  const difference = Math.abs(left.livingArea - right.livingArea);
  return difference >= MIN_LIVING_AREA_DIFFERENCE &&
    difference <= MAX_LIVING_AREA_DIFFERENCE
    ? difference
    : null;
}

function controlsPass(left, right, dimension) {
  const dateDifferenceDays =
    Math.abs(left.closingMilliseconds - right.closingMilliseconds) / 86_400_000;
  if (dateDifferenceDays > MAX_PAIR_DATE_DIFFERENCE_DAYS) return null;
  const distanceMiles = greatCircleMiles(left, right);
  if (!Number.isFinite(distanceMiles) || distanceMiles > MAX_PAIR_DISTANCE_MILES) return null;
  const yearDifference =
    Number.isFinite(left.yearBuilt) && Number.isFinite(right.yearBuilt)
      ? Math.abs(left.yearBuilt - right.yearBuilt)
      : null;
  if (yearDifference !== null && yearDifference > MAX_PAIR_AGE_DIFFERENCE_YEARS) return null;
  const siteDifferenceRatio = relativeDifference(left.siteSize, right.siteSize);
  if (
    siteDifferenceRatio !== null &&
    siteDifferenceRatio > MAX_PAIR_SITE_DIFFERENCE_RATIO
  ) {
    return null;
  }
  const livingAreaDifferenceRatio = relativeDifference(
    left.livingArea,
    right.livingArea,
  );
  if (
    dimension !== "living_area" &&
    livingAreaDifferenceRatio > MAX_CONTROL_GLA_DIFFERENCE_RATIO
  ) {
    return null;
  }
  return {
    dateDifferenceDays,
    distanceMiles,
    yearDifference,
    siteDifferenceRatio,
    livingAreaDifferenceRatio,
  };
}

function closenessScore(controlDifferences, dimension) {
  const distanceScore = Math.max(
    0,
    1 - controlDifferences.distanceMiles / MAX_PAIR_DISTANCE_MILES,
  );
  const dateScore = Math.max(
    0,
    1 - controlDifferences.dateDifferenceDays / MAX_PAIR_DATE_DIFFERENCE_DAYS,
  );
  const ageScore =
    controlDifferences.yearDifference === null
      ? 0.5
      : Math.max(
          0,
          1 - controlDifferences.yearDifference / MAX_PAIR_AGE_DIFFERENCE_YEARS,
        );
  const siteScore =
    controlDifferences.siteDifferenceRatio === null
      ? 0.5
      : Math.max(
          0,
          1 -
            controlDifferences.siteDifferenceRatio /
              MAX_PAIR_SITE_DIFFERENCE_RATIO,
        );
  const livingAreaScore =
    dimension === "living_area"
      ? 1
      : Math.max(
          0,
          1 -
            controlDifferences.livingAreaDifferenceRatio /
              MAX_CONTROL_GLA_DIFFERENCE_RATIO,
        );
  return round(
    (distanceScore * 30 +
      dateScore * 20 +
      ageScore * 20 +
      siteScore * 10 +
      livingAreaScore * 20),
    1,
  );
}

function superiorAndInferior(left, right, dimension) {
  if (dimension === "bathrooms") {
    return left.bathrooms > right.bathrooms
      ? { superior: left, inferior: right }
      : { superior: right, inferior: left };
  }
  if (dimension === "garage") {
    return left.garageSpaces > right.garageSpaces
      ? { superior: left, inferior: right }
      : { superior: right, inferior: left };
  }
  if (dimension === "pool") {
    return left.pool
      ? { superior: left, inferior: right }
      : { superior: right, inferior: left };
  }
  return left.livingArea > right.livingArea
    ? { superior: left, inferior: right }
    : { superior: right, inferior: left };
}

function featureValue(sale, dimension) {
  if (dimension === "bathrooms") return sale.bathrooms;
  if (dimension === "garage") return sale.garageSpaces;
  if (dimension === "pool") return sale.pool;
  return sale.livingArea;
}

function formatFeatureValue(value) {
  if (typeof value === "boolean") return value ? "With pool" : "Without pool";
  if (!Number.isFinite(value)) return "Unknown";
  return Number.isInteger(value) ? String(value) : String(round(value, 1));
}

function rangeDefinition(inferiorValue, superiorValue, featureDifference, dimension) {
  if (dimension === "pool") {
    return {
      id: "without-to-with-pool",
      label: "Without pool to with pool",
      fromValue: false,
      toValue: true,
      unit: "per_feature",
      unitLabel: "pool contribution",
    };
  }
  if (dimension === "living_area") {
    const lower = Math.floor(featureDifference / 100) * 100;
    const upper = lower + 99;
    return {
      id: `${lower}-to-${upper}-sf-difference`,
      label: `${lower.toLocaleString("en-US")}–${upper.toLocaleString("en-US")} SF difference`,
      fromValue: lower,
      toValue: upper,
      unit: "per_square_foot",
      unitLabel: "per square foot",
    };
  }
  const prefix = dimension === "bathrooms" ? "bath" : "garage";
  return {
    id: `${prefix}-${inferiorValue}-to-${superiorValue}`,
    label:
      dimension === "bathrooms"
        ? `${formatFeatureValue(inferiorValue)} to ${formatFeatureValue(superiorValue)} baths`
        : `${formatFeatureValue(inferiorValue)} to ${formatFeatureValue(superiorValue)} garage spaces`,
    fromValue: inferiorValue,
    toValue: superiorValue,
    unit: dimension === "bathrooms" ? "per_bath_equivalent" : "per_garage_space",
    unitLabel:
      dimension === "bathrooms"
        ? "per full-bath equivalent"
        : "per garage space",
  };
}

function publicSale(sale) {
  return {
    saleId: sale.saleId,
    sourceRecordId: sale.sourceRecordId,
    accountId: sale.accountId,
    address: sale.address,
    city: sale.city,
    closingDate: sale.closingDate,
    salePrice: sale.salePrice,
    bedrooms: sale.bedrooms,
    bathrooms: sale.bathrooms,
    garageSpaces: sale.garageSpaces,
    pool: sale.pool,
    livingArea: sale.livingArea,
    siteSize: sale.siteSize,
    yearBuilt: sale.yearBuilt,
  };
}

function candidatePair(left, right, dimension) {
  const featureDifference = targetDifference(left, right, dimension);
  if (featureDifference === null) return null;
  const controlDifferences = controlsPass(left, right, dimension);
  if (!controlDifferences) return null;
  const { superior, inferior } = superiorAndInferior(left, right, dimension);
  const inferiorValue = featureValue(inferior, dimension);
  const superiorValue = featureValue(superior, dimension);
  const salePriceDifference = superior.salePrice - inferior.salePrice;
  const unitPriceDifference =
    dimension === "pool"
      ? salePriceDifference
      : salePriceDifference / featureDifference;
  const range = rangeDefinition(
    inferiorValue,
    superiorValue,
    featureDifference,
    dimension,
  );
  return {
    id: `${dimension}:${inferior.id}:${superior.id}`,
    range,
    inferior: publicSale(inferior),
    superior: publicSale(superior),
    inferiorId: inferior.id,
    superiorId: superior.id,
    featureDifference: round(featureDifference, 2),
    salePriceDifference: round(salePriceDifference, 2),
    unitPriceDifference: round(unitPriceDifference, 2),
    matchScore: closenessScore(controlDifferences, dimension),
    controlDifferences: {
      distanceMiles: round(controlDifferences.distanceMiles, 2),
      closingDateDays: Math.round(controlDifferences.dateDifferenceDays),
      livingAreaPercent: round(controlDifferences.livingAreaDifferenceRatio * 100, 1),
      yearBuiltYears: controlDifferences.yearDifference,
      siteSizePercent:
        controlDifferences.siteDifferenceRatio === null
          ? null
          : round(controlDifferences.siteDifferenceRatio * 100, 1),
    },
  };
}

function collectDimensionCandidates(sales, dimension) {
  const groups = new Map();
  for (const sale of sales) {
    const target = featureValue(sale, dimension);
    if (target === null || target === undefined) continue;
    const key = exactControlKey(sale, dimension);
    if (!key) continue;
    const group = groups.get(key) || [];
    group.push(sale);
    groups.set(key, group);
  }

  const candidates = [];
  for (const group of groups.values()) {
    group.sort((left, right) => left.livingArea - right.livingArea);
    for (let leftIndex = 0; leftIndex < group.length; leftIndex += 1) {
      const left = group[leftIndex];
      const comparisonLimit = Math.min(
        group.length,
        leftIndex + 1 + MAX_COMPARISONS_PER_SALE,
      );
      for (let rightIndex = leftIndex + 1; rightIndex < comparisonLimit; rightIndex += 1) {
        const right = group[rightIndex];
        const livingDifference = right.livingArea - left.livingArea;
        if (
          dimension === "living_area" &&
          livingDifference > MAX_LIVING_AREA_DIFFERENCE
        ) {
          break;
        }
        if (
          dimension !== "living_area" &&
          relativeDifference(left.livingArea, right.livingArea) >
            MAX_CONTROL_GLA_DIFFERENCE_RATIO
        ) {
          break;
        }
        const candidate = candidatePair(left, right, dimension);
        if (candidate) candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function rangesFromCandidates(candidates) {
  const byRange = new Map();
  for (const candidate of candidates) {
    const rangeCandidates = byRange.get(candidate.range.id) || [];
    rangeCandidates.push(candidate);
    byRange.set(candidate.range.id, rangeCandidates);
  }
  const ranges = [];
  for (const rangeCandidates of byRange.values()) {
    rangeCandidates.sort((left, right) =>
      right.matchScore - left.matchScore ||
      left.controlDifferences.distanceMiles - right.controlDifferences.distanceMiles ||
      left.controlDifferences.closingDateDays - right.controlDifferences.closingDateDays,
    );
    const usedSales = new Set();
    const selectedPairs = [];
    for (const candidate of rangeCandidates) {
      if (
        usedSales.has(candidate.inferiorId) ||
        usedSales.has(candidate.superiorId)
      ) {
        continue;
      }
      usedSales.add(candidate.inferiorId);
      usedSales.add(candidate.superiorId);
      selectedPairs.push(candidate);
      if (selectedPairs.length >= MAX_PAIRS_PER_RANGE) break;
    }
    if (!selectedPairs.length) continue;
    const range = selectedPairs[0].range;
    ranges.push({
      ...range,
      statistics: statistics(
        selectedPairs.map((pair) => pair.unitPriceDifference),
        range.unit,
      ),
      pairs: selectedPairs.map(({ inferiorId, superiorId, range: _range, ...pair }) => pair),
    });
  }
  return ranges.sort((left, right) => {
    if (typeof left.fromValue === "number" && typeof right.fromValue === "number") {
      return left.fromValue - right.fromValue;
    }
    return left.label.localeCompare(right.label);
  });
}

const DIMENSIONS = [
  {
    key: "bathrooms",
    label: "Total bathrooms",
    explanation:
      "Pairs hold housing type, bedroom count, garage count, pool status, location, date, age, site size, and living area as close as practicable.",
  },
  {
    key: "garage",
    label: "Garage spaces",
    explanation:
      "Pairs hold housing type, bedroom and bathroom counts, pool status, location, date, age, site size, and living area as close as practicable.",
  },
  {
    key: "pool",
    label: "Pool",
    explanation:
      "Pairs hold housing type, bedroom and bathroom counts, garage count, location, date, age, site size, and living area as close as practicable.",
  },
  {
    key: "living_area",
    label: "Gross living area",
    explanation:
      "Pairs hold housing type, bedroom and bathroom counts, garage count, pool status, location, date, age, and site size as close as practicable. Results are normalized per square foot.",
  },
];

export function buildPairedSalesAnalysis(rows) {
  const normalizedSales = rows
    .map(normalizeSale)
    .filter(Boolean);
  return {
    pairableSaleCount: normalizedSales.length,
    methodology: {
      maximumPairDistanceMiles: MAX_PAIR_DISTANCE_MILES,
      maximumClosingDateDifferenceDays: MAX_PAIR_DATE_DIFFERENCE_DAYS,
      maximumYearBuiltDifferenceYears: MAX_PAIR_AGE_DIFFERENCE_YEARS,
      maximumSiteSizeDifferencePercent: MAX_PAIR_SITE_DIFFERENCE_RATIO * 100,
      maximumControlLivingAreaDifferencePercent:
        MAX_CONTROL_GLA_DIFFERENCE_RATIO * 100,
      maximumPairsPerRange: MAX_PAIRS_PER_RANGE,
      pairReuseWithinRange: false,
      negativeDifferencesRetained: true,
      knownNonTargetControlsRequired: true,
    },
    dimensions: DIMENSIONS.map((dimension) => ({
      ...dimension,
      ranges: rangesFromCandidates(
        collectDimensionCandidates(normalizedSales, dimension.key),
      ),
    })),
  };
}
