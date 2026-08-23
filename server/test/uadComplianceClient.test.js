import assert from "node:assert/strict";
import test from "node:test";

import {
  createUadComplianceRegistry,
  parseUadComplianceResponse,
} from "../src/modules/uad/uadComplianceClient.js";

function response(body, { status = 200, contentType = "application/json", headers = {} } = {}) {
  return new Response(body, { status, headers: { "content-type": contentType, ...headers } });
}

test("compliance registry is disabled and credential-safe by default", () => {
  const registry = createUadComplianceRegistry({});
  assert.equal(registry.enabled, false);
  assert.equal(registry.providers.fannie.configured, false);
  assert.equal(registry.providers.freddie.configured, false);
  assert.throws(() => registry.getClient("fannie"), /uad_compliance_disabled/);
  assert.doesNotMatch(JSON.stringify(registry.providers), /client|secret|url/i);
});

test("compliance endpoints require HTTPS and explicit token authentication style", () => {
  assert.throws(() => createUadComplianceRegistry({
    FANNIE_UAD_COMPLIANCE_BASE_URL: "http://example.com/submit",
  }), /uad_compliance_https_url_required/);
  const registry = createUadComplianceRegistry({
    UAD_COMPLIANCE_API_ENABLED: "true",
    FANNIE_UAD_COMPLIANCE_ENABLED: "true",
    FANNIE_UAD_COMPLIANCE_ENVIRONMENT: "acpt",
    FANNIE_UAD_COMPLIANCE_BASE_URL: "https://api.example.test/uad",
    FANNIE_UAD_COMPLIANCE_TOKEN_URL: "https://identity.example.test/token",
    FANNIE_UAD_COMPLIANCE_CLIENT_ID: "id",
    FANNIE_UAD_COMPLIANCE_CLIENT_SECRET: "secret",
  });
  assert.equal(registry.providers.fannie.configured, false);
  assert.throws(() => registry.getClient("fannie"), /uad_compliance_fannie_not_configured/);
});

test("client-credentials token and XML submission never expose credentials in results", async () => {
  const calls = [];
  const registry = createUadComplianceRegistry({
    UAD_COMPLIANCE_API_ENABLED: "true",
    UAD_COMPLIANCE_API_TIMEOUT_MS: "5000",
    FANNIE_UAD_COMPLIANCE_ENABLED: "true",
    FANNIE_UAD_COMPLIANCE_ENVIRONMENT: "acpt",
    FANNIE_UAD_COMPLIANCE_BASE_URL: "https://api.example.test/uad",
    FANNIE_UAD_COMPLIANCE_TOKEN_URL: "https://identity.example.test/token",
    FANNIE_UAD_COMPLIANCE_CLIENT_ID: "client-id",
    FANNIE_UAD_COMPLIANCE_CLIENT_SECRET: "client-secret",
    FANNIE_UAD_COMPLIANCE_SCOPE: "uad.validate",
    FANNIE_UAD_COMPLIANCE_TOKEN_AUTH_STYLE: "basic",
    FANNIE_UAD_COMPLIANCE_ALLOWED_HOSTS: "api.example.test,identity.example.test",
  }, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (String(url).includes("identity")) return response(JSON.stringify({ access_token: "temporary-token" }));
      return response(JSON.stringify({ findings: [] }), {
        headers: { "x-correlation-id": "provider-correlation" },
      });
    },
  });
  const result = await registry.getClient("fannie").submitXml("<MESSAGE/>", { correlationId: "local-correlation" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.redirect, "error");
  assert.match(calls[0].init.headers.authorization, /^Basic /);
  assert.equal(String(calls[0].init.body).includes("client-secret"), false);
  assert.equal(calls[1].init.headers.authorization, "Bearer temporary-token");
  assert.equal(calls[1].init.headers["content-type"], "application/xml");
  assert.equal(calls[1].init.body, "<MESSAGE/>");
  assert.equal(result.provider_correlation_id, "provider-correlation");
  assert.doesNotMatch(JSON.stringify(result), /client-secret|temporary-token/);
});

