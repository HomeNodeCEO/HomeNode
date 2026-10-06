import type { ComparableSearchProfileKey } from './api';

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
    context: 'appraiser_defined_area' | 'two_mile_radius' | 'market_studies';
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
