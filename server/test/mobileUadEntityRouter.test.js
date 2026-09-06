import assert from "node:assert/strict";
import test from "node:test";

import express from "express";

if (Object.hasOwn(process.env, "DATABASE_URL")) {
  throw new Error("mobile_uad_entity_router_test_requires_database_url_absent");
}
const { createMobileRouter } = await import("../src/modules/mobile/router.js");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ORGANIZATION_ID = "33333333-3333-4333-8333-333333333333";
const WORKFILE_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const PROPOSAL_ID = "66666666-6666-4666-8666-666666666666";
const OPERATION_ID = "77777777-7777-4777-8777-777777777777";
const ENTITY_ID = "88888888-8888-4888-8888-888888888888";
const REPORT_ID = "99999999-9999-4999-8999-999999999999";
const ISSUER = "https://identity.example.test";
const SUBJECT = "synthetic-mobile-appraiser";
const TOKEN = "synthetic-mobile-bearer";
const BEGIN = "BEGIN ISOLATION LEVEL READ COMMITTED";
const normalizeSql = (sql) => String(sql).replace(/\s+/g, " ").trim();
const IDENTITY_SQL = normalizeSql(`SELECT users.id AS user_id, users.email, users.display_name,
  memberships.organization_id, organizations.display_name AS organization_display_name, roles.role_code
  FROM app_auth.oidc_identities identities
  JOIN app_auth.users users ON users.id = identities.user_id AND users.active = true
  LEFT JOIN app_auth.organization_memberships memberships
    ON memberships.user_id = users.id AND memberships.status = 'active'
  LEFT JOIN app_auth.membership_roles roles
    ON roles.organization_id = memberships.organization_id AND roles.user_id = memberships.user_id
  LEFT JOIN app_auth.organizations organizations ON organizations.id = memberships.organization_id
  WHERE identities.issuer = $1 AND identities.subject = $2
  ORDER BY memberships.organization_id, roles.role_code`);
const IDENTITY_TOUCH_SQL = normalizeSql(`UPDATE app_auth.oidc_identities
  SET last_authenticated_at = now(), updated_at = now() WHERE issuer = $1 AND subject = $2`);
const SESSION_SQL = normalizeSql(`SELECT session.*, report_file.workflow_type, report_file.registry_revision,
  report_file.uad_workfile_id FROM app.inspection_sessions session
  JOIN app.report_files report_file ON report_file.id = session.report_file_id
  WHERE session.id = $1 AND session.organization_id = ANY($2::uuid[])
    AND session.appraiser_user_id = $3 AND report_file.workflow_type = 'uad_3_6'
  FOR UPDATE OF session, report_file`);
const OPERATION_SQL = normalizeSql(`SELECT request_sha256, result FROM app.mobile_uad_entity_review_operations
  WHERE inspection_session_id = $1 AND client_operation_id = $2`);
const PROPOSAL_SQL = normalizeSql(`SELECT * FROM app.mobile_uad_entity_proposals
  WHERE id = $1 AND inspection_session_id = $2 FOR UPDATE`);
const WORKFILE_SQL = normalizeSql(`SELECT id, current_revision, specification_release_key, status, signed_at
  FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE`);
const SIGNATURE_SQL = normalizeSql(`SELECT EXISTS (
  SELECT 1 FROM appraisal.uad_signatures WHERE workfile_id = $1 ) AS has_signatures`);

