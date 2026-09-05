import assert from "node:assert/strict";
import test from "node:test";

import {
  createUadSignatureAcknowledgmentToken,
  getUadCertificationReadiness,
  signUadWorkfile,
} from "../src/modules/uad/certifications.js";
import { getUadEditor } from "../src/modules/uad/editor.js";
import { listUadAssets } from "../src/modules/uad/assets.js";
import { listUadSketches } from "../src/modules/uad/sketches.js";
import { buildUadValidationInputDigest } from "../src/modules/uad/validation.js";

const WORKFILE_ID = "00000000-0000-4000-8000-000000000101";
const APPRAISER_ID = "00000000-0000-4000-8000-000000000102";
const SUPERVISOR_ID = "00000000-0000-4000-8000-000000000103";
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000104";
const ASSET_ID = "00000000-0000-4000-8000-000000000105";
const NOW = new Date("2026-09-05T12:00:00.000Z");
const SECRET = "synthetic-signing-assurance-secret-at-least-32-characters";
const OPTIONS = { signingSecret: SECRET, now: NOW };
const SPOOFED_ASSURANCE = {
  auth_time: Math.floor(NOW.getTime() / 1000),
  amr: ["mfa", "pwd"],
  acr: "strong",
  mfa_verified: true,
  reauthenticated: true,
  last_authenticated_at: NOW.toISOString(),
};

function authentication(userId = APPRAISER_ID) {
  return { userId, issuer: "https://synthetic-identity.example", subject: `synthetic-${userId}` };
}

function signer(userId = APPRAISER_ID, role = "appraiser") {
  return {
    workfile_id: WORKFILE_ID,
    user_id: userId,
    signer_role: role,
    display_name: role === "appraiser" ? "Synthetic Test Appraiser" : "Synthetic Test Supervisor",
    user_active: true,
    user_metadata: {},
    signature_policy: "session",
    profile_status: "active",
    organization_id: ORGANIZATION_ID,
    organization_legal_name: "Synthetic Test Organization LLC",
    organization_display_name: "Synthetic Test Organization",
    organization_dba_name: null,
    address_line_1: "100 Synthetic Test Lane",
    address_line_2: null,
    city: "Test City",
    state_code: "TX",
    postal_code: "75000",
    country_code: "US",
    license_id: "00000000-0000-4000-8000-000000000106",
    jurisdiction: "TX",
    license_number: "SYNTHETIC-NOT-A-REAL-LICENSE",
    license_type: "Certified Residential",
    issued_on: "2025-01-01",
    expires_on: "2999-12-31",
    license_status: "active",
    license_metadata: {},
  };
}

