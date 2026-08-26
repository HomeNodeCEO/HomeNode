import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import {
  customAppraisalReportReadiness,
  ensureCustomAppraisalReportArtifactSchema,
  ensureSignedCustomAppraisalReportArtifact,
  loadCustomAppraisalPropertySnapshot,
} from "./customAppraisalReportPdf.js";
import { normalizeCostApproachSection } from "./costApproach.js";
import { normalizeIncomeApproachSection } from "./incomeApproach.js";
import { normalizeFinalReconciliationSection } from "./finalReconciliation.js";
import { normalizeSalesComparisonQualitativeAnalysis } from "../util/qualitativeAnalysis.js";

const SECTION_KEY_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const SAVE_REASONS = new Set(["autosave", "manual_save", "legacy_import"]);
const MAX_SECTION_BYTES = 850_000;
const READINESS_WARNING_CODE_PATTERN = /^[a-z][a-z0-9_]{1,95}$/;
const schemaReadyByPool = new WeakMap();

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function normalizeCustomAppraisalSectionKey(value) {
  const sectionKey = String(value || "").trim().toLowerCase();
  if (!SECTION_KEY_PATTERN.test(sectionKey)) {
    throw new Error("invalid_custom_appraisal_section_key");
  }
  return sectionKey;
}

export function normalizeCustomAppraisalSectionValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_custom_appraisal_section_value");
  }
  if (jsonBytes(value) > MAX_SECTION_BYTES) {
    throw new Error("custom_appraisal_section_too_large");
  }
  return value;
}

export function normalizeCustomAppraisalSectionRevision(value) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("invalid_custom_appraisal_section_revision");
  }
  return revision;
}

export function normalizeCustomAppraisalSaveReason(value) {
  const reason = String(value || "autosave").trim().toLowerCase();
  if (!SAVE_REASONS.has(reason)) {
    throw new Error("invalid_custom_appraisal_save_reason");
  }
  return reason;
}

export function normalizeCustomAppraisalWarningCodes(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 50) {
    throw new Error("invalid_custom_appraisal_warning_codes");
  }
  const codes = value.map((code) => String(code || "").trim().toLowerCase());
  if (codes.some((code) => !READINESS_WARNING_CODE_PATTERN.test(code))) {
    throw new Error("invalid_custom_appraisal_warning_codes");
  }
  return [...new Set(codes)];
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value.toJSON === "function") return stableJson(value.toJSON());
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  }
  return value;
}

export function customAppraisalSnapshotChecksum(snapshot) {
  return createHash("sha256").update(JSON.stringify(stableJson(snapshot))).digest("hex");
}

export function customAppraisalSignatureHmac(signingSecretValue, input) {
  const signingSecret = String(signingSecretValue || "");
  if (signingSecret.length < 32) throw new Error("custom_appraisal_signing_secret_not_configured");
  return createHmac("sha256", signingSecret).update(JSON.stringify({
    signature_event_id: input.signatureEventId,
    organization_id: input.organizationId || null,
    signer_user_id: input.signerUserId || null,
    signed_at: input.signedAt,
    snapshot_checksum_sha256: input.snapshotChecksumSha256,
  })).digest("hex");
}

export function verifyCustomAppraisalSignedSnapshot(row, signingSecretValue) {
  if (!row?.signature_hmac_sha256) return true;
  const snapshotChecksum = customAppraisalSnapshotChecksum(row.snapshot);
  if (snapshotChecksum !== row.checksum_sha256) {
    throw new Error("custom_appraisal_signed_snapshot_integrity_failed");
  }
  const expected = customAppraisalSignatureHmac(signingSecretValue, {
    signatureEventId: row.signature_event_id,
    organizationId: row.organization_id,
    signerUserId: row.signed_by_user_id,
    signedAt: row.signed_at,
    snapshotChecksumSha256: row.checksum_sha256,
  });
  const actual = String(row.signature_hmac_sha256 || "");
  if (!/^[a-f0-9]{64}$/.test(actual)
      || !timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"))) {
    throw new Error("custom_appraisal_signed_snapshot_integrity_failed");
  }
  return true;
}

