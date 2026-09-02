export type NeighborhoodMetricSummary = {
  count: number;
  low: number | null;
  high: number | null;
  median: number | null;
  average: number | null;
  cod: number | null;
  cv: number | null;
};

export interface NeighborhoodRelevanceAssessment {
  id: number;
  account_id: string;
  scope_key: string;
  assignment_file_id: number | null;
  boundary_assessment_id: number;
  methodology_version: number;
  input_signature: string;
  summary: {
    candidate_count: number;
    included_count: number;
    excluded_count: number;
    insufficient_data_count: number;
    low_relevance_excluded_count: number;
    dissimilar_pocket_excluded_count: number;
    classification_counts: Record<string, number>;
    score_range: { minimum: number | null; maximum: number | null };
    sale_history_months: number;
    sale_prices_time_adjusted: false;
    minimum_dissimilar_pocket_size: number;
    primary_population_threshold: number;
    primary_population_sale_count: number;
    primary_population_rule: 'all_system_relevant_pockets';
    selected_pocket_count: number;
    total_pocket_count: number;
    relevant_statistics?: {
      population_rule: 'all_system_relevant_pockets';
      reviewable_property_count: number;
      included_property_count: number;
      included_sale_count: number;
      sale_coverage_percent: number;
      composite_cod: number | null;
      reliability_score: number;
      property_profile: Record<string, NeighborhoodMetricSummary>;
      sales_profile: Record<string, NeighborhoodMetricSummary>;
    };
  };
  distributions: Record<string, unknown>;
  confidence: {
    confidence?: 'high' | 'moderate' | 'limited';
    counts?: Record<string, number>;
    coverage?: Record<string, number>;
    automatic_actions?: string[];
    appraiser_review_required?: boolean;
  };
  source_state: Record<string, unknown>;
  disclosure: string;
  generated_at: string;
  updated_at: string;
  visualization?: Array<{
    parcel_object_id: number;
    account_id: string | null;
    address: string | null;
    score: number | null;
    excluded: boolean;
    classification: string;
    cluster_id: string | null;
    pocket_id: string | null;
    pocket_size: number;
    system_selected: boolean;
    primary_population: boolean;
    recommended_population?: boolean;
    relevance_band: 'highest' | 'high' | 'relevant' | 'marginal' | 'low' | 'excluded' | 'insufficient_data';
    appraiser_override?: 'included' | 'removed' | null;
    same_subject_neighborhood: boolean;
    year_built: number | null;
    site_area_sqft: number | null;
    gla_sqft: number | null;
    market_value: number | null;
    sale_price: number | null;
    sale_date: string | null;
    sales: Array<{ sale_price: number; sale_date: string | null }>;
    distance_miles: number | null;
    point: { type: 'Point'; coordinates: [number, number] };
  }>;
}
