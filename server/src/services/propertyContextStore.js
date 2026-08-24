import {
  AUTOMATED_ZONING_SOURCE_KEYS,
  DALLAS_COUNTY_ZONING_JURISDICTIONS,
  OFFICIAL_ZONING_SOURCES,
} from "./propertyZoningSources.js";

const DEFAULT_BOUNDARY_CACHE_TTL_HOURS = 24 * 7;
const schemaReadyByPool = new WeakMap();

async function upsertDallasCountyZoningRegistry(pool) {
  const records = DALLAS_COUNTY_ZONING_JURISDICTIONS.map((jurisdiction) => ({
    provider_key: jurisdiction.providerKey,
    provider_label: jurisdiction.providerLabel,
    provider_type: "official_municipal",
    jurisdiction: jurisdiction.city,
    priority: 100,
    status: "registered",
    service_url: jurisdiction.serviceUrl,
    service_layer: jurisdiction.serviceLayer,
    configuration: jurisdiction.configuration,
  }));
  await pool.query(
    `INSERT INTO gis.zoning_source_registry (
       provider_key, provider_label, provider_type, jurisdiction, priority,
       status, service_url, service_layer, configuration
     )
     SELECT provider_key, provider_label, provider_type, jurisdiction, priority,
            status, service_url, service_layer, configuration
     FROM jsonb_to_recordset($1::jsonb) AS source(
       provider_key text, provider_label text, provider_type text,
       jurisdiction text, priority integer, status text, service_url text,
       service_layer integer, configuration jsonb
     )
     ON CONFLICT (provider_key) DO UPDATE SET
       provider_label = EXCLUDED.provider_label,
       provider_type = EXCLUDED.provider_type,
       jurisdiction = EXCLUDED.jurisdiction,
       priority = EXCLUDED.priority,
       status = CASE
         WHEN EXCLUDED.service_url IS NULL THEN 'registered'
         WHEN gis.zoning_source_registry.status = 'current'
          AND gis.zoning_source_registry.service_url IS NOT DISTINCT FROM EXCLUDED.service_url
           THEN 'current'
         ELSE 'registered'
       END,
       service_url = EXCLUDED.service_url,
       service_layer = EXCLUDED.service_layer,
       configuration = EXCLUDED.configuration,
       last_success_at = CASE
         WHEN gis.zoning_source_registry.service_url IS NOT DISTINCT FROM EXCLUDED.service_url
           THEN gis.zoning_source_registry.last_success_at
         ELSE NULL
       END,
       last_error = CASE
         WHEN gis.zoning_source_registry.service_url IS NOT DISTINCT FROM EXCLUDED.service_url
           THEN gis.zoning_source_registry.last_error
         ELSE NULL
       END,
       updated_at = now()`,
    [JSON.stringify(records)],
  );
  await pool.query(
    `UPDATE gis.zoning_source_registry
     SET status = 'pending_credentials', service_url = NULL, service_layer = NULL,
         configuration = '{"request_path":"disabled","fallback_only":true,"disabled_reason":"paid_provider_not_enabled"}'::jsonb,
         last_error = NULL, updated_at = now()
     WHERE provider_key = 'propzone_gridics'`,
  );
}