export function canonicalCustomAppraisalFileName(fileNumber, assignmentFileId) {
  const base = String(fileNumber || "appraisal")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "appraisal";
  const id = Number(assignmentFileId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("invalid_assignment_file_id");
  }
  return `${base}-${id}.homenode-appraisal.json`;
}

export async function ensureCustomAppraisalWorkfileSchema(pool) {
  const existing = schemaReadyByPool.get(pool);
  if (existing) return existing;
  const pending = (async () => {
    await pool.query(`
    CREATE SCHEMA IF NOT EXISTS app;

    CREATE TABLE IF NOT EXISTS app.custom_appraisal_workfiles (
      assignment_file_id bigint PRIMARY KEY REFERENCES app.assignment_files(id) ON DELETE RESTRICT,
      workfile_key uuid NOT NULL DEFAULT gen_random_uuid(),
      canonical_file_name text NOT NULL,
      schema_version integer NOT NULL DEFAULT 1,
      status text NOT NULL DEFAULT 'draft',
      signed_at timestamptz,
      signed_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (workfile_key),
      UNIQUE (canonical_file_name),
      CHECK (schema_version >= 1),
      CHECK (status IN ('draft', 'signed', 'archived')),
      CHECK ((status = 'signed' AND signed_at IS NOT NULL) OR status <> 'signed')
    );

    CREATE TABLE IF NOT EXISTS app.custom_appraisal_workfile_sections (
      assignment_file_id bigint NOT NULL REFERENCES app.custom_appraisal_workfiles(assignment_file_id) ON DELETE RESTRICT,
      section_key text NOT NULL,
      section_value jsonb NOT NULL DEFAULT '{}'::jsonb,
      revision integer NOT NULL DEFAULT 1,
      updated_by text NOT NULL DEFAULT 'HomeNode editor',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (assignment_file_id, section_key),
      CHECK (section_key ~ '^[a-z][a-z0-9_]{1,63}$'),
      CHECK (jsonb_typeof(section_value) = 'object'),
      CHECK (revision >= 1)
    );

    CREATE INDEX IF NOT EXISTS custom_appraisal_workfiles_status_updated_idx
      ON app.custom_appraisal_workfiles (status, updated_at DESC, assignment_file_id);

    CREATE TABLE IF NOT EXISTS app.custom_appraisal_workfile_section_history (
      id bigserial PRIMARY KEY,
      assignment_file_id bigint NOT NULL REFERENCES app.custom_appraisal_workfiles(assignment_file_id) ON DELETE RESTRICT,
      section_key text NOT NULL,
      section_value jsonb NOT NULL,
      revision integer NOT NULL,
      event_type text NOT NULL DEFAULT 'autosave',
      changed_by text NOT NULL DEFAULT 'HomeNode editor',
      changed_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (assignment_file_id, section_key, revision),
      CHECK (section_key ~ '^[a-z][a-z0-9_]{1,63}$'),
      CHECK (jsonb_typeof(section_value) = 'object'),
      CHECK (revision >= 1),
      CHECK (event_type IN ('autosave', 'manual_save', 'legacy_import', 'signed'))
    );

    CREATE INDEX IF NOT EXISTS custom_appraisal_workfile_section_history_idx
      ON app.custom_appraisal_workfile_section_history
        (assignment_file_id, section_key, revision DESC, changed_at DESC);

    CREATE TABLE IF NOT EXISTS app.custom_appraisal_signed_snapshots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      assignment_file_id bigint NOT NULL UNIQUE REFERENCES app.custom_appraisal_workfiles(assignment_file_id) ON DELETE RESTRICT,
      canonical_file_name text NOT NULL UNIQUE,
      schema_version integer NOT NULL,
      snapshot jsonb NOT NULL,
      checksum_sha256 text NOT NULL,
      signed_by text NOT NULL,
      organization_id uuid REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
      signed_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE RESTRICT,
      signature_event_id uuid NOT NULL DEFAULT gen_random_uuid(),
      signed_from_ip text,
      signed_user_agent text,
      signature_hmac_sha256 text,
      signed_at timestamptz NOT NULL DEFAULT now(),
      CHECK (schema_version >= 1),
      CHECK (jsonb_typeof(snapshot) = 'object'),
      CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$')
    );
    ALTER TABLE app.custom_appraisal_signed_snapshots
      ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS signed_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS signature_event_id uuid NOT NULL DEFAULT gen_random_uuid(),
      ADD COLUMN IF NOT EXISTS signed_from_ip text,
      ADD COLUMN IF NOT EXISTS signed_user_agent text,
      ADD COLUMN IF NOT EXISTS signature_hmac_sha256 text;
    CREATE UNIQUE INDEX IF NOT EXISTS custom_appraisal_signed_signature_event_uidx
      ON app.custom_appraisal_signed_snapshots (signature_event_id);
  `);

    await pool.query(`
    INSERT INTO app.custom_appraisal_workfiles (
      assignment_file_id,
      canonical_file_name
    )
    SELECT
      assignment_file.id,
      COALESCE(
        NULLIF(left(
          trim(both '-' from regexp_replace(lower(assignment_file.file_number), '[^a-z0-9]+', '-', 'g')),
          72
        ), ''),
        'appraisal'
      ) || '-' || assignment_file.id::text || '.homenode-appraisal.json'
    FROM app.assignment_files assignment_file
    ON CONFLICT (assignment_file_id) DO NOTHING
    `);
  })().catch((error) => {
    schemaReadyByPool.delete(pool);
    throw error;
  });
  schemaReadyByPool.set(pool, pending);
  return pending;
}

