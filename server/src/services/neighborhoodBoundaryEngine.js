import { createHash } from "node:crypto";

import { resolveComparableSearchProfile } from "../util/comparableSearchProfiles.js";
import { ensureAssignmentFilesSchema } from "./assignmentFiles.js";
import { loadBoundaryStreetNames } from "./boundaryStreets.js";
import {
  ensurePropertyContextSchema,
  getPropertyContextSourceHealth,
} from "./propertyContextStore.js";
import { NEIGHBORHOOD_BOUNDARY_DISCLOSURE } from "./neighborhoodRelevance.js";

export const NEIGHBORHOOD_BOUNDARY_METHODOLOGY_VERSION = 2;

// TODO(neighborhood-boundary-validation): Test automated boundary suggestions on
// representative properties in multiple Dallas County cities and urban,
// suburban, semi-rural, and rural settings before treating these road-selection
// thresholds and reporting aliases as stable appraisal methodology.

const METERS_PER_MILE = 1609.344;
const MAX_BOUNDARY_POINTS = 2500;
const MINIMUM_BOUNDARY_BUFFER_METERS = 120;
const schemaReadyByPool = new WeakMap();

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizedAccountId(value) {
  const accountId = String(value || "").trim();
  if (!accountId || accountId.length > 100 || /[\u0000-\u001f\u007f]/.test(accountId)) {
    throw new Error("invalid_account_id");
  }
  return accountId;
}

function assessmentScopeKey(assignmentFileId) {
  return assignmentFileId ? `assignment:${assignmentFileId}` : "property";
}

function confidenceFromEvidence({ candidateCount, physicalCoverage, roadEvidence, zoningEvidence }) {
  const cardinalRoads = Object.values(roadEvidence?.cardinal_boundaries || {})
    .filter((side) => side?.primary_street).length;
  const roadConfidence = Object.values(roadEvidence?.cardinal_boundaries || {})
    .filter((side) => ["high", "medium"].includes(side?.confidence)).length;
  const zoningAvailable = Boolean(zoningEvidence?.subject?.zoning_code);
  if (
    candidateCount >= 100 && physicalCoverage >= 0.75 && cardinalRoads >= 3 &&
    roadConfidence >= 2 && zoningAvailable
  ) {
    return "high";
  }
  if (candidateCount >= 30 && physicalCoverage >= 0.50 && cardinalRoads >= 2) {
    return "moderate";
  }
  return "limited";
}

function inputSignature(input) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function boundaryResponse(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    account_id: row.account_id,
    scope_key: row.scope_key,
    assignment_file_id: row.assignment_file_id == null
      ? null
      : Number(row.assignment_file_id),
    methodology_version: Number(row.methodology_version),
    status: row.status,
    search_profile: row.search_profile,
    discovery_radius_miles: Number(row.discovery_radius_miles),
    input_signature: row.input_signature,
    boundary: row.boundary_geojson,
    evidence: row.evidence || {},
    source_state: row.source_state || {},
    confidence: row.confidence,
    review_required: row.review_required,
    reviewer: row.reviewer || null,
    review_notes: row.review_notes || null,
    confirmed_at: row.confirmed_at || null,
    generated_at: row.generated_at,
    updated_at: row.updated_at,
  };
}

