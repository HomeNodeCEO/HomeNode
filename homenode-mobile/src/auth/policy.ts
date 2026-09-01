function errorText(reason: unknown, depth = 0): string {
  if (depth > 3 || reason == null) return "";
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) {
    return `${reason.name} ${reason.message} ${errorText(reason.cause, depth + 1)}`;
  }
  if (typeof reason !== "object") return String(reason);
  const value = reason as Record<string, unknown>;
  return ["error", "code", "message", "description", "error_description", "params", "data", "body", "cause"]
    .map((key) => errorText(value[key], depth + 1))
    .join(" ");
}

export function isDefinitiveRefreshFailure(reason: unknown) {
  const normalized = errorText(reason).toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return [
    "invalid_grant",
    "refresh_token_expired",
    "refresh_token_revoked",
    "revoked_refresh_token",
  ].some((code) => normalized.includes(code));
}