async function ensureWorkfileRow(client, accountId, assignmentFileId) {
  const { rows } = await client.query(
    `SELECT assignment_file.id, assignment_file.file_number
       FROM app.assignment_files assignment_file
      WHERE assignment_file.id = $1 AND assignment_file.account_id = $2`,
    [assignmentFileId, accountId],
  );
  const assignmentFile = rows[0];
  if (!assignmentFile) throw new Error("assignment_file_not_found");
  await client.query(
    `INSERT INTO app.custom_appraisal_workfiles (
       assignment_file_id, canonical_file_name
     ) VALUES ($1, $2)
     ON CONFLICT (assignment_file_id) DO NOTHING`,
    [
      assignmentFileId,
      canonicalCustomAppraisalFileName(assignmentFile.file_number, assignmentFileId),
    ],
  );
  return assignmentFile;
}

function workfileResponse(workfile, sections, signedSnapshot = null) {
  return {
    assignment_file_id: Number(workfile.assignment_file_id),
    file_number: workfile.file_number,
    workfile_key: workfile.workfile_key,
    canonical_file_name: workfile.canonical_file_name,
    schema_version: Number(workfile.schema_version),
    status: workfile.status,
    signed_at: workfile.signed_at || null,
    signed_by: workfile.signed_by || null,
    created_at: workfile.created_at,
    updated_at: workfile.updated_at,
    signed_snapshot: signedSnapshot ? {
      id: signedSnapshot.id,
      checksum_sha256: signedSnapshot.checksum_sha256,
      signed_at: signedSnapshot.signed_at,
      signed_by: signedSnapshot.signed_by,
      signed_by_user_id: signedSnapshot.signed_by_user_id || null,
      organization_id: signedSnapshot.organization_id || null,
      signature_event_id: signedSnapshot.signature_event_id || null,
      signature_hmac_sha256: signedSnapshot.signature_hmac_sha256 || null,
    } : null,
    sections: Object.fromEntries(sections.map((section) => [section.section_key, {
      value: section.section_value || {},
      revision: Number(section.revision),
      updated_by: section.updated_by,
      updated_at: section.updated_at,
    }])),
  };
}

