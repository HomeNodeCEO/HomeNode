import { isAuthenticatedSessionEditorCredential } from '@/lib/editorCredential';
import {
  clearCustomAppraisalSignatureEventId,
  getOrCreateCustomAppraisalSignatureEventId,
} from '@/lib/customAppraisalSigning';
import {
  withDesktopSketchSaveOperation,
} from '@/lib/desktopSketchSaveOperation';
import { createTimedRequestCache } from '@/lib/timedRequestCache';
import type { NeighborhoodRelevanceAssessment } from '@/lib/neighborhoodRelevanceTypes';
export type { NeighborhoodRelevanceAssessment } from '@/lib/neighborhoodRelevanceTypes';

type Json = Record<string, unknown>;

const BASE =
  (import.meta.env.VITE_API_URL || import.meta.env.VITE_API_BASE || '')
    .toString()
    .replace(/\/+$/, ''); // '' means use relative paths (dev proxy)

export function makeUrl(path: string, params?: Record<string, string | number | boolean | undefined>) {
  const u = new URL((BASE || '') + path, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    }
  }
  return BASE ? u.toString() : path + (u.search ? `?${u.searchParams.toString()}` : '');
}

export async function fetchWithApplicationAuthentication(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (isAuthenticatedSessionEditorCredential(headers.get('x-homenode-editor-key'))) {
    headers.delete('x-homenode-editor-key');
  }
  const accessToken = typeof window !== 'undefined'
    ? await window.homenodeAuth?.getAccessToken?.()
    : null;
  if (typeof accessToken === 'string' && accessToken.trim() && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${accessToken.trim()}`);
  }
  return fetch(input, { ...init, credentials: 'include', headers });
}

type FetchJSONOptions = RequestInit & {
  timeoutMs?: number;
  retryTransient?: boolean;
};

function transientRetryDelay(response?: Response) {
  const retryAfter = Number(response?.headers.get('retry-after'));
  return Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.min(retryAfter * 1000, 3000)
    : 500;
}

function responseErrorMessage(body: unknown, status: number): string {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    const candidate = record.error ?? record.message;
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, 500);
  }
  return `HTTP ${status}`;
}

export async function fetchJSON<T = unknown>(input: string, init?: FetchJSONOptions): Promise<T> {
  const { timeoutMs = 25000, retryTransient = false, ...requestInit } = init || {};
  const attempts = retryTransient ? 2 : 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchWithApplicationAuthentication(input, {
        ...requestInit,
        signal: controller.signal,
      });
      const ct = res.headers.get('content-type') || '';
      const isJson = ct.includes('application/json');

      if (!res.ok) {
        if (res.status === 429 && attempt + 1 < attempts) {
          await new Promise((resolve) => setTimeout(resolve, transientRetryDelay(res)));
          continue;
        }
        const body: unknown = isJson
          ? await res.json().catch(() => ({}))
          : await res.text().catch(() => '');
        throw new Error(responseErrorMessage(body, res.status));
      }
      const body: unknown = isJson ? await res.json() : await res.text();
      return body as T;
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('Request timed out');
      if (retryTransient && error instanceof TypeError && attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, transientRetryDelay()));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error('Request failed');
}

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
  native_account_id?: string | null;
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
  property_context?: PropertyComplexityAssessment | null;
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
  subject_condition_rating?: string;
  subject_condition_notes?: string;
  significant_physical_deficiencies?: boolean | null;
  subject_conforms_to_neighborhood?: boolean | null;
  subject_nonconformity_type?: string;
  subject_nonconformity_explanation?: string;
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
  subject_under_contract?: boolean;
  contract_arms_length?: boolean | null;
  contract_buyer_names?: string;
  contract_seller_names?: string;
  contract_price?: string | number;
  contract_date?: string;
  contract_closing_date?: string;
  loan_amount?: string | number;
  down_payment?: string | number;
  earnest_money?: string | number;
  seller_concessions?: string | number;
  contract_property_condition?: string;
  contract_repairs?: string;
  contract_analysis_summary?: string;
  seller_matches_public_records?: boolean | null;
  seller_mismatch_explanation?: string;
  neighborhood_land_use_one_unit_pct?: string | number;
  neighborhood_land_use_two_to_four_unit_pct?: string | number;
  neighborhood_land_use_multifamily_pct?: string | number;
  neighborhood_land_use_commercial_pct?: string | number;
  neighborhood_land_use_other_vacant_pct?: string | number;
  neighborhood_land_use_analysis_source?: string;
  neighborhood_land_use_analyzed_at?: string;
  neighborhood_land_use_parcel_count?: string | number;
  neighborhood_land_use_review_count?: string | number;
  neighborhood_land_use_coverage_percent?: string | number;
  neighborhood_land_use_confidence?: string;
  neighborhood_land_use_boundary_signature?: string;
  neighborhood_built_up_pct?: string | number;
  neighborhood_location_type?: string;
  neighborhood_built_up?: string;
  neighborhood_growth?: string;
  neighborhood_unemployment_pct?: string | number;
  neighborhood_unemployment_zip?: string;
  neighborhood_unemployment_source?: string;
  neighborhood_unemployment_dataset_year?: string | number;
  neighborhood_unemployment_variable?: string;
  neighborhood_city_unemployment_pct?: string | number;
  neighborhood_city_unemployment_name?: string;
  neighborhood_city_unemployment_source?: string;
  neighborhood_city_unemployment_dataset_year?: string | number;
  neighborhood_city_unemployment_variable?: string;
  neighborhood_market_trend?: string;
  neighborhood_market_change_pct?: string | number;
  neighborhood_median_dom?: string | number;
  neighborhood_demand_supply?: string;
  neighborhood_marketing_time?: string;
  neighborhood_house_price_low?: string | number;
  neighborhood_house_price_high?: string | number;
  neighborhood_house_price_predominant?: string | number;
  neighborhood_ppsf_low?: string | number;
  neighborhood_ppsf_high?: string | number;
  neighborhood_ppsf_predominant?: string | number;
  neighborhood_age_low?: string | number;
  neighborhood_age_high?: string | number;
  neighborhood_age_predominant?: string | number;
  neighborhood_gla_low?: string | number;
  neighborhood_gla_high?: string | number;
  neighborhood_gla_predominant?: string | number;
  neighborhood_sale_count?: string | number;
  neighborhood_all_property_count?: string | number;
  neighborhood_all_house_price_low?: string | number;
  neighborhood_all_house_price_high?: string | number;
  neighborhood_all_house_price_predominant?: string | number;
  neighborhood_all_ppsf_low?: string | number;
  neighborhood_all_ppsf_high?: string | number;
  neighborhood_all_ppsf_predominant?: string | number;
  neighborhood_all_age_low?: string | number;
  neighborhood_all_age_high?: string | number;
  neighborhood_all_age_predominant?: string | number;
  neighborhood_all_gla_low?: string | number;
  neighborhood_all_gla_high?: string | number;
  neighborhood_all_gla_predominant?: string | number;
  neighborhood_all_value_count?: string | number;
  neighborhood_all_ppsf_count?: string | number;
  neighborhood_all_age_count?: string | number;
  neighborhood_all_gla_count?: string | number;
  neighborhood_city_name?: string;
  neighborhood_city_sale_count?: string | number;
  neighborhood_city_average_sale_price?: string | number;
  neighborhood_city_average_ppsf?: string | number;
  neighborhood_city_average_age?: string | number;
  neighborhood_city_average_gla?: string | number;
  neighborhood_city_comparison_as_of?: string;
  neighborhood_boundary_geometry?: GeoJsonPolygon | null;
  neighborhood_boundary_label?: string;
  neighborhood_boundary_source?: string;
  neighborhood_boundary_saved_at?: string;
  neighborhood_boundary_streets?: string;
  neighborhood_boundary_north?: string;
  neighborhood_boundary_east?: string;
  neighborhood_boundary_south?: string;
  neighborhood_boundary_west?: string;
  neighborhood_boundary_exclusions?: string;
  neighborhood_boundary_streets_source?: string;
  neighborhood_boundary_streets_retrieved_at?: string;
  neighborhood_boundary_confirmed?: boolean;
  neighborhood_boundary_confirmed_at?: string;
  neighborhood_boundary_engine_assessment_id?: number | string;
  neighborhood_boundary_engine_assignment_file_id?: number | string;
  neighborhood_boundary_engine_methodology_version?: number | string;
  neighborhood_boundary_engine_confidence?: string;
  neighborhood_boundary_engine_disclosure?: string;
  neighborhood_boundary_engine_warnings?: string[];
  neighborhood_relevance_assessment_id?: number | string;
  neighborhood_relevance_methodology_version?: number | string;
  neighborhood_relevance_confidence?: string;
  neighborhood_relevance_candidate_count?: number | string;
  neighborhood_relevance_included_count?: number | string;
  neighborhood_relevance_excluded_count?: number | string;
  neighborhood_relevance_insufficient_data_count?: number | string;
  neighborhood_relevance_generated_at?: string;
  neighborhood_relevance_removed_pocket_ids?: string[];
  neighborhood_relevance_added_pocket_ids?: string[];
  neighborhood_relevance_override_updated_at?: string;
  highest_best_use_conclusion?: string;
  highest_best_use_summary?: string;
  highest_best_use_zoning_compatible?: boolean | null;
  highest_best_use_flags?: string[];
  highest_best_use_source?: string;
  highest_best_use_analyzed_at?: string;
  highest_best_use_subject_site_area_sqft?: string | number;
  highest_best_use_comparison_min_site_area_sqft?: string | number;
  highest_best_use_comparison_median_site_area_sqft?: string | number;
  highest_best_use_comparison_parcel_count?: string | number;
  subject_concluded_value?: string | number;
  neighborhood_value_position?: string;
  neighborhood_value_difference?: string | number;
  neighborhood_value_difference_pct?: string | number;
  neighborhood_value_conclusion?: string;
  neighborhood_value_conclusion_auto?: string;
  neighborhood_value_conclusion_signature?: string;
  neighborhood_value_conclusion_generated_at?: string;
  neighborhood_value_source?: string;
  lender_revision_count?: string | number;
  lender_revision_last_requested_at?: string;
  lender_revision_note?: string;
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
  workfile: {
    key: string;
    canonical_file_name: string;
    status: 'draft' | 'signed' | 'archived';
    signed_at: string | null;
    signed_by: string | null;
    updated_at: string;
  } | null;
  created_at: string;
  updated_at: string;
  custom_appraisal_sections?: Record<string, {
    value: Record<string, unknown>;
    revision: number;
    last_applied_session_id: string | null;
    updated_at: string;
  }>;
  mobile_inspection_sketch?: {
    id: string;
    client_sketch_id?: string;
    inspection_session_id?: string;
    report_file_id?: string;
    workflow_type?: 'custom_appraisal' | 'uad_3_6' | 'property_tax_protest';
    revision: number;
    measurement_standard: 'ansi_z765_2021' | 'jurisdiction_required_other';
    measurement_method: 'exterior' | 'interior_perimeter' | 'plans' | 'mixed';
    review_status: 'draft' | 'appraiser_confirmed';
    confirmed_at: string | null;
    updated_at: string;
    summary: {
      area_count: number;
      room_count: number;
      all_areas_closed: boolean;
      any_self_intersections: boolean;
      above_grade_finished_sqft: number;
      below_grade_finished_sqft: number;
      above_grade_nonstandard_finished_sqft: number;
      below_grade_nonstandard_finished_sqft: number;
      above_grade_noncontinuous_finished_sqft: number;
      above_grade_unfinished_sqft: number;
      below_grade_unfinished_sqft: number;
      garage_sqft: number;
      porch_patio_deck_sqft: number;
      by_classification: Record<string, number>;
    };
    document: {
      schema_version: string;
      source: 'manual';
      units: 'feet';
      dimension_precision_feet: number;
      measurement_standard: 'ansi_z765_2021' | 'jurisdiction_required_other';
      alternate_standard_name: string | null;
      measurement_method: 'exterior' | 'interior_perimeter' | 'plans' | 'mixed';
      review_status: 'draft' | 'appraiser_confirmed';
      ansi_review_required: boolean;
      review_notes: string | null;
      areas: Array<{
        id: string;
        label: string;
        level_label: string;
        classification: string;
        notes: string | null;
        vertices: Array<{ x: number; y: number }>;
        position: number;
        calculation: {
          closed: boolean;
          self_intersecting: boolean;
          perimeter_feet: number;
          reported_area_sqft: number | null;
          closure_gap_feet: number;
          calculated_area_sqft: number | null;
          ready_for_area_classification: boolean;
          bounds: { min_x: number; min_y: number; max_x: number; max_y: number };
          centroid: { x: number; y: number } | null;
          segments: Array<{
            index: number;
            from: { x: number; y: number };
            to: { x: number; y: number };
            length_feet: number;
          }>;
        };
      }>;
      rooms: Array<{
        id: string;
        room_ref: string;
        area_id: string;
        label: string;
        room_type: string;
        level_label: string;
        anchor: { x: number; y: number };
        position: number;
      }>;
    };
  } | null;
  mobile_inspection_photos?: Array<{
    id: string;
    client_photo_id: string;
    origin_channel: 'mobile' | 'desktop';
    category: string;
    room_ref: string | null;
    room_label: string | null;
    caption: string | null;
    position: number;
    captured_at: string | null;
    status: 'verified';
    revision: number;
    verified_at: string;
    retention_until: string;
    required_retention_years: number;
    view_url: string | null;
    view_url_expires_in_seconds: number | null;
  }>;
}

export interface AssignmentFilesResponse {
  account_id: string;
  files: AppraisalAssignmentFile[];
  latest_file: AppraisalAssignmentFile | null;
  legacy_assignment_details: AssignmentDetailsPayload | null;
}

export type CanonicalReportWorkflow = 'custom_appraisal' | 'uad_3_6' | 'property_tax_protest';

export interface CanonicalReportFile {
  id: string;
  organization_id: string;
  account_id: string;
  workflow_type: CanonicalReportWorkflow;
  file_number: string;
  sequence_number: number | null;
  target_id: string | null;
  previous_report_file_id: string | null;
  is_current: boolean;
  registry_revision: number;
  ready_for_inspection: boolean;
  created_at: string;
  updated_at: string;
}

export interface CanonicalReportFilesResponse {
  account_id: string;
  workflow_type: CanonicalReportWorkflow;
  files: CanonicalReportFile[];
  recommended_file: CanonicalReportFile | null;
  requires_creation: boolean;
}

export type AppraisalHistoryWorkflow = 'custom_appraisal' | 'uad_3_6';
export type AppraisalReplicationMode = 'same_assignment_alternate' | 'new_assignment_template';

export interface PreviousAppraisalFile {
  id: string;
  appraisal_case_id: string | null;
  subject_snapshot_id: string | null;
  snapshot_version: number | null;
  snapshot_verification_status: 'captured' | 'unverified' | 'confirmed' | 'superseded' | null;
  workflow_type: AppraisalHistoryWorkflow;
  file_number: string;
  status: string;
  current_revision: number;
  is_current: boolean;
  effective_date: string | null;
  inspection_date: string | null;
  property_type: string | null;
  inspection_method: string | null;
  summary: {
    condition_rating: string | null;
    quality_rating: string | null;
    gross_living_area_sqft: number | null;
    site_area_sqft: number | null;
    site_area_acres: number | null;
    parcel_count: number | null;
    legal_descriptions: string[];
    photo_count: number;
    has_confirmed_sketch: boolean;
  };
  replication: {
    mode: AppraisalReplicationMode;
    source_report_file_id: string | null;
    source_file_number: string | null;
    change_review_required: boolean;
  } | null;
  target_id: string | null;
  view_url: string;
  created_at: string;
  updated_at: string;
}

export interface PreviousAppraisalFilesResponse {
  account_id: string;
  files: PreviousAppraisalFile[];
}

export async function getPreviousAppraisalFiles(
  accountId: string,
): Promise<PreviousAppraisalFilesResponse> {
  return fetchJSON<PreviousAppraisalFilesResponse>(
    makeUrl(`/api/accounts/${encodeURIComponent(String(accountId || '').trim())}/appraisal-history`),
  );
}

export async function replicatePreviousAppraisalFile(
  accountId: string,
  reportFileId: string,
  input: {
    mode: AppraisalReplicationMode;
    target_workflow_type: AppraisalHistoryWorkflow;
    client_request_id?: string;
    file_number?: string;
    effective_date?: string;
    inspection_date?: string;
    same_assignment_confirmed?: boolean;
  },
  editorKey: string,
): Promise<{
  ok: true;
  source_report_file_id: string;
  report_file: PreviousAppraisalFile;
  change_review_required: boolean;
}> {
  return fetchJSON(
    makeUrl(
      `/api/accounts/${encodeURIComponent(String(accountId || '').trim())}/appraisal-history/${encodeURIComponent(reportFileId)}/replicate`,
    ),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-homenode-editor-key': editorKey,
      },
      body: JSON.stringify(input),
    },
  );
}

export interface CustomAppraisalWorkfileSection<T extends object = Record<string, unknown>> {
  value: T;
  revision: number;
  updated_by: string;
  updated_at: string;
}

export interface CustomAppraisalWorkfile {
  assignment_file_id: number;
  file_number: string;
  workfile_key: string;
  canonical_file_name: string;
  schema_version: number;
  status: 'draft' | 'signed' | 'archived';
  signed_at: string | null;
  signed_by: string | null;
  created_at: string;
  updated_at: string;
  signed_snapshot: {
    id: string;
    checksum_sha256: string;
    signed_at: string;
    signed_by: string;
  } | null;
  sections: Record<string, CustomAppraisalWorkfileSection>;
  checksum_sha256?: string;
  report_pdf?: {
    canonical_file_name: string;
    checksum_sha256: string;
    page_count: number;
    byte_size: number;
    generated_at: string;
  } | null;
}

export interface CustomAppraisalReadinessIssue {
  code: string;
  message: string;
}

export interface CustomAppraisalReadiness {
  ready: boolean;
  blockers: CustomAppraisalReadinessIssue[];
  warnings: CustomAppraisalReadinessIssue[];
  blocker_messages: string[];
  warning_messages: string[];
  warning_codes: string[];
  assignment_file_id: number;
  workfile_status: CustomAppraisalWorkfile['status'];
  evaluated_at: string;
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
  listing_key?: string | null;
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
  candidate_influence_signature?: PropertyInfluenceSignature | null;
  influence_signature?: PropertyInfluenceSignature | null;
  influence_similarity?: {
    data_available: boolean;
    priority_tier: number;
    similarity_score: number | null;
    exact_material_match: boolean;
    shared_material_keys: string[];
    missing_subject_keys: string[];
    additional_comparable_keys: string[];
    reason: string;
  };
  influence_support_candidate?: boolean;
  candidate_purpose?: 'primary_similarity' | 'influence_support';
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
  source_latitude: number | null;
  source_longitude: number | null;
  location_evidence_status: 'coordinate_ready' | 'address_ready' | 'manual_review';
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
  linked_account_id?: string | null;
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
    influence_signature?: PropertyInfluenceSignature | null;
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
    influence_context_count?: number;
    missing_influence_context_count?: number;
    recommended_count: number;
    older_than_two_years_count: number;
    older_than_one_year_count: number;
    recent_high_score_count: number;
  };
  influence_ranking?: {
    methodology_version: number;
    influence_priority_applied: boolean;
    subject_context_available: boolean;
    eligible_sale_count: number;
    measured_sale_count: number;
    coverage_ratio: number;
    minimum_coverage_ratio: number;
    material_influence_categories: string[];
    ordering: string[];
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
  secondary_sales: SaleRow[];
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
    average_sale_price: number | null;
    average_price_per_square_foot: number | null;
    average_age: number | null;
    average_living_area: number | null;
    minimum_sale_price: number | null;
    maximum_sale_price: number | null;
    minimum_price_per_square_foot: number | null;
    maximum_price_per_square_foot: number | null;
    minimum_age: number | null;
    maximum_age: number | null;
    median_age: number | null;
    minimum_living_area: number | null;
    maximum_living_area: number | null;
    median_living_area: number | null;
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

export type RegressionFeatureKey =
  | 'living_area'
  | 'bathrooms'
  | 'garage'
  | 'pool'
  | 'age'
  | 'site_size';

export interface RegressionAnalysisResponse {
  subject: {
    accountId: string;
    address: string | null;
    city: string | null;
    county: string | null;
    postalCode: string | null;
    housingGroup: string;
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
  rawEligibleSaleCount: number;
  housingTypeExcludedCount: number;
  methodology: {
    model: 'ordinary_least_squares';
    salePricesTimeAdjusted: false;
    minimumStrongSample: number;
    observationsPerParameter: number;
    minimumPredictorCoveragePercent: number;
  };
  population: {
    eligibleSaleCount: number;
    modelSaleCount: number;
    excludedIncompleteCount: number;
  };
  model: null | {
    intercept: number;
    rSquared: number;
    adjustedRSquared: number;
    rootMeanSquaredError: number;
    parameterCount: number;
    reliability: GroupedAdjustmentReliability;
  };
  coefficients: Array<{
    key: RegressionFeatureKey;
    label: string;
    unit: 'per_square_foot' | 'per_bath_equivalent' | 'per_garage_space' | 'per_feature' | 'per_year';
    coefficient: number;
    standardizedCoefficient: number | null;
    recommendedAdjustment: number;
    mean: number;
    standardDeviation: number;
    coverageCount: number;
    reliability: GroupedAdjustmentReliability;
  }>;
  warnings: string[];
  coverage: Array<{
    key: RegressionFeatureKey;
    label: string;
    count: number;
    percent: number;
  }>;
}

export type DepreciatedCostTarget = 'living_area' | 'garage' | 'pool';

export interface DepreciatedCostAdjustmentResponse {
  schema_version: 1;
  methodology: 'replacement_cost_new_less_depreciation';
  target_dimension: DepreciatedCostTarget;
  description: string;
  source_name: string | null;
  source_reference: string | null;
  as_of_date: string | null;
  unit_cost: number;
  local_multiplier: number;
  entrepreneurial_incentive_percent: number;
  depreciation_percent: number;
  factor_percent: number;
  direct_cost_per_unit: number;
  replacement_cost_new_per_unit: number;
  depreciation_per_unit: number;
  depreciated_cost_per_unit: number;
  recommended_adjustment: number;
  unit: 'per_square_foot' | 'per_garage_space' | 'per_feature';
  formula: string;
}

export interface SiteValuationEvidence {
  saleId: number | null;
  sourceRecordId: string | null;
  accountId: string | null;
  address: string | null;
  closingDate: string | null;
  salePrice: number;
  cadLandValue: number;
  cadImprovementValue: number;
  allocationRatio: number;
  siteSizeSquareFeet: number;
  allocatedSiteValue: number;
  siteValuePerSquareFoot: number;
}

export interface SiteValuationResponse {
  subject: {
    accountId: string;
    address: string | null;
    city: string | null;
    county: string | null;
    postalCode: string | null;
    siteSizeSquareFeet: number | null;
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
  methodology: {
    method: 'allocation';
    salePricesTimeAdjusted: false;
    allocationBasis: string;
    minimumStrongSample: 30;
  };
  population: {
    eligibleSaleCount: number;
    analyzedSaleCount: number;
    missingAllocationCount: number;
    missingSiteSizeCount: number;
  };
  statistics: null | {
    medianSiteValuePerSquareFoot: number;
    averageSiteValuePerSquareFoot: number;
    standardDeviation: number;
    coefficientOfDispersion: number;
    coefficientOfVariation: number;
    minimumSiteValuePerSquareFoot: number;
    maximumSiteValuePerSquareFoot: number;
  };
  options: Array<{
    id: 'median' | 'average';
    label: string;
    amount: number;
    reliability: 'strong' | 'moderate' | 'limited';
  }>;
  evidence: SiteValuationEvidence[];
  reliability: 'strong' | 'moderate' | 'limited';
  warnings: string[];
}

export type QualitativeClassification = 'inferior' | 'similar' | 'superior' | 'excluded';

export interface QualitativeSelectionInput {
  comparable_key: string;
  classification: QualitativeClassification;
  commentary?: string | null;
}

export interface QualitativeComparableInput {
  sale: SaleRow;
  indicatedValue: number;
}

export interface QualitativeAnalysisResponse {
  schema_version: 1;
  methodology: 'qualitative_bracketing';
  selections: Array<{
    comparable_key: string;
    comparable_number: number;
    address: string | null;
    classification: QualitativeClassification;
    commentary: string | null;
    indicated_value: number | null;
  }>;
  conclusion: {
    analyzed_count: number;
    inferior_count: number;
    similar_count: number;
    superior_count: number;
    excluded_count: number;
    lower_bound: number | null;
    upper_bound: number | null;
    similar_median: number | null;
    recommended_value: number | null;
    bracket_consistent: boolean;
    narrative: string;
    warnings: string[];
  };
  applied: boolean;
  calculated_at: string;
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

export interface NeighborhoodProfileResponse extends Omit<MarketConditionsResponse, 'analyses'> {
  analyses: Array<Omit<MarketConditionsAnalysis, 'series' | 'map_sales'>>;
  boundary_streets: {
    street_names: string[];
    cardinal_boundaries: Record<'north' | 'east' | 'south' | 'west', {
      primary_street: string | null;
      confidence: 'high' | 'medium' | 'low' | 'unavailable';
      candidates: Array<{
        name: string;
        score: number;
        distance_to_analysis_center_miles?: number;
        distance_to_analysis_edge_miles?: number;
        signed_distance_to_analysis_edge_miles?: number;
        analysis_edge_relation?: 'outside' | 'inside';
        corridor_key?: string;
        selected?: boolean;
      }>;
    }>;
    summary: string;
    source: string;
    retrieved_at: string;
    boundary_buffer_meters: number;
    review_required: boolean;
  } | null;
  boundary_street_warning: string | null;
}

export type NeighborhoodLandUseCategoryKey =
  | 'one_unit'
  | 'two_to_four_unit'
  | 'multifamily'
  | 'commercial'
  | 'other_vacant';

export interface NeighborhoodLandUseCategoryResult {
  key: NeighborhoodLandUseCategoryKey;
  label: string;
  parcel_count: number;
  area_sqft: number;
  area_acres: number;
  percentage: number;
}

export interface NeighborhoodLandUseReviewParcel {
  object_id: string | number | null;
  account_id: string | null;
  site_address: string | null;
  use_description: string | null;
  property_description: string | null;
  class_code: string | null;
  class_description: string | null;
  category: NeighborhoodLandUseCategoryKey;
  category_label: string;
  confidence: 'high' | 'medium' | 'low';
  review_reason: string;
  clipped_area_sqft: number;
  clipped_area_acres: number;
}

export interface NeighborhoodLandUseAnalysisResponse {
  subject_account_id: string;
  jurisdiction: 'Dallas County';
  source: string;
  source_url: string;
  source_mode?: 'local_mirror' | 'live_dcad';
  source_health?: PropertyContextSourceHealth | null;
  analyzed_at: string;
  methodology_version: number;
  boundary: GeoJsonPolygon;
  boundary_signature: string;
  boundary_area_acres: number;
  covered_parcel_area_acres: number;
  built_up_area_acres: number;
  built_up_percent: number;
  built_up_band: 'over_75' | '25_to_75' | 'under_25';
  built_up_label: 'Over 75%' | '25-75%' | 'Under 25%';
  built_up_parcel_count: number;
  subject_site_area_sqft: number | null;
  comparison_min_site_area_sqft: number | null;
  comparison_median_site_area_sqft: number | null;
  comparison_parcel_count: number;
  subject_smaller_than_all_comparisons: boolean;
  coverage_percent: number;
  overlap_percent: number;
  parcel_count: number;
  excluded_non_land_record_count: number;
  review_required_count: number;
  review_area_percent: number;
  confidence: 'high' | 'moderate' | 'limited';
  categories: NeighborhoodLandUseCategoryResult[];
  property_profile?: {
    population: 'all_one_unit_properties';
    property_count: number;
    house_price: NeighborhoodPropertyProfileMetric;
    price_per_square_foot: NeighborhoodPropertyProfileMetric;
    age: NeighborhoodPropertyProfileMetric;
    living_area: NeighborhoodPropertyProfileMetric;
    value_basis: string;
    denominator_note: string;
  };
  review_parcels: NeighborhoodLandUseReviewParcel[];
  review_parcels_truncated: boolean;
  warnings: string[];
  denominator_note: string;
  cache_hit: boolean;
  persistent_cache_hit?: boolean;
  stale_cache_used?: boolean;
  processing_duration_ms: number;
  cached_analysis_duration_ms: number | null;
}

export interface NeighborhoodPropertyProfileMetric {
  count: number;
  low: number | null;
  high: number | null;
  predominant: number | null;
}

export type PropertyComplexityLevel = 'simple' | 'moderate' | 'complex';

export interface PropertyContextSourceHealth {
  source_key: string;
  label: string;
  status: 'current' | 'stale' | 'unavailable';
  usable: boolean;
  serving_stale_data: boolean;
  row_count: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_source_update_at: string | null;
  age_hours: number | null;
  stale_after_hours: number;
  source_url: string | null;
  source_vintage: string | null;
  last_error: string | null;
}

export interface PropertyComplexityFactor {
  code: string;
  label: string;
  severity: 'low' | 'moderate' | 'high';
  points: number;
  detail: string;
  evidence?: Record<string, unknown>;
}

export interface PropertyComplexityAssessment {
  id: number;
  account_id: string;
  scope_key: string;
  assignment_file_id: number | null;
  methodology_version: number;
  computed_at: string;
  updated_at: string;
  automatic_complexity: PropertyComplexityLevel;
  effective_complexity: PropertyComplexityLevel;
  score: number;
  confidence: 'high' | 'moderate' | 'limited';
  geography: 'urban' | 'suburban' | 'semi_rural' | 'rural';
  recommended_search_profile: ComparableSearchProfileKey;
  factors: PropertyComplexityFactor[];
  warnings: string[];
  subject: {
    account_id: string;
    address: string | null;
    gross_living_area_sqft: number | null;
    year_built: number | null;
    actual_age: number | null;
    site_area_sqft: number | null;
    housing_type: string | null;
    attachment_type: string | null;
    amenities: Array<{ key: string; label: string; present: boolean }>;
  };
  peer_statistics: {
    peer_count: number;
    context: 'appraiser_defined_area' | 'two_mile_radius';
    radius_miles: number | null;
    gla: { count: number; percentile: number | null; median: number | null };
    age: { count: number; percentile: number | null; median: number | null };
    site_area: { count: number; percentile: number | null; median: number | null };
    pool_prevalence_percent: number | null;
  };
  spatial_context: {
    parcel_available: boolean;
    parcel_match_method: string | null;
    subject_site_area_sqft: number | null;
    site_percentile: number | null;
    site_comparison_count: number;
    parcel_compactness: number | null;
    corner_lot: boolean;
    road_frontage_count: number;
    road_frontages: string[];
    nearest_major_road: {
      name: string | null;
      road_class: string;
      distance_feet: number;
    } | null;
    nearest_railroad?: {
      name: string | null;
      distance_feet: number;
    } | null;
    nearest_high_traffic_road?: {
      name: string | null;
      route_prefix: string | null;
      route_number: string | null;
      roadway_type: string | null;
      annual_average_daily_traffic: number;
      distance_feet: number;
      source_date: string | null;
      synced_at: string | null;
      source: 'TxDOT AADT';
    } | null;
    zoning_context?: Record<string, unknown> | null;
    flood_context?: Record<string, unknown> | null;
    adjacent_influences: Array<Record<string, unknown>>;
    nearby_influences: Array<Record<string, unknown>>;
  };
  source_health: PropertyContextSourceHealth[];
  requires_appraiser_review: true;
  review_status: 'automatic' | 'reviewed' | 'overridden';
  appraiser_complexity: PropertyComplexityLevel | null;
  appraiser_notes: string | null;
  reviewer: string | null;
  reviewed_at: string | null;
}

export interface PropertyInfluenceSignature {
  methodology_version: number;
  context_available: boolean;
  material_influence_present: boolean;
  material_keys: string[];
  material_categories: string[];
  zoning_keys: string[];
  descriptors: string[];
  dominant_influence_key: string;
}

export interface PropertyContextStatusResponse {
  ok: true;
  offline_first: true;
  external_services_required_at_request_time: false;
  sources: PropertyContextSourceHealth[];
  usable_source_count: number;
  stale_source_count: number;
  unavailable_source_count: number;
  influence_context?: {
    current_methodology_version?: number;
    queue: Record<string, number>;
    coverage: {
      sale_account_count: number;
      measured_sale_account_count: number;
      missing_sale_account_count: number;
      coverage_percent: number;
    };
    migration?: {
      prior_version_sale_account_count: number;
      version_coverage: Record<string, number>;
      recalculation_in_progress: boolean;
    };
    unmatched_sales?: {
      review_required_record_count: number;
      included_in_account_coverage: false;
      coverage_note: string;
    };
  };
  zoning_source_hierarchy?: Array<{
    provider_key: string;
    provider_label: string;
    provider_type: 'official_municipal' | 'propzone_gridics';
    jurisdiction: string;
    priority: number;
    status: string;
    service_url?: string | null;
    service_layer?: number | null;
    configuration?: Record<string, unknown>;
    automation_status?: 'automatic' | 'manual_review';
    configured: boolean;
    request_path_dependency: false;
    last_success_at: string | null;
    last_error: string | null;
  }>;
  zoning_coverage?: {
    county: 'Dallas';
    municipality_count: number;
    automated_source_count: number;
    current_source_count: number;
    pending_initial_sync_count: number;
    manual_review_count: number;
    manual_review_jurisdictions: string[];
  };
  checked_at: string;
}

export interface NeighborhoodEngineReadinessResponse {
  county: string;
  measured_at: string;
  prototype_ready: boolean;
  production_ready: boolean;
  prototype_blockers: string[];
  production_blockers: string[];
  accounts: {
    total_accounts: number;
    parcel_accounts: number;
    year_built_accounts: number;
    site_size_accounts: number;
    coordinate_accounts: number;
    coverage: {
      parcel_geometry_percent: number;
      year_built_percent: number;
      site_size_percent: number;
      coordinate_percent: number;
    };
  };
  sales: {
    usable_sales: number;
    distinct_sale_accounts: number;
    coordinate_percent: number;
    year_built_percent: number;
    site_size_percent: number;
    price_percent: number;
  };
  roads: {
    segment_counts: Record<string, number>;
    required_roads_available: boolean;
    traffic_available: boolean;
  };
  zoning: {
    provider_count: number;
    district_count: number;
    available: boolean;
  };
  source_health: PropertyContextSourceHealth[];
  warnings: string[];
}

export interface NeighborhoodBoundaryAssessment {
  id: number;
  account_id: string;
  scope_key: string;
  assignment_file_id: number | null;
  methodology_version: number;
  status: 'generated' | 'confirmed' | 'rejected' | 'superseded';
  search_profile: string;
  discovery_radius_miles: number;
  input_signature: string;
  boundary: GeoJsonPolygon;
  evidence: {
    boundary_purpose?: string;
    broad_boundary_is_relevance_filter?: false;
    disclosure?: string;
    subject?: Record<string, unknown>;
    discovery?: {
      profile_key?: string;
      profile_label?: string;
      profile_source?: string;
      radius_miles?: number;
      candidate_count?: number;
      boundary_area_square_miles?: number | null;
      boundary_generation_mode?:
        | 'traffic_backed_traced_road_polygon'
        | 'traffic_backed_cardinal_road_enclosure'
        | 'parcel_discovery_shape_fallback'
        | 'radial_discovery_envelope';
      physical_characteristic_coverage_percent?: number;
    };
    roads?: {
      source?: string;
      retrieved_at?: string;
      summary?: string;
      street_names?: string[];
      cardinal_boundaries?: Record<'north' | 'east' | 'south' | 'west', {
        primary_street?: string | null;
        confidence?: string;
        candidates?: Array<{
          name: string;
          score: number;
          distance_to_analysis_center_miles?: number;
          distance_to_analysis_edge_miles?: number;
          signed_distance_to_analysis_edge_miles?: number;
          analysis_edge_relation?: 'outside' | 'inside';
          corridor_key?: string;
          selected?: boolean;
          representative_point?: [number, number] | null;
        }>;
      }>;
    };
    zoning?: Record<string, unknown>;
    warnings?: string[];
  };
  source_state: Record<string, unknown>;
  confidence: 'high' | 'moderate' | 'limited';
  review_required: boolean;
  reviewer: string | null;
  review_notes: string | null;
  confirmed_at: string | null;
  generated_at: string;
  updated_at: string;
}

export interface ZoningEvidenceDocument {
  id: number;
  provider_key: string;
  document_key: string;
  title: string;
  official_url: string;
  content_type: string;
  checksum_sha256: string;
  file_size_bytes: number;
  page_count: number | null;
  extraction_status: 'machine_readable' | 'review_required' | 'extraction_failed';
  extraction?: {
    extraction_method?: string;
    text_length?: number;
    review_reason?: string;
    candidates?: AssignmentDocumentCandidate[];
  };
  fetched_at: string;
  source_last_modified: string | null;
  content_url: string;
}

export interface ZoningVerification {
  id: number;
  account_id: string;
  assignment_file_id: number | null;
  provider_key: string;
  source_document_id: number | null;
  source_type: 'map_pdf' | 'interactive_map' | 'city_confirmation' | 'official_gis' | 'manual';
  zoning_code: string;
  zoning_description: string | null;
  page_number: number | null;
  confirmation_reference: string | null;
  notes: string | null;
  reviewer: string;
  verified_at: string;
}

export interface PropertyZoningEvidence {
  account: { account_id: string; address: string | null; city: string | null; county: string | null };
  jurisdiction: {
    city: string;
    provider_key: string;
    provider_label: string;
    automation_status: 'automatic' | 'manual_review';
    reference_url: string | null;
    contact: {
      department: string;
      contactName?: string | null;
      phone: string | null;
      planningPhone?: string | null;
      buildingPhone?: string | null;
      email: string | null;
      address: string | null;
      sourceUrl: string;
    } | null;
  } | null;
  review_required: boolean;
  review_reason: string | null;
  documents: ZoningEvidenceDocument[];
  automatic_result: {
    zoning_code: string | null;
    zoning_description: string | null;
    provider_key: string;
    source_record_id?: string | null;
    source_attributes?: Record<string, unknown> | null;
    source_updated_at: string | null;
    synced_at: string;
  } | null;
  suggested_result?: {
    zoning_code: string | null;
    zoning_description: string | null;
    provider_key: string;
    source_record_id?: string | null;
    source_attributes?: Record<string, unknown> | null;
    source_updated_at: string | null;
    synced_at: string | null;
    lookup_mode?: string | null;
  } | null;
  verification: ZoningVerification | null;
}

export async function getZoningDocumentDescriptionSuggestion(
  documentId: number,
  zoningCode: string,
): Promise<{
  ok: true;
  extraction_status: string;
  suggestion: AssignmentDocumentCandidate | null;
}> {
  return fetchJSON(makeUrl(
    `/api/zoning-source-documents/${documentId}/description-suggestion`,
    { zoning_code: zoningCode },
  ));
}

export interface AssignmentPhotoObject {
  id: string;
  variant: 'original' | 'display';
  file_name: string;
  content_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  status: 'pending_upload' | 'verified' | 'rejected';
}

export interface AssignmentPhoto {
  id: string;
  client_photo_id: string;
  origin_channel: 'mobile' | 'desktop';
  category: string;
  room_ref: string | null;
  room_label: string | null;
  caption: string | null;
  position: number;
  captured_at: string | null;
  status: 'pending_upload' | 'verifying' | 'verified' | 'failed';
  revision: number;
  verified_at: string | null;
  retention_until: string | null;
  required_retention_years: number;
  view_url: string | null;
  view_url_expires_in_seconds: number | null;
  objects: AssignmentPhotoObject[];
}

export interface AssignmentPhotoUploadRequest {
  client_photo_id: string;
  category: string;
  caption?: string;
  captured_at?: string;
  objects: Array<{
    client_object_id: string;
    variant: 'original' | 'display';
    file_name: string;
    content_type: string;
    byte_size: number;
    width?: number | null;
    height?: number | null;
  }>;
}

export interface AssignmentPhotoUploadResponse {
  photo: AssignmentPhoto;
  uploads: Array<{
    object_id: string;
    variant: 'original' | 'display';
    method: 'PUT';
    url: string;
    headers: Record<string, string>;
    expires_in_seconds: number;
  }>;
}

export async function getAssignmentPhotos(
  accountId: string,
  assignmentFileId: number,
  editorKey: string,
): Promise<{
  workfile_status: string;
  version: string;
  evidence_version: string;
  photo_version: string;
  sketch_revision: number | null;
  photos: AssignmentPhoto[];
}> {
  return fetchJSON(makeUrl(
    `/api/accounts/${encodeURIComponent(accountId.trim())}/assignment-files/${assignmentFileId}/photos`,
  ), {
    headers: { 'x-homenode-editor-key': editorKey },
    retryTransient: true,
  });
}

export interface EvidenceVersion {
  evidence_version: string;
  photo_version: string;
  verified_photo_count: number;
  sketch_revision: number | null;
  sketch_review_status: 'draft' | 'appraiser_confirmed' | null;
  sketch_updated_at: string | null;
}

export interface AssignmentEvidenceVersion extends EvidenceVersion {
  workfile_status: string;
}

export async function getAssignmentEvidenceVersion(
  accountId: string,
  assignmentFileId: number,
  editorKey: string,
): Promise<AssignmentEvidenceVersion> {
  return fetchJSON(makeUrl(
    `/api/accounts/${encodeURIComponent(accountId.trim())}/assignment-files/${assignmentFileId}/evidence/version`,
  ), {
    headers: { 'x-homenode-editor-key': editorKey },
    cache: 'no-store',
    timeoutMs: 10_000,
    retryTransient: true,
  });
}

export async function getAssignmentPhotoVersion(
  accountId: string,
  assignmentFileId: number,
  editorKey: string,
): Promise<{ workfile_status: string; version: string; photo_count: number }> {
  return fetchJSON(makeUrl(
    `/api/accounts/${encodeURIComponent(accountId.trim())}/assignment-files/${assignmentFileId}/photos/version`,
  ), {
    headers: { 'x-homenode-editor-key': editorKey },
    cache: 'no-store',
    timeoutMs: 10_000,
    retryTransient: true,
  });
}

export async function createAssignmentPhotoUpload(
  accountId: string,
  assignmentFileId: number,
  input: AssignmentPhotoUploadRequest,
  editorKey: string,
): Promise<AssignmentPhotoUploadResponse> {
  return fetchJSON(makeUrl(
    `/api/accounts/${encodeURIComponent(accountId.trim())}/assignment-files/${assignmentFileId}/photos/upload-requests`,
  ), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-homenode-editor-key': editorKey },
    body: JSON.stringify(input),
  });
}

export async function uploadAssignmentPhotoObjectViaApi(
  accountId: string,
  assignmentFileId: number,
  photoId: string,
  objectId: string,
  content: Blob,
  editorKey: string,
): Promise<void> {
  await fetchJSON(makeUrl(
    `/api/accounts/${encodeURIComponent(accountId.trim())}/assignment-files/${assignmentFileId}`
      + `/photos/${encodeURIComponent(photoId)}/objects/${encodeURIComponent(objectId)}/content`,
  ), {
    method: 'PUT',
    headers: {
      'content-type': content.type || 'application/octet-stream',
      'x-homenode-editor-key': editorKey,
    },
    body: content,
    timeoutMs: 120_000,
  });
}

export async function verifyAssignmentPhotoUpload(
  accountId: string,
  assignmentFileId: number,
  photoId: string,
  editorKey: string,
): Promise<AssignmentPhoto> {
  const response = await fetchJSON<{ ok: true; photo: AssignmentPhoto }>(makeUrl(
    `/api/accounts/${encodeURIComponent(accountId.trim())}/assignment-files/${assignmentFileId}/photos/${encodeURIComponent(photoId)}/verify`,
  ), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-homenode-editor-key': editorKey },
    body: '{}',
  });
  return response.photo;
}

export async function updateAssignmentPhotoMetadata(
  accountId: string,
  assignmentFileId: number,
  photoId: string,
  input: { base_revision: number; category: string; caption: string },
  editorKey: string,
): Promise<AssignmentPhoto> {
  const response = await fetchJSON<{ ok: true; photo: AssignmentPhoto }>(makeUrl(
    `/api/accounts/${encodeURIComponent(accountId.trim())}/assignment-files/${assignmentFileId}/photos/${encodeURIComponent(photoId)}`,
  ), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-homenode-editor-key': editorKey },
    body: JSON.stringify(input),
  });
  return response.photo;
}

export async function removeAssignmentPhoto(
  accountId: string,
  assignmentFileId: number,
  photoId: string,
  editorKey: string,
): Promise<void> {
  await fetchJSON(makeUrl(
    `/api/accounts/${encodeURIComponent(accountId.trim())}/assignment-files/${assignmentFileId}/photos/${encodeURIComponent(photoId)}`,
  ), { method: 'DELETE', headers: { 'x-homenode-editor-key': editorKey } });
}

export type AssignmentDocumentType =
  | 'zoning_map'
  | 'zoning_ordinance'
  | 'purchase_contract'
  | 'engagement_letter'
  | 'mls_sheet'
  | 'district_evidence'
  | 'map'
  | 'other';

export interface AssignmentDocumentCandidate {
  id?: number;
  document_id?: number;
  field_key: string;
  raw_value: string;
  normalized_value: string | null;
  page_number: number | null;
  confidence: number | null;
  evidence_excerpt: string | null;
  extraction_method: string;
  review_status?: 'suggested' | 'confirmed' | 'rejected';
  confirmed_value?: string | null;
  reviewer?: string | null;
  reviewed_at?: string | null;
  assignment_application?: AssignmentDocumentApplication;
}

export interface AssignmentDocumentApplication {
  applied: boolean;
  reason?: string;
  revision?: number;
  assignment_details?: AssignmentDetailsPayload;
}

export interface AssignmentDocumentCandidateReview {
  id: number;
  document_id: number;
  candidate_id: number | null;
  field_key: string;
  raw_value: string;
  normalized_value: string | null;
  review_status: 'confirmed' | 'rejected';
  confirmed_value: string | null;
  reviewer: string;
  reviewed_at: string;
}

export interface AssignmentDocument {
  id: number;
  account_id: string;
  assignment_file_id: number | null;
  uad_workfile_id?: string | null;
  tax_protest_file_id?: string | null;
  report_file_id?: string | null;
  document_type: AssignmentDocumentType;
  title: string;
  file_name: string;
  content_type: string;
  checksum_sha256: string;
  file_size_bytes: number;
  page_count: number | null;
  processing_status: 'uploaded' | 'processing' | 'review_required' | 'ocr_required' | 'extraction_failed' | 'reviewed';
  processing_attempts: number;
  processing_started_at: string | null;
  next_processing_at: string | null;
  last_processing_error: string | null;
  extraction_method: string | null;
  extraction_summary: {
    text_length?: number;
    candidate_count?: number;
    review_reason?: string;
    error?: string;
    processing_attempts?: number;
    automatic_retry_exhausted?: boolean;
    subject_address_override?: {
      acknowledged?: boolean;
      reviewer?: string;
      acknowledged_at?: string;
      reason?: string;
      document_subject_address?: string;
      report_subject_address?: string;
      confirmed_candidate_ids?: number[];
    };
  };
  source_kind: 'upload' | 'official_url' | 'zoning_cache';
  source_url: string | null;
  uploaded_by: string | null;
  uploaded_at: string;
  processed_at: string | null;
  reviewed_at: string | null;
  content_url: string;
  candidate_count?: number;
  suggested_candidate_count?: number;
  candidates?: AssignmentDocumentCandidate[];
  review_history?: AssignmentDocumentCandidateReview[];
}

export async function getAssignmentDocuments(
  accountId: string,
  editorKey: string,
  assignmentFileId?: number | null,
): Promise<AssignmentDocument[]> {
  const response = await fetchJSON<{ ok: true; documents: AssignmentDocument[] }>(
    makeUrl(
      `/api/accounts/${encodeURIComponent(accountId.trim())}/documents`,
      { assignment_file_id: assignmentFileId || undefined },
    ),
    { headers: { 'x-homenode-editor-key': editorKey } },
  );
  return response.documents;
}

export async function getAssignmentDocument(
  documentId: number,
  editorKey: string,
): Promise<AssignmentDocument> {
  const response = await fetchJSON<{ ok: true; document: AssignmentDocument }>(
    makeUrl(`/api/documents/${documentId}`),
    { headers: { 'x-homenode-editor-key': editorKey } },
  );
  return response.document;
}

export async function getAssignmentDocumentContent(
  documentId: number,
  editorKey: string,
): Promise<Blob> {
  const response = await fetchWithApplicationAuthentication(makeUrl(`/api/documents/${documentId}/content`), {
    headers: { 'x-homenode-editor-key': editorKey },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error || `HTTP ${response.status}`);
  }
  return response.blob();
}

export async function deleteAssignmentDocument(
  documentId: number,
  editorKey: string,
): Promise<{ document_id: number; deleted: true; storage_deleted: boolean }> {
  const response = await fetchJSON<{
    ok: true;
    document_id: number;
    deleted: true;
    storage_deleted: boolean;
  }>(
    makeUrl(`/api/documents/${documentId}`),
    { method: 'DELETE', headers: { 'x-homenode-editor-key': editorKey } },
  );
  return response;
}

export async function uploadAssignmentDocument(
  accountId: string,
  file: File,
  metadata: {
    assignmentFileId?: number | null;
    documentType: AssignmentDocumentType;
    title?: string;
    uploadedBy?: string;
  },
  editorKey: string,
): Promise<AssignmentDocument> {
  const response = await fetchJSON<{ ok: true; document: AssignmentDocument }>(
    makeUrl(`/api/accounts/${encodeURIComponent(accountId.trim())}/documents`),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/pdf',
        'x-homenode-editor-key': editorKey,
        'x-assignment-file-id': metadata.assignmentFileId ? String(metadata.assignmentFileId) : '',
        'x-document-type': encodeURIComponent(metadata.documentType),
        'x-document-title': encodeURIComponent(metadata.title || file.name),
        'x-document-file-name': encodeURIComponent(file.name),
        'x-document-uploaded-by': encodeURIComponent(metadata.uploadedBy || ''),
      },
      body: file,
      timeoutMs: 120000,
    },
  );
  return response.document;
}

export async function reprocessAssignmentDocument(
  documentId: number,
  editorKey: string,
): Promise<AssignmentDocument> {
  const response = await fetchJSON<{ ok: true; document: AssignmentDocument }>(
    makeUrl(`/api/documents/${documentId}/reprocess`),
    { method: 'POST', headers: { 'x-homenode-editor-key': editorKey }, timeoutMs: 120000 },
  );
  return response.document;
}

export async function confirmAssignmentDocumentDespiteSubjectMismatch(
  documentId: number,
  input: {
    reviewer: string;
    reportSubjectAddress: string;
    candidateValues?: Record<number, string>;
  },
  editorKey: string,
): Promise<AssignmentDocument> {
  const response = await fetchJSON<{ ok: true; document: AssignmentDocument }>(
    makeUrl(`/api/documents/${documentId}/subject-address-override`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-homenode-editor-key': editorKey },
      body: JSON.stringify({
        reviewer: input.reviewer,
        report_subject_address: input.reportSubjectAddress,
        candidate_values: input.candidateValues || {},
      }),
    },
  );
  return response.document;
}

export async function confirmAllAssignmentDocumentCandidates(
  documentId: number,
  input: {
    reviewer: string;
    reportSubjectAddress?: string;
    candidateValues?: Record<number, string>;
  },
  editorKey: string,
): Promise<{ document: AssignmentDocument; assignmentApplication?: AssignmentDocumentApplication }> {
  const response = await fetchJSON<{
    ok: true;
    document: AssignmentDocument;
    assignment_application?: AssignmentDocumentApplication;
  }>(
    makeUrl(`/api/documents/${documentId}/confirm-all`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-homenode-editor-key': editorKey },
      body: JSON.stringify({
        reviewer: input.reviewer,
        report_subject_address: input.reportSubjectAddress || '',
        candidate_values: input.candidateValues || {},
      }),
    },
  );
  return { document: response.document, assignmentApplication: response.assignment_application };
}

export async function reviewAssignmentDocumentCandidate(
  documentId: number,
  candidateId: number,
  input: {
    reviewStatus: 'confirmed' | 'rejected';
    confirmedValue?: string;
    reviewer: string;
  },
  editorKey: string,
): Promise<AssignmentDocumentCandidate> {
  const response = await fetchJSON<{ ok: true; candidate: AssignmentDocumentCandidate }>(
    makeUrl(`/api/documents/${documentId}/candidates/${candidateId}`),
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-homenode-editor-key': editorKey },
      body: JSON.stringify({
        review_status: input.reviewStatus,
        confirmed_value: input.confirmedValue || '',
        reviewer: input.reviewer,
      }),
    },
  );
  return response.candidate;
}

export async function getPropertyZoningEvidence(
  accountId: string,
  assignmentFileId?: number | null,
): Promise<{ ok: true; account_id: string; evidence: PropertyZoningEvidence }> {
  return fetchJSON(makeUrl(
    `/api/accounts/${encodeURIComponent(String(accountId || '').trim())}/zoning-evidence`,
    { assignment_file_id: assignmentFileId || undefined },
  ));
}

export async function savePropertyZoningVerification(
  accountId: string,
  input: {
    assignment_file_id?: number | null;
    jurisdiction_city: string;
    source_document_id?: number | null;
    source_type: ZoningVerification['source_type'];
    zoning_code: string;
    zoning_description?: string;
    page_number?: number | null;
    confirmation_reference?: string;
    notes?: string;
    reviewer: string;
  },
  editorKey: string,
): Promise<{ ok: true; account_id: string; verification: ZoningVerification }> {
  return fetchJSON(makeUrl(
    `/api/accounts/${encodeURIComponent(String(accountId || '').trim())}/zoning-verification`,
  ), {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-homenode-editor-key': editorKey,
    },
    body: JSON.stringify(input),
  });
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

export interface CensusZipProfile {
  postal_code: string;
  geography_name: string | null;
  unemployment_percent: number;
  dataset: string;
  dataset_year: number;
  variable: string;
  source: string;
  retrieved_at: string;
}

export interface CensusCityProfile {
  city: string;
  state: string;
  state_fips: string;
  place_code: string | null;
  geography_name: string | null;
  unemployment_percent: number;
  dataset: string;
  dataset_year: number;
  variable: string;
  source: string;
  retrieved_at: string;
}

/** Load the official ACS 5-year unemployment estimate for a ZIP/ZCTA. */
export async function getCensusZipProfile(postalCode: string): Promise<CensusZipProfile> {
  const zip = String(postalCode || '').replace(/\D/g, '').slice(0, 5);
  return fetchJSON<CensusZipProfile>(
    makeUrl(`/api/census/zip-profile/${encodeURIComponent(zip)}`),
  );
}

/** Load the official ACS 5-year unemployment estimate for a city/place. */
export async function getCensusCityProfile(
  city: string,
  state = 'TX',
): Promise<CensusCityProfile> {
  const params = new URLSearchParams({ city: String(city || '').trim(), state });
  return fetchJSON<CensusCityProfile>(makeUrl(`/api/census/city-profile?${params.toString()}`));
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
export async function getAssignmentFiles(
  accountId: string,
  assignmentFileId?: number | null,
): Promise<AssignmentFilesResponse> {
  const id = (accountId || '').trim();
  return fetchJSON<AssignmentFilesResponse>(
    makeUrl(`/api/accounts/${encodeURIComponent(id)}/assignment-files`, {
      assignment_file_id: assignmentFileId || undefined,
    }),
  );
}

export async function getCanonicalReportFiles(
  accountId: string,
  workflowType: CanonicalReportWorkflow,
): Promise<CanonicalReportFilesResponse> {
  const id = (accountId || '').trim();
  return fetchJSON<CanonicalReportFilesResponse>(makeUrl(
    `/api/accounts/${encodeURIComponent(id)}/report-files`,
    { workflow_type: workflowType },
  ));
}

export async function createCanonicalReportFile(
  accountId: string,
  input: {
    workflow_type: CanonicalReportWorkflow;
    organization_id: string;
    client_request_id: string;
    previous_report_file_id?: string | null;
  },
): Promise<{ report_file: CanonicalReportFile; created: boolean }> {
  const id = (accountId || '').trim();
  return fetchJSON(makeUrl(`/api/accounts/${encodeURIComponent(id)}/report-files`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
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

export async function updateAssignmentFile(
  accountId: string,
  assignmentFileId: number,
  input: {
    assignment_details: AssignmentDetailsPayload;
    expected_revision: number;
    reviewer?: string;
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

export async function getCustomAppraisalWorkfile(
  accountId: string,
  assignmentFileId: number,
): Promise<{ ok: true; account_id: string; workfile: CustomAppraisalWorkfile }> {
  const id = (accountId || '').trim();
  return fetchJSON(
    makeUrl(
      `/api/accounts/${encodeURIComponent(id)}/assignment-files/${encodeURIComponent(String(assignmentFileId))}/workfile`,
    ),
  );
}

export async function saveCustomAppraisalWorkfileSection<T extends object>(
  accountId: string,
  assignmentFileId: number,
  sectionKey: string,
  input: {
    value: T;
    expected_revision: number;
    save_reason?: 'autosave' | 'manual_save' | 'legacy_import';
    reviewer?: string;
  },
  editorKey: string,
): Promise<{
  ok: true;
  account_id: string;
  assignment_file_id: number;
  section: CustomAppraisalWorkfileSection<T> & { key: string };
}> {
  const id = (accountId || '').trim();
  return fetchJSON(
    makeUrl(
      `/api/accounts/${encodeURIComponent(id)}/assignment-files/${encodeURIComponent(String(assignmentFileId))}/workfile/sections/${encodeURIComponent(sectionKey)}`,
    ),
    {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-homenode-editor-key': editorKey,
      },
      body: JSON.stringify(input),
    },
  );
}

/** Run the server-authoritative E&O preflight without changing the file. */
export async function getCustomAppraisalWorkfileReadiness(
  accountId: string,
  assignmentFileId: number,
  editorKey: string,
): Promise<{ ok: true; account_id: string; readiness: CustomAppraisalReadiness }> {
  const id = (accountId || '').trim();
  return fetchJSON(
    makeUrl(
      `/api/accounts/${encodeURIComponent(id)}/assignment-files/${encodeURIComponent(String(assignmentFileId))}/workfile/readiness`,
    ),
    { headers: { 'x-homenode-editor-key': editorKey } },
  );
}

/** Finalize the current file as an immutable, checksummed appraisal snapshot. */
export async function signCustomAppraisalWorkfile(
  accountId: string,
  assignmentFileId: number,
  input: { signed_by: string; acknowledged_warning_codes?: string[] },
  editorKey: string,
): Promise<{ ok: true; account_id: string; workfile: CustomAppraisalWorkfile }> {
  const id = (accountId || '').trim();
  const signatureEventId = getOrCreateCustomAppraisalSignatureEventId(id, assignmentFileId);
  const response = await fetchJSON<{
    ok: true;
    account_id: string;
    workfile: CustomAppraisalWorkfile;
  }>(
    makeUrl(
      `/api/accounts/${encodeURIComponent(id)}/assignment-files/${encodeURIComponent(String(assignmentFileId))}/workfile/sign`,
    ),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-homenode-editor-key': editorKey,
      },
      body: JSON.stringify({ ...input, signature_event_id: signatureEventId }),
    },
  );
  clearCustomAppraisalSignatureEventId(id, assignmentFileId, signatureEventId);
  return response;
}

/** Fetch the named database workfile (a live draft or immutable signed snapshot). */
export async function downloadCustomAppraisalWorkfile(
  accountId: string,
  assignmentFileId: number,
  editorKey: string,
): Promise<{ blob: Blob; fileName: string; immutable: boolean }> {
  const id = (accountId || '').trim();
  const response = await fetchWithApplicationAuthentication(
    makeUrl(
      `/api/accounts/${encodeURIComponent(id)}/assignment-files/${encodeURIComponent(String(assignmentFileId))}/workfile/download`,
    ),
    { headers: { 'x-homenode-editor-key': editorKey } },
  );
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const payload = await response.json();
      message = payload?.error || message;
    } catch {
      // The HTTP status remains actionable when a proxy returns plain text.
    }
    throw new Error(message);
  }
  const disposition = response.headers.get('content-disposition') || '';
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const quotedName = disposition.match(/filename="([^"]+)"/i)?.[1];
  const fileName = encodedName ? decodeURIComponent(encodedName) : quotedName || `custom-appraisal-${assignmentFileId}.json`;
  return {
    blob: await response.blob(),
    fileName,
    immutable: response.headers.get('x-homenode-immutable') === 'true',
  };
}

/** Download the fixed-layout server PDF for the current draft or signed file. */
export async function downloadCustomAppraisalReportPdf(
  accountId: string,
  assignmentFileId: number,
  editorKey: string,
): Promise<{ blob: Blob; fileName: string; immutable: boolean; pageCount: number | null }> {
  const id = (accountId || '').trim();
  const response = await fetchWithApplicationAuthentication(
    makeUrl(
      `/api/accounts/${encodeURIComponent(id)}/assignment-files/${encodeURIComponent(String(assignmentFileId))}/workfile/report.pdf`,
    ),
    { headers: { 'x-homenode-editor-key': editorKey } },
  );
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const payload = await response.json();
      message = Array.isArray(payload?.readiness_errors) && payload.readiness_errors.length
        ? `${payload.error}: ${payload.readiness_errors.join(' ')}`
        : payload?.error || message;
    } catch {
      // Preserve the HTTP status when an upstream proxy returns plain text.
    }
    throw new Error(message);
  }
  const disposition = response.headers.get('content-disposition') || '';
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const quotedName = disposition.match(/filename="([^"]+)"/i)?.[1];
  const pages = Number(response.headers.get('x-homenode-report-pages'));
  return {
    blob: await response.blob(),
    fileName: encodedName ? decodeURIComponent(encodedName) : quotedName || `custom-appraisal-${assignmentFileId}.pdf`,
    immutable: response.headers.get('x-homenode-immutable') === 'true',
    pageCount: Number.isSafeInteger(pages) && pages > 0 ? pages : null,
  };
}

/** Save a desktop review as the next immutable mobile-sketch revision. */
export async function updateMobileInspectionSketch(
  accountId: string,
  assignmentFileId: number,
  input: {
    sketch: NonNullable<AppraisalAssignmentFile['mobile_inspection_sketch']>['document'];
    expected_revision: number;
    reviewer?: string;
    client_operation_id?: string;
  },
  editorKey: string,
): Promise<{
  ok: true;
  sketch: NonNullable<AppraisalAssignmentFile['mobile_inspection_sketch']>;
  report_registry_revision: number;
}> {
  const id = (accountId || '').trim();
  return withDesktopSketchSaveOperation(
    'custom-appraisal',
    id,
    assignmentFileId,
    input.expected_revision,
    (operationId) => fetchJSON<{
      ok: true;
      sketch: NonNullable<AppraisalAssignmentFile['mobile_inspection_sketch']>;
      report_registry_revision: number;
    }>(
      makeUrl(
        '/api/accounts/'
          + encodeURIComponent(id)
          + '/assignment-files/'
          + encodeURIComponent(String(assignmentFileId))
          + '/mobile-sketch',
      ),
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-homenode-editor-key': editorKey,
        },
        body: JSON.stringify({ ...input, client_operation_id: operationId }),
        retryTransient: true,
      },
    ),
    input.client_operation_id,
  );
}

/** Save a Property Tax Protest sketch through the authenticated desktop workflow. */
export async function updatePropertyTaxInspectionSketch(
  accountId: string,
  fileId: string,
  sketch: EditableInspectionSketch,
  document: EditableInspectionSketch['document'],
): Promise<EditableInspectionSketch> {
  return withDesktopSketchSaveOperation(
    'property-tax-protest',
    accountId,
    fileId,
    sketch.revision,
    async (operationId) => {
      const response = await fetchJSON<{ sketch: EditableInspectionSketch }>(
        makeUrl(
          `/api/accounts/${encodeURIComponent(accountId)}`
            + `/property-tax-protest/${encodeURIComponent(fileId)}/sketch`,
        ),
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            client_operation_id: operationId,
            expected_revision: sketch.revision,
            sketch: document,
            reviewer: 'HomeNode appraiser',
          }),
          retryTransient: true,
        },
      );
      return response.sketch;
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
  return fetchJSON<SalesReconciliationQueueResponse>(url, {
    timeoutMs: 90000,
    retryTransient: true,
  });
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
  verified_parcel_id: string;
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

const neighborhoodProfileCache = createTimedRequestCache<NeighborhoodProfileResponse>(5 * 60_000);

/** Refresh the saved custom neighborhood, citywide comparison, and boundary street candidates. */
export async function getNeighborhoodProfile(
  request: Omit<MarketConditionsRequest, 'areaKeys'>,
  { force = false }: { force?: boolean } = {},
): Promise<NeighborhoodProfileResponse> {
  const url = makeUrl('/api/sales/neighborhood-profile');
  const payload = {
    subject_account_id: request.subjectAccountId.trim(),
    as_of: request.asOf,
    period_months: request.periodMonths,
    custom_geometry: request.customGeometry || null,
    context_override: request.contextOverride || null,
  };
  const cacheKey = JSON.stringify(payload);
  return neighborhoodProfileCache.load(cacheKey, () => fetchJSON<NeighborhoodProfileResponse>(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...payload, force_refresh: force }),
      timeoutMs: 120000,
    }), { force });
}

/** Calculate present land use from every official DCAD parcel in the saved custom boundary. */
export async function runNeighborhoodLandUseAnalysis(
  subjectAccountId: string,
  customGeometry: GeoJsonPolygon,
): Promise<NeighborhoodLandUseAnalysisResponse> {
  return fetchJSON<NeighborhoodLandUseAnalysisResponse>(
    makeUrl('/api/sales/neighborhood-land-use'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subject_account_id: subjectAccountId.trim(),
        custom_geometry: customGeometry,
      }),
      timeoutMs: 180000,
      retryTransient: true,
    },
  );
}

/** Load the most recently saved offline property-context assessment. */
export async function getPropertyContextAssessment(
  accountId: string,
  assignmentFileId?: number | null,
): Promise<PropertyComplexityAssessment | null> {
  const response = await fetchJSON<{
    account_id: string;
    assessment: PropertyComplexityAssessment | null;
  }>(makeUrl(`/api/accounts/${encodeURIComponent(accountId.trim())}/property-context`, {
    assignment_file_id: assignmentFileId || undefined,
  }));
  return response.assessment;
}

/** Recalculate complexity exclusively from locally stored data. */
export async function analyzePropertyContext(
  accountId: string,
  options: {
    assignmentFileId?: number | null;
    customGeometry?: GeoJsonPolygon | null;
    geography?: string | null;
  } = {},
): Promise<PropertyComplexityAssessment> {
  const response = await fetchJSON<{
    ok: true;
    account_id: string;
    assessment: PropertyComplexityAssessment;
  }>(makeUrl(`/api/accounts/${encodeURIComponent(accountId.trim())}/property-context/analyze`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      assignment_file_id: options.assignmentFileId || null,
      custom_geometry: options.customGeometry || null,
      geography: options.geography || null,
    }),
    timeoutMs: 90000,
  });
  return response.assessment;
}

/** Confirm or override the automatic complexity determination. */
export async function savePropertyContextReview(
  accountId: string,
  update: {
    assignmentFileId?: number | null;
    complexity: PropertyComplexityLevel;
    notes?: string;
    reviewer?: string;
  },
): Promise<PropertyComplexityAssessment> {
  const response = await fetchJSON<{
    ok: true;
    account_id: string;
    assessment: PropertyComplexityAssessment;
  }>(makeUrl(`/api/accounts/${encodeURIComponent(accountId.trim())}/property-context`), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      assignment_file_id: update.assignmentFileId || null,
      complexity: update.complexity,
      notes: update.notes || '',
      reviewer: update.reviewer || 'HomeNode appraiser',
    }),
  });
  return response.assessment;
}

/** Show local source freshness without calling Dallas CAD or Census services. */
export async function getPropertyContextStatus(): Promise<PropertyContextStatusResponse> {
  return fetchJSON<PropertyContextStatusResponse>(makeUrl('/api/property-context/status'));
}

/** Audit locally stored inputs before enabling automated neighborhood generation. */
export async function getNeighborhoodEngineReadiness(
  county = 'Dallas',
): Promise<NeighborhoodEngineReadinessResponse> {
  return fetchJSON<NeighborhoodEngineReadinessResponse>(makeUrl('/api/neighborhood-engine/readiness', {
    county,
  }));
}

/** Load the latest assignment-specific broad boundary, falling back to the property result. */
export async function getNeighborhoodBoundary(
  accountId: string,
  assignmentFileId?: number | null,
): Promise<NeighborhoodBoundaryAssessment | null> {
  const response = await fetchJSON<{
    account_id: string;
    assessment: NeighborhoodBoundaryAssessment | null;
  }>(makeUrl(`/api/accounts/${encodeURIComponent(accountId.trim())}/neighborhood-boundary`, {
    assignment_file_id: assignmentFileId || undefined,
  }));
  return response.assessment;
}

/** Generate and persist an outage-tolerant broad boundary from local PostGIS mirrors. */
export async function generateNeighborhoodBoundary(
  accountId: string,
  options: {
    assignmentFileId?: number | null;
    searchProfile?: string | null;
    discoveryRadiusMiles?: number | null;
  } = {},
): Promise<NeighborhoodBoundaryAssessment> {
  const response = await fetchJSON<{
    ok: true;
    account_id: string;
    assessment: NeighborhoodBoundaryAssessment;
  }>(makeUrl(`/api/accounts/${encodeURIComponent(accountId.trim())}/neighborhood-boundary/generate`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      assignment_file_id: options.assignmentFileId || null,
      search_profile: options.searchProfile || null,
      discovery_radius_miles: options.discoveryRadiusMiles ?? null,
    }),
    timeoutMs: 120000,
  });
  return response.assessment;
}

/** Persist the appraiser's confirmation independently for the current assignment file. */
export async function reviewNeighborhoodBoundary(
  accountId: string,
  assessmentId: number,
  options: {
    assignmentFileId?: number | null;
    confirmed: boolean;
    reviewer?: string;
    notes?: string;
  },
): Promise<NeighborhoodBoundaryAssessment> {
  const response = await fetchJSON<{
    ok: true;
    account_id: string;
    assessment: NeighborhoodBoundaryAssessment;
  }>(makeUrl(
    `/api/accounts/${encodeURIComponent(accountId.trim())}/neighborhood-boundary/${assessmentId}`,
  ), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      assignment_file_id: options.assignmentFileId || null,
      confirmed: options.confirmed,
      reviewer: options.reviewer || 'HomeNode appraiser',
      notes: options.notes || '',
    }),
  });
  return response.assessment;
}

/** Load the latest independent relevance-population summary for the file. */
export async function getNeighborhoodRelevance(
  accountId: string,
  assignmentFileId?: number | null,
): Promise<NeighborhoodRelevanceAssessment | null> {
  const response = await fetchJSON<{
    account_id: string;
    assessment: NeighborhoodRelevanceAssessment | null;
  }>(makeUrl(`/api/accounts/${encodeURIComponent(accountId.trim())}/neighborhood-relevance`, {
    assignment_file_id: assignmentFileId || undefined,
  }));
  return response.assessment;
}

/** Score and persist the relevant property population for a saved broad boundary. */
export async function generateNeighborhoodRelevance(
  accountId: string,
  options: {
    assignmentFileId?: number | null;
    boundaryAssessmentId?: number | null;
  } = {},
): Promise<NeighborhoodRelevanceAssessment> {
  const response = await fetchJSON<{
    ok: true;
    account_id: string;
    assessment: NeighborhoodRelevanceAssessment;
  }>(makeUrl(`/api/accounts/${encodeURIComponent(accountId.trim())}/neighborhood-relevance/generate`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      assignment_file_id: options.assignmentFileId || null,
      boundary_assessment_id: options.boundaryAssessmentId || null,
    }),
    timeoutMs: 120000,
  });
  return response.assessment;
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
  const subtitle = mvText ? `${row.account_id} ? ${mvText}` : row.account_id;

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

// Older code imports `PropertyDetail` ? map it to the current `AccountDetail` shape.
export type PropertyDetail = AccountDetail;

// Older code imports `fetchPropertyDetail` ? reuse the existing fetchProperty/getAccount logic.
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

export interface PropertyTaxProtestFile {
  report_file_id: string;
  tax_protest_file_id: string;
  organization_id: string;
  account_id: string;
  file_number: string;
  previous_file_id: string | null;
  workfile_data: Record<string, unknown>;
  status: string;
  revision: number;
  registry_revision: number;
  is_current: boolean;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  evidence_version?: string;
  photo_version?: string;
  verified_photo_count?: number;
  sketch_revision?: number | null;
  sketch_review_status?: 'draft' | 'appraiser_confirmed' | null;
  sketch_updated_at?: string | null;
  photos: {
    verified_count: number;
    items: Array<{
      id: string;
      category: string;
      room_label: string | null;
      caption: string | null;
      position: number;
      verified_at: string;
      retention_until: string;
    }>;
  };
  sketch: AppraisalAssignmentFile['mobile_inspection_sketch'];
}

export type EditableInspectionSketch = NonNullable<AppraisalAssignmentFile['mobile_inspection_sketch']>;

/** Fit an auditable same-housing-type OLS model inside one selected market area. */
export async function runRegressionAnalysis(request: {
  subjectAccountId: string;
  marketKey: MarketConditionsAreaKey;
  asOf?: string;
  customGeometry?: GeoJsonPolygon | null;
}): Promise<RegressionAnalysisResponse> {
  return fetchJSON<RegressionAnalysisResponse>(makeUrl('/api/sales/regression-analysis'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      subject_account_id: request.subjectAccountId.trim(),
      market_key: request.marketKey,
      as_of: request.asOf,
      custom_geometry: request.customGeometry || null,
    }),
    timeoutMs: 120000,
  });
}

/** Recalculate a replacement-cost-new-less-depreciation adjustment on the server. */
export async function calculateDepreciatedCostAdjustment(request: {
  targetDimension: DepreciatedCostTarget;
  description: string;
  unitCost: number;
  localMultiplier: number;
  entrepreneurialIncentivePercent: number;
  depreciationPercent: number;
  factorPercent: number;
  sourceName?: string | null;
  sourceReference?: string | null;
  asOfDate?: string | null;
}): Promise<DepreciatedCostAdjustmentResponse> {
  return fetchJSON<DepreciatedCostAdjustmentResponse>(makeUrl('/api/sales/depreciated-cost-adjustment'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      target_dimension: request.targetDimension,
      description: request.description,
      unit_cost: request.unitCost,
      local_multiplier: request.localMultiplier,
      entrepreneurial_incentive_percent: request.entrepreneurialIncentivePercent,
      depreciation_percent: request.depreciationPercent,
      factor_percent: request.factorPercent,
      source_name: request.sourceName || null,
      source_reference: request.sourceReference || null,
      as_of_date: request.asOfDate || null,
    }),
  });
}

/** Run an allocation-method site valuation inside one selected market area. */
export async function runSiteValuation(request: {
  subjectAccountId: string;
  marketKey: MarketConditionsAreaKey;
  asOf?: string;
  customGeometry?: GeoJsonPolygon | null;
}): Promise<SiteValuationResponse> {
  return fetchJSON<SiteValuationResponse>(makeUrl('/api/sales/site-valuation'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      subject_account_id: request.subjectAccountId.trim(),
      market_key: request.marketKey,
      as_of: request.asOf,
      custom_geometry: request.customGeometry || null,
    }),
    timeoutMs: 120000,
  });
}

/** Calculate or apply a qualitative bracketing conclusion on the server. */
export async function runQualitativeAnalysis(request: {
  comparables: QualitativeComparableInput[];
  selections: QualitativeSelectionInput[];
  applied?: boolean;
}): Promise<QualitativeAnalysisResponse> {
  return fetchJSON<QualitativeAnalysisResponse>(makeUrl('/api/sales/qualitative-analysis'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      comparables: request.comparables,
      selections: request.selections,
      applied: request.applied === true,
    }),
  });
}
