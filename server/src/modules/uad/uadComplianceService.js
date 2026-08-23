import { createHash, randomUUID } from "node:crypto";

import { validateAppendixH1FindingRuleIds } from "./appendixH.js";
import { parseUadComplianceResponse } from "./uadComplianceClient.js";
import { normalizeUadWorkfileId } from "./workfiles.js";

const PROVIDER_VALIDATOR = Object.freeze({ fannie: "fannie_api", freddie: "freddie_api" });
const AUTHORIZED_ROLES = Object.freeze(["organization_admin", "homenode_admin"]);

function normalizedErrorCode(error) {
  const code = String(error?.message || "uad_compliance_request_failed").split(":", 1)[0]
    .toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 120);
  return code || "uad_compliance_request_failed";
}

function validationResponse(run, exchange, findings = []) {
  if (!run) return null;
  return {
    id: run.id,
    workfile_id: run.workfile_id,
    revision_number: Number(run.revision_number),
    specification_release_key: run.specification_release_key,
    provider: exchange?.provider || (run.validator_type === "fannie_api" ? "fannie" : "freddie"),
    environment: exchange?.environment || null,
    status: run.status,
    fatal_count: Number(run.fatal_count),
    warning_count: Number(run.warning_count),
    started_at: run.started_at,
    completed_at: run.completed_at,
    request_correlation_id: exchange?.request_correlation_id || null,
    provider_correlation_id: exchange?.provider_correlation_id || null,
    response_http_status: exchange?.response_http_status == null ? null : Number(exchange.response_http_status),
    response_content_type: exchange?.response_content_type || null,
    response_checksum_sha256: exchange?.response_checksum_sha256 || null,
    request_xml_checksum_sha256: exchange?.request_checksum_sha256 || null,
    error_code: exchange?.error_code || null,
    metadata: run.metadata || {},
    findings: findings.map((finding) => ({
      id: finding.id,
      rule_id: finding.rule_id || null,
      severity: finding.severity,
      uad_uid: finding.uad_uid || null,
      report_field_id: finding.report_field_id || null,
      message: finding.message,
      status: finding.status,
      metadata: finding.metadata || {},
      created_at: finding.created_at,
    })),
  };
}

async function authorizeComplianceActor(queryable, workfileId, actorUserId) {
  if (!actorUserId) throw new Error("uad_compliance_authentication_required");
  const result = await queryable.query(
    `SELECT workfile.*,
            EXISTS (
              SELECT 1
                FROM app_auth.organization_memberships AS membership
                JOIN app_auth.membership_roles AS role
                  ON role.organization_id = membership.organization_id
                 AND role.user_id = membership.user_id
               WHERE membership.organization_id = workfile.organization_id
                 AND membership.user_id = $2
                 AND membership.status = 'active'
                 AND role.role_code = ANY($3::text[])
            ) AS administrative_access
       FROM appraisal.uad_workfiles AS workfile
      WHERE workfile.id = $1`,
    [workfileId, actorUserId, AUTHORIZED_ROLES],
  );
  if (!result.rows.length) throw new Error("uad_workfile_not_found");
  const workfile = result.rows[0];
  const assigned = actorUserId === workfile.assigned_appraiser_user_id
    || actorUserId === workfile.supervisory_appraiser_user_id;
  if (!assigned && !workfile.administrative_access) throw new Error("uad_compliance_access_denied");
  return workfile;
}

async function loadLatestProviderResult(queryable, workfileId, provider) {
  const validatorType = PROVIDER_VALIDATOR[provider];
  const runResult = await queryable.query(
    `SELECT run.*, exchange.provider, exchange.environment,
            exchange.request_correlation_id, exchange.provider_correlation_id,
            exchange.response_http_status, exchange.response_content_type,
            exchange.response_checksum_sha256, exchange.request_checksum_sha256,
            exchange.error_code
       FROM appraisal.uad_validation_runs AS run
       LEFT JOIN appraisal.uad_compliance_exchanges AS exchange
         ON exchange.validation_run_id = run.id
      WHERE run.workfile_id = $1 AND run.validator_type = $2
      ORDER BY run.started_at DESC, run.id DESC LIMIT 1`,
    [workfileId, validatorType],
  );
  if (!runResult.rows.length) return null;
  const run = runResult.rows[0];
  const findings = await queryable.query(
    `SELECT * FROM appraisal.uad_validation_findings
      WHERE validation_run_id = $1 ORDER BY created_at, id`,
    [run.id],
  );
  return validationResponse(run, run, findings.rows);
}

