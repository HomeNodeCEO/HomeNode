import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";

import {
  REDTEAM_AUTHORIZATION_PERSONAS,
  createRedTeamAccessTokenFactory,
  runUadRedTeamAuthorizationMatrix,
} from "../src/modules/uad/uadRedTeamAuthorization.js";
import { REDTEAM_API_ORIGIN } from "../src/modules/uad/uadRedTeamBaseline.js";
import { REDTEAM_PERSONAS } from "../src/security/redTeamFixtures.js";

const WORKFILES = Object.freeze({
  organization_a: Object.freeze({
    id: "11111111-1111-4111-8111-111111111111",
    organization_id: "10000000-0000-4000-8000-000000000001",
    file_number: "HN-REDTEAM-ORG-A-0001",
  }),
  organization_b: Object.freeze({
    id: "22222222-2222-4222-8222-222222222222",
    organization_id: "20000000-0000-4000-8000-000000000001",
    file_number: "HN-REDTEAM-ORG-B-0001",
  }),
});

const ACCESS = Object.freeze({
  assigned_appraiser_a: { list: ["organization_a"], read: ["organization_a"], write: ["organization_a"] },
  unassigned_appraiser_a: { list: [], read: [], write: [] },
  supervisor_a: { list: [], read: [], write: [] },
  reviewer_a: { list: ["organization_a"], read: ["organization_a"], write: [] },
  organization_admin_a: { list: ["organization_a"], read: ["organization_a"], write: ["organization_a"] },
  appraiser_b: { list: ["organization_b"], read: ["organization_b"], write: ["organization_b"] },
  organization_admin_b: { list: ["organization_b"], read: ["organization_b"], write: ["organization_b"] },
  homenode_admin: { list: ["organization_a", "organization_b"], read: ["organization_a", "organization_b"], write: ["organization_a", "organization_b"] },
  inactive_user: { authenticationError: "mobile_identity_not_provisioned" },
  suspended_member: { authenticationError: "mobile_organization_membership_required" },
  member_without_role: { listError: "uad_access_denied", list: [], read: [], write: [] },
  unprovisioned_user: { authenticationError: "mobile_identity_not_provisioned" },
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function matrixFetch({ leakCrossTenant = false, reviewerCanWrite = false } = {}) {
  return async (url, init = {}) => {
    const token = new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "") || "";
    const persona = token.replace(/^redteam-token-/, "");
    const access = ACCESS[persona];
    if (!access) return json({ error: "invalid_access_token" }, 401);
    if (access.authenticationError) return json({ error: access.authenticationError }, 403);

    const path = new URL(url).pathname;
    if (path === "/api/mobile/me") return json({ user: { userId: `synthetic:${persona}` } });
    if (path.includes("/api/uad/accounts/") && path.endsWith("/workfiles")) {
      if (access.listError) return json({ error: access.listError }, 403);
      return json({ workfiles: access.list.map((label) => WORKFILES[label]) });
    }

    const label = Object.entries(WORKFILES).find(([, workfile]) => path.includes(workfile.id))?.[0];
    if (!label) throw new Error(`unexpected_request:${path}`);
    if (init.method === "PATCH") {
      const allowed = access.write.includes(label)
        || (reviewerCanWrite && persona === "reviewer_a" && label === "organization_a");
      return allowed
        ? json({ error: "invalid_uad_expected_revision" }, 400)
        : json({ error: "uad_workfile_access_denied" }, 403);
    }
    const allowed = access.read.includes(label)
      || (leakCrossTenant && persona === "assigned_appraiser_a" && label === "organization_b");
    return allowed
      ? json({ workfile: WORKFILES[label] })
      : json({ error: "uad_workfile_access_denied" }, 403);
  };
}

const getAccessToken = async (persona) => `redteam-token-${persona}`;

test("authenticated red-team matrix proves role and tenant boundaries without mutation", async () => {
  const result = await runUadRedTeamAuthorizationMatrix({
    fetchImpl: matrixFetch(),
    getAccessToken,
    checkedAt: "2026-08-21T20:46:21.360Z",
  });

  assert.equal(result.ok, true);
  assert.equal(result.request_count, 73);
  assert.equal(Object.keys(result.personas).length, REDTEAM_AUTHORIZATION_PERSONAS.length);
  assert.equal(result.personas.reviewer_a.targets.organization_a.read.http_status, 200);
  assert.equal(result.personas.reviewer_a.targets.organization_a.write_probe.http_status, 403);
  assert.equal(result.personas.homenode_admin.targets.organization_b.write_probe.error_code, "invalid_uad_expected_revision");
  assert.equal(result.personas.unprovisioned_user.identity.error_code, "mobile_identity_not_provisioned");
  assert.doesNotMatch(JSON.stringify(result), /redteam-token-|Bearer\s/i);
});

test("matrix fails on cross-tenant disclosure or reviewer write privilege", async () => {
  const leaked = await runUadRedTeamAuthorizationMatrix({
    fetchImpl: matrixFetch({ leakCrossTenant: true }),
    getAccessToken,
  });
  assert.equal(leaked.ok, false);
  assert.equal(leaked.personas.assigned_appraiser_a.targets.organization_b.read.ready, false);

  const excessivePrivilege = await runUadRedTeamAuthorizationMatrix({
    fetchImpl: matrixFetch({ reviewerCanWrite: true }),
    getAccessToken,
  });
  assert.equal(excessivePrivilege.ok, false);
  assert.equal(excessivePrivilege.personas.reviewer_a.targets.organization_a.write_probe.ready, false);
});

test("short-lived synthetic JWT factory signs RS256 tokens and rejects non-red-team issuers", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const subjects = Object.fromEntries(REDTEAM_PERSONAS.map((persona) => [persona.key, `subject:${persona.key}`]));
  const factory = createRedTeamAccessTokenFactory({
    privateKeyPem,
    keyId: "uad-redteam-test-key",
    issuer: "https://uad-redteam-identity.homenode.invalid",
    audience: "homenode-uad-redteam-api",
    subjectsJson: JSON.stringify(subjects),
    now: () => Date.UTC(2026, 7, 21, 20, 0, 0),
  });
  const token = await factory("assigned_appraiser_a");
  const parts = token.split(".");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  assert.equal(header.alg, "RS256");
  assert.equal(header.kid, "uad-redteam-test-key");
  assert.equal(payload.sub, "subject:assigned_appraiser_a");
  assert.equal(payload.exp - payload.iat, 600);
  assert.equal(verify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"),
    createPublicKey(privateKey),
    Buffer.from(parts[2], "base64url"),
  ), true);

  assert.throws(() => createRedTeamAccessTokenFactory({
    privateKeyPem,
    keyId: "uad-redteam-test-key",
    issuer: "https://identity.example.com",
    audience: "homenode-uad-redteam-api",
    subjectsJson: JSON.stringify(subjects),
  }), /invalid_uad_redteam_oidc_issuer/);
});

test("matrix cannot be redirected outside the fixed red-team service", async () => {
  await assert.rejects(() => runUadRedTeamAuthorizationMatrix({
    baseUrl: "https://homenode-api-staging.onrender.com",
    fetchImpl: matrixFetch(),
    getAccessToken,
  }), /invalid_uad_redteam_api_url/);
  assert.equal(REDTEAM_API_ORIGIN, "https://homenode-api-redteam.onrender.com");
});
