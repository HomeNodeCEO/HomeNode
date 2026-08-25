import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";

import { createRedTeamAccessTokenFactory } from "../src/modules/uad/uadRedTeamAuthorization.js";
import { runUadRedTeamArtifactResilience } from "../src/modules/uad/uadRedTeamArtifactResilience.js";

const outputDirectory = path.resolve(
  process.env.UAD_REDTEAM_ARTIFACT_RESILIENCE_OUTPUT_DIRECTORY
    || "uad-redteam-artifact-resilience",
);
const getAccessToken = createRedTeamAccessTokenFactory({
  privateKeyPem: process.env.UAD_REDTEAM_JWT_PRIVATE_KEY,
  keyId: process.env.UAD_REDTEAM_JWT_KEY_ID,
  issuer: process.env.UAD_REDTEAM_OIDC_ISSUER,
  audience: process.env.UAD_REDTEAM_OIDC_AUDIENCE,
  subjectsJson: process.env.UAD_REDTEAM_OIDC_SUBJECTS_JSON,
  unprovisionedSubject: process.env.UAD_REDTEAM_UNPROVISIONED_SUBJECT,
});
const result = await runUadRedTeamArtifactResilience({
  baseUrl: process.env.UAD_REDTEAM_BASE_URL,
  fixtureAccountId: process.env.UAD_REDTEAM_FIXTURE_ACCOUNT_ID,
  getAccessToken,
});
await fs.mkdir(outputDirectory, { recursive: true });
await fs.writeFile(
  path.join(outputDirectory, "evidence.json"),
  `${JSON.stringify(result, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
