import { createHash, randomUUID } from "node:crypto";

import {
  classifyDcadLandUse,
  isDcadParcelBuiltUp,
} from "./neighborhoodLandUse.js";
import { ensurePropertyContextSchema } from "./propertyContextStore.js";
import { OFFICIAL_ZONING_SOURCES } from "./propertyZoningSources.js";

export const DCAD_PARCEL_SYNC_URL =
  "https://maps.dcad.org/prdwa/rest/services/Property/ParcelQuery/MapServer/4/query";
export const TIGER_ROAD_SERVICE_URL =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation_LargeScale/MapServer";
export const FEMA_NFHL_QUERY_URL =
  "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query";
export const TXDOT_AADT_QUERY_URL =
  "https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/TxDOT_AADT/FeatureServer/0/query";

const DCAD_SYNC_FIELDS = [
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
  "PRVASSDVAL",
  "LASTUPDATE",
].join(",");

const ROAD_FIELDS = "OBJECTID,OID,NAME,BASENAME,MTFCC,RTTYP";
const FEMA_NFHL_FIELDS = "OBJECTID,GFID,DFIRM_ID,FLD_AR_ID,FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE,SOURCE_CIT";
const TXDOT_AADT_FIELDS = "OBJECTID,RTE_NM,RTE_PRFX,RTE_NBR,RDBD_TYPE,AADT_CUR,EXT_DATE";
const DALLAS_COUNTY_QUERY_ENVELOPE = Object.freeze({
  xmin: -97.05,
  ymin: 32.50,
  xmax: -96.45,
  ymax: 33.10,
  spatialReference: { wkid: 4326 },
});
const DEFAULT_BATCH_SIZE = 2_000;
const DEFAULT_FETCH_CONCURRENCY = 3;

const ROAD_LAYERS = Object.freeze([
  { id: 0, sourceKey: "tiger_roads_primary", label: "Census TIGER primary roads", roadClass: "primary", outFields: ROAD_FIELDS },
  { id: 1, sourceKey: "tiger_roads_secondary", label: "Census TIGER secondary roads", roadClass: "secondary", outFields: ROAD_FIELDS },
  { id: 2, sourceKey: "tiger_roads_local", label: "Census TIGER local roads", roadClass: "local", outFields: ROAD_FIELDS },
  {
    id: 3,
    sourceKey: "tiger_railroads",
    label: "Census TIGER railroads",
    roadClass: "railroad",
    // The railroad layer does not expose the road-only RTTYP field.
    outFields: "OBJECTID,OID,NAME,BASENAME,MTFCC,SUFTYP,SUFTYPEABRV",
  },
]);

export function tigerRoadOutFields(layerId) {
  return ROAD_LAYERS.find((layer) => layer.id === Number(layerId))?.outFields || ROAD_FIELDS;
}

export function deduplicateSourceRecords(records = []) {
  return [...new Map(
    records.map((record) => [`${record.source_key}:${record.source_record_id}`, record]),
  ).values()];
}
function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value) {
  const parsed = numeric(value);
  return parsed === null ? null : Math.round(parsed);
}

function text(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function sourceDate(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const numericValue = Number(value);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return new Date(numericValue).toISOString();
  }
  const monthDayYear = String(value || "").match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (monthDayYear) {
    return new Date(`${monthDayYear[3]}-${monthDayYear[1]}-${monthDayYear[2]}T00:00:00.000Z`).toISOString();
  }
  const parsed = new Date(value || 0);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function recordHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function arcGisBody(values) {
  return new URLSearchParams(
    Object.entries(values)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)]),
  );
}

export async function requestArcGis(url, values, {
  fetchImpl = fetch,
  timeoutMs = 120_000,
  maximumAttempts = 3,
} = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: arcGisBody(values),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`property_context_source_http_${response.status}`);
      const payload = await response.json();
      if (payload?.error) {
        throw new Error(
          `property_context_source_${payload.error.code || "error"}: ${payload.error.message || "unknown error"}`,
        );
      }
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt >= maximumAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError || new Error("property_context_source_failed");
}

export async function fetchArcGisObjectIds(url, {
  where = "1=1",
  geometry = null,
  fetchImpl = fetch,
} = {}) {
  const payload = await requestArcGis(url, {
    where,
    ...(geometry ? {
      geometry: JSON.stringify(geometry),
      geometryType: geometry.xmin == null ? "esriGeometryPolygon" : "esriGeometryEnvelope",
      spatialRel: "esriSpatialRelIntersects",
      inSR: 4326,
    } : {}),
    returnIdsOnly: true,
    f: "json",
  }, { fetchImpl });
  return [...new Set((payload.objectIds || [])
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0))]
    .sort((left, right) => left - right);
}

export async function fetchArcGisFeatures(url, {
  objectIds,
  outFields,
  fetchImpl = fetch,
} = {}) {
  const common = {
    objectIds: objectIds.join(","),
    outFields,
    returnGeometry: true,
    outSR: 4326,
    geometryPrecision: 7,
  };
  let payload = await requestArcGis(url, { ...common, f: "geojson" }, { fetchImpl });
  if (!Array.isArray(payload.features)) {
    payload = await requestArcGis(url, { ...common, f: "json" }, { fetchImpl });
  }
  return payload.features || [];
}

function geoJsonGeometry(feature) {
  const geometry = feature?.geometry;
  if (!geometry) return null;
  if (geometry.type && geometry.coordinates) return geometry;
  if (Array.isArray(geometry.rings)) {
    return { type: "Polygon", coordinates: geometry.rings };
  }
  if (Array.isArray(geometry.paths)) {
    return geometry.paths.length === 1
      ? { type: "LineString", coordinates: geometry.paths[0] }
      : { type: "MultiLineString", coordinates: geometry.paths };
  }
  return null;
}