export async function ensurePropertyContextSchema(pool) {
  const existing = schemaReadyByPool.get(pool);
  if (existing) return existing;
  const pending = (async () => {
    await pool.query(`
    CREATE SCHEMA IF NOT EXISTS gis;
    CREATE SCHEMA IF NOT EXISTS app;

    CREATE TABLE IF NOT EXISTS gis.source_sync_runs (
      id uuid PRIMARY KEY,
      source_key text NOT NULL,
      mode text NOT NULL CHECK (mode IN ('full', 'incremental')),
      status text NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
      records_seen bigint NOT NULL DEFAULT 0,
      records_written bigint NOT NULL DEFAULT 0,
      records_deleted bigint NOT NULL DEFAULT 0,
      checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
      error_message text,
      started_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS property_context_sync_runs_source_idx
      ON gis.source_sync_runs (source_key, started_at DESC);

    CREATE TABLE IF NOT EXISTS gis.source_sync_state (
      source_key text PRIMARY KEY,
      source_label text NOT NULL,
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'current', 'failed')),
      source_url text,
      source_vintage text,
      row_count bigint NOT NULL DEFAULT 0,
      last_attempt_at timestamptz,
      last_success_at timestamptz,
      last_source_update_at timestamptz,
      last_run_id uuid REFERENCES gis.source_sync_runs(id) ON DELETE SET NULL,
      checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
      last_error text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS gis.dcad_parcels (
      object_id bigint PRIMARY KEY,
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
      land_use_category text NOT NULL DEFAULT 'other_vacant',
      classification_confidence text NOT NULL DEFAULT 'low',
      classification_review_reason text,
      built_up boolean NOT NULL DEFAULT false,
      building_area_sqft numeric,
      residential_area_sqft numeric,
      residential_year_built integer,
      land_value numeric,
      improvement_value numeric,
      current_market_value numeric,
      previous_market_value numeric,
      parcel_area_sqft numeric,
      source_updated_at timestamptz,
      source_attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
      source_record_hash text NOT NULL,
      sync_run_id uuid REFERENCES gis.source_sync_runs(id) ON DELETE SET NULL,
      synced_at timestamptz NOT NULL DEFAULT now(),
      geom geometry(MultiPolygon, 4326) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dcad_parcels_account_idx
      ON gis.dcad_parcels (account_id);
    CREATE INDEX IF NOT EXISTS dcad_parcels_low_parcel_idx
      ON gis.dcad_parcels (low_parcel_id);
    CREATE INDEX IF NOT EXISTS dcad_parcels_land_use_idx
      ON gis.dcad_parcels (land_use_category);
    CREATE INDEX IF NOT EXISTS dcad_parcels_source_updated_idx
      ON gis.dcad_parcels (source_updated_at);
    CREATE INDEX IF NOT EXISTS dcad_parcels_geom_gix
      ON gis.dcad_parcels USING gist (geom);

    CREATE TABLE IF NOT EXISTS gis.road_segments (
      source_layer text NOT NULL,
      source_object_id bigint NOT NULL,
      source_oid text,
      name text,
      base_name text,
      mtfcc text,
      route_type text,
      road_class text NOT NULL CHECK (road_class IN ('primary', 'secondary', 'local', 'railroad')),
      source_vintage text,
      source_attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
      source_record_hash text NOT NULL,
      sync_run_id uuid REFERENCES gis.source_sync_runs(id) ON DELETE SET NULL,
      synced_at timestamptz NOT NULL DEFAULT now(),
      geom geometry(MultiLineString, 4326) NOT NULL,
      PRIMARY KEY (source_layer, source_object_id)
    );
    CREATE INDEX IF NOT EXISTS road_segments_name_idx
      ON gis.road_segments (upper(name));
    CREATE INDEX IF NOT EXISTS road_segments_class_idx
      ON gis.road_segments (road_class);
    CREATE INDEX IF NOT EXISTS road_segments_geom_gix
      ON gis.road_segments USING gist (geom);

    -- Durable road identity and topology.  Aliases let an appraiser or a sync
    -- source declare that differently named portions are one continuous
    -- corridor; graph nodes/edges make closed roadway enclosures queryable.
    CREATE TABLE IF NOT EXISTS gis.road_corridor_aliases (
      normalized_alias text PRIMARY KEY,
      corridor_key text NOT NULL,
      canonical_name text NOT NULL,
      source text NOT NULL DEFAULT 'reviewed',
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS gis.road_corridors (
      corridor_key text PRIMARY KEY,
      canonical_name text NOT NULL,
      aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
      road_class text,
      segment_count integer NOT NULL DEFAULT 0,
      rebuilt_at timestamptz NOT NULL DEFAULT now(),
      geom geometry(MultiLineString, 4326) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS road_corridors_geom_gix
      ON gis.road_corridors USING gist (geom);
    CREATE TABLE IF NOT EXISTS gis.road_graph_nodes (
      node_key text PRIMARY KEY,
      geom geometry(Point, 4326) NOT NULL,
      rebuilt_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS road_graph_nodes_geom_gix
      ON gis.road_graph_nodes USING gist (geom);
    CREATE TABLE IF NOT EXISTS gis.road_graph_edges (
      source_layer text NOT NULL,
      source_object_id bigint NOT NULL,
      part_index integer NOT NULL,
      corridor_key text NOT NULL,
      from_node_key text NOT NULL,
      to_node_key text NOT NULL,
      road_name text,
      road_class text,
      geom geometry(LineString, 4326) NOT NULL,
      rebuilt_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (source_layer, source_object_id, part_index)
    );
    CREATE INDEX IF NOT EXISTS road_graph_edges_corridor_idx
      ON gis.road_graph_edges (corridor_key);
    CREATE INDEX IF NOT EXISTS road_graph_edges_nodes_idx
      ON gis.road_graph_edges (from_node_key, to_node_key);
    CREATE INDEX IF NOT EXISTS road_graph_edges_geom_gix
      ON gis.road_graph_edges USING gist (geom);

    CREATE TABLE IF NOT EXISTS gis.traffic_volume_segments (
      source_key text NOT NULL DEFAULT 'txdot_aadt',
      source_object_id bigint NOT NULL,
      route_name text,
      route_prefix text,
      route_number text,
      roadway_type text,
      current_aadt integer,
      source_date timestamptz,
      source_attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
      source_record_hash text NOT NULL,
      sync_run_id uuid REFERENCES gis.source_sync_runs(id) ON DELETE SET NULL,
      synced_at timestamptz NOT NULL DEFAULT now(),
      geom geometry(MultiLineString, 4326) NOT NULL,
      PRIMARY KEY (source_key, source_object_id)
    );
    CREATE INDEX IF NOT EXISTS traffic_volume_segments_aadt_idx
      ON gis.traffic_volume_segments (current_aadt DESC);
    CREATE INDEX IF NOT EXISTS traffic_volume_segments_geom_gix
      ON gis.traffic_volume_segments USING gist (geom);

    CREATE TABLE IF NOT EXISTS gis.zoning_source_registry (
      provider_key text PRIMARY KEY,
      provider_label text NOT NULL,
      provider_type text NOT NULL
        CHECK (provider_type IN ('official_municipal', 'propzone_gridics')),
      jurisdiction text NOT NULL,
      priority integer NOT NULL,
      status text NOT NULL DEFAULT 'registered'
        CHECK (status IN ('registered', 'configured', 'current', 'failed', 'pending_credentials')),
      service_url text,
      service_layer integer,
      configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
      last_success_at timestamptz,
      last_error text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO gis.zoning_source_registry (
      provider_key, provider_label, provider_type, jurisdiction, priority,
      status, service_url, service_layer, configuration
    ) VALUES
      (
        'city_dallas_official', 'City of Dallas official zoning GIS',
        'official_municipal', 'Dallas', 100, 'registered',
        'https://gis.dallascityhall.com/arcgis/rest/services/sdc_public/Zoning/MapServer/15/query',
        15, '{"zoning_code_fields":["LONG_ZONE_DIST","ZONE_DIST"]}'::jsonb
      ),
      (
        'city_garland_official', 'City of Garland official zoning GIS',
        'official_municipal', 'Garland', 100, 'registered',
        'https://maps.garlandtx.gov/arcgis/rest/services/CityMap_Other/GDC_Zoning/MapServer/1/query',
        1, '{"zoning_code_fields":["BASE_ZONE","GDC_ZONING"]}'::jsonb
      ),
      (
        'city_farmers_branch_official', 'City of Farmers Branch official zoning GIS',
        'official_municipal', 'Farmers Branch', 100, 'registered',
        'https://services1.arcgis.com/rrMt0tlqg3eYOL0M/arcgis/rest/services/Zoning_public/FeatureServer/0/query',
        0, '{"zoning_code_fields":["ZONECLASS","CITYPDDIST"]}'::jsonb
      ),
      (
        'city_richardson_official', 'City of Richardson official zoning GIS',
        'official_municipal', 'Richardson', 100, 'registered',
        'https://maps.cor.gov/arcgis/rest/services/DevelopmentServices/ZoningDistricts/MapServer/1/query',
        1, '{"zoning_code_fields":["ZONECLASS","CZO"]}'::jsonb
      ),
      (
        'city_desoto_official', 'City of DeSoto official zoning GIS',
        'official_municipal', 'DeSoto', 100, 'registered',
        'https://services8.arcgis.com/QHqdbIhWBJLlMbGN/arcgis/rest/services/Zoning_DeSoto/FeatureServer/0/query',
        0, '{"zoning_code_fields":["Zone_Code","ZONECLASS"]}'::jsonb
      ),
      (
        'propzone_gridics', 'Gridics PropZone zoning fallback',
        'propzone_gridics', 'DFW configured coverage', 50,
        'pending_credentials', NULL, NULL,
        '{"request_path":"disabled","fallback_only":true,"disabled_reason":"paid_provider_not_enabled"}'::jsonb
      )
    ON CONFLICT (provider_key) DO NOTHING;

    CREATE TABLE IF NOT EXISTS gis.zoning_districts (
      provider_key text NOT NULL
        REFERENCES gis.zoning_source_registry(provider_key) ON DELETE CASCADE,
      source_record_id text NOT NULL,
      jurisdiction text NOT NULL,
      zoning_code text,
      zoning_description text,
      generalized_use text,
      overlays jsonb NOT NULL DEFAULT '[]'::jsonb,
      source_attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
      source_record_hash text NOT NULL,
      source_updated_at timestamptz,
      sync_run_id uuid REFERENCES gis.source_sync_runs(id) ON DELETE SET NULL,
      synced_at timestamptz NOT NULL DEFAULT now(),
      geom geometry(MultiPolygon, 4326) NOT NULL,
      PRIMARY KEY (provider_key, source_record_id)
    );
    CREATE INDEX IF NOT EXISTS zoning_districts_jurisdiction_idx
      ON gis.zoning_districts (upper(jurisdiction), provider_key);
    CREATE INDEX IF NOT EXISTS zoning_districts_geom_gix
      ON gis.zoning_districts USING gist (geom);

    CREATE TABLE IF NOT EXISTS gis.flood_hazard_areas (
      source_key text NOT NULL DEFAULT 'fema_nfhl',
      source_record_id text NOT NULL,
      flood_zone text,
      zone_subtype text,
      special_flood_hazard boolean,
      static_base_flood_elevation numeric,
      source_attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
      source_record_hash text NOT NULL,
      source_updated_at timestamptz,
      sync_run_id uuid REFERENCES gis.source_sync_runs(id) ON DELETE SET NULL,
      synced_at timestamptz NOT NULL DEFAULT now(),
      geom geometry(MultiPolygon, 4326) NOT NULL,
      PRIMARY KEY (source_key, source_record_id)
    );
    CREATE INDEX IF NOT EXISTS flood_hazard_areas_zone_idx
      ON gis.flood_hazard_areas (flood_zone, special_flood_hazard);
    CREATE INDEX IF NOT EXISTS flood_hazard_areas_geom_gix
      ON gis.flood_hazard_areas USING gist (geom);

    CREATE TABLE IF NOT EXISTS gis.property_influence_contexts (
      account_id text PRIMARY KEY,
      parcel_object_id bigint,
      methodology_version integer NOT NULL,
      spatial_context jsonb NOT NULL,
      influence_signature jsonb NOT NULL,
      material_influence_present boolean NOT NULL DEFAULT false,
      dominant_influence_key text NOT NULL DEFAULT 'ordinary_location',
      material_keys text[] NOT NULL DEFAULT '{}'::text[],
      material_categories text[] NOT NULL DEFAULT '{}'::text[],
      source_state jsonb NOT NULL DEFAULT '{}'::jsonb,
      computed_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS property_influence_contexts_material_idx
      ON gis.property_influence_contexts (material_influence_present, dominant_influence_key);
    CREATE INDEX IF NOT EXISTS property_influence_contexts_keys_gin
      ON gis.property_influence_contexts USING gin (material_keys);
    CREATE INDEX IF NOT EXISTS property_influence_contexts_categories_gin
      ON gis.property_influence_contexts USING gin (material_categories);
    CREATE INDEX IF NOT EXISTS property_influence_contexts_computed_idx
      ON gis.property_influence_contexts (computed_at);

    -- Keep every methodology revision instead of replacing the previous
    -- evidence while a new countywide backfill is still in progress. The
    -- single-row table above remains the fast current lookup used by ranking.
    CREATE TABLE IF NOT EXISTS gis.property_influence_context_versions (
      account_id text NOT NULL,
      methodology_version integer NOT NULL,
      parcel_object_id bigint,
      spatial_context jsonb NOT NULL,
      influence_signature jsonb NOT NULL,
      material_influence_present boolean NOT NULL DEFAULT false,
      dominant_influence_key text NOT NULL DEFAULT 'ordinary_location',
      material_keys text[] NOT NULL DEFAULT '{}'::text[],
      material_categories text[] NOT NULL DEFAULT '{}'::text[],
      source_state jsonb NOT NULL DEFAULT '{}'::jsonb,
      computed_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (account_id, methodology_version)
    );
    CREATE INDEX IF NOT EXISTS property_influence_versions_method_idx
      ON gis.property_influence_context_versions (methodology_version, computed_at);
    CREATE INDEX IF NOT EXISTS property_influence_versions_keys_gin
      ON gis.property_influence_context_versions USING gin (material_keys);
    INSERT INTO gis.property_influence_context_versions (
      account_id, methodology_version, parcel_object_id, spatial_context,
      influence_signature, material_influence_present,
      dominant_influence_key, material_keys, material_categories,
      source_state, computed_at, updated_at
    )
    SELECT account_id, methodology_version, parcel_object_id, spatial_context,
           influence_signature, material_influence_present,
           dominant_influence_key, material_keys, material_categories,
           source_state, computed_at, updated_at
    FROM gis.property_influence_contexts
    ON CONFLICT (account_id, methodology_version) DO NOTHING;

    CREATE TABLE IF NOT EXISTS gis.property_influence_queue (
      account_id text PRIMARY KEY,
      reason text NOT NULL,
      priority integer NOT NULL DEFAULT 10,
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'retry', 'completed', 'manual_review')),
      attempts integer NOT NULL DEFAULT 0,
      available_at timestamptz NOT NULL DEFAULT now(),
      locked_at timestamptz,
      locked_by text,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS property_influence_queue_claim_idx
      ON gis.property_influence_queue (status, available_at, priority DESC, updated_at);

    -- Any importer can write sales without knowing about the maintenance
    -- worker. This trigger makes a newly matched or rematched sale immediately
    -- eligible for location-influence calculation.
    CREATE OR REPLACE FUNCTION gis.queue_property_influence_for_sale()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $property_influence_trigger$
    DECLARE
      candidate_account_id text;
      previous_account_id text;
    BEGIN
      candidate_account_id := COALESCE(
        NULLIF(BTRIM(to_jsonb(NEW)->>'primary_account_id'), ''),
        NULLIF(BTRIM(to_jsonb(NEW)->>'account_id'), '')
      );
      IF TG_OP = 'UPDATE' THEN
        previous_account_id := COALESCE(
          NULLIF(BTRIM(to_jsonb(OLD)->>'primary_account_id'), ''),
          NULLIF(BTRIM(to_jsonb(OLD)->>'account_id'), '')
        );
        IF previous_account_id IS NOT DISTINCT FROM candidate_account_id THEN
          RETURN NEW;
        END IF;
      END IF;
      IF candidate_account_id ~ '^[0-9A-Za-z]{17}$' THEN
        INSERT INTO gis.property_influence_queue (
          account_id, reason, priority, status, available_at
        ) VALUES (
          candidate_account_id, 'sale_inventory_change', 120, 'pending', now()
        )
        ON CONFLICT (account_id) DO UPDATE SET
          reason = EXCLUDED.reason,
          priority = GREATEST(gis.property_influence_queue.priority, EXCLUDED.priority),
          status = CASE
            WHEN gis.property_influence_queue.status = 'processing'
              THEN gis.property_influence_queue.status
            ELSE 'pending'
          END,
          available_at = CASE
            WHEN gis.property_influence_queue.status = 'processing'
              THEN gis.property_influence_queue.available_at
            ELSE now()
          END,
          completed_at = NULL,
          updated_at = now();
      END IF;
      RETURN NEW;
    END;
    $property_influence_trigger$;

    DO $property_influence_triggers$
    BEGIN
      IF to_regclass('core.sales_source_records') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'queue_property_influence_on_source_sale'
          AND tgrelid = to_regclass('core.sales_source_records')
          AND NOT tgisinternal
      ) THEN
        EXECUTE 'CREATE TRIGGER queue_property_influence_on_source_sale
          AFTER INSERT OR UPDATE OF primary_account_id ON core.sales_source_records
          FOR EACH ROW WHEN (NEW.record_type = ''closed_sale'')
          EXECUTE FUNCTION gis.queue_property_influence_for_sale()';
      END IF;
      IF to_regclass('core.sales') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'queue_property_influence_on_canonical_sale'
          AND tgrelid = to_regclass('core.sales')
          AND NOT tgisinternal
      ) THEN
        EXECUTE 'CREATE TRIGGER queue_property_influence_on_canonical_sale
          AFTER INSERT OR UPDATE OF account_id ON core.sales
          FOR EACH ROW EXECUTE FUNCTION gis.queue_property_influence_for_sale()';
      END IF;
    END;
    $property_influence_triggers$;

    CREATE TABLE IF NOT EXISTS gis.boundary_analysis_cache (
      cache_key text PRIMARY KEY,
      subject_account_id text NOT NULL,
      boundary_signature text NOT NULL,
      analysis_type text NOT NULL,
      boundary jsonb NOT NULL,
      result jsonb NOT NULL,
      source_state jsonb NOT NULL DEFAULT '{}'::jsonb,
      analyzed_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      last_accessed_at timestamptz NOT NULL DEFAULT now(),
      access_count bigint NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS boundary_analysis_subject_idx
      ON gis.boundary_analysis_cache (subject_account_id, analysis_type, analyzed_at DESC);

    CREATE TABLE IF NOT EXISTS app.property_complexity_assessments (
      id bigserial PRIMARY KEY,
      account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      scope_key text NOT NULL DEFAULT 'property',
      assignment_file_id bigint,
      automatic_complexity text NOT NULL
        CHECK (automatic_complexity IN ('simple', 'moderate', 'complex')),
      automatic_score numeric NOT NULL,
      confidence text NOT NULL CHECK (confidence IN ('high', 'moderate', 'limited')),
      geography text NOT NULL,
      automatic_assessment jsonb NOT NULL,
      appraiser_complexity text
        CHECK (appraiser_complexity IS NULL OR appraiser_complexity IN ('simple', 'moderate', 'complex')),
      appraiser_notes text,
      reviewer text,
      reviewed_at timestamptz,
      computed_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (account_id, scope_key)
    );
    CREATE INDEX IF NOT EXISTS property_complexity_account_updated_idx
      ON app.property_complexity_assessments (account_id, updated_at DESC);
    `);
    await upsertDallasCountyZoningRegistry(pool);
  })().catch((error) => {
    schemaReadyByPool.delete(pool);
    throw error;
  });
  schemaReadyByPool.set(pool, pending);
  return pending;
}

