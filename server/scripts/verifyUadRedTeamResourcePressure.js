import { runUadRedTeamResourcePressure } from "../src/modules/uad/uadRedTeamResourcePressure.js";

const result = await runUadRedTeamResourcePressure({
  baseUrl: process.env.UAD_REDTEAM_BASE_URL,
  fixtureAccountId: process.env.UAD_REDTEAM_FIXTURE_ACCOUNT_ID,
  timeoutMs: process.env.UAD_REDTEAM_TIMEOUT_MS,
  concurrency: process.env.UAD_REDTEAM_PRESSURE_CONCURRENCY,
  mixedRequests: process.env.UAD_REDTEAM_PRESSURE_REQUESTS,
});
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
