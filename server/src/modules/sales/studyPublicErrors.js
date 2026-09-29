// Fixed validation codes raised by the market-context and study services.
// Unknown upstream/DB exceptions must never become client-visible merely
// because their messages start with `invalid_`, `custom_`, or similar.
export const MARKET_STUDY_PUBLIC_ERRORS = new Set([
  "subject_not_found",
  "invalid_subject_account_id",
  "invalid_market_area",
  "invalid_market_period",
  "invalid_as_of",
  "market_areas_required",
  "market_area_limit_exceeded",
  "market_spatial_support_not_ready",
  "custom_area_must_be_polygon",
  "custom_area_coordinates_required",
  "custom_area_requires_three_points",
  "custom_area_too_many_vertices",
  "custom_area_ring_invalid",
  "custom_area_ring_not_closed",
  "custom_area_coordinate_invalid",
  "custom_area_outside_dfw_bounds",
  "custom_area_geometry_invalid",
  "custom_area_size_invalid",
]);

export const MARKET_ANALYSIS_PUBLIC_ERRORS = new Set([
  ...MARKET_STUDY_PUBLIC_ERRORS,
  "market_context_override_too_long",
  "invalid_market_context_override_source",
  "invalid_market_context_postal_code",
  "invalid_market_context_source_account_id",
  "market_context_coordinates_incomplete",
  "market_context_coordinates_outside_dfw",
  "market_context_override_empty",
]);

export const MARKET_CONTEXT_PUBLIC_ERRORS = new Set([
  "subject_not_found",
  "invalid_subject_account_id",
  "market_spatial_support_not_ready",
]);

export const DEPRECIATED_COST_PUBLIC_ERRORS = new Set([
  "depreciated_cost_description_required",
  "invalid_depreciated_cost_target",
  "invalid_depreciated_cost_number",
  "invalid_depreciated_cost_date",
]);