function sourceAgeHours(value, now = Date.now()) {
  const timestamp = new Date(value || 0).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return Math.max(0, (now - timestamp) / 3_600_000);
}

export function normalizeSourceHealth(row, { staleAfterHours, now = Date.now() }) {
  const rowCount = Number(row?.row_count || 0);
  const ageHours = sourceAgeHours(row?.last_success_at, now);
  const usable = rowCount > 0 && ageHours !== null;
  const failed = row?.status === "failed";
  const stale = usable && (failed || ageHours > staleAfterHours);
  return {
    source_key: row?.source_key || "unknown",
    label: row?.source_label || row?.source_key || "Unknown source",
    status: !usable ? "unavailable" : stale ? "stale" : "current",
    usable,
    serving_stale_data: stale,
    row_count: rowCount,
    last_attempt_at: row?.last_attempt_at || null,
    last_success_at: row?.last_success_at || null,
    last_source_update_at: row?.last_source_update_at || null,
    age_hours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
    stale_after_hours: staleAfterHours,
    source_url: row?.source_url || null,
    source_vintage: row?.source_vintage || null,
    last_error: row?.last_error || null,
  };
}

export async function getPropertyContextSourceHealth(pool, { now = Date.now() } = {}) {
  const expected = [
    ["dcad_parcels", "Dallas CAD parcel GIS", 72],
    ["tiger_roads_primary", "Census TIGER primary roads", 24 * 45],
    ["tiger_roads_secondary", "Census TIGER secondary roads", 24 * 45],
    ["tiger_roads_local", "Census TIGER local roads", 24 * 45],
    ["tiger_railroads", "Census TIGER railroads", 24 * 45],
    ["txdot_aadt", "TxDOT annual average daily traffic", 24 * 45],
    ["fema_nfhl", "FEMA National Flood Hazard Layer", 24 * 30],
    ...OFFICIAL_ZONING_SOURCES.map((source) => [source.sourceKey, source.label, 24 * 14]),
  ];
  const { rows } = await pool.query(
    `SELECT source_key, source_label, status, source_url, source_vintage,
            row_count, last_attempt_at, last_success_at, last_source_update_at,
            last_error, metadata
     FROM gis.source_sync_state
     WHERE source_key = ANY($1::text[])
     ORDER BY source_key`,
    [[
      "dcad_parcels",
      "tiger_roads_primary",
      "tiger_roads_secondary",
      "tiger_roads_local",
      "tiger_railroads",
      "txdot_aadt",
      "fema_nfhl",
      ...AUTOMATED_ZONING_SOURCE_KEYS,
    ]],
  );
  const byKey = new Map(rows.map((row) => [row.source_key, row]));
  return expected.map(([sourceKey, label, staleAfterHours]) => normalizeSourceHealth(
    byKey.get(sourceKey) || { source_key: sourceKey, source_label: label },
    { staleAfterHours, now },
  ));
}

