const COMPLEXITY_ORDER = Object.freeze({ simple: 0, moderate: 1, complex: 2 });

export const PROPERTY_COMPLEXITY_LEVELS = Object.freeze([
  "simple",
  "moderate",
  "complex",
]);

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rounded(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function normalizedPercentile(value) {
  const parsed = finiteNumber(value);
  if (parsed === null) return null;
  return Math.max(0, Math.min(100, parsed));
}

function normalizeGeography(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (["urban", "suburban", "semi_rural", "rural"].includes(normalized)) {
    return normalized;
  }
  return "suburban";
}

function minimumLevel(current, requested) {
  return COMPLEXITY_ORDER[requested] > COMPLEXITY_ORDER[current]
    ? requested
    : current;
}

function percentileFactor({
  code,
  label,
  value,
  percentile,
  sampleCount,
  unit = "",
  extremePoints,
  notablePoints,
}) {
  const position = normalizedPercentile(percentile);
  if (position === null || Number(sampleCount) < 10) return null;
  const numericValue = finiteNumber(value);
  const formattedValue = numericValue === null
    ? "the reported value"
    : `${Math.round(numericValue).toLocaleString()}${unit}`;
  if (position <= 5 || position >= 95) {
    return {
      code,
      label,
      severity: "high",
      points: extremePoints,
      detail: `${formattedValue} is in approximately the ${rounded(position, 0)}th percentile among ${Number(sampleCount).toLocaleString()} nearby properties.`,
    };
  }
  if (position <= 10 || position >= 90) {
    return {
      code,
      label,
      severity: "moderate",
      points: notablePoints,
      detail: `${formattedValue} is in approximately the ${rounded(position, 0)}th percentile among ${Number(sampleCount).toLocaleString()} nearby properties.`,
    };
  }
  return null;
}

function sourceWarnings(sourceHealth = []) {
  return sourceHealth.flatMap((source) => {
    if (source.usable && source.serving_stale_data) {
      return [`${source.label || source.source_key} is currently unavailable or stale; the most recent locally stored data is being used.`];
    }
    if (!source.usable) {
      return [`${source.label || source.source_key} has not been synchronized, so related complexity factors remain unscored.`];
    }
    return [];
  });
}

/**
 * Produce an appraisal screening recommendation from independently reviewable
 * property, peer, and spatial evidence. This intentionally recommends a search
 * profile; it never changes the appraiser's final complexity selection.
 */
export function buildPropertyComplexityAssessment({
  subject = {},
  peerStatistics = {},
  spatialContext = {},
  sourceHealth = [],
  geography,
  computedAt = new Date().toISOString(),
} = {}) {
  const factors = [];
  const warnings = sourceWarnings(sourceHealth);
  let requiredLevel = "simple";

  const addFactor = (factor, forcedLevel = null) => {
    if (!factor) return;
    factors.push(factor);
    if (forcedLevel) requiredLevel = minimumLevel(requiredLevel, forcedLevel);
  };

  addFactor(percentileFactor({
    code: "atypical_gla",
    label: "Atypical gross living area",
    value: subject.gross_living_area_sqft,
    percentile: peerStatistics.gla?.percentile,
    sampleCount: peerStatistics.gla?.count,
    unit: " sq. ft.",
    extremePoints: 14,
    notablePoints: 8,
  }));
  addFactor(percentileFactor({
    code: "atypical_site_size",
    label: "Atypical site size",
    value: subject.site_area_sqft ?? spatialContext.subject_site_area_sqft,
    percentile: spatialContext.site_percentile ?? peerStatistics.site_area?.percentile,
    sampleCount: spatialContext.site_comparison_count ?? peerStatistics.site_area?.count,
    unit: " sq. ft.",
    extremePoints: 14,
    notablePoints: 7,
  }));
  addFactor(percentileFactor({
    code: "atypical_age",
    label: "Atypical age / year built",
    value: subject.actual_age,
    percentile: peerStatistics.age?.percentile,
    sampleCount: peerStatistics.age?.count,
    unit: " years",
    extremePoints: 8,
    notablePoints: 4,
  }));

  const amenityFactors = Array.isArray(subject.amenities)
    ? subject.amenities.filter((item) => item?.present)
    : [];
  const poolAmenity = amenityFactors.find((item) => item.key === "pool");
  const poolPrevalence = finiteNumber(peerStatistics.pool_prevalence_percent);
  if (poolAmenity && poolPrevalence !== null && poolPrevalence < 15) {
    addFactor({
      code: "uncommon_pool",
      label: "Uncommon pool amenity",
      severity: "moderate",
      points: 5,
      detail: `A pool is reported while only ${rounded(poolPrevalence, 1)}% of measured nearby properties report one.`,
    });
  }
  const additionalAmenities = amenityFactors.filter((item) => item.key !== "pool");
  if (additionalAmenities.length) {
    const points = Math.min(8, additionalAmenities.length * 2);
    addFactor({
      code: "additional_amenities",
      label: "Additional or uncommon amenities",
      severity: points >= 6 ? "moderate" : "low",
      points,
      detail: additionalAmenities.map((item) => item.label).join(", "),
    });
  }

  const adjacentInfluences = Array.isArray(spatialContext.adjacent_influences)
    ? spatialContext.adjacent_influences
    : [];
  for (const influence of adjacentInfluences.slice(0, 3)) {
    const category = String(influence.category || "other");
    const industrial = /industrial|warehouse|manufactur/i.test(
      `${influence.use_description || ""} ${influence.property_description || ""}`,
    );
    const points = industrial ? 35 : category === "commercial" ? 30 : category === "multifamily" ? 25 : 12;
    const relationship = influence.relationship === "rear"
      ? "backs to"
      : influence.relationship === "side"
        ? "shares a side boundary with"
        : "is directly adjacent to";
    addFactor({
      code: `${category}_adjacency`,
      label: `${industrial ? "Industrial" : influence.category_label || category} adjacency`,
      severity: "high",
      points,
      detail: `The subject ${relationship} ${influence.site_address || influence.use_description || "a mapped influence parcel"}.`,
      evidence: influence,
    }, "complex");
  }

  const nearbyInfluences = Array.isArray(spatialContext.nearby_influences)
    ? spatialContext.nearby_influences
    : [];
  const nearestInfluence = nearbyInfluences[0];
  if (!adjacentInfluences.length && nearestInfluence) {
    const distanceFeet = finiteNumber(nearestInfluence.distance_feet);
    if (distanceFeet !== null && distanceFeet <= 500) {
      const points = distanceFeet <= 250 ? 14 : 8;
      addFactor({
        code: `${nearestInfluence.category || "external"}_proximity`,
        label: `${nearestInfluence.category_label || "External use"} proximity`,
        severity: distanceFeet <= 250 ? "moderate" : "low",
        points,
        detail: `${nearestInfluence.site_address || nearestInfluence.use_description || "A mapped influence parcel"} is approximately ${Math.round(distanceFeet).toLocaleString()} feet from the subject.`,
        evidence: nearestInfluence,
      }, distanceFeet <= 100 ? "moderate" : null);
    }
  }

  if (spatialContext.corner_lot) {
    addFactor({
      code: "corner_lot",
      label: "Corner lot",
      severity: "low",
      points: 6,
      detail: `${Number(spatialContext.road_frontage_count || 2)} separately named road frontages were detected: ${(spatialContext.road_frontages || []).join(", ")}.`,
    });
  }
  const nearestMajorRoad = spatialContext.nearest_major_road;
  const majorRoadDistance = finiteNumber(nearestMajorRoad?.distance_feet);
  if (majorRoadDistance !== null && majorRoadDistance <= 300) {
    const primary = nearestMajorRoad.road_class === "primary";
    const points = primary && majorRoadDistance <= 150 ? 20 : majorRoadDistance <= 100 ? 12 : 7;
    addFactor({
      code: "major_road_influence",
      label: "Major-road influence",
      severity: points >= 12 ? "high" : "moderate",
      points,
      detail: `${nearestMajorRoad.name || "A major road"} is approximately ${Math.round(majorRoadDistance).toLocaleString()} feet from the parcel.`,
      evidence: nearestMajorRoad,
    }, points >= 12 ? "moderate" : null);
  }
  const nearestRailroad = spatialContext.nearest_railroad;
  const railroadDistance = finiteNumber(nearestRailroad?.distance_feet);
  if (railroadDistance !== null && railroadDistance <= 1_000) {
    const points = railroadDistance <= 250 ? 24 : railroadDistance <= 500 ? 16 : 7;
    addFactor({
      code: "railroad_influence",
      label: "Railroad influence",
      severity: points >= 16 ? "high" : "moderate",
      points,
      detail: `${nearestRailroad.name || "A mapped railroad"} is approximately ${Math.round(railroadDistance).toLocaleString()} feet from the parcel.`,
      evidence: nearestRailroad,
    }, railroadDistance <= 500 ? "moderate" : null);
  }
  const floodContext = spatialContext.flood_context;
  if (floodContext?.special_flood_hazard === true) {
    addFactor({
      code: "special_flood_hazard_area",
      label: "Mapped special flood hazard area",
      severity: "high",
      points: 25,
      detail: `The parcel intersects FEMA flood zone ${floodContext.flood_zone || "SFHA"}; the effective map and any property-specific flood determination require appraiser review.`,
      evidence: floodContext,
    }, "complex");
  }
  const zoningContext = spatialContext.zoning_context;
  const generalizedZoning = String(zoningContext?.generalized_use || "").toLowerCase();
  const housingType = String(subject.housing_type || "").toLowerCase();
  const residentialSubject = /single|detached|attached|town|condo|residen/.test(housingType);
  if (
    residentialSubject && generalizedZoning &&
    !/residen|mixed|planned|pud|pd/.test(generalizedZoning)
  ) {
    addFactor({
      code: "zoning_use_mismatch",
      label: "Zoning/current-use mismatch",
      severity: "high",
      points: 25,
      detail: `The saved zoning source classifies the site as ${zoningContext.generalized_use}; the current residential use requires investigation.`,
      evidence: zoningContext,
    }, "complex");
  }
  const compactness = finiteNumber(spatialContext.parcel_compactness);
  if (compactness !== null && compactness < 0.4) {
    addFactor({
      code: "irregular_site",
      label: "Irregular parcel configuration",
      severity: compactness < 0.25 ? "high" : "moderate",
      points: compactness < 0.25 ? 10 : 5,
      detail: `The parcel compactness ratio is ${rounded(compactness, 2)}, indicating a potentially irregular configuration that warrants review.`,
    });
  }

  if (Number(peerStatistics.peer_count || 0) < 20) {
    warnings.push("Fewer than 20 nearby residential properties had sufficient local characteristics for a reliable typical-property comparison.");
  }
  if (!spatialContext.parcel_available) {
    warnings.push("The subject parcel is not yet available in the local GIS mirror; adjacency, road-frontage, shape, and GIS site-size factors remain unscored.");
  }

  const score = Math.min(100, factors.reduce((sum, factor) => sum + Number(factor.points || 0), 0));
  let automaticLevel = score >= 45 ? "complex" : score >= 20 ? "moderate" : "simple";
  automaticLevel = minimumLevel(automaticLevel, requiredLevel);
  const normalizedGeography = normalizeGeography(geography);
  const usableSources = sourceHealth.filter((source) => source.usable).length;
  const staleSources = sourceHealth.filter((source) => source.serving_stale_data).length;
  const peerSufficient = Number(peerStatistics.peer_count || 0) >= 20;
  const confidence = spatialContext.parcel_available && peerSufficient && staleSources === 0
    ? "high"
    : (spatialContext.parcel_available || peerSufficient || usableSources > 0)
      ? "moderate"
      : "limited";

  return {
    methodology_version: 1,
    computed_at: computedAt,
    automatic_complexity: automaticLevel,
    effective_complexity: automaticLevel,
    score,
    confidence,
    geography: normalizedGeography,
    recommended_search_profile: `${normalizedGeography}_${automaticLevel}`,
    factors: factors.sort((left, right) => Number(right.points) - Number(left.points)),
    warnings: [...new Set(warnings)],
    subject,
    peer_statistics: peerStatistics,
    spatial_context: spatialContext,
    source_health: sourceHealth,
    requires_appraiser_review: true,
    review_status: "automatic",
    appraiser_complexity: null,
    appraiser_notes: null,
    reviewer: null,
    reviewed_at: null,
  };
}

export function normalizePropertyComplexityReview(value = {}) {
  const complexity = String(value.complexity || value.appraiser_complexity || "")
    .trim()
    .toLowerCase();
  if (!PROPERTY_COMPLEXITY_LEVELS.includes(complexity)) {
    throw new Error("invalid_property_complexity");
  }
  const notes = String(value.notes || value.appraiser_notes || "").trim().slice(0, 4_000);
  const reviewer = String(value.reviewer || "HomeNode appraiser").trim().slice(0, 200) || "HomeNode appraiser";
  return { complexity, notes, reviewer };
}

export function applyPropertyComplexityReview(assessment, review) {
  if (!assessment) throw new Error("property_complexity_assessment_required");
  const normalized = normalizePropertyComplexityReview(review);
  return {
    ...assessment,
    effective_complexity: normalized.complexity,
    recommended_search_profile: `${normalizeGeography(assessment.geography)}_${normalized.complexity}`,
    review_status: normalized.complexity === assessment.automatic_complexity
      ? "reviewed"
      : "overridden",
    appraiser_complexity: normalized.complexity,
    appraiser_notes: normalized.notes || null,
    reviewer: normalized.reviewer,
    reviewed_at: new Date().toISOString(),
  };
}