export function normalizeDcadParcelFeature(feature, runId) {
  const attributes = feature?.properties || feature?.attributes || {};
  const objectId = integer(attributes.OBJECTID ?? feature?.id);
  const geometry = geoJsonGeometry(feature);
  if (!objectId || !geometry || !["Polygon", "MultiPolygon"].includes(geometry.type)) return null;
  const classified = classifyDcadLandUse(attributes);
  const normalized = {
    object_id: objectId,
    account_id: text(attributes.PARCELID),
    low_parcel_id: text(attributes.LOWPARCELID),
    site_address: text(attributes.SITEADDRESS),
    use_code: text(attributes.USECD),
    use_description: text(attributes.USEDSCRP),
    class_code: text(attributes.CLASSCD),
    class_description: text(attributes.CLASSDSCRP),
    property_description: text(attributes.PRPRTYDSCRP),
    subdivision_name: text(attributes.CNVYNAME),
    structure_type: text(attributes.RESSTRTYP),
    land_use_category: classified.category,
    classification_confidence: classified.confidence,
    classification_review_reason: classified.review_reason,
    built_up: isDcadParcelBuiltUp(attributes),
    building_area_sqft: numeric(attributes.BLDGAREA),
    residential_area_sqft: numeric(attributes.RESFLRAREA),
    residential_year_built: integer(attributes.RESYRBLT),
    land_value: numeric(attributes.LNDVALUE),
    improvement_value: numeric(attributes.IMPVALUE),
    current_market_value: numeric(attributes.CNTASSDVAL),
    previous_market_value: numeric(attributes.PRVASSDVAL),
    source_updated_at: sourceDate(attributes.LASTUPDATE),
    source_attributes: attributes,
    sync_run_id: runId,
    geometry,
  };
  return { ...normalized, source_record_hash: recordHash(normalized) };
}

export function normalizeRoadFeature(feature, { runId, sourceLayer, roadClass, sourceVintage }) {
  const attributes = feature?.properties || feature?.attributes || {};
  const objectId = integer(attributes.OBJECTID ?? feature?.id);
  const geometry = geoJsonGeometry(feature);
  if (!objectId || !geometry || !["LineString", "MultiLineString"].includes(geometry.type)) return null;
  const normalized = {
    source_layer: sourceLayer,
    source_object_id: objectId,
    source_oid: text(attributes.OID),
    name: text(attributes.NAME),
    base_name: text(attributes.BASENAME),
    mtfcc: text(attributes.MTFCC),
    route_type: text(attributes.RTTYP),
    road_class: roadClass,
    source_vintage: sourceVintage,
    source_attributes: attributes,
    sync_run_id: runId,
    geometry,
  };
  return { ...normalized, source_record_hash: recordHash(normalized) };
}

export function normalizeTrafficVolumeFeature(feature, runId) {
  const attributes = feature?.properties || feature?.attributes || {};
  const objectId = integer(attributes.OBJECTID ?? feature?.id);
  const geometry = geoJsonGeometry(feature);
  if (!objectId || !geometry || !["LineString", "MultiLineString"].includes(geometry.type)) return null;
  const normalized = {
    source_key: "txdot_aadt",
    source_object_id: objectId,
    route_name: text(attributes.RTE_NM),
    route_prefix: text(attributes.RTE_PRFX),
    route_number: text(attributes.RTE_NBR),
    roadway_type: text(attributes.RDBD_TYPE),
    current_aadt: integer(attributes.AADT_CUR),
    source_date: sourceDate(attributes.EXT_DATE),
    source_attributes: attributes,
    sync_run_id: runId,
    geometry,
  };
  return { ...normalized, source_record_hash: recordHash(normalized) };
}

function firstText(attributes, fields) {
  for (const field of fields || []) {
    const value = text(attributes[field]);
    if (value) return value;
  }
  return null;
}

function generalizedZoningUse(...values) {
  const description = values.filter(Boolean).join(" ").toUpperCase();
  if (/INDUSTR|WAREHOUSE|MANUFACTUR/.test(description)) return "industrial";
  if (/MIXED|MX|MU/.test(description)) return "mixed_use";
  if (/COMMERCIAL|RETAIL|OFFICE|CENTRAL BUSINESS|CBD|CR|CS|CA/.test(description)) return "commercial";
  if (/MULTI|APARTMENT|DUPLEX|TOWNHOUSE|MF/.test(description)) return "multifamily_residential";
  if (/RESIDENTIAL|SINGLE FAMILY|AGRICULTUR|RURAL|R-|SF|TH/.test(description)) return "residential";
  if (/PLANNED|PD|PUD/.test(description)) return "planned_development";
  return "unclassified";
}

export function normalizeFemaFloodFeature(feature, runId) {
  const attributes = feature?.properties || feature?.attributes || {};
  const geometry = geoJsonGeometry(feature);
  // GFID identifies the effective FIRM dataset and is shared by thousands of
  // polygons. FLD_AR_ID is the stable identity of the individual flood area.
  const sourceRecordId = text(attributes.FLD_AR_ID) ||
    text(attributes.OBJECTID ?? feature?.id) || text(attributes.GFID);
  if (!sourceRecordId || !geometry || !["Polygon", "MultiPolygon"].includes(geometry.type)) {
    return null;
  }
  const staticBfe = numeric(attributes.STATIC_BFE);
  const normalized = {
    source_key: "fema_nfhl",
    source_record_id: sourceRecordId,
    flood_zone: text(attributes.FLD_ZONE),
    zone_subtype: text(attributes.ZONE_SUBTY),
    special_flood_hazard: String(attributes.SFHA_TF || "").toUpperCase() === "T",
    static_base_flood_elevation: staticBfe !== null && staticBfe > -9_000 ? staticBfe : null,
    source_attributes: attributes,
    source_updated_at: null,
    sync_run_id: runId,
    geometry,
  };
  return { ...normalized, source_record_hash: recordHash(normalized) };
}