export async function readBoundaryAnalysisCache(
  pool,
  cacheKey,
  { allowExpired = false, now = new Date() } = {},
) {
  const { rows } = await pool.query(
    `UPDATE gis.boundary_analysis_cache
     SET last_accessed_at = now(), access_count = access_count + 1
     WHERE cache_key = $1
       AND ($2::boolean OR expires_at > $3::timestamptz)
     RETURNING result, source_state, analyzed_at, expires_at`,
    [cacheKey, allowExpired, now.toISOString()],
  );
  if (!rows.length || !rows[0]?.result) return null;
  return {
    result: rows[0].result,
    source_state: rows[0].source_state,
    analyzed_at: rows[0].analyzed_at,
    expires_at: rows[0].expires_at,
    expired: new Date(rows[0].expires_at).getTime() <= now.getTime(),
  };
}

export async function writeBoundaryAnalysisCache(
  pool,
  {
    cacheKey,
    subjectAccountId,
    boundarySignature,
    analysisType,
    boundary,
    result,
    sourceState = {},
    ttlHours = DEFAULT_BOUNDARY_CACHE_TTL_HOURS,
  },
) {
  await pool.query(
    `INSERT INTO gis.boundary_analysis_cache (
       cache_key, subject_account_id, boundary_signature, analysis_type,
       boundary, result, source_state, analyzed_at, expires_at
     ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,now(),
               now() + ($8::text || ' hours')::interval)
     ON CONFLICT (cache_key) DO UPDATE SET
       boundary = EXCLUDED.boundary,
       result = EXCLUDED.result,
       source_state = EXCLUDED.source_state,
       analyzed_at = EXCLUDED.analyzed_at,
       expires_at = EXCLUDED.expires_at,
       last_accessed_at = now(),
       access_count = gis.boundary_analysis_cache.access_count + 1`,
    [
      cacheKey,
      subjectAccountId,
      boundarySignature,
      analysisType,
      JSON.stringify(boundary),
      JSON.stringify(result),
      JSON.stringify(sourceState),
      ttlHours,
    ],
  );
}

