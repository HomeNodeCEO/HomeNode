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
  state?: string | null;
  postal_code?: string | null;
  search_match?: 'exact_account' | 'exact_address' | 'address_prefix' | 'same_street' | 'city_prefix' | null;
  county: string | null;
  neighborhood_code: string | null;
  subdivision: string | null;
  legal_description: string | null;
  data_quality_status?: string | null;
  data_quality_flags?: string[] | null;
  canonical_account_id?: string | null;
  requested_account_id?: string | null;
  resolved_from_legacy?: boolean;

  latest_tax_year?: number | null;
  latest_market_value?: string | number | null;       // core.market_values.total_value
  latest_improvement_value?: string | number | null;  // core.market_values.imp_value
  latest_land_value?: string | number | null;         // core.market_values.land_value
  latest_capped_value?: string | number | null;       // core.market_values.homestead_cap_value
}

export interface AccountDetail {
  account: AccountRow;
  owner_summary?: {
    owner_name: string | null;
    mailing_address: string | null;
    tax_year: number | null;
  } | null;
  owner_parties?: Array<{
    owner_name: string | null;
    ownership_pct: string | number | null;
    tax_year: number | null;
  }>;
  report_manual_values?: Partial<Record<ReportManualSectionKey, ReportManualValue>>;
  sales_history?: Array<{
    sale_id: string | number | null;
    source_record_id: string | number | null;
    listing_id: string | null;
    closing_date: string | null;
    sale_price: string | number | null;
    days_on_market: number | null;
    buyer_financing: string | null;
    mls_status: string | null;
    record_type: 'closed_sale';
  }>;
  property_activity_history?: PropertyActivityHistoryRow[];
  census_geography?: {
    tract_geoid: string | null;
    tract_code: string | null;
    state_fips: string | null;
    county_fips: string | null;
    block_code: string | null;
    benchmark: string;
    vintage: string;
    status: 'pending' | 'processing' | 'retry' | 'matched' | 'review_required' | 'failed';
    response_status: string | null;
    review_reason: string | null;
    source_method: 'coordinate' | 'address';
    looked_up_at: string | null;
  } | null;
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

export type ReportManualSectionKey =
  | 'report.subject_identification'
  | 'report.exemptions'
  | 'report.sales_history'
  | 'report.property_characteristics'
  | 'report.land_details'
  | 'report.appraisal_values'
  | 'report.assignment_details';

export interface ReportManualValue {
  value: unknown;
  revision: number;
  reviewer: string | null;
  notes: string | null;
  updated_at: string;
}

export interface AssignmentDetailsPayload {
  pud?: boolean;
  hoa_dues_amount?: string | number;
  hoa_frequency?: string;
  hoa_explanation?: string;
  occupancy?: string;
  occupancy_explanation?: string;
  assignment_types?: string[];
  assignment_explanation?: string;
  lender_client_name?: string;
  lender_client_address?: string;
}

export interface PropertyActivityHistoryRow {
  sale_id: string | number | null;
  source_record_id: string | number | null;
  listing_key: string | null;
  listing_id: string | null;
  source: string | null;
  record_type: 'listing' | 'contract' | 'closed_sale' | 'cad_transfer';
  activity_date: string | null;
  listing_date: string | null;
  contract_date: string | null;
  closing_date: string | null;
  list_price: string | number | null;
  sale_price: string | number | null;
  days_on_market: number | null;
  buyer_financing: string | null;
  concessions: string | number | null;
  mls_status: string | null;
  requires_additional_review: boolean;
  data_quality_flags: string[] | null;
}

export interface AppraisalAssignmentFile {
  id: number;
  account_id: string;
  file_number: string;
  assignment_details: AssignmentDetailsPayload;
  inherited_from_file_id: number | null;
  inherited_from_file_number: string | null;
  reviewer: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface AssignmentFilesResponse {
  account_id: string;
  files: AppraisalAssignmentFile[];
  latest_file: AppraisalAssignmentFile | null;
  legacy_assignment_details: AssignmentDetailsPayload | null;
}

export interface SalePhoto {
  id: string | number;
  source_record_id: string | number;
  media_url: string;
  order_number: number | null;
  is_primary: boolean;
  caption: string | null;
  mime_type: string | null;
  permission: string | null;
  modification_timestamp: string | null;
}

export interface SalePhotosResponse {
  source_record_id: string | number;
  listing_key: string | null;
  listing_id: string | null;
  source_name: string | null;
  photos: SalePhoto[];
}

export interface AccountPhotosResponse {
  account_id: string;
  source_record_id: string | number | null;
  listing_key: string | null;
  listing_id: string | null;
  source_name: string | null;
  record_type?: 'closed_sale' | 'listing' | null;
  activity_date?: string | null;
  photos: SalePhoto[];
}

export interface SaleRow {
  sale_id: string | number | null;
  source_record_id: string | number | null;
  listing_id: string | null;
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
  match_status: 'exact' | 'normalized' | 'secondary' | 'multiple' | 'unmatched' | 'manual_verified';
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
  primary_photo_url: string | null;
  photo_count: number;
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
  distanceMiles?: number | null;
  locationScore?: number;
  squareFootageScore?: number;
  ageScore?: number;
  siteSizeScore?: number;
  salesDateScore?: number;
  ageDataAvailable?: boolean;
  subjectYearBuilt?: number | null;
  comparableYearBuilt?: number | null;
  yearBuiltDifference?: number | null;
  siteDataAvailable?: boolean;
  subjectSiteSize?: number | null;
  comparableSiteSize?: number | null;
  siteSizeDifference?: number | null;
  siteSizeDifferenceRatio?: number | null;
  siteSizeDifferencePercent?: number | null;
  housingTypeScore?: number;
  subjectHousingType?: string;
  comparableHousingType?: string;
  housingTypeKnown?: boolean;
  housingTypeCompatible?: boolean;
  squareFootageDifference?: number;
  squareFootageDifferenceRatio?: number;
  squareFootageDifferencePercent?: number;
  score_rank?: number;
  score_requires_review?: boolean;
  saleAgeDays?: number | null;
  soldWithinOneYear?: boolean;
  soldOverOneYear?: boolean;
  soldOverTwoYears?: boolean;
  recommended?: boolean;
  recommendationRank?: number | null;
  recommendationExclusionReason?: string | null;
  price_per_square_foot?: number | null;
  price_per_square_foot_zscore?: number | null;
  price_per_square_foot_robust_zscore?: number | null;
  statistical_outlier?: boolean;
  statistical_outlier_direction?: 'high' | 'low' | null;
  statistical_outlier_methods?: Array<
    'standard_deviation' | 'median_absolute_deviation' | 'interquartile_range'
  >;
  outlier_analysis_eligible?: boolean;
}

export interface SalesReconciliationQueueItem {
  source_record_id: string | number;
  listing_id: string | null;
  source_name: string | null;
  source_filename: string | null;
  source_row_number: number | null;
  record_type: 'closed_sale';
  mls_status: string | null;
  closing_date: string | null;
  sale_price: string | number | null;
  days_on_market: number | null;
  listing_contract_date: string | null;
  bedrooms_total: number | null;
  bathrooms_total_integer: number | null;
  bathrooms_full: number | null;
  bathrooms_half: number | null;
  living_area: string | number | null;
  year_built: number | null;
  structural_style: string | null;
  architectural_style: string | null;
  attachment_type: 'detached' | 'attached' | 'mixed' | 'unknown';
  parcel_number_raw: string | null;
  parcel_number2_raw: string | null;
  primary_account_id: string | null;
  match_status: SaleRow['match_status'];
  multi_parcel_status: SaleRow['multi_parcel_status'];
  has_unresolved_parcel: boolean;
  requires_additional_review: boolean;
  data_quality_flags: string[];
  canonical_sale_id: string | number | null;
  address_hint: string | null;
  queue_reasons: string[];
}

export interface SalesReconciliationQueueResponse {
  total: number;
  limit: number;
  offset: number;
  items: SalesReconciliationQueueItem[];
}

export interface LocationBackfillStatus {
  queue: {
    pending: number;
    processing: number;
    retry: number;
    completed: number;
    manual_review: number;
  };
  coverage: {
    sale_account_count: number;
    located_sale_account_count: number;
    missing_sale_account_count: number;
    coverage_percent: number;
  };
}

export interface SalesReconciliationUpdate {
  account_id: string;
  notes?: string | null;
  reviewer?: string | null;
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

export interface AppraisalRatingReview {
  source_record_id: string | number;
  listing_id: string | null;
  condition_rating: string | null;
  quality_rating: string | null;
  notes: string | null;
  reviewer: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface SubjectAppraisalRating {
  account_id: string;
  effective_date: string;
  condition_rating: string | null;
  quality_rating: string | null;
  notes: string | null;
  reviewer: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface AppraisalRatingUpdate {
  condition_rating?: string | null;
  quality_rating?: string | null;
  notes?: string | null;
  reviewer?: string | null;
  expected_revision?: number | null;
  clear?: boolean;
}

export interface SalesSearchParams {
  q?: string;
  subjectAccountId?: string;
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
  searchProfile?: ComparableSearchProfileKey;
  limit?: number;
  offset?: number;
}

export type ComparableSearchProfileKey =
  | 'urban_simple'
  | 'urban_moderate'
  | 'urban_complex'
  | 'suburban_simple'
  | 'suburban_moderate'
  | 'suburban_complex'
  | 'semi_rural_simple'
  | 'semi_rural_moderate'
  | 'semi_rural_complex'
  | 'rural_simple'
  | 'rural_moderate'
  | 'rural_complex';

export interface ComparableSearchProfile {
  key: ComparableSearchProfileKey;
  label: string;
  geography: 'urban' | 'suburban' | 'semi_rural' | 'rural';
  complexity: 'simple' | 'moderate' | 'complex';
  radius_miles: number;
}

export interface ComparableRecommendationParams {
  subjectAccountId: string;
  analysisAsOf?: string;
  periodMonths?: 12 | 24 | 36;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  marketBreakdown?: GroupedAnalysisBreakdownKey;
  locationWeight?: number;
  squareFootageWeight?: number;
  yearBuiltWeight?: number;
  siteSizeWeight?: number;
  salesDateWeight?: number;
  locationScaleMiles?: number;
  squareFootageScaleRatio?: number;
  yearBuiltScaleYears?: number;
  siteSizeScaleRatio?: number;
  salesDateScaleDays?: number;
  outlierScoreThreshold?: number;
  searchProfile?: ComparableSearchProfileKey;
}

export interface ComparableStatisticalAnalysis {
  score_threshold: number;
  minimum_sample_size: number;
  qualified_sale_count: number;
  measured_sale_count: number;
  effective_sample_size: number;
  duplicate_observation_count: number;
  coverage_ratio: number;
  distinct_sale_months: number;
  largest_month_share: number;
  sample_sufficient: boolean;
  confidence: 'high' | 'moderate' | 'insufficient';
  mean_price_per_square_foot: number | null;
  median_price_per_square_foot: number | null;
  standard_deviation_price_per_square_foot: number | null;
  first_quartile_price_per_square_foot: number | null;
  third_quartile_price_per_square_foot: number | null;
  interquartile_range_price_per_square_foot: number | null;
  median_absolute_deviation_price_per_square_foot: number | null;
  skewness: number | null;
  lower_fence_price_per_square_foot: number | null;
  upper_fence_price_per_square_foot: number | null;
  outlier_count: number;
  methods: string[];
  warnings: Array<{ code: string; message: string }>;
}

export interface ComparableRecommendationsResponse {
  subject: {
    account_id: string;
    address: string | null;
    city: string | null;
    county: string | null;
    postal_code: string | null;
    neighborhood_code: string | null;
    living_area_sqft: number;
    year_built: number | null;
    site_size_sqft: number | null;
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
    yearBuiltWeight: number;
    siteSizeWeight: number;
    salesDateWeight: number;
    locationScaleMiles: number;
    squareFootageScaleRatio: number;
    yearBuiltScaleYears: number;
    siteSizeScaleRatio: number;
    salesDateScaleDays: number;
    locationWeightPercent: number;
    squareFootageWeightPercent: number;
    yearBuiltWeightPercent: number;
    siteSizeWeightPercent: number;
    salesDateWeightPercent: number;
    squareFootageScalePercent: number;
    siteSizeScalePercent: number;
    squareFootageIsHardFilter: false;
  };
  coverage: {
    candidate_count: number;
    eligible_count: number;
    total_scored_count?: number;
    scope_eligible_count?: number;
    missing_location_count: number;
    unsupported_county_count: number;
    missing_square_footage_count: number;
    missing_year_built_count: number;
    missing_site_size_count: number;
    recommended_count: number;
    older_than_two_years_count: number;
    older_than_one_year_count: number;
    recent_high_score_count: number;
  };
  recommendation_policy: {
    count: number;
    periodMonths: 12 | 24 | 36;
    analysisAsOf: string;
    analysisStartDate: string;
    olderThanOneYearCount: number;
    outsideAnalysisPeriodCount: number;
    expandedHistoricalPeriod: boolean;
    recentYears: number;
    olderThanYears: number;
    highScoreThreshold: number;
    referenceDate: string | null;
    recentHighScoreCount: number;
    scoreAboveThresholdCount: number;
    olderSaleExclusionApplied: boolean;
  };
  statistical_analysis: ComparableStatisticalAnalysis;
  analysis_period: {
    analysis_as_of: string;
    date_from: string;
    period_months: 12 | 24 | 36;
  };
  search_profile: ComparableSearchProfile;
  study_market?: {
    key: GroupedAnalysisBreakdownKey | null;
    scope: 'city' | 'zip' | 'radius' | null;
    radius_miles: number | null;
    label: string;
  };
  recommended_sales: SaleRow[];
  competitive_sales: SaleRow[];
  sales: SaleRow[];
}

export type MarketConditionsAreaKey =
  | 'city'
  | 'zip'
  | 'radius_1'
  | 'radius_2'
  | 'radius_3'
  | 'radius_4'
  | 'radius_5'
  | 'custom';

export type GeoJsonPolygon = {
  type: 'Polygon';
  coordinates: number[][][];
};

export interface MarketContextOverride {
  source: 'manual' | 'dcad_related_parcel';
  address?: string | null;
  city?: string | null;
  county?: string | null;
  postal_code?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  source_account_id?: string | null;
  review_note?: string | null;
}

export interface MarketConditionsSubject {
  account_id: string;
  address: string | null;
  city: string | null;
  county: string | null;
  postal_code: string | null;
  neighborhood_code: string | null;
  latitude: number | null;
  longitude: number | null;
  location_status: 'matched' | 'not_found' | 'invalid' | null;
  location_source: string | null;
  location_precision: string | null;
  location_confidence: 'high' | 'medium' | 'low' | null;
  location_review_required: boolean;
  location_review_reason: string | null;
  context_override_active: boolean;
  context_override_source: 'manual' | 'dcad_related_parcel' | null;
  context_overridden_fields: string[];
  context_source_account_id: string | null;
  context_review_note: string | null;
}

export interface RelatedParcel {
  account_id: string;
  low_parcel_id: string | null;
  site_address: string | null;
  address: string | null;
  city: string | null;
  postal_code: string | null;
  county: string | null;
  neighborhood_code: string | null;
  property_description: string | null;
  legal_description: string | null;
  use_description: string | null;
  living_area_sqft: number | null;
  land_value: number | null;
  improvement_value: number | null;
  total_value: number | null;
  latitude: number | null;
  longitude: number | null;
  source_updated_at: string | null;
  source: string;
  data_quality_status: string | null;
  in_database: boolean;
  is_subject: boolean;
  materially_different?: boolean;
  difference_fields?: string[];
}

export interface RelatedParcelsResponse {
  subject_account_id: string;
  query_address: string;
  live_query_status: 'complete' | 'unavailable' | 'unsupported_county';
  live_query_error: string | null;
  review_required: boolean;
  material_difference_found?: boolean;
  merge_performed: false;
  parcels: RelatedParcel[];
}

export interface MarketConditionsSeriesPoint {
  period_start: string | null;
  sale_count: number;
  median_sale_price: number | null;
  median_days_on_market: number | null;
  median_sale_to_list_ratio: number | null;
  median_price_per_square_foot: number | null;
}

export interface MarketConditionsMapSale {
  sale_id: string | number | null;
  source_record_id: string | number | null;
  account_id: string | null;
  address: string | null;
  city: string | null;
  closing_date: string | null;
  sale_price: number | null;
  latitude: number | null;
  longitude: number | null;
}

export interface MarketCongruencyNumericFactor {
  count: number;
  cod: number | null;
  cv: number | null;
  weight: number;
}

export interface MarketCongruencyFactors {
  living_area: MarketCongruencyNumericFactor;
  price_per_square_foot: MarketCongruencyNumericFactor;
  sale_price: MarketCongruencyNumericFactor;
  age: MarketCongruencyNumericFactor;
  housing_type: {
    count: number;
    dispersion: number | null;
    dominant_type: string | null;
    weight: number;
  };
}

export interface MarketStudyStatistics {
  annualized_change_percent: number | null;
  trend_start_period: string | null;
  trend_end_period: string | null;
  trend_start_median_price: number | null;
  trend_end_median_price: number | null;
  monthly_observation_count: number;
  composite_cod: number | null;
  composite_cv: number | null;
  characteristic_weight_available: number;
  reliability_score: number | null;
  sample_sufficient: boolean;
}

export interface MarketConditionsAnalysis {
  market: {
    key: MarketConditionsAreaKey;
    scope: 'city' | 'zip' | 'radius' | 'custom';
    label: string;
    city: string | null;
    county: string | null;
    postal_code: string | null;
    radius_miles: number | null;
    custom_geometry: GeoJsonPolygon | null;
    area_square_miles: number | null;
    includes_subject: boolean | null;
  };
  period: {
    start: string | null;
    end: string | null;
  };
  population: {
    eligible_sale_count: number;
    mapped_sale_count: number;
  };
  summary: {
    median_sale_price: number | null;
    median_days_on_market: number | null;
    median_sale_to_list_ratio: number | null;
    median_price_per_square_foot: number | null;
    minimum_sale_price: number | null;
    maximum_sale_price: number | null;
    congruency_factors: MarketCongruencyFactors;
  };
  statistics: MarketStudyStatistics;
  series: {
    monthly: MarketConditionsSeriesPoint[];
    quarterly: MarketConditionsSeriesPoint[];
    semiannual: MarketConditionsSeriesPoint[];
    yearly: MarketConditionsSeriesPoint[];
  };
  map_sales: MarketConditionsMapSale[];
  filters: {
    record_type: 'closed_sale';
    minimum_sale_price: number | null;
    review_flagged_sales_included: boolean;
    multi_parcel_sales_included: boolean;
    attached_housing_included: boolean;
    inclusive_start_date: boolean;
    period_months: number;
    complete_calendar_months: boolean;
    analysis_as_of: string;
    partial_as_of_month_excluded: boolean;
  };
}

export interface MarketConditionsResponse {
  subject: MarketConditionsSubject;
  analyses: MarketConditionsAnalysis[];
  recommendation: {
    methodology_version: number;
    weighting_method?: 'appraiser_defined_area_60_percent' | 'mean_median_reconciliation';
    appraiser_defined_area_weight_percent?: number;
    stable_threshold_percent: number;
    conclusion:
      | 'increasing'
      | 'stable'
      | 'decreasing'
      | 'insufficient';
    average_annualized_change_percent: number | null;
    median_annualized_change_percent: number | null;
    recommended_change_percent: number | null;
    ranked_studies: Array<{
      rank: number;
      key: MarketConditionsAreaKey;
      label: string;
      reliability_score: number | null;
      reconciliation_weight_percent?: number | null;
      sale_count: number;
      sample_sufficient: boolean;
      annualized_change_percent: number | null;
      composite_cod: number | null;
      composite_cv: number | null;
    }>;
  };
  unavailable_areas: Array<{
    key: MarketConditionsAreaKey;
    label: string;
    reason: string;
  }>;
  independence_notice: string;
}

export interface MarketConditionsRequest {
  subjectAccountId: string;
  areaKeys: MarketConditionsAreaKey[];
  asOf?: string;
  periodMonths: 12 | 24 | 36;
  customGeometry?: GeoJsonPolygon | null;
  contextOverride?: MarketContextOverride | null;
}

export type GroupedAdjustmentReliability = 'strong' | 'moderate' | 'limited';

export interface GroupedAdjustmentOption {
  id: 'median_sale_price_difference' | 'average_sale_price_difference';
  label: string;
  basis: 'median_sale_price_difference' | 'average_sale_price_difference';
  rawAmount: number;
  amount: number;
  priceDifference?: number;
  livingAreaDifference?: number;
  reliability: GroupedAdjustmentReliability;
  sampleSizeLow: number;
  sampleSizeHigh: number;
  recommended: boolean;
}

export interface GroupedAnalysisGroup {
  groupValue: number | boolean;
  label: string;
  sampleSize: number;
  minimumSalePrice: number | null;
  maximumSalePrice: number | null;
  averageSalePrice: number | null;
  medianSalePrice: number | null;
  lowerQuartileSalePrice: number | null;
  upperQuartileSalePrice: number | null;
  salePriceStandardDeviation: number | null;
  averagePricePerSquareFoot: number | null;
  medianPricePerSquareFoot: number | null;
  averageLivingArea: number | null;
  medianLivingArea: number | null;
  minimumLivingArea: number | null;
  maximumLivingArea: number | null;
  averageDaysOnMarket: number | null;
  medianDaysOnMarket: number | null;
}

export interface GroupedAnalysisTransition {
  id: string;
  label: string;
  fromGroupValue: number | boolean;
  toGroupValue: number | boolean;
  fromSampleSize: number;
  toSampleSize: number;
  options: GroupedAdjustmentOption[];
}

export interface GroupedAnalysisDimension {
  key: 'bathrooms' | 'garage' | 'pool' | 'living_area';
  label: string;
  groups: GroupedAnalysisGroup[];
  transitions: GroupedAnalysisTransition[];
}

export type GroupedAnalysisBreakdownKey =
  | 'city'
  | 'zip'
  | 'radius_1'
  | 'radius_2'
  | 'radius_3'
  | 'radius_4'
  | 'radius_5'
  | 'custom';

export interface GroupedAnalysisResponse {
  subject: {
    account_id: string;
    address: string | null;
  };
  market: {
    key: GroupedAnalysisBreakdownKey;
    scope: 'city' | 'zip' | 'radius' | 'custom';
    city: string | null;
    county: string | null;
    postal_code: string | null;
    radius_miles: number | null;
    label: string;
  };
  period: {
    start: string | null;
    end: string | null;
  };
  population: {
    eligible_sale_count: number;
    bathroom_sale_count: number;
    garage_sale_count: number;
    pool_sale_count: number;
    living_area_sale_count: number;
  };
  filters: {
    record_type: 'closed_sale';
    minimum_sale_price: number | null;
    review_flagged_sales_included: boolean;
    multi_parcel_sales_included: boolean;
    attached_housing_included: boolean;
    period_years: number;
  };
  dimensions: GroupedAnalysisDimension[];
}

export type PairedAnalysisDimensionKey =
  | 'bathrooms'
  | 'garage'
  | 'pool'
  | 'living_area';

export type PairedAnalysisUnit =
  | 'per_bath_equivalent'
  | 'per_garage_space'
  | 'per_feature'
  | 'per_square_foot';

export interface PairedSaleSummary {
  saleId: string | null;
  sourceRecordId: string | null;
  accountId: string | null;
  address: string | null;
  city: string | null;
  closingDate: string | null;
  salePrice: number;
  bedrooms: number | null;
  bathrooms: number | null;
  garageSpaces: number | null;
  pool: boolean | null;
  livingArea: number;
  siteSize: number | null;
  yearBuilt: number | null;
}

export interface PairedSaleEvidence {
  id: string;
  inferior: PairedSaleSummary;
  superior: PairedSaleSummary;
  featureDifference: number;
  salePriceDifference: number;
  unitPriceDifference: number;
  matchScore: number;
  controlDifferences: {
    distanceMiles: number;
    closingDateDays: number;
    livingAreaPercent: number;
    yearBuiltYears: number | null;
    siteSizePercent: number | null;
  };
}

export interface PairedAnalysisStatistics {
  sampleSize: number;
  mean: number | null;
  median: number | null;
  standardDeviation: number | null;
  coefficientOfVariation: number | null;
  coefficientOfDispersion: number | null;
  recommendedAdjustment: number | null;
  reliability: GroupedAdjustmentReliability;
}

export interface PairedAnalysisRange {
  id: string;
  label: string;
  fromValue: number | boolean;
  toValue: number | boolean;
  unit: PairedAnalysisUnit;
  unitLabel: string;
  statistics: PairedAnalysisStatistics;
  pairs: PairedSaleEvidence[];
}

export interface PairedAnalysisDimension {
  key: PairedAnalysisDimensionKey;
  label: string;
  explanation: string;
  ranges: PairedAnalysisRange[];
}

export interface PairedSalesAnalysisResponse {
  subject: {
    accountId: string;
    address: string | null;
    city: string | null;
    county: string | null;
    postalCode: string | null;
  };
  market: {
    key: MarketConditionsAreaKey;
    scope: 'city' | 'zip' | 'radius' | 'custom';
    radiusMiles: number | null;
    label: string;
    customGeometry: GeoJsonPolygon | null;
  };
  period: {
    start: string;
    end: string;
    analysisAsOf: string;
    periodMonths: 12;
    completeCalendarMonths: true;
  };
  population: {
    eligibleSaleCount: number;
    pairableSaleCount: number;
  };
  methodology: {
    maximumPairDistanceMiles: number;
    maximumClosingDateDifferenceDays: number;
    maximumYearBuiltDifferenceYears: number;
    maximumSiteSizeDifferencePercent: number;
    maximumControlLivingAreaDifferencePercent: number;
    maximumPairsPerRange: number;
    pairReuseWithinRange: false;
    negativeDifferencesRetained: true;
    knownNonTargetControlsRequired: true;
  };
  dimensions: PairedAnalysisDimension[];
}

export interface GroupedAnalysesResponse {
  subject: {
    account_id: string;
    address: string | null;
    city: string | null;
    county: string | null;
    postal_code: string | null;
    latitude: number | null;
    longitude: number | null;
  };
  analyses: GroupedAnalysisResponse[];
  unavailable_breakdowns: Array<{
    key: GroupedAnalysisBreakdownKey;
    label: string;
    reason: string;
  }>;
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

/** Load the latest ordered MLS photo gallery available for an account. */
export async function getAccountPhotos(accountId: string): Promise<AccountPhotosResponse> {
  const id = (accountId || '').trim();
  const url = makeUrl(`/api/accounts/${encodeURIComponent(id)}/photos`);
  return fetchJSON<AccountPhotosResponse>(url);
}

/** Resolve one property's Census tract immediately, ahead of the background queue. */
export async function lookupAccountCensusGeography(
  accountId: string,
  editorKey: string,
): Promise<{
  ok: true;
  account_id: string;
  census_geography: NonNullable<AccountDetail['census_geography']>;
}> {
  const id = (accountId || '').trim();
  return fetchJSON(makeUrl(`/api/accounts/${encodeURIComponent(id)}/census-geography/lookup`), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-homenode-editor-key': editorKey,
    },
    body: JSON.stringify({}),
    timeoutMs: 135000,
  });
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

/** Save one or more explicitly edited Property Report sections with audit history. */
export async function updatePropertyReportSections(
  accountId: string,
  sections: Partial<Record<ReportManualSectionKey, unknown>>,
  editorKey: string,
): Promise<{
  ok: true;
  account_id: string;
  manual_values: Partial<Record<ReportManualSectionKey, ReportManualValue>>;
}> {
  const id = (accountId || '').trim();
  const url = makeUrl(`/api/accounts/${encodeURIComponent(id)}/report-manual-values`);
  return fetchJSON(url, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-homenode-editor-key': editorKey,
    },
    body: JSON.stringify({ sections }),
  });
}

/** Load the immutable assignment-file log and the latest values available to inherit. */
export async function getAssignmentFiles(accountId: string): Promise<AssignmentFilesResponse> {
  const id = (accountId || '').trim();
  return fetchJSON<AssignmentFilesResponse>(
    makeUrl(`/api/accounts/${encodeURIComponent(id)}/assignment-files`),
  );
}

/** Create a distinct appraisal file. Earlier file snapshots are never overwritten. */
export async function createAssignmentFile(
  accountId: string,
  input: {
    file_number: string;
    assignment_details: AssignmentDetailsPayload;
    inherited_from_file_id?: number | null;
  },
  editorKey: string,
): Promise<{ ok: true; assignment_file: AppraisalAssignmentFile }> {
  const id = (accountId || '').trim();
  return fetchJSON(makeUrl(`/api/accounts/${encodeURIComponent(id)}/assignment-files`), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-homenode-editor-key': editorKey,
    },
    body: JSON.stringify(input),
  });
}

/** Save a revision to the currently active assignment file. */
export async function updateAssignmentFile(
  accountId: string,
  assignmentFileId: number,
  input: {
    assignment_details: AssignmentDetailsPayload;
    expected_revision: number;
  },
  editorKey: string,
): Promise<{ ok: true; assignment_file: AppraisalAssignmentFile }> {
  const id = (accountId || '').trim();
  return fetchJSON(
    makeUrl(
      `/api/accounts/${encodeURIComponent(id)}/assignment-files/${encodeURIComponent(String(assignmentFileId))}`,
    ),
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-homenode-editor-key': editorKey,
      },
      body: JSON.stringify(input),
    },
  );
}