// Only SQL is simulated. The real editor/digest, consent-token verification,
// readiness, signing persistence and quorum services execute without injection.
// The pre-existing passed validation/PDF rows are synthetic stored evidence;
// these tests do not claim to generate a compliant appraisal or real artifact.
function harness({ supervisor = false, failAt = null, rollbackFails = false } = {}) {
  const state = {
    workfile: {
      id: WORKFILE_ID,
      account_id: "SYNTHETIC-ACCOUNT",
      file_number: "SYNTHETIC-SIGNING-ASSURANCE",
      organization_id: ORGANIZATION_ID,
      assigned_appraiser_user_id: APPRAISER_ID,
      supervisory_appraiser_user_id: supervisor ? SUPERVISOR_ID : null,
      specification_release_key: "uad-3.6-test",
      status: "ready",
      current_revision: 4,
      signed_at: null,
      updated_at: NOW.toISOString(),
    },
    signers: [signer(), ...(supervisor ? [signer(SUPERVISOR_ID, "supervisory_appraiser")] : [])],
    signatures: [],
    audits: [],
    effectiveDate: "2026-09-04",
    validationStatus: "passed",
    validationRevision: 4,
    validationDigest: null,
    pdfStatus: "ready",
    pdfDigest: null,
    verifiedSignatureAsset: true,
    connects: 0,
    releases: 0,
    calls: [],
  };
  const fields = [
    ["assignment", "1000.0158", "TraditionalAppraisal"],
    ["appraiser_inspection", "2400.0081", "Physical"],
    ["appraiser_inspection", "2400.0082", "Physical"],
    ["reconciliation", "1300.0012", "2026-09-04"],
    ["certification_scope", "2200.0062", false],
    ["certification_intended_user", "2200.0037", false],
    ["certification_report", "2200.0038", "InteriorAndExterior"],
    ["certification_report", "2200.0017", false],
    ["certification_report", "2200.0034", false],
  ].map(([field_context, uad_uid, value], index) => ({
    id: `synthetic-field-${index}`, workfile_id: WORKFILE_ID, entity_id: null,
    field_context, uad_uid, report_field_id: null, value,
    source_type: "manual", source_reference: null,
    is_appraiser_confirmed: true, is_override: false,
    created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
  }));
  const assets = [{
    id: ASSET_ID, workfile_id: WORKFILE_ID, entity_id: null,
    asset_kind: "signature", section_number: 29, caption_type: null,
    caption: "Synthetic signature image", original_file_name: "synthetic-signature.png",
    content_type: "image/png", byte_size: 64, status: "verified",
    capture_metadata: { synthetic_only: true },
    uploaded_at: NOW.toISOString(), verified_at: NOW.toISOString(), created_at: NOW.toISOString(),
  }];
  let transactionSnapshot = null;
  const record = (kind, sql, parameters) => {
    state.calls.push({ kind, sql, parameters });
    if (kind === failAt) throw new Error(`synthetic_${kind}_failure`);
  };
  const query = async (statement, parameters = []) => {
    const sql = statement.replace(/\s+/g, " ").trim();
    if (sql === "BEGIN") {
      record("begin", sql, parameters);
      transactionSnapshot = structuredClone({
        workfile: state.workfile, signatures: state.signatures, audits: state.audits,
      });
      return { rows: [] };
    }
    if (sql === "ROLLBACK") {
      record("rollback", sql, parameters);
      if (transactionSnapshot) Object.assign(state, transactionSnapshot);
      transactionSnapshot = null;
      if (rollbackFails) throw new Error("synthetic_rollback_failure");
      return { rows: [] };
    }
    if (sql === "COMMIT") {
      record("commit", sql, parameters);
      transactionSnapshot = null;
      return { rows: [] };
    }
    if (sql.startsWith("SELECT * FROM appraisal.uad_workfiles") && sql.endsWith("FOR UPDATE")) {
      record("lock", sql, parameters);
      assert.deepEqual(parameters, [WORKFILE_ID]);
      return { rows: state.workfile ? [{ ...state.workfile }] : [] };
    }
    if (sql.startsWith("WITH required_signers AS")) {
      record("signers", sql, parameters);
      assert.deepEqual(parameters, [WORKFILE_ID]);
      return { rows: state.signers.map(row => ({ ...row })) };
    }
    if (sql.startsWith("SELECT value #>> '{}' AS effective_date")) {
      record("effective_date", sql, parameters);
      assert.deepEqual(parameters, [WORKFILE_ID]);
      return { rows: [{ effective_date: state.effectiveDate }] };
    }
    if (sql.startsWith("SELECT id FROM appraisal.uad_assets")) {
      record("signature_asset", sql, parameters);
      assert.deepEqual(parameters, [ASSET_ID, WORKFILE_ID]);
      assert.match(sql, /asset_kind = 'signature' AND status = 'verified'/);
      return { rows: state.verifiedSignatureAsset ? [{ id: ASSET_ID }] : [] };
    }
    if (sql.startsWith("SELECT id,") && sql.includes("FROM appraisal.uad_workfiles")) {
      record(sql.includes("account_id") ? "editor_workfile" : "readiness_workfile", sql, parameters);
      assert.deepEqual(parameters, [WORKFILE_ID]);
      return { rows: state.workfile ? [{ ...state.workfile }] : [] };
    }
    for (const [table, kind, rows] of [
      ["uad_field_values", "fields", fields],
      ["uad_entities", "entities", []],
      ["uad_assets", "assets", assets],
      ["uad_sketches", "sketches", []],
    ]) {
      if (sql.startsWith(`SELECT * FROM appraisal.${table} `)) {
        record(kind, sql, parameters);
        assert.deepEqual(parameters, [WORKFILE_ID]);
        return { rows: structuredClone(rows) };
      }
    }
    if (sql.startsWith("SELECT status, revision_number, metadata FROM appraisal.uad_validation_runs")) {
      record("validation", sql, parameters);
      assert.deepEqual(parameters, [WORKFILE_ID]);
      return { rows: [{ status: state.validationStatus, revision_number: state.validationRevision,
        metadata: { input_digest_sha256: state.validationDigest } }] };
    }
    if (sql.startsWith("SELECT artifact_type, generation_status, metadata")) {
      record("pdf", sql, parameters);
      assert.deepEqual(parameters, [WORKFILE_ID, 4]);
      return { rows: [{ artifact_type: "pdf", generation_status: state.pdfStatus,
        metadata: { input_digest_sha256: state.pdfDigest } }] };
    }
    if (sql.startsWith("SELECT id, workfile_id, revision_number, signer_user_id, signer_role,")) {
      record("current_signatures", sql, parameters);
      assert.deepEqual(parameters, [WORKFILE_ID, 4]);
      return { rows: structuredClone(state.signatures.filter(row => row.revision_number === 4)) };
    }
    if (sql.startsWith("INSERT INTO appraisal.uad_signatures")) {
      record("insert_signature", sql, parameters);
      const [id, workfile_id, revision_number, signer_user_id, signer_role,
        signature_asset_id, credentialJson, authentication_method, execution_date,
        workfile_input_digest_sha256, credential_snapshot_sha256, attestationJson] = parameters;
      assert.equal(workfile_id, WORKFILE_ID);
      assert.equal(revision_number, 4);
      const row = { id, workfile_id, revision_number, signer_user_id, signer_role,
        signature_asset_id, authentication_method, execution_date, workfile_input_digest_sha256,
        credential_snapshot_sha256, signed_at: NOW.toISOString() };
      state.signatures.push({ ...row, credential_snapshot: JSON.parse(credentialJson),
        attestation: JSON.parse(attestationJson) });
      return { rows: [row] };
    }
    if (sql.startsWith("SELECT revision_number, signer_user_id, signer_role, workfile_input_digest_sha256")) {
      record("quorum", sql, parameters);
      assert.deepEqual(parameters, [WORKFILE_ID, 4]);
      return { rows: structuredClone(state.signatures.filter(row => row.revision_number === 4)) };
    }
    if (sql.startsWith("UPDATE appraisal.uad_workfiles SET status = 'signed'")) {
      record("mark_signed", sql, parameters);
      assert.deepEqual(parameters, [WORKFILE_ID]);
      state.workfile.status = "signed";
      state.workfile.signed_at = NOW.toISOString();
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO appraisal.uad_audit_events")) {
      record("audit", sql, parameters);
      assert.match(sql, /'uad_signature.created'/);
      state.audits.push({ workfile_id: parameters[0], actor_user_id: parameters[1],
        signature_id: parameters[2], after: JSON.parse(parameters[3]), metadata: JSON.parse(parameters[4]) });
      return { rows: [], rowCount: 1 };
    }
    assert.fail(`Unexpected synthetic signing query: ${sql}`);
  };
  const client = { query, release() { state.releases += 1; } };
  const pool = { query, async connect() { state.connects += 1; return client; } };
  return {
    pool, state,
    async prime() {
      const editor = await getUadEditor(pool, WORKFILE_ID);
      const digest = buildUadValidationInputDigest(editor,
        await listUadAssets(pool, WORKFILE_ID), await listUadSketches(pool, WORKFILE_ID));
      state.validationDigest = digest;
      state.pdfDigest = digest;
      state.calls.length = 0;
      return digest;
    },
    input(userId = APPRAISER_ID) {
      const signerRole = userId === APPRAISER_ID ? "appraiser" : "supervisory_appraiser";
      return {
        execution_date: "2026-09-05",
        acknowledgment_token: createUadSignatureAcknowledgmentToken({
          workfileId: WORKFILE_ID, revisionNumber: 4, inputDigest: state.validationDigest,
          signerUserId: userId, signerRole, authentication: authentication(userId),
        }, SECRET, { now: NOW }).token,
      };
    },
  };
}