export function normalizeOfficialZoningFeature(feature, runId, source) {
  const attributes = feature?.properties || feature?.attributes || {};
  const geometry = geoJsonGeometry(feature);
  const rawSourceRecordId = firstText(attributes, source.sourceIdFields) ||
    text(attributes.GLOBALID) || text(attributes.OBJECTID ?? feature?.id);
  const sourceRecordId = rawSourceRecordId && source.sourceRecordPrefix
    ? `${source.sourceRecordPrefix}:${rawSourceRecordId}`
    : rawSourceRecordId;
  if (!sourceRecordId || !geometry || !["Polygon", "MultiPolygon"].includes(geometry.type)) {
    return null;
  }
  const zoningCode = firstText(attributes, source.zoningCodeFields);
  const zoningDescription = firstText(attributes, source.descriptionFields);
  const normalized = {
    provider_key: source.providerKey,
    source_record_id: sourceRecordId,
    jurisdiction: source.jurisdiction,
    zoning_code: zoningCode,
    zoning_description: zoningDescription,
    generalized_use: generalizedZoningUse(zoningCode, zoningDescription),
    overlays: [],
    source_attributes: attributes,
    source_updated_at: sourceDate(
      firstText(attributes, source.sourceUpdatedFields) || attributes.EFFECTIVEDATE,
    ),
    sync_run_id: runId,
    geometry,
  };
  return { ...normalized, source_record_hash: recordHash(normalized) };
}

async function startRun(pool, { sourceKey, sourceLabel, sourceUrl, sourceVintage, mode }) {
  const runId = randomUUID();
  await pool.query(
    `INSERT INTO gis.source_sync_runs (id, source_key, mode, status)
     VALUES ($1,$2,$3,'running')`,
    [runId, sourceKey, mode],
  );
  await pool.query(
    `INSERT INTO gis.source_sync_state (
       source_key, source_label, status, source_url, source_vintage,
       last_attempt_at, last_run_id, last_error
     ) VALUES ($1,$2,'running',$3,$4,now(),$5,NULL)
     ON CONFLICT (source_key) DO UPDATE SET
       source_label = EXCLUDED.source_label,
       status = 'running',
       source_url = EXCLUDED.source_url,
       source_vintage = COALESCE(EXCLUDED.source_vintage, gis.source_sync_state.source_vintage),
       last_attempt_at = now(),
       last_run_id = EXCLUDED.last_run_id,
       last_error = NULL,
       updated_at = now()`,
    [sourceKey, sourceLabel, sourceUrl, sourceVintage, runId],
  );
  return runId;
}

async function updateRunCheckpoint(pool, runId, sourceKey, checkpoint, seen, written) {
  await pool.query(
    `UPDATE gis.source_sync_runs
     SET records_seen = $2, records_written = $3, checkpoint = $4::jsonb
     WHERE id = $1`,
    [runId, seen, written, JSON.stringify(checkpoint)],
  );
  await pool.query(
    `UPDATE gis.source_sync_state
     SET checkpoint = $2::jsonb, updated_at = now()
     WHERE source_key = $1`,
    [sourceKey, JSON.stringify(checkpoint)],
  );
}

async function completeRun(pool, {
  runId,
  sourceKey,
  rowCount,
  seen,
  written,
  deleted,
  lastSourceUpdateAt = null,
  metadata = {},
}) {
  await pool.query(
    `UPDATE gis.source_sync_runs
     SET status = 'complete', records_seen = $2, records_written = $3,
         records_deleted = $4, completed_at = now(), error_message = NULL
     WHERE id = $1`,
    [runId, seen, written, deleted],
  );
  await pool.query(
    `UPDATE gis.source_sync_state
     SET status = 'current', row_count = $2, last_success_at = now(),
         last_source_update_at = COALESCE($3::timestamptz, last_source_update_at),
         checkpoint = '{}'::jsonb, last_error = NULL,
         metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
         updated_at = now()
     WHERE source_key = $1`,
    [
      sourceKey,
      rowCount,
      lastSourceUpdateAt,
      JSON.stringify(metadata),
    ],
  );
}

async function failRun(pool, { runId, sourceKey, error }) {
  const message = String(error?.message || error || "property_context_sync_failed").slice(0, 4_000);
  await pool.query(
    `UPDATE gis.source_sync_runs
     SET status = 'failed', error_message = $2, completed_at = now()
     WHERE id = $1`,
    [runId, message],
  );
  await pool.query(
    `UPDATE gis.source_sync_state
     SET status = 'failed', last_error = $2, updated_at = now()
     WHERE source_key = $1`,
    [sourceKey, message],
  );
}