/** Load background coordinate coverage for matched sale accounts. */
export async function getLocationBackfillStatus(): Promise<LocationBackfillStatus> {
  const url = makeUrl('/api/location-backfill/status');
  return fetchJSON<LocationBackfillStatus>(url, { timeoutMs: 90000 });
}

/** Load source MLS sales that still need a manually verified CAD account. */
export async function getSalesReconciliationQueue(
  limit = 20,
  offset = 0,
): Promise<SalesReconciliationQueueResponse> {
  const url = makeUrl('/api/sales/reconciliation-queue', { limit, offset });
  return fetchJSON<SalesReconciliationQueueResponse>(url, { timeoutMs: 90000 });
}

/** Save a verified sale-to-account link and upsert the canonical sale. */
export async function reconcileSalesSourceRecord(
  sourceRecordId: string | number,
  update: SalesReconciliationUpdate,
  editorKey: string,
): Promise<{
  ok: true;
  sale_id: string | number;
  account: {
    account_id: string;
    address: string | null;
    city: string | null;
    postal_code: string | null;
    county: string | null;
  };
  unresolved_parcel_count: number;
}> {
  const url = makeUrl(`/api/sales/${encodeURIComponent(String(sourceRecordId))}/reconcile`);
  return fetchJSON(url, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-homenode-editor-key': editorKey,
    },
    body: JSON.stringify(update),
  });
}