function scopeKey(assignmentFileId) {
  const parsed = Number(assignmentFileId);
  return Number.isSafeInteger(parsed) && parsed > 0 ? `assignment:${parsed}` : "property";
}

function assessmentResponse(row) {
  if (!row) return null;
  const automatic = row.automatic_assessment || {};
  const effectiveComplexity = row.appraiser_complexity || row.automatic_complexity;
  return {
    ...automatic,
    id: Number(row.id),
    account_id: row.account_id,
    scope_key: row.scope_key,
    assignment_file_id: row.assignment_file_id == null ? null : Number(row.assignment_file_id),
    automatic_complexity: row.automatic_complexity,
    effective_complexity: effectiveComplexity,
    score: Number(row.automatic_score),
    confidence: row.confidence,
    geography: row.geography,
    recommended_search_profile: `${row.geography}_${effectiveComplexity}`,
    review_status: row.appraiser_complexity
      ? row.appraiser_complexity === row.automatic_complexity ? "reviewed" : "overridden"
      : "automatic",
    appraiser_complexity: row.appraiser_complexity,
    appraiser_notes: row.appraiser_notes,
    reviewer: row.reviewer,
    reviewed_at: row.reviewed_at,
    computed_at: row.computed_at,
    updated_at: row.updated_at,
  };
}

