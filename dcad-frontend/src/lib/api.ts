// src/lib/api.ts
// Postgres-backed API client (no scraper)

type Json = Record<string, any>;

const BASE =
  ((import.meta as any).env?.VITE_API_URL || (import.meta as any).env?.VITE_API_BASE || '')
    .toString()
    .replace(/\/+$/, ''); // '' means use relative paths (dev proxy)

/** Small helper to build URLs with query params */
export function makeUrl(path: string, params?: Record<string, string | number | boolean | undefined>) {
  const u = new URL((BASE || '') + path, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    }
  }
  // When BASE is absolute, URL() will keep it. When BASE is '', we need the path as-is:
  return BASE ? u.toString() : path + (u.search ? `?${u.searchParams.toString()}` : '');
}

/** Fetch JSON with timeout + nicer errors */
async function fetchJSON<T = any>(input: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init?.timeoutMs ?? 15000);

  try {
    const res = await fetch(input, { ...init, signal: controller.signal });
    const ct = res.headers.get('content-type') || '';
    const isJson = ct.includes('application/json');

    if (!res.ok) {
      const body = isJson ? await res.json().catch(() => ({})) : await res.text().catch(() => '');
      const msg = (body && (body.error || body.message)) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return (isJson ? res.json() : (res.text() as any)) as Promise<T>;
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new Error('Request timed out');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/** ---------------- Types returned by your API ---------------- */

export interface AccountRow {
  account_id: string;
  address: string | null;
  county: string | null;
  neighborhood_code: string | null;
  subdivision: string | null;
  legal_description: string | null;

  latest_tax_year?: number | null;
  latest_market_value?: string | number | null;       // core.market_values.total_value
  latest_improvement_value?: string | number | null;  // core.market_values.imp_value
  latest_land_value?: string | number | null;         // core.market_values.land_value
  latest_capped_value?: string | number | null;       // core.market_values.homestead_cap_value
}

export interface AccountDetail {
  account: AccountRow;
  primary_improvements: {
    construction_type?: string | null;
    percent_complete?: number | null;
    year_built?: number | null;
    effective_year_built?: number | null;
    actual_age?: number | null;
    depreciation?: number | null;
    desirability?: string | null;
    stories?: string | null;
    living_area_sqft?: number | null;
    total_living_area?: number | null;
    bedroom_count?: number | null;
    bath_count?: number | null;
    basement?: boolean | null;
    kitchens?: number | null;
    wetbars?: number | null;
    fireplaces?: number | null;
    sprinkler?: boolean | null;
    spa?: boolean | null;
    pool?: boolean | null;
    sauna?: boolean | null;
    air_conditioning?: string | null;
    heating?: string | null;
    foundation?: string | null;
    roof_material?: string | null;
    roof_type?: string | null;
    exterior_material?: string | null;
    fence_type?: string | null;
    number_units?: number | null;
  } | null;
}

/** ---------------- API calls (DB only; no scraper) ---------------- */

/**
 * Search accounts by address fragment or exact 17-char account_id.
 * Backend route: GET /api/search?q=&limit=&offset=
 */
export async function searchAccounts(q: string, limit = 25, offset = 0): Promise<AccountRow[]> {
  if (!q || !q.trim()) return [];
  const url = makeUrl('/api/search', { q: q.trim(), limit, offset });
  return fetchJSON<AccountRow[]>(url);
}

/** Get a single account (core + latest market values + primary improvements) */
export async function getAccount(accountId: string): Promise<AccountDetail> {
  const id = (accountId || '').trim();
  const url = makeUrl(`/api/accounts/${encodeURIComponent(id)}`);
  return fetchJSON<AccountDetail>(url);
}

/**
 * Compatibility export for components expecting fetchProperty(countyId, accountId).
 * We ignore countyId for now and fetch by account id from /api/accounts/:id.
 */
export async function fetchProperty(countyIdOrAccountId: number | string, maybeAccountId?: string): Promise<AccountDetail> {
  const id =
    typeof countyIdOrAccountId === 'string'
      ? countyIdOrAccountId
      : (maybeAccountId || '').trim();

  if (!id) throw new Error('fetchProperty: accountId is required');
  return getAccount(id);
}

/** Optional: health check to show API connectivity in the UI */
export async function health(): Promise<Json> {
  const url = makeUrl('/health');
  return fetchJSON<Json>(url, { timeoutMs: 5000 });
}

// --- TILE_DISPLAY_HELPERS: display helpers for search tiles (append-only) ---

/** Currency formatter for market values on tiles */
export function formatCurrency(v: string | number | null | undefined) {
  if (v === null || v === undefined || v === '') return '';
  const n = typeof v === 'string' ? Number(String(v).replace(/[^0-9.-]/g, '')) : v;
  if (!isFinite(n)) return String(v);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}

/**
 * Build display fields for a result tile:
 *  - title: Address (primary)
 *  - subtitle: Account ID (and market value if present)
 */
export function toTile(row: AccountRow) {
  const title = (row.address && row.address.trim()) || '(No address)';
  const mv = row.latest_market_value;
  const mvText = formatCurrency(mv);
  const subtitle = mvText ? `${row.account_id} · ${mvText}` : row.account_id;

  return {
    id: row.account_id,
    title,
    subtitle,
    raw: row,
  };
}

