const DEFAULT_BOUNDARY_CACHE_TTL_HOURS = 24 * 7;
const schemaReadyByPool = new WeakMap();

export async function ensurePropertyContextSchema(pool) {
  const existing = schemaReadyByPool.get(pool);
  if (existing) return existing;
  const pending = pool.query(`
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
        'propzone_gridics', 'Gridics PropZone zoning fallback',
        'propzone_gridics', 'DFW configured coverage', 50,
        'pending_credentials', NULL, NULL,
        '{"request_path":"scheduled_only","fallback_only":true}'::jsonb
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
  `).catch((error) => {
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
  const { rows } = await pool.query(
    `SELECT source_key, source_label, status, source_url, source_vintage,
            row_count, last_attempt_at, last_success_at, last_source_update_at,
            last_error, metadata
     FROM gis.source_sync_state
     WHERE source_key IN ('dcad_parcels', 'tiger_roads_primary',
                          'tiger_roads_secondary', 'tiger_roads_local',
                          'tiger_railroads', 'fema_nfhl',
                          'zoning_city_dallas_official',
                          'zoning_city_garland_official')
     ORDER BY source_key`,
  );
  const byKey = new Map(rows.map((row) => [row.source_key, row]));
  const expected = [
    ["dcad_parcels", "Dallas CAD parcel GIS", 72],
    ["tiger_roads_primary", "Census TIGER primary roads", 24 * 45],
    ["tiger_roads_secondary", "Census TIGER secondary roads", 24 * 45],
    ["tiger_roads_local", "Census TIGER local roads", 24 * 45],
    ["tiger_railroads", "Census TIGER railroads", 24 * 45],
    ["fema_nfhl", "FEMA National Flood Hazard Layer", 24 * 30],
    ["zoning_city_dallas_official", "City of Dallas official zoning GIS", 24 * 14],
    ["zoning_city_garland_official", "City of Garland official zoning GIS", 24 * 14],
  ];
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
