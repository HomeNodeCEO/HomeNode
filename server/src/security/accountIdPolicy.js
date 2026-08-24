const LEGACY_DALLAS_ACCOUNT_ID = /^[0-9A-Za-z]{17}$/;
const SYNTHETIC_REDTEAM_ACCOUNT_ID = /^UAD-REDTEAM-[A-Z0-9-]+$/;

/**
 * Preserve the production parcel-id contract while allowing explicitly
 * namespaced synthetic fixtures to exercise legacy routes in the isolated
 * red-team deployment.
 */
export function isLegacyAccountIdAllowed(value, { redTeamEnabled = false } = {}) {
  const normalized = String(value || "").trim();
  if (LEGACY_DALLAS_ACCOUNT_ID.test(normalized)) return true;
  return Boolean(redTeamEnabled)
    && normalized.length <= 64
    && SYNTHETIC_REDTEAM_ACCOUNT_ID.test(normalized);
}

export const ACCOUNT_ID_POLICY_LIMITS = Object.freeze({
  legacy_length: 17,
  synthetic_redteam_maximum_length: 64,
});
