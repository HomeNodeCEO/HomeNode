const trustedReadinessDetails = new WeakMap();

// Only the signing service may mark E&O details as safe to return to the
// authenticated appraiser. A storage/provider exception with the same message
// must not gain access to this response shape by attaching its own properties.
export function attachCustomAppraisalReadinessErrorDetails(error, details) {
  trustedReadinessDetails.set(error, details);
  return error;
}

export function customAppraisalReadinessErrorDetails(error) {
  if (!error || typeof error !== "object") return null;
  return trustedReadinessDetails.get(error) ?? null;
}