async function upsertDcadParcels(pool, parcels) {
  if (!parcels.length) return 0;
  const { rowCount } = await pool.query(
    `WITH source AS (
       SELECT *
       FROM jsonb_to_recordset($1::jsonb) AS row(
         object_id bigint,
         account_id text,
         low_parcel_id text,
         site_address text,
         use_code text,
         use_description text,
         class_code text,
         class_description text,
         property_description text,
         subdivision_name text,
         structure_type text,
         land_use_category text,
         classification_confidence text,
         classification_review_reason text,
         built_up boolean,
         building_area_sqft numeric,
         residential_area_sqft numeric,
         residential_year_built integer,
         land_value numeric,
         improvement_value numeric,
         current_market_value numeric,
         previous_market_value numeric,
         source_updated_at timestamptz,
         source_attributes jsonb,
         source_record_hash text,
         sync_run_id uuid,
         geometry jsonb
       )
     ), prepared AS (
       SELECT source.*,
              ST_Multi(ST_CollectionExtract(ST_MakeValid(
                ST_SetSRID(ST_GeomFromGeoJSON(source.geometry::text), 4326)
              ), 3))::geometry(MultiPolygon,4326) AS geom
       FROM source
     )
     INSERT INTO gis.dcad_parcels (
       object_id, account_id, low_parcel_id, site_address, use_code,
       use_description, class_code, class_description, property_description,
       subdivision_name, structure_type, land_use_category,
       classification_confidence, classification_review_reason, built_up,
       building_area_sqft, residential_area_sqft, residential_year_built,
       land_value, improvement_value, current_market_value,
       previous_market_value, parcel_area_sqft, source_updated_at,
       source_attributes, source_record_hash, sync_run_id, synced_at, geom
     )
     SELECT object_id, account_id, low_parcel_id, site_address, use_code,
            use_description, class_code, class_description, property_description,
            subdivision_name, structure_type, land_use_category,
            classification_confidence, classification_review_reason, built_up,
            building_area_sqft, residential_area_sqft, residential_year_built,
            land_value, improvement_value, current_market_value,
            previous_market_value, ST_Area(geom::geography) * 10.76391041671,
            source_updated_at, source_attributes, source_record_hash,
            sync_run_id, now(), geom
     FROM prepared
     WHERE NOT ST_IsEmpty(geom)
     ON CONFLICT (object_id) DO UPDATE SET
       account_id = EXCLUDED.account_id,
       low_parcel_id = EXCLUDED.low_parcel_id,
       site_address = EXCLUDED.site_address,
       use_code = EXCLUDED.use_code,
       use_description = EXCLUDED.use_description,
       class_code = EXCLUDED.class_code,
       class_description = EXCLUDED.class_description,
       property_description = EXCLUDED.property_description,
       subdivision_name = EXCLUDED.subdivision_name,
       structure_type = EXCLUDED.structure_type,
       land_use_category = EXCLUDED.land_use_category,
       classification_confidence = EXCLUDED.classification_confidence,
       classification_review_reason = EXCLUDED.classification_review_reason,
       built_up = EXCLUDED.built_up,
       building_area_sqft = EXCLUDED.building_area_sqft,
       residential_area_sqft = EXCLUDED.residential_area_sqft,
       residential_year_built = EXCLUDED.residential_year_built,
       land_value = EXCLUDED.land_value,
       improvement_value = EXCLUDED.improvement_value,
       current_market_value = EXCLUDED.current_market_value,
       previous_market_value = EXCLUDED.previous_market_value,
       parcel_area_sqft = EXCLUDED.parcel_area_sqft,
       source_updated_at = EXCLUDED.source_updated_at,
       source_attributes = EXCLUDED.source_attributes,
       source_record_hash = EXCLUDED.source_record_hash,
       sync_run_id = EXCLUDED.sync_run_id,
       synced_at = now(),
       geom = EXCLUDED.geom`,
    [JSON.stringify(parcels)],
  );
  return rowCount || 0;
}

async function upsertRoadSegments(pool, roads) {
  if (!roads.length) return 0;
  const { rowCount } = await pool.query(
    `WITH source AS (
       SELECT *
       FROM jsonb_to_recordset($1::jsonb) AS row(
         source_layer text,
         source_object_id bigint,
         source_oid text,
         name text,
         base_name text,
         mtfcc text,
         route_type text,
         road_class text,
         source_vintage text,
         source_attributes jsonb,
         source_record_hash text,
         sync_run_id uuid,
         geometry jsonb
       )
     ), prepared AS (
       SELECT source.*,
              ST_Multi(ST_CollectionExtract(ST_MakeValid(
                ST_SetSRID(ST_GeomFromGeoJSON(source.geometry::text), 4326)
              ), 2))::geometry(MultiLineString,4326) AS geom
       FROM source
     )
     INSERT INTO gis.road_segments (
       source_layer, source_object_id, source_oid, name, base_name, mtfcc,
       route_type, road_class, source_vintage, source_attributes,
       source_record_hash, sync_run_id, synced_at, geom
     )
     SELECT source_layer, source_object_id, source_oid, name, base_name, mtfcc,
            route_type, road_class, source_vintage, source_attributes,
            source_record_hash, sync_run_id, now(), geom
     FROM prepared
     WHERE NOT ST_IsEmpty(geom)
     ON CONFLICT (source_layer, source_object_id) DO UPDATE SET
       source_oid = EXCLUDED.source_oid,
       name = EXCLUDED.name,
       base_name = EXCLUDED.base_name,
       mtfcc = EXCLUDED.mtfcc,
       route_type = EXCLUDED.route_type,
       road_class = EXCLUDED.road_class,
       source_vintage = EXCLUDED.source_vintage,
       source_attributes = EXCLUDED.source_attributes,
       source_record_hash = EXCLUDED.source_record_hash,
       sync_run_id = EXCLUDED.sync_run_id,
       synced_at = now(),
       geom = EXCLUDED.geom`,
    [JSON.stringify(roads)],
  );
  return rowCount || 0;
}

async function upsertTrafficVolumeSegments(pool, records) {
  if (!records.length) return 0;
  const { rowCount } = await pool.query(
    `WITH source AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
         source_key text, source_object_id bigint, route_name text,
         route_prefix text, route_number text, roadway_type text,
         current_aadt integer, source_date timestamptz,
         source_attributes jsonb, source_record_hash text,
         sync_run_id uuid, geometry jsonb
       )
     ), prepared AS (
       SELECT source.*,
              ST_Multi(ST_CollectionExtract(ST_MakeValid(
                ST_SetSRID(ST_GeomFromGeoJSON(source.geometry::text), 4326)
              ), 2))::geometry(MultiLineString,4326) AS geom
       FROM source
     )
     INSERT INTO gis.traffic_volume_segments (
       source_key, source_object_id, route_name, route_prefix, route_number,
       roadway_type, current_aadt, source_date, source_attributes,
       source_record_hash, sync_run_id, synced_at, geom
     )
     SELECT source_key, source_object_id, route_name, route_prefix, route_number,
            roadway_type, current_aadt, source_date, source_attributes,
            source_record_hash, sync_run_id, now(), geom
     FROM prepared WHERE NOT ST_IsEmpty(geom)
     ON CONFLICT (source_key, source_object_id) DO UPDATE SET
       route_name = EXCLUDED.route_name,
       route_prefix = EXCLUDED.route_prefix,
       route_number = EXCLUDED.route_number,
       roadway_type = EXCLUDED.roadway_type,
       current_aadt = EXCLUDED.current_aadt,
       source_date = EXCLUDED.source_date,
       source_attributes = EXCLUDED.source_attributes,
       source_record_hash = EXCLUDED.source_record_hash,
       sync_run_id = EXCLUDED.sync_run_id,
       synced_at = now(), geom = EXCLUDED.geom`,
    [JSON.stringify(records)],
  );
  return rowCount || 0;
}