/** Batch-load saved comparable condition/quality reviews. */
export async function getSaleAppraisalReviews(
  sourceRecordIds: Array<string | number>,
): Promise<AppraisalRatingReview[]> {
  const ids = [...new Set(sourceRecordIds.map(String).filter(Boolean))];
  if (!ids.length) return [];
  const url = makeUrl('/api/sales/reviews', { source_record_ids: ids.join(',') });
  const response = await fetchJSON<{ reviews: AppraisalRatingReview[] }>(url);
  return response.reviews || [];
}

/** Explicit Save Changes for one source MLS sale. */
export async function updateSaleAppraisalReview(
  sourceRecordId: string | number,
  update: AppraisalRatingUpdate,
  editorKey: string,
): Promise<AppraisalRatingReview> {
  const url = makeUrl(`/api/sales/${encodeURIComponent(String(sourceRecordId))}/review`);
  const response = await fetchJSON<{ ok: true; review: AppraisalRatingReview }>(url, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-homenode-editor-key': editorKey,
    },
    body: JSON.stringify(update),
  });
  return response.review;
}

export async function getSubjectAppraisalRating(
  accountId: string,
  effectiveDate: string,
): Promise<SubjectAppraisalRating | null> {
  const url = makeUrl(`/api/accounts/${encodeURIComponent(accountId)}/appraisal-rating`, {
    effective_date: effectiveDate,
  });
  const response = await fetchJSON<{ rating: SubjectAppraisalRating | null }>(url);
  return response.rating;
}