async function assertEarlyDenial(fixture, code, { input = {}, auth = authentication() } = {}) {
  await assert.rejects(signUadWorkfile(fixture.pool, WORKFILE_ID, auth, input, OPTIONS), { message: code });
  assert.deepEqual(fixture.state.calls.map(call => call.kind), ["begin", "lock", "signers", "rollback"]);
  assert.equal(fixture.state.connects, 1);
  assert.equal(fixture.state.releases, 1);
  assert.deepEqual(fixture.state.signatures, []);
  assert.deepEqual(fixture.state.audits, []);
  assert.equal(fixture.state.workfile.status, "ready");
  assert.equal(fixture.state.workfile.signed_at, null);
}

const INVALID_POLICIES = [
  ["missing", undefined], ["null", null], ["blank", ""], ["whitespace", " "],
  ["false", false], ["true", true], ["zero", 0], ["one", 1], ["NaN", NaN],
  ["case changed", "Session"], ["trim required", " session "],
  ["unknown", "mfa"], ["misspelled", "reauthentcation"],
  ["reauth case changed", "Reauthentication"], ["reauth whitespace", "reauthentication "],
  ["array", ["session"]], ["empty array", []], ["object", { method: "session" }],
  ["boxed string", new String("session")], ["symbol", Symbol("session")],
];

