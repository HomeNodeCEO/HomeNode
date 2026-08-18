import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createOidcAccessTokenVerifier,
  normalizeOidcIssuer,
  parseBearerToken,
} from "../src/modules/mobile/auth.js";
import {
  formatReportFileNumber,
  normalizeWorkflowType,
} from "../src/modules/mobile/fileNumbers.js";
import { calculateManualSketch } from "../src/modules/mobile/manualSketch.js";
import { normalizePropertySearch } from "../src/modules/mobile/properties.js";
import {
  canonicalJson,
  normalizeSyncBatch,
  syncPayloadSha256,
} from "../src/modules/mobile/sync.js";

const ISSUER = "https://identity.example.test";
const AUDIENCE = "https://api.homenode.test/mobile";
const NOW = Date.parse("2026-08-21T12:00:00.000Z");
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: "mobile-test-key", alg: "RS256", use: "sig" };

function encoded(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function token(overrides = {}) {
  const header = encoded({ alg: "RS256", typ: "JWT", kid: publicJwk.kid });
  const payload = encoded({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "user_123",
    iat: Math.floor(NOW / 1000) - 30,
    exp: Math.floor(NOW / 1000) + 300,
    ...overrides,
  });
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`, "ascii"), privateKey)
    .toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function verifier() {
  return createOidcAccessTokenVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUri: `${ISSUER}/.well-known/jwks.json`,
    now: () => NOW,
    fetchImpl: async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
}

test("formats independent, recognizable report-file sequences", () => {
  assert.equal(formatReportFileNumber({
    workflowType: "custom_appraisal",
    calendarYear: 2026,
    sequenceNumber: 1,
  }), "HN-CA-2026-000001");
  assert.equal(formatReportFileNumber({
    workflowType: "uad_3_6",
    calendarYear: 2026,
    sequenceNumber: 1,
  }), "HN-UAD-2026-000001");
  assert.equal(formatReportFileNumber({
    workflowType: "property_tax_protest",
    calendarYear: 2026,
    sequenceNumber: 1,
  }), "HN-PTP-2026-000001");
  assert.throws(() => normalizeWorkflowType("uploaded_jpeg"), /invalid_workflow_type/);
});

test("normalizes bounded mobile property searches", () => {
  assert.equal(normalizePropertySearch("  100   Test Street "), "100 Test Street");
  assert.throws(() => normalizePropertySearch("x"), /invalid_property_search_query/);
  assert.throws(() => normalizePropertySearch("x".repeat(121)), /invalid_property_search_query/);
});

test("canonicalizes and validates offline sync operations", () => {
  const payload = {
    value: "Observed condition",
    field_path: "inspection.general.appraiser_comments",
    base: { exists: false },
    source_type: "appraiser",
    appraiser_confirmed: true,
  };
  assert.equal(canonicalJson({ z: 1, a: [true, null] }), '{"a":[true,null],"z":1}');
  const operations = normalizeSyncBatch({
    operations: [{
      client_operation_id: "10000000-0000-4000-8000-000000000001",
      operation_kind: "field.upsert",
      base_session_revision: 1,
      payload_sha256: syncPayloadSha256(payload),
      payload,
    }],
  });
  assert.equal(operations[0].payload.field_path, "inspection.general.appraiser_comments");
  assert.throws(() => normalizeSyncBatch({
    operations: [{
      client_operation_id: "10000000-0000-4000-8000-000000000001",
      operation_kind: "field.upsert",
      base_session_revision: 1,
      payload_sha256: "0".repeat(64),
      payload,
    }],
  }), /invalid_payload_sha256/);
});

test("manual sketch calculator requires closure before calculating square footage", () => {
  const rectangle = calculateManualSketch({
    vertices: [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 30 },
      { x: 0, y: 30 },
      { x: 0, y: 0 },
    ],
  });
  assert.equal(rectangle.closed, true);
  assert.equal(rectangle.self_intersecting, false);
  assert.equal(rectangle.calculated_area_sqft, 1200);
  assert.equal(rectangle.perimeter_feet, 140);
  assert.equal(rectangle.ansi_review_required, true);

  const open = calculateManualSketch({
    vertices: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }],
  });
  assert.equal(open.closed, false);
  assert.equal(open.calculated_area_sqft, null);
});

test("manual sketch calculator rejects self-intersecting outlines", () => {
  const result = calculateManualSketch({
    vertices: [
      { x: 0, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
      { x: 20, y: 0 },
      { x: 0, y: 0 },
    ],
  });
  assert.equal(result.closed, true);
  assert.equal(result.self_intersecting, true);
  assert.equal(result.calculated_area_sqft, null);
});

test("accepts only a bounded bearer token and HTTPS OIDC issuer", () => {
  assert.equal(parseBearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.throws(() => parseBearerToken("Basic abc"), /invalid_access_token/);
  assert.equal(normalizeOidcIssuer(`${ISSUER}/`), `${ISSUER}/`);
  assert.throws(() => normalizeOidcIssuer("http://identity.example.test"), /invalid_oidc_issuer/);
});

test("verifies an RS256 OIDC access token with JWKS", async () => {
  const claims = await verifier().verify(token());
  assert.equal(claims.sub, "user_123");
  assert.equal(claims.iss, ISSUER);
});

test("rejects expired, wrong-audience, and tampered OIDC tokens", async () => {
  const oidc = verifier();
  await assert.rejects(() => oidc.verify(token({ exp: Math.floor(NOW / 1000) - 120 })), /invalid_access_token/);
  await assert.rejects(() => oidc.verify(token({ aud: "wrong-audience" })), /invalid_access_token/);
  const valid = token();
  const parts = valid.split(".");
  parts[1] = encoded({ ...JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")), sub: "attacker" });
  await assert.rejects(() => oidc.verify(parts.join(".")), /invalid_access_token/);
});

test("mobile migration is additive and encodes retention, lineage, and sparse edits", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(
    path.resolve(directory, "../migrations/20260821_mobile_foundation.sql"),
    "utf8",
  );
  assert.match(source, /CREATE TABLE IF NOT EXISTS app\.report_files/);
  assert.match(source, /previous_report_file_id uuid REFERENCES app\.report_files/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS app\.inspection_field_edits/);
  assert.match(source, /required_retention_years integer NOT NULL DEFAULT 5/);
  assert.match(source, /CHECK \(required_retention_years = 5\)/);
  assert.match(source, /UNIQUE \(inspection_session_id, client_operation_id\)/);
  assert.doesNotMatch(source, /DROP\s+(?:DATABASE|SCHEMA|TABLE|COLUMN)/i);

  const offlineSource = fs.readFileSync(
    path.resolve(directory, "../migrations/20260822_mobile_offline_sync.sql"),
    "utf8",
  );
  assert.match(offlineSource, /ADD COLUMN IF NOT EXISTS client_operation_id uuid/);
  assert.match(offlineSource, /ADD COLUMN IF NOT EXISTS is_tombstone boolean/);
  assert.match(offlineSource, /mobile_sync_operations_unresolved_conflict_idx/);
  assert.doesNotMatch(offlineSource, /DROP\s+(?:DATABASE|SCHEMA|TABLE|COLUMN)/i);
});
