const DEFAULT_MAX_LIMIT = 100;
const DEFAULT_MAX_OFFSET = 10_000;

export class PaginationError extends Error {
  constructor(code) {
    super(code);
    this.name = "PaginationError";
  }
}

function readInteger(raw, fallback, errorCode) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "string" && typeof raw !== "number") throw new PaginationError(errorCode);
  const text = String(raw).trim();
  if (!/^[0-9]+$/.test(text)) throw new PaginationError(errorCode);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new PaginationError(errorCode);
  return value;
}

/** Parse public limit/offset pairs before constructing a database query. */
export function parsePagination(query, {
  defaultLimit,
  maxLimit = DEFAULT_MAX_LIMIT,
  maxOffset = DEFAULT_MAX_OFFSET,
} = {}) {
  if (
    !Number.isSafeInteger(defaultLimit) || defaultLimit < 1
    || !Number.isSafeInteger(maxLimit) || maxLimit < defaultLimit
    || !Number.isSafeInteger(maxOffset) || maxOffset < 0
  ) throw new TypeError("pagination_config_invalid");
  let requestedLimit;
  let requestedOffset;
  try { requestedLimit = query?.limit; }
  catch { throw new PaginationError("invalid_limit"); }
  try { requestedOffset = query?.offset; }
  catch { throw new PaginationError("invalid_offset"); }

  const limit = readInteger(requestedLimit, defaultLimit, "invalid_limit");
  const offset = readInteger(requestedOffset, 0, "invalid_offset");
  if (limit < 1) throw new PaginationError("invalid_limit");
  if (offset > maxOffset) throw new PaginationError("invalid_offset");
  return { limit: Math.min(limit, maxLimit), offset };
}
