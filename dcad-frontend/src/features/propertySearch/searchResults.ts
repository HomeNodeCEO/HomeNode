export type ApiSearchRow = {
  account_id: string;
  address?: string | null;
  street_name?: string | null;
  city?: string | null;
  postal_code?: string | null;
  search_match?: "exact_account" | "exact_address" | "address_prefix" | "same_street" | "city_prefix" | null;
  owner?: string | null;
  situs_address?: string | null;
  latest_market_value?: number | string | null;
  data_quality_status?: string | null;
  data_quality_flags?: string[] | null;
  canonical_account_id?: string | null;
  requested_account_id?: string | null;
  resolved_from_legacy?: boolean;
};

export type PropertySearchItem = {
  id: string;
  title: string;
  subtitle?: string;
  raw?: ApiSearchRow;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableMarketValue(value: unknown): number | string | null {
  return typeof value === "number" || typeof value === "string" ? value : null;
}

function normalizeSearchMatch(value: unknown): ApiSearchRow["search_match"] {
  switch (value) {
    case "exact_account":
    case "exact_address":
    case "address_prefix":
    case "same_street":
    case "city_prefix":
      return value;
    default:
      return null;
  }
}

function normalizeFlags(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeSearchRow(value: unknown): ApiSearchRow | null {
  if (!isRecord(value)) return null;
  const accountId = nullableString(value.account_id)?.trim();
  if (!accountId) return null;
  return {
    account_id: accountId,
    address: nullableString(value.address),
    street_name: nullableString(value.street_name),
    city: nullableString(value.city),
    postal_code: nullableString(value.postal_code),
    search_match: normalizeSearchMatch(value.search_match),
    owner: nullableString(value.owner),
    situs_address: nullableString(value.situs_address),
    latest_market_value: nullableMarketValue(value.latest_market_value),
    data_quality_status: nullableString(value.data_quality_status),
    data_quality_flags: normalizeFlags(value.data_quality_flags),
    canonical_account_id: nullableString(value.canonical_account_id),
    requested_account_id: nullableString(value.requested_account_id),
    resolved_from_legacy: typeof value.resolved_from_legacy === "boolean"
      ? value.resolved_from_legacy
      : undefined,
  };
}

export function normalizeSearchRows(input: unknown): ApiSearchRow[] {
  let candidates: unknown[] = [];
  if (Array.isArray(input)) {
    candidates = input;
  } else if (isRecord(input)) {
    if (Array.isArray(input.results)) candidates = input.results;
    else if (Array.isArray(input.rows)) candidates = input.rows;
  }
  return candidates.flatMap((candidate) => {
    const row = normalizeSearchRow(candidate);
    return row ? [row] : [];
  });
}

export function propertySearchErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return String(error);
}
