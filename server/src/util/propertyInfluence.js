const MATERIAL_INFLUENCE_CATEGORIES = Object.freeze([
  "external_use",
  "major_road",
  "traffic_volume",
  "railroad",
  "flood",
  "corner",
]);

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function influenceCategory(influence = {}) {
  const description = `${influence.use_description || ""} ${influence.property_description || ""}`;
  if (/industrial|warehouse|manufactur|distribution|freight/i.test(description)) {
    return "industrial";
  }
  const category = normalizedText(influence.category);
  if (category === "multifamily") return "multifamily";
  if (category === "commercial") return "commercial";
  return category || "other";
}

function relationship(value) {
  const normalized = normalizedText(value);
  return ["front", "rear", "side", "adjacent"].includes(normalized)
    ? normalized
    : "adjacent";
}

function proximityBand(distanceFeet, bands) {
  const distance = finiteNumber(distanceFeet);
  if (distance === null) return null;
  return bands.find(({ maximum }) => distance <= maximum)?.key || null;
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function nearestInfluence(influences) {
  return [...influences].sort(
    (left, right) =>
      (finiteNumber(left?.distance_feet) ?? Number.POSITIVE_INFINITY) -
      (finiteNumber(right?.distance_feet) ?? Number.POSITIVE_INFINITY),
  )[0] || null;
}

/**
 * Convert independently reviewable GIS observations into stable comparison
 * keys. These are deliberately broad: the appraiser needs a sale exposed to a
 * similar influence, not a false claim that two sites are identical.
 */
export function buildPropertyInfluenceSignature(spatialContext = {}) {
  const adjacent = Array.isArray(spatialContext.adjacent_influences)
    ? spatialContext.adjacent_influences
    : [];
  const nearby = Array.isArray(spatialContext.nearby_influences)
    ? spatialContext.nearby_influences
    : [];
  const materialKeys = [];
  const descriptors = [];

  for (const influence of adjacent) {
    const category = influenceCategory(influence);
    const side = relationship(influence.relationship);
    materialKeys.push(`external_use:${category}:${side}`);
    descriptors.push(`${category} ${side} adjacency`);
  }
  if (!adjacent.length) {
    const nearest = nearestInfluence(nearby);
    const band = proximityBand(nearest?.distance_feet, [
      { key: "within_100ft", maximum: 100 },
      { key: "within_250ft", maximum: 250 },
      { key: "within_500ft", maximum: 500 },
    ]);
    if (nearest && band) {
      const category = influenceCategory(nearest);
      materialKeys.push(`external_use:${category}:${band}`);
      descriptors.push(`${category} ${band.replaceAll("_", " ")}`);
    }
  }

  const majorRoad = spatialContext.nearest_major_road;
  const majorRoadBand = proximityBand(majorRoad?.distance_feet, [
    { key: "within_100ft", maximum: 100 },
    { key: "within_300ft", maximum: 300 },
    { key: "within_500ft", maximum: 500 },
  ]);
  const majorRoadClass = normalizedText(majorRoad?.road_class);
  if (majorRoadBand && ["primary", "secondary"].includes(majorRoadClass)) {
    materialKeys.push(`major_road:${majorRoadClass}:${majorRoadBand}`);
    descriptors.push(`${majorRoadClass} road ${majorRoadBand.replaceAll("_", " ")}`);
  }

  const trafficRoad = spatialContext.nearest_high_traffic_road;
  const trafficCount = finiteNumber(trafficRoad?.annual_average_daily_traffic);
  const trafficBand = trafficCount === null
    ? null
    : trafficCount >= 50000
      ? "very_high"
      : trafficCount >= 25000
        ? "high"
        : trafficCount >= 10000
          ? "moderate"
          : null;
  const trafficDistanceBand = proximityBand(trafficRoad?.distance_feet, [
    { key: "within_100ft", maximum: 100 },
    { key: "within_300ft", maximum: 300 },
    { key: "within_500ft", maximum: 500 },
    { key: "within_750ft", maximum: 750 },
  ]);
  if (trafficBand && trafficDistanceBand) {
    materialKeys.push(`traffic_volume:${trafficBand}:${trafficDistanceBand}`);
    descriptors.push(`${trafficBand.replaceAll("_", " ")} traffic ${trafficDistanceBand.replaceAll("_", " ")}`);
  }

  const railroad = spatialContext.nearest_railroad;
  const railroadBand = proximityBand(railroad?.distance_feet, [
    { key: "within_250ft", maximum: 250 },
    { key: "within_500ft", maximum: 500 },
    { key: "within_1000ft", maximum: 1_000 },
  ]);
  if (railroadBand) {
    materialKeys.push(`railroad:${railroadBand}`);
    descriptors.push(`railroad ${railroadBand.replaceAll("_", " ")}`);
  }

  const flood = spatialContext.flood_context || {};
  const floodZone = normalizedText(flood.flood_zone || flood.zone);
  const specialFloodHazard = flood.special_flood_hazard === true ||
    ["a", "ae", "ah", "ao", "ar", "a99", "v", "ve"].includes(floodZone);
  if (specialFloodHazard) {
    materialKeys.push(`flood:sfha:${floodZone || "mapped"}`);
    descriptors.push(`special flood hazard area${floodZone ? ` (${floodZone.toUpperCase()})` : ""}`);
  }

  if (spatialContext.corner_lot === true) {
    materialKeys.push("corner:corner_lot");
    descriptors.push("corner lot");
  }

  const zoning = spatialContext.zoning_context || {};
  const zoningCode = normalizedText(zoning.zoning_code || zoning.code);
  const zoningUse = normalizedText(zoning.generalized_use || zoning.use_category);
  const zoningKeys = uniqueSorted([
    zoningUse ? `zoning_use:${zoningUse}` : null,
    zoningCode ? `zoning_code:${zoningCode}` : null,
  ]);
  const sortedMaterialKeys = uniqueSorted(materialKeys);
  const categoryKeys = uniqueSorted(
    sortedMaterialKeys.map((key) => key.split(":", 1)[0]),
  );
  const contextAvailable = spatialContext.parcel_available === true;

  return {
    methodology_version: 3,
    context_available: contextAvailable,
    material_influence_present: sortedMaterialKeys.length > 0,
    material_keys: sortedMaterialKeys,
    material_categories: categoryKeys,
    zoning_keys: zoningKeys,
    descriptors: uniqueSorted(descriptors),
    dominant_influence_key: sortedMaterialKeys[0] || "ordinary_location",
  };
}

function categoryMap(signature = {}) {
  const result = new Map();
  for (const key of signature.material_keys || []) {
    const category = String(key).split(":", 1)[0];
    if (!result.has(category)) result.set(category, []);
    result.get(category).push(key);
  }
  return result;
}

/**
 * Influence similarity is a ranking tier, not a dollar adjustment. A complete
 * material match must be allowed to outrank an otherwise closer or newer sale;
 * the normal numeric comparable score orders properties within the same tier.
 */
export function comparePropertyInfluenceSignatures(subject, comparable) {
  if (!subject?.context_available || !comparable?.context_available) {
    return {
      data_available: false,
      priority_tier: 0,
      similarity_score: null,
      exact_material_match: false,
      shared_material_keys: [],
      missing_subject_keys: subject?.material_keys || [],
      additional_comparable_keys: comparable?.material_keys || [],
      reason: "influence_context_unavailable",
    };
  }

  const subjectKeys = new Set(subject.material_keys || []);
  const comparableKeys = new Set(comparable.material_keys || []);
  const shared = [...subjectKeys].filter((key) => comparableKeys.has(key)).sort();
  const missing = [...subjectKeys].filter((key) => !comparableKeys.has(key)).sort();
  const additional = [...comparableKeys].filter((key) => !subjectKeys.has(key)).sort();
  const exactMaterialMatch = missing.length === 0 && additional.length === 0;

  if (!subjectKeys.size) {
    const ordinaryMatch = comparableKeys.size === 0;
    return {
      data_available: true,
      priority_tier: ordinaryMatch ? 3 : 1,
      similarity_score: ordinaryMatch ? 100 : 25,
      exact_material_match: ordinaryMatch,
      shared_material_keys: [],
      missing_subject_keys: [],
      additional_comparable_keys: additional,
      reason: ordinaryMatch
        ? "both_locations_have_no_mapped_material_influence"
        : "comparable_has_additional_mapped_influence",
    };
  }

  const subjectByCategory = categoryMap(subject);
  const comparableByCategory = categoryMap(comparable);
  const sharedCategories = [...subjectByCategory.keys()].filter((key) => comparableByCategory.has(key));
  const categoryCoverage = sharedCategories.length / Math.max(1, subjectByCategory.size);
  const unionSize = new Set([...subjectKeys, ...comparableKeys]).size;
  const keySimilarity = unionSize ? shared.length / unionSize : 1;
  const zoningSubject = new Set(subject.zoning_keys || []);
  const zoningComparable = new Set(comparable.zoning_keys || []);
  const zoningShared = [...zoningSubject].some((key) => zoningComparable.has(key));
  const similarityScore = Math.round(
    Math.min(100, (categoryCoverage * 60 + keySimilarity * 35 + (zoningShared ? 5 : 0)) * 10),
  ) / 10;
  const priorityTier = exactMaterialMatch
    ? 4
    : categoryCoverage === 1 && shared.length > 0
      ? 3
      : shared.length > 0
        ? 2
        : 1;

  return {
    data_available: true,
    priority_tier: priorityTier,
    similarity_score: similarityScore,
    exact_material_match: exactMaterialMatch,
    shared_material_keys: shared,
    missing_subject_keys: missing,
    additional_comparable_keys: additional,
    reason: exactMaterialMatch
      ? "same_mapped_material_influences"
      : shared.length
        ? "partially_matching_mapped_influences"
        : "mapped_influences_do_not_match",
  };
}

export function decorateAndRankByInfluence(
  rankedSales,
  subjectSignature,
  signatureForSale,
  { minimumCoverageRatio = 0.8 } = {},
) {
  const decorated = rankedSales.map((sale) => {
    const signature = signatureForSale(sale) || null;
    return {
      ...sale,
      influence_signature: signature,
      influence_similarity: comparePropertyInfluenceSignatures(
        subjectSignature,
        signature,
      ),
    };
  });
  const eligible = decorated.filter((sale) => sale.housingTypeCompatible !== false);
  const measured = eligible.filter((sale) => sale.influence_similarity.data_available);
  const coverageRatio = eligible.length ? measured.length / eligible.length : 0;
  const subjectAvailable = subjectSignature?.context_available === true;
  const applied = subjectAvailable && coverageRatio >= minimumCoverageRatio;

  if (applied) {
    decorated.sort((left, right) =>
      Number(right.influence_similarity.priority_tier || 0) -
        Number(left.influence_similarity.priority_tier || 0) ||
      Number(right.influence_similarity.similarity_score || 0) -
        Number(left.influence_similarity.similarity_score || 0) ||
      Number(right.comparableScore || 0) - Number(left.comparableScore || 0) ||
      (finiteNumber(left.distanceMiles) ?? Number.POSITIVE_INFINITY) -
        (finiteNumber(right.distanceMiles) ?? Number.POSITIVE_INFINITY),
    );
  }

  return {
    sales: decorated,
    policy: {
      methodology_version: 2,
      influence_priority_applied: applied,
      subject_context_available: subjectAvailable,
      eligible_sale_count: eligible.length,
      measured_sale_count: measured.length,
      coverage_ratio: Math.round(coverageRatio * 10_000) / 10_000,
      minimum_coverage_ratio: minimumCoverageRatio,
      material_influence_categories: MATERIAL_INFLUENCE_CATEGORIES,
      ordering: applied
        ? ["influence_priority_tier", "influence_similarity", "comparable_score", "distance"]
        : ["comparable_score", "distance"],
    },
  };
}
