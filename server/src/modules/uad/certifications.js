import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { listUadAssets } from "./assets.js";
import { getUadEditor } from "./editor.js";
import { listUadSketches } from "./sketches.js";
import { evaluateUadSignatureQuorum } from "./signatureQuorum.js";
import { buildUadValidationInputDigest } from "./validation.js";
import { normalizeUadWorkfileId } from "./workfiles.js";

const LICENSE_TYPES = new Set([
  "CertifiedGeneral",
  "CertifiedResidential",
  "LicensedResidentialAppraiser",
  "None",
  "Other",
  "TraineeAppraiser",
]);

const SIGNATURE_ACKNOWLEDGMENT_PURPOSE = "uad_signature_acknowledgment";
const SIGNATURE_ACKNOWLEDGMENT_VERSION = 1;
const SIGNATURE_ACKNOWLEDGMENT_LIFETIME_MILLISECONDS = 15 * 60 * 1000;
const SIGNATURE_ACKNOWLEDGMENT_MAX_TOKEN_LENGTH = 8_192;

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stableJson(value))).digest("hex");
}

function signingSecret(value) {
  const secret = String(value || "");
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("uad_signature_acknowledgment_unavailable");
  }
  return secret;
}

function authenticationBinding(authentication) {
  return {
    issuer: String(authentication?.issuer || "").trim() || null,
    subject: String(authentication?.subject || "").trim() || null,
  };
}

function acknowledgmentError(code = "uad_signature_acknowledgment_invalid") {
  return new Error(code);
}