/** Explicit Save Changes for the subject at one appraisal effective date. */
export async function updateSubjectAppraisalRating(
  accountId: string,
  effectiveDate: string,
  update: AppraisalRatingUpdate,
  editorKey: string,
): Promise<SubjectAppraisalRating> {
  const url = makeUrl(`/api/accounts/${encodeURIComponent(accountId)}/appraisal-rating`);
  const response = await fetchJSON<{ ok: true; rating: SubjectAppraisalRating }>(url, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-homenode-editor-key': editorKey,
    },
    body: JSON.stringify({ ...update, effective_date: effectiveDate }),
  });
  return response.rating;
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
    subject_account_id: params.subjectAccountId?.trim(),
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
    search_profile: params.searchProfile,
    limit: params.limit ?? 25,
    offset: params.offset ?? 0,
  });
  return fetchJSON<SaleRow[]>(url);
}

/** Lazily load the ordered MLS gallery for one imported sale/listing row. */
export async function getSalePhotos(
  sourceRecordId: string | number,
): Promise<SalePhotosResponse> {
  const id = String(sourceRecordId ?? '').trim();
  const url = makeUrl(`/api/sales/${encodeURIComponent(id)}/photos`);
  return fetchJSON<SalePhotosResponse>(url);
}

/** Rank matched sales by proximity, living-area, age, site-size, and sale-date similarity. */
export async function getComparableRecommendations(
  params: ComparableRecommendationParams,
): Promise<ComparableRecommendationsResponse> {
  const url = makeUrl('/api/sales/recommendations', {
    subject_account_id: params.subjectAccountId.trim(),
    analysis_as_of: params.analysisAsOf,
    period_months: params.periodMonths,
    date_from: params.dateFrom,
    date_to: params.dateTo,
    limit: params.limit ?? 25,
    market_breakdown: params.marketBreakdown,
    location_weight: params.locationWeight,
    square_footage_weight: params.squareFootageWeight,
    year_built_weight: params.yearBuiltWeight,
    site_size_weight: params.siteSizeWeight,
    sales_date_weight: params.salesDateWeight,
    location_scale_miles: params.locationScaleMiles,
    square_footage_scale_ratio: params.squareFootageScaleRatio,
    year_built_scale_years: params.yearBuiltScaleYears,
    site_size_scale_ratio: params.siteSizeScaleRatio,
    sales_date_scale_days: params.salesDateScaleDays,
    outlier_score_threshold: params.outlierScoreThreshold,
    search_profile: params.searchProfile,
  });
  return fetchJSON<ComparableRecommendationsResponse>(url, { timeoutMs: 90000 });
}

