import { createHash, randomUUID } from "node:crypto";

import {
  classifyDcadLandUse,
  isDcadParcelBuiltUp,
} from "./neighborhoodLandUse.js";
import { ensurePropertyContextSchema } from "./propertyContextStore.js";

export const DCAD_PARCEL_SYNC_URL =
  "https://maps.dcad.org/prdwa/rest/services/Property/ParcelQuery/MapServer/4/query";
export const TIGER_ROAD_SERVICE_URL =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation_LargeScale/MapServer";

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
  { id: 0, sourceKey: "tiger_roads_primary", label: "Census TIGER primary roads", roadClass: "primary" },
  { id: 1, sourceKey: "tiger_roads_secondary", label: "Census TIGER secondary roads", roadClass: "secondary" },
  { id: 2, sourceKey: "tiger_roads_local", label: "Census TIGER local roads", roadClass: "local" },
]);

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
  const numericValue = Number(value);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return new Date(numericValue).toISOString();
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

export async function requestArcGis(url, values, { fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
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

async function startRun(pool, { sourceKey, sourceLabel, sourceUrl, sourceVintage, mode }) {
  const runId = randomUUID();
  await pool.query(
    `INSERT INTO gis.source_sync_runs (id, source_key, mode, status)
     VALUES ($1,$2,$3,'running');
     INSERT INTO gis.source_sync_state (
       source_key, source_label, status, source_url, source_vintage,
       last_attempt_at, last_run_id, last_error
     ) VALUES ($2,$4,'running',$5,$6,now(),$1,NULL)
     ON CONFLICT (source_key) DO UPDATE SET
       source_label = EXCLUDED.source_label,
       status = 'running',
       source_url = EXCLUDED.source_url,
       source_vintage = COALESCE(EXCLUDED.source_vintage, gis.source_sync_state.source_vintage),
       last_attempt_at = now(),
       last_run_id = EXCLUDED.last_run_id,
       last_error = NULL,
       updated_at = now()`,
    [runId, sourceKey, mode, sourceLabel, sourceUrl, sourceVintage],
  );
  return runId;
}

async function updateRunCheckpoint(pool, runId, sourceKey, checkpoint, seen, written) {
  await pool.query(
    `UPDATE gis.source_sync_runs
     SET records_seen = $3, records_written = $4, checkpoint = $5::jsonb
     WHERE id = $1;
     UPDATE gis.source_sync_state
     SET checkpoint = $5::jsonb, updated_at = now()
     WHERE source_key = $2`,
    [runId, sourceKey, seen, written, JSON.stringify(checkpoint)],
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
     SET status = 'complete', records_seen = $3, records_written = $4,
         records_deleted = $5, completed_at = now(), error_message = NULL
     WHERE id = $1;
     UPDATE gis.source_sync_state
     SET status = 'current', row_count = $6, last_success_at = now(),
         last_source_update_at = COALESCE($7::timestamptz, last_source_update_at),
         checkpoint = '{}'::jsonb, last_error = NULL,
         metadata = COALESCE(metadata, '{}'::jsonb) || $8::jsonb,
         updated_at = now()
     WHERE source_key = $2`,
    [
      runId,
      sourceKey,
      seen,
      written,
      deleted,
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
     SET status = 'failed', error_message = $3, completed_at = now()
     WHERE id = $1;
     UPDATE gis.source_sync_state
     SET status = 'failed', last_error = $3, updated_at = now()
     WHERE source_key = $2`,
    [runId, sourceKey, message],
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
        outFields: ROAD_FIELDS,
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