for (const [label, policy] of INVALID_POLICIES) {
  test(`signing assurance: ${label} profile policy fails closed before downstream reads`, async () => {
    const fixture = harness();
    if (label === "missing") delete fixture.state.signers[0].signature_policy;
    else fixture.state.signers[0].signature_policy = policy;
    await assertEarlyDenial(fixture, "uad_signature_policy_invalid", {
      input: { authentication_method: "session", ...SPOOFED_ASSURANCE },
      auth: { ...authentication(), ...SPOOFED_ASSURANCE },
    });
  });
}

for (const input of [
  {}, { authentication_method: "session" }, { authentication_method: "reauthentication" },
  { authentication_method: "mfa", ...SPOOFED_ASSURANCE },
]) {
  test(`signing assurance: reauthentication is unavailable despite caller method ${String(input.authentication_method)}`, async () => {
    const fixture = harness();
    fixture.state.signers[0].signature_policy = "reauthentication";
    await assertEarlyDenial(fixture, "uad_signature_reauthentication_unavailable", {
      input, auth: { ...authentication(), ...SPOOFED_ASSURANCE },
    });
    assert.equal(fixture.state.signers[0].signature_policy, "reauthentication", "never downgrade the stored policy");
  });
}

const INVALID_METHODS = [
  ["explicit undefined", undefined], ["null", null], ["false", false], ["true", true],
  ["zero", 0], ["one", 1], ["blank", ""], ["whitespace", " "],
  ["stronger", "reauthentication"], ["MFA", "mfa"], ["case changed", "Session"],
  ["trim required", " session "], ["array", ["session"]], ["object", { method: "session" }],
  ["boxed string", new String("session")], ["symbol", Symbol("session")],
];

for (const [label, method] of INVALID_METHODS) {
  test(`signing assurance: ${label} caller method cannot label a session signature`, async () => {
    const fixture = harness();
    await assertEarlyDenial(fixture, "uad_signature_authentication_method_mismatch", {
      input: { authentication_method: method, ...SPOOFED_ASSURANCE },
    });
  });
}

