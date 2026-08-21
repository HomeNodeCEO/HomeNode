import { runUadArtifactSecurityChecks } from "../src/modules/uad/uadArtifactSecurity.js";

const result = await runUadArtifactSecurityChecks();
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
