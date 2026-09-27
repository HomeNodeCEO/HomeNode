const trustedDetails = new WeakMap();

// Only UAD domain validation code should mark details as safe for API responses.
// An exception from a provider or storage adapter cannot gain this marker by
// attaching its own `details` property.
export function attachUadPublicErrorDetails(error, details) {
  error.details = details;
  trustedDetails.set(error, details);
  return error;
}

export function publicUadErrorDetails(error) {
  if (!error || typeof error !== "object") return null;
  return trustedDetails.get(error) ?? null;
}
