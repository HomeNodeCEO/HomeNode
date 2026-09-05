import { createHash, randomUUID } from "node:crypto";

import { listUadAssets } from "./assets.js";
import { buildUadCertificationWarnings } from "./certificationsCatalog.js";
import { getUadEditor, validateCompleteSection } from "./editor.js";
import {
  getUadField,
  normalizeAndValidateUadValue,
  uadFieldAppliesToEntity,
  uadFieldIsVisible,
} from "./fieldCatalog.js";
import { normalizeUadWorkfileId } from "./workfiles.js";
import { listUadSketches } from "./sketches.js";
import { assertUadWorkfileMutable } from "./workfileLifecycle.js";

export const UAD_LOCAL_VALIDATOR_VERSION = "homenode-uad-local-v1";

const MAX_FINDINGS = 5_000;

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  }
  return value;
}

export function buildUadValidationInputDigest(editor, assets = [], sketches = []) {
  const document = {
    specification_release_key: editor.workfile.specification_release_key,
    current_revision: Number(editor.workfile.current_revision),
    applicable_sections: editor.sections
      .filter((section) => section.applicable !== false)
      .map((section) => section.key),
    entities: editor.entities
      .map((entity) => ({
        id: entity.id,
        parent_entity_id: entity.parent_entity_id || null,
        entity_type: entity.entity_type,
        entity_identifier: entity.entity_identifier,
        ordinal: Number(entity.ordinal),
        label: entity.label || null,
        data: entity.data || {},
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    field_values: editor.values
      .map((value) => ({
        entity_id: value.entity_id || null,
        context_key: value.context_key,
        uid: value.uid,
        report_field_id: value.report_field_id,
        value: value.value,
        source_type: value.source_type,
        source_reference: value.source_reference || null,
        is_appraiser_confirmed: Boolean(value.is_appraiser_confirmed),
        is_override: Boolean(value.is_override),
      }))
      .sort((left, right) => (
        `${left.entity_id || "root"}:${left.context_key}:${left.uid}`
          .localeCompare(`${right.entity_id || "root"}:${right.context_key}:${right.uid}`)
      )),
    assets: assets
      .map((asset) => ({
        id: asset.id,
        entity_id: asset.entity_id || null,
        asset_kind: asset.asset_kind,
        section_number: asset.section_number == null ? null : Number(asset.section_number),
        caption_type: asset.caption_type || null,
        caption: asset.caption || null,
        original_file_name: asset.original_file_name || null,
        content_type: asset.content_type,
        byte_size: asset.byte_size == null ? null : Number(asset.byte_size),
        status: asset.status,
        capture_metadata: asset.capture_metadata || {},
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    sketches: sketches
      .map((sketch) => ({
        id: sketch.id,
        entity_id: sketch.entity_id || null,
        schema_version: sketch.schema_version,
        geometry: sketch.geometry || {},
        measurements: sketch.measurements || {},
        calculated_areas: sketch.calculated_areas || {},
        area_overrides: sketch.area_overrides || {},
        rendered_asset_id: sketch.rendered_asset_id || null,
        source: sketch.source,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  return createHash("sha256").update(JSON.stringify(stableJson(document))).digest("hex");
}

function valueKey(value) {
  return `${value.entity_id || "root"}:${value.context_key || value.field_context}:${value.uid || value.uad_uid}`;
}

function valueIsPresent(value) {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") {
    return value.amount !== null && value.amount !== undefined && value.amount !== "" && Boolean(value.unit);
  }
  return true;
}

function valueLookup(valuesByKey, entityId = null) {
  return (requestedKey, options = {}) => {
    if (options.uidOnly) {
      const prefix = `${entityId || "root"}:`;
      const suffix = `:${requestedKey}`;
      for (const [key, value] of valuesByKey) {
        if (key.startsWith(prefix) && key.endsWith(suffix)) return value;
      }
      for (const [key, value] of valuesByKey) {
        if (key.startsWith("root:") && key.endsWith(suffix)) return value;
      }
      return undefined;
    }
    return valuesByKey.get(`${entityId || "root"}:${requestedKey}`)
      ?? valuesByKey.get(`root:${requestedKey}`);
  };
}

function findingFromError(section, error) {
  const field = getUadField(error.context_key, error.uid);
  const code = String(error.code || "invalid").trim() || "invalid";
  return {
    severity: "fatal",
    rule_id: `uad.local.${section}.${code}`,
    uad_uid: error.uid || field?.uid || null,
    report_field_id: field?.reportFieldId || null,
    entity_id: error.entity_id || null,
    message: String(error.message || "The UAD workfile contains an invalid value."),
    metadata: {
      section,
      field_key: error.key || field?.key || null,
      context_key: error.context_key || field?.contextKey || null,
      code,
      validator_version: UAD_LOCAL_VALIDATOR_VERSION,
    },
  };
}

function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = [
      finding.severity,
      finding.rule_id,
      finding.entity_id || "root",
      finding.uad_uid || "",
      finding.message,
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Runs the already-enforced section rules as one deterministic workfile gate.
 * This function is pure so the same rule aggregation can later guard XML and
 * submission-package generation without depending on an HTTP request.
 */
export function buildLocalUadValidationFindings(editor, assets = []) {
  const applicableSections = new Set(
    editor.sections.filter((section) => section.applicable !== false).map((section) => section.key),
  );
  const rows = editor.values.map((value) => ({
    ...value,
    field_context: value.context_key,
    uad_uid: value.uid,
  }));
  const findings = [];

  for (const section of applicableSections) {
    for (const error of validateCompleteSection(section, rows, [], editor.entities, assets)) {
      findings.push(findingFromError(section, error));
    }
  }
  if (applicableSections.has("certifications")) {
    findings.push(...buildUadCertificationWarnings(editor).map((finding) => ({
      ...finding,
      metadata: {
        ...finding.metadata,
        validator_version: UAD_LOCAL_VALIDATOR_VERSION,
      },
    })));
  }

  const valuesByKey = new Map(editor.values.map((value) => [valueKey(value), value.value]));
  const entitiesById = new Map(editor.entities.map((entity) => [entity.id, entity]));
  for (const value of editor.values) {
    const field = getUadField(value.context_key, value.uid);
    if (!field) {
      findings.push({
        severity: "fatal",
        rule_id: "uad.local.catalog.unknown_field",
        uad_uid: value.uid || null,
        report_field_id: value.report_field_id || null,
        entity_id: value.entity_id || null,
        message: `Saved field ${value.context_key}:${value.uid} is not in the locked UAD field catalog.`,
        metadata: {
          section: "catalog",
          context_key: value.context_key,
          code: "unknown_field",
          validator_version: UAD_LOCAL_VALIDATOR_VERSION,
        },
      });
      continue;
    }

    const normalized = normalizeAndValidateUadValue(field, value.value);
    if (normalized.error) findings.push(findingFromError(field.section, normalized.error));

    if (
      !valueIsPresent(value.value)
      || value.is_appraiser_confirmed
      || value.source_type === "calculated"
      || field.calculated
      || field.readOnly
      || !applicableSections.has(field.section)
    ) continue;

    const entity = value.entity_id ? entitiesById.get(value.entity_id) : null;
    if ((field.entityType && !uadFieldAppliesToEntity(field, entity)) || (!field.entityType && value.entity_id)) {
      continue;
    }
    const lookup = valueLookup(valuesByKey, value.entity_id || null);
    if (!uadFieldIsVisible(field, lookup)) continue;

    findings.push({
      severity: "fatal",
      rule_id: `uad.local.${field.section}.appraiser_confirmation_required`,
      uad_uid: field.uid,
      report_field_id: field.reportFieldId,
      entity_id: value.entity_id || null,
      message: `${field.label} must be reviewed and saved by the appraiser.`,
      metadata: {
        section: field.section,
        field_key: field.key,
        context_key: field.contextKey,
        code: "appraiser_confirmation_required",
        source_type: value.source_type,
        validator_version: UAD_LOCAL_VALIDATOR_VERSION,
      },
    });
  }

  const result = dedupeFindings(findings);
  if (result.length > MAX_FINDINGS) throw new Error("uad_validation_findings_too_large");
  return result;
}

function findingResponse(row) {
  return {
    id: row.id,
    rule_id: row.rule_id || null,
    severity: row.severity,
    uad_uid: row.uad_uid || null,
    report_field_id: row.report_field_id || null,
    entity_id: row.entity_id || null,
    message: row.message,
    status: row.status,
    metadata: row.metadata || {},
    created_at: row.created_at,
  };
}

function validationResponse(row, findings, workfile) {
  const revisionNumber = Number(row.revision_number);
  const currentRevision = Number(workfile.current_revision);
  return {
    id: row.id,
    workfile_id: row.workfile_id,
    revision_number: revisionNumber,
    specification_release_key: row.specification_release_key,
    validator_type: row.validator_type,
    status: row.status,
    fatal_count: Number(row.fatal_count),
    warning_count: Number(row.warning_count),
    started_at: row.started_at,
    completed_at: row.completed_at,
    metadata: row.metadata || {},
    workfile_status: workfile.status,
    is_current_revision: revisionNumber === currentRevision,
    ready_for_export: row.status === "passed"
      && workfile.status === "ready"
      && revisionNumber === currentRevision,
    findings: findings.map(findingResponse),
  };
}

async function loadFindings(queryable, validationRunId) {
  const { rows } = await queryable.query(
    `SELECT *
       FROM appraisal.uad_validation_findings
      WHERE validation_run_id = $1
      ORDER BY CASE severity WHEN 'fatal' THEN 0 ELSE 1 END,
               metadata->>'section', report_field_id NULLS LAST, created_at, id`,
    [validationRunId],
  );
  return rows;
}

export async function getLatestUadValidation(pool, workfileIdValue) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const workfileResult = await pool.query(
    `SELECT id, current_revision, status
       FROM appraisal.uad_workfiles
      WHERE id = $1`,
    [workfileId],
  );
  if (!workfileResult.rows.length) throw new Error("uad_workfile_not_found");
  const runResult = await pool.query(
    `SELECT *
       FROM appraisal.uad_validation_runs
      WHERE workfile_id = $1 AND validator_type = 'local_compliance'
      ORDER BY started_at DESC, id DESC
      LIMIT 1`,
    [workfileId],
  );
  if (!runResult.rows.length) return null;
  const findings = await loadFindings(pool, runResult.rows[0].id);
  return validationResponse(runResult.rows[0], findings, workfileResult.rows[0]);
}

export async function runLocalUadValidation(pool, workfileIdValue) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT id, current_revision, specification_release_key, status
         FROM appraisal.uad_workfiles
        WHERE id = $1
        FOR UPDATE`,
      [workfileId],
    );
    if (!locked.rows.length) throw new Error("uad_workfile_not_found");
    assertUadWorkfileMutable(locked.rows[0].status, "uad_validation_status_locked");

    await client.query(
      "UPDATE appraisal.uad_workfiles SET status = 'validating', updated_at = now() WHERE id = $1",
      [workfileId],
    );
    const editor = await getUadEditor(client, workfileId);
    const assets = await listUadAssets(client, workfileId);
    const sketches = await listUadSketches(client, workfileId);
    const findings = buildLocalUadValidationFindings(editor, assets);
    const fatalCount = findings.filter((finding) => finding.severity === "fatal").length;
    const warningCount = findings.filter((finding) => finding.severity === "warning").length;
    const status = fatalCount ? "failed" : "passed";
    const workfileStatus = fatalCount ? "draft" : "ready";
    const runId = randomUUID();
    const metadata = {
      validator_version: UAD_LOCAL_VALIDATOR_VERSION,
      applicable_sections: editor.sections
        .filter((section) => section.applicable !== false)
        .map((section) => section.key),
      field_value_count: editor.values.length,
      entity_count: editor.entities.length,
      asset_count: assets.length,
      sketch_count: sketches.length,
      input_digest_sha256: buildUadValidationInputDigest(editor, assets, sketches),
    };

    await client.query(
      `UPDATE appraisal.uad_validation_findings AS finding
          SET status = 'superseded'
         FROM appraisal.uad_validation_runs AS run
        WHERE finding.validation_run_id = run.id
          AND run.workfile_id = $1
          AND run.validator_type = 'local_compliance'
          AND finding.status = 'open'`,
      [workfileId],
    );
    const inserted = await client.query(
      `INSERT INTO appraisal.uad_validation_runs (
         id, workfile_id, revision_number, specification_release_key,
         validator_type, status, fatal_count, warning_count, completed_at, metadata
       ) VALUES ($1, $2, $3, $4, 'local_compliance', $5, $6, $7, now(), $8::jsonb)
       RETURNING *`,
      [
        runId,
        workfileId,
        Number(locked.rows[0].current_revision),
        locked.rows[0].specification_release_key,
        status,
        fatalCount,
        warningCount,
        JSON.stringify(metadata),
      ],
    );

    for (const finding of findings) {
      await client.query(
        `INSERT INTO appraisal.uad_validation_findings (
           id, validation_run_id, rule_id, severity, uad_uid, report_field_id,
           entity_id, message, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          randomUUID(), runId, finding.rule_id, finding.severity, finding.uad_uid,
          finding.report_field_id, finding.entity_id, finding.message,
          JSON.stringify(finding.metadata),
        ],
      );
    }

    await client.query(
      "UPDATE appraisal.uad_workfiles SET status = $2, updated_at = now() WHERE id = $1",
      [workfileId, workfileStatus],
    );
    await client.query(
      `INSERT INTO appraisal.uad_audit_events (
         workfile_id, event_type, entity_type, entity_id, after_data, metadata
       ) VALUES ($1, 'uad_validation.completed', 'uad_validation_run', $2, $3::jsonb, $4::jsonb)`,
      [
        workfileId,
        runId,
        JSON.stringify({ status, fatal_count: fatalCount, warning_count: warningCount }),
        JSON.stringify({
          revision_number: Number(locked.rows[0].current_revision),
          specification_release_key: locked.rows[0].specification_release_key,
          validator_version: UAD_LOCAL_VALIDATOR_VERSION,
        }),
      ],
    );
    const persistedFindings = await loadFindings(client, runId);
    await client.query("COMMIT");

    return validationResponse(inserted.rows[0], persistedFindings, {
      current_revision: locked.rows[0].current_revision,
      status: workfileStatus,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
