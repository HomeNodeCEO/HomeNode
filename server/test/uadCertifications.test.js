import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildUadCredentialSnapshot,
  createUadSignatureAcknowledgmentToken,
  normalizeUadAppraiserLicenseType,
  verifyUadSignatureAcknowledgmentToken,
} from "../src/modules/uad/certifications.js";
import {
  buildUadCertificationWarnings,
  UAD_CERTIFICATION_INSPECTION_TYPES,
} from "../src/modules/uad/certificationsCatalog.js";
import {
  calculateCertificationSystemValues,
  validateCompleteSection,
} from "../src/modules/uad/editor.js";
import { getUadEditorSections, getUadField } from "../src/modules/uad/fieldCatalog.js";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

function row(context, uid, value) {
  return { entity_id: null, field_context: context, uad_uid: uid, value };
}

function validRows() {
  return [
    row("assignment", "1000.0158", "TraditionalAppraisal"),
    row("appraiser_inspection", "2400.0081", "Physical"),
    row("appraiser_inspection", "2400.0082", "Physical"),
    row("certification_scope", "2200.0062", false),
    row("certification_intended_user", "2200.0037", false),
    row("certification_report", "2200.0038", "InteriorAndExterior"),
    row("certification_report", "2200.0017", false),
    row("certification_report", "2200.0034", false),
  ];
}

test("registers official Section 29 certification controls and enumerations", () => {
  const section = getUadEditorSections().find((item) => item.key === "certifications");
  assert.equal(section.officialSectionNumber, 29);
  assert.equal(section.title, "Certifications and Scope of Work");
  assert.deepEqual(
    getUadField("certification_report", "2200.0038").options,
    UAD_CERTIFICATION_INSPECTION_TYPES,
  );
  assert.equal(getUadField("certification_scope", "1000.0028").calculated, true);
  assert.equal(getUadField("certification_scope", "2200.0003").maxLength, 2500);
  assert.equal(getUadField("certification_report", "2200.0016").maxLength, 1250);
  assert.equal(getUadField("certification_appraiser", "2200.0087").maxLength, 360);
});

test("derives the federal-agency indicator from Assignment Information", () => {
  assert.equal(calculateCertificationSystemValues(validRows())[0].value, false);
  assert.equal(calculateCertificationSystemValues([
    ...validRows(),
    row("assignment", "1000.0029", "VA"),
  ])[0].value, true);
});

test("accepts a complete standard SFR certification section", () => {
  assert.deepEqual(validateCompleteSection("certifications", validRows(), [], []), []);
});

test("requires assignment-specific text when a Section 29 indicator is Yes", () => {
  const cases = [
    ["certification_scope", "2200.0062", "2200.0003"],
    ["certification_intended_user", "2200.0037", "2200.0004"],
    ["certification_report", "2200.0017", "2200.0016"],
    ["certification_report", "2200.0034", "2200.0087"],
  ];
  for (const [context, indicatorUid, requiredUid] of cases) {
    const rows = validRows().map((item) => (
      item.field_context === context && item.uad_uid === indicatorUid ? { ...item, value: true } : item
    ));
    const errors = validateCompleteSection("certifications", rows, [], []);
    assert.equal(errors.some((error) => error.uid === requiredUid && error.code === "required"), true);
  }
});

test("emits Appendix H inspection consistency warnings without making them fatal", () => {
  const editor = {
    values: validRows().map((value) => ({
      entity_id: value.entity_id,
      context_key: value.field_context,
      uid: value.uad_uid,
      value: value.uad_uid === "2200.0038" ? "Exterior" : value.value,
    })),
  };
  const warnings = buildUadCertificationWarnings(editor);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].severity, "warning");
  assert.equal(warnings[0].rule_id, "UAD1512");
});