export async function getUadComplianceStatus(pool, registry, workfileIdValue, actorUserId) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const workfile = await authorizeComplianceActor(pool, workfileId, actorUserId);
  const [fannie, freddie] = await Promise.all([
    loadLatestProviderResult(pool, workfileId, "fannie"),
    loadLatestProviderResult(pool, workfileId, "freddie"),
  ]);
  return {
    enabled: registry.enabled,
    providers: registry.providers,
    workfile: {
      id: workfile.id,
      current_revision: Number(workfile.current_revision),
      status: workfile.status,
    },
    results: { fannie, freddie },
  };
}

async function failComplianceRun(pool, { runId, exchangeId, error }) {
  const errorCode = normalizedErrorCode(error);
  await pool.query(
    `WITH failed_run AS (
       UPDATE appraisal.uad_validation_runs
          SET status = 'error', completed_at = now(),
              metadata = metadata || $3::jsonb
        WHERE id = $1
     )
     UPDATE appraisal.uad_compliance_exchanges
        SET exchange_status = 'error', completed_at = now(), error_code = $4
      WHERE id = $2`,
    [runId, exchangeId, JSON.stringify({ error_code: errorCode }), errorCode],
  );
}

export async function runUadCompliance(
  pool,
  storage,
  registry,
  workfileIdValue,
  providerValue,
  actorUserId,
) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const provider = String(providerValue || "").trim().toLowerCase();
  const validatorType = PROVIDER_VALIDATOR[provider];
  if (!validatorType) throw new Error("invalid_uad_compliance_provider");
  const providerClient = registry.getClient(provider);
  if (!storage?.configured) throw new Error("uad_object_storage_not_configured");
  const requestCorrelationId = randomUUID();
  const runId = randomUUID();
  const exchangeId = randomUUID();
  const client = await pool.connect();
  let workfile;
  let xmlArtifact;
  try {
    await client.query("BEGIN");
    workfile = await authorizeComplianceActor(client, workfileId, actorUserId);
    const locked = await client.query(
      `SELECT * FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE`,
      [workfileId],
    );
    workfile = locked.rows[0];
    if (!workfile || !["signed", "exported"].includes(workfile.status)) {
      throw new Error("uad_compliance_signed_revision_required");
    }
    const artifactResult = await client.query(
      `SELECT * FROM appraisal.uad_generated_artifacts
        WHERE workfile_id = $1 AND revision_number = $2 AND artifact_type = 'xml'
          AND generation_status = 'ready'
        LIMIT 1`,
      [workfileId, Number(workfile.current_revision)],
    );
    xmlArtifact = artifactResult.rows[0];
    if (!xmlArtifact || xmlArtifact.metadata?.schema_valid !== true) {
      throw new Error("uad_compliance_schema_valid_xml_required");
    }
    const environment = registry.providers[provider].environment;
    await client.query(
      `INSERT INTO appraisal.uad_validation_runs (
         id, workfile_id, revision_number, specification_release_key,
         validator_type, status, requested_by_user_id, metadata
       ) VALUES ($1, $2, $3, $4, $5, 'running', $6, $7::jsonb)`,
      [
        runId, workfileId, Number(workfile.current_revision), workfile.specification_release_key,
        validatorType, actorUserId,
        JSON.stringify({
          provider,
          environment,
          request_correlation_id: requestCorrelationId,
          request_xml_artifact_id: xmlArtifact.id,
          request_xml_checksum_sha256: xmlArtifact.checksum_sha256,
        }),
      ],
    );
    await client.query(
      `INSERT INTO appraisal.uad_compliance_exchanges (
         id, validation_run_id, workfile_id, revision_number, provider,
         environment, request_correlation_id, request_artifact_id,
         request_checksum_sha256
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        exchangeId, runId, workfileId, Number(workfile.current_revision), provider,
        environment, requestCorrelationId, xmlArtifact.id, xmlArtifact.checksum_sha256,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  try {
    const downloaded = await storage.getObject({ objectKey: xmlArtifact.object_key });
    const requestChecksum = createHash("sha256").update(downloaded.body).digest("hex");
    if (Number(xmlArtifact.byte_size) !== downloaded.body.length) throw new Error("uad_compliance_xml_size_mismatch");
    if (xmlArtifact.checksum_sha256 !== requestChecksum) throw new Error("uad_compliance_xml_checksum_mismatch");
    const response = await providerClient.submitXml(downloaded.body, { correlationId: requestCorrelationId });
    const findings = parseUadComplianceResponse(response);
    const catalogDrift = validateAppendixH1FindingRuleIds(findings);
    if (!catalogDrift.current) throw new Error("uad_compliance_rule_catalog_drift");
    const fatalCount = findings.filter((finding) => finding.severity === "fatal").length;
    const warningCount = findings.length - fatalCount;
    const status = response.ok ? (fatalCount ? "failed" : "passed") : "error";
    const errorCode = response.ok ? null : `uad_compliance_http_${response.http_status}`;
    const persist = await pool.connect();
    try {
      await persist.query("BEGIN");
      const unchanged = await persist.query(
        `SELECT current_revision, status FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE`,
        [workfileId],
      );
      if (!unchanged.rows.length || Number(unchanged.rows[0].current_revision) !== Number(workfile.current_revision)) {
        throw new Error("uad_compliance_workfile_changed");
      }
      await persist.query(
        `UPDATE appraisal.uad_validation_findings AS finding
            SET status = 'superseded'
           FROM appraisal.uad_validation_runs AS run
          WHERE finding.validation_run_id = run.id
            AND run.workfile_id = $1 AND run.validator_type = $2
            AND run.id <> $3 AND finding.status = 'open'`,
        [workfileId, validatorType, runId],
      );
      for (const finding of findings) {
        await persist.query(
          `INSERT INTO appraisal.uad_validation_findings (
             id, validation_run_id, rule_id, severity, uad_uid,
             report_field_id, message, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [
            randomUUID(), runId, finding.rule_id, finding.severity, finding.uad_uid,
            finding.report_field_id, finding.message,
            JSON.stringify({ provider, environment: registry.providers[provider].environment }),
          ],
        );
      }
      const runResult = await persist.query(
        `UPDATE appraisal.uad_validation_runs
            SET status = $2, fatal_count = $3, warning_count = $4,
                completed_at = now(), metadata = metadata || $5::jsonb
          WHERE id = $1 RETURNING *`,
        [
          runId, status, fatalCount, warningCount,
          JSON.stringify({
            response_http_status: response.http_status,
            response_checksum_sha256: response.response_checksum_sha256,
            provider_correlation_id: response.provider_correlation_id,
          }),
        ],
      );
      const exchangeResult = await persist.query(
        `UPDATE appraisal.uad_compliance_exchanges
            SET response_http_status = $2, response_content_type = $3,
                response_checksum_sha256 = $4, response_payload = $5,
                provider_correlation_id = $6, exchange_status = $7,
                error_code = $8, completed_at = now()
          WHERE id = $1 RETURNING *`,
        [
          exchangeId, response.http_status, response.content_type,
          response.response_checksum_sha256, response.body,
          response.provider_correlation_id, status, errorCode,
        ],
      );
      await persist.query(
        `INSERT INTO appraisal.uad_audit_events (
           workfile_id, actor_user_id, event_type, entity_type, entity_id,
           after_data, metadata
         ) VALUES ($1, $2, 'uad_compliance.completed', 'uad_validation_run', $3, $4::jsonb, $5::jsonb)`,
        [
          workfileId, actorUserId, runId,
          JSON.stringify({ provider, status, fatal_count: fatalCount, warning_count: warningCount }),
          JSON.stringify({
            revision_number: Number(workfile.current_revision),
            request_correlation_id: requestCorrelationId,
            provider_correlation_id: response.provider_correlation_id,
          }),
        ],
      );
      const findingsResult = await persist.query(
        `SELECT * FROM appraisal.uad_validation_findings
          WHERE validation_run_id = $1 ORDER BY created_at, id`,
        [runId],
      );
      await persist.query("COMMIT");
      return validationResponse(runResult.rows[0], exchangeResult.rows[0], findingsResult.rows);
    } catch (error) {
      await persist.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      persist.release();
    }
  } catch (error) {
    await failComplianceRun(pool, { runId, exchangeId, error }).catch(() => {});
    throw error;
  }
}
