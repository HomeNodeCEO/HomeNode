import { runUadStagingSmoke } from "../src/modules/uad/uadStagingSmoke.js";

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((item) => item.startsWith(prefix))?.slice(prefix.length) || null;
}

const baseUrl = option("base-url") || process.env.UAD_STAGING_BASE_URL;
if (!baseUrl) throw new Error("UAD_STAGING_BASE_URL or --base-url is required");

const result = await runUadStagingSmoke({
  baseUrl,
  appUrl: option("app-url") || process.env.UAD_STAGING_APP_URL,
  fixtureAccountId: option("fixture-account") || process.env.UAD_STAGING_FIXTURE_ACCOUNT_ID,
  timeoutMs: option("timeout-ms") || process.env.UAD_STAGING_TIMEOUT_MS,
  requireCompliance: /^(1|true|yes|on)$/i.test(String(process.env.UAD_STAGING_REQUIRE_COMPLIANCE || "")),
});

const evidence = {
  ok: result.ok === true,
  checked_at: result.checked_at,
  checks: {
    health: result.checks.health,
    capabilities: result.checks.capabilities,
    operational_readiness: result.checks.operational_readiness,
    synthetic_fixture: {
      ready: result.checks.synthetic_fixture.ready,
      http_status: result.checks.synthetic_fixture.http_status,
      workfile_count: result.checks.synthetic_fixture.workfile_count,
      error_code: result.checks.synthetic_fixture.error_code,
    },
    web_app: result.checks.web_app,
    external_compliance: result.checks.external_compliance,
  },
};
console.log(JSON.stringify(evidence, null, 2));
if (!result.ok) process.exitCode = 1;