export function createUadSignatureAcknowledgmentToken({
  workfileId,
  revisionNumber,
  inputDigest,
  signerUserId,
  signerRole,
  authentication,
}, secretValue, {
  now = new Date(),
  acknowledgmentId = randomUUID(),
} = {}) {
  const issuedAt = new Date(now);
  if (!Number.isFinite(issuedAt.getTime())) throw acknowledgmentError();
  const binding = authenticationBinding(authentication);
  const payload = {
    version: SIGNATURE_ACKNOWLEDGMENT_VERSION,
    purpose: SIGNATURE_ACKNOWLEDGMENT_PURPOSE,
    acknowledgment_id: acknowledgmentId,
    workfile_id: workfileId,
    revision_number: Number(revisionNumber),
    workfile_input_digest_sha256: inputDigest,
    signer_user_id: signerUserId,
    signer_role: signerRole,
    standard_certifications_acknowledged: true,
    scope_of_work_acknowledged: true,
    authentication_issuer: binding.issuer,
    authentication_subject: binding.subject,
    acknowledged_at: issuedAt.toISOString(),
    expires_at: new Date(
      issuedAt.getTime() + SIGNATURE_ACKNOWLEDGMENT_LIFETIME_MILLISECONDS,
    ).toISOString(),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", signingSecret(secretValue))
    .update(body)
    .digest("base64url");
  return { token: `${body}.${signature}`, payload };
}

export function verifyUadSignatureAcknowledgmentToken(tokenValue, expected, secretValue, {
  now = new Date(),
} = {}) {
  const token = String(tokenValue || "").trim();
  if (!token) throw acknowledgmentError("uad_signature_acknowledgment_required");
  if (token.length > SIGNATURE_ACKNOWLEDGMENT_MAX_TOKEN_LENGTH) throw acknowledgmentError();
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw acknowledgmentError();
  const expectedSignature = createHmac("sha256", signingSecret(secretValue))
    .update(parts[0])
    .digest();
  let receivedSignature;
  let payload;
  try {
    const body = Buffer.from(parts[0], "base64url");
    receivedSignature = Buffer.from(parts[1], "base64url");
    if (
      body.toString("base64url") !== parts[0]
      || receivedSignature.toString("base64url") !== parts[1]
    ) throw acknowledgmentError();
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    throw acknowledgmentError();
  }
  if (
    receivedSignature.length !== expectedSignature.length
    || !timingSafeEqual(receivedSignature, expectedSignature)
    || !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
  ) throw acknowledgmentError();

  const currentTime = new Date(now).getTime();
  const acknowledgedAt = Date.parse(payload.acknowledged_at);
  const expiresAt = Date.parse(payload.expires_at);
  if (
    !Number.isFinite(currentTime)
    || !Number.isFinite(acknowledgedAt)
    || !Number.isFinite(expiresAt)
    || acknowledgedAt > currentTime + 30_000
    || expiresAt <= currentTime
    || expiresAt - acknowledgedAt !== SIGNATURE_ACKNOWLEDGMENT_LIFETIME_MILLISECONDS
  ) throw acknowledgmentError("uad_signature_acknowledgment_expired");

  const binding = authenticationBinding(expected.authentication);
  if (
    payload.version !== SIGNATURE_ACKNOWLEDGMENT_VERSION
    || payload.purpose !== SIGNATURE_ACKNOWLEDGMENT_PURPOSE
    || payload.workfile_id !== expected.workfileId
    || Number(payload.revision_number) !== Number(expected.revisionNumber)
    || payload.workfile_input_digest_sha256 !== expected.inputDigest
    || payload.signer_user_id !== expected.signerUserId
    || payload.signer_role !== expected.signerRole
    || payload.standard_certifications_acknowledged !== true
    || payload.scope_of_work_acknowledged !== true
    || payload.authentication_issuer !== binding.issuer
    || payload.authentication_subject !== binding.subject
    || typeof payload.acknowledgment_id !== "string"
    || !payload.acknowledgment_id
  ) throw acknowledgmentError("uad_signature_acknowledgment_mismatch");

  return Object.freeze({
    acknowledgment_id: payload.acknowledgment_id,
    acknowledged_at: payload.acknowledged_at,
    standard_certifications_acknowledged: true,
    scope_of_work_acknowledged: true,
    authentication_issuer: binding.issuer,
    authentication_subject: binding.subject,
  });
}

function isoDate(value) {
  if (!value) return null;
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function nameParts(displayName, metadata = {}) {
  const words = String(displayName || "").trim().split(/\s+/).filter(Boolean);
  return {
    first_name: metadata.first_name || words[0] || null,
    middle_name: metadata.middle_name || (words.length > 2 ? words.slice(1, -1).join(" ") : null),
    last_name: metadata.last_name || (words.length > 1 ? words.at(-1) : null),
    suffix_name: metadata.suffix_name || null,
  };
}

export function normalizeUadAppraiserLicenseType(licenseType, metadata = {}) {
  const explicit = String(metadata.uad_license_type || "").trim();
  if (LICENSE_TYPES.has(explicit)) return explicit;
  const normalized = String(licenseType || "").toLowerCase().replace(/[^a-z]/g, "");
  if (normalized.includes("trainee")) return "TraineeAppraiser";
  if (normalized.includes("certifiedgeneral")) return "CertifiedGeneral";
  if (normalized.includes("certifiedresidential")) return "CertifiedResidential";
  if (normalized.includes("licensedresidential") || normalized === "licensed") {
    return "LicensedResidentialAppraiser";
  }
  if (normalized === "none") return "None";
  return "Other";
}

export function buildUadCredentialSnapshot(row, { capturedAt = new Date().toISOString() } = {}) {
  const names = nameParts(row.display_name, row.user_metadata || {});
  const snapshot = {
    schema_version: "1.0",
    captured_at: capturedAt,
    signer: {
      user_id: row.user_id,
      role: row.signer_role,
      display_name: row.display_name,
      ...names,
    },
    organization: {
      id: row.organization_id,
      legal_name: row.organization_legal_name,
      display_name: row.organization_display_name,
      dba_name: row.organization_dba_name || null,
      address_line_1: row.address_line_1,
      address_line_2: row.address_line_2 || null,
      city: row.city,
      state_code: row.state_code,
      postal_code: row.postal_code,
      country_code: row.country_code || "US",
    },
    license: {
      id: row.license_id,
      jurisdiction: row.jurisdiction,
      license_number: row.license_number,
      license_type: normalizeUadAppraiserLicenseType(row.license_type, row.license_metadata || {}),
      license_type_other_description: row.license_metadata?.uad_license_type_other_description || null,
      issued_on: isoDate(row.issued_on),
      expires_on: isoDate(row.expires_on),
      status: row.license_status,
    },
    signature_policy: row.signature_policy,
  };
  return {
    snapshot,
    credential_snapshot_sha256: digest(snapshot),
  };
}

function missingCredentialFields(row) {
  const names = nameParts(row.display_name, row.user_metadata || {});
  const missing = [];
  if (!row.user_id || row.user_active !== true) missing.push("active_user");
  if (row.profile_status !== "active") missing.push("active_appraiser_profile");
  if (!names.first_name) missing.push("first_name");
  if (!names.last_name) missing.push("last_name");
  if (!row.organization_id) missing.push("organization");
  for (const key of ["organization_display_name", "address_line_1", "city", "state_code", "postal_code"]) {
    if (!row[key]) missing.push(key);
  }
  if (!row.license_id) missing.push("active_license");
  if (!row.license_number) missing.push("license_number");
  if (!row.jurisdiction) missing.push("license_jurisdiction");
  if (!row.expires_on) missing.push("license_expiration_date");
  if (
    row.license_id
    && normalizeUadAppraiserLicenseType(row.license_type, row.license_metadata || {}) === "Other"
    && !row.license_metadata?.uad_license_type_other_description
  ) missing.push("license_type_other_description");
  if (row.expires_on && isoDate(row.expires_on) < new Date().toISOString().slice(0, 10)) {
    missing.push("unexpired_license");
  }
  return missing;
}

async function loadSignerRows(queryable, workfileId) {
  const { rows } = await queryable.query(
    `WITH required_signers AS (
       SELECT workfile.id AS workfile_id, workfile.organization_id,
              'appraiser'::text AS signer_role,
              workfile.assigned_appraiser_user_id AS user_id
         FROM appraisal.uad_workfiles workfile
        WHERE workfile.id = $1
       UNION ALL
       SELECT workfile.id, workfile.organization_id,
              'supervisory_appraiser'::text,
              workfile.supervisory_appraiser_user_id
         FROM appraisal.uad_workfiles workfile
        WHERE workfile.id = $1 AND workfile.supervisory_appraiser_user_id IS NOT NULL
     )
     SELECT signer.workfile_id, signer.signer_role, signer.user_id,
            users.display_name, users.active AS user_active, users.metadata AS user_metadata,
            profile.signature_policy, profile.profile_status,
            organization.id AS organization_id,
            organization.legal_name AS organization_legal_name,
            organization.display_name AS organization_display_name,
            organization.dba_name AS organization_dba_name,
            organization.address_line_1, organization.address_line_2,
            organization.city, organization.state_code, organization.postal_code,
            organization.country_code,
            license.id AS license_id, license.jurisdiction, license.license_number,
            license.license_type, license.issued_on, license.expires_on,
            license.status AS license_status, license.metadata AS license_metadata
       FROM required_signers signer
       LEFT JOIN app_auth.users users ON users.id = signer.user_id
       LEFT JOIN app_auth.appraiser_profiles profile ON profile.user_id = signer.user_id
       LEFT JOIN app_auth.organizations organization
         ON organization.id = COALESCE(signer.organization_id, profile.default_organization_id)
       LEFT JOIN LATERAL (
         SELECT candidate.*
           FROM app_auth.appraiser_licenses candidate
          WHERE candidate.user_id = signer.user_id
            AND candidate.status = 'active'
          ORDER BY
            CASE WHEN candidate.expires_on IS NULL OR candidate.expires_on >= CURRENT_DATE THEN 0 ELSE 1 END,
            candidate.expires_on DESC NULLS LAST,
            candidate.created_at DESC
          LIMIT 1
       ) license ON true
      ORDER BY CASE signer.signer_role WHEN 'appraiser' THEN 0 ELSE 1 END`,
    [workfileId],
  );
  return rows;
}

async function loadSignatureArtifactReadiness(queryable, workfileId, revisionNumber, inputDigest) {
  const { rows } = await queryable.query(
    `SELECT artifact_type, generation_status, metadata
       FROM appraisal.uad_generated_artifacts
      WHERE workfile_id = $1 AND revision_number = $2
        AND artifact_type = 'pdf'`,
    [workfileId, Number(revisionNumber)],
  );
  const artifacts = new Map(rows.map((row) => [row.artifact_type, row]));
  const pdf = artifacts.get("pdf");
  const pdfReady = pdf?.generation_status === "ready"
    && pdf.metadata?.input_digest_sha256 === inputDigest;
  return {
    pdf_ready: pdfReady,
    missing: !pdfReady ? ["current_pdf"] : [],
  };
}

function signerRoleForWorkfile(workfile, actorUserId) {
  if (actorUserId === workfile.assigned_appraiser_user_id) return "appraiser";
  if (actorUserId === workfile.supervisory_appraiser_user_id) return "supervisory_appraiser";
  return null;
}

export async function acknowledgeUadSignature(pool, workfileIdValue, authentication, input = {}, {
  signingSecret: signingSecretValue,
  now = new Date(),
} = {}) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const actorUserId = String(authentication?.userId || "").trim();
  if (!actorUserId) throw new Error("uad_signature_authentication_required");
  if (
    input.standard_certifications_acknowledged !== true
    || input.scope_of_work_acknowledged !== true
  ) throw new Error("uad_signature_acknowledgments_required");
  const expectedRevision = Number(input.expected_revision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error("invalid_uad_signature_acknowledgment_revision");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workfileResult = await client.query(
      `SELECT id, assigned_appraiser_user_id, supervisory_appraiser_user_id,
              current_revision, status
         FROM appraisal.uad_workfiles
        WHERE id = $1
        FOR UPDATE`,
      [workfileId],
    );
    if (!workfileResult.rows.length) throw new Error("uad_workfile_not_found");
    const workfile = workfileResult.rows[0];
    if (workfile.status !== "ready") throw new Error("uad_signature_local_validation_required");
    if (Number(workfile.current_revision) !== expectedRevision) {
      throw new Error("uad_signature_acknowledgment_stale_revision");
    }
    const signerRole = signerRoleForWorkfile(workfile, actorUserId);
    if (!signerRole) throw new Error("uad_signature_access_denied");

    const editor = await getUadEditor(client, workfileId);
    const assets = await listUadAssets(client, workfileId);
    const sketches = await listUadSketches(client, workfileId);
    const inputDigest = buildUadValidationInputDigest(editor, assets, sketches);
    const artifactReadiness = await loadSignatureArtifactReadiness(
      client,
      workfileId,
      expectedRevision,
      inputDigest,
    );
    if (!artifactReadiness.pdf_ready) throw new Error("uad_signature_pdf_required");

    const acknowledgment = createUadSignatureAcknowledgmentToken({
      workfileId,
      revisionNumber: expectedRevision,
      inputDigest,
      signerUserId: actorUserId,
      signerRole,
      authentication,
    }, signingSecretValue, { now });
    await client.query(
      `INSERT INTO appraisal.uad_audit_events (
         workfile_id, actor_user_id, event_type, entity_type, entity_id, after_data, metadata
       ) VALUES ($1, $2, 'uad_signature.acknowledged', 'uad_signature_acknowledgment',
                 $3, $4::jsonb, $5::jsonb)`,
      [
        workfileId,
        actorUserId,
        acknowledgment.payload.acknowledgment_id,
        JSON.stringify({
          standard_certifications_acknowledged: true,
          scope_of_work_acknowledged: true,
        }),
        JSON.stringify({
          revision_number: expectedRevision,
          workfile_input_digest_sha256: inputDigest,
          signer_role: signerRole,
          acknowledged_at: acknowledgment.payload.acknowledged_at,
          expires_at: acknowledgment.payload.expires_at,
        }),
      ],
    );
    await client.query("COMMIT");
    return {
      acknowledgment_token: acknowledgment.token,
      acknowledgment_id: acknowledgment.payload.acknowledgment_id,
      acknowledged_at: acknowledgment.payload.acknowledged_at,
      expires_at: acknowledgment.payload.expires_at,
      revision_number: expectedRevision,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getUadCertificationReadiness(queryable, workfileIdValue) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const workfileResult = await queryable.query(
    `SELECT id, organization_id, assigned_appraiser_user_id,
            supervisory_appraiser_user_id, current_revision, status
       FROM appraisal.uad_workfiles
      WHERE id = $1`,
    [workfileId],
  );
  if (!workfileResult.rows.length) throw new Error("uad_workfile_not_found");
  const rows = await loadSignerRows(queryable, workfileId);
  const signers = rows.map((row) => {
    const missing = missingCredentialFields(row);
    return {
      role: row.signer_role,
      user_id: row.user_id || null,
      display_name: row.display_name || null,
      signature_policy: row.signature_policy || null,
      profile_status: row.profile_status || null,
      organization_name: row.organization_display_name || null,
      license: row.license_id ? {
        jurisdiction: row.jurisdiction,
        license_number: row.license_number,
        license_type: normalizeUadAppraiserLicenseType(row.license_type, row.license_metadata || {}),
        expires_on: isoDate(row.expires_on),
      } : null,
      ready: missing.length === 0,
      missing,
    };
  });
  if (!workfileResult.rows[0].assigned_appraiser_user_id && !signers.length) {
    signers.push({
      role: "appraiser",
      user_id: null,
      display_name: null,
      signature_policy: null,
      profile_status: null,
      organization_name: null,
      license: null,
      ready: false,
      missing: ["assigned_appraiser"],
    });
  }
  const editor = await getUadEditor(queryable, workfileId);
  const [assets, sketches] = await Promise.all([
    listUadAssets(queryable, workfileId),
    listUadSketches(queryable, workfileId),
  ]);
  const inputDigest = buildUadValidationInputDigest(editor, assets, sketches);
  const artifactReadiness = await loadSignatureArtifactReadiness(
    queryable,
    workfileId,
    workfileResult.rows[0].current_revision,
    inputDigest,
  );
  return {
    workfile_id: workfileId,
    revision_number: Number(workfileResult.rows[0].current_revision),
    workfile_status: workfileResult.rows[0].status,
    ready: signers.length > 0
      && signers.every((signer) => signer.ready)
      && artifactReadiness.missing.length === 0,
    artifact_readiness: artifactReadiness,
    signers,
  };
}

export async function signUadWorkfile(pool, workfileIdValue, authentication, input = {}, {
  signingSecret: signingSecretValue,
  now = new Date(),
} = {}) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const actorUserId = String(authentication?.userId || "").trim();
  if (!actorUserId) throw new Error("uad_signature_authentication_required");
  const executionDate = isoDate(now);
  const requestedExecutionDate = input.execution_date ? isoDate(input.execution_date) : executionDate;
  if (!requestedExecutionDate) throw new Error("invalid_uad_signature_execution_date");
  if (requestedExecutionDate !== executionDate) throw new Error("uad_signature_execution_date_mismatch");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workfileResult = await client.query(
      `SELECT * FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE`,
      [workfileId],
    );
    if (!workfileResult.rows.length) throw new Error("uad_workfile_not_found");
    const workfile = workfileResult.rows[0];
    if (workfile.status !== "ready") throw new Error("uad_signature_local_validation_required");

    const signerRole = signerRoleForWorkfile(workfile, actorUserId);
    if (!signerRole) throw new Error("uad_signature_access_denied");

    const signerRows = await loadSignerRows(client, workfileId);
    const signerRow = signerRows.find((row) => row.signer_role === signerRole && row.user_id === actorUserId);
    if (!signerRow) throw new Error("uad_signature_profile_not_found");
    const missing = missingCredentialFields(signerRow);
    if (missing.length) {
      const error = new Error("uad_signature_credentials_incomplete");
      error.details = { missing };
      throw error;
    }
    const authenticationMethod = String(input.authentication_method || "session");
    if (authenticationMethod !== signerRow.signature_policy) throw new Error("uad_signature_authentication_method_mismatch");

    const effectiveDateResult = await client.query(
      `SELECT value #>> '{}' AS effective_date
         FROM appraisal.uad_field_values
        WHERE workfile_id = $1 AND entity_id IS NULL
          AND field_context = 'reconciliation' AND uad_uid = '1300.0012'
        LIMIT 1`,
      [workfileId],
    );
    const effectiveDate = isoDate(effectiveDateResult.rows[0]?.effective_date);
    if (effectiveDate && executionDate < effectiveDate) throw new Error("uad_signature_before_effective_date");

    let signatureAssetId = input.signature_asset_id || null;
    if (signatureAssetId) {
      const assetResult = await client.query(
        `SELECT id FROM appraisal.uad_assets
          WHERE id = $1 AND workfile_id = $2
            AND asset_kind = 'signature' AND status = 'verified'`,
        [signatureAssetId, workfileId],
      );
      if (!assetResult.rows.length) throw new Error("uad_signature_asset_not_verified");
      signatureAssetId = assetResult.rows[0].id;
    }

    const editor = await getUadEditor(client, workfileId);
    const assets = await listUadAssets(client, workfileId);
    const sketches = await listUadSketches(client, workfileId);
    const inputDigest = buildUadValidationInputDigest(editor, assets, sketches);
    const validationResult = await client.query(
      `SELECT status, revision_number, metadata
         FROM appraisal.uad_validation_runs
        WHERE workfile_id = $1 AND validator_type = 'local_compliance'
        ORDER BY started_at DESC, id DESC LIMIT 1`,
      [workfileId],
    );
    const validation = validationResult.rows[0];
    if (
      validation?.status !== "passed"
      || Number(validation.revision_number) !== Number(workfile.current_revision)
      || validation.metadata?.input_digest_sha256 !== inputDigest
    ) throw new Error("uad_signature_local_validation_stale");

    const artifactReadiness = await loadSignatureArtifactReadiness(
      client,
      workfileId,
      workfile.current_revision,
      inputDigest,
    );
    if (!artifactReadiness.pdf_ready) throw new Error("uad_signature_pdf_required");

    const credential = buildUadCredentialSnapshot(signerRow);
    const attestation = verifyUadSignatureAcknowledgmentToken(
      input.acknowledgment_token,
      {
        workfileId,
        revisionNumber: Number(workfile.current_revision),
        inputDigest,
        signerUserId: actorUserId,
        signerRole,
        authentication,
      },
      signingSecretValue,
      { now },
    );
    const currentSignatures = await client.query(
      `SELECT id, workfile_id, revision_number, signer_user_id, signer_role,
              signature_asset_id, authentication_method, signed_at, execution_date,
              workfile_input_digest_sha256, credential_snapshot_sha256
         FROM appraisal.uad_signatures
        WHERE workfile_id = $1 AND revision_number = $2
        ORDER BY signed_at, id`,
      [workfileId, Number(workfile.current_revision)],
    );
    let signature = currentSignatures.rows.find((row) => (
      row.signer_user_id === actorUserId && row.signer_role === signerRole
    ));
    const replay = Boolean(signature);
    if (signature && (
      signature.workfile_input_digest_sha256 !== inputDigest
      || signature.authentication_method !== authenticationMethod
      || isoDate(signature.execution_date) !== executionDate
    )) throw new Error("uad_signature_existing_snapshot_mismatch");

    let signatureId = signature?.id || null;
    if (!signature) {
      signatureId = randomUUID();
      const inserted = await client.query(
        `INSERT INTO appraisal.uad_signatures (
           id, workfile_id, revision_number, signer_user_id, signer_role,
           signature_asset_id, credential_snapshot, authentication_method,
           signed_at, execution_date, workfile_input_digest_sha256,
           credential_snapshot_sha256, attestation
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7::jsonb, $8,
           now(), $9, $10, $11, $12::jsonb
         )
         RETURNING id, workfile_id, revision_number, signer_user_id, signer_role,
                   signature_asset_id, authentication_method, signed_at, execution_date,
                   workfile_input_digest_sha256, credential_snapshot_sha256`,
        [
          signatureId,
          workfileId,
          Number(workfile.current_revision),
          actorUserId,
          signerRole,
          signatureAssetId,
          JSON.stringify(credential.snapshot),
          authenticationMethod,
          executionDate,
          inputDigest,
          credential.credential_snapshot_sha256,
          JSON.stringify(attestation),
        ],
      );
      signature = inserted.rows[0];
    }

    const signatureRows = await client.query(
      `SELECT revision_number, signer_user_id, signer_role, workfile_input_digest_sha256
         FROM appraisal.uad_signatures
        WHERE workfile_id = $1 AND revision_number = $2`,
      [workfileId, Number(workfile.current_revision)],
    );
    const quorum = evaluateUadSignatureQuorum(workfile, signatureRows.rows, {
      revisionNumber: Number(workfile.current_revision),
      inputDigest,
    });
    const complete = quorum.complete;
    if (complete) {
      await client.query(
        `UPDATE appraisal.uad_workfiles SET status = 'signed', signed_at = now(), updated_at = now()
          WHERE id = $1`,
        [workfileId],
      );
    }
    if (!replay) {
      await client.query(
        `INSERT INTO appraisal.uad_audit_events (
           workfile_id, actor_user_id, event_type, entity_type, entity_id, after_data, metadata
         ) VALUES ($1, $2, 'uad_signature.created', 'uad_signature', $3, $4::jsonb, $5::jsonb)`,
        [
          workfileId,
          actorUserId,
          signatureId,
          JSON.stringify({ signer_role: signerRole, execution_date: executionDate, complete }),
          JSON.stringify({
            revision_number: Number(workfile.current_revision),
            workfile_input_digest_sha256: inputDigest,
            credential_snapshot_sha256: credential.credential_snapshot_sha256,
            quorum,
          }),
        ],
      );
    }
    await client.query("COMMIT");
    return {
      signature,
      workfile_status: complete ? "signed" : "ready",
      idempotent: replay,
      quorum,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