async function upsertFloodHazards(pool, records) {
  if (!records.length) return 0;
  // FEMA can return multiple geometries with the same stable GFID/FLD_AR_ID
  // in a single response. PostgreSQL cannot update the same conflict target
  // twice within one INSERT, so keep one deterministic record per identity.
  const uniqueRecords = deduplicateSourceRecords(records);
  const { rowCount } = await pool.query(
    `WITH source AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
         source_key text, source_record_id text, flood_zone text,
         zone_subtype text, special_flood_hazard boolean,
         static_base_flood_elevation numeric, source_attributes jsonb,
         source_record_hash text, source_updated_at timestamptz,
         sync_run_id uuid, geometry jsonb
       )
     ), prepared AS (
       SELECT source.*,
              ST_Multi(ST_CollectionExtract(ST_MakeValid(
                ST_SetSRID(ST_GeomFromGeoJSON(source.geometry::text), 4326)
              ), 3))::geometry(MultiPolygon,4326) AS geom
       FROM source
     )
     INSERT INTO gis.flood_hazard_areas (
       source_key, source_record_id, flood_zone, zone_subtype,
       special_flood_hazard, static_base_flood_elevation,
       source_attributes, source_record_hash, source_updated_at,
       sync_run_id, synced_at, geom
     )
     SELECT source_key, source_record_id, flood_zone, zone_subtype,
            special_flood_hazard, static_base_flood_elevation,
            source_attributes, source_record_hash, source_updated_at,
            sync_run_id, now(), geom
     FROM prepared WHERE NOT ST_IsEmpty(geom)
     ON CONFLICT (source_key, source_record_id) DO UPDATE SET
       flood_zone = EXCLUDED.flood_zone,
       zone_subtype = EXCLUDED.zone_subtype,
       special_flood_hazard = EXCLUDED.special_flood_hazard,
       static_base_flood_elevation = EXCLUDED.static_base_flood_elevation,
       source_attributes = EXCLUDED.source_attributes,
       source_record_hash = EXCLUDED.source_record_hash,
       source_updated_at = EXCLUDED.source_updated_at,
       sync_run_id = EXCLUDED.sync_run_id,
       synced_at = now(), geom = EXCLUDED.geom`,
    [JSON.stringify(uniqueRecords)],
  );
  return rowCount || 0;
}

async function upsertZoningDistricts(pool, records) {
  if (!records.length) return 0;
  const { rowCount } = await pool.query(
    `WITH source AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
         provider_key text, source_record_id text, jurisdiction text,
         zoning_code text, zoning_description text, generalized_use text,
         overlays jsonb, source_attributes jsonb, source_record_hash text,
         source_updated_at timestamptz, sync_run_id uuid, geometry jsonb
       )
     ), prepared AS (
       SELECT source.*,
              ST_Multi(ST_CollectionExtract(ST_MakeValid(
                ST_SetSRID(ST_GeomFromGeoJSON(source.geometry::text), 4326)
              ), 3))::geometry(MultiPolygon,4326) AS geom
       FROM source
     )
     INSERT INTO gis.zoning_districts (
       provider_key, source_record_id, jurisdiction, zoning_code,
       zoning_description, generalized_use, overlays, source_attributes,
       source_record_hash, source_updated_at, sync_run_id, synced_at, geom
     )
     SELECT provider_key, source_record_id, jurisdiction, zoning_code,
            zoning_description, generalized_use, overlays, source_attributes,
            source_record_hash, source_updated_at, sync_run_id, now(), geom
     FROM prepared WHERE NOT ST_IsEmpty(geom)
     ON CONFLICT (provider_key, source_record_id) DO UPDATE SET
       jurisdiction = EXCLUDED.jurisdiction,
       zoning_code = EXCLUDED.zoning_code,
       zoning_description = EXCLUDED.zoning_description,
       generalized_use = EXCLUDED.generalized_use,
       overlays = EXCLUDED.overlays,
       source_attributes = EXCLUDED.source_attributes,
       source_record_hash = EXCLUDED.source_record_hash,
       source_updated_at = EXCLUDED.source_updated_at,
       sync_run_id = EXCLUDED.sync_run_id,
       synced_at = now(), geom = EXCLUDED.geom`,
    [JSON.stringify(records)],
  );
  return rowCount || 0;
}

async function fetchAndWriteBatches({
  objectIds,
  batchSize,
  concurrency,
  fetchBatch,
  normalizeFeature,
  writeBatch,
  onCheckpoint,
}) {
  const batches = chunks(objectIds, batchSize);
  let seen = 0;
  let written = 0;
  for (let index = 0; index < batches.length; index += concurrency) {
    const group = batches.slice(index, index + concurrency);
    const featureGroups = await Promise.all(group.map((ids) => fetchBatch(ids)));
    for (let offset = 0; offset < group.length; offset += 1) {
      const ids = group[offset];
      const records = featureGroups[offset].map(normalizeFeature).filter(Boolean);
      seen += ids.length;
      written += await writeBatch(records);
      await onCheckpoint({
        seen,
        written,
        last_object_id: ids.at(-1) || null,
        batch_index: index + offset + 1,
        batch_count: batches.length,
      });
    }
  }
  return { seen, written };
}