export async function getCustomAppraisalWorkfile(pool, { accountId, assignmentFileId }) {
  await ensureCustomAppraisalWorkfileSchema(pool);
  await ensureWorkfileRow(pool, accountId, assignmentFileId);
  const [{ rows: workfileRows }, { rows: sectionRows }, { rows: signedRows }] = await Promise.all([
    pool.query(
      `SELECT workfile.*, assignment_file.file_number
         FROM app.custom_appraisal_workfiles workfile
         JOIN app.assignment_files assignment_file ON assignment_file.id = workfile.assignment_file_id
        WHERE workfile.assignment_file_id = $1 AND assignment_file.account_id = $2`,
      [assignmentFileId, accountId],
    ),
    pool.query(
      `SELECT section_key, section_value, revision, updated_by, updated_at
         FROM app.custom_appraisal_workfile_sections
        WHERE assignment_file_id = $1
        ORDER BY section_key`,
      [assignmentFileId],
    ),
    pool.query(
      `SELECT id, checksum_sha256, signed_at, signed_by,
              organization_id, signed_by_user_id, signature_event_id,
              signature_hmac_sha256
         FROM app.custom_appraisal_signed_snapshots
        WHERE assignment_file_id = $1`,
      [assignmentFileId],
    ),
  ]);
  if (!workfileRows.length) throw new Error("assignment_file_not_found");
  return workfileResponse(workfileRows[0], sectionRows, signedRows[0] || null);
}

/**
 * Run the authoritative server E&O preflight without mutating or locking the
 * appraisal file. This is deliberately on-demand so property-report loading
 * remains fast; final signing runs the same checks again inside its transaction.
 */
export async function getCustomAppraisalWorkfileReadiness(pool, {
  accountId,
  assignmentFileId,
}) {
  const [workfile, property] = await Promise.all([
    getCustomAppraisalWorkfile(pool, { accountId, assignmentFileId }),
    loadCustomAppraisalPropertySnapshot(pool, { accountId, assignmentFileId }),
  ]);
  const snapshot = {
    record_kind: "homenode_custom_appraisal_readiness_preview",
    ...workfile,
    assignment: property.assignment,
    evidence: { property_report_data: property },
  };
  return {
    ...customAppraisalReportReadiness(snapshot, property),
    assignment_file_id: Number(assignmentFileId),
    workfile_status: workfile.status,
    evaluated_at: new Date().toISOString(),
  };
}

async function queryJsonRowsIfAvailable(client, tableName, sql, params) {
  const { rows: tableRows } = await client.query("SELECT to_regclass($1) AS table_name", [tableName]);
  if (!tableRows[0]?.table_name) return [];
  const { rows } = await client.query(sql, params);
  return rows.map((row) => row.record);
}

