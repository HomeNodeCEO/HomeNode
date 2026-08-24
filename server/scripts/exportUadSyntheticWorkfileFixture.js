import "dotenv/config";

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import pg from "pg";

const ACCOUNT_ID = "UAD-STAGING-SFR-0001";
const FILE_NUMBER = "HN-UAD-STAGING-SFR-0001";
const FORMAT = "homenode_uad_synthetic_fixture_v1";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const outputPath = path.resolve(process.argv[2] || "uad-synthetic-workfile-fixture.json");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

function entityKey(entityType, entityIdentifier) {
  if (!entityType || !entityIdentifier) return null;
  return `${entityType}:${entityIdentifier}`;
}

try {
  const database = await pool.query("SELECT current_database() AS name");
  const databaseName = String(database.rows[0]?.name || "");
  if (!databaseName.endsWith("_test")) {
    throw new Error("synthetic fixture export refused a non-test database");
  }

  const workfileResult = await pool.query(
    `SELECT id, specification_release_key
       FROM appraisal.uad_workfiles
      WHERE account_id = $1 AND lower(file_number) = lower($2)
      ORDER BY created_at, id LIMIT 1`,
    [ACCOUNT_ID, FILE_NUMBER],
  );
  if (!workfileResult.rows.length) throw new Error("synthetic fixture workfile missing");
  const workfile = workfileResult.rows[0];

  const entityResult = await pool.query(
    `WITH RECURSIVE excluded AS (
       SELECT id
         FROM appraisal.uad_entities
        WHERE workfile_id = $1
          AND entity_type = 'sales_comparable'
          AND ordinal > 1
       UNION ALL
       SELECT child.id
         FROM appraisal.uad_entities AS child
         JOIN excluded AS parent ON child.parent_entity_id = parent.id
        WHERE child.workfile_id = $1
     ), hierarchy AS (
       SELECT id, 0 AS depth
         FROM appraisal.uad_entities
        WHERE workfile_id = $1 AND parent_entity_id IS NULL
       UNION ALL
       SELECT child.id, parent.depth + 1
         FROM appraisal.uad_entities AS child
         JOIN hierarchy AS parent ON child.parent_entity_id = parent.id
        WHERE child.workfile_id = $1
     )
     SELECT entity.id, entity.entity_type, entity.entity_identifier,
            entity.ordinal, entity.label, entity.data,
            parent.entity_type AS parent_entity_type,
            parent.entity_identifier AS parent_entity_identifier,
            hierarchy.depth
       FROM appraisal.uad_entities AS entity
       JOIN hierarchy ON hierarchy.id = entity.id
       LEFT JOIN appraisal.uad_entities AS parent ON parent.id = entity.parent_entity_id
      WHERE entity.workfile_id = $1
        AND NOT EXISTS (SELECT 1 FROM excluded WHERE excluded.id = entity.id)
      ORDER BY hierarchy.depth, entity.entity_type, entity.ordinal, entity.entity_identifier`,
    [workfile.id],
  );
  const includedIds = new Set(entityResult.rows.map((entity) => entity.id));

  const valueResult = await pool.query(
    `SELECT DISTINCT ON (value.entity_id, value.field_context, value.uad_uid)
            value.entity_id, value.field_context, value.uad_uid,
            value.report_field_id, value.value,
            entity.entity_type, entity.entity_identifier
       FROM appraisal.uad_field_values AS value
       LEFT JOIN appraisal.uad_entities AS entity ON entity.id = value.entity_id
      WHERE value.workfile_id = $1
      ORDER BY value.entity_id NULLS FIRST, value.field_context, value.uad_uid,
               value.updated_at DESC, value.created_at DESC, value.id DESC`,
    [workfile.id],
  );

  const entities = entityResult.rows.map((entity) => ({
    key: entityKey(entity.entity_type, entity.entity_identifier),
    parent_key: entityKey(entity.parent_entity_type, entity.parent_entity_identifier),
    entity_type: entity.entity_type,
    entity_identifier: entity.entity_identifier,
    ordinal: Number(entity.ordinal),
    label: entity.label || null,
    data: entity.data || {},
  }));
  const fieldValues = valueResult.rows
    .filter((value) => value.entity_id == null || includedIds.has(value.entity_id))
    .map((value) => ({
      entity_key: entityKey(value.entity_type, value.entity_identifier),
      field_context: value.field_context,
      uad_uid: value.uad_uid,
      report_field_id: value.report_field_id || null,
      value: value.value,
    }))
    .sort((left, right) => (
      String(left.entity_key || "").localeCompare(String(right.entity_key || ""))
      || left.field_context.localeCompare(right.field_context)
      || left.uad_uid.localeCompare(right.uad_uid)
    ));
  const fixture = {
    format: FORMAT,
    specification_release_key: workfile.specification_release_key,
    source: {
      account_id: ACCOUNT_ID,
      file_number: FILE_NUMBER,
      classification: "synthetic_only",
    },
    counts: {
      entities: entities.length,
      field_values: fieldValues.length,
      sales_comparables: entities.filter((entity) => entity.entity_type === "sales_comparable").length,
    },
    entities,
    field_values: fieldValues,
  };
  const canonical = JSON.stringify(fixture);
  const output = {
    ...fixture,
    sha256: createHash("sha256").update(canonical).digest("hex"),
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    exported: true,
    format: FORMAT,
    specification_release_key: workfile.specification_release_key,
    counts: output.counts,
    sha256: output.sha256,
    output: outputPath,
  }));
} finally {
  await pool.end();
}
