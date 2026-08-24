import { createHash } from "node:crypto";

import { validateCustomMarketGeometry } from "./marketConditions.js";
import { esriGeometryToGeoJson } from "../util/parcelArea.js";
import {
  ensurePropertyContextSchema,
  getPropertyContextSourceHealth,
  readBoundaryAnalysisCache,
  writeBoundaryAnalysisCache,
} from "./propertyContextStore.js";

export const DCAD_LAND_USE_QUERY_URL =
  "https://maps.dcad.org/prdwa/rest/services/Property/ParcelQuery/MapServer/4/query";

export const LAND_USE_CATEGORIES = Object.freeze([
  { key: "one_unit", label: "One-Unit" },
  { key: "two_to_four_unit", label: "2-4 Unit" },
  { key: "multifamily", label: "Multi-Family" },
  { key: "commercial", label: "Commercial" },
  { key: "other_vacant", label: "Other / Vacant Land" },
]);

const CATEGORY_LABEL = new Map(LAND_USE_CATEGORIES.map((item) => [item.key, item.label]));
const DCAD_FIELDS = [
  "OBJECTID",
  "LOWPARCELID",
  "PARCELID",
  "SITEADDRESS",
  "USECD",
  "USEDSCRP",
  "CLASSCD",
  "CLASSDSCRP",
  "PRPRTYDSCRP",
  "CNVYNAME",
  "RESSTRTYP",
  "BLDGAREA",
  "RESFLRAREA",
  "RESYRBLT",
  "LNDVALUE",
  "IMPVALUE",
  "CNTASSDVAL",
  "LASTUPDATE",
].join(",");
const MAX_PARCELS = 25_000;
const PARCEL_BATCH_SIZE = 2_000;
const PARCEL_FETCH_CONCURRENCY = 3;
const ANALYSIS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const ANALYSIS_CACHE_MAX_ENTRIES = 50;
const SQ_FEET_PER_ACRE = 43_560;
const VACANT_CLASS_CODES = new Set(["7", "8", "9", "10", "11", "39"]);
const IMPROVED_CLASS_CODES = new Set(["1", "2", "3", "4", "5", "6", "17", "18", "35", "40"]);

function normalizedDescription(...values) {
  return values
    .map((value) => String(value || "").trim().toUpperCase())
    .filter(Boolean)
    .join(" | ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classification(category, confidence, reviewReason = null) {
  return {
    category,
    category_label: CATEGORY_LABEL.get(category),
    confidence,
    requires_review: Boolean(reviewReason),
    review_reason: reviewReason,
  };
}

export function classifyDcadLandUse(attributes = {}) {
  const classCode = String(attributes.CLASSCD ?? attributes.class_code ?? "").trim();
  const useDescription = String(
    attributes.USEDSCRP ?? attributes.use_description ?? "",
  ).trim();
  const propertyDescription = String(
    attributes.PRPRTYDSCRP ?? attributes.property_description ?? "",
  ).trim();
  const classDescription = String(
    attributes.CLASSDSCRP ?? attributes.class_description ?? "",
  ).trim();
  const description = normalizedDescription(
    classDescription,
    useDescription,
    attributes.CNVYNAME,
    propertyDescription,
  );

  if (["7", "8", "9", "10", "11", "39"].includes(classCode)) {
    return classification("other_vacant", "high");
  }
  if (classCode === "6") return classification("two_to_four_unit", "high");
  if (["5", "35"].includes(classCode)) return classification("multifamily", "high");
  if (["1", "2", "3", "4"].includes(classCode)) {
    return classification("one_unit", "high");
  }
  if (["17", "18"].includes(classCode)) return classification("commercial", "high");
  if (["22", "23", "24", "25", "26", "28", "29", "41", "49"].includes(classCode)) {
    return classification("other_vacant", "high");
  }
  if (classCode === "40") {
    return classification(
      "one_unit",
      "medium",
      "Residential improvement inventory was provisionally treated as one-unit housing.",
    );
  }

  if (/\b(VACANT|UNIMPROVED|AGRICULTUR|FARM|RANCH LAND|OPEN SPACE)\b/.test(description)) {
    return classification("other_vacant", "high");
  }
  if (/\b(DUPLEX|TRIPLEX|FOURPLEX|TWO FAMILY|THREE FAMILY|FOUR FAMILY|2 TO 4 UNIT|2 4 UNIT)\b/.test(description)) {
    return classification("two_to_four_unit", "high");
  }
  if (/\b(APARTMENT|MULTI FAMILY|MULTIFAMILY|FIVE OR MORE|5 OR MORE|MOBILE HOME PARK)\b/.test(description)) {
    return classification("multifamily", "high");
  }
  if (/\b(CONDOMINIUMS?|CONDOS?)\b/.test(description)) {
    return classification(
      "one_unit",
      "medium",
      "Condominium land was provisionally included with one-unit housing.",
    );
  }
  if (/\b(SINGLE FAMILY|SINGLE RESIDENCE|ONE FAMILY|TOWNHOUSE|TOWNHOME|PATIO HOME|MOBILE HOME)\b/.test(description)) {
    return classification("one_unit", "high");
  }
  if (/\b(MIXED USE|MIXED DEVELOPMENT)\b/.test(description)) {
    return classification(
      "commercial",
      "low",
      "Mixed-use parcel was provisionally included with commercial land.",
    );
  }
  if (/\b(COMMERCIAL|RETAIL|OFFICE|INDUSTRIAL|WAREHOUSE|HOTEL|MOTEL|RESTAURANT|SHOPPING|BANK|MEDICAL|HOSPITAL|NURSING|DAY CARE|THEATER|SERVICE STATION|AUTO SALES|CAR WASH|MINI STORAGE|SELF STORAGE)\b/.test(description)) {
    return classification("commercial", "high");
  }
  if (/\b(CHURCH|RELIGIOUS|SCHOOL|COLLEGE|UNIVERSITY|GOVERNMENT|PUBLIC|UTILITY|COMMON AREA|PARK|GREENBELT|RIGHT OF WAY|RAILROAD|AIRPORT|CEMETERY|CLUBHOUSE|RECREATION)\b/.test(description)) {
    return classification("other_vacant", "high");
  }
  if (/\bRESIDENTIAL\b/.test(description)) {
    return classification(
      "one_unit",
      "low",
      "Generic residential use was provisionally treated as one-unit housing.",
    );
  }
  const improvementValue = Number(attributes.IMPVALUE ?? attributes.improvement_value);
  if (Number.isFinite(improvementValue) && improvementValue === 0) {
    return classification(
      "other_vacant",
      "medium",
      "No recognized use was reported; zero improvement value suggests vacant or other land.",
    );
  }
  return classification(
    "other_vacant",
    "low",
    "DCAD use description did not match a recognized land-use category.",
  );
}

export function isDcadParcelBuiltUp(attributes = {}) {
  const classCode = String(attributes.CLASSCD ?? attributes.class_code ?? "").trim();
  if (VACANT_CLASS_CODES.has(classCode)) return false;
  if (IMPROVED_CLASS_CODES.has(classCode)) return true;
  const improvementValue = Number(attributes.IMPVALUE ?? attributes.improvement_value);
  return Number.isFinite(improvementValue) && improvementValue > 0;
}

export function classifyBuiltUpBand(value) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  if (percent > 75) return { key: "over_75", label: "Over 75%" };
  if (percent >= 25) return { key: "25_to_75", label: "25-75%" };
  return { key: "under_25", label: "Under 25%" };
}