// Strict synthetic SQL contract: real authenticator, role middleware, router and
// review service; no PostgreSQL visibility, provider, or durable-device proof.
function fixture({ action = "create", signedAt = null, signatureRevision = null,
  status = "ready", provisioned = true, role = "appraiser", foreignOrganization = false,
  serviceError = null } = {}) {
  const authQueries = [], queries = [], failures = [];
  let verified = 0, connections = 0, releases = 0, active = false;
  const organizationId = foreignOrganization ? OTHER_ORGANIZATION_ID : ORGANIZATION_ID;
  const workfile = { id: WORKFILE_ID, current_revision: 2, specification_release_key: "synthetic-release",
    status, signed_at: signedAt };
  const proposal = { id: PROPOSAL_ID, inspection_session_id: SESSION_ID, report_file_id: REPORT_ID,
    uad_workfile_id: WORKFILE_ID, status: "pending", action, entity_type: "assignment_seller",
    target_entity_id: action === "delete" ? ENTITY_ID : null, parent_entity_id: null,
    label: "Synthetic seller", entity_data: {}, base_target_revision: 2,
    base_entity: action === "delete" ? { id: ENTITY_ID, workfile_id: WORKFILE_ID } : null };
  const signatures = signatureRevision === null ? [] : [{ workfile_id: WORKFILE_ID, revision_number: signatureRevision }];
  const client = {
    async query(sql, params = []) {
      const statement = normalizeSql(sql);
      queries.push(statement);
      try {
        assert.equal(this, client);
        assert.equal(releases, 0);
        if (statement === BEGIN) {
          assert.equal(active, false); assert.deepEqual(params, []); active = true;
          return { rows: [] };
        }
        assert.equal(active, true, "review must use its checked-out active transaction");
        if (statement === "ROLLBACK") {
          assert.deepEqual(params, []); active = false; return { rows: [] };
        }
        if (statement === SESSION_SQL) {
          assert.deepEqual(params, [SESSION_ID, [organizationId], USER_ID]);
          return { rows: foreignOrganization ? [] : [{ id: SESSION_ID, report_file_id: REPORT_ID,
            organization_id: ORGANIZATION_ID, appraiser_user_id: USER_ID, status: "review_required",
            workflow_type: "uad_3_6", uad_workfile_id: WORKFILE_ID, registry_revision: 3 }] };
        }
        if (statement === OPERATION_SQL) {
          assert.deepEqual(params, [SESSION_ID, OPERATION_ID]); return { rows: [] };
        }
        if (statement === PROPOSAL_SQL) {
          assert.deepEqual(params, [PROPOSAL_ID, SESSION_ID]); return { rows: [structuredClone(proposal)] };
        }
        if (statement === WORKFILE_SQL) {
          assert.deepEqual(params, [WORKFILE_ID]);
          if (serviceError) throw serviceError;
          return { rows: [structuredClone(workfile)] };
        }
        if (statement === SIGNATURE_SQL) {
          assert.equal(queries.at(-2), WORKFILE_SQL, "fresh signature query follows the workfile lock");
          assert.deepEqual(params, [WORKFILE_ID]);
          return { rows: [{ has_signatures: signatures.some((row) => row.workfile_id === WORKFILE_ID) }] };
        }
        assert.fail(`unexpected mobile entity review SQL: ${statement}`);
      } catch (error) {
        if (error !== serviceError) failures.push(error);
        throw error;
      }
    },
    release() {
      try { assert.equal(this, client); assert.equal(active, false); assert.equal(++releases, 1); }
      catch (error) { failures.push(error); throw error; }
    },
  };
  const pool = {
    async connect() {
      try { assert.equal(++connections, 1); assert.equal(authQueries.length, 2); return client; }
      catch (error) { failures.push(error); throw error; }
    },
    async query(sql, params = []) {
      const statement = normalizeSql(sql);
      authQueries.push(statement);
      try {
        assert.equal(connections, 0, "only authentication uses pool.query");
        assert.deepEqual(params, [ISSUER, SUBJECT]);
        if (statement === IDENTITY_SQL) {
          assert.equal(authQueries.length, 1);
          return { rows: provisioned ? [{ user_id: USER_ID, email: "synthetic@example.test",
            display_name: "Synthetic appraiser", organization_id: organizationId,
            organization_display_name: "Synthetic organization", role_code: role }] : [] };
        }
        if (statement === IDENTITY_TOUCH_SQL) {
          assert.equal(authQueries.length, 2); return { rows: [] };
        }
        assert.fail(`unexpected mobile authentication SQL: ${statement}`);
      } catch (error) { failures.push(error); throw error; }
    },
  };
  return {
    pool, authQueries, queries,
    verifier: { configured: true, async verify(token) {
      try { assert.equal(token, TOKEN); assert.equal(++verified, 1); return { iss: ISSUER, sub: SUBJECT }; }
      catch (error) { failures.push(error); throw error; }
    } },
    assertHealthy() { assert.deepEqual(failures, [], "mock failures must not masquerade as expected HTTP errors"); },
    ownership() { return { verified, connections, releases, active }; },
  };
}

