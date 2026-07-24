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
  const timeout = setTimeout(() => controller.abort(), init?.timeoutMs ?? 25000);

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
  street_name?: string | null;
  city?: string | null;
  postal_code?: string | null;
  search_match?: 'exact_account' | 'exact_address' | 'address_prefix' | 'same_street' | null;
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
  housing_profile: HousingProfile | null;
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

export interface MarketValueHistoryRow {
  tax_year: number;
  market_value?: number | string | null;
  total_value?: number | string | null;
}

export interface SaleParcelLink {
  source_position: number;
  parcel_sequence: number;
  parcel_role: 'primary' | 'additional';
  parcel_number_raw: string;
  parcel_number_normalized?: string | null;
  account_id?: string | null;
  match_method: string;
  is_resolved: boolean;
}

export interface SaleRow {
  sale_id: string | number | null;
  source_record_id: string | number | null;
  primary_account_id: string | null;
  county: string | null;
  neighborhood_code: string | null;
  subdivision: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  closing_date: string | null;
  sale_price: string | number | null;
  days_on_market: number | null;
  concessions: string | null;
  seller_contributions: string | number | null;
  listing_contract_date: string | null;
  buyer_financing: string | null;
  mls_status: string | null;
  record_type: 'closed_sale' | 'listing';
  structural_style: string | null;
  housing_type: string | null;
  attachment_type: 'detached' | 'attached' | 'mixed' | 'unknown';
  architectural_style: string | null;
  source: string | null;
  source_filename: string | null;
  source_row_number: number | null;
  match_status: 'exact' | 'normalized' | 'secondary' | 'multiple' | 'unmatched';
  has_multiple_parcel_numbers: boolean;
  multi_parcel_status: 'single' | 'possible' | 'confirmed';
  has_unresolved_parcel: boolean;
  requires_additional_review: boolean;
  data_quality_flags: string[];
  provided_parcel_fields: number;
  resolved_account_count: number;
  linked_parcels: SaleParcelLink[];
  mls_bedrooms_total: number | null;
  mls_bathrooms_total_integer: number | null;
  mls_bathrooms_full: number | null;
  mls_bathrooms_half: number | null;
  mls_living_area: string | number | null;
  mls_lot_size_area: string | number | null;
  mls_year_built: number | null;
  mls_garage_spaces: string | number | null;
  mls_garage_yn: boolean | null;
  mls_pool_yn: boolean | null;
  ratio_current_price_by_living_area: string | number | null;
  ratio_close_price_by_list_price: string | number | null;
  ratio_close_price_by_original_list_price: string | number | null;
  ratio_close_price_by_living_area: string | number | null;
  cad_bedroom_count: number | null;
  cad_bath_count: string | number | null;
  cad_baths_full: number | null;
  cad_baths_half: number | null;
  cad_living_area_sqft: number | null;
  cad_total_area_sqft: number | null;
  cad_year_built: number | null;
  cad_effective_year_built: number | null;
  cad_stories: string | null;
  cad_pool: boolean | null;
  cad_building_class: string | null;
  cad_land_value: string | number | null;
  cad_improvement_value: string | number | null;
  cad_market_value: string | number | null;
  latitude?: string | number | null;
  longitude?: string | number | null;
  location_status?: 'matched' | 'not_found' | 'invalid' | null;
  location_source?: string | null;
  location_precision?: string | null;
  location_confidence?: 'high' | 'medium' | 'low' | null;
  location_review_required?: boolean;
  location_review_reason?: string | null;
  location_geocoded_at?: string | null;
  comparable_square_feet?: number | null;
  comparableScore?: number;
  distanceMiles?: number;
  locationScore?: number;
  squareFootageScore?: number;
  squareFootageDifference?: number;
  squareFootageDifferenceRatio?: number;
  squareFootageDifferencePercent?: number;
  score_rank?: number;
  score_requires_review?: boolean;
  saleAgeDays?: number | null;
  soldWithinOneYear?: boolean;
  soldOverTwoYears?: boolean;
  recommended?: boolean;
  recommendationRank?: number | null;
  recommendationExclusionReason?: string | null;
}

export interface HousingProfile {
  structural_style?: string | null;
  housing_type?: string | null;
  attachment_type?: 'detached' | 'attached' | 'mixed' | 'unknown' | null;
  architectural_style?: string | null;
  mls_status?: string | null;
  source_name?: string | null;
  source_url?: string | null;
  source_record_reference?: string | null;
  observed_at?: string | null;
  confidence?: string | number | null;
  profile_source?: 'verified_override' | 'mls_source_record' | string | null;
}

export interface HousingProfileUpdate {
  housing_type: string;
  attachment_type: 'detached' | 'attached' | 'mixed' | 'unknown';
  architectural_style?: string | null;
  source_url?: string | null;
  notes?: string | null;
  source_record_reference?: string | null;
}

export interface SalesSearchParams {
  q?: string;
  accountId?: string;
  excludeAccountId?: string;
  neighborhoodCode?: string;
  dateFrom?: string;
  dateTo?: string;
  minPrice?: number;
  maxPrice?: number;
  matched?: boolean;
  review?: boolean;
  multiParcel?: 'single' | 'possible' | 'confirmed';
  recordType?: 'closed_sale' | 'listing' | 'all';
  includeAttached?: boolean;
  limit?: number;
  offset?: number;
}