export async function ensureNeighborhoodBoundarySchema(pool) {
  const existing = schemaReadyByPool.get(pool);
  if (existing) return existing;
  const pending = (async () => {
    await ensureAssignmentFilesSchema(pool);
    await ensurePropertyContextSchema(pool);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app.neighborhood_boundary_assessments (
        id bigserial PRIMARY KEY,
        account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
        scope_key text NOT NULL DEFAULT 'property',
        assignment_file_id bigint REFERENCES app.assignment_files(id) ON DELETE CASCADE,
        methodology_version integer NOT NULL,
        status text NOT NULL DEFAULT 'generated'
          CHECK (status IN ('generated', 'confirmed', 'rejected', 'superseded')),
        search_profile text NOT NULL,
        discovery_radius_miles numeric NOT NULL,
        input_signature text NOT NULL,
        boundary geometry(Polygon, 4326) NOT NULL,
        boundary_geojson jsonb NOT NULL,
        evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
        source_state jsonb NOT NULL DEFAULT '{}'::jsonb,
        confidence text NOT NULL CHECK (confidence IN ('high', 'moderate', 'limited')),
        review_required boolean NOT NULL DEFAULT true,
        reviewer text,
        review_notes text,
        confirmed_at timestamptz,
        generated_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (account_id, scope_key, methodology_version, input_signature)
      );
      CREATE INDEX IF NOT EXISTS neighborhood_boundary_latest_idx
        ON app.neighborhood_boundary_assessments
          (account_id, scope_key, generated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS neighborhood_boundary_geom_gix
        ON app.neighborhood_boundary_assessments USING gist (boundary);
    `);
  })().catch((error) => {
    schemaReadyByPool.delete(pool);
    throw error;
  });
  schemaReadyByPool.set(pool, pending);
  return pending;
}

async function assertAssignmentBelongsToAccount(pool, accountId, assignmentFileId) {
  if (!assignmentFileId) return;
  const { rowCount } = await pool.query(
    `SELECT 1
     FROM app.assignment_files
     WHERE id = $1 AND account_id = $2`,
    [assignmentFileId, accountId],
  );
  if (!rowCount) throw new Error("invalid_assignment_file");
}

async function resolveSearchProfile(pool, accountId, assignmentFileId, requestedProfile) {
  if (requestedProfile !== undefined && requestedProfile !== null && requestedProfile !== "") {
    const explicit = resolveComparableSearchProfile(requestedProfile, { useDefault: false });
    if (!explicit) throw new Error("invalid_neighborhood_search_profile");
    return { ...explicit, source: "requested" };
  }
  const scopeKey = assessmentScopeKey(assignmentFileId);
  const { rows } = await pool.query(
    `SELECT geography, COALESCE(appraiser_complexity, automatic_complexity) AS complexity
     FROM app.property_complexity_assessments
     WHERE account_id = $1
       AND scope_key IN ($2, 'property')
     ORDER BY (scope_key = $2) DESC, updated_at DESC, id DESC
     LIMIT 1`,
    [accountId, scopeKey],
  );
  const assessment = rows[0];
  const inferredKey = assessment
    ? `${assessment.geography}_${assessment.complexity}`
    : null;
  const inferred = resolveComparableSearchProfile(inferredKey, { useDefault: false }) ||
    resolveComparableSearchProfile(null);
  return {
    ...inferred,
    source: assessment ? "property_complexity" : "default",
  };
}

async function buildBroadBoundary(pool, { accountId, radiusMiles }) {
  const radiusMeters = radiusMiles * METERS_PER_MILE;
  const { rows } = await pool.query(
    `WITH subject AS MATERIALIZED (
       SELECT
         parcel.object_id,
         parcel.account_id,
         parcel.low_parcel_id,
         parcel.land_use_category,
         parcel.residential_year_built,
         parcel.parcel_area_sqft,
         parcel.current_market_value,
         parcel.geom,
         ST_PointOnSurface(parcel.geom) AS center
       FROM gis.dcad_parcels parcel
       WHERE parcel.account_id = $1 OR parcel.low_parcel_id = $1
       ORDER BY (parcel.account_id = $1) DESC,
                parcel.parcel_area_sqft ASC NULLS LAST,
                parcel.object_id
       LIMIT 1
     ), nearby_ranked AS MATERIALIZED (
       SELECT
         parcel.object_id,
         parcel.account_id,
         parcel.land_use_category,
         parcel.residential_year_built,
         parcel.parcel_area_sqft,
         parcel.current_market_value,
         ST_PointOnSurface(parcel.geom) AS center,
         ST_Distance(subject.center::geography, parcel.geom::geography) AS distance_meters,
         row_number() OVER (
           ORDER BY ST_Distance(subject.center::geography, parcel.geom::geography),
                    parcel.object_id
         ) AS distance_rank
       FROM gis.dcad_parcels parcel
       CROSS JOIN subject
       WHERE parcel.geom && ST_Expand(subject.geom, $2::double precision / 111320.0)
         AND ST_DWithin(subject.center::geography, parcel.geom::geography, $2)
         AND (
           parcel.land_use_category = subject.land_use_category
           OR (
             subject.land_use_category IN ('one_unit', 'two_to_four_unit', 'multifamily')
             AND parcel.land_use_category IN ('one_unit', 'two_to_four_unit', 'multifamily')
           )
         )
     ), sampled AS MATERIALIZED (
       SELECT * FROM nearby_ranked WHERE distance_rank <= $3
     ), raw_boundary AS (
       SELECT
         CASE
           WHEN COUNT(*) >= 4 THEN ST_Buffer(
             ST_ConcaveHull(ST_Collect(center), 0.82, false)::geography,
             GREATEST($4::double precision, LEAST($2::double precision * 0.08, 300))
           )::geometry
           ELSE ST_Buffer((SELECT geom FROM subject)::geography,
                          GREATEST($4::double precision, LEAST($2::double precision, 805)))::geometry
         END AS geom
       FROM sampled
     ), clipped AS (
       SELECT ST_Intersection(
         ST_MakeValid(raw_boundary.geom),
         ST_Buffer(subject.center::geography, $2)::geometry
       ) AS geom
       FROM raw_boundary CROSS JOIN subject
     ), polygon_parts AS (
       SELECT (ST_Dump(ST_CollectionExtract(ST_MakeValid(geom), 3))).geom AS geom
       FROM clipped
     ), subject_part AS (
       SELECT part.geom
       FROM polygon_parts part CROSS JOIN subject
       WHERE ST_Covers(part.geom, subject.center)
       ORDER BY ST_Area(part.geom::geography) DESC
       LIMIT 1
     ), final_boundary AS (
       SELECT ST_SimplifyPreserveTopology(
         COALESCE(
           (SELECT geom FROM subject_part),
           ST_Buffer((SELECT geom FROM subject)::geography, $4)::geometry
         ),
         0.0002
       ) AS geom
     )
     SELECT
       subject.object_id AS subject_parcel_object_id,
       subject.account_id AS subject_parcel_account_id,
       subject.low_parcel_id AS subject_low_parcel_id,
       subject.land_use_category AS subject_land_use_category,
       subject.residential_year_built AS subject_year_built,
       subject.parcel_area_sqft AS subject_site_area_sqft,
       subject.current_market_value AS subject_market_value,
       ST_AsGeoJSON(subject.center)::jsonb AS subject_point,
       ST_AsGeoJSON(final_boundary.geom)::jsonb AS boundary,
       ST_Area(final_boundary.geom::geography) / 2589988.110336 AS boundary_area_square_miles,
       COUNT(sampled.object_id)::integer AS candidate_count,
       COUNT(sampled.residential_year_built)::integer AS year_built_count,
       COUNT(sampled.parcel_area_sqft)::integer AS site_size_count,
       COUNT(sampled.current_market_value)::integer AS market_value_count,
       COUNT(*) FILTER (WHERE sampled.distance_meters <= $2)::integer AS spatial_count,
       MAX(sampled.distance_meters) / $5::double precision AS sampled_max_distance_miles
     FROM subject
     CROSS JOIN final_boundary
     LEFT JOIN sampled ON TRUE
     GROUP BY subject.object_id, subject.account_id, subject.low_parcel_id,
              subject.land_use_category, subject.residential_year_built,
              subject.parcel_area_sqft, subject.current_market_value,
              subject.center, final_boundary.geom`,
    [
      accountId,
      radiusMeters,
      MAX_BOUNDARY_POINTS,
      MINIMUM_BOUNDARY_BUFFER_METERS,
      METERS_PER_MILE,
    ],
  );
  const row = rows[0];
  if (!row?.subject_parcel_object_id || !row?.boundary) {
    throw new Error("subject_parcel_geometry_unavailable");
  }
  return row;
}

async function loadZoningEvidence(pool, { subjectParcelObjectId, boundary }) {
  const { rows } = await pool.query(
    `WITH subject AS (
       SELECT ST_PointOnSurface(geom) AS center
       FROM gis.dcad_parcels WHERE object_id = $1
     ), boundary AS (
       SELECT ST_SetSRID(ST_GeomFromGeoJSON($2), 4326) AS geom
     ), subject_zoning AS (
       SELECT zoning.provider_key, zoning.jurisdiction, zoning.zoning_code,
              zoning.zoning_description, zoning.generalized_use,
              registry.provider_label, registry.status AS provider_status,
              zoning.source_updated_at, zoning.synced_at
       FROM gis.zoning_districts zoning
       JOIN gis.zoning_source_registry registry USING (provider_key)
       CROSS JOIN subject
       WHERE ST_Covers(zoning.geom, subject.center)
       ORDER BY registry.priority DESC,
                (registry.provider_type = 'official_municipal') DESC,
                zoning.source_updated_at DESC NULLS LAST,
                zoning.synced_at DESC
       LIMIT 1
     ), districts AS (
       SELECT zoning.provider_key, zoning.zoning_code, zoning.generalized_use,
              ST_Area(ST_Intersection(zoning.geom, boundary.geom)::geography) AS overlap_area
       FROM gis.zoning_districts zoning CROSS JOIN boundary
       WHERE zoning.geom && boundary.geom AND ST_Intersects(zoning.geom, boundary.geom)
     )
     SELECT
       COALESCE((SELECT to_jsonb(subject_zoning) FROM subject_zoning), '{}'::jsonb) AS subject,
       COUNT(districts.*)::integer AS intersecting_district_count,
       COUNT(DISTINCT NULLIF(districts.generalized_use, ''))::integer AS generalized_use_count,
       COALESCE(jsonb_agg(
         jsonb_build_object(
           'provider_key', districts.provider_key,
           'zoning_code', districts.zoning_code,
           'generalized_use', districts.generalized_use,
           'overlap_area_sqft', ROUND((districts.overlap_area * 10.76391041671)::numeric)
         ) ORDER BY districts.overlap_area DESC
       ) FILTER (WHERE districts.provider_key IS NOT NULL), '[]'::jsonb) AS districts
     FROM districts`,
    [subjectParcelObjectId, JSON.stringify(boundary)],
  );
  return rows[0] || { subject: {}, districts: [] };
}

function evidenceCoverage(boundary) {
  const candidateCount = Number(boundary.candidate_count || 0);
  if (!candidateCount) return 0;
  const yearCoverage = Number(boundary.year_built_count || 0) / candidateCount;
  const siteCoverage = Number(boundary.site_size_count || 0) / candidateCount;
  return Math.min(yearCoverage, siteCoverage);
}

function generationWarnings({ boundary, roadEvidence, zoningEvidence, sourceHealth }) {
  const warnings = [];
  if (Number(boundary.candidate_count || 0) < 30) {
    warnings.push("Fewer than 30 similarly classified parcels were available inside the discovery radius.");
  }
  if (!roadEvidence?.street_names?.length) {
    warnings.push("No local road segments could be confidently assigned to the generated boundary.");
  }
  if (!zoningEvidence?.subject?.zoning_code) {
    warnings.push("Subject zoning was not available from the local official zoning mirror.");
  }
  const stale = sourceHealth.filter((source) => source.serving_stale_data);
  if (stale.length) {
    warnings.push(`Last-known-good data was used for: ${stale.map(
      (source) => source.label || source.source_key,
    ).join(", ")}.`);
  }
  return warnings;
}

async function saveGeneratedBoundary(pool, assessment) {
  const { rows } = await pool.query(
    `INSERT INTO app.neighborhood_boundary_assessments (
       account_id, scope_key, assignment_file_id, methodology_version, status,
       search_profile, discovery_radius_miles, input_signature, boundary,
       boundary_geojson, evidence, source_state, confidence, review_required
     ) VALUES (
       $1,$2,$3,$4,'generated',$5,$6,$7,
       ST_SetSRID(ST_GeomFromGeoJSON($8),4326),$8::jsonb,$9::jsonb,$10::jsonb,$11,$12
     )
     ON CONFLICT (account_id, scope_key, methodology_version, input_signature)
     DO UPDATE SET
       search_profile = EXCLUDED.search_profile,
       discovery_radius_miles = EXCLUDED.discovery_radius_miles,
       boundary = EXCLUDED.boundary,
       boundary_geojson = EXCLUDED.boundary_geojson,
       evidence = EXCLUDED.evidence,
       source_state = EXCLUDED.source_state,
       confidence = EXCLUDED.confidence,
       review_required = CASE
         WHEN app.neighborhood_boundary_assessments.status = 'confirmed' THEN false
         ELSE EXCLUDED.review_required
       END,
       updated_at = now()
     RETURNING *`,
    [
      assessment.account_id,
      assessment.scope_key,
      assessment.assignment_file_id,
      assessment.methodology_version,
      assessment.search_profile.key,
      assessment.search_profile.radiusMiles,
      assessment.input_signature,
      JSON.stringify(assessment.boundary),
      JSON.stringify(assessment.evidence),
      JSON.stringify(assessment.source_state),
      assessment.confidence,
      assessment.review_required,
    ],
  );
  return boundaryResponse(rows[0]);
}

export async function generateNeighborhoodBoundary(pool, {
  accountId,
  assignmentFileId = null,
  searchProfileKey = null,
} = {}) {
  const normalizedId = normalizedAccountId(accountId);
  const parsedAssignmentId = assignmentFileId == null || assignmentFileId === ""
    ? null
    : positiveInteger(assignmentFileId);
  if (assignmentFileId != null && assignmentFileId !== "" && !parsedAssignmentId) {
    throw new Error("invalid_assignment_file");
  }
  await ensureNeighborhoodBoundarySchema(pool);
  await assertAssignmentBelongsToAccount(pool, normalizedId, parsedAssignmentId);
  const profile = await resolveSearchProfile(
    pool,
    normalizedId,
    parsedAssignmentId,
    searchProfileKey,
  );
  const boundaryRow = await buildBroadBoundary(pool, {
    accountId: normalizedId,
    radiusMiles: profile.radiusMiles,
  });
  const boundary = boundaryRow.boundary;
  let roadEvidence = null;
  try {
    roadEvidence = await loadBoundaryStreetNames(pool, boundary, {
      allowRemoteFallback: false,
      centerPoint: boundaryRow.subject_point,
    });
  } catch (error) {
    roadEvidence = {
      source: "Local TxDOT AADT mirror with Census road names",
      street_names: [],
      cardinal_boundaries: {},
      summary: "",
      review_required: true,
      warning: error?.message || "local_txdot_boundary_roads_unavailable",
    };
  }
  const [zoningEvidence, sourceHealth] = await Promise.all([
    loadZoningEvidence(pool, {
      subjectParcelObjectId: boundaryRow.subject_parcel_object_id,
      boundary,
    }),
    getPropertyContextSourceHealth(pool),
  ]);
  const physicalCoverage = evidenceCoverage(boundaryRow);
  const confidence = confidenceFromEvidence({
    candidateCount: Number(boundaryRow.candidate_count || 0),
    physicalCoverage,
    roadEvidence,
    zoningEvidence,
  });
  const sourceState = {
    sources: sourceHealth,
    serving_stale_data: sourceHealth.some((source) => source.serving_stale_data),
  };
  const evidence = {
    boundary_purpose: "broad_descriptive_neighborhood",
    broad_boundary_is_relevance_filter: false,
    disclosure: NEIGHBORHOOD_BOUNDARY_DISCLOSURE,
    subject: {
      parcel_object_id: Number(boundaryRow.subject_parcel_object_id),
      parcel_account_id: boundaryRow.subject_parcel_account_id,
      low_parcel_id: boundaryRow.subject_low_parcel_id,
      point: boundaryRow.subject_point,
      land_use_category: boundaryRow.subject_land_use_category,
      year_built: finiteNumber(boundaryRow.subject_year_built),
      site_area_sqft: finiteNumber(boundaryRow.subject_site_area_sqft),
      market_value: finiteNumber(boundaryRow.subject_market_value),
    },
    discovery: {
      profile_key: profile.key,
      profile_label: profile.label,
      profile_source: profile.source,
      radius_miles: profile.radiusMiles,
      maximum_sampled_parcels: MAX_BOUNDARY_POINTS,
      candidate_count: Number(boundaryRow.candidate_count || 0),
      sampled_max_distance_miles: finiteNumber(boundaryRow.sampled_max_distance_miles),
      boundary_area_square_miles: finiteNumber(boundaryRow.boundary_area_square_miles),
      physical_characteristic_coverage_percent: Math.round(physicalCoverage * 1000) / 10,
      year_built_count: Number(boundaryRow.year_built_count || 0),
      site_size_count: Number(boundaryRow.site_size_count || 0),
      market_value_count: Number(boundaryRow.market_value_count || 0),
    },
    roads: roadEvidence,
    zoning: zoningEvidence,
  };
  evidence.warnings = generationWarnings({
    boundary: boundaryRow,
    roadEvidence,
    zoningEvidence,
    sourceHealth,
  });
  const signature = inputSignature({
    methodology_version: NEIGHBORHOOD_BOUNDARY_METHODOLOGY_VERSION,
    account_id: normalizedId,
    assignment_file_id: parsedAssignmentId,
    search_profile: profile.key,
    boundary,
    sources: sourceHealth.map((source) => ({
      source_key: source.source_key,
      last_success_at: source.last_success_at,
      row_count: source.row_count,
    })),
  });
  return saveGeneratedBoundary(pool, {
    account_id: normalizedId,
    scope_key: assessmentScopeKey(parsedAssignmentId),
    assignment_file_id: parsedAssignmentId,
    methodology_version: NEIGHBORHOOD_BOUNDARY_METHODOLOGY_VERSION,
    search_profile: profile,
    input_signature: signature,
    boundary,
    evidence,
    source_state: sourceState,
    confidence,
    // Version 1 always requests a final appraiser confirmation. High/moderate
    // confidence removes manual drawing, not professional responsibility.
    review_required: true,
  });
}

export async function getLatestNeighborhoodBoundary(pool, {
  accountId,
  assignmentFileId = null,
} = {}) {
  const normalizedId = normalizedAccountId(accountId);
  const parsedAssignmentId = assignmentFileId == null || assignmentFileId === ""
    ? null
    : positiveInteger(assignmentFileId);
  if (assignmentFileId != null && assignmentFileId !== "" && !parsedAssignmentId) {
    throw new Error("invalid_assignment_file");
  }
  await ensureNeighborhoodBoundarySchema(pool);
  await assertAssignmentBelongsToAccount(pool, normalizedId, parsedAssignmentId);
  const scopeKey = assessmentScopeKey(parsedAssignmentId);
  const { rows } = await pool.query(
    `SELECT *
     FROM app.neighborhood_boundary_assessments
     WHERE account_id = $1
       AND scope_key IN ($2, 'property')
       AND status <> 'rejected'
     ORDER BY (scope_key = $2) DESC,
              generated_at DESC,
              (status = 'confirmed') DESC,
              id DESC
     LIMIT 1`,
    [normalizedId, scopeKey],
  );
  return boundaryResponse(rows[0]);
}

export async function reviewNeighborhoodBoundary(pool, {
  accountId,
  assessmentId,
  assignmentFileId = null,
  confirmed,
  reviewer = "HomeNode appraiser",
  notes = "",
} = {}) {
  const normalizedId = normalizedAccountId(accountId);
  const parsedAssessmentId = positiveInteger(assessmentId);
  if (!parsedAssessmentId) throw new Error("invalid_neighborhood_boundary_assessment");
  const parsedAssignmentId = assignmentFileId == null || assignmentFileId === ""
    ? null
    : positiveInteger(assignmentFileId);
  if (assignmentFileId != null && assignmentFileId !== "" && !parsedAssignmentId) {
    throw new Error("invalid_assignment_file");
  }
  if (typeof confirmed !== "boolean") throw new Error("invalid_neighborhood_boundary_review");
  const normalizedReviewer = String(reviewer || "").trim();
  const normalizedNotes = String(notes || "").trim();
  if (!normalizedReviewer || normalizedReviewer.length > 200) {
    throw new Error("invalid_neighborhood_boundary_reviewer");
  }
  if (normalizedNotes.length > 5000) throw new Error("neighborhood_boundary_notes_too_long");
  await ensureNeighborhoodBoundarySchema(pool);
  await assertAssignmentBelongsToAccount(pool, normalizedId, parsedAssignmentId);
  const scopeKey = assessmentScopeKey(parsedAssignmentId);
  const { rows } = await pool.query(
    `UPDATE app.neighborhood_boundary_assessments
     SET status = CASE WHEN $4::boolean THEN 'confirmed' ELSE 'generated' END,
         review_required = NOT $4::boolean,
         reviewer = $5,
         review_notes = NULLIF($6, ''),
         confirmed_at = CASE WHEN $4::boolean THEN now() ELSE NULL END,
         updated_at = now()
     WHERE id = $1
       AND account_id = $2
       AND scope_key = $3
     RETURNING *`,
    [
      parsedAssessmentId,
      normalizedId,
      scopeKey,
      confirmed,
      normalizedReviewer,
      normalizedNotes,
    ],
  );
  if (!rows.length) throw new Error("neighborhood_boundary_assessment_not_found");
  return boundaryResponse(rows[0]);
}