test("requires assigned-host pinning and production verification evidence", () => {
  const unpinned = createUadComplianceRegistry({
    UAD_COMPLIANCE_API_ENABLED: "true",
    FANNIE_UAD_COMPLIANCE_ENABLED: "true",
    FANNIE_UAD_COMPLIANCE_ENVIRONMENT: "acpt",
    FANNIE_UAD_COMPLIANCE_BASE_URL: "https://api.example.test/uad",
    FANNIE_UAD_COMPLIANCE_TOKEN_URL: "https://identity.example.test/token",
    FANNIE_UAD_COMPLIANCE_CLIENT_ID: "id",
    FANNIE_UAD_COMPLIANCE_CLIENT_SECRET: "secret",
    FANNIE_UAD_COMPLIANCE_TOKEN_AUTH_STYLE: "basic",
  });
  assert.equal(unpinned.providers.fannie.configured, false);
  assert.ok(unpinned.providers.fannie.blockers.includes("allowed_hosts_missing"));
  assert.ok(unpinned.providers.fannie.blockers.includes("submission_host_not_allowed"));

  const production = createUadComplianceRegistry({
    UAD_COMPLIANCE_API_ENABLED: "true",
    FANNIE_UAD_COMPLIANCE_ENABLED: "true",
    FANNIE_UAD_COMPLIANCE_ENVIRONMENT: "production",
    FANNIE_UAD_COMPLIANCE_BASE_URL: "https://api.example.test/uad",
    FANNIE_UAD_COMPLIANCE_TOKEN_URL: "https://identity.example.test/token",
    FANNIE_UAD_COMPLIANCE_CLIENT_ID: "id",
    FANNIE_UAD_COMPLIANCE_CLIENT_SECRET: "secret",
    FANNIE_UAD_COMPLIANCE_TOKEN_AUTH_STYLE: "basic",
    FANNIE_UAD_COMPLIANCE_ALLOWED_HOSTS: "api.example.test,identity.example.test",
  });
  assert.equal(production.providers.fannie.configured, false);
  assert.deepEqual(production.providers.fannie.blockers, ["production_verification_evidence_missing"]);

  const verified = createUadComplianceRegistry({
    UAD_COMPLIANCE_API_ENABLED: "true",
    FANNIE_UAD_COMPLIANCE_ENABLED: "true",
    FANNIE_UAD_COMPLIANCE_ENVIRONMENT: "production",
    FANNIE_UAD_COMPLIANCE_BASE_URL: "https://api.example.test/uad",
    FANNIE_UAD_COMPLIANCE_TOKEN_URL: "https://identity.example.test/token",
    FANNIE_UAD_COMPLIANCE_CLIENT_ID: "id",
    FANNIE_UAD_COMPLIANCE_CLIENT_SECRET: "secret",
    FANNIE_UAD_COMPLIANCE_TOKEN_AUTH_STYLE: "basic",
    FANNIE_UAD_COMPLIANCE_ALLOWED_HOSTS: "api.example.test,identity.example.test",
    FANNIE_UAD_COMPLIANCE_VERIFICATION_EVIDENCE_SHA256: "a".repeat(64),
  });
  assert.equal(verified.providers.fannie.configured, true);
  assert.deepEqual(verified.providers.fannie.blockers, []);
  assert.doesNotMatch(JSON.stringify(verified.providers), /secret|api\.example|identity\.example/i);
});

test("normalizes bounded JSON and XML compliance findings", () => {
  const json = parseUadComplianceResponse({
    content_type: "application/json",
    body: JSON.stringify({ findings: [{ ruleId: "UAD0001", severity: "Fatal", message: "Required value missing", uadUid: "0100.0001" }] }),
  });
  assert.deepEqual(json, [{
    rule_id: "UAD0001",
    severity: "fatal",
    message: "Required value missing",
    uad_uid: "0100.0001",
    report_field_id: null,
  }]);

  const xml = parseUadComplianceResponse({
    content_type: "application/xml",
    body: "<RESPONSE><FINDING><RuleIdentifier>UAD1008</RuleIdentifier><SeverityType>Warning</SeverityType><MessageText>Review value</MessageText><ReportFieldIdentifier>3.001</ReportFieldIdentifier></FINDING></RESPONSE>",
  });
  assert.deepEqual(xml, [{
    rule_id: "UAD1008",
    severity: "warning",
    message: "Review value",
    uad_uid: null,
    report_field_id: "3.001",
  }]);
  assert.throws(() => parseUadComplianceResponse({
    content_type: "text/plain",
    body: "OK",
  }), /uad_compliance_response_invalid/);
});