export interface ComparableRecommendationParams {
  subjectAccountId: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  locationWeight?: number;
  squareFootageWeight?: number;
  locationScaleMiles?: number;
  squareFootageScaleRatio?: number;
}

export interface ComparableRecommendationsResponse {
  subject: {
    account_id: string;
    address: string | null;
    city: string | null;
    county: string | null;
    neighborhood_code: string | null;
    living_area_sqft: number;
    latitude: number;
    longitude: number;
    location_source: string;
    location_precision: string;
    location_confidence: 'high' | 'medium' | 'low';
    location_review_required: boolean;
    location_review_reason: string | null;
    location_geocoded_at: string | null;
  };
  scoring: {
    locationWeight: number;
    squareFootageWeight: number;
    locationScaleMiles: number;
    squareFootageScaleRatio: number;
    locationWeightPercent: number;
    squareFootageWeightPercent: number;
    squareFootageScalePercent: number;
    squareFootageIsHardFilter: false;
  };
  coverage: {
    candidate_count: number;
    eligible_count: number;
    missing_location_count: number;
    unsupported_county_count: number;
    missing_square_footage_count: number;
    recommended_count: number;
    older_than_two_years_count: number;
    recent_high_score_count: number;
  };
  recommendation_policy: {
    count: number;
    recentYears: number;
    olderThanYears: number;
    highScoreThreshold: number;
    referenceDate: string | null;
    recentHighScoreCount: number;
    scoreAboveThresholdCount: number;
    olderSaleExclusionApplied: boolean;
  };
  recommended_sales: SaleRow[];
  sales: SaleRow[];
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

/** Save a source-attributed manual housing classification for an account. */
export async function updateAccountHousingProfile(
  accountId: string,
  update: HousingProfileUpdate,
  editorKey: string,
): Promise<{ ok: true; housing_profile: HousingProfile }> {
  const id = (accountId || '').trim();
  const url = makeUrl(`/api/accounts/${encodeURIComponent(id)}/housing-profile`);
  return fetchJSON<{ ok: true; housing_profile: HousingProfile }>(url, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-homenode-editor-key': editorKey,
    },
    body: JSON.stringify(update),
  });
}

/** Market value history for an account */
export async function getMarketValueHistory(accountId: string): Promise<MarketValueHistoryRow[]> {
  const id = (accountId || '').trim();
  const url = makeUrl(`/api/accounts/${encodeURIComponent(id)}/market_value_history`);
  return fetchJSON<MarketValueHistoryRow[]>(url);
}

/** Search transaction-level sales without expanding one price per linked parcel. */
export async function searchSales(params: SalesSearchParams = {}): Promise<SaleRow[]> {
  const url = makeUrl('/api/sales', {
    q: params.q?.trim(),
    account_id: params.accountId?.trim(),
    exclude_account_id: params.excludeAccountId?.trim(),
    neighborhood_code: params.neighborhoodCode?.trim(),
    date_from: params.dateFrom,
    date_to: params.dateTo,
    min_price: params.minPrice,
    max_price: params.maxPrice,
    matched: params.matched,
    review: params.review,
    multi_parcel: params.multiParcel,
    record_type: params.recordType,
    include_attached: params.includeAttached,
    limit: params.limit ?? 25,
    offset: params.offset ?? 0,
  });
  return fetchJSON<SaleRow[]>(url);
}

/** Rank matched sales by DCAD parcel proximity and continuous living-area similarity. */
export async function getComparableRecommendations(
  params: ComparableRecommendationParams,
): Promise<ComparableRecommendationsResponse> {
  const url = makeUrl('/api/sales/recommendations', {
    subject_account_id: params.subjectAccountId.trim(),
    date_from: params.dateFrom,
    date_to: params.dateTo,
    limit: params.limit ?? 25,
    location_weight: params.locationWeight,
    square_footage_weight: params.squareFootageWeight,
    location_scale_miles: params.locationScaleMiles,
    square_footage_scale_ratio: params.squareFootageScaleRatio,
  });
  return fetchJSON<ComparableRecommendationsResponse>(url, { timeoutMs: 90000 });
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

/** ---------------- Compatibility exports for existing components ---------------- */

// Some components import types/functions with older names. Provide thin aliases to avoid
// touching many files while we iterate.

// Older code imports `PropertyDetail` — map it to the current `AccountDetail` shape.
export type PropertyDetail = AccountDetail;

// Older code imports `fetchPropertyDetail` — reuse the existing fetchProperty/getAccount logic.
export async function fetchPropertyDetail(accountId: string): Promise<PropertyDetail> {
  return getAccount(accountId);
}

// Search compatibility
export type SearchItem = {
  id: string;
  title: string;
  subtitle?: string;
  raw: AccountRow;
};

// Older code expects `apiSearch` and `toSearchItems` from '@/lib/api'
export async function apiSearch(q: string, limit = 25, offset = 0): Promise<AccountRow[]> {
  return searchAccounts(q, limit, offset);
}

export function toSearchItems(rows: AccountRow[]): SearchItem[] {
  return rows.map(toTile);
}