export function allocateLandUsePercentages(categoryAreas) {
  const total = LAND_USE_CATEGORIES.reduce(
    (sum, category) => sum + Math.max(0, Number(categoryAreas[category.key]) || 0),
    0,
  );
  if (total <= 0) return Object.fromEntries(LAND_USE_CATEGORIES.map(({ key }) => [key, 0]));
  const allocations = LAND_USE_CATEGORIES.map(({ key }, index) => {
    const exactTenths = ((Math.max(0, Number(categoryAreas[key]) || 0) / total) * 1000);
    return {
      key,
      index,
      tenths: Math.floor(exactTenths),
      remainder: exactTenths - Math.floor(exactTenths),
    };
  });
  let remaining = 1000 - allocations.reduce((sum, item) => sum + item.tenths, 0);
  allocations
    .slice()
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index)
    .forEach((item) => {
      if (remaining <= 0) return;
      allocations[item.index].tenths += 1;
      remaining -= 1;
    });
  return Object.fromEntries(allocations.map(({ key, tenths }) => [key, tenths / 10]));
}

function arcGisBody(values) {
  return new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)]));
}

async function arcGisRequest(body, fetchImpl) {
  const response = await fetchImpl(DCAD_LAND_USE_QUERY_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`dcad_land_use_query_http_${response.status}`);
  const payload = await response.json();
  if (payload?.error) {
    throw new Error(
      `dcad_land_use_query_${payload.error.code || "error"}: ${payload.error.message || "unknown error"}`,
    );
  }
  return payload;
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function normalizeParcelFeature(feature, index) {
  const properties = feature?.properties || feature?.attributes || {};
  const geometry = feature?.geometry?.rings
    ? esriGeometryToGeoJson(feature.geometry)
    : feature?.geometry;
  if (!geometry || !["Polygon", "MultiPolygon"].includes(geometry.type)) return null;
  return {
    source_index: index,
    object_id: properties.OBJECTID ?? feature?.id ?? null,
    account_id: String(properties.PARCELID || properties.LOWPARCELID || "").trim() || null,
    site_address: String(properties.SITEADDRESS || "").trim() || null,
    use_description: String(properties.USEDSCRP || "").trim() || null,
    use_code: String(properties.USECD || "").trim() || null,
    class_code: String(properties.CLASSCD || "").trim() || null,
    class_description: String(properties.CLASSDSCRP || "").trim() || null,
    property_description: String(properties.PRPRTYDSCRP || "").trim() || null,
    source_updated_at: Number.isFinite(Number(properties.LASTUPDATE))
      ? new Date(Number(properties.LASTUPDATE)).toISOString()
      : null,
    attributes: properties,
    geometry,
  };
}

export async function fetchDcadLandUseParcels(customGeometry, { fetchImpl = fetch } = {}) {
  const geometry = validateCustomMarketGeometry(customGeometry);
  const esriGeometry = JSON.stringify({
    rings: geometry.coordinates,
    spatialReference: { wkid: 4326 },
  });
  const idPayload = await arcGisRequest(arcGisBody({
    where: "1=1",
    geometry: esriGeometry,
    geometryType: "esriGeometryPolygon",
    spatialRel: "esriSpatialRelIntersects",
    inSR: "4326",
    returnIdsOnly: "true",
    f: "json",
  }), fetchImpl);
  const objectIds = [...new Set((idPayload.objectIds || []).map(Number).filter(Number.isFinite))];
  if (objectIds.length > MAX_PARCELS) throw new Error("land_use_area_too_many_parcels");
  if (!objectIds.length) return [];

  const featureBatches = await mapWithConcurrency(
    chunks(objectIds, PARCEL_BATCH_SIZE),
    PARCEL_FETCH_CONCURRENCY,
    async (objectIdBatch) => {
      let payload = await arcGisRequest(arcGisBody({
        objectIds: objectIdBatch.join(","),
        outFields: DCAD_FIELDS,
        returnGeometry: "true",
        outSR: "4326",
        geometryPrecision: "7",
        f: "geojson",
      }), fetchImpl);
      if (!Array.isArray(payload.features)) {
        payload = await arcGisRequest(arcGisBody({
          objectIds: objectIdBatch.join(","),
          outFields: DCAD_FIELDS,
          returnGeometry: "true",
          outSR: "4326",
          geometryPrecision: "7",
          f: "json",
        }), fetchImpl);
      }
      return payload.features || [];
    },
  );
  const features = featureBatches.flat();
  return features
    .map((feature, index) => normalizeParcelFeature(feature, index))
    .filter(Boolean);
}

async function calculateClippedParcelMetrics(pool, boundary, classifiedParcels) {
  const payload = classifiedParcels.map((parcel, sourceIndex) => ({
    source_index: sourceIndex,
    account_id: parcel.account_id,
    category: parcel.classification.category,
    built_up: parcel.built_up,
    geometry: parcel.geometry,
  }));
  const { rows } = await pool.query(
    `WITH boundary AS (
       SELECT ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)) AS geom
     ), source_features AS (
       SELECT
         (item->>'source_index')::integer AS source_index,
         NULLIF(item->>'account_id', '') AS account_id,
         item->>'category' AS category,
         COALESCE((item->>'built_up')::boolean, false) AS built_up,
         ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON((item->'geometry')::text), 4326)) AS geom
       FROM jsonb_array_elements($2::jsonb) item
     ), source_measured AS (
       SELECT
         source_index,
         account_id,
         category,
         built_up,
         geom,
         ST_Area(geom::geography) * 10.76391041671 AS full_area_sqft
       FROM source_features
     ), clipped AS (
       SELECT
         source_index,
         account_id,
         category,
         built_up,
         full_area_sqft,
         ST_CollectionExtract(ST_Intersection(source_features.geom, boundary.geom), 3) AS geom
       FROM source_measured source_features
       CROSS JOIN boundary
       WHERE ST_Intersects(source_features.geom, boundary.geom)
     ), usable AS (
       SELECT source_index, account_id, category, built_up, full_area_sqft, geom
       FROM clipped
       WHERE NOT ST_IsEmpty(geom)
     ), category_dissolved AS (
       SELECT
         category,
         CASE category
           WHEN 'one_unit' THEN 1
           WHEN 'two_to_four_unit' THEN 2
           WHEN 'multifamily' THEN 3
           WHEN 'commercial' THEN 4
           ELSE 5
         END AS category_order,
         ST_UnaryUnion(ST_Collect(geom)) AS geom
       FROM usable
       GROUP BY category
     ), category_resolved AS (
       SELECT
         current.category,
         ST_Difference(
           current.geom,
           COALESCE(
             (
               SELECT ST_UnaryUnion(ST_Collect(prior.geom))
               FROM category_dissolved prior
               WHERE prior.category_order < current.category_order
             ),
             ST_GeomFromText('POLYGON EMPTY', 4326)
           )
         ) AS geom
       FROM category_dissolved current
     ), category_areas AS (
       SELECT
         category,
         ST_Area(geom::geography) * 10.76391041671 AS area_sqft
       FROM category_resolved
     ), covered AS (
       SELECT ST_Area(ST_UnaryUnion(ST_Collect(geom))::geography) * 10.76391041671 AS area_sqft
       FROM usable
     ), built_up_covered AS (
       SELECT ST_Area(ST_UnaryUnion(ST_Collect(geom))::geography) * 10.76391041671 AS area_sqft
       FROM usable
       WHERE built_up
     )
     SELECT
       ST_Area(boundary.geom::geography) * 10.76391041671 AS boundary_area_sqft,
       COALESCE((SELECT area_sqft FROM covered), 0) AS covered_area_sqft,
       COALESCE((SELECT area_sqft FROM built_up_covered), 0) AS built_up_area_sqft,
       (SELECT COUNT(*) FROM usable WHERE built_up) AS built_up_parcel_count,
       COALESCE((
         SELECT SUM(ST_Area(geom::geography) * 10.76391041671)
         FROM category_dissolved
       ), 0) AS raw_category_area_sqft,
       COALESCE((
         SELECT jsonb_object_agg(category, area_sqft)
         FROM category_areas
       ), '{}'::jsonb) AS category_areas,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'source_index', source_index,
           'area_sqft', ST_Area(geom::geography) * 10.76391041671,
           'full_area_sqft', full_area_sqft
         ) ORDER BY source_index)
         FROM usable
       ), '[]'::jsonb) AS parcel_areas
     FROM boundary`,
    [JSON.stringify(boundary), JSON.stringify(payload)],
  );
  return rows[0];
}

// The synchronized Dallas parcel mirror already stores normalized land-use
// classifications and valid PostGIS geometry. Keep that geometry inside the
// database: serializing thousands of polygons to JSON and immediately parsing
// them back into PostGIS was the dominant land-use analysis cost.
async function calculateLocalClippedParcelMetrics(pool, boundary) {
  const { rows } = await pool.query(
    `WITH boundary AS MATERIALIZED (
       SELECT ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)) AS geom
     ), parcel_candidates AS MATERIALIZED (
       SELECT
         parcel.object_id,
         parcel.account_id,
         parcel.land_use_category AS category,
         parcel.built_up,
         parcel.parcel_area_sqft,
         CASE
           WHEN ST_IsValid(parcel.geom) THEN parcel.geom
           ELSE ST_Multi(ST_CollectionExtract(ST_MakeValid(parcel.geom), 3))
         END AS safe_geom
       FROM gis.dcad_parcels parcel
       CROSS JOIN boundary
       WHERE parcel.geom && boundary.geom
         AND parcel.use_code IS DISTINCT FROM '3'
     ), clipped AS MATERIALIZED (
       SELECT
         row_number() OVER (ORDER BY parcel.object_id) - 1 AS source_index,
         parcel.account_id,
         parcel.category,
         parcel.built_up,
         COALESCE(
           parcel.parcel_area_sqft,
           ST_Area(parcel.safe_geom::geography) * 10.76391041671
         ) AS full_area_sqft,
         CASE
           WHEN ST_Covers(boundary.geom, parcel.safe_geom)
             THEN COALESCE(
               parcel.parcel_area_sqft,
               ST_Area(parcel.safe_geom::geography) * 10.76391041671
             )
           ELSE ST_Area(ST_Intersection(parcel.safe_geom, boundary.geom)::geography) *
             10.76391041671
         END AS area_sqft
       FROM parcel_candidates parcel
       CROSS JOIN boundary
       WHERE NOT ST_IsEmpty(parcel.safe_geom)
         AND ST_Intersects(parcel.safe_geom, boundary.geom)
     ), category_areas AS (
       SELECT category, SUM(area_sqft) AS area_sqft
       FROM clipped
       GROUP BY category
     )
     SELECT
       ST_Area(boundary.geom::geography) * 10.76391041671 AS boundary_area_sqft,
       COALESCE((SELECT SUM(area_sqft) FROM clipped), 0) AS covered_area_sqft,
       COALESCE((SELECT SUM(area_sqft) FROM clipped WHERE built_up), 0) AS built_up_area_sqft,
       (SELECT COUNT(*) FROM clipped WHERE built_up) AS built_up_parcel_count,
       COALESCE((SELECT SUM(area_sqft) FROM clipped), 0) AS raw_category_area_sqft,
       COALESCE((
         SELECT jsonb_object_agg(category, area_sqft)
         FROM category_areas
       ), '{}'::jsonb) AS category_areas,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'source_index', source_index,
           'area_sqft', area_sqft,
           'full_area_sqft', full_area_sqft
         ) ORDER BY source_index)
         FROM clipped
       ), '[]'::jsonb) AS parcel_areas
     FROM boundary`,
    [JSON.stringify(boundary)],
  );
  return rows[0];
}

function rounded(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function positiveMetric(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function summarizeMetric(values, digits = 0) {
  const sorted = values
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (!sorted.length) {
    return { count: 0, low: null, high: null, predominant: null };
  }
  const midpoint = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[midpoint]
    : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
  return {
    count: sorted.length,
    low: rounded(sorted[0], digits),
    high: rounded(sorted[sorted.length - 1], digits),
    predominant: rounded(median, digits),
  };
}

/**
 * Describe the complete one-unit housing stock inside the saved boundary.
 * Unlike the market study, this population includes properties that did not sell.
 */
export function buildNeighborhoodPropertyProfile(classifiedParcels, {
  asOfYear = new Date().getUTCFullYear(),
} = {}) {
  const oneUnitParcels = classifiedParcels.filter(
    (parcel) => parcel.classification?.category === "one_unit" && parcel.built_up,
  );
  const marketValues = [];
  const livingAreas = [];
  const ages = [];
  const pricesPerSquareFoot = [];
  for (const parcel of oneUnitParcels) {
    const attributes = parcel.attributes || {};
    const marketValue = positiveMetric(
      attributes.CNTASSDVAL,
      attributes.current_market_value,
      parcel.current_market_value,
    );
    const livingArea = positiveMetric(
      attributes.RESFLRAREA,
      attributes.residential_area_sqft,
      parcel.residential_area_sqft,
      attributes.BLDGAREA,
      attributes.building_area_sqft,
      parcel.building_area_sqft,
    );
    const yearBuilt = positiveMetric(
      attributes.RESYRBLT,
      attributes.residential_year_built,
      parcel.residential_year_built,
    );
    if (marketValue !== null) marketValues.push(marketValue);
    if (livingArea !== null) livingAreas.push(livingArea);
    if (yearBuilt !== null && yearBuilt <= asOfYear) ages.push(asOfYear - yearBuilt);
    if (marketValue !== null && livingArea !== null) {
      pricesPerSquareFoot.push(marketValue / livingArea);
    }
  }
  return {
    population: "all_one_unit_properties",
    property_count: oneUnitParcels.length,
    house_price: summarizeMetric(marketValues, 0),
    price_per_square_foot: summarizeMetric(pricesPerSquareFoot, 2),
    age: summarizeMetric(ages, 0),
    living_area: summarizeMetric(livingAreas, 0),
    value_basis: "Dallas CAD current market value",
    denominator_note:
      "All improved one-unit properties intersecting the defined neighborhood are included whether or not they sold. Price and price-per-square-foot use current Dallas CAD market value; age and GLA use Dallas CAD parcel attributes.",
  };
}

function normalizedAccountId(value) {
  return String(value || "").replace(/[^0-9A-Za-z]/g, "").replace(/^0+/, "");
}

export async function fetchLocalDcadLandUseParcels(pool, customGeometry) {
  const geometry = validateCustomMarketGeometry(customGeometry);
  const { rows } = await pool.query(
    `WITH boundary AS (
       SELECT ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)) AS geom
     )
     SELECT
       parcel.object_id,
       parcel.account_id,
       parcel.low_parcel_id,
       parcel.site_address,
       parcel.use_code,
       parcel.use_description,
       parcel.class_code,
       parcel.class_description,
       parcel.property_description,
       parcel.subdivision_name,
       parcel.structure_type,
       parcel.land_use_category,
       parcel.classification_confidence,
       parcel.classification_review_reason,
       parcel.built_up,
       parcel.building_area_sqft,
       parcel.residential_area_sqft,
       parcel.residential_year_built,
       parcel.current_market_value,
       parcel.improvement_value,
       parcel.source_updated_at
     FROM gis.dcad_parcels parcel
     CROSS JOIN boundary
     WHERE parcel.geom && boundary.geom
       AND ST_Intersects(
         CASE
           WHEN ST_IsValid(parcel.geom) THEN parcel.geom
           ELSE ST_Multi(ST_CollectionExtract(ST_MakeValid(parcel.geom), 3))
         END,
         boundary.geom
       )
     ORDER BY parcel.object_id
     LIMIT $2`,
    [JSON.stringify(geometry), MAX_PARCELS + 1],
  );
  if (rows.length > MAX_PARCELS) throw new Error("land_use_area_too_many_parcels");
  return rows.map((row, index) => {
    const attributes = {
      OBJECTID: row.object_id,
      PARCELID: row.account_id,
      LOWPARCELID: row.low_parcel_id,
      SITEADDRESS: row.site_address,
      USECD: row.use_code,
      USEDSCRP: row.use_description,
      CLASSCD: row.class_code,
      CLASSDSCRP: row.class_description,
      PRPRTYDSCRP: row.property_description,
      CNVYNAME: row.subdivision_name,
      RESSTRTYP: row.structure_type,
      BLDGAREA: row.building_area_sqft,
      RESFLRAREA: row.residential_area_sqft,
      RESYRBLT: row.residential_year_built,
      CNTASSDVAL: row.current_market_value,
      IMPVALUE: row.improvement_value,
    };
    return {
      source_index: index,
      object_id: row.object_id,
      account_id: String(row.account_id || row.low_parcel_id || "").trim() || null,
      site_address: String(row.site_address || "").trim() || null,
      use_description: String(row.use_description || "").trim() || null,
      use_code: String(row.use_code || "").trim() || null,
      class_code: String(row.class_code || "").trim() || null,
      class_description: String(row.class_description || "").trim() || null,
      property_description: String(row.property_description || "").trim() || null,
      land_use_category: String(row.land_use_category || "").trim() || null,
      classification_confidence:
        String(row.classification_confidence || "").trim() || null,
      classification_review_reason:
        String(row.classification_review_reason || "").trim() || null,
      built_up: Boolean(row.built_up),
      source_updated_at: row.source_updated_at,
      attributes,
      building_area_sqft: row.building_area_sqft,
      residential_area_sqft: row.residential_area_sqft,
      residential_year_built: row.residential_year_built,
      current_market_value: row.current_market_value,
    };
  });
}

const analysisCache = new Map();

function cloned(value) {
  return JSON.parse(JSON.stringify(value));
}

function cachedAnalysis(key, now = Date.now()) {
  const cached = analysisCache.get(key);
  if (!cached) return null;
  if (now - cached.cachedAt >= ANALYSIS_CACHE_TTL_MS) {
    analysisCache.delete(key);
    return null;
  }
  return {
    ...cloned(cached.value),
    cache_hit: true,
    processing_duration_ms: 0,
    cached_analysis_duration_ms: cached.value.processing_duration_ms,
  };
}

function cacheAnalysis(key, value, now = Date.now()) {
  analysisCache.set(key, { cachedAt: now, value: cloned(value) });
  while (analysisCache.size > ANALYSIS_CACHE_MAX_ENTRIES) {
    analysisCache.delete(analysisCache.keys().next().value);
  }
}

export function clearNeighborhoodLandUseAnalysisCache() {
  analysisCache.clear();
}

export function evaluateSubjectSiteSize(accountId, classifiedParcels, fullAreaByIndex) {
  const normalizedSubject = normalizedAccountId(accountId);
  const subjectIndex = classifiedParcels.findIndex(
    (parcel) => normalizedAccountId(parcel.account_id) === normalizedSubject,
  );
  if (subjectIndex < 0) {
    return {
      subject_site_area_sqft: null,
      comparison_min_site_area_sqft: null,
      comparison_median_site_area_sqft: null,
      comparison_parcel_count: 0,
      subject_smaller_than_all_comparisons: false,
    };
  }
  const subjectArea = Number(fullAreaByIndex.get(subjectIndex)) || 0;
  const subjectCategory = classifiedParcels[subjectIndex].classification.category;
  const comparisonAreas = classifiedParcels
    .map((parcel, index) => ({
      index,
      category: parcel.classification.category,
      area: Number(fullAreaByIndex.get(index)) || 0,
    }))
    .filter((item) => item.index !== subjectIndex && item.category === subjectCategory && item.area > 0)
    .map((item) => item.area);
  const comparisonMinimum = comparisonAreas.length ? Math.min(...comparisonAreas) : null;
  const sortedComparisonAreas = [...comparisonAreas].sort((left, right) => left - right);
  const midpoint = Math.floor(sortedComparisonAreas.length / 2);
  const comparisonMedian = !sortedComparisonAreas.length
    ? null
    : sortedComparisonAreas.length % 2
      ? sortedComparisonAreas[midpoint]
      : (sortedComparisonAreas[midpoint - 1] + sortedComparisonAreas[midpoint]) / 2;
  return {
    subject_site_area_sqft: subjectArea > 0 ? rounded(subjectArea, 0) : null,
    comparison_min_site_area_sqft: comparisonMinimum === null ? null : rounded(comparisonMinimum, 0),
    comparison_median_site_area_sqft: comparisonMedian === null ? null : rounded(comparisonMedian, 0),
    comparison_parcel_count: comparisonAreas.length,
    subject_smaller_than_all_comparisons: Boolean(
      subjectArea > 0 && comparisonAreas.length >= 3 && comparisonMinimum !== null && subjectArea < comparisonMinimum,
    ),
  };
}

export async function buildNeighborhoodLandUseAnalysis(
  pool,
  {
    subjectAccountId,
    customGeometry,
    fetchImpl = fetch,
    preferLocalMirror = true,
    persistentCache = true,
  },
) {
  const analysisStartedAt = Date.now();
  const accountId = String(subjectAccountId || "").trim();
  if (!/^[0-9A-Za-z]{17}$/.test(accountId)) throw new Error("invalid_account_id");
  const boundary = validateCustomMarketGeometry(customGeometry);
  const boundarySignature = createHash("sha256").update(JSON.stringify(boundary)).digest("hex");
  const cacheKey = `${accountId}:${boundarySignature}`;
  const cached = cachedAnalysis(cacheKey, analysisStartedAt);
  if (cached) return cached;
  let persistentCached = null;
  if (persistentCache) {
    await ensurePropertyContextSchema(pool);
    persistentCached = await readBoundaryAnalysisCache(
      pool,
      `land_use:${cacheKey}`,
    ).catch(() => null);
    if (persistentCached?.result?.property_profile) {
      return {
        ...persistentCached.result,
        cache_hit: true,
        persistent_cache_hit: true,
        stale_cache_used: false,
        processing_duration_ms: Date.now() - analysisStartedAt,
        cached_analysis_duration_ms:
          persistentCached.result.processing_duration_ms ?? null,
      };
    }
  }
  const { rows: accountRows } = await pool.query(
    "SELECT account_id, county FROM core.accounts WHERE account_id = $1",
    [accountId],
  );
  if (!accountRows.length) throw new Error("account_not_found");
  if (accountRows[0].county && !/dallas/i.test(String(accountRows[0].county))) {
    throw new Error("land_use_analysis_dallas_county_only");
  }

  let sourceMode = "live_dcad";
  let sourceHealth = null;
  let parcels = [];
  if (preferLocalMirror) {
    const sources = await getPropertyContextSourceHealth(pool).catch(() => []);
    sourceHealth = sources.find((source) => source.source_key === "dcad_parcels") || null;
    if (sourceHealth?.usable) {
      parcels = await fetchLocalDcadLandUseParcels(pool, boundary);
      sourceMode = "local_mirror";
    }
  }
  if (!parcels.length && sourceMode !== "local_mirror") {
    try {
      parcels = await fetchDcadLandUseParcels(boundary, { fetchImpl });
    } catch (error) {
      if (persistentCache) {
        const stale = await readBoundaryAnalysisCache(
          pool,
          `land_use:${cacheKey}`,
          { allowExpired: true },
        ).catch(() => null);
        if (stale?.result) {
          return {
            ...stale.result,
            cache_hit: true,
            persistent_cache_hit: true,
            stale_cache_used: true,
            processing_duration_ms: Date.now() - analysisStartedAt,
            cached_analysis_duration_ms: stale.result.processing_duration_ms ?? null,
            warnings: [
              ...(stale.result.warnings || []),
              "The live Dallas CAD GIS request failed. HomeNode is using the most recent saved analysis for this exact boundary.",
            ],
          };
        }
      }
      throw error;
    }
  }
  if (!parcels.length) throw new Error("no_dcad_parcels_in_boundary");
  const landParcels = parcels.filter((parcel) => parcel.use_code !== "3");
  if (!landParcels.length) throw new Error("no_dcad_parcels_in_boundary");
  const excludedNonLandRecordCount = parcels.length - landParcels.length;
  const classifiedParcels = landParcels.map((parcel) => ({
    ...parcel,
      classification: classifyDcadLandUse(parcel.attributes),
      built_up: sourceMode === "local_mirror"
        ? Boolean(parcel.built_up)
        : isDcadParcelBuiltUp(parcel.attributes),
    }));
  if (sourceMode === "local_mirror") {
    classifiedParcels.forEach((parcel) => {
      parcel.classification = {
        category: parcel.land_use_category || "other_vacant",
        category_label: LAND_USE_CATEGORIES.find(
          ({ key }) => key === parcel.land_use_category,
        )?.label || "Other / Vacant Land",
        confidence: parcel.classification_confidence || "low",
        requires_review: Boolean(parcel.classification_review_reason),
        review_reason: parcel.classification_review_reason || null,
      };
    });
  }
  const metrics = sourceMode === "local_mirror"
    ? await calculateLocalClippedParcelMetrics(pool, boundary)
    : await calculateClippedParcelMetrics(pool, boundary, classifiedParcels);
  const parcelAreaByIndex = new Map(
    (metrics.parcel_areas || []).map((item) => [Number(item.source_index), Number(item.area_sqft) || 0]),
  );
  const fullAreaByIndex = new Map(
    (metrics.parcel_areas || []).map((item) => [Number(item.source_index), Number(item.full_area_sqft) || 0]),
  );
  const siteSizeReview = evaluateSubjectSiteSize(accountId, classifiedParcels, fullAreaByIndex);
  const propertyProfile = buildNeighborhoodPropertyProfile(classifiedParcels, {
    asOfYear: new Date(analysisStartedAt).getUTCFullYear(),
  });
  const categoryAreas = Object.fromEntries(
    LAND_USE_CATEGORIES.map(({ key }) => [key, Number(metrics.category_areas?.[key]) || 0]),
  );
  const percentages = allocateLandUsePercentages(categoryAreas);
  const categoryAreaSum = Object.values(categoryAreas).reduce((sum, value) => sum + value, 0);
  const boundaryArea = Number(metrics.boundary_area_sqft) || 0;
  const coveredArea = Number(metrics.covered_area_sqft) || 0;
  const builtUpArea = Number(metrics.built_up_area_sqft) || 0;
  const builtUpPercent = coveredArea > 0 ? (builtUpArea / coveredArea) * 100 : 0;
  const builtUpBand = classifyBuiltUpBand(builtUpPercent);
  const rawCategoryArea = Number(metrics.raw_category_area_sqft) || 0;
  const coveragePercent = boundaryArea > 0 ? (coveredArea / boundaryArea) * 100 : 0;
  const overlapPercent = coveredArea > 0
    ? Math.max(0, ((rawCategoryArea - coveredArea) / coveredArea) * 100)
    : 0;
  const reviewParcels = classifiedParcels
    .map((parcel, index) => ({
      object_id: parcel.object_id,
      account_id: parcel.account_id,
      site_address: parcel.site_address,
      use_description: parcel.use_description,
      property_description: parcel.property_description,
      class_code: parcel.class_code,
      class_description: parcel.class_description,
      category: parcel.classification.category,
      category_label: parcel.classification.category_label,
      confidence: parcel.classification.confidence,
      review_reason: parcel.classification.review_reason,
      clipped_area_sqft: rounded(parcelAreaByIndex.get(index) || 0, 0),
      clipped_area_acres: rounded((parcelAreaByIndex.get(index) || 0) / SQ_FEET_PER_ACRE, 3),
    }))
    .filter((parcel) => parcel.review_reason)
    .sort((left, right) => right.clipped_area_sqft - left.clipped_area_sqft);
  const reviewArea = reviewParcels.reduce((sum, parcel) => sum + parcel.clipped_area_sqft, 0);
  const reviewAreaPercent = categoryAreaSum > 0 ? (reviewArea / categoryAreaSum) * 100 : 0;
  const confidence = coveragePercent >= 70 && reviewAreaPercent <= 2 && overlapPercent <= 1
    ? "high"
    : coveragePercent >= 55 && reviewAreaPercent <= 7.5 && overlapPercent <= 3
      ? "moderate"
      : "limited";
  const warnings = [];
  if (coveragePercent < 70) {
    warnings.push("Official parcel polygons cover less than 70% of the drawn boundary; roads and other non-parcel land are excluded from the percentage denominator.");
  }
  if (reviewParcels.length) {
    warnings.push(`${reviewParcels.length} parcel${reviewParcels.length === 1 ? "" : "s"} use provisional classifications and should be reviewed.`);
  }
  if (overlapPercent > 1) {
    warnings.push("Some parcel categories overlap spatially; category polygons were dissolved before calculating percentages.");
  }
  if (excludedNonLandRecordCount) {
    warnings.push(`${excludedNonLandRecordCount} mapped business-personal-property record${excludedNonLandRecordCount === 1 ? " was" : "s were"} excluded because those records do not represent separate land parcels.`);
  }
  if (sourceMode === "local_mirror" && sourceHealth?.serving_stale_data) {
    warnings.push("Dallas CAD GIS synchronization is currently stale or unavailable. This analysis uses the most recent locally stored county parcel data.");
  }

  const result = {
    subject_account_id: accountId,
    jurisdiction: "Dallas County",
    source: sourceMode === "local_mirror"
      ? "HomeNode local Dallas CAD ParcelPublishing mirror"
      : "Dallas Central Appraisal District ParcelPublishing GIS",
    source_url: DCAD_LAND_USE_QUERY_URL,
    source_mode: sourceMode,
    source_health: sourceHealth,
    analyzed_at: new Date().toISOString(),
    methodology_version: 2,
    boundary,
    boundary_signature: boundarySignature,
    boundary_area_acres: rounded(boundaryArea / SQ_FEET_PER_ACRE, 2),
    covered_parcel_area_acres: rounded(coveredArea / SQ_FEET_PER_ACRE, 2),
    built_up_area_acres: rounded(builtUpArea / SQ_FEET_PER_ACRE, 2),
    built_up_percent: rounded(builtUpPercent, 1),
    built_up_band: builtUpBand.key,
    built_up_label: builtUpBand.label,
    built_up_parcel_count: Number(metrics.built_up_parcel_count) || 0,
    ...siteSizeReview,
    coverage_percent: rounded(coveragePercent, 1),
    overlap_percent: rounded(overlapPercent, 1),
    parcel_count: classifiedParcels.length,
    excluded_non_land_record_count: excludedNonLandRecordCount,
    review_required_count: reviewParcels.length,
    review_area_percent: rounded(reviewAreaPercent, 1),
    confidence,
    categories: LAND_USE_CATEGORIES.map(({ key, label }) => ({
      key,
      label,
      parcel_count: classifiedParcels.filter((parcel) => parcel.classification.category === key).length,
      area_sqft: rounded(categoryAreas[key], 0),
      area_acres: rounded(categoryAreas[key] / SQ_FEET_PER_ACRE, 2),
      percentage: percentages[key],
    })),
    property_profile: propertyProfile,
    review_parcels: reviewParcels.slice(0, 250),
    review_parcels_truncated: reviewParcels.length > 250,
    warnings,
    denominator_note: "Percentages use dissolved, clipped CAD parcel acreage. Roads and uncovered non-parcel land are reported in coverage but excluded from the category denominator.",
    cache_hit: false,
    persistent_cache_hit: false,
    stale_cache_used: false,
    processing_duration_ms: Date.now() - analysisStartedAt,
    cached_analysis_duration_ms: null,
  };
  cacheAnalysis(cacheKey, result);
  if (persistentCache) {
    await writeBoundaryAnalysisCache(pool, {
      cacheKey: `land_use:${cacheKey}`,
      subjectAccountId: accountId,
      boundarySignature,
      analysisType: "neighborhood_land_use",
      boundary,
      result,
      sourceState: sourceHealth || { source_mode: sourceMode },
      ttlHours: 24,
    }).catch((error) => {
      console.warn("[neighborhood-land-use] persistent cache write failed", error?.message || error);
    });
  }
  return result;
}

export function neighborhoodLandUseErrorStatus(message) {
  if (["invalid_account_id", "custom_area_must_be_polygon", "custom_area_coordinates_required", "custom_area_requires_three_points", "custom_area_ring_invalid", "custom_area_ring_not_closed", "custom_area_coordinate_invalid", "custom_area_outside_dfw_bounds"].includes(message)) return 400;
  if (message === "account_not_found") return 404;
  if (["land_use_analysis_dallas_county_only", "no_dcad_parcels_in_boundary", "land_use_area_too_many_parcels"].includes(message)) return 422;
  if (message.startsWith("dcad_land_use_query_")) return 502;
  return 500;
}
