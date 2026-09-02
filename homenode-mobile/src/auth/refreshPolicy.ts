export type AccessTokenRequest = {
  forceRefresh?: boolean;
};

export type RefreshFailure = "terminal" | "temporary";

export function classifyRefreshFailure(
  reason: unknown,
  { confirmedTokenError = false }: { confirmedTokenError?: boolean } = {},
): RefreshFailure {
  const code = reason && typeof reason === "object" && "code" in reason
    ? String(reason.code || "")
    : "";
  return confirmedTokenError && code === "invalid_grant" ? "terminal" : "temporary";
}

export function canReplayAfterAuthenticationFailure(methodValue: string | undefined) {
  const method = String(methodValue || "GET").trim().toUpperCase();
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}