function incrementalDcadWhere(lastSuccessAt) {
  if (!lastSuccessAt) return "1=1";
  const date = new Date(lastSuccessAt);
  if (Number.isNaN(date.getTime())) return "1=1";
  date.setMinutes(date.getMinutes() - 30);
  const sqlTimestamp = date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  return `LASTUPDATE > TIMESTAMP '${sqlTimestamp}'`;
}

export async function syncDcadPropertyContext(pool, {
  mode = "incremental",
  fetchImpl = fetch,
  batchSize = DEFAULT_BATCH_SIZE,
  concurrency = DEFAULT_FETCH_CONCURRENCY,
  logger = console,
} = {}) {
  await ensurePropertyContextSchema(pool);
  const sourceKey = "dcad_parcels";
  const { rows: stateRows } = await pool.query(
    "SELECT last_success_at FROM gis.source_sync_state WHERE source_key = $1",
    [sourceKey],
  );
  const effectiveMode = mode === "full" || !stateRows[0]?.last_success_at ? "full" : "incremental";
  const runId = await startRun(pool, {
    sourceKey,
    sourceLabel: "Dallas CAD parcel GIS",
    sourceUrl: DCAD_PARCEL_SYNC_URL,
    sourceVintage: null,
    mode: effectiveMode,
  });
  try {
    const where = effectiveMode === "full"
      ? "1=1"
      : incrementalDcadWhere(stateRows[0]?.last_success_at);
    const objectIds = await fetchArcGisObjectIds(DCAD_PARCEL_SYNC_URL, { where, fetchImpl });
    if (effectiveMode === "full" && objectIds.length < 100_000) {
      throw new Error(`property_context_dcad_full_sync_incomplete_${objectIds.length}`);
    }
    logger.log(`[property-context] DCAD ${effectiveMode} sync found ${objectIds.length.toLocaleString()} object ids`);
    const progress = await fetchAndWriteBatches({
      objectIds,
      batchSize,
      concurrency,
      fetchBatch: (ids) => fetchArcGisFeatures(DCAD_PARCEL_SYNC_URL, {
        objectIds: ids,
        outFields: DCAD_SYNC_FIELDS,
        fetchImpl,
      }),
      normalizeFeature: (feature) => normalizeDcadParcelFeature(feature, runId),
      writeBatch: (records) => upsertDcadParcels(pool, records),
      onCheckpoint: (checkpoint) => updateRunCheckpoint(
        pool,
        runId,
        sourceKey,
        checkpoint,
        checkpoint.seen,
        checkpoint.written,
      ),
    });
    let deleted = 0;
    if (effectiveMode === "full") {
      const deletedResult = await pool.query(
        "DELETE FROM gis.dcad_parcels WHERE sync_run_id IS DISTINCT FROM $1",
        [runId],
      );
      deleted = deletedResult.rowCount || 0;
    }
    const { rows: countRows } = await pool.query(
      "SELECT COUNT(*)::bigint AS count, MAX(source_updated_at) AS max_source_updated_at FROM gis.dcad_parcels",
    );
    await completeRun(pool, {
      runId,
      sourceKey,
      rowCount: Number(countRows[0]?.count || 0),
      seen: progress.seen,
      written: progress.written,
      deleted,
      lastSourceUpdateAt: countRows[0]?.max_source_updated_at || null,
      metadata: { mode: effectiveMode, batch_size: batchSize },
    });
    return { source_key: sourceKey, run_id: runId, mode: effectiveMode, deleted, ...progress };
  } catch (error) {
    await failRun(pool, { runId, sourceKey, error }).catch(() => {});
    throw error;
  }
}

async function syncTigerRoadLayer(pool, layer, {
  fetchImpl,
  batchSize,
  concurrency,
  sourceVintage,
  logger,
}) {
  const sourceUrl = `${TIGER_ROAD_SERVICE_URL}/${layer.id}/query`;
  const runId = await startRun(pool, {
    sourceKey: layer.sourceKey,
    sourceLabel: layer.label,
    sourceUrl,
    sourceVintage,
    mode: "full",
  });
  try {
    const objectIds = await fetchArcGisObjectIds(sourceUrl, {
      geometry: DALLAS_COUNTY_QUERY_ENVELOPE,
      fetchImpl,
    });
    if (!objectIds.length) {
      throw new Error(`property_context_${layer.sourceKey}_full_sync_empty`);
    }
    logger.log(`[property-context] ${layer.label} sync found ${objectIds.length.toLocaleString()} object ids`);
    const progress = await fetchAndWriteBatches({
      objectIds,
      batchSize,
      concurrency,
      fetchBatch: (ids) => fetchArcGisFeatures(sourceUrl, {
        objectIds: ids,
        outFields: tigerRoadOutFields(layer.id),
        fetchImpl,
      }),
      normalizeFeature: (feature) => normalizeRoadFeature(feature, {
        runId,
        sourceLayer: layer.sourceKey,
        roadClass: layer.roadClass,
        sourceVintage,
      }),
      writeBatch: (records) => upsertRoadSegments(pool, records),
      onCheckpoint: (checkpoint) => updateRunCheckpoint(
        pool,
        runId,
        layer.sourceKey,
        checkpoint,
        checkpoint.seen,
        checkpoint.written,
      ),
    });
    const deletedResult = await pool.query(
      "DELETE FROM gis.road_segments WHERE source_layer = $1 AND sync_run_id IS DISTINCT FROM $2",
      [layer.sourceKey, runId],
    );
    const { rows: countRows } = await pool.query(
      "SELECT COUNT(*)::bigint AS count FROM gis.road_segments WHERE source_layer = $1",
      [layer.sourceKey],
    );
    await completeRun(pool, {
      runId,
      sourceKey: layer.sourceKey,
      rowCount: Number(countRows[0]?.count || 0),
      seen: progress.seen,
      written: progress.written,
      deleted: deletedResult.rowCount || 0,
      metadata: { envelope: DALLAS_COUNTY_QUERY_ENVELOPE, batch_size: batchSize },
    });
    return {
      source_key: layer.sourceKey,
      run_id: runId,
      mode: "full",
      deleted: deletedResult.rowCount || 0,
      ...progress,
    };
  } catch (error) {
    await failRun(pool, { runId, sourceKey: layer.sourceKey, error }).catch(() => {});
    throw error;
  }
}

