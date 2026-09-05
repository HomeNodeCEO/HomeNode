import { randomUUID } from "node:crypto";

import { normalizeUadWorkfileId } from "./workfiles.js";
import { assertLockedUadWorkfileMutable } from "./workfileLifecycle.js";

const MAX_STRUCTURED_SKETCH_BYTES = 2 * 1024 * 1024;
const SKETCH_SOURCES = new Set(["homenode", "mobile", "imported", "third_party"]);

function plainObject(value, code) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value;
}

export function normalizeUadSketchInput(input = {}) {
  const schemaVersion = String(input.schema_version || "1.0").trim();
  const source = String(input.source || "homenode").trim();
  if (!schemaVersion || schemaVersion.length > 32) throw new Error("invalid_uad_sketch_schema_version");
  if (!SKETCH_SOURCES.has(source)) throw new Error("invalid_uad_sketch_source");

  const normalized = {
    entityId: input.entity_id == null ? null : normalizeUadWorkfileId(input.entity_id),
    schemaVersion,
    geometry: plainObject(input.geometry, "invalid_uad_sketch_geometry"),
    measurements: plainObject(input.measurements, "invalid_uad_sketch_measurements"),
    calculatedAreas: plainObject(input.calculated_areas, "invalid_uad_sketch_calculated_areas"),
    areaOverrides: plainObject(input.area_overrides, "invalid_uad_sketch_area_overrides"),
    renderedAssetId: input.rendered_asset_id == null ? null : normalizeUadWorkfileId(input.rendered_asset_id),
    source,
    expectedRevision: input.expected_revision == null ? null : Number(input.expected_revision),
    changeSource: String(input.change_source || "uad_sketch_api").trim().slice(0, 100) || "uad_sketch_api",
  };
  if (normalized.expectedRevision != null && (
    !Number.isSafeInteger(normalized.expectedRevision) || normalized.expectedRevision < 1
  )) throw new Error("invalid_uad_sketch_expected_revision");
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_STRUCTURED_SKETCH_BYTES) {
    throw new Error("invalid_uad_sketch_size");
  }
  return normalized;
}