test("signing assurance: policy and request objects are never coerced into trusted strings", async () => {
  let coercions = 0;
  const coercible = { toString() { coercions += 1; return "session"; } };
  const invalidPolicy = harness();
  invalidPolicy.state.signers[0].signature_policy = coercible;
  await assertEarlyDenial(invalidPolicy, "uad_signature_policy_invalid");
  const invalidMethod = harness();
  await assertEarlyDenial(invalidMethod, "uad_signature_authentication_method_mismatch", {
    input: { authentication_method: coercible },
  });
  assert.equal(coercions, 0);
});

test("signing assurance: credential errors retain precedence over unsupported policy and caller method", async () => {
  const fixture = harness();
  fixture.state.signers[0].profile_status = "inactive";
  fixture.state.signers[0].signature_policy = "reauthentication";
  await assert.rejects(signUadWorkfile(fixture.pool, WORKFILE_ID, authentication(),
    { authentication_method: null }, OPTIONS), error => {
    assert.equal(error.message, "uad_signature_credentials_incomplete");
    assert.deepEqual(error.details, { missing: ["active_appraiser_profile"] });
    return true;
  });
  assert.deepEqual(fixture.state.calls.map(call => call.kind), ["begin", "lock", "signers", "rollback"]);
  assert.equal(fixture.state.releases, 1);
});

test("signing assurance: rollback failure never hides the stable policy error", async () => {
  const fixture = harness({ rollbackFails: true });
  fixture.state.signers[0].signature_policy = "reauthentication";
  await assertEarlyDenial(fixture, "uad_signature_reauthentication_unavailable");
});

for (const method of ["omitted", "session"]) {
  test(`signing assurance: ${method} method persists a server-derived session signature and complete quorum`, async () => {
    const fixture = harness();
    const digest = await fixture.prime();
    const input = { ...fixture.input(), signature_asset_id: ASSET_ID, ...SPOOFED_ASSURANCE,
      signer_user_id: SUPERVISOR_ID, signer_role: "supervisory_appraiser" };
    if (method !== "omitted") input.authentication_method = method;
    const result = await signUadWorkfile(fixture.pool, WORKFILE_ID,
      { ...authentication(), ...SPOOFED_ASSURANCE }, input, OPTIONS);
    assert.equal(result.idempotent, false);
    assert.equal(result.workfile_status, "signed");
    assert.equal(result.quorum.complete, true);
    assert.deepEqual(result.quorum.missing_roles, []);
    assert.equal(result.signature.authentication_method, "session");
    assert.equal(result.signature.signer_user_id, APPRAISER_ID);
    assert.equal(result.signature.signer_role, "appraiser");
    assert.equal(result.signature.signature_asset_id, ASSET_ID);
    assert.equal(result.signature.workfile_input_digest_sha256, digest);
    assert.equal(fixture.state.workfile.current_revision, 4);
    assert.equal(fixture.state.workfile.signed_at, NOW.toISOString());
    assert.equal(fixture.state.signatures.length, 1);
    const stored = fixture.state.signatures[0];
    assert.equal(stored.credential_snapshot.signature_policy, "session");
    assert.equal(stored.credential_snapshot.signer.user_id, APPRAISER_ID);
    assert.equal(stored.attestation.standard_certifications_acknowledged, true);
    assert.equal(stored.attestation.scope_of_work_acknowledged, true);
    assert.equal(stored.attestation.authentication_subject, authentication().subject);
    for (const key of Object.keys(SPOOFED_ASSURANCE)) {
      assert.equal(Object.hasOwn(stored, key), false);
      assert.equal(Object.hasOwn(stored.attestation, key), false);
    }
    assert.equal(fixture.state.audits.length, 1);
    assert.equal(fixture.state.audits[0].actor_user_id, APPRAISER_ID);
    assert.equal(fixture.state.audits[0].metadata.workfile_input_digest_sha256, digest);
    assert.equal(fixture.state.calls.at(-1).kind, "commit");
    assert.equal(fixture.state.calls.some(call => call.kind === "rollback"), false);
    assert.equal(fixture.state.releases, 1);
  });
}

