import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const entrypoint = path.resolve(directory, "../src/oldServer.js");
const inheritedEnvironment = { ...process.env };
delete inheritedEnvironment.APPLICATION_AUTHENTICATION_REQUIRED;
delete inheritedEnvironment.LEGACY_AUTH_ROLLOUT_UNTIL;
delete inheritedEnvironment.OIDC_ISSUER;
delete inheritedEnvironment.OIDC_AUDIENCE;
delete inheritedEnvironment.OIDC_CLIENT_ID;
delete inheritedEnvironment.OIDC_JWKS_URI;
delete inheritedEnvironment.OIDC_WEB_ISSUER;
delete inheritedEnvironment.OIDC_WEB_CLIENT_ID;
delete inheritedEnvironment.OIDC_WEB_CLIENT_SECRET;
delete inheritedEnvironment.OIDC_WEB_REDIRECT_URI;
delete inheritedEnvironment.OIDC_WEB_JWKS_URI;
delete inheritedEnvironment.WEB_APP_URL;
delete inheritedEnvironment.WEB_SESSION_CROSS_SITE;
delete inheritedEnvironment.CORS_ORIGIN;
delete inheritedEnvironment.APP_SESSION_SECRET;
delete inheritedEnvironment.APP_SIGNING_SECRET;

function startWith(environment = {}) {
  return spawnSync(process.execPath, [entrypoint], {
    cwd: path.resolve(directory, ".."),
    encoding: "utf8",
    env: {
      ...inheritedEnvironment,
      NODE_ENV: "production",
      ...environment,
    },
    timeout: 15_000,
  });
}

test("the real server entrypoint fails before startup when the production setting is absent", () => {
  const result = startWith({ APP_SESSION_SECRET: "do-not-print-this-value" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /application_authentication_setting_required/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /do-not-print-this-value/);
});

test("the real server entrypoint rejects a malformed production setting", () => {
  const result = startWith({ APPLICATION_AUTHENTICATION_REQUIRED: "flase" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /application_authentication_setting_invalid/);
});

test("the real server entrypoint rejects indefinite production rollout mode", () => {
  const result = startWith({ APPLICATION_AUTHENTICATION_REQUIRED: "false" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /legacy_auth_rollout_until_required/);
});

test("the real server entrypoint rejects expired production rollout mode", () => {
  const result = startWith({
    APPLICATION_AUTHENTICATION_REQUIRED: "false",
    LEGACY_AUTH_ROLLOUT_UNTIL: "2000-01-01",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /legacy_auth_rollout_expired/);
});

test("the real server entrypoint preserves enforced-mode configuration failure", () => {
  const result = startWith({ APPLICATION_AUTHENTICATION_REQUIRED: "true" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /application_authentication_required_but_not_configured/);
});