async function signedEvidenceManifest(client, { accountId, assignmentFileId }) {
  const assignmentResult = await client.query(
    `SELECT jsonb_build_object(
       'id', assignment_file.id,
       'account_id', assignment_file.account_id,
       'file_number', assignment_file.file_number,
       'revision', assignment_file.revision,
       'assignment_details', assignment_file.assignment_details,
       'created_at', assignment_file.created_at,
       'updated_at', assignment_file.updated_at
     ) AS record
       FROM app.assignment_files assignment_file
      WHERE assignment_file.id = $1 AND assignment_file.account_id = $2`,
    [assignmentFileId, accountId],
  );
  const reportFiles = await queryJsonRowsIfAvailable(
    client,
    "app.report_files",
    `SELECT to_jsonb(report_file) AS record
       FROM app.report_files report_file
      WHERE report_file.custom_assignment_file_id = $1
      ORDER BY report_file.updated_at DESC, report_file.id`,
    [assignmentFileId],
  );
  const reportFileIds = reportFiles.map((record) => record.id).filter(Boolean);
  const documents = await queryJsonRowsIfAvailable(
    client,
    "app.assignment_documents",
    `SELECT to_jsonb(document) - 'content' AS record
       FROM app.assignment_documents document
      WHERE document.account_id = $1
        AND document.assignment_file_id = $2
      ORDER BY document.uploaded_at, document.id`,
    [accountId, assignmentFileId],
  );
  const photos = reportFileIds.length ? await queryJsonRowsIfAvailable(
    client,
    "app.inspection_photos",
    `SELECT to_jsonb(photo) AS record
       FROM app.inspection_photos photo
      WHERE photo.report_file_id = ANY($1::uuid[])
      ORDER BY photo.position, photo.created_at, photo.id`,
    [reportFileIds],
  ) : [];
  const photoIds = photos.map((record) => record.id).filter(Boolean);
  const photoObjects = photoIds.length ? await queryJsonRowsIfAvailable(
    client,
    "app.inspection_photo_objects",
    `SELECT to_jsonb(object) AS record
       FROM app.inspection_photo_objects object
      WHERE object.photo_id = ANY($1::uuid[])
      ORDER BY object.photo_id, object.variant, object.id`,
    [photoIds],
  ) : [];
  const sketches = reportFileIds.length ? await queryJsonRowsIfAvailable(
    client,
    "app.inspection_sketches",
    `SELECT to_jsonb(sketch) AS record
       FROM app.inspection_sketches sketch
      WHERE sketch.report_file_id = ANY($1::uuid[])
      ORDER BY sketch.updated_at, sketch.id`,
    [reportFileIds],
  ) : [];
  const propertyContext = await queryJsonRowsIfAvailable(
    client,
    "app.property_complexity_assessments",
    `SELECT to_jsonb(assessment) AS record
       FROM app.property_complexity_assessments assessment
      WHERE assessment.account_id = $1
        AND (assessment.assignment_file_id = $2 OR assessment.assignment_file_id IS NULL)
      ORDER BY (assessment.assignment_file_id = $2) DESC,
               assessment.updated_at DESC, assessment.id DESC
      LIMIT 1`,
    [accountId, assignmentFileId],
  );
  const neighborhoodBoundaries = await queryJsonRowsIfAvailable(
    client,
    "app.neighborhood_boundary_assessments",
    `SELECT to_jsonb(assessment) AS record
       FROM app.neighborhood_boundary_assessments assessment
      WHERE assessment.account_id = $1
        AND (assessment.assignment_file_id = $2 OR assessment.assignment_file_id IS NULL)
      ORDER BY (assessment.assignment_file_id = $2) DESC,
               assessment.updated_at DESC, assessment.id DESC
      LIMIT 1`,
    [accountId, assignmentFileId],
  );
  const neighborhoodRelevance = await queryJsonRowsIfAvailable(
    client,
    "app.neighborhood_relevance_assessments",
    `SELECT to_jsonb(assessment) AS record
       FROM app.neighborhood_relevance_assessments assessment
      WHERE assessment.account_id = $1
        AND (assessment.assignment_file_id = $2 OR assessment.assignment_file_id IS NULL)
      ORDER BY (assessment.assignment_file_id = $2) DESC,
               assessment.updated_at DESC, assessment.id DESC
      LIMIT 1`,
    [accountId, assignmentFileId],
  );
  const propertyReportData = await loadCustomAppraisalPropertySnapshot(client, {
    accountId,
    assignmentFileId,
  });
  return {
    assignment: assignmentResult.rows[0]?.record || null,
    evidence: {
      documents,
      report_files: reportFiles,
      inspection_photos: photos,
      inspection_photo_objects: photoObjects,
      inspection_sketches: sketches,
      property_context: propertyContext[0] || null,
      neighborhood_boundary: neighborhoodBoundaries[0] || null,
      neighborhood_relevance: neighborhoodRelevance[0] || null,
      property_report_data: propertyReportData,
    },
  };
}

