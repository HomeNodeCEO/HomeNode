import { createHash } from "node:crypto";

import {
  ensureNeighborhoodBoundarySchema,
  getLatestNeighborhoodBoundary,
} from "./neighborhoodBoundaryEngine.js";
import {
  buildNeighborhoodRelevanceAssessment,
  NEIGHBORHOOD_RELEVANCE_METHODOLOGY_VERSION,
} from "./neighborhoodRelevance.js";
import { getPropertyContextSourceHealth } from "./propertyContextStore.js";

const RELEVANCE_SALE_HISTORY_MONTHS = 36;
const MINIMUM_DISSIMILAR_POCKET_SIZE = 3;
const MAX_CANDIDATE_PARCELS = 5000;
const ADJACENCY_DISTANCE_METERS = 20;
const schemaReadyByPool = new WeakMap();

function normalizedAccountId(value) {
  const accountId = String(value || "").trim();
  if (!accountId || accountId.length > 100 || /[\u0000-\u001f\u007f]/.test(accountId)) {
    throw new Error("invalid_account_id");
  }
  return accountId;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function scopeKey(assignmentFileId) {
  return assignmentFileId ? `assignment:${assignmentFileId}` : "property";
}

function hashInput(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function relevanceResponse(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    account_id: row.account_id,
    scope_key: row.scope_key,
    assignment_file_id: row.assignment_file_id == null ? null : Number(row.assignment_file_id),
    boundary_assessment_id: Number(row.boundary_assessment_id),
    methodology_version: Number(row.methodology_version),
    input_signature: row.input_signature,
    summary: row.summary || {},
    distributions: row.distributions || {},
    confidence: row.confidence || {},
    source_state: row.source_state || {},
    disclosure: row.disclosure || "",
    generated_at: row.generated_at,
    updated_at: row.updated_at,
  };
}

export async function ensureNeighborhoodRelevanceSchema(pool) {
  const existing = schemaReadyByPool.get(pool);
  if (existing) return existing;
  const pending = (async () => {
    await ensureNeighborhoodBoundarySchema(pool);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app.neighborhood_relevance_assessments (
        id bigserial PRIMARY KEY,
        account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
        scope_key text NOT NULL DEFAULT 'property',
        assignment_file_id bigint REFERENCES app.assignment_files(id) ON DELETE CASCADE,
        boundary_assessment_id bigint NOT NULL
          REFERENCES app.neighborhood_boundary_assessments(id) ON DELETE CASCADE,
        methodology_version integer NOT NULL,
        input_signature text NOT NULL,
        summary jsonb NOT NULL,
        distributions jsonb NOT NULL,
        confidence jsonb NOT NULL,
        source_state jsonb NOT NULL DEFAULT '{}'::jsonb,
        disclosure text NOT NULL,
        generated_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (account_id, scope_key, methodology_version, input_signature)
      );
      CREATE INDEX IF NOT EXISTS neighborhood_relevance_latest_idx
        ON app.neighborhood_relevance_assessments
          (account_id, scope_key, generated_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS app.neighborhood_relevance_candidates (
        assessment_id bigint NOT NULL
          REFERENCES app.neighborhood_relevance_assessments(id) ON DELETE CASCADE,
        parcel_object_id bigint NOT NULL,
        account_id text,
        address text,
        land_use_category text,
        subdivision_name text,
        neighborhood_code text,
        same_subject_neighborhood boolean NOT NULL DEFAULT false,
        score numeric,
        available_weight_percent numeric NOT NULL,
        statistical_classification text NOT NULL,
        excluded boolean NOT NULL DEFAULT false,
        exclusion_reason text,
        cluster_id text,
        cluster_size integer,
        year_built integer,
        site_area_sqft numeric,
        sale_price numeric,
        sale_date date,
        distance_miles numeric,
        factors jsonb NOT NULL,
        diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
        point geometry(Point, 4326),
        PRIMARY KEY (assessment_id, parcel_object_id)
      );
      ALTER TABLE app.neighborhood_relevance_candidates
        ADD COLUMN IF NOT EXISTS land_use_category text;
      ALTER TABLE app.neighborhood_relevance_candidates
        ADD COLUMN IF NOT EXISTS subdivision_name text,
        ADD COLUMN IF NOT EXISTS neighborhood_code text,
        ADD COLUMN IF NOT EXISTS same_subject_neighborhood boolean NOT NULL DEFAULT false;
      CREATE INDEX IF NOT EXISTS neighborhood_relevance_candidate_score_idx
        ON app.neighborhood_relevance_candidates
          (assessment_id, excluded, score DESC NULLS LAST);
      CREATE INDEX IF NOT EXISTS neighborhood_relevance_candidate_class_idx
        ON app.neighborhood_relevance_candidates
          (assessment_id, statistical_classification);
      CREATE INDEX IF NOT EXISTS neighborhood_relevance_candidate_point_gix
        ON app.neighborhood_relevance_candidates USING gist (point);
    `);
  })().catch((error) => {
    schemaReadyByPool.delete(pool);
    throw error;
  });
  schemaReadyByPool.set(pool, pending);
  return pending;
}

async function loadCandidateParcels(pool, { accountId, boundary }) {
  const { rows } = await pool.query(
    `WITH boundary AS MATERIALIZED (
       SELECT ST_SetSRID(ST_GeomFromGeoJSON($2), 4326) AS geom
     ), subject AS MATERIALIZED (
       SELECT parcel.object_id, parcel.land_use_category, parcel.residential_year_built, parcel.parcel_area_sqft,
              parcel.residential_area_sqft, parcel.subdivision_name,
              account.subdivision, account.neighborhood_code,
              ST_PointOnSurface(parcel.geom) AS center
       FROM gis.dcad_parcels parcel
       LEFT JOIN core.accounts account ON account.account_id = parcel.account_id
       WHERE parcel.account_id = $1 OR parcel.low_parcel_id = $1
       ORDER BY (parcel.account_id = $1) DESC,
                parcel.parcel_area_sqft ASC NULLS LAST,
                parcel.object_id
       LIMIT 1
     ), candidates AS MATERIALIZED (
       SELECT
         parcel.object_id AS parcel_object_id,
         parcel.account_id,
         parcel.site_address AS address,
         parcel.land_use_category,
         COALESCE(NULLIF(parcel.subdivision_name, ''), NULLIF(account.subdivision, '')) AS subdivision_name,
         account.neighborhood_code,
         parcel.residential_year_built AS year_built,
         parcel.parcel_area_sqft AS site_area_sqft,
         parcel.residential_area_sqft AS gla_sqft,
         ST_Distance(subject.center::geography, candidate_location.center::geography)
           / 1609.344 AS distance_miles,
         ST_AsGeoJSON(candidate_location.center)::jsonb AS point
       FROM gis.dcad_parcels parcel
       LEFT JOIN core.accounts account ON account.account_id = parcel.account_id
       CROSS JOIN boundary
       CROSS JOIN subject
       CROSS JOIN LATERAL (
         SELECT ST_PointOnSurface(parcel.geom) AS center
       ) candidate_location
       WHERE parcel.object_id <> subject.object_id
         AND parcel.geom && boundary.geom
         AND ST_Covers(boundary.geom, candidate_location.center)
       ORDER BY ST_Distance(subject.center::geography, candidate_location.center::geography),
                parcel.object_id
       LIMIT $3
     )
     SELECT
       candidate.*,
       subject.residential_year_built AS subject_year_built,
       subject.land_use_category AS subject_land_use_category,
       subject.parcel_area_sqft AS subject_site_area_sqft,
       subject.residential_area_sqft AS subject_gla_sqft
       , COALESCE(NULLIF(subject.subdivision_name, ''), NULLIF(subject.subdivision, '')) AS subject_subdivision_name
       , subject.neighborhood_code AS subject_neighborhood_code
     FROM candidates candidate
     CROSS JOIN subject`,
    [
      accountId,
      JSON.stringify(boundary),
      MAX_CANDIDATE_PARCELS,
    ],
  );
  if (!rows.length) throw new Error("neighborhood_relevance_candidates_unavailable");
  const first = rows[0];
  const subjectLandUse = String(first.subject_land_use_category || "").trim();
  const saleAccountIds = [...new Set(rows
    .filter((row) => {
      const candidateLandUse = String(row.land_use_category || "").trim();
      return row.account_id && (
        !subjectLandUse || !candidateLandUse || candidateLandUse === subjectLandUse
      );
    })
    .map((row) => String(row.account_id).trim())
    .filter(Boolean))];
  const latestSales = await loadLatestCandidateSales(pool, saleAccountIds);
  return {
    subject: {
      account_id: accountId,
      land_use_category: first.subject_land_use_category,
      year_built: first.subject_year_built,
      site_area_sqft: first.subject_site_area_sqft,
      gla_sqft: first.subject_gla_sqft,
      subdivision_name: first.subject_subdivision_name,
      neighborhood_code: first.subject_neighborhood_code,
    },
    candidates: rows.map((row) => {
      const sale = latestSales.get(String(row.account_id || "").trim());
      return {
        parcel_object_id: Number(row.parcel_object_id),
        id: `parcel:${row.parcel_object_id}`,
        account_id: row.account_id || null,
        address: row.address || null,
        land_use_category: row.land_use_category || null,
        year_built: row.year_built,
        site_area_sqft: row.site_area_sqft,
        gla_sqft: row.gla_sqft,
        subdivision_name: row.subdivision_name,
        neighborhood_code: row.neighborhood_code,
        same_subject_neighborhood: Boolean(
          (row.subdivision_name && first.subject_subdivision_name &&
            String(row.subdivision_name).trim().toUpperCase() ===
              String(first.subject_subdivision_name).trim().toUpperCase()) ||
          (row.neighborhood_code && first.subject_neighborhood_code &&
            String(row.neighborhood_code).trim().toUpperCase() ===
              String(first.subject_neighborhood_code).trim().toUpperCase())
        ),
        distance_miles: row.distance_miles,
        sale_price: sale?.sale_price ?? null,
        sale_date: sale?.sale_date ?? null,
        point: row.point,
      };
    }),
  };
}

async function loadLatestCandidateSales(pool, accountIds) {
  if (!accountIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (sale.primary_account_id)
       sale.primary_account_id,
       sale.sale_price::numeric AS sale_price,
       sale.closing_date AS sale_date
     FROM core.v_sales_enriched sale
     WHERE sale.primary_account_id = ANY($1::text[])
       AND sale.record_type = 'closed_sale'
       AND sale.sale_price > 0
       AND sale.closing_date >= CURRENT_DATE - ($2::text || ' months')::interval
     ORDER BY sale.primary_account_id,
              sale.closing_date DESC,
              sale.source_record_id DESC NULLS LAST`,
    [accountIds, RELEVANCE_SALE_HISTORY_MONTHS],
  );
  return new Map(rows.map((row) => [String(row.primary_account_id), row]));
}

async function loadPotentialPocketAdjacency(pool, parcelObjectIds) {
  const ids = [...new Set(parcelObjectIds.map(Number).filter(Number.isSafeInteger))];
  if (ids.length < MINIMUM_DISSIMILAR_POCKET_SIZE) return [];
  const { rows } = await pool.query(
    `SELECT left_parcel.object_id AS left_id,
            right_parcel.object_id AS right_id
     FROM gis.dcad_parcels left_parcel
     JOIN gis.dcad_parcels right_parcel
       ON right_parcel.object_id > left_parcel.object_id
      AND right_parcel.object_id = ANY($1::bigint[])
      AND right_parcel.geom && ST_Expand(
        left_parcel.geom,
        $2::double precision / 111320.0
      )
      AND ST_DWithin(
        left_parcel.geom::geography,
        right_parcel.geom::geography,
        $2::double precision
      )
     WHERE left_parcel.object_id = ANY($1::bigint[])
     ORDER BY left_parcel.object_id, right_parcel.object_id
     LIMIT 100000`,
    [ids, ADJACENCY_DISTANCE_METERS],
  );
  return rows.map((row) => [Number(row.left_id), Number(row.right_id)]);
}

export function applyContiguousPocketClassification(
  candidates,
  adjacencyPairs,
  { minimumClusterSize = MINIMUM_DISSIMILAR_POCKET_SIZE } = {},
) {
  const potentialIds = new Set(candidates
    .filter((candidate) =>
      candidate.statistical_classification === "potential_dissimilar_cluster_member",
    )
    .map((candidate) => Number(candidate.parcel_object_id))
    .filter(Number.isSafeInteger));
  const parent = new Map([...potentialIds].map((id) => [id, id]));
  const find = (id) => {
    const current = parent.get(id);
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (left, right) => {
    if (!parent.has(left) || !parent.has(right)) return;
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(Math.max(leftRoot, rightRoot), Math.min(leftRoot, rightRoot));
  };
  for (const [left, right] of adjacencyPairs) union(Number(left), Number(right));
  const membersByRoot = new Map();
  for (const id of potentialIds) {
    const root = find(id);
    const members = membersByRoot.get(root) || [];
    members.push(id);
    membersByRoot.set(root, members);
  }
  const clusterById = new Map();
  for (const members of membersByRoot.values()) {
    const sorted = members.sort((left, right) => left - right);
    const clusterId = `pocket:${sorted[0]}`;
    for (const id of sorted) clusterById.set(id, { clusterId, size: sorted.length });
  }
  return candidates.map((candidate) => {
    if (candidate.same_subject_neighborhood === true) {
      return {
        ...candidate,
        excluded: false,
        exclusion_reason: null,
        statistical_classification: "protected_subject_neighborhood",
      };
    }
    if (candidate.statistical_classification !== "potential_dissimilar_cluster_member") {
      return candidate;
    }
    const cluster = clusterById.get(Number(candidate.parcel_object_id));
    if (!cluster || cluster.size < minimumClusterSize) {
      return {
        ...candidate,
        excluded: false,
        exclusion_reason: null,
        contiguous_cluster: cluster
          ? { id: cluster.clusterId, size: cluster.size, qualifies_as_pocket: false }
          : null,
      };
    }
    return {
      ...candidate,
      excluded: true,
      exclusion_reason: "contiguous_dissimilar_pocket",
      statistical_classification: "excluded_dissimilar_pocket",
      contiguous_cluster: {
        id: cluster.clusterId,
        size: cluster.size,
        qualifies_as_pocket: true,
      },
    };
  });
}

export function applyLandUsePrerequisite(candidates, subjectLandUseCategory) {
  const subjectCategory = String(subjectLandUseCategory || "").trim();
  if (!subjectCategory) return candidates;
  return candidates.map((candidate) => {
    if (candidate.same_subject_neighborhood === true) return candidate;
    const candidateCategory = String(candidate.land_use_category || "").trim();
    if (!candidateCategory || candidateCategory === subjectCategory) return candidate;
    return {
      ...candidate,
      excluded: true,
      exclusion_reason: "different_land_use",
      statistical_classification: "excluded_land_use_mismatch",
      exclusion_requires_contiguous_cluster: false,
    };
  });
}

function summarizeCandidates(candidates) {
  const count = (predicate) => candidates.filter(predicate).length;
  const classificationCounts = candidates.reduce((summary, candidate) => {
    summary[candidate.statistical_classification] =
      (summary[candidate.statistical_classification] || 0) + 1;
    return summary;
  }, {});
  const scores = candidates.map((candidate) => Number(candidate.score)).filter(Number.isFinite);
  return {
    candidate_count: candidates.length,
    included_count: count((candidate) => !candidate.excluded),
    excluded_count: count((candidate) => candidate.excluded),
    insufficient_data_count: count((candidate) =>
      candidate.statistical_classification === "insufficient_data",
    ),
    low_relevance_excluded_count: count((candidate) =>
      candidate.statistical_classification === "excluded_low_relevance",
    ),
    dissimilar_pocket_excluded_count: count((candidate) =>
      candidate.statistical_classification === "excluded_dissimilar_pocket",
    ),
    classification_counts: classificationCounts,
    score_range: {
      minimum: scores.length ? Math.min(...scores) : null,
      maximum: scores.length ? Math.max(...scores) : null,
    },
    sale_history_months: RELEVANCE_SALE_HISTORY_MONTHS,
    sale_prices_time_adjusted: false,
    minimum_dissimilar_pocket_size: MINIMUM_DISSIMILAR_POCKET_SIZE,
  };
}

function candidatePersistencePayload(candidates) {
  return candidates.map((candidate) => ({
    parcel_object_id: candidate.parcel_object_id,
    account_id: candidate.account_id,
    address: candidate.address,
    land_use_category: candidate.land_use_category,
    subdivision_name: candidate.subdivision_name,
    neighborhood_code: candidate.neighborhood_code,
    same_subject_neighborhood: candidate.same_subject_neighborhood === true,
    score: candidate.score,
    available_weight_percent: candidate.available_weight_percent,
    statistical_classification: candidate.statistical_classification,
    excluded: candidate.excluded,
    exclusion_reason: candidate.exclusion_reason || (
      candidate.statistical_classification === "excluded_low_relevance"
        ? "relevance_score_below_threshold"
        : null
    ),
    cluster_id: candidate.contiguous_cluster?.id || null,
    cluster_size: candidate.contiguous_cluster?.size || null,
    year_built: candidate.year_built,
    site_area_sqft: candidate.site_area_sqft,
    sale_price: candidate.sale_price,
    sale_date: candidate.sale_price_date,
    distance_miles: candidate.distance_miles,
    factors: candidate.factors,
    diagnostics: {
      primary_deviation_count: candidate.primary_deviation_count,
      extreme_deviation_count: candidate.extreme_deviation_count,
      supporting_boundary_evidence: candidate.supporting_boundary_evidence,
      exclusion_threshold_percent: candidate.exclusion_threshold_percent,
      gla: candidate.gla_diagnostic,
      contiguous_cluster: candidate.contiguous_cluster || null,
    },
    point: candidate.point,
  }));
}

async function persistAssessment(pool, assessment) {
  const client = typeof pool.connect === "function" ? await pool.connect() : null;
  const queryable = client || pool;
  try {
    if (client) await client.query("BEGIN");
    const { rows } = await queryable.query(
      `INSERT INTO app.neighborhood_relevance_assessments (
         account_id, scope_key, assignment_file_id, boundary_assessment_id,
         methodology_version, input_signature, summary, distributions,
         confidence, source_state, disclosure
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11)
       ON CONFLICT (account_id, scope_key, methodology_version, input_signature)
       DO UPDATE SET
         boundary_assessment_id = EXCLUDED.boundary_assessment_id,
         summary = EXCLUDED.summary,
         distributions = EXCLUDED.distributions,
         confidence = EXCLUDED.confidence,
         source_state = EXCLUDED.source_state,
         disclosure = EXCLUDED.disclosure,
         updated_at = now()
       RETURNING *`,
      [
        assessment.account_id,
        assessment.scope_key,
        assessment.assignment_file_id,
        assessment.boundary_assessment_id,
        assessment.methodology_version,
        assessment.input_signature,
        JSON.stringify(assessment.summary),
        JSON.stringify(assessment.distributions),
        JSON.stringify(assessment.confidence),
        JSON.stringify(assessment.source_state),
        assessment.disclosure,
      ],
    );
    const row = rows[0];
    await queryable.query(
      `DELETE FROM app.neighborhood_relevance_candidates WHERE assessment_id = $1`,
      [row.id],
    );
    const payload = candidatePersistencePayload(assessment.candidates);
    await queryable.query(
      `INSERT INTO app.neighborhood_relevance_candidates (
         assessment_id, parcel_object_id, account_id, address, land_use_category,
         subdivision_name, neighborhood_code, same_subject_neighborhood, score,
         available_weight_percent, statistical_classification, excluded,
         exclusion_reason, cluster_id, cluster_size, year_built, site_area_sqft,
         sale_price, sale_date, distance_miles, factors, diagnostics, point
       )
       SELECT $1, item.parcel_object_id, item.account_id, item.address,
              item.land_use_category, item.subdivision_name, item.neighborhood_code,
              item.same_subject_neighborhood, item.score,
              item.available_weight_percent, item.statistical_classification,
              item.excluded, item.exclusion_reason, item.cluster_id,
              item.cluster_size, item.year_built, item.site_area_sqft,
              item.sale_price, item.sale_date,
              item.distance_miles, item.factors, item.diagnostics,
              CASE WHEN item.point IS NULL THEN NULL
                   ELSE ST_SetSRID(ST_GeomFromGeoJSON(item.point::text), 4326)
              END
       FROM jsonb_to_recordset($2::jsonb) AS item(
         parcel_object_id bigint, account_id text, address text,
         land_use_category text, subdivision_name text, neighborhood_code text,
         same_subject_neighborhood boolean, score numeric,
         available_weight_percent numeric, statistical_classification text,
         excluded boolean, exclusion_reason text, cluster_id text,
         cluster_size integer, year_built integer, site_area_sqft numeric,
         sale_price numeric, sale_date date, distance_miles numeric,
         factors jsonb, diagnostics jsonb, point jsonb
       )`,
      [row.id, JSON.stringify(payload)],
    );
    if (client) await client.query("COMMIT");
    return relevanceResponse(row);
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client?.release();
  }
}

export async function generateNeighborhoodRelevance(pool, {
  accountId,
  assignmentFileId = null,
  boundaryAssessmentId = null,
} = {}) {
  const normalizedId = normalizedAccountId(accountId);
  const parsedAssignmentId = assignmentFileId == null || assignmentFileId === ""
    ? null
    : positiveInteger(assignmentFileId);
  if (assignmentFileId != null && assignmentFileId !== "" && !parsedAssignmentId) {
    throw new Error("invalid_assignment_file");
  }
  await ensureNeighborhoodRelevanceSchema(pool);
  const latestBoundary = await getLatestNeighborhoodBoundary(pool, {
    accountId: normalizedId,
    assignmentFileId: parsedAssignmentId,
  });
  if (!latestBoundary) throw new Error("neighborhood_boundary_required");
  const parsedBoundaryId = boundaryAssessmentId == null || boundaryAssessmentId === ""
    ? latestBoundary.id
    : positiveInteger(boundaryAssessmentId);
  if (!parsedBoundaryId || parsedBoundaryId !== latestBoundary.id) {
    throw new Error("invalid_neighborhood_boundary_assessment");
  }
  const loaded = await loadCandidateParcels(pool, {
    accountId: normalizedId,
    boundary: latestBoundary.boundary,
  });
  const sourceHealth = await getPropertyContextSourceHealth(pool);
  const initial = buildNeighborhoodRelevanceAssessment({
    subject: loaded.subject,
    candidates: loaded.candidates,
    maximumDistanceMiles: latestBoundary.discovery_radius_miles,
    sourceHealth,
  });
  const landUseScreened = applyLandUsePrerequisite(
    initial.candidates,
    loaded.subject.land_use_category,
  );
  const potentialIds = landUseScreened
    .filter((candidate) =>
      candidate.statistical_classification === "potential_dissimilar_cluster_member",
    )
    .map((candidate) => candidate.parcel_object_id);
  const adjacency = await loadPotentialPocketAdjacency(pool, potentialIds);
  const candidates = applyContiguousPocketClassification(landUseScreened, adjacency);
  const summary = summarizeCandidates(candidates);
  const signature = hashInput({
    methodology_version: NEIGHBORHOOD_RELEVANCE_METHODOLOGY_VERSION,
    boundary_assessment_id: latestBoundary.id,
    boundary_input_signature: latestBoundary.input_signature,
    candidates: loaded.candidates.map((candidate) => ({
      parcel_object_id: candidate.parcel_object_id,
      year_built: candidate.year_built,
      site_area_sqft: candidate.site_area_sqft,
      sale_price: candidate.sale_price,
      sale_date: candidate.sale_date,
      distance_miles: candidate.distance_miles,
    })),
  });
  return persistAssessment(pool, {
    account_id: normalizedId,
    scope_key: scopeKey(parsedAssignmentId),
    assignment_file_id: parsedAssignmentId,
    boundary_assessment_id: latestBoundary.id,
    methodology_version: NEIGHBORHOOD_RELEVANCE_METHODOLOGY_VERSION,
    input_signature: signature,
    summary,
    distributions: initial.distributions,
    confidence: initial.confidence,
    source_state: {
      sources: sourceHealth,
      serving_stale_data: sourceHealth.some((source) => source.serving_stale_data),
    },
    disclosure: initial.disclosure,
    candidates,
  });
}

export async function getLatestNeighborhoodRelevance(pool, {
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
  await ensureNeighborhoodRelevanceSchema(pool);
  const requestedScope = scopeKey(parsedAssignmentId);
  if (parsedAssignmentId) {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM app.assignment_files WHERE id = $1 AND account_id = $2`,
      [parsedAssignmentId, normalizedId],
    );
    if (!rowCount) throw new Error("invalid_assignment_file");
  }
  const { rows } = await pool.query(
    `SELECT *
     FROM app.neighborhood_relevance_assessments
     WHERE account_id = $1 AND scope_key IN ($2, 'property')
     ORDER BY (scope_key = $2) DESC, generated_at DESC, id DESC
     LIMIT 1`,
    [normalizedId, requestedScope],
  );
  return relevanceResponse(rows[0]);
}