export async function saveAutomaticPropertyComplexityAssessment(
  pool,
  { accountId, assignmentFileId = null, assessment },
) {
  const key = scopeKey(assignmentFileId);
  const parsedAssignmentId = key === "property" ? null : Number(assignmentFileId);
  const { rows } = await pool.query(
    `INSERT INTO app.property_complexity_assessments (
       account_id, scope_key, assignment_file_id, automatic_complexity,
       automatic_score, confidence, geography, automatic_assessment, computed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::timestamptz)
     ON CONFLICT (account_id, scope_key) DO UPDATE SET
       assignment_file_id = EXCLUDED.assignment_file_id,
       automatic_complexity = EXCLUDED.automatic_complexity,
       automatic_score = EXCLUDED.automatic_score,
       confidence = EXCLUDED.confidence,
       geography = EXCLUDED.geography,
       automatic_assessment = EXCLUDED.automatic_assessment,
       computed_at = EXCLUDED.computed_at,
       updated_at = now()
     RETURNING *`,
    [
      accountId,
      key,
      parsedAssignmentId,
      assessment.automatic_complexity,
      assessment.score,
      assessment.confidence,
      assessment.geography,
      JSON.stringify(assessment),
      assessment.computed_at,
    ],
  );
  return assessmentResponse(rows[0]);
}