async function requestReview(context, state, { anonymous = false } = {}) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/mobile", createMobileRouter({ pool: state.pool, verifier: state.verifier,
    enabled: true, security: { apiRateLimitEnabled: false } }));
  // No manufactured req.mobileAuth or cache middleware: use actual route behavior.
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve); server.once("error", reject);
  });
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/mobile/inspection-sessions/${SESSION_ID}/uad-entities/proposals/${PROPOSAL_ID}/review`, {
    method: "POST", headers: { "content-type": "application/json", ...(anonymous ? {} : { authorization: `Bearer ${TOKEN}` }) },
    body: JSON.stringify({ client_operation_id: OPERATION_ID, decision: "accept" }),
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.json();
  state.assertHealthy();
  return { status: response.status, cacheControl: response.headers.get("cache-control"), body };
}

function assertDeniedTransaction(state, { signatures = false, foreignOrganization = false } = {}) {
  assert.deepEqual(state.ownership(), { verified: 1, connections: 1, releases: 1, active: false });
  assert.deepEqual(state.authQueries, [IDENTITY_SQL, IDENTITY_TOUCH_SQL]);
  assert.deepEqual(state.queries, foreignOrganization ? [BEGIN, SESSION_SQL, "ROLLBACK"]
    : [BEGIN, SESSION_SQL, OPERATION_SQL, PROPOSAL_SQL, WORKFILE_SQL, ...(signatures ? [SIGNATURE_SQL] : []), "ROLLBACK"]);
  assert.equal(state.queries.some((sql) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
  assert.equal(state.queries.some((sql) => sql.includes("FROM appraisal.uad_entities")), false);
  assert.equal(state.queries.includes("COMMIT"), false);
}

for (const action of ["create", "delete"]) {
  for (const [reason, lifecycle] of [
    ["signed_at", { signedAt: "2026-09-06T00:00:00.000Z" }],
    ["partial current signature", { signatureRevision: 2 }],
    ["historical signature under revised", { status: "revised", signatureRevision: 1 }],
  ]) {
    test(`mobile UAD ${action} acceptance returns permanent no-store 409 for ${reason}`, async (context) => {
      const state = fixture({ action, ...lifecycle });
      const result = await requestReview(context, state);
      assertDeniedTransaction(state, { signatures: lifecycle.signatureRevision !== undefined });
      assert.deepEqual(result, { status: 409, cacheControl: "no-store", body: { error: "uad_workfile_status_locked" } });
    });
  }
}

for (const [name, options, requestOptions, expected, verified, authCount] of [
  ["anonymous", {}, { anonymous: true }, { status: 401, error: "invalid_access_token" }, 0, 0],
  ["unprovisioned identity", { provisioned: false }, {}, { status: 403, error: "mobile_identity_not_provisioned" }, 1, 1],
  ["read-only member", { role: "viewer" }, {}, { status: 403, error: "mobile_write_role_required" }, 1, 2],
]) {
  test(`mobile UAD review rejects ${name} before connecting a mutation client`, async (context) => {
    const state = fixture(options);
    const result = await requestReview(context, state, requestOptions);
    assert.equal(result.status, expected.status); assert.deepEqual(result.body, { error: expected.error });
    assert.deepEqual(state.ownership(), { verified, connections: 0, releases: 0, active: false });
    assert.equal(state.authQueries.length, authCount); assert.deepEqual(state.queries, []);
  });
}

test("mobile UAD review enforces organization-scoped session lookup before proposal access", async (context) => {
  const state = fixture({ foreignOrganization: true });
  const result = await requestReview(context, state);
  assertDeniedTransaction(state, { foreignOrganization: true });
  assert.equal(result.status, 404); assert.deepEqual(result.body, { error: "uad_entity_session_not_found" });
});

for (const message of ["synthetic_backend_failure_private_detail", "unrelated_status_locked"]) {
  test(`mobile UAD review keeps unexpected ${message} generic 500`, async (context) => {
    const state = fixture({ serviceError: new Error(message) });
    const result = await requestReview(context, state);
    assertDeniedTransaction(state);
    assert.equal(result.status, 500); assert.deepEqual(result.body, { error: "mobile_request_failed" });
    assert.equal(JSON.stringify(result.body).includes(message), false);
  });
}