/** Load the subject location used to center the independent market-study map. */
export async function getMarketConditionsContext(
  subjectAccountId: string,
): Promise<{ subject: MarketConditionsSubject }> {
  const url = makeUrl('/api/sales/market-context', {
    subject_account_id: subjectAccountId.trim(),
  });
  return fetchJSON<{ subject: MarketConditionsSubject }>(url, {
    timeoutMs: 90000,
  });
}

/** Find exact same-address CAD parcels without merging account records. */
export async function getRelatedParcels(
  subjectAccountId: string,
  address?: string,
): Promise<RelatedParcelsResponse> {
  const url = makeUrl(`/api/accounts/${encodeURIComponent(subjectAccountId.trim())}/related-parcels`, {
    address: address?.trim() || undefined,
  });
  return fetchJSON<RelatedParcelsResponse>(url, { timeoutMs: 90000 });
}

/** Build independent market-condition studies without filtering comparable inventory. */
export async function runMarketConditionsAnalysis(
  request: MarketConditionsRequest,
): Promise<MarketConditionsResponse> {
  const url = makeUrl('/api/sales/market-analysis');
  return fetchJSON<MarketConditionsResponse>(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      subject_account_id: request.subjectAccountId.trim(),
      area_keys: request.areaKeys,
      as_of: request.asOf,
      period_months: request.periodMonths,
      custom_geometry: request.customGeometry || null,
      context_override: request.contextOverride || null,
    }),
    timeoutMs: 120000,
  });
}

