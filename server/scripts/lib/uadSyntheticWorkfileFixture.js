import { createHash } from "node:crypto";
import fs from "node:fs/promises";

import { CURRENT_UAD_RELEASE_KEY } from "../../src/modules/uad/constants.js";

const FIXTURE_URL = new URL("../../fixtures/uad/synthetic-sfr-h1.5.json", import.meta.url);
const FORMAT = "homenode_uad_synthetic_fixture_v1";
let fixturePromise;

function deterministicUuid(value) {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "8";
  const normalized = hex.join("");
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20)}`;
}

function validateFixture(fixture) {
  if (!fixture || fixture.format !== FORMAT) throw new Error("invalid_synthetic_uad_fixture_format");
  if (fixture.specification_release_key !== CURRENT_UAD_RELEASE_KEY) {
    throw new Error("stale_synthetic_uad_fixture_release");
  }
  if (fixture.source?.classification !== "synthetic_only") {
    throw new Error("invalid_synthetic_uad_fixture_classification");
  }
  if (!Array.isArray(fixture.entities) || !Array.isArray(fixture.field_values)) {
    throw new Error("invalid_synthetic_uad_fixture_shape");
  }
  if (fixture.counts?.entities !== fixture.entities.length
      || fixture.counts?.field_values !== fixture.field_values.length) {
    throw new Error("invalid_synthetic_uad_fixture_counts");
  }
  const { sha256, ...unsigned } = fixture;
  const actualHash = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(String(sha256 || "")) || sha256 !== actualHash) {
    throw new Error("invalid_synthetic_uad_fixture_checksum");
  }
  const entityKeys = new Set();
  for (const entity of fixture.entities) {
    if (!entity.key || entityKeys.has(entity.key)) throw new Error("invalid_synthetic_uad_fixture_entity_key");
    if (entity.parent_key && !entityKeys.has(entity.parent_key)) {
      throw new Error("invalid_synthetic_uad_fixture_entity_order");
    }
    entityKeys.add(entity.key);
  }
  if (fixture.entities.filter((entity) => entity.entity_type === "sales_comparable").length !== 1) {
    throw new Error("invalid_synthetic_uad_fixture_comparable_count");
  }
  for (const value of fixture.field_values) {
    if (value.entity_key && !entityKeys.has(value.entity_key)) {
      throw new Error("invalid_synthetic_uad_fixture_value_entity");
    }
    if (!value.field_context || !value.uad_uid) throw new Error("invalid_synthetic_uad_fixture_value_key");
  }
  return fixture;
}

export async function loadSyntheticUadWorkfileFixture() {
  fixturePromise ||= fs.readFile(FIXTURE_URL, "utf8")
    .then((source) => validateFixture(JSON.parse(source)));
  return fixturePromise;
}

export async function seedSyntheticUadWorkfileFixture(pool, workfileId, {
  namespace = "synthetic-uad-workfile",
  observedAt = "2026-08-21T12:00:00.000Z",
  sourceReference = "synthetic_uad_workfile_fixture",
} = {}) {
  const fixture = await loadSyntheticUadWorkfileFixture();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const boundary = await client.query(
      `SELECT workfile.specification_release_key, workfile.status,
              account.account_id, account.data_quality_status,
              organization.metadata->>'synthetic' AS synthetic_organization
         FROM appraisal.uad_workfiles AS workfile
         JOIN core.accounts AS account ON account.account_id = workfile.account_id
         JOIN app_auth.organizations AS organization ON organization.id = workfile.organization_id
        WHERE workfile.id = $1
        FOR UPDATE OF workfile`,
      [workfileId],
    );
    const target = boundary.rows[0];
    if (!target) throw new Error("synthetic_uad_fixture_workfile_missing");
    if (!String(target.account_id).startsWith("UAD-REDTEAM-")
        || target.data_quality_status !== "synthetic"
        || target.synthetic_organization !== "true") {
      throw new Error("synthetic_uad_fixture_boundary_violation");
    }
    if (target.specification_release_key !== fixture.specification_release_key) {
      throw new Error("synthetic_uad_fixture_release_mismatch");
    }
    if (["signed", "exported", "submitted"].includes(target.status)) {
      throw new Error("synthetic_uad_fixture_immutable_workfile");
    }

    const entityIds = new Map();
    for (const entity of fixture.entities) {
      const parentEntityId = entity.parent_key ? entityIds.get(entity.parent_key) : null;
      if (entity.parent_key && !parentEntityId) throw new Error("synthetic_uad_fixture_parent_missing");
      const id = deterministicUuid(`${namespace}:entity:${entity.key}`);
      const inserted = await client.query(
        `INSERT INTO appraisal.uad_entities (
           id, workfile_id, parent_entity_id, entity_type, entity_identifier,
           ordinal, label, data, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz, $9::timestamptz)
         ON CONFLICT (workfile_id, entity_type, entity_identifier) DO UPDATE SET
           parent_entity_id = EXCLUDED.parent_entity_id,
           ordinal = EXCLUDED.ordinal,
           label = EXCLUDED.label,
           data = EXCLUDED.data,
           updated_at = EXCLUDED.updated_at
         RETURNING id`,
        [
          id,
          workfileId,
          parentEntityId,
          entity.entity_type,
          entity.entity_identifier,
          entity.ordinal,
          entity.label,
          JSON.stringify(entity.data || {}),
          observedAt,
        ],
      );
      entityIds.set(entity.key, inserted.rows[0].id);
    }

    await client.query("DELETE FROM appraisal.uad_field_values WHERE workfile_id = $1", [workfileId]);
    const values = fixture.field_values.map((value) => ({
      id: deterministicUuid(`${namespace}:value:${value.entity_key || "root"}:${value.field_context}:${value.uad_uid}`),
      entity_id: value.entity_key ? entityIds.get(value.entity_key) : null,
      field_context: value.field_context,
      uad_uid: value.uad_uid,
      report_field_id: value.report_field_id,
      value: value.value,
    }));
    await client.query(
      `INSERT INTO appraisal.uad_field_values (
         id, workfile_id, entity_id, field_context, uad_uid, report_field_id,
         value, source_type, source_reference, source_observed_at,
         is_appraiser_confirmed, created_at, updated_at
       )
       SELECT input.id::uuid, $1, input.entity_id::uuid, input.field_context,
              input.uad_uid, input.report_field_id, input.value,
              'appraiser', $3, $4::timestamptz, true, $4::timestamptz, $4::timestamptz
         FROM jsonb_to_recordset($2::jsonb) AS input(
           id text, entity_id text, field_context text, uad_uid text,
           report_field_id text, value jsonb
         )`,
      [workfileId, JSON.stringify(values), sourceReference, observedAt],
    );
    await client.query(
      "UPDATE appraisal.uad_workfiles SET status = 'draft', updated_at = now() WHERE id = $1",
      [workfileId],
    );
    await client.query("COMMIT");
    return {
      format: fixture.format,
      specification_release_key: fixture.specification_release_key,
      sha256: fixture.sha256,
      entity_count: fixture.entities.length,
      field_value_count: fixture.field_values.length,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