test("builds deterministic immutable credential snapshots with official license types", () => {
  const signer = {
    user_id: "00000000-0000-4000-8000-000000000001",
    signer_role: "appraiser",
    display_name: "Taylor Q Appraiser",
    user_metadata: {},
    organization_id: "00000000-0000-4000-8000-000000000002",
    organization_legal_name: "HomeNode Real Estate LLC",
    organization_display_name: "HomeNode Real Estate",
    organization_dba_name: null,
    address_line_1: "100 Test Office Dr",
    address_line_2: null,
    city: "Garland",
    state_code: "TX",
    postal_code: "75044",
    country_code: "US",
    license_id: "00000000-0000-4000-8000-000000000003",
    jurisdiction: "TX",
    license_number: "STAGING-CR-0001",
    license_type: "Certified Residential",
    issued_on: "2025-01-01",
    expires_on: "2028-12-31",
    license_status: "active",
    license_metadata: {},
    signature_policy: "session",
  };
  const first = buildUadCredentialSnapshot(signer, { capturedAt: "2026-08-20T12:00:00.000Z" });
  const second = buildUadCredentialSnapshot({ ...signer }, { capturedAt: "2026-08-20T12:00:00.000Z" });
  assert.deepEqual(first, second);
  assert.match(first.credential_snapshot_sha256, /^[0-9a-f]{64}$/);
  assert.equal(first.snapshot.signer.first_name, "Taylor");
  assert.equal(first.snapshot.signer.middle_name, "Q");
  assert.equal(first.snapshot.signer.last_name, "Appraiser");
  assert.equal(first.snapshot.license.license_type, "CertifiedResidential");
  assert.equal(normalizeUadAppraiserLicenseType("trainee appraiser"), "TraineeAppraiser");
});

test("binds signature acknowledgment tokens to the exact signer and workfile revision", () => {
  const secret = "test-signing-secret-that-is-at-least-32-characters";
  const now = new Date("2026-09-04T12:00:00.000Z");
  const authentication = {
    issuer: "https://identity.example",
    subject: "workos-user-1",
  };
  const expected = {
    workfileId: "00000000-0000-4000-8000-000000000010",
    revisionNumber: 12,
    inputDigest: "a".repeat(64),
    signerUserId: "00000000-0000-4000-8000-000000000011",
    signerRole: "appraiser",
    authentication,
  };
  const acknowledgment = createUadSignatureAcknowledgmentToken(
    expected,
    secret,
    {
      now,
      acknowledgmentId: "00000000-0000-4000-8000-000000000012",
    },
  );
  const verified = verifyUadSignatureAcknowledgmentToken(
    acknowledgment.token,
    expected,
    secret,
    { now: new Date("2026-09-04T12:05:00.000Z") },
  );
  assert.deepEqual(verified, {
    acknowledgment_id: "00000000-0000-4000-8000-000000000012",
    acknowledged_at: "2026-09-04T12:00:00.000Z",
    standard_certifications_acknowledged: true,
    scope_of_work_acknowledged: true,
    authentication_issuer: "https://identity.example",
    authentication_subject: "workos-user-1",
  });
  assert.throws(
    () => verifyUadSignatureAcknowledgmentToken(
      acknowledgment.token,
      { ...expected, revisionNumber: 13 },
      secret,
      { now },
    ),
    /uad_signature_acknowledgment_mismatch/,
  );
  assert.throws(
    () => verifyUadSignatureAcknowledgmentToken(
      acknowledgment.token,
      { ...expected, signerUserId: "00000000-0000-4000-8000-000000000099" },
      secret,
      { now },
    ),
    /uad_signature_acknowledgment_mismatch/,
  );
});

test("rejects missing, tampered, expired, or weakly signed acknowledgment tokens", () => {
  const secret = "test-signing-secret-that-is-at-least-32-characters";
  const now = new Date("2026-09-04T12:00:00.000Z");
  const expected = {
    workfileId: "00000000-0000-4000-8000-000000000020",
    revisionNumber: 4,
    inputDigest: "b".repeat(64),
    signerUserId: "00000000-0000-4000-8000-000000000021",
    signerRole: "supervisory_appraiser",
    authentication: { issuer: "https://identity.example", subject: "workos-user-2" },
  };
  const { token } = createUadSignatureAcknowledgmentToken(expected, secret, { now });
  assert.throws(
    () => verifyUadSignatureAcknowledgmentToken("", expected, secret, { now }),
    /uad_signature_acknowledgment_required/,
  );
  assert.throws(
    () => verifyUadSignatureAcknowledgmentToken(
      `${token.slice(0, -1)}${token.endsWith("x") ? "y" : "x"}`,
      expected,
      secret,
      { now },
    ),
    /uad_signature_acknowledgment_invalid/,
  );
  const [body, signature] = token.split(".");
  const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const signatureLastIndex = base64UrlAlphabet.indexOf(signature.at(-1));
  assert.ok(signatureLastIndex >= 0);
  assert.equal(signatureLastIndex % 4, 0);
  const equivalentNonCanonicalSignature = `${signature.slice(0, -1)}${base64UrlAlphabet[signatureLastIndex + 1]}`;
  assert.deepEqual(
    Buffer.from(equivalentNonCanonicalSignature, "base64url"),
    Buffer.from(signature, "base64url"),
  );
  assert.throws(
    () => verifyUadSignatureAcknowledgmentToken(
      `${body}.${equivalentNonCanonicalSignature}`,
      expected,
      secret,
      { now },
    ),
    /uad_signature_acknowledgment_invalid/,
  );
  assert.throws(
    () => verifyUadSignatureAcknowledgmentToken(
      token,
      expected,
      secret,
      { now: new Date("2026-09-04T12:15:00.000Z") },
    ),
    /uad_signature_acknowledgment_expired/,
  );
  assert.throws(
    () => createUadSignatureAcknowledgmentToken(expected, "short", { now }),
    /uad_signature_acknowledgment_unavailable/,
  );
});

