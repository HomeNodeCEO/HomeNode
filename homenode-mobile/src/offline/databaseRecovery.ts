function errorText(reason: unknown, seen = new Set<unknown>()): string {
  if (reason == null || seen.has(reason)) return "";
  seen.add(reason);
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) {
    return [reason.name, reason.message, errorText(reason.cause, seen)].filter(Boolean).join(" ");
  }
  if (typeof reason === "object") {
    const candidate = reason as { code?: unknown; message?: unknown; cause?: unknown };
    return [candidate.code, candidate.message, errorText(candidate.cause, seen)]
      .filter((value) => typeof value === "string" || typeof value === "number")
      .join(" ");
  }
  return String(reason);
}

export function isUnreadableSqliteDatabaseError(reason: unknown) {
  const text = errorText(reason);
  return /file is not a database|error code\s*26|sqlite_notadb|sqliteerror.*\b26\b/i.test(text);
}
