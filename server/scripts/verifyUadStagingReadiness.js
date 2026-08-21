import "dotenv/config";

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

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
