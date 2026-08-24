import {
  createRedTeamAccessTokenFactory,
} from "../src/modules/uad/uadRedTeamAuthorization.js";
import { runUadRedTeamEndpointFuzz } from "../src/modules/uad/uadRedTeamEndpointFuzz.js";

const getAccessToken = createRedTeamAccessTokenFactory({
  privateKeyPem: process.env.UAD_REDTEAM_JWT_PRIVATE_KEY,
  keyId: process.env.UAD_REDTEAM_JWT_KEY_ID,
  issuer: process.env.UAD_REDTEAM_OIDC_ISSUER,
  audience: process.env.UAD_REDTEAM_OIDC_AUDIENCE,
  subjectsJson: process.env.UAD_REDTEAM_OIDC_SUBJECTS_JSON,
  unprovisionedSubject: process.env.UAD_REDTEAM_UNPROVISIONED_SUBJECT,
});

const result = await runUadRedTeamEndpointFuzz({
  baseUrl: process.env.UAD_REDTEAM_BASE_URL,
  fixtureAccountId: process.env.UAD_REDTEAM_FIXTURE_ACCOUNT_ID,
  timeoutMs: process.env.UAD_REDTEAM_TIMEOUT_MS,
  getAccessToken,
});

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
