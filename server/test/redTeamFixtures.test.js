import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRedTeamOidcSubjects,
  pruneStaleRedTeamOidcIssuers,
  REDTEAM_ORGANIZATIONS,
  REDTEAM_PERSONAS,
} from "../src/security/redTeamFixtures.js";

test("red-team personas cover both tenants and every negative authorization state", () => {
  assert.equal(Object.keys(REDTEAM_ORGANIZATIONS).length, 2);
  const keys = new Set(REDTEAM_PERSONAS.map((persona) => persona.key));
  for (const required of [
    "assigned_appraiser_a",
    "unassigned_appraiser_a",
    "supervisor_a",
    "reviewer_a",
    "organization_admin_a",
    "appraiser_b",
    "organization_admin_b",
    "homenode_admin",
    "inactive_user",
    "suspended_member",
    "member_without_role",
  ]) assert.ok(keys.has(required), required);
  assert.equal(new Set(REDTEAM_PERSONAS.map((persona) => persona.id)).size, REDTEAM_PERSONAS.length);
  assert.ok(REDTEAM_PERSONAS.some((persona) => !persona.active));
  assert.ok(REDTEAM_PERSONAS.some((persona) => persona.status === "suspended"));
  assert.ok(REDTEAM_PERSONAS.some((persona) => persona.roles.length === 0));
});

test("OIDC subject mapping is exact, complete, and unique", () => {
  const mapping = Object.fromEntries(REDTEAM_PERSONAS.map((persona) => [persona.key, `subject:${persona.key}`]));
  assert.deepEqual(parseRedTeamOidcSubjects(JSON.stringify(mapping)), mapping);
  assert.throws(() => parseRedTeamOidcSubjects("{}"), /redteam_oidc_subject_required/);
  assert.throws(() => parseRedTeamOidcSubjects(JSON.stringify({ ...mapping, unknown: "subject:unknown" })), /unknown_persona/);
  const duplicated = { ...mapping, reviewer_a: mapping.assigned_appraiser_a };
  assert.throws(() => parseRedTeamOidcSubjects(JSON.stringify(duplicated)), /must_be_unique/);
});

test("OIDC issuer reconciliation removes only stale identities for synthetic personas", async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("count(DISTINCT user_id)")) {
        return { rows: [{ count: 11, distinct_users: 11 }] };
      }
      if (sql.includes("DELETE FROM app_auth.oidc_identities")) {
        return { rows: [{ user_id: REDTEAM_PERSONAS[0].id }], rowCount: 1 };
      }
      throw new Error(`unexpected_query:${sql}`);
    },
  };
  const removed = await pruneStaleRedTeamOidcIssuers(
    client,
    "https://uad-redteam-identity.homenode.invalid",
  );
  assert.equal(removed, 1);
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[0].params[0], REDTEAM_PERSONAS.map((persona) => persona.id));
  assert.equal(queries[0].params[1], "https://uad-redteam-identity.homenode.invalid");
  assert.match(queries[1].sql, /issuer <> \$2/);
});

test("OIDC issuer reconciliation fails closed for incomplete or non-red-team identity sets", async () => {
  const client = {
    async query() {
      return { rows: [{ count: 10, distinct_users: 10 }] };
    },
  };
  await assert.rejects(
    pruneStaleRedTeamOidcIssuers(client, "https://uad-redteam-identity.homenode.invalid"),
    /identity_set_incomplete/,
  );
  await assert.rejects(
    pruneStaleRedTeamOidcIssuers(client, "https://login.example.com"),
    /redteam_oidc_issuer_invalid/,
  );
});
