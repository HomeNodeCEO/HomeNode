import { runUadRedTeamBaseline } from "../src/modules/uad/uadRedTeamBaseline.js";

const result = await runUadRedTeamBaseline({
  baseUrl: process.env.UAD_REDTEAM_BASE_URL,
  appUrl: process.env.UAD_REDTEAM_APP_URL,
  fixtureAccountId: process.env.UAD_REDTEAM_FIXTURE_ACCOUNT_ID,
  timeoutMs: process.env.UAD_REDTEAM_TIMEOUT_MS,
});

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
