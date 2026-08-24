import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCOUNT_ID_POLICY_LIMITS,
  isLegacyAccountIdAllowed,
} from "../src/security/accountIdPolicy.js";

test("production legacy routes accept only the established parcel-id shape", () => {
  assert.equal(isLegacyAccountIdAllowed("26272500060150000"), true);
  assert.equal(isLegacyAccountIdAllowed("UAD-REDTEAM-SFR-0001"), false);
  assert.equal(isLegacyAccountIdAllowed("UAD-STAGING-SFR-0001"), false);
  assert.equal(isLegacyAccountIdAllowed("../../etc/passwd"), false);
});

test("red-team routes accept only explicitly namespaced synthetic fixtures", () => {
  const options = { redTeamEnabled: true };
  assert.equal(isLegacyAccountIdAllowed("UAD-REDTEAM-SFR-0001", options), true);
  assert.equal(isLegacyAccountIdAllowed("UAD-REDTEAM-ABC123", options), true);
  assert.equal(isLegacyAccountIdAllowed("uad-redteam-sfr-0001", options), false);
  assert.equal(isLegacyAccountIdAllowed("UAD-STAGING-SFR-0001", options), false);
  assert.equal(isLegacyAccountIdAllowed("UAD-REDTEAM-../../SECRET", options), false);
  assert.equal(
    isLegacyAccountIdAllowed(`UAD-REDTEAM-${"A".repeat(ACCOUNT_ID_POLICY_LIMITS.synthetic_redteam_maximum_length)}`, options),
    false,
  );
});
