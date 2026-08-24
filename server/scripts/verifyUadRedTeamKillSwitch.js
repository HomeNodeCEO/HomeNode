import { runUadRedTeamKillSwitchCheck } from "../src/modules/uad/uadRedTeamKillSwitch.js";

const result = await runUadRedTeamKillSwitchCheck({
  baseUrl: process.env.UAD_REDTEAM_BASE_URL,
  timeoutMs: process.env.UAD_REDTEAM_TIMEOUT_MS,
});

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