export async function syncTigerRoadContext(pool, {
  fetchImpl = fetch,
  batchSize = 5_000,
  concurrency = DEFAULT_FETCH_CONCURRENCY,
  sourceVintage = process.env.TIGER_ROAD_VINTAGE || String(new Date().getFullYear() - 1),
  logger = console,
} = {}) {
  await ensurePropertyContextSchema(pool);
  const results = [];
  for (const layer of ROAD_LAYERS) {
    results.push(await syncTigerRoadLayer(pool, layer, {
      fetchImpl,
      batchSize,
      concurrency,
      sourceVintage,
      logger,
    }));
  }
  return results;
}

export async function syncTxdotTrafficContext(pool, {
  fetchImpl = fetch,
  batchSize = 1_000,
  concurrency = DEFAULT_FETCH_CONCURRENCY,
  sourceVintage = "current",
  logger = console,
} = {}) {
  await ensurePropertyContextSchema(pool);
  const sourceKey = "txdot_aadt";
  const runId = await startRun(pool, {
    sourceKey,
    sourceLabel: "TxDOT annual average daily traffic",
    sourceUrl: TXDOT_AADT_QUERY_URL,
    sourceVintage,
    mode: "full",
  });
  try {
    const objectIds = await fetchArcGisObjectIds(TXDOT_AADT_QUERY_URL, {
      geometry: DALLAS_COUNTY_QUERY_ENVELOPE,
      fetchImpl,
    });
    if (objectIds.length < 1_000) {
      throw new Error(`property_context_txdot_aadt_full_sync_incomplete_${objectIds.length}`);
    }
    logger.log(`[property-context] TxDOT AADT sync found ${objectIds.length.toLocaleString()} object ids`);
    const progress = await fetchAndWriteBatches({
      objectIds,
      batchSize,
      concurrency,
      fetchBatch: (ids) => fetchArcGisFeatures(TXDOT_AADT_QUERY_URL, {
        objectIds: ids,
        outFields: TXDOT_AADT_FIELDS,
        fetchImpl,
      }),
      normalizeFeature: (feature) => normalizeTrafficVolumeFeature(feature, runId),
      writeBatch: (records) => upsertTrafficVolumeSegments(pool, records),
      onCheckpoint: (checkpoint) => updateRunCheckpoint(
        pool, runId, sourceKey, checkpoint, checkpoint.seen, checkpoint.written,
      ),
    });
    const deletedResult = await pool.query(
      "DELETE FROM gis.traffic_volume_segments WHERE source_key = $1 AND sync_run_id IS DISTINCT FROM $2",
      [sourceKey, runId],
    );
    const { rows } = await pool.query(
      `SELECT COUNT(*)::bigint AS count, MAX(source_date) AS max_source_date
       FROM gis.traffic_volume_segments WHERE source_key = $1`,
      [sourceKey],
    );
    await completeRun(pool, {
      runId,
      sourceKey,
      rowCount: Number(rows[0]?.count || 0),
      seen: progress.seen,
      written: progress.written,
      deleted: deletedResult.rowCount || 0,
      lastSourceUpdateAt: rows[0]?.max_source_date || null,
      metadata: { envelope: DALLAS_COUNTY_QUERY_ENVELOPE, authoritative: true },
    });
    return { source_key: sourceKey, run_id: runId, mode: "full", deleted: deletedResult.rowCount || 0, ...progress };
  } catch (error) {
    await failRun(pool, { runId, sourceKey, error }).catch(() => {});
    throw error;
  }
}

export async function syncFemaFloodContext(pool, {
  fetchImpl = fetch,
  // NFHL polygons can be extremely detailed. Smaller batches avoid transient
  // ArcGIS HTTP 500 responses caused by oversized geometry payloads.
  batchSize = 200,
  concurrency = 1,
  sourceVintage = process.env.FEMA_NFHL_VINTAGE || "effective-current",
  logger = console,
} = {}) {
  await ensurePropertyContextSchema(pool);
  const sourceKey = "fema_nfhl";
  const runId = await startRun(pool, {
    sourceKey,
    sourceLabel: "FEMA National Flood Hazard Layer",
    sourceUrl: FEMA_NFHL_QUERY_URL,
    sourceVintage,
    mode: "full",
  });
  try {
    const objectIds = await fetchArcGisObjectIds(FEMA_NFHL_QUERY_URL, {
      geometry: DALLAS_COUNTY_QUERY_ENVELOPE,
      fetchImpl,
    });
    if (objectIds.length < 1_000) {
      throw new Error(`property_context_fema_nfhl_full_sync_incomplete_${objectIds.length}`);
    }
    logger.log(`[property-context] FEMA NFHL sync found ${objectIds.length.toLocaleString()} object ids`);
    const progress = await fetchAndWriteBatches({
      objectIds,
      batchSize,
      concurrency,
      fetchBatch: (ids) => fetchArcGisFeatures(FEMA_NFHL_QUERY_URL, {
        objectIds: ids,
        outFields: FEMA_NFHL_FIELDS,
        fetchImpl,
      }),
      normalizeFeature: (feature) => normalizeFemaFloodFeature(feature, runId),
      writeBatch: (records) => upsertFloodHazards(pool, records),
      onCheckpoint: (checkpoint) => updateRunCheckpoint(
        pool,
        runId,
        sourceKey,
        checkpoint,
        checkpoint.seen,
        checkpoint.written,
      ),
    });
    const deletedResult = await pool.query(
      "DELETE FROM gis.flood_hazard_areas WHERE source_key = $1 AND sync_run_id IS DISTINCT FROM $2",
      [sourceKey, runId],
    );
    const { rows } = await pool.query(
      "SELECT COUNT(*)::bigint AS count FROM gis.flood_hazard_areas WHERE source_key = $1",
      [sourceKey],
    );
    await completeRun(pool, {
      runId,
      sourceKey,
      rowCount: Number(rows[0]?.count || 0),
      seen: progress.seen,
      written: progress.written,
      deleted: deletedResult.rowCount || 0,
      metadata: { envelope: DALLAS_COUNTY_QUERY_ENVELOPE, layer: 28 },
    });
    return { source_key: sourceKey, run_id: runId, mode: "full", ...progress };
  } catch (error) {
    await failRun(pool, { runId, sourceKey, error }).catch(() => {});
    throw error;
  }
}

