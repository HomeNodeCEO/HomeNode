import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRedTeamOidcSubjects,
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