test("signing assurance: session partial quorum supports idempotent replay and the real supervisor completion", async () => {
  const fixture = harness({ supervisor: true });
  await fixture.prime();
  const first = await signUadWorkfile(fixture.pool, WORKFILE_ID, authentication(), fixture.input(), OPTIONS);
  assert.equal(first.workfile_status, "ready");
  assert.deepEqual(first.quorum.missing_roles, ["supervisory_appraiser"]);
  assert.equal(fixture.state.workfile.signed_at, null);
  fixture.state.calls.length = 0;
  const replay = await signUadWorkfile(fixture.pool, WORKFILE_ID, authentication(),
    { ...fixture.input(), authentication_method: "session" }, OPTIONS);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.signature.id, first.signature.id);
  assert.equal(replay.workfile_status, "ready");
  assert.equal(fixture.state.signatures.length, 1);
  assert.equal(fixture.state.audits.length, 1);
  assert.equal(fixture.state.calls.some(call => ["insert_signature", "audit", "mark_signed"].includes(call.kind)), false);
  const completed = await signUadWorkfile(fixture.pool, WORKFILE_ID, authentication(SUPERVISOR_ID),
    fixture.input(SUPERVISOR_ID), OPTIONS);
  assert.equal(completed.quorum.complete, true);
  assert.equal(completed.signature.signer_role, "supervisory_appraiser");
  assert.equal(completed.signature.authentication_method, "session");
  assert.equal(completed.workfile_status, "signed");
  assert.equal(fixture.state.signatures.length, 2);
  assert.equal(fixture.state.audits.length, 2);
  assert.equal(fixture.state.releases, 3);
});

test("signing assurance: a session signer does not bypass an unavailable co-signer policy", async () => {
  const fixture = harness({ supervisor: true });
  fixture.state.signers[1].signature_policy = "reauthentication";
  await fixture.prime();
  const partial = await signUadWorkfile(fixture.pool, WORKFILE_ID, authentication(), fixture.input(), OPTIONS);
  assert.equal(partial.workfile_status, "ready");
  assert.deepEqual(partial.quorum.missing_roles, ["supervisory_appraiser"]);
  fixture.state.calls.length = 0;
  await assert.rejects(signUadWorkfile(fixture.pool, WORKFILE_ID, authentication(SUPERVISOR_ID),
    { ...fixture.input(SUPERVISOR_ID), authentication_method: "reauthentication", ...SPOOFED_ASSURANCE }, OPTIONS),
  { message: "uad_signature_reauthentication_unavailable" });
  assert.deepEqual(fixture.state.calls.map(call => call.kind), ["begin", "lock", "signers", "rollback"]);
  assert.equal(fixture.state.signatures.length, 1);
  assert.equal(fixture.state.audits.length, 1);
  assert.equal(fixture.state.workfile.status, "ready");
});

test("signing assurance: genuine consent cannot upgrade a reauthentication policy to verified assurance", async () => {
  const fixture = harness();
  await fixture.prime();
  const input = { ...fixture.input(), authentication_method: "reauthentication", ...SPOOFED_ASSURANCE };
  fixture.state.signers[0].signature_policy = "reauthentication";
  await assertEarlyDenial(fixture, "uad_signature_reauthentication_unavailable", { input });
});

test("signing assurance: an existing reauthentication label cannot be silently replayed as session", async () => {
  const fixture = harness({ supervisor: true });
  await fixture.prime();
  await signUadWorkfile(fixture.pool, WORKFILE_ID, authentication(), fixture.input(), OPTIONS);
  fixture.state.signatures[0].authentication_method = "reauthentication";
  const existing = structuredClone(fixture.state.signatures);
  fixture.state.calls.length = 0;
  await assert.rejects(signUadWorkfile(fixture.pool, WORKFILE_ID, authentication(), fixture.input(), OPTIONS),
    { message: "uad_signature_existing_snapshot_mismatch" });
  assert.deepEqual(fixture.state.signatures, existing, "do not relabel or delete historical signing evidence");
  assert.equal(fixture.state.audits.length, 1);
  assert.equal(fixture.state.calls.some(call => ["insert_signature", "audit", "mark_signed", "commit"].includes(call.kind)), false);
  assert.equal(fixture.state.calls.at(-1).kind, "rollback");
  assert.equal(fixture.state.releases, 2);
});