async function syncOfficialZoningSource(pool, source, {
  fetchImpl,
  batchSize,
  concurrency,
  logger,
}) {
  const runId = await startRun(pool, {
    sourceKey: source.sourceKey,
    sourceLabel: source.label,
    sourceUrl: source.url,
    sourceVintage: "municipal-current",
    mode: "full",
  });
  try {
    const querySources = source.queryUrls?.length
      ? source.queryUrls
      : [{ url: source.url, recordPrefix: null }];
    const sourceLayers = [];
    for (const querySource of querySources) {
      const objectIds = await fetchArcGisObjectIds(querySource.url, { fetchImpl });
      sourceLayers.push({ ...querySource, objectIds });
    }
    const totalObjectIds = sourceLayers.reduce((sum, layer) => sum + layer.objectIds.length, 0);
    if (!totalObjectIds) {
      throw new Error(`property_context_${source.sourceKey}_full_sync_empty`);
    }
    logger.log(`[property-context] ${source.label} sync found ${totalObjectIds.toLocaleString()} object ids`);
    const progress = { seen: 0, written: 0 };
    for (const layer of sourceLayers) {
      const completedBefore = { ...progress };
      const layerProgress = await fetchAndWriteBatches({
        objectIds: layer.objectIds,
        batchSize,
        concurrency,
        fetchBatch: (ids) => fetchArcGisFeatures(layer.url, {
          objectIds: ids,
          outFields: source.outFields,
          fetchImpl,
        }),
        normalizeFeature: (feature) => normalizeOfficialZoningFeature(feature, runId, {
          ...source,
          sourceRecordPrefix: layer.recordPrefix || null,
        }),
        writeBatch: (records) => upsertZoningDistricts(pool, records),
        onCheckpoint: (checkpoint) => updateRunCheckpoint(
          pool,
          runId,
          source.sourceKey,
          {
            ...checkpoint,
            layer_url: layer.url,
            layer_record_prefix: layer.recordPrefix || null,
            seen: completedBefore.seen + checkpoint.seen,
            written: completedBefore.written + checkpoint.written,
          },
          completedBefore.seen + checkpoint.seen,
          completedBefore.written + checkpoint.written,
        ),
      });
      progress.seen += layerProgress.seen;
      progress.written += layerProgress.written;
    }
    const deletedResult = await pool.query(
      "DELETE FROM gis.zoning_districts WHERE provider_key = $1 AND sync_run_id IS DISTINCT FROM $2",
      [source.providerKey, runId],
    );
    const { rows } = await pool.query(
      "SELECT COUNT(*)::bigint AS count FROM gis.zoning_districts WHERE provider_key = $1",
      [source.providerKey],
    );
    await completeRun(pool, {
      runId,
      sourceKey: source.sourceKey,
      rowCount: Number(rows[0]?.count || 0),
      seen: progress.seen,
      written: progress.written,
      deleted: deletedResult.rowCount || 0,
      metadata: { jurisdiction: source.jurisdiction, provider_key: source.providerKey },
    });
    await pool.query(
      `UPDATE gis.zoning_source_registry
       SET status = 'current', last_success_at = now(), last_error = NULL, updated_at = now()
       WHERE provider_key = $1`,
      [source.providerKey],
    );
    return { source_key: source.sourceKey, run_id: runId, mode: "full", ...progress };
  } catch (error) {
    await failRun(pool, { runId, sourceKey: source.sourceKey, error }).catch(() => {});
    await pool.query(
      `UPDATE gis.zoning_source_registry
       SET status = 'failed', last_error = $2, updated_at = now()
       WHERE provider_key = $1`,
      [source.providerKey, String(error?.message || error).slice(0, 4_000)],
    ).catch(() => {});
    throw error;
  }
}

export async function syncOfficialZoningContext(pool, {
  fetchImpl = fetch,
  batchSize = 1_000,
  concurrency = 2,
  logger = console,
  continueOnError = true,
} = {}) {
  await ensurePropertyContextSchema(pool);
  const results = [];
  for (const source of OFFICIAL_ZONING_SOURCES) {
    try {
      results.push(await syncOfficialZoningSource(pool, source, {
        fetchImpl,
        batchSize,
        concurrency,
        logger,
      }));
    } catch (error) {
      if (!continueOnError) throw error;
      logger.error?.(`[property-context] ${source.label} sync failed; retained last usable data`, error);
      results.push({
        source_key: source.sourceKey,
        mode: "full",
        status: "failed",
        error: String(error?.message || error),
      });
    }
  }
  return results;
}
