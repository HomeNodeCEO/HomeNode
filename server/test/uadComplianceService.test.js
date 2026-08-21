import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runUadCompliance } from "../src/modules/uad/uadComplianceService.js";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

test("adds credential-free durable compliance exchange history", () => {
  const migration = fs.readFileSync(
    path.join(TEST_DIRECTORY, "../migrations/20260924_uad_compliance_api.sql"),
    "utf8",
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS appraisal\.uad_compliance_exchanges/);
  assert.match(migration, /provider IN \('fannie', 'freddie'\)/);
  assert.match(migration, /response_payload text/);
  assert.match(migration, /octet_length\(response_payload\) <= 2097152/);
  assert.match(migration, /request_checksum_sha256/);
  assert.match(migration, /response_checksum_sha256/);
  assert.doesNotMatch(migration, /client_secret|access_token|token_url/i);
});

test("keeps provider calls behind OIDC, assignment authorization, and feature flags", () => {
  const router = fs.readFileSync(path.join(TEST_DIRECTORY, "../src/modules/uad/router.js"), "utf8");
  const service = fs.readFileSync(path.join(TEST_DIRECTORY, "../src/modules/uad/uadComplianceService.js"), "utf8");
  const server = fs.readFileSync(path.join(TEST_DIRECTORY, "../src/oldServer.js"), "utf8");
  assert.match(router, /compliance", authenticateSigner/);
  assert.match(router, /compliance\/:provider", authenticateSigner/);
  assert.match(service, /assigned_appraiser_user_id/);
  assert.match(service, /supervisory_appraiser_user_id/);
  assert.match(service, /organization_admin/);
  assert.match(service, /schema_valid/);
  assert.match(service, /uad_compliance_exchanges/);
  assert.doesNotMatch(service, /clientSecret|access_token/);
  assert.match(server, /createUadComplianceRegistry/);
  assert.match(server, /compliance: uadComplianceRegistry/);
});

test("persists a normalized provider run without retaining OAuth credentials", async () => {
  const workfileId = "00000000-0000-4000-8000-000000000001";
  const actorUserId = "00000000-0000-4000-8000-000000000002";
  const xml = Buffer.from("<MESSAGE/>", "utf8");
  const xmlChecksum = createHash("sha256").update(xml).digest("hex");
  const calls = [];
  const workfile = {
    id: workfileId,
    organization_id: "00000000-0000-4000-8000-000000000003",
    assigned_appraiser_user_id: actorUserId,
    supervisory_appraiser_user_id: null,
    administrative_access: false,
    current_revision: 3,
    specification_release_key: "uad-3.6-2026-08-13-h1.5",
    status: "signed",
  };
  const xmlArtifact = {
    id: "00000000-0000-4000-8000-000000000004",
    object_key: "private/report.xml",
    byte_size: xml.length,
    checksum_sha256: xmlChecksum,
    metadata: { schema_valid: true },
  };
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes("SELECT workfile.*")) return { rows: [workfile] };
    if (sql.includes("SELECT * FROM appraisal.uad_workfiles")) return { rows: [workfile] };
    if (sql.includes("SELECT * FROM appraisal.uad_generated_artifacts")) return { rows: [xmlArtifact] };
    if (sql.includes("SELECT current_revision, status")) return { rows: [workfile] };
    if (sql.includes("UPDATE appraisal.uad_validation_runs") && sql.includes("RETURNING")) {
      return { rows: [{
        id: params[0],
        workfile_id: workfileId,
        revision_number: 3,
        specification_release_key: workfile.specification_release_key,
        validator_type: "fannie_api",
        status: params[1],
        fatal_count: params[2],
        warning_count: params[3],
        started_at: "2026-08-21T00:00:00.000Z",
        completed_at: "2026-08-21T00:00:01.000Z",
        metadata: JSON.parse(params[4]),
      }] };
    }
    if (sql.includes("UPDATE appraisal.uad_compliance_exchanges") && sql.includes("RETURNING")) {
      return { rows: [{
        provider: "fannie",
        environment: "acpt",
        request_correlation_id: "local-correlation",
        provider_correlation_id: params[5],
        response_http_status: params[1],
        response_content_type: params[2],
        response_checksum_sha256: params[3],
        request_checksum_sha256: xmlChecksum,
        error_code: params[7],
      }] };
    }
    if (sql.includes("SELECT * FROM appraisal.uad_validation_findings")) {
      return { rows: [{
        id: "finding-1",
        rule_id: "UAD0002",
        severity: "warning",
        uad_uid: null,
        report_field_id: "3.001",
        message: "Review value",
        status: "open",
        metadata: { provider: "fannie" },
        created_at: "2026-08-21T00:00:01.000Z",
      }] };
    }
    return { rows: [] };
  };
  const pool = {
    connect: async () => ({ query, release() {} }),
    query,
  };
  const registry = {
    enabled: true,
    providers: { fannie: { configured: true, environment: "acpt" } },
    getClient: () => ({
      submitXml: async (body) => {
        assert.deepEqual(body, xml);
        return {
          ok: true,
          http_status: 200,
          content_type: "application/json",
          body: JSON.stringify({ findings: [{ ruleId: "UAD0002", severity: "Warning", message: "Review value", reportFieldId: "3.001" }] }),
          response_checksum_sha256: "a".repeat(64),
          provider_correlation_id: "provider-correlation",
        };
      },
    }),
  };
  const result = await runUadCompliance(
    pool,
    { configured: true, getObject: async () => ({ body: xml }) },
    registry,
    workfileId,
    "fannie",
    actorUserId,
  );

  assert.equal(result.status, "passed");
  assert.equal(result.fatal_count, 0);
  assert.equal(result.warning_count, 1);
  assert.equal(result.findings[0].rule_id, "UAD0002");
  const exchangeUpdate = calls.find((call) => (
    call.sql.includes("UPDATE appraisal.uad_compliance_exchanges") && call.sql.includes("RETURNING")
  ));
  assert.match(exchangeUpdate.params[4], /Review value/);
  assert.doesNotMatch(JSON.stringify(calls), /client-secret|access-token/);
});
