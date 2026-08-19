import "dotenv/config";

import { createOidcAccessTokenVerifier } from "../src/modules/mobile/auth.js";
import { environmentFlag } from "../src/util/requestPerformance.js";

const mobileEnabled = environmentFlag(process.env.MOBILE_INSPECTION_ENABLED);
const verifier = createOidcAccessTokenVerifier({
  issuer: process.env.OIDC_ISSUER,
  audience: process.env.OIDC_AUDIENCE,
  jwksUri: process.env.OIDC_JWKS_URI,
  clockToleranceSeconds: process.env.OIDC_CLOCK_TOLERANCE_SECONDS,
});

if (!mobileEnabled) {
  console.log(JSON.stringify({ checked: false, configured: verifier.configured, reason: "mobile_inspection_disabled" }));
  process.exit(0);
}

if (!verifier.configured) {
  throw new Error("mobile OIDC must be configured before mobile inspection is enabled");
}

const status = await verifier.preflight();
console.log(JSON.stringify({
  checked: true,
  configured: status.configured,
  issuer: status.issuer,
  audience: status.audience,
  jwks_uri: status.jwksUri,
  signing_algorithm: status.signingAlgorithm,
  supported_key_count: status.supportedKeyCount,
}));