export async function saveCustomAppraisalWorkfileSection(pool, {
  accountId,
  assignmentFileId,
  sectionKey: sectionKeyValue,
  sectionValue: sectionValueInput,
  expectedRevision: expectedRevisionValue,
  saveReason: saveReasonValue,
  reviewer: reviewerValue,
}) {
  const sectionKey = normalizeCustomAppraisalSectionKey(sectionKeyValue);
  let sectionValue = normalizeCustomAppraisalSectionValue(
    sectionKey === "cost_approach"
      ? normalizeCostApproachSection(sectionValueInput)
      : sectionKey === "income_approach"
        ? normalizeIncomeApproachSection(sectionValueInput)
        : sectionKey === "sales_comparison"
          ? normalizeSalesComparisonQualitativeAnalysis(sectionValueInput)
          : sectionValueInput,
  );
  const expectedRevision = normalizeCustomAppraisalSectionRevision(expectedRevisionValue);
  const saveReason = normalizeCustomAppraisalSaveReason(saveReasonValue);
  const reviewer = String(reviewerValue || "HomeNode editor").trim().slice(0, 200) || "HomeNode editor";
  await ensureCustomAppraisalWorkfileSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkfileRow(client, accountId, assignmentFileId);
    const metaResult = await client.query(
      `SELECT status FROM app.custom_appraisal_workfiles
        WHERE assignment_file_id = $1 FOR UPDATE`,
      [assignmentFileId],
    );
    if (metaResult.rows[0]?.status === "signed") {
      throw new Error("custom_appraisal_workfile_signed");
    }
    const existingResult = await client.query(
      `SELECT revision FROM app.custom_appraisal_workfile_sections
        WHERE assignment_file_id = $1 AND section_key = $2 FOR UPDATE`,
      [assignmentFileId, sectionKey],
    );
    const currentRevision = Number(existingResult.rows[0]?.revision || 0);
    if (currentRevision !== expectedRevision) {
      const error = new Error("custom_appraisal_section_revision_conflict");
      error.currentRevision = currentRevision;
      throw error;
    }
    if (sectionKey === "final_reconciliation") {
      const sourceResult = await client.query(
        `SELECT section_key, section_value, revision
           FROM app.custom_appraisal_workfile_sections
          WHERE assignment_file_id = $1
            AND section_key = ANY($2::text[])
          FOR SHARE`,
        [assignmentFileId, ["sales_comparison", "income_approach", "cost_approach"]],
      );
      const sourceSections = {};
      for (const source of sourceResult.rows) {
        sourceSections[source.section_key] = source.section_value || {};
        sourceSections[`${source.section_key}_revision`] = Number(source.revision || 0);
      }
      sectionValue = normalizeCustomAppraisalSectionValue(
        normalizeFinalReconciliationSection(sectionValueInput, sourceSections),
      );
    }
    const nextRevision = currentRevision + 1;
    const { rows } = await client.query(
      `INSERT INTO app.custom_appraisal_workfile_sections (
         assignment_file_id, section_key, section_value, revision, updated_by
       ) VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (assignment_file_id, section_key) DO UPDATE SET
         section_value = EXCLUDED.section_value,
         revision = EXCLUDED.revision,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING section_key, section_value, revision, updated_by, updated_at`,
      [assignmentFileId, sectionKey, JSON.stringify(sectionValue), nextRevision, reviewer],
    );
    await client.query(
      `INSERT INTO app.custom_appraisal_workfile_section_history (
         assignment_file_id, section_key, section_value, revision,
         event_type, changed_by
       ) VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
      [assignmentFileId, sectionKey, JSON.stringify(sectionValue), nextRevision, saveReason, reviewer],
    );
    await client.query(
      `UPDATE app.custom_appraisal_workfiles SET updated_at = now()
        WHERE assignment_file_id = $1`,
      [assignmentFileId],
    );
    await client.query(
      `UPDATE app.assignment_files SET updated_at = now() WHERE id = $1`,
      [assignmentFileId],
    );
    await client.query("COMMIT");
    return {
      key: rows[0].section_key,
      value: rows[0].section_value,
      revision: Number(rows[0].revision),
      updated_by: rows[0].updated_by,
      updated_at: rows[0].updated_at,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function signCustomAppraisalWorkfile(pool, {
  accountId,
  assignmentFileId,
  signedBy: signedByValue,
  signerUserId = null,
  signatureEventId: signatureEventIdValue = null,
  signedFromIp: signedFromIpValue = null,
  signedUserAgent: signedUserAgentValue = null,
  signingSecret: signingSecretValue = null,
  acknowledgedWarningCodes: acknowledgedWarningCodesValue,
}) {
  const signedBy = String(signedByValue || "HomeNode editor").trim().slice(0, 200);
  if (!signedBy) throw new Error("invalid_custom_appraisal_signer");
  const signingSecret = String(signingSecretValue || "");
  if (signerUserId && signingSecret.length < 32) {
    throw new Error("custom_appraisal_signing_secret_not_configured");
  }
  const signatureEventId = String(signatureEventIdValue || randomUUID()).trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(signatureEventId)) {
    throw new Error("invalid_custom_appraisal_signature_event");
  }
  const signedFromIp = String(signedFromIpValue || "").trim().slice(0, 200) || null;
  const signedUserAgent = String(signedUserAgentValue || "").trim().slice(0, 1_000) || null;
  const acknowledgedWarningCodes = normalizeCustomAppraisalWarningCodes(
    acknowledgedWarningCodesValue,
  );
  await ensureCustomAppraisalWorkfileSchema(pool);
  await ensureCustomAppraisalReportArtifactSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkfileRow(client, accountId, assignmentFileId);
    const metaResult = await client.query(
      `SELECT workfile.*, assignment_file.file_number,
              assignment_file.organization_id,
              assignment_file.assigned_appraiser_user_id,
              assignment_file.supervisory_appraiser_user_id
         FROM app.custom_appraisal_workfiles workfile
         JOIN app.assignment_files assignment_file ON assignment_file.id = workfile.assignment_file_id
        WHERE workfile.assignment_file_id = $1 AND assignment_file.account_id = $2
        FOR UPDATE OF workfile`,
      [assignmentFileId, accountId],
    );
    const workfile = metaResult.rows[0];
    if (!workfile) throw new Error("assignment_file_not_found");
    if (workfile.status === "signed") throw new Error("custom_appraisal_workfile_signed");
    if (signerUserId && ![
      workfile.assigned_appraiser_user_id,
      workfile.supervisory_appraiser_user_id,
    ].includes(signerUserId)) {
      throw new Error("custom_appraisal_signer_not_assigned");
    }
    const sectionResult = await client.query(
      `SELECT section_key, section_value, revision, updated_by, updated_at
         FROM app.custom_appraisal_workfile_sections
        WHERE assignment_file_id = $1 ORDER BY section_key FOR SHARE`,
      [assignmentFileId],
    );
    if (!sectionResult.rows.length) throw new Error("custom_appraisal_workfile_empty");
    const manifest = await signedEvidenceManifest(client, { accountId, assignmentFileId });
    const snapshot = {
      record_kind: "homenode_custom_appraisal_signed_snapshot",
      ...workfileResponse(workfile, sectionResult.rows),
      ...manifest,
    };
    const signedAt = new Date().toISOString();
    snapshot.status = "signed";
    snapshot.signed_at = signedAt;
    snapshot.signed_by = signedBy;
    snapshot.signature = {
      event_id: signatureEventId,
      organization_id: workfile.organization_id || null,
      signer_user_id: signerUserId || null,
      signed_from_ip: signedFromIp,
      signed_user_agent: signedUserAgent,
    };
    const readiness = customAppraisalReportReadiness(
      snapshot,
      manifest.evidence.property_report_data,
    );
    if (readiness.blockers.length) {
      const error = new Error("custom_appraisal_eo_incomplete");
      error.readinessErrors = readiness.blocker_messages;
      error.readiness = readiness;
      throw error;
    }
    const acknowledgedSet = new Set(acknowledgedWarningCodes);
    const unacknowledgedWarnings = readiness.warnings.filter(
      (warning) => !acknowledgedSet.has(warning.code),
    );
    if (unacknowledgedWarnings.length) {
      const error = new Error("custom_appraisal_eo_warnings_unacknowledged");
      error.readinessWarnings = unacknowledgedWarnings;
      error.readiness = readiness;
      throw error;
    }
    snapshot.eo_readiness = {
      version: 1,
      evaluated_at: signedAt,
      blockers: [],
      warnings: readiness.warnings,
      acknowledged_warning_codes: readiness.warning_codes,
      acknowledged_by: signedBy,
    };
    const serialized = JSON.stringify(snapshot);
    const checksum = customAppraisalSnapshotChecksum(snapshot);
    const signatureHmac = signingSecret
      ? customAppraisalSignatureHmac(signingSecret, {
        signatureEventId,
        organizationId: workfile.organization_id,
        signerUserId,
        signedAt,
        snapshotChecksumSha256: checksum,
      })
      : null;
    const signedResult = await client.query(
      `INSERT INTO app.custom_appraisal_signed_snapshots (
         assignment_file_id, canonical_file_name, schema_version,
         snapshot, checksum_sha256, signed_by, signed_at,
         organization_id, signed_by_user_id, signature_event_id,
         signed_from_ip, signed_user_agent, signature_hmac_sha256
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::timestamptz,
                 $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        assignmentFileId,
        workfile.canonical_file_name,
        workfile.schema_version,
        serialized,
        checksum,
        signedBy,
        signedAt,
        workfile.organization_id || null,
        signerUserId || null,
        signatureEventId,
        signedFromIp,
        signedUserAgent,
        signatureHmac,
      ],
    );
    await client.query(
      `UPDATE app.custom_appraisal_workfiles
          SET status = 'signed', signed_at = $2::timestamptz,
              signed_by = $3, updated_at = now()
        WHERE assignment_file_id = $1`,
      [assignmentFileId, signedAt, signedBy],
    );
    const artifact = await ensureSignedCustomAppraisalReportArtifact(client, {
      accountId,
      assignmentFileId,
      snapshot,
      signedSnapshotId: signedResult.rows[0].id,
      workfileChecksum: checksum,
    });
    await client.query("COMMIT");
    const reportPdf = {
      canonical_file_name: artifact.canonical_file_name,
      checksum_sha256: artifact.content_sha256,
      page_count: Number(artifact.page_count),
      byte_size: Number(artifact.byte_size),
      generated_at: artifact.generated_at,
    };
    return {
      ...snapshot,
      checksum_sha256: checksum,
      report_pdf: reportPdf,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getCustomAppraisalWorkfileDownload(pool, {
  accountId,
  assignmentFileId,
  signingSecret = null,
}) {
  await ensureCustomAppraisalWorkfileSchema(pool);
  const signedResult = await pool.query(
    `SELECT snapshot.snapshot, snapshot.canonical_file_name,
            snapshot.checksum_sha256, snapshot.signed_at,
            snapshot.organization_id, snapshot.signed_by_user_id,
            snapshot.signature_event_id, snapshot.signature_hmac_sha256
       FROM app.custom_appraisal_signed_snapshots snapshot
       JOIN app.assignment_files assignment_file
         ON assignment_file.id = snapshot.assignment_file_id
      WHERE snapshot.assignment_file_id = $1
        AND assignment_file.account_id = $2`,
    [assignmentFileId, accountId],
  );
  if (signedResult.rows.length) {
    verifyCustomAppraisalSignedSnapshot(signedResult.rows[0], signingSecret);
    return {
      snapshot: signedResult.rows[0].snapshot,
      canonical_file_name: signedResult.rows[0].canonical_file_name,
      checksum_sha256: signedResult.rows[0].checksum_sha256,
      signed_at: signedResult.rows[0].signed_at,
      immutable: true,
    };
  }
  const workfile = await getCustomAppraisalWorkfile(pool, { accountId, assignmentFileId });
  return {
    snapshot: {
      record_kind: "homenode_custom_appraisal_draft",
      ...workfile,
    },
    canonical_file_name: workfile.canonical_file_name,
    checksum_sha256: null,
    signed_at: null,
    immutable: false,
  };
}
