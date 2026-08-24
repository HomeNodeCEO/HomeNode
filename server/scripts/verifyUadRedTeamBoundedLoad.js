import { runUadRedTeamBoundedLoad } from "../src/modules/uad/uadRedTeamBoundedLoad.js";

const result = await runUadRedTeamBoundedLoad({
  baseUrl: process.env.UAD_REDTEAM_BASE_URL,
  timeoutMs: process.env.UAD_REDTEAM_TIMEOUT_MS,
  concurrency: process.env.UAD_REDTEAM_LOAD_CONCURRENCY,
});

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