test("registers the additive Section 29 catalog, rules, and tamper-evident signature columns", () => {
  const sql = fs.readFileSync(path.join(TEST_DIRECTORY, "../migrations/20260922_uad_certifications.sql"), "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS execution_date date/);
  assert.match(sql, /workfile_input_digest_sha256/);
  assert.match(sql, /credential_snapshot_sha256/);
  assert.match(sql, /2200\.0038/);
  assert.match(sql, /2400\.0056/);
  assert.match(sql, /2200\.0154/);
  assert.match(sql, /2400\.0041/);
  assert.match(sql, /2200\.0084/);
  assert.match(sql, /1400\.0342/);
  assert.match(sql, /2200\.0094/);
  assert.match(sql, /UAD1512/);
  assert.match(sql, /UAD1536/);
  assert.match(sql, /Appendix A-1 URAR Delivery Specification 1\.4/);
  assert.doesNotMatch(sql, /UPDATE\s+core\./i);
  assert.doesNotMatch(sql, /UPDATE\s+appraisal\.uad_field_values/i);
});

test("keeps certification readiness and signing behind the existing OIDC identity boundary", () => {
  const certifications = fs.readFileSync(path.join(TEST_DIRECTORY, "../src/modules/uad/certifications.js"), "utf8");
  const client = fs.readFileSync(path.join(TEST_DIRECTORY, "../../dcad-frontend/src/features/uad/api.ts"), "utf8");
  const panel = fs.readFileSync(path.join(TEST_DIRECTORY, "../../dcad-frontend/src/features/uad/components/UadSignaturePanel.tsx"), "utf8");
  const router = fs.readFileSync(path.join(TEST_DIRECTORY, "../src/modules/uad/router.js"), "utf8");
  const server = fs.readFileSync(path.join(TEST_DIRECTORY, "../src/oldServer.js"), "utf8");
  assert.match(router, /certification-readiness", authenticateIfNeeded/);
  assert.match(router, /signature-acknowledgments", authenticateIfNeeded/);
  assert.match(router, /signatures", authenticateIfNeeded/);
  assert.match(router, /req\.mobileAuth \? next\(\) : authenticateSigner/);
  assert.match(router, /current_signer: currentSigner/);
  assert.match(router, /signUadWorkfile/);
  assert.match(server, /verifier: mobileOidcVerifier/);
  assert.match(certifications, /uad_signature_pdf_required/);
  assert.match(certifications, /uad_signature\.acknowledged/);
  assert.match(certifications, /verifyUadSignatureAcknowledgmentToken\(/);
  assert.doesNotMatch(
    certifications,
    /const attestation = \{\s*standard_certifications_acknowledged: true,\s*scope_of_work_acknowledged: true/,
  );
  assert.match(certifications, /metadata\?\.input_digest_sha256 === inputDigest/);
  assert.match(client, /signature-acknowledgments/);
  assert.match(client, /acknowledgment_token: string/);
  assert.match(panel, /standard_certifications_acknowledged: true/);
  assert.match(panel, /acknowledgment_token: acknowledgment\.acknowledgment_token/);
  assert.match(client, /generateUadPdfArtifact[\s\S]*announceUadWorkfileMutation\(workfileId\)/);
  assert.match(client, /generateUadXmlArtifact[\s\S]*announceUadWorkfileMutation\(workfileId\)/);
});