test("signing assurance: a newly unsupported policy blocks even replay of a pre-existing session signature", async () => {
  const fixture = harness({ supervisor: true });
  await fixture.prime();
  await signUadWorkfile(fixture.pool, WORKFILE_ID, authentication(), fixture.input(), OPTIONS);
  const existing = structuredClone(fixture.state.signatures);
  fixture.state.signers[0].signature_policy = "reauthentication";
  fixture.state.calls.length = 0;
  await assert.rejects(signUadWorkfile(fixture.pool, WORKFILE_ID, authentication(), fixture.input(), OPTIONS),
    { message: "uad_signature_reauthentication_unavailable" });
  assert.deepEqual(fixture.state.calls.map(call => call.kind), ["begin", "lock", "signers", "rollback"]);
  assert.deepEqual(fixture.state.signatures, existing);
  assert.equal(fixture.state.audits.length, 1);
  assert.equal(fixture.state.releases, 2);
});

for (const [label, mutate, expected] of [
  ["failed validation", state => { state.validationStatus = "failed"; }, "uad_signature_local_validation_stale"],
  ["old validation revision", state => { state.validationRevision = 3; }, "uad_signature_local_validation_stale"],
  ["changed validation digest", state => { state.validationDigest = "0".repeat(64); }, "uad_signature_local_validation_stale"],
  ["failed PDF", state => { state.pdfStatus = "failed"; }, "uad_signature_pdf_required"],
  ["changed PDF digest", state => { state.pdfDigest = "0".repeat(64); }, "uad_signature_pdf_required"],
  ["future effective date", state => { state.effectiveDate = "2026-09-06"; }, "uad_signature_before_effective_date"],
  ["unverified signature asset", state => { state.verifiedSignatureAsset = false; }, "uad_signature_asset_not_verified"],
]) {
  test(`signing assurance: session policy preserves ${label} refusal`, async () => {
    const fixture = harness();
    await fixture.prime();
    const input = { ...fixture.input(), signature_asset_id: ASSET_ID };
    mutate(fixture.state);
    await assert.rejects(signUadWorkfile(fixture.pool, WORKFILE_ID, authentication(), input, OPTIONS), { message: expected });
    assert.equal(fixture.state.calls.some(call => ["insert_signature", "audit", "mark_signed", "commit"].includes(call.kind)), false);
    assert.equal(fixture.state.calls.at(-1).kind, "rollback");
    assert.equal(fixture.state.releases, 1);
    assert.deepEqual(fixture.state.signatures, []);
    assert.deepEqual(fixture.state.audits, []);
  });
}

test("signing assurance: request identities and assurance claims cannot replace authenticated identity", async () => {
  const fixture = harness();
  await assert.rejects(signUadWorkfile(fixture.pool, WORKFILE_ID, SPOOFED_ASSURANCE,
    { userId: APPRAISER_ID, signer_user_id: APPRAISER_ID, ...SPOOFED_ASSURANCE }, OPTIONS),
  { message: "uad_signature_authentication_required" });
  assert.equal(fixture.state.connects, 0);
  assert.deepEqual(fixture.state.calls, []);
});

test("signing assurance: an unassigned authenticated identity retains access-denied precedence", async () => {
  const fixture = harness();
  await assert.rejects(signUadWorkfile(fixture.pool, WORKFILE_ID, authentication(SUPERVISOR_ID),
    { signer_user_id: APPRAISER_ID, authentication_method: "session", ...SPOOFED_ASSURANCE }, OPTIONS),
  { message: "uad_signature_access_denied" });
  assert.deepEqual(fixture.state.calls.map(call => call.kind), ["begin", "lock", "rollback"]);
  assert.equal(fixture.state.releases, 1);
});

