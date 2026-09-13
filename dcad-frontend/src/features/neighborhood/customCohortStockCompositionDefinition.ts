// Fixed browser admission counterpart; producer/checker parity tests pin these
// exact bytes to the server definition. This is descriptive, not a scoring policy.
export const STOCK_COMPOSITION_PROFILE = {"id":"custom-current-stock-composition-v1","revision":1,"content_sha256":"27dc44aa824a4d09b65ae9b96051613fff7731bd3494b8844dfecfbfd15e1ce8"} as const;
export const STOCK_COMPOSITION_DEFINITION = {
  "id": "custom-current-stock-composition-v1",
  "revision": 1,
  "basis": "within_context_binned_current_stock_observations",
  "authority": "not_established",
  "limits": {
    "accounts": 50000,
    "groups": 1025,
    "output_utf8_bytes": 256000
  },
  "numeric_fields": [
    "gla_sqft",
    "year_built",
    "site_area_sqft"
  ],
  "numeric_units": [
    "ft2",
    "year",
    "ft2"
  ],
  "numeric_states": [
    "observed",
    "partial",
    "missing",
    "invalid",
    "conflicting"
  ],
  "numeric_count_shape": [
    "state_counts",
    "bin_counts"
  ],
  "housing_count_shape": [
    "state_counts",
    "category_counts"
  ],
  "population_shape": [
    "member_count",
    "numeric_counts",
    "housing_counts"
  ],
  "pocket_shape": [
    "original_pocket_id",
    "member_count",
    "numeric_counts",
    "housing_counts"
  ],
  "subject_numeric_shape": [
    "state",
    "value",
    "origin"
  ],
  "subject_housing_shape": [
    "state",
    "category",
    "origin"
  ],
  "subject_numeric_states": [
    "observed",
    "missing",
    "invalid",
    "conflicting",
    "json_null",
    "ambiguous_rows"
  ],
  "subject_origins": [
    "saved_subject",
    "retained_subject_public",
    "current_subject_cad"
  ],
  "housing_states": [
    "observed",
    "missing",
    "unknown",
    "partial",
    "conflicting"
  ],
  "housing_categories": [
    "detached_single_family",
    "townhouse",
    "condominium",
    "duplex",
    "apartment",
    "mobile_home",
    "manufactured_home"
  ],
  "housing_profiles": [
    {
      "id": "custom-recorded-housing-v1",
      "revision": 1,
      "content_sha256": "12871b3b6251f507a19b1ac20e45df07ace43f6d10654ee513f314ad830de391"
    },
    {
      "id": "custom-recorded-housing-v2",
      "revision": 2,
      "content_sha256": "636415258d1f8d1e74ab1aac1f5592ea5f3d634153225bd138113a63d993f135"
    }
  ],
  "denominator": "every_unique_account_once_in_exact_original_leaf_partition_including_nonempty_unassigned",
  "numeric_values": "existing_preview_number_values_only;existing_decimal_conflicts_remain_conflicting",
  "partial": "observed_cell_with_missing_record_count_above_zero;included_in_bins_and_separate_partial_state",
  "binning": {
    "method": "type_7",
    "fractions": [
      0.25,
      0.5,
      0.75
    ],
    "reference": "all_observed_and_partial_unique_accounts_in_same_context",
    "interpolation": "sorted[lower]*(1-fractional_position)+sorted[upper]*fractional_position",
    "intervals": [
      "(-infinity,q1)",
      "[q1,q2)",
      "[q2,q3)",
      "[q3,infinity)"
    ],
    "equality": "ties_go_right;repeated_cuts_retained;zero_width_bins_remain_empty",
    "empty": "null_cuts_and_four_zero_counts",
    "comparison": "within_exact_context_only;bin_equality_is_not_full_distribution_equality"
  },
  "subject": "copy_existing_resolved_recommendation_observations;no_new_fallback_or_numeric_origin_inference",
  "reference": "exact_catalog_assigned_subject_leaf_only;frontend_may_union_its_explicit_review_family_leaf_ids",
  "limitations": [
    "descriptive_composition_not_calibrated_reliability",
    "not_sales_sample_representativeness",
    "provider_and_historical_population_coverage_not_established",
    "missing_states_are_not_imputed",
    "no_legal_subdivision_identity_or_name_family_inferred",
    "no_similarity_weight_score_or_selection_change"
  ]
} as const;