export async function getLatestPropertyComplexityAssessment(
  pool,
  accountId,
  { assignmentFileId = null } = {},
) {
  const key = scopeKey(assignmentFileId);
  const { rows } = await pool.query(
    `SELECT *
     FROM app.property_complexity_assessments
     WHERE account_id = $1
       AND ($2::text = 'property' OR scope_key IN ($2, 'property'))
     ORDER BY (scope_key = $2) DESC, updated_at DESC
     LIMIT 1`,
    [accountId, key],
  );
  return assessmentResponse(rows[0]);
}

export async function savePropertyComplexityReview(
  pool,
  { accountId, assignmentFileId = null, complexity, notes, reviewer },
) {
  const key = scopeKey(assignmentFileId);
  const { rows } = await pool.query(
    `UPDATE app.property_complexity_assessments
     SET appraiser_complexity = $3,
         appraiser_notes = NULLIF($4, ''),
         reviewer = $5,
         reviewed_at = now(),
         updated_at = now()
     WHERE account_id = $1 AND scope_key = $2
     RETURNING *`,
    [accountId, key, complexity, notes || "", reviewer],
  );
  if (!rows.length && key !== "property") {
    const propertyAssessment = await getLatestPropertyComplexityAssessment(pool, accountId);
    if (!propertyAssessment) return null;
    const copied = await saveAutomaticPropertyComplexityAssessment(pool, {
      accountId,
      assignmentFileId,
      assessment: propertyAssessment,
    });
    return savePropertyComplexityReview(pool, {
      accountId,
      assignmentFileId,
      complexity,
      notes,
      reviewer,
    });
  }
  return assessmentResponse(rows[0]);
}
