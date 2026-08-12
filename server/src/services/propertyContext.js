import { validateCustomMarketGeometry } from "./marketConditions.js";
import {
  ensurePropertyContextSchema,
  getLatestPropertyComplexityAssessment,
  getPropertyContextSourceHealth,
  saveAutomaticPropertyComplexityAssessment,
  savePropertyComplexityReview as saveStoredPropertyComplexityReview,
} from "./propertyContextStore.js";
import {
  buildPropertyComplexityAssessment,
  normalizePropertyComplexityReview,
} from "../util/propertyComplexity.js";
import { buildPropertyInfluenceSignature } from "../util/propertyInfluence.js";
import {
  getPropertyInfluenceStatus,
  getZoningSourceRegistry,
  savePropertyInfluenceContext,
} from "./propertyInfluenceStore.js";

const FEET_PER_METER = 3.280839895;
const DEFAULT_CONTEXT_RADIUS_METERS = 3_218.688;

function finiteNumber(value) {
  if (typeof value === "string") {
    const normalized = value.replace(/[^0-9.-]/g, "");
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function reportedBoolean(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["true", "yes", "y", "1", "present", "pool"].includes(normalized)) return true;
  if (["false", "no", "n", "0", "none", "not present"].includes(normalized)) return false;
  return null;
}

function manualLandSiteArea(value) {
  const rows = Array.isArray(value?.land_detail) ? value.land_detail : [];
  const areas = rows.map((row) => positiveNumber(row?.area_sqft)).filter((area) => area !== null);
  return areas.length ? areas.reduce((sum, area) => sum + area, 0) : null;
}

function percentile(countAtOrBelow, count) {
  const denominator = Number(count || 0);
  if (denominator <= 0) return null;
  return Math.max(0, Math.min(100, (Number(countAtOrBelow || 0) / denominator) * 100));
}

function rounded(value, digits = 1) {
  const parsed = finiteNumber(value);
  if (parsed === null) return null;
  const factor = 10 ** digits;
  return Math.round(parsed * factor) / factor;
}

function normalizedRoadName(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/\b(NORTH|SOUTH|EAST|WEST|NORTHEAST|NORTHWEST|SOUTHEAST|SOUTHWEST)\b/g, " ")
    .replace(/\b(N|S|E|W|NE|NW|SE|SW)\b/g, " ")
    .replace(/\b(STREET|ST|ROAD|RD|DRIVE|DR|LANE|LN|AVENUE|AVE|BOULEVARD|BLVD|COURT|CT|CIRCLE|CIR|PLACE|PL|PARKWAY|PKWY|HIGHWAY|HWY|TRAIL|TRL|WAY)\b/g, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function roadMatchesAddress(roadName, address) {
  const road = normalizedRoadName(roadName);
  const street = normalizedRoadName(String(address || "").replace(/^\s*\d+[A-Z-]*\s+/, ""));
  return Boolean(road && street && (street.includes(road) || road.includes(street)));
}

function pointCoordinates(value) {
  const coordinates = value?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const longitude = finiteNumber(coordinates[0]);
  const latitude = finiteNumber(coordinates[1]);
  return longitude === null || latitude === null ? null : [longitude, latitude];
}

export function detectCornerLot(subjectPoint, roadFrontages = []) {
  const subject = pointCoordinates(subjectPoint);
  if (!subject || !Array.isArray(roadFrontages) || roadFrontages.length < 2) {
    return false;
  }
  const vectors = roadFrontages
    .map((road) => ({
      name: normalizedRoadName(road?.name),
      point: pointCoordinates(road?.closest_point),
    }))
    .filter((road) => road.name && road.point)
    .map((road) => ({
      ...road,
      angle: Math.atan2(
        road.point[1] - subject[1],
        road.point[0] - subject[0],
      ) * 180 / Math.PI,
    }));
  for (let left = 0; left < vectors.length; left += 1) {
    for (let right = left + 1; right < vectors.length; right += 1) {
      if (vectors[left].name === vectors[right].name) continue;
      const rawDifference = Math.abs(vectors[left].angle - vectors[right].angle);
      const difference = Math.min(rawDifference, 360 - rawDifference);
      if (difference >= 35 && difference <= 145) return true;
    }
  }
  return false;
}

export function determineInfluenceRelationship({
  subjectPoint,
  influencePoint,
  frontagePoint,
  cornerLot = false,
}) {
  if (cornerLot) return "adjacent";
  const subject = pointCoordinates(subjectPoint);
  const influence = pointCoordinates(influencePoint);
  const frontage = pointCoordinates(frontagePoint);
  if (!subject || !influence || !frontage) return "adjacent";
  const frontVector = [frontage[0] - subject[0], frontage[1] - subject[1]];
  const influenceVector = [influence[0] - subject[0], influence[1] - subject[1]];
  const frontMagnitude = Math.hypot(...frontVector);
  const influenceMagnitude = Math.hypot(...influenceVector);
  if (frontMagnitude === 0 || influenceMagnitude === 0) return "adjacent";
  const cosine = (
    frontVector[0] * influenceVector[0] + frontVector[1] * influenceVector[1]
  ) / (frontMagnitude * influenceMagnitude);
  if (cosine <= -0.35) return "rear";
  if (cosine >= 0.35) return "front";
  return "side";
}

function deriveAmenities(subject, additionalImprovements) {
  const rows = Array.isArray(additionalImprovements) ? additionalImprovements : [];
  const improvementLabels = rows
    .map((row) => String(row?.improvement_type || "").trim())
    .filter(Boolean);
  const amenities = [
    { key: "pool", label: "Pool", present: reportedBoolean(subject.pool) === true },
    { key: "spa", label: "Spa", present: reportedBoolean(subject.spa) === true },
    { key: "sauna", label: "Sauna", present: reportedBoolean(subject.sauna) === true },
    { key: "basement", label: "Basement", present: reportedBoolean(subject.basement) === true },
    { key: "multiple_fireplaces", label: "Multiple fireplaces", present: Number(subject.fireplaces || 0) >= 2 },
    { key: "wet_bar", label: "Wet bar", present: Number(subject.wetbars || 0) > 0 },
    { key: "sprinkler", label: "Sprinkler system", present: reportedBoolean(subject.sprinkler) === true },
  ];
  for (const [index, label] of improvementLabels.entries()) {
    amenities.push({
      key: `additional_${index + 1}`,
      label,
      present: true,
    });
  }
  return amenities;
}

async function loadSubject(pool, accountId, assignmentFileId) {
  const { rows } = await pool.query(
    `SELECT
       account.account_id,
       account.address,
       account.city,
       account.county,
       account.postal_code,
       location.latitude,
       location.longitude,
       improvement.living_area_sqft,
       improvement.total_living_area,
       improvement.total_area_sqft,
       improvement.year_built,
       improvement.effective_year_built,
       improvement.actual_age,
       improvement.pool,
       improvement.spa,
       improvement.sauna,
       improvement.basement,
       improvement.fireplaces,
       improvement.wetbars,
       improvement.sprinkler,
       improvement.number_units,
       housing.housing_type,
       housing.attachment_type,
       land.site_area_sqft,
       additional.rows AS additional_improvements,
       manual_property.attribute_value AS manual_property,
       manual_land.attribute_value AS manual_land,
       assignment.assignment_details
     FROM core.accounts account
     LEFT JOIN core.account_locations location
       ON location.account_id = account.account_id
     LEFT JOIN LATERAL (
       SELECT * FROM core.primary_improvements
       WHERE account_id = account.account_id
       LIMIT 1
     ) improvement ON TRUE
     LEFT JOIN core.v_account_housing_profiles housing
       ON housing.account_id = account.account_id
     LEFT JOIN LATERAL (
       SELECT SUM(area_sqft)::numeric AS site_area_sqft
       FROM core.land_detail
       WHERE account_id = account.account_id
         AND tax_year = (SELECT MAX(tax_year) FROM core.land_detail WHERE account_id = account.account_id)
     ) land ON TRUE
     LEFT JOIN LATERAL (
       SELECT COALESCE(jsonb_agg(jsonb_build_object(
         'improvement_type', secondary.sec_imp_type,
         'area_sqft', secondary.sec_imp_sqft,
         'year_built', secondary.sec_imp_year_built
       ) ORDER BY secondary.id), '[]'::jsonb) AS rows
       FROM core.secondary_improvements secondary
       WHERE secondary.account_id = account.account_id
     ) additional ON TRUE
     LEFT JOIN app.property_attribute_manual_values manual_property
       ON manual_property.account_id = account.account_id
      AND manual_property.attribute_key = 'report.property_characteristics'
     LEFT JOIN app.property_attribute_manual_values manual_land
       ON manual_land.account_id = account.account_id
      AND manual_land.attribute_key = 'report.land_details'
     LEFT JOIN LATERAL (
       SELECT file.assignment_details
       FROM app.assignment_files file
       WHERE file.account_id = account.account_id
         AND ($2::bigint IS NULL OR file.id = $2)
       ORDER BY (file.id = $2) DESC, file.updated_at DESC, file.id DESC
       LIMIT 1
     ) assignment ON TRUE
     WHERE account.account_id = $1`,
    [accountId, assignmentFileId || null],
  );
  if (!rows.length) throw new Error("account_not_found");
  const row = rows[0];
  const manualImprovement = row.manual_property?.main_improvement || {};
  const manualHousing = row.manual_property?.housing_profile || {};
  const currentYear = new Date().getFullYear();
  const yearBuilt = positiveNumber(
    manualImprovement.effective_year_built ??
    manualImprovement.year_built ??
    row.effective_year_built ??
    row.year_built,
  );
  const actualAge = positiveNumber(manualImprovement.actual_age ?? row.actual_age) ?? (
    yearBuilt ? Math.max(0, currentYear - yearBuilt) : null
  );
  const subject = {
    account_id: row.account_id,
    address: row.address,
    city: row.city,
    county: row.county,
    postal_code: row.postal_code,
    latitude: finiteNumber(row.latitude),
    longitude: finiteNumber(row.longitude),
    gross_living_area_sqft: positiveNumber(
      manualImprovement.living_area_sqft ??
      manualImprovement.total_living_area ??
      row.living_area_sqft ??
      row.total_living_area ??
      row.total_area_sqft,
    ),
    year_built: yearBuilt,
    actual_age: actualAge,
    site_area_sqft: manualLandSiteArea(row.manual_land) ?? positiveNumber(row.site_area_sqft),
    housing_type: manualHousing.housing_type || row.housing_type || null,
    attachment_type: manualHousing.attachment_type || row.attachment_type || null,
    pool: manualImprovement.pool ?? row.pool,
    spa: manualImprovement.spa ?? row.spa,
    sauna: manualImprovement.sauna ?? row.sauna,
    basement: manualImprovement.basement ?? row.basement,
    fireplaces: manualImprovement.fireplaces ?? row.fireplaces,
    wetbars: manualImprovement.wetbars ?? row.wetbars,
    sprinkler: manualImprovement.sprinkler ?? row.sprinkler,
    number_units: manualImprovement.number_units ?? row.number_units,
    assignment_details: row.assignment_details || {},
  };
  subject.amenities = deriveAmenities(subject, row.additional_improvements);
  return subject;
}

async function loadPeerStatistics(pool, subject, customGeometry, centerPoint) {
  const longitude = finiteNumber(centerPoint?.longitude ?? subject.longitude);
  const latitude = finiteNumber(centerPoint?.latitude ?? subject.latitude);
  if (longitude === null || latitude === null) {
    return {
      peer_count: 0,
      gla: { count: 0, percentile: null, median: null },
      age: { count: 0, percentile: null, median: null },
      site_area: { count: 0, percentile: null, median: null },
      pool_prevalence_percent: null,
      context: customGeometry ? "appraiser_defined_area" : "two_mile_radius",
    };
  }
  const boundary = customGeometry ? JSON.stringify(customGeometry) : null;
  const { rows } = await pool.query(
    `WITH context AS (
       SELECT
         ST_SetSRID(ST_MakePoint($2, $3), 4326) AS center,
         CASE WHEN $4::text IS NULL THEN NULL
              ELSE ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($4), 4326))
         END AS boundary
     ), peers AS (
       SELECT
         COALESCE(improvement.living_area_sqft, improvement.total_living_area,
                  improvement.total_area_sqft)::numeric AS gla,
         COALESCE(
           improvement.actual_age,
           EXTRACT(YEAR FROM CURRENT_DATE) - COALESCE(improvement.effective_year_built, improvement.year_built)
         )::numeric AS age,
         land.site_area_sqft::numeric AS site_area,
         CASE WHEN lower(COALESCE(improvement.pool::text, '')) IN ('true','t','yes','y','1','present','pool')
              THEN 1 ELSE 0 END AS has_pool
       FROM core.accounts account
       JOIN core.account_locations location ON location.account_id = account.account_id
       LEFT JOIN LATERAL (
         SELECT * FROM core.primary_improvements
         WHERE account_id = account.account_id
         LIMIT 1
       ) improvement ON TRUE
       LEFT JOIN LATERAL (
         SELECT SUM(area_sqft)::numeric AS site_area_sqft
         FROM core.land_detail
         WHERE account_id = account.account_id
           AND tax_year = (SELECT MAX(tax_year) FROM core.land_detail WHERE account_id = account.account_id)
       ) land ON TRUE
       CROSS JOIN context
       WHERE account.account_id <> $1
         AND location.latitude IS NOT NULL
         AND location.longitude IS NOT NULL
         AND COALESCE(improvement.living_area_sqft, improvement.total_living_area,
                      improvement.total_area_sqft) > 0
         AND COALESCE(improvement.number_units, 1) <= 1
         AND CASE WHEN context.boundary IS NULL
              THEN ST_DWithin(
                ST_SetSRID(ST_MakePoint(location.longitude, location.latitude),4326)::geography,
                context.center::geography,
                $8
              )
              ELSE ST_Covers(
                context.boundary,
                ST_SetSRID(ST_MakePoint(location.longitude, location.latitude),4326)
              )
             END
     )
     SELECT
       COUNT(*)::integer AS peer_count,
       COUNT(gla)::integer AS gla_count,
       COUNT(*) FILTER (WHERE gla <= $5)::integer AS gla_at_or_below,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY gla) FILTER (WHERE gla IS NOT NULL) AS gla_median,
       COUNT(age)::integer AS age_count,
       COUNT(*) FILTER (WHERE age <= $6)::integer AS age_at_or_below,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY age) FILTER (WHERE age IS NOT NULL) AS age_median,
       COUNT(site_area)::integer AS site_count,
       COUNT(*) FILTER (WHERE site_area <= $7)::integer AS site_at_or_below,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY site_area) FILTER (WHERE site_area IS NOT NULL) AS site_median,
       AVG(has_pool) * 100 AS pool_prevalence_percent
     FROM peers`,
    [
      subject.account_id,
      longitude,
      latitude,
      boundary,
      subject.gross_living_area_sqft,
      subject.actual_age,
      subject.site_area_sqft,
      DEFAULT_CONTEXT_RADIUS_METERS,
    ],
  );
  const row = rows[0] || {};
  return {
    peer_count: Number(row.peer_count || 0),
    gla: {
      count: Number(row.gla_count || 0),
      percentile: percentile(row.gla_at_or_below, row.gla_count),
      median: rounded(row.gla_median, 0),
    },
    age: {
      count: Number(row.age_count || 0),
      percentile: percentile(row.age_at_or_below, row.age_count),
      median: rounded(row.age_median, 0),
    },
    site_area: {
      count: Number(row.site_count || 0),
      percentile: percentile(row.site_at_or_below, row.site_count),
      median: rounded(row.site_median, 0),
    },
    pool_prevalence_percent: rounded(row.pool_prevalence_percent, 1),
    context: customGeometry ? "appraiser_defined_area" : "two_mile_radius",
    radius_miles: customGeometry ? null : 2,
  };
}

export async function loadSpatialContext(pool, subject, customGeometry) {
  const longitude = finiteNumber(subject.longitude);
  const latitude = finiteNumber(subject.latitude);
  const { rows: parcelRows } = await pool.query(
    `SELECT
       parcel.object_id,
       parcel.account_id,
       parcel.low_parcel_id,
       parcel.site_address,
       parcel.land_use_category,
       parcel.parcel_area_sqft,
       CASE WHEN ST_Perimeter(parcel.geom::geography) > 0
            THEN 4 * pi() * ST_Area(parcel.geom::geography) /
                 power(ST_Perimeter(parcel.geom::geography), 2)
            ELSE NULL END AS compactness,
       ST_AsGeoJSON(ST_PointOnSurface(parcel.geom))::jsonb AS subject_point,
       CASE
         WHEN parcel.account_id = $1 OR parcel.low_parcel_id = $1 THEN 'account_id'
         ELSE 'coordinate_containment'
       END AS match_method
     FROM gis.dcad_parcels parcel
     WHERE parcel.account_id = $1
        OR parcel.low_parcel_id = $1
        OR ($2::double precision IS NOT NULL AND $3::double precision IS NOT NULL AND
            ST_Covers(parcel.geom, ST_SetSRID(ST_MakePoint($2,$3),4326)))
     ORDER BY
       (parcel.account_id = $1 OR parcel.low_parcel_id = $1) DESC,
       parcel.parcel_area_sqft ASC NULLS LAST
     LIMIT 1`,
    [subject.account_id, longitude, latitude],
  );
  const parcel = parcelRows[0];
  if (!parcel) {
    return {
      parcel_available: false,
      parcel_match_method: null,
      subject_site_area_sqft: subject.site_area_sqft,
      site_percentile: null,
      site_comparison_count: 0,
      parcel_compactness: null,
      corner_lot: false,
      road_frontage_count: 0,
      road_frontages: [],
      nearest_major_road: null,
      adjacent_influences: [],
      nearby_influences: [],
      subject_point: longitude !== null && latitude !== null
        ? { type: "Point", coordinates: [longitude, latitude] }
        : null,
    };
  }

  const boundary = customGeometry ? JSON.stringify(customGeometry) : null;
  const { rows: siteRows } = await pool.query(
    `WITH subject AS (
       SELECT geom, land_use_category, parcel_area_sqft
       FROM gis.dcad_parcels WHERE object_id = $1
     ), peers AS (
       SELECT parcel.parcel_area_sqft
       FROM gis.dcad_parcels parcel
       CROSS JOIN subject
       WHERE parcel.object_id <> $1
         AND parcel.land_use_category = subject.land_use_category
         AND parcel.parcel_area_sqft > 0
         AND CASE WHEN $2::text IS NULL
              THEN ST_DWithin(parcel.geom::geography, subject.geom::geography, $3)
              ELSE ST_Intersects(
                parcel.geom,
                ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($2),4326))
              )
             END
     )
     SELECT
       COUNT(*)::integer AS peer_count,
       COUNT(*) FILTER (WHERE parcel_area_sqft <= (SELECT parcel_area_sqft FROM subject))::integer AS at_or_below,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY parcel_area_sqft) AS median_area
     FROM peers`,
    [parcel.object_id, boundary, DEFAULT_CONTEXT_RADIUS_METERS],
  );
  const site = siteRows[0] || {};

  const { rows: influenceRows } = await pool.query(
    `WITH subject AS (
       SELECT geom, ST_PointOnSurface(geom) AS center
       FROM gis.dcad_parcels WHERE object_id = $1
     )
     SELECT
       parcel.object_id,
       parcel.account_id,
       parcel.site_address,
       parcel.land_use_category AS category,
       CASE parcel.land_use_category
         WHEN 'commercial' THEN 'Commercial'
         WHEN 'multifamily' THEN 'Multi-Family'
         ELSE initcap(replace(parcel.land_use_category, '_', ' '))
       END AS category_label,
       parcel.use_description,
       parcel.property_description,
       ST_Distance(subject.geom::geography, parcel.geom::geography) * $3 AS distance_feet,
       ST_DWithin(subject.geom::geography, parcel.geom::geography, 2) AS directly_adjacent,
       ST_AsGeoJSON(ST_PointOnSurface(parcel.geom))::jsonb AS influence_point
     FROM gis.dcad_parcels parcel
     CROSS JOIN subject
     WHERE parcel.object_id <> $1
       AND parcel.land_use_category IN ('commercial', 'multifamily')
       AND ST_DWithin(subject.geom::geography, parcel.geom::geography, $2)
     ORDER BY ST_Distance(subject.geom::geography, parcel.geom::geography), parcel.object_id
     LIMIT 25`,
    [parcel.object_id, 500 / FEET_PER_METER, FEET_PER_METER],
  );

  const { rows: roadRows } = await pool.query(
    `WITH subject AS (
       SELECT geom FROM gis.dcad_parcels WHERE object_id = $1
     )
     SELECT
       road.source_layer,
       road.source_object_id,
       road.name,
       road.base_name,
       road.mtfcc,
       road.road_class,
       ST_Distance(subject.geom::geography, road.geom::geography) * $3 AS distance_feet,
       ST_AsGeoJSON(ST_ClosestPoint(road.geom, ST_PointOnSurface(subject.geom)))::jsonb AS closest_point
     FROM gis.road_segments road
     CROSS JOIN subject
     WHERE (
       (road.road_class = 'railroad' AND
        ST_DWithin(subject.geom::geography, road.geom::geography, $4))
       OR
       (road.road_class <> 'railroad' AND
        ST_DWithin(subject.geom::geography, road.geom::geography, $2))
     )
     ORDER BY ST_Distance(subject.geom::geography, road.geom::geography), road.road_class, road.name
     LIMIT 100`,
    [parcel.object_id, 500 / FEET_PER_METER, FEET_PER_METER, 1_000 / FEET_PER_METER],
  );
  const namedFrontages = [...new Map(
    roadRows
      .filter((road) => road.road_class !== "railroad" && road.name && Number(road.distance_feet) <= 85)
      .map((road) => [normalizedRoadName(road.name), road]),
  ).values()];
  const cornerLot = detectCornerLot(parcel.subject_point, namedFrontages);
  const frontageRoad = roadRows.find(
    (road) => road.road_class !== "railroad" && roadMatchesAddress(road.name, subject.address),
  ) || roadRows.find((road) => road.road_class !== "railroad") || null;
  const influences = influenceRows.map((influence) => ({
    ...influence,
    distance_feet: rounded(influence.distance_feet, 0),
    relationship: determineInfluenceRelationship({
      subjectPoint: parcel.subject_point,
      influencePoint: influence.influence_point,
      frontagePoint: frontageRoad?.closest_point,
      cornerLot,
    }),
  }));
  const nearestMajorRoad = roadRows.find((road) => ["primary", "secondary"].includes(road.road_class));
  const nearestRailroad = roadRows.find((road) => road.road_class === "railroad");
  const { rows: zoningRows } = await pool.query(
    `WITH subject AS (
       SELECT geom, ST_PointOnSurface(geom) AS center
       FROM gis.dcad_parcels WHERE object_id = $1
     )
     SELECT
       zoning.provider_key,
       registry.provider_label,
       registry.provider_type,
       registry.priority,
       zoning.jurisdiction,
       zoning.zoning_code,
       zoning.zoning_description,
       zoning.generalized_use,
       zoning.overlays,
       zoning.source_updated_at,
       zoning.synced_at
     FROM gis.zoning_districts zoning
     JOIN gis.zoning_source_registry registry
       ON registry.provider_key = zoning.provider_key
     CROSS JOIN subject
     WHERE ST_Covers(zoning.geom, subject.center)
     ORDER BY registry.priority DESC,
              (registry.provider_type = 'official_municipal') DESC,
              zoning.source_updated_at DESC NULLS LAST,
              zoning.synced_at DESC
     LIMIT 1`,
    [parcel.object_id],
  );
  const { rows: floodRows } = await pool.query(
    `WITH subject AS (
       SELECT geom, ST_PointOnSurface(geom) AS center
       FROM gis.dcad_parcels WHERE object_id = $1
     )
     SELECT source_key, source_record_id, flood_zone, zone_subtype,
            special_flood_hazard, static_base_flood_elevation,
            source_updated_at, synced_at
     FROM gis.flood_hazard_areas flood
     CROSS JOIN subject
     WHERE ST_Intersects(flood.geom, subject.geom)
     ORDER BY flood.special_flood_hazard DESC NULLS LAST,
              ST_Area(ST_Intersection(flood.geom, subject.geom)::geography) DESC,
              flood.synced_at DESC
     LIMIT 1`,
    [parcel.object_id],
  );
  const subjectPoint = pointCoordinates(parcel.subject_point);
  return {
    parcel_available: true,
    parcel_object_id: Number(parcel.object_id),
    parcel_match_method: parcel.match_method,
    subject_site_area_sqft: rounded(parcel.parcel_area_sqft, 0),
    site_percentile: percentile(site.at_or_below, site.peer_count),
    site_median_area_sqft: rounded(site.median_area, 0),
    site_comparison_count: Number(site.peer_count || 0),
    parcel_compactness: rounded(parcel.compactness, 3),
    corner_lot: cornerLot,
    road_frontage_count: namedFrontages.length,
    road_frontages: namedFrontages.map((road) => road.name),
    frontage_road: frontageRoad ? {
      name: frontageRoad.name,
      road_class: frontageRoad.road_class,
      distance_feet: rounded(frontageRoad.distance_feet, 0),
    } : null,
    nearest_major_road: nearestMajorRoad ? {
      name: nearestMajorRoad.name,
      road_class: nearestMajorRoad.road_class,
      mtfcc: nearestMajorRoad.mtfcc,
      distance_feet: rounded(nearestMajorRoad.distance_feet, 0),
    } : null,
    nearest_railroad: nearestRailroad ? {
      name: nearestRailroad.name,
      mtfcc: nearestRailroad.mtfcc,
      distance_feet: rounded(nearestRailroad.distance_feet, 0),
    } : null,
    zoning_context: zoningRows[0] || null,
    flood_context: floodRows[0] || null,
    adjacent_influences: influences.filter((influence) => influence.directly_adjacent),
    nearby_influences: influences.filter((influence) => !influence.directly_adjacent),
    subject_point: parcel.subject_point,
    center: subjectPoint ? { longitude: subjectPoint[0], latitude: subjectPoint[1] } : null,
  };
}

export async function analyzePropertyContext(pool, {
  accountId,
  assignmentFileId = null,
  customGeometry = null,
  geography = null,
} = {}) {
  const normalizedAccountId = String(accountId || "").trim();
  if (!/^[0-9A-Za-z]{17}$/.test(normalizedAccountId)) throw new Error("invalid_account_id");
  await ensurePropertyContextSchema(pool);
  const boundary = customGeometry ? validateCustomMarketGeometry(customGeometry) : null;
  const subject = await loadSubject(pool, normalizedAccountId, assignmentFileId);
  const sourceHealth = await getPropertyContextSourceHealth(pool);
  const spatialContext = await loadSpatialContext(pool, subject, boundary);
  const influenceSignature = buildPropertyInfluenceSignature(spatialContext);
  await savePropertyInfluenceContext(pool, {
    accountId: normalizedAccountId,
    spatialContext,
    influenceSignature,
    sourceHealth,
  });
  const peerStatistics = await loadPeerStatistics(
    pool,
    subject,
    boundary,
    spatialContext.center,
  );
  const selectedGeography = geography || subject.assignment_details?.neighborhood_location_type || "suburban";
  const assessment = buildPropertyComplexityAssessment({
    subject: {
      account_id: subject.account_id,
      address: subject.address,
      gross_living_area_sqft: subject.gross_living_area_sqft,
      year_built: subject.year_built,
      actual_age: subject.actual_age,
      site_area_sqft: subject.site_area_sqft ?? spatialContext.subject_site_area_sqft,
      housing_type: subject.housing_type,
      attachment_type: subject.attachment_type,
      amenities: subject.amenities,
    },
    peerStatistics,
    spatialContext,
    sourceHealth,
    geography: selectedGeography,
  });
  return saveAutomaticPropertyComplexityAssessment(pool, {
    accountId: normalizedAccountId,
    assignmentFileId,
    assessment,
  });
}

export async function refreshStoredPropertyInfluenceContext(pool, {
  accountId,
} = {}) {
  const normalizedAccountId = String(accountId || "").trim();
  if (!/^[0-9A-Za-z]{17}$/.test(normalizedAccountId)) {
    throw new Error("invalid_account_id");
  }
  await ensurePropertyContextSchema(pool);
  const subject = await loadSubject(pool, normalizedAccountId, null);
  const sourceHealth = await getPropertyContextSourceHealth(pool);
  const spatialContext = await loadSpatialContext(pool, subject, null);
  const influenceSignature = buildPropertyInfluenceSignature(spatialContext);
  return savePropertyInfluenceContext(pool, {
    accountId: normalizedAccountId,
    spatialContext,
    influenceSignature,
    sourceHealth,
  });
}

export async function getStoredPropertyContext(pool, {
  accountId,
  assignmentFileId = null,
} = {}) {
  await ensurePropertyContextSchema(pool);
  return getLatestPropertyComplexityAssessment(pool, accountId, { assignmentFileId });
}

export async function savePropertyContextReview(pool, {
  accountId,
  assignmentFileId = null,
  review,
} = {}) {
  await ensurePropertyContextSchema(pool);
  const normalized = normalizePropertyComplexityReview(review);
  const result = await saveStoredPropertyComplexityReview(pool, {
    accountId,
    assignmentFileId,
    complexity: normalized.complexity,
    notes: normalized.notes,
    reviewer: normalized.reviewer,
  });
  if (!result) throw new Error("property_complexity_assessment_required");
  return result;
}

export async function getPropertyContextStatus(pool) {
  await ensurePropertyContextSchema(pool);
  const [sources, influenceStatus, zoningProviders] = await Promise.all([
    getPropertyContextSourceHealth(pool),
    getPropertyInfluenceStatus(pool),
    getZoningSourceRegistry(pool),
  ]);
  return {
    ok: true,
    offline_first: true,
    external_services_required_at_request_time: false,
    sources,
    usable_source_count: sources.filter((source) => source.usable).length,
    stale_source_count: sources.filter((source) => source.serving_stale_data).length,
    unavailable_source_count: sources.filter((source) => !source.usable).length,
    influence_context: influenceStatus,
    zoning_source_hierarchy: zoningProviders,
    checked_at: new Date().toISOString(),
  };
}

export function propertyContextErrorStatus(message) {
  if (["invalid_account_id", "invalid_property_complexity"].includes(message)) return 400;
  if (message === "account_not_found") return 404;
  if (message === "property_complexity_assessment_required") return 409;
  if (String(message).startsWith("custom_area_")) return 400;
  return 500;
}