function sketchResponse(row) {
  return {
    id: row.id,
    workfile_id: row.workfile_id,
    entity_id: row.entity_id || null,
    schema_version: row.schema_version,
    geometry: row.geometry || {},
    measurements: row.measurements || {},
    calculated_areas: row.calculated_areas || {},
    area_overrides: row.area_overrides || {},
    rendered_asset_id: row.rendered_asset_id || null,
    source: row.source,
    revision: Number(row.revision || 1),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listUadSketches(pool, workfileIdValue) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const { rows } = await pool.query(
    `SELECT *
       FROM appraisal.uad_sketches
      WHERE workfile_id = $1
      ORDER BY entity_id NULLS FIRST, updated_at DESC, id`,
    [workfileId],
  );
  return rows.map(sketchResponse);
}

export async function saveUadSketch(pool, workfileIdValue, input = {}, actorUserId = null) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const normalized = normalizeUadSketchInput(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const workfile = await client.query(
      "SELECT id, status, signed_at FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE",
      [workfileId],
    );
    if (!workfile.rows.length) throw new Error("uad_workfile_not_found");
    await assertLockedUadWorkfileMutable(client, workfile.rows[0]);

    if (normalized.entityId) {
      const entity = await client.query(
        "SELECT id FROM appraisal.uad_entities WHERE id = $1 AND workfile_id = $2",
        [normalized.entityId, workfileId],
      );
      if (!entity.rows.length) throw new Error("uad_entity_not_found");
    }
    if (normalized.renderedAssetId) {
      const asset = await client.query(
        `SELECT id FROM appraisal.uad_assets
          WHERE id = $1 AND workfile_id = $2 AND section_number = 7
            AND status = 'verified'`,
        [normalized.renderedAssetId, workfileId],
      );
      if (!asset.rows.length) throw new Error("uad_sketch_rendered_asset_not_found");
    }

    const existing = await client.query(
      `SELECT * FROM appraisal.uad_sketches
        WHERE workfile_id = $1 AND entity_id IS NOT DISTINCT FROM $2::uuid
        ORDER BY updated_at DESC, id
        LIMIT 1
        FOR UPDATE`,
      [workfileId, normalized.entityId],
    );
    const id = existing.rows[0]?.id || randomUUID();
    const currentRevision = Number(existing.rows[0]?.revision || 0);
    if (
      existing.rows.length && normalized.expectedRevision != null
      && currentRevision !== normalized.expectedRevision
    ) {
      const conflict = new Error("uad_sketch_revision_conflict");
      conflict.currentRevision = currentRevision;
      throw conflict;
    }
    const nextRevision = existing.rows.length ? currentRevision + 1 : 1;
    const parameters = [
      id,
      workfileId,
      normalized.entityId,
      normalized.schemaVersion,
      JSON.stringify(normalized.geometry),
      JSON.stringify(normalized.measurements),
      JSON.stringify(normalized.calculatedAreas),
      JSON.stringify(normalized.areaOverrides),
      normalized.renderedAssetId,
      normalized.source,
      actorUserId,
      nextRevision,
    ];
    const saved = existing.rows.length
      ? await client.query(
          `UPDATE appraisal.uad_sketches
              SET schema_version = $4, geometry = $5::jsonb, measurements = $6::jsonb,
                  calculated_areas = $7::jsonb, area_overrides = $8::jsonb,
                  rendered_asset_id = $9, source = $10, updated_by_user_id = $11,
                  revision = $12, updated_at = now()
            WHERE id = $1 AND workfile_id = $2 AND entity_id IS NOT DISTINCT FROM $3::uuid
            RETURNING *`,
          parameters,
        )
      : await client.query(
          `INSERT INTO appraisal.uad_sketches (
             id, workfile_id, entity_id, schema_version, geometry, measurements,
             calculated_areas, area_overrides, rendered_asset_id, source,
             created_by_user_id, updated_by_user_id, revision
           ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, $11, $12)
           RETURNING *`,
          parameters,
        );

    await client.query(
      "UPDATE appraisal.uad_workfiles SET status = 'draft', updated_at = now() WHERE id = $1",
      [workfileId],
    );

    await client.query(
      `INSERT INTO appraisal.uad_sketch_history (
         sketch_id, workfile_id, revision, geometry, measurements,
         calculated_areas, area_overrides, rendered_asset_id, source,
         changed_by_user_id, change_source
       ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $11)
       ON CONFLICT (sketch_id, revision) DO NOTHING`,
      [
        id,
        workfileId,
        nextRevision,
        JSON.stringify(normalized.geometry),
        JSON.stringify(normalized.measurements),
        JSON.stringify(normalized.calculatedAreas),
        JSON.stringify(normalized.areaOverrides),
        normalized.renderedAssetId,
        normalized.source,
        actorUserId,
        normalized.changeSource,
      ],
    );

    await client.query(
      `INSERT INTO appraisal.uad_audit_events (
         workfile_id, actor_user_id, event_type, entity_type, entity_id, before_data, after_data, metadata
       ) VALUES ($1, $6, 'uad_sketch.saved', 'uad_sketch', $2, $3::jsonb, $4::jsonb, $5::jsonb)`,
      [
        workfileId,
        id,
        JSON.stringify(existing.rows[0] ? sketchResponse(existing.rows[0]) : null),
        JSON.stringify(sketchResponse(saved.rows[0])),
        JSON.stringify({
          source: normalized.source,
          schema_version: normalized.schemaVersion,
          prior_revision: currentRevision || null,
          next_revision: nextRevision,
          change_source: normalized.changeSource,
        }),
        actorUserId,
      ],
    );
    await client.query("COMMIT");
    return sketchResponse(saved.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