for (const [label, mutate, expected] of [
  ["missing consent", input => { delete input.acknowledgment_token; }, "uad_signature_acknowledgment_required"],
  ["tampered consent", input => { input.acknowledgment_token += "tampered"; }, "uad_signature_acknowledgment_invalid"],
]) {
  test(`signing assurance: session policy preserves ${label} refusal`, async () => {
    const fixture = harness();
    await fixture.prime();
    const input = fixture.input(); mutate(input);
    await assert.rejects(signUadWorkfile(fixture.pool, WORKFILE_ID, authentication(), input, OPTIONS), { message: expected });
    assert.equal(fixture.state.calls.at(-1).kind, "rollback");
    assert.equal(fixture.state.calls.some(call => ["insert_signature", "audit", "mark_signed", "commit"].includes(call.kind)), false);
    assert.equal(fixture.state.releases, 1);
  });
}

for (const stage of ["insert_signature", "quorum", "mark_signed", "audit", "commit"]) {
  test(`signing assurance: session ${stage} failure preserves rollback and release`, async () => {
    const fixture = harness({ failAt: stage });
    await fixture.prime();
    await assert.rejects(signUadWorkfile(fixture.pool, WORKFILE_ID, authentication(), fixture.input(), OPTIONS),
      { message: `synthetic_${stage}_failure` });
    assert.equal(fixture.state.calls.at(-1).kind, "rollback");
    assert.equal(fixture.state.releases, 1);
    assert.deepEqual(fixture.state.signatures, []);
    assert.deepEqual(fixture.state.audits, []);
    assert.equal(fixture.state.workfile.status, "ready");
    assert.equal(fixture.state.workfile.signed_at, null);
  });
}

for (const [label, policy] of [["reauthentication", "reauthentication"], ...INVALID_POLICIES]) {
  test(`signing assurance readiness: ${label} blocks its signer with the stable policy code`, async () => {
    const fixture = harness({ supervisor: true });
    if (label === "missing") delete fixture.state.signers[1].signature_policy;
    else fixture.state.signers[1].signature_policy = policy;
    await fixture.prime();
    const result = await getUadCertificationReadiness(fixture.pool, WORKFILE_ID);
    assert.equal(result.ready, false);
    assert.equal(result.artifact_readiness.pdf_ready, true);
    assert.equal(result.signers.length, 2);
    assert.equal(result.signers[0].ready, true);
    assert.deepEqual(result.signers[0].missing, []);
    assert.equal(result.signers[1].ready, false);
    assert.deepEqual(result.signers[1].missing, [label === "reauthentication"
      ? "uad_signature_reauthentication_unavailable" : "uad_signature_policy_invalid"]);
    assert.equal(result.signers[1].user_id, SUPERVISOR_ID);
    assert.equal(result.signers[1].role, "supervisory_appraiser");
    assert.equal(fixture.state.connects, 0);
    assert.equal(fixture.state.calls.some(call => ["begin", "insert_signature", "audit", "mark_signed", "commit"].includes(call.kind)), false);
  });
}

test("signing assurance readiness: ordinary session signers and current PDF remain ready", async () => {
  const fixture = harness({ supervisor: true });
  await fixture.prime();
  const result = await getUadCertificationReadiness(fixture.pool, WORKFILE_ID);
  assert.equal(result.ready, true);
  assert.equal(result.revision_number, 4);
  assert.equal(result.workfile_status, "ready");
  assert.equal(result.signers.every(row => row.ready && row.signature_policy === "session"), true);
  assert.equal(result.signers.every(row => row.missing.length === 0), true);
});

test("signing assurance readiness: existing missing credentials precede the policy code", async () => {
  const fixture = harness();
  fixture.state.signers[0].profile_status = "inactive";
  fixture.state.signers[0].signature_policy = "reauthentication";
  await fixture.prime();
  const result = await getUadCertificationReadiness(fixture.pool, WORKFILE_ID);
  assert.deepEqual(result.signers[0].missing,
    ["active_appraiser_profile", "uad_signature_reauthentication_unavailable"]);
  assert.equal(result.ready, false);
});