/** Build current one-year bathroom, garage, pool, and living-area grouped adjustment studies. */
export async function getGroupedAdjustmentAnalysis(
  subjectAccountId: string,
  asOf?: string,
): Promise<GroupedAnalysisResponse> {
  const url = makeUrl('/api/sales/grouped-analysis', {
    subject_account_id: subjectAccountId.trim(),
    as_of: asOf,
  });
  return fetchJSON<GroupedAnalysisResponse>(url, { timeoutMs: 90000 });
}

/** Build one or more selected grouped studies for the same subject and period. */
export async function getGroupedAdjustmentAnalyses(
  subjectAccountId: string,
  breakdowns: GroupedAnalysisBreakdownKey[],
  asOf?: string,
): Promise<GroupedAnalysesResponse> {
  const url = makeUrl('/api/sales/grouped-analysis', {
    subject_account_id: subjectAccountId.trim(),
    as_of: asOf,
    breakdowns: breakdowns.join(','),
  });
  return fetchJSON<GroupedAnalysesResponse>(url, { timeoutMs: 120000 });
}

/** Build a paired-sales study inside one selected market area. */
export async function runPairedSalesAnalysis(request: {
  subjectAccountId: string;
  marketKey: MarketConditionsAreaKey;
  asOf?: string;
  customGeometry?: GeoJsonPolygon | null;
}): Promise<PairedSalesAnalysisResponse> {
  const url = makeUrl('/api/sales/paired-analysis');
  return fetchJSON<PairedSalesAnalysisResponse>(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      subject_account_id: request.subjectAccountId.trim(),
      market_key: request.marketKey,
      as_of: request.asOf,
      custom_geometry: request.customGeometry || null,
    }),
    timeoutMs: 120000,
  });
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

/** Keep city/state/ZIP metadata out of the primary search-tile heading. */
export function formatSearchTileAddress(
  address: string | null | undefined,
  city?: string | null,
) {
  const value = String(address || '').replace(/\s+/g, ' ').trim().replace(/^,|,$/g, '');
  if (!value) return '(Address unavailable)';

  const normalize = (text: string) => text
    .toUpperCase()
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const normalizedCity = normalize(String(city || ''));
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  if (normalizedCity) {
    const cityIndex = parts.findIndex(
      (part, index) => index > 0 && normalize(part) === normalizedCity,
    );
    if (cityIndex > 0) return parts.slice(0, cityIndex).join(', ');
  }
  if (parts.length >= 3) return parts.slice(0, -2).join(', ');
  if (parts.length === 2 && /(?:\bTX\b|\bTEXAS\b|\d{5})/i.test(parts[1])) {
    return parts[0];
  }
  return value;
}

/**
 * Build display fields for a result tile:
 *  - title: Address (primary)
 *  - subtitle: Account ID (and market value if present)
 */
export function toTile(row: AccountRow) {
  const title = formatSearchTileAddress(row.address, row.city);
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

