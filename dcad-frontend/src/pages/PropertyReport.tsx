import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocation, useParams } from "react-router-dom";
import { fetchDetail } from "@/lib/dcad";
import {
  readAppraisalReportDraft,
  type AppraisalReportSalesDraft,
} from "@/lib/appraisalReportDraft";
import {
  createAssignmentFile,
  analyzePropertyContext as runPropertyContextAnalysis,
  getPropertyZoningEvidence,
  getZoningDocumentDescriptionSuggestion,
  getCensusCityProfile,
  getCensusZipProfile,
  getNeighborhoodProfile,
  getNeighborhoodBoundary,
  generateNeighborhoodBoundary as runNeighborhoodBoundaryGeneration,
  generateNeighborhoodRelevance as runNeighborhoodRelevanceGeneration,
  reviewNeighborhoodBoundary as saveNeighborhoodBoundaryReview,
  getPropertyContextAssessment,
  runNeighborhoodLandUseAnalysis,
  getAssignmentFiles,
  getAccountPhotos,
  getRelatedParcels,
  lookupAccountCensusGeography,
  savePropertyContextReview,
  savePropertyZoningVerification,
  updateAssignmentFile,
  updatePropertyReportSections,
  type AppraisalAssignmentFile,
  type AssignmentDocumentType,
  type AssignmentDetailsPayload,
  type NeighborhoodProfileResponse,
  type NeighborhoodBoundaryAssessment,
  type NeighborhoodRelevanceAssessment,
  type NeighborhoodLandUseAnalysisResponse,
  type PropertyComplexityAssessment,
  type PropertyComplexityLevel,
  type PropertyZoningEvidence,
  type ReportManualSectionKey,
  type RelatedParcelsResponse,
  makeUrl,
} from "@/lib/api";
import {
  readMarketConditionsDraft,
  type MarketConditionsDraft,
} from "@/lib/marketConditionsDraft";
import {
  calculateNeighborhoodRepresentativeness,
  DEFAULT_NEIGHBORHOOD_BOUNDARY_NARRATIVE,
  hasSavedNeighborhoodLandUseProfile,
  marketTrendFromChange,
  neighborhoodBoundaryReadinessErrors,
  neighborhoodLandUseTotal,
  NEIGHBORHOOD_ALL_PROPERTY_ROWS,
  NEIGHBORHOOD_CITY_AVERAGE_ROWS,
  NEIGHBORHOOD_LAND_USE_FIELDS,
  NEIGHBORHOOD_RANGE_ROWS,
} from "@/lib/neighborhoodCharacteristics";
import {
  determineNeighborhoodValuePosition,
  determineHighestBestUse,
  growthFromMarket,
  locationTypeFromLandUse,
  marketTrendFromRecommendation,
  marketingTimeFromMedianDom,
  reconciledMedianDaysOnMarket,
  type NeighborhoodLocationType,
} from "@/lib/neighborhoodAutomation";
import { UAD_CONDITION_RATINGS } from "@/lib/conditionQualityRatings";
import type { MarketAreaOrigin } from "@/lib/marketAreaGeometry";
import MarketConditionsAnalysis from "@/components/MarketConditionsAnalysis";
import DeferredReportSection from "@/components/DeferredReportSection";
import AssignmentDocumentCenter from "@/components/AssignmentDocumentCenter";

type DcadOwner = {
  owner_name?: string;
  mailing_address?: string;
  parties?: DcadOwnerParty[];
};

type DcadOwnerParty = {
  owner_name?: string;
  ownership_pct?: string | number;
};

type DcadValueSummary = {
  certified_year?: number | string;
  improvement_value?: string | number;
  land_value?: string | number;
  market_value?: string | number;
  capped_value?: string | number;
};

type DcadMainImprovement = {
  building_class?: string;
  year_built?: string | number;
  effective_year_built?: string | number;
  actual_age?: string | number;
  desirability?: string;
  living_area_sqft?: string | number;
  total_living_area?: string | number;
  total_area_sqft?: string | number;
  percent_complete?: string | number;
  stories?: number | string;
  construction_type?: string;
  foundation?: string;
  roof_type?: string;
  roof_material?: string;
  exterior_material?: string;
  basement?: boolean | string;
  heating?: string;
  air_conditioning?: string;
  bedroom_count?: string | number;
  bath_count?: string | number;
  baths_full?: string | number;
  baths_half?: string | number;
  kitchens?: string | number;
  wetbars?: string | number;
  fireplaces?: string | number;
  sprinkler?: boolean | string;
  spa?: boolean | string;
  pool?: boolean | string;
  sauna?: boolean | string;
  fence_type?: string;
  number_units?: string | number;
};

type DcadLandRow = {
  number?: string | number;
  state_code?: string;
  zoning?: string;
  frontage_ft?: string | number;
  depth_ft?: string | number;
  area_sqft?: string | number;
  pricing_method?: string;
  unit_price?: string | number;
  market_adjustment_pct?: string | number;
  adjusted_price?: string | number;
  ag_land?: string;
};

type DcadImprovementRow = {
  number?: string | number;
  improvement_type?: string;
  construction?: string;
  floor?: string;
  exterior_wall?: string;
  area_sqft?: string | number;
  value?: string | number;
  year_built?: string | number;
};

type DcadExemptionRow = {
  taxing_jurisdiction?: string;
  homestead_exemption?: string | number;
  disabled_vet?: string | number;
  taxable_value?: string | number;
};

type DcadExemptionsMap = {
  city?: DcadExemptionRow;
  school?: DcadExemptionRow;
  county?: DcadExemptionRow;
  college?: DcadExemptionRow;
  hospital?: DcadExemptionRow;
  special_district?: DcadExemptionRow;
};

type DcadSaleHistoryRow = {
  sale_id?: string | number;
  source_record_id?: string | number;
  listing_key?: string;
  listing_id?: string;
  source?: string;
  activity_date?: string;
  listing_date?: string;
  contract_date?: string;
  closing_date?: string;
  list_price?: string | number;
  sale_price?: string | number;
  days_on_market?: string | number;
  buyer_financing?: string;
  concessions?: string | number;
  mls_status?: string;
  record_type?: string;
  requires_additional_review?: boolean;
  data_quality_flags?: string[];
};

type DcadHousingProfile = {
  structural_style?: string;
  housing_type?: string;
  attachment_type?: string;
  architectural_style?: string;
  profile_source?: string;
};

type AssignmentDetails = AssignmentDetailsPayload;

type DcadDetail = {
  tax_year?: number;
  property_location?: {
    address?: string;
    neighborhood?: string;
    mapsco?: string;
    city?: string;
    state?: string;
    postal_code?: string;
    county?: string;
    subdivision?: string;
    census_tract?: string;
    census_tract_geoid?: string;
    census_tract_status?: string;
    census_vintage?: string;
  };
  owner?: DcadOwner;
  value_summary?: DcadValueSummary;
  main_improvement?: DcadMainImprovement;
  housing_profile?: DcadHousingProfile;
  additional_improvements?: DcadImprovementRow[];
  land_detail?: DcadLandRow[];
  exemptions?: DcadExemptionsMap;
  legal_description?: {
    lines?: string[];
    deed_transfer_date?: string;
  };
  sales_history?: DcadSaleHistoryRow[];
  property_activity_history?: DcadSaleHistoryRow[];
  census_geography?: {
    tract_geoid?: string;
    tract_code?: string;
    status?: string;
    vintage?: string;
    review_reason?: string;
  } | null;
  property_context?: PropertyComplexityAssessment | null;
  homestead_yes?: boolean;
  assignment_details?: AssignmentDetails;
  photos?: string[];
  report_manual_values?: Partial<Record<ReportManualSectionKey, unknown>>;
};

type EditableReportSection = {
  key: ReportManualSectionKey;
  title: string;
};

const EDITABLE_REPORT_SECTIONS: EditableReportSection[] = [
  { key: "report.subject_identification", title: "Subject Identification" },
  { key: "report.exemptions", title: "Current Exemptions" },
  { key: "report.sales_history", title: "Listings, Contracts, and Sales History" },
  { key: "report.property_characteristics", title: "Property Characteristics" },
  { key: "report.land_details", title: "Land Details" },
  { key: "report.appraisal_values", title: "Appraisal District Values" },
];

const HOA_FREQUENCY_OPTIONS = [
  ["per_year", "Per Year"],
  ["per_quarter", "Per Quarter"],
  ["per_month", "Per Month"],
  ["other", "Other"],
] as const;

const OCCUPANCY_OPTIONS = [
  ["owner", "Owner"],
  ["tenant", "Tenant"],
  ["vacant", "Vacant"],
  ["unknown", "Unknown"],
] as const;

const ASSIGNMENT_TYPE_OPTIONS = [
  ["purchase_transaction", "Purchase Transaction"],
  ["refinance", "Refinance"],
  ["heloc", "HELOC"],
  ["rtl", "RTL"],
  ["bridge_loan", "Bridge Loan"],
  ["new_construction", "New Construction"],
  ["rehab", "Rehab"],
  ["dscr", "DSCR"],
  ["other", "Other"],
] as const;

const CONTRACT_AMOUNT_FIELDS = [
  ["contract_price", "Contract Price"],
  ["loan_amount", "Loan Amount"],
  ["down_payment", "Down Payment"],
  ["earnest_money", "Earnest Money"],
  ["seller_concessions", "Seller Concessions"],
] as const;

const SUBJECT_NONCONFORMITY_OPTIONS = [
  ["under_improvement", "Under-Improvement"],
  ["over_improvement", "Over-Improvement"],
  ["functional_obsolescence", "Functional Obsolescence"],
  ["other", "Other"],
] as const;

const NEIGHBORHOOD_CHOICE_GROUPS = [
  {
    label: "Location Type",
    field: "neighborhood_location_type",
    options: [["urban", "Urban"], ["suburban", "Suburban"], ["rural", "Rural"]],
  },
  {
    label: "% Built-Up",
    field: "neighborhood_built_up",
    options: [["over_75", "Over 75%"], ["25_to_75", "25-75%"], ["under_25", "Under 25%"]],
  },
  {
    label: "Overall Growth",
    field: "neighborhood_growth",
    options: [["rapid", "Rapid"], ["stable", "Stable"], ["slow", "Slow"]],
  },
  {
    label: "Market Trends",
    field: "neighborhood_market_trend",
    options: [["increasing", "Increasing"], ["stable", "Stable"], ["declining", "Declining"]],
  },
  {
    label: "Demand / Supply",
    field: "neighborhood_demand_supply",
    options: [["shortage", "Shortage"], ["in_balance", "In Balance"], ["over_supply", "Over Supply"]],
  },
  {
    label: "Marketing Time",
    field: "neighborhood_marketing_time",
    options: [["under_3_months", "Under 3 Months"], ["3_to_6_months", "3-6 Months"], ["over_6_months", "Over 6 Months"]],
  },
] as const;

function assignmentDraftFromDetail(value?: AssignmentDetails): AssignmentDetails {
  return {
    subject_condition_rating: value?.subject_condition_rating || "",
    subject_condition_notes: value?.subject_condition_notes || "",
    significant_physical_deficiencies:
      typeof value?.significant_physical_deficiencies === "boolean"
        ? value.significant_physical_deficiencies
        : null,
    subject_conforms_to_neighborhood:
      typeof value?.subject_conforms_to_neighborhood === "boolean"
        ? value.subject_conforms_to_neighborhood
        : null,
    subject_nonconformity_type: value?.subject_nonconformity_type || "",
    subject_nonconformity_explanation: value?.subject_nonconformity_explanation || "",
    pud: Boolean(value?.pud),
    hoa_dues_amount: value?.hoa_dues_amount || "",
    hoa_frequency: value?.hoa_frequency || "",
    hoa_explanation: value?.hoa_explanation || "",
    occupancy: value?.occupancy || "",
    occupancy_explanation: value?.occupancy_explanation || "",
    assignment_types: cloneEditorValue(value?.assignment_types || []),
    assignment_explanation: value?.assignment_explanation || "",
    lender_client_name: value?.lender_client_name || "",
    lender_client_address: value?.lender_client_address || "",
    subject_under_contract: Boolean(value?.subject_under_contract),
    contract_arms_length: typeof value?.contract_arms_length === "boolean"
      ? value.contract_arms_length
      : true,
    contract_seller_names: value?.contract_seller_names || "",
    contract_price: value?.contract_price || "",
    contract_date: value?.contract_date || "",
    loan_amount: value?.loan_amount || "",
    down_payment: value?.down_payment || "",
    earnest_money: value?.earnest_money || "",
    seller_concessions: value?.seller_concessions || "",
    seller_matches_public_records:
      typeof value?.seller_matches_public_records === "boolean"
        ? value.seller_matches_public_records
        : null,
    seller_mismatch_explanation: value?.seller_mismatch_explanation || "",
    neighborhood_land_use_one_unit_pct: value?.neighborhood_land_use_one_unit_pct ?? "",
    neighborhood_land_use_two_to_four_unit_pct:
      value?.neighborhood_land_use_two_to_four_unit_pct ?? "",
    neighborhood_land_use_multifamily_pct: value?.neighborhood_land_use_multifamily_pct ?? "",
    neighborhood_land_use_commercial_pct: value?.neighborhood_land_use_commercial_pct ?? "",
    neighborhood_land_use_other_vacant_pct:
      value?.neighborhood_land_use_other_vacant_pct ?? "",
    neighborhood_land_use_analysis_source:
      value?.neighborhood_land_use_analysis_source || "",
    neighborhood_land_use_analyzed_at: value?.neighborhood_land_use_analyzed_at || "",
    neighborhood_land_use_parcel_count: value?.neighborhood_land_use_parcel_count ?? "",
    neighborhood_land_use_review_count: value?.neighborhood_land_use_review_count ?? "",
    neighborhood_land_use_coverage_percent:
      value?.neighborhood_land_use_coverage_percent ?? "",
    neighborhood_land_use_confidence: value?.neighborhood_land_use_confidence || "",
    neighborhood_land_use_boundary_signature:
      value?.neighborhood_land_use_boundary_signature || "",
    neighborhood_built_up_pct: value?.neighborhood_built_up_pct ?? "",
    neighborhood_location_type: value?.neighborhood_location_type || "",
    neighborhood_built_up: value?.neighborhood_built_up || "",
    neighborhood_growth: value?.neighborhood_growth || "",
    neighborhood_unemployment_pct: value?.neighborhood_unemployment_pct ?? "",
    neighborhood_unemployment_zip: value?.neighborhood_unemployment_zip || "",
    neighborhood_unemployment_source: value?.neighborhood_unemployment_source || "",
    neighborhood_unemployment_dataset_year:
      value?.neighborhood_unemployment_dataset_year ?? "",
    neighborhood_unemployment_variable: value?.neighborhood_unemployment_variable || "",
    neighborhood_city_unemployment_pct: value?.neighborhood_city_unemployment_pct ?? "",
    neighborhood_city_unemployment_name: value?.neighborhood_city_unemployment_name || "",
    neighborhood_city_unemployment_source:
      value?.neighborhood_city_unemployment_source || "",
    neighborhood_city_unemployment_dataset_year:
      value?.neighborhood_city_unemployment_dataset_year ?? "",
    neighborhood_city_unemployment_variable:
      value?.neighborhood_city_unemployment_variable || "",
    neighborhood_market_trend: value?.neighborhood_market_trend || "",
    neighborhood_market_change_pct: value?.neighborhood_market_change_pct ?? "",
    neighborhood_median_dom: value?.neighborhood_median_dom ?? "",
    neighborhood_demand_supply: value?.neighborhood_demand_supply || "",
    neighborhood_marketing_time: value?.neighborhood_marketing_time || "",
    neighborhood_house_price_low: value?.neighborhood_house_price_low ?? "",
    neighborhood_house_price_high: value?.neighborhood_house_price_high ?? "",
    neighborhood_house_price_predominant: value?.neighborhood_house_price_predominant ?? "",
    neighborhood_ppsf_low: value?.neighborhood_ppsf_low ?? "",
    neighborhood_ppsf_high: value?.neighborhood_ppsf_high ?? "",
    neighborhood_ppsf_predominant: value?.neighborhood_ppsf_predominant ?? "",
    neighborhood_age_low: value?.neighborhood_age_low ?? "",
    neighborhood_age_high: value?.neighborhood_age_high ?? "",
    neighborhood_age_predominant: value?.neighborhood_age_predominant ?? "",
    neighborhood_gla_low: value?.neighborhood_gla_low ?? "",
    neighborhood_gla_high: value?.neighborhood_gla_high ?? "",
    neighborhood_gla_predominant: value?.neighborhood_gla_predominant ?? "",
    neighborhood_sale_count: value?.neighborhood_sale_count ?? "",
    neighborhood_all_property_count: value?.neighborhood_all_property_count ?? "",
    neighborhood_all_house_price_low: value?.neighborhood_all_house_price_low ?? "",
    neighborhood_all_house_price_high: value?.neighborhood_all_house_price_high ?? "",
    neighborhood_all_house_price_predominant:
      value?.neighborhood_all_house_price_predominant ?? "",
    neighborhood_all_ppsf_low: value?.neighborhood_all_ppsf_low ?? "",
    neighborhood_all_ppsf_high: value?.neighborhood_all_ppsf_high ?? "",
    neighborhood_all_ppsf_predominant: value?.neighborhood_all_ppsf_predominant ?? "",
    neighborhood_all_age_low: value?.neighborhood_all_age_low ?? "",
    neighborhood_all_age_high: value?.neighborhood_all_age_high ?? "",
    neighborhood_all_age_predominant: value?.neighborhood_all_age_predominant ?? "",
    neighborhood_all_gla_low: value?.neighborhood_all_gla_low ?? "",
    neighborhood_all_gla_high: value?.neighborhood_all_gla_high ?? "",
    neighborhood_all_gla_predominant: value?.neighborhood_all_gla_predominant ?? "",
    neighborhood_all_value_count: value?.neighborhood_all_value_count ?? "",
    neighborhood_all_ppsf_count: value?.neighborhood_all_ppsf_count ?? "",
    neighborhood_all_age_count: value?.neighborhood_all_age_count ?? "",
    neighborhood_all_gla_count: value?.neighborhood_all_gla_count ?? "",
    neighborhood_city_name: value?.neighborhood_city_name || "",
    neighborhood_city_sale_count: value?.neighborhood_city_sale_count ?? "",
    neighborhood_city_average_sale_price: value?.neighborhood_city_average_sale_price ?? "",
    neighborhood_city_average_ppsf: value?.neighborhood_city_average_ppsf ?? "",
    neighborhood_city_average_age: value?.neighborhood_city_average_age ?? "",
    neighborhood_city_average_gla: value?.neighborhood_city_average_gla ?? "",
    neighborhood_city_comparison_as_of: value?.neighborhood_city_comparison_as_of || "",
    neighborhood_boundary_geometry: value?.neighborhood_boundary_geometry || null,
    neighborhood_boundary_label: value?.neighborhood_boundary_label || "",
    neighborhood_boundary_source: value?.neighborhood_boundary_source || "",
    neighborhood_boundary_saved_at: value?.neighborhood_boundary_saved_at || "",
    neighborhood_boundary_streets: value?.neighborhood_boundary_streets || "",
    neighborhood_boundary_north: value?.neighborhood_boundary_north || "",
    neighborhood_boundary_east: value?.neighborhood_boundary_east || "",
    neighborhood_boundary_south: value?.neighborhood_boundary_south || "",
    neighborhood_boundary_west: value?.neighborhood_boundary_west || "",
    neighborhood_boundary_exclusions:
      typeof value?.neighborhood_boundary_exclusions === "string" &&
      value.neighborhood_boundary_exclusions.trim()
        ? value.neighborhood_boundary_exclusions
        : DEFAULT_NEIGHBORHOOD_BOUNDARY_NARRATIVE,
    neighborhood_boundary_streets_source: value?.neighborhood_boundary_streets_source || "",
    neighborhood_boundary_streets_retrieved_at:
      value?.neighborhood_boundary_streets_retrieved_at || "",
    neighborhood_boundary_confirmed: Boolean(value?.neighborhood_boundary_confirmed),
    neighborhood_boundary_confirmed_at: value?.neighborhood_boundary_confirmed_at || "",
    neighborhood_boundary_engine_assessment_id:
      value?.neighborhood_boundary_engine_assessment_id ?? "",
    neighborhood_boundary_engine_assignment_file_id:
      value?.neighborhood_boundary_engine_assignment_file_id ?? "",
    neighborhood_boundary_engine_methodology_version:
      value?.neighborhood_boundary_engine_methodology_version ?? "",
    neighborhood_boundary_engine_confidence:
      value?.neighborhood_boundary_engine_confidence || "",
    neighborhood_boundary_engine_disclosure:
      value?.neighborhood_boundary_engine_disclosure || "",
    neighborhood_boundary_engine_warnings: cloneEditorValue(
      value?.neighborhood_boundary_engine_warnings || [],
    ),
    neighborhood_relevance_assessment_id:
      value?.neighborhood_relevance_assessment_id ?? "",
    neighborhood_relevance_methodology_version:
      value?.neighborhood_relevance_methodology_version ?? "",
    neighborhood_relevance_confidence:
      value?.neighborhood_relevance_confidence || "",
    neighborhood_relevance_candidate_count:
      value?.neighborhood_relevance_candidate_count ?? "",
    neighborhood_relevance_included_count:
      value?.neighborhood_relevance_included_count ?? "",
    neighborhood_relevance_excluded_count:
      value?.neighborhood_relevance_excluded_count ?? "",
    neighborhood_relevance_insufficient_data_count:
      value?.neighborhood_relevance_insufficient_data_count ?? "",
    neighborhood_relevance_generated_at:
      value?.neighborhood_relevance_generated_at || "",
    highest_best_use_conclusion: value?.highest_best_use_conclusion || "",
    highest_best_use_summary: value?.highest_best_use_summary || "",
    highest_best_use_zoning_compatible:
      typeof value?.highest_best_use_zoning_compatible === "boolean"
        ? value.highest_best_use_zoning_compatible
        : null,
    highest_best_use_flags: cloneEditorValue(value?.highest_best_use_flags || []),
    highest_best_use_source: value?.highest_best_use_source || "",
    highest_best_use_analyzed_at: value?.highest_best_use_analyzed_at || "",
    highest_best_use_subject_site_area_sqft:
      value?.highest_best_use_subject_site_area_sqft ?? "",
    highest_best_use_comparison_min_site_area_sqft:
      value?.highest_best_use_comparison_min_site_area_sqft ?? "",
    highest_best_use_comparison_median_site_area_sqft:
      value?.highest_best_use_comparison_median_site_area_sqft ?? "",
    highest_best_use_comparison_parcel_count:
      value?.highest_best_use_comparison_parcel_count ?? "",
    subject_concluded_value: value?.subject_concluded_value ?? "",
    neighborhood_value_position: value?.neighborhood_value_position || "",
    neighborhood_value_difference: value?.neighborhood_value_difference ?? "",
    neighborhood_value_difference_pct: value?.neighborhood_value_difference_pct ?? "",
    neighborhood_value_conclusion: value?.neighborhood_value_conclusion || "",
    neighborhood_value_conclusion_auto: value?.neighborhood_value_conclusion_auto || "",
    neighborhood_value_conclusion_signature:
      value?.neighborhood_value_conclusion_signature || "",
    neighborhood_value_conclusion_generated_at:
      value?.neighborhood_value_conclusion_generated_at || "",
    neighborhood_value_source: value?.neighborhood_value_source || "",
    lender_revision_count: Math.max(0, Number(value?.lender_revision_count) || 0),
    lender_revision_last_requested_at: value?.lender_revision_last_requested_at || "",
    lender_revision_note: value?.lender_revision_note || "",
  };
}

function assignmentValidationErrors(assignment: AssignmentDetails): string[] {
  const errors: string[] = [];
  const hoaAmount = parseNumber(assignment.hoa_dues_amount);
  const hoaExplanation = String(assignment.hoa_explanation || "").trim();
  const assignmentTypes = Array.isArray(assignment.assignment_types)
    ? assignment.assignment_types
    : [];
  if (
    assignment.pud &&
    !((hoaAmount !== null && hoaAmount > 0 && assignment.hoa_frequency) || hoaExplanation)
  ) {
    errors.push("Enter HOA dues and a frequency, or explain why they are unavailable.");
  }
  if (assignment.pud && assignment.hoa_frequency === "other" && !hoaExplanation) {
    errors.push("Explain the Other HOA dues frequency.");
  }
  if (
    assignment.occupancy === "unknown" &&
    !String(assignment.occupancy_explanation || "").trim()
  ) {
    errors.push("Explain why occupancy is unknown.");
  }
  if (
    assignmentTypes.includes("other") &&
    !String(assignment.assignment_explanation || "").trim()
  ) {
    errors.push("Explain the Other assignment type.");
  }
  if (assignment.subject_under_contract && !assignmentTypes.includes("purchase_transaction")) {
    errors.push("Subject Under Contract requires Purchase Transaction in Assignment Details.");
  }
  if (assignment.subject_under_contract && typeof assignment.contract_arms_length !== "boolean") {
    errors.push("Select Yes or No for Arms Length.");
  }
  if (
    assignment.subject_under_contract &&
    typeof assignment.seller_matches_public_records !== "boolean"
  ) {
    errors.push("Select Yes or No for whether the seller matches public records.");
  }
  if (
    assignment.subject_under_contract &&
    assignment.seller_matches_public_records === false &&
    !String(assignment.seller_mismatch_explanation || "").trim()
  ) {
    errors.push("Explain the difference between the contract seller and public records.");
  }
  const landUseTotal = neighborhoodLandUseTotal(assignment);
  if (landUseTotal !== null && Math.abs(landUseTotal - 100) > 0.1) {
    errors.push("Present land use percentages must total 100%.");
  }
  return errors;
}

function CheckboxChoice({
  checked,
  label,
  onChange,
  disabled = false,
  compact = false,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <label className={`flex items-center rounded-lg border font-medium ${
      compact ? "gap-1.5 px-2 py-1.5 text-xs" : "gap-2 px-3 py-2 text-sm"
    } ${
      disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer"
    } ${
      checked
        ? "border-blue-400 bg-blue-50 text-blue-900"
        : "border-slate-200 bg-white text-slate-700"
    }`}>
      <input
        type="checkbox"
        className={`checkbox checkbox-primary ${compact ? "checkbox-xs" : "checkbox-sm"}`}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

const ARRAY_ROW_TEMPLATES: Record<string, Record<string, unknown>> = {
  property_activity_history: {
    record_type: "listing",
    activity_date: "",
    listing_id: "",
    mls_status: "",
    list_price: "",
    sale_price: "",
    days_on_market: "",
    buyer_financing: "",
    concessions: "",
    source: "Manual appraisal-file entry",
  },
  sales_history: {
    closing_date: "",
    listing_id: "",
    sale_price: "",
    days_on_market: "",
    buyer_financing: "",
  },
  land_detail: {
    number: "",
    state_code: "",
    zoning: "",
    frontage_ft: "",
    depth_ft: "",
    area_sqft: "",
    pricing_method: "",
    adjusted_price: "",
  },
  additional_improvements: {
    improvement_type: "",
    construction: "",
    floor: "",
    exterior_wall: "",
    area_sqft: "",
    value: "",
    year_built: "",
  },
  parties: {
    owner_name: "",
    ownership_pct: "",
  },
};

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function displayValue(value: unknown, fallback = "Not reported"): string {
  return hasValue(value) ? String(value) : fallback;
}

function parseNumber(value: unknown): number | null {
  if (!hasValue(value)) return null;
  const parsed =
    typeof value === "number"
      ? value
      : Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMoney(value: unknown): string {
  const parsed = parseNumber(value);
  if (parsed === null) return "Not reported";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(parsed);
}

function formatNumber(value: unknown, suffix = ""): string {
  const parsed = parseNumber(value);
  if (parsed === null) return "Not reported";
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(parsed)}${suffix}`;
}

function formatOwnershipPercent(value: unknown): string {
  const parsed = parseNumber(value);
  if (parsed === null) return "Share not reported";
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 3,
  }).format(parsed)}%`;
}

function formatDate(value: unknown): string {
  if (!hasValue(value)) return "Not reported";
  const date = new Date(String(value));
  if (Number.isNaN(date.valueOf())) return String(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatCensusTract(value: unknown): string {
  const code = String(value || "").trim();
  if (!/^\d{6}$/.test(code)) return displayValue(value, "Pending coordinate lookup");
  const whole = Number.parseInt(code.slice(0, 4), 10);
  const decimal = code.slice(4);
  return decimal === "00" ? String(whole) : `${whole}.${decimal}`;
}

function activityTypeLabel(value: unknown): string {
  const labels: Record<string, string> = {
    listing: "Listing",
    contract: "Contract",
    closed_sale: "Closed Sale",
    cad_transfer: "CAD Transfer",
  };
  return labels[String(value || "")] || displayValue(value, "Activity");
}

function activityTypeClass(value: unknown): string {
  switch (String(value || "")) {
    case "closed_sale": return "bg-emerald-100 text-emerald-800";
    case "contract": return "bg-amber-100 text-amber-900";
    case "listing": return "bg-blue-100 text-blue-800";
    default: return "bg-slate-200 text-slate-700";
  }
}

function listingTimelineRows(events: DcadSaleHistoryRow[]): DcadSaleHistoryRow[] {
  const rows = new Map<string, DcadSaleHistoryRow>();
  events.forEach((event, index) => {
    if (event.record_type === "cad_transfer") return;
    if (
      !hasValue(event.listing_id) &&
      !hasValue(event.listing_key) &&
      !hasValue(event.source_record_id) &&
      !["listing", "contract", "closed_sale"].includes(String(event.record_type || ""))
    ) return;
    const key = String(
      event.listing_id || event.listing_key || event.source_record_id ||
      `${event.source || "source"}-${event.closing_date || event.listing_date || index}`,
    );
    const current = rows.get(key) || {};
    const merged = { ...current } as DcadSaleHistoryRow;
    Object.entries(event).forEach(([field, value]) => {
      if (hasValue(value)) {
        (merged as Record<string, unknown>)[field] = value;
      }
    });
    rows.set(key, merged);
  });
  return [...rows.values()].sort((left, right) => {
    const leftDate = Date.parse(String(left.closing_date || left.contract_date || left.listing_date || ""));
    const rightDate = Date.parse(String(right.closing_date || right.contract_date || right.listing_date || ""));
    return (Number.isFinite(rightDate) ? rightDate : 0) - (Number.isFinite(leftDate) ? leftDate : 0);
  });
}

function normalizedNameTokens(value: unknown): string[] {
  return [...new Set(
    String(value || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, " ")
      .split(/\s+/)
      .filter((token) => token && !["AND", "THE"].includes(token)),
  )].sort();
}

function sellerComparisonSummary(contractSeller: unknown, publicOwner: unknown): {
  matches: boolean | null;
  summary: string;
} {
  const contractLabel = String(contractSeller || "").trim();
  const publicLabel = String(publicOwner || "").trim();
  if (!contractLabel) return { matches: null, summary: "Enter the contract seller name to compare it with CAD ownership." };
  if (!publicLabel || publicLabel === "Not reported") {
    return { matches: null, summary: "CAD ownership is unavailable, so the contract seller requires manual review." };
  }
  const contractTokens = normalizedNameTokens(contractLabel);
  const publicTokens = normalizedNameTokens(publicLabel);
  const matches =
    contractTokens.length > 0 &&
    contractTokens.length === publicTokens.length &&
    contractTokens.every((token, index) => token === publicTokens[index]);
  return matches
    ? {
        matches: true,
        summary: `The contract seller appears consistent with CAD public records (${publicLabel}).`,
      }
    : {
        matches: false,
        summary: `The contract lists ${contractLabel}, while CAD public records list ${publicLabel}. Review and explain the difference before completing the assignment.`,
      };
}

type NeighborhoodRangeRowDefinition = {
  label: string;
  low: keyof AssignmentDetails;
  high: keyof AssignmentDetails;
  predominant: keyof AssignmentDetails;
  format: string;
};

function NeighborhoodRangeGrid({
  rows,
  assignment,
  readOnly = false,
  onChange,
}: {
  rows: readonly NeighborhoodRangeRowDefinition[];
  assignment: AssignmentDetails;
  readOnly?: boolean;
  onChange: <K extends keyof AssignmentDetails>(key: K, value: AssignmentDetails[K]) => void;
}) {
  return (
    <div className="mt-2 min-w-[510px]">
      <div className="grid grid-cols-[1.2fr_1fr_1fr_1fr] gap-2 border-b border-slate-300 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
        <div>Measure</div><div>Low</div><div>High</div><div>Predominant</div>
      </div>
      {rows.map((row) => (
        <div key={row.label} className="grid grid-cols-[1.2fr_1fr_1fr_1fr] items-center gap-2 border-b border-slate-100 py-1 last:border-0">
          <div className="text-xs font-medium text-slate-800">{row.label}</div>
          {[row.low, row.high, row.predominant].map((field) => {
            const isMoney = row.format === "money";
            const isPricePerSquareFoot = /Sq\. Ft\./.test(row.label);
            return (
              <div key={field} className="relative">
                {isMoney ? (
                  <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs font-medium text-slate-600">$</span>
                ) : null}
                <input
                  type="number"
                  min="0"
                  step={row.label === "Age" ? "1" : "0.01"}
                  readOnly={readOnly}
                  aria-readonly={readOnly}
                  className={`input input-bordered input-xs w-full ${readOnly ? "bg-slate-50 text-slate-700" : "bg-white"} ${isMoney ? "pl-5" : ""} ${isPricePerSquareFoot ? "pr-8" : ""}`}
                  value={(assignment[field] as string | number | undefined) ?? ""}
                  onChange={(event) => {
                    if (!readOnly) onChange(field, event.target.value);
                  }}
                />
                {isPricePerSquareFoot ? (
                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-500">/SF</span>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function NeighborhoodCharacteristicsContent({
  accountId,
  assignmentFileId,
  assignmentDraft,
  postalCode,
  unemploymentLoading,
  unemploymentMessage,
  profileLoading,
  profileMessage,
  boundarySuggestions,
  customAreaAvailable,
  marketConditionsDraft,
  highestBestUseContext,
  valuePositionContext,
  assignmentDirty,
  assignmentSaveMessage,
  assignmentSaveDisabled,
  savingAssignmentFile,
  onAssignmentChange,
  onRefreshUnemployment,
  onRefreshBoundary,
  onBoundarySuggestionsChange,
  onConfirmBoundary,
  onMarketConditionsChange,
  onSave,
}: {
  accountId?: string;
  assignmentFileId?: number | null;
  assignmentDraft: AssignmentDetails;
  postalCode: string;
  unemploymentLoading: boolean;
  unemploymentMessage: string;
  profileLoading: boolean;
  profileMessage: string;
  boundarySuggestions: NonNullable<NeighborhoodProfileResponse["boundary_streets"]>["cardinal_boundaries"] | null;
  customAreaAvailable: boolean;
  marketConditionsDraft: MarketConditionsDraft | null;
  highestBestUseContext: {
    zoning: string;
    currentUse: string;
  };
  valuePositionContext: {
    concludedValue: number | null;
    source: string;
    subjectGla: number | null;
    subjectAge: number | null;
    subjectQuality: string;
  };
  assignmentDirty: boolean;
  assignmentSaveMessage: string;
  assignmentSaveDisabled: boolean;
  savingAssignmentFile: boolean;
  onAssignmentChange: <K extends keyof AssignmentDetails>(
    key: K,
    value: AssignmentDetails[K],
  ) => void;
  onRefreshUnemployment: () => void;
  onRefreshBoundary: () => void;
  onBoundarySuggestionsChange: (
    suggestions: NonNullable<NeighborhoodProfileResponse["boundary_streets"]>["cardinal_boundaries"] | null,
  ) => void;
  onConfirmBoundary: (checked: boolean) => void;
  onMarketConditionsChange: (draft: MarketConditionsDraft | null) => void;
  onSave: () => void;
}) {
  const [landUseAnalysis, setLandUseAnalysis] = useState<NeighborhoodLandUseAnalysisResponse | null>(null);
  const [landUseAnalysisLoading, setLandUseAnalysisLoading] = useState(false);
  const [landUseAnalysisMessage, setLandUseAnalysisMessage] = useState("");
  const [generatedBoundary, setGeneratedBoundary] = useState<NeighborhoodBoundaryAssessment | null>(null);
  const [generatedBoundaryLoading, setGeneratedBoundaryLoading] = useState(false);
  const [generatedBoundaryMessage, setGeneratedBoundaryMessage] = useState("");
  const [relevanceAssessment, setRelevanceAssessment] = useState<NeighborhoodRelevanceAssessment | null>(null);
  const [relevanceLoading, setRelevanceLoading] = useState(false);
  const [relevanceMessage, setRelevanceMessage] = useState("");
  const automaticLandUseFingerprintRef = useRef("");
  const automaticBoundaryAttemptRef = useRef("");
  const landUseTotal = neighborhoodLandUseTotal(assignmentDraft);
  const boundaryErrors = neighborhoodBoundaryReadinessErrors(assignmentDraft);
  const boundaryRing = assignmentDraft.neighborhood_boundary_geometry?.coordinates?.[0] || [];
  const zipUnemployment = parseNumber(assignmentDraft.neighborhood_unemployment_pct);
  const cityUnemployment = parseNumber(assignmentDraft.neighborhood_city_unemployment_pct);
  const unemploymentDifference = zipUnemployment !== null && cityUnemployment !== null
    ? zipUnemployment - cityUnemployment
    : null;
  const effectiveConcludedValue = valuePositionContext.concludedValue ??
    parseNumber(assignmentDraft.subject_concluded_value);
  const valuePosition = useMemo(() => determineNeighborhoodValuePosition({
    concludedValue: effectiveConcludedValue,
    predominantValue: assignmentDraft.neighborhood_house_price_predominant,
    neighborhoodLowValue: assignmentDraft.neighborhood_house_price_low,
    neighborhoodHighValue: assignmentDraft.neighborhood_house_price_high,
    subjectGla: valuePositionContext.subjectGla,
    predominantGla: assignmentDraft.neighborhood_gla_predominant,
    subjectSiteSize: assignmentDraft.highest_best_use_subject_site_area_sqft,
    predominantSiteSize: assignmentDraft.highest_best_use_comparison_median_site_area_sqft,
    subjectAge: valuePositionContext.subjectAge,
    predominantAge: assignmentDraft.neighborhood_age_predominant,
    conditionRating: assignmentDraft.subject_condition_rating,
    qualityRating: valuePositionContext.subjectQuality,
    conformsToNeighborhood: assignmentDraft.subject_conforms_to_neighborhood,
    nonconformityType: assignmentDraft.subject_nonconformity_type,
  }), [
    assignmentDraft.highest_best_use_comparison_median_site_area_sqft,
    assignmentDraft.highest_best_use_subject_site_area_sqft,
    assignmentDraft.neighborhood_age_predominant,
    assignmentDraft.neighborhood_gla_predominant,
    assignmentDraft.neighborhood_house_price_high,
    assignmentDraft.neighborhood_house_price_low,
    assignmentDraft.neighborhood_house_price_predominant,
    assignmentDraft.subject_condition_rating,
    assignmentDraft.subject_conforms_to_neighborhood,
    assignmentDraft.subject_nonconformity_type,
    effectiveConcludedValue,
    valuePositionContext.subjectAge,
    valuePositionContext.subjectGla,
    valuePositionContext.subjectQuality,
  ]);
  const representativeness = useMemo(
    () => calculateNeighborhoodRepresentativeness(assignmentDraft),
    [assignmentDraft],
  );
  const valuePositionSignature = useMemo(() => JSON.stringify({
    concludedValue: effectiveConcludedValue,
    predominantValue: assignmentDraft.neighborhood_house_price_predominant,
    lowValue: assignmentDraft.neighborhood_house_price_low,
    highValue: assignmentDraft.neighborhood_house_price_high,
    subjectGla: valuePositionContext.subjectGla,
    predominantGla: assignmentDraft.neighborhood_gla_predominant,
    subjectSiteSize: assignmentDraft.highest_best_use_subject_site_area_sqft,
    predominantSiteSize: assignmentDraft.highest_best_use_comparison_median_site_area_sqft,
    subjectAge: valuePositionContext.subjectAge,
    predominantAge: assignmentDraft.neighborhood_age_predominant,
    condition: assignmentDraft.subject_condition_rating,
    quality: valuePositionContext.subjectQuality,
    conforms: assignmentDraft.subject_conforms_to_neighborhood,
    nonconformityType: assignmentDraft.subject_nonconformity_type,
  }), [
    assignmentDraft.highest_best_use_comparison_median_site_area_sqft,
    assignmentDraft.highest_best_use_subject_site_area_sqft,
    assignmentDraft.neighborhood_age_predominant,
    assignmentDraft.neighborhood_gla_predominant,
    assignmentDraft.neighborhood_house_price_high,
    assignmentDraft.neighborhood_house_price_low,
    assignmentDraft.neighborhood_house_price_predominant,
    assignmentDraft.subject_condition_rating,
    assignmentDraft.subject_conforms_to_neighborhood,
    assignmentDraft.subject_nonconformity_type,
    effectiveConcludedValue,
    valuePositionContext.subjectAge,
    valuePositionContext.subjectGla,
    valuePositionContext.subjectQuality,
  ]);
  const landUseAnalysisIsCurrent = Boolean(
    landUseAnalysis && assignmentDraft.neighborhood_boundary_geometry &&
    JSON.stringify(landUseAnalysis.boundary.coordinates) ===
      JSON.stringify(assignmentDraft.neighborhood_boundary_geometry.coordinates),
  );
  const analyzePresentLandUse = async (automatic = false) => {
    if (!accountId || !assignmentDraft.neighborhood_boundary_geometry) {
      setLandUseAnalysisMessage(
        "Import or refresh the Appraiser-Defined Area before analyzing present land use.",
      );
      return;
    }
    setLandUseAnalysisLoading(true);
    setLandUseAnalysisMessage(
      automatic
        ? "Loading present land use and the all-property neighborhood profile automatically..."
        : "",
    );
    try {
      const result = await runNeighborhoodLandUseAnalysis(
        accountId,
        assignmentDraft.neighborhood_boundary_geometry,
      );
      setLandUseAnalysis(result);
      applyPresentLandUse(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Present land-use analysis failed.";
      setLandUseAnalysisMessage(
        /dallas_county_only/i.test(message)
          ? "Automated parcel land-use analysis is currently available for Dallas County properties only."
          : /too_many_parcels/i.test(message)
            ? "The drawn area contains too many parcels. Tighten the neighborhood boundary and try again."
            : /dcad_land_use_query/i.test(message)
              ? "The official DCAD parcel service is temporarily unavailable. No report values were changed."
              : message,
      );
    } finally {
      setLandUseAnalysisLoading(false);
    }
  };
  const applyPresentLandUse = (result: NeighborhoodLandUseAnalysisResponse) => {
    const fieldByCategory = {
      one_unit: "neighborhood_land_use_one_unit_pct",
      two_to_four_unit: "neighborhood_land_use_two_to_four_unit_pct",
      multifamily: "neighborhood_land_use_multifamily_pct",
      commercial: "neighborhood_land_use_commercial_pct",
      other_vacant: "neighborhood_land_use_other_vacant_pct",
    } as const;
    result.categories.forEach((category) => {
      onAssignmentChange(fieldByCategory[category.key], category.percentage);
    });
    const categoryPercentage = new Map(result.categories.map((category) => [category.key, category.percentage]));
    const locationType = locationTypeFromLandUse({
      oneUnit: categoryPercentage.get("one_unit") || 0,
      twoToFourUnit: categoryPercentage.get("two_to_four_unit") || 0,
      multifamily: categoryPercentage.get("multifamily") || 0,
      commercial: categoryPercentage.get("commercial") || 0,
      otherVacant: categoryPercentage.get("other_vacant") || 0,
    });
    const medianDom = marketConditionsDraft
      ? reconciledMedianDaysOnMarket(marketConditionsDraft.response)
      : null;
    const marketChange = marketConditionsDraft?.response.recommendation.recommended_change_percent ?? null;
    const highestBestUse = determineHighestBestUse({
      zoning: highestBestUseContext.zoning,
      currentUse: highestBestUseContext.currentUse,
      subjectSmallerThanAllComparisons: result.subject_smaller_than_all_comparisons,
      comparisonParcelCount: result.comparison_parcel_count,
    });
    onAssignmentChange("neighborhood_land_use_analysis_source", result.source);
    onAssignmentChange("neighborhood_land_use_analyzed_at", result.analyzed_at);
    onAssignmentChange("neighborhood_land_use_parcel_count", result.parcel_count);
    onAssignmentChange("neighborhood_land_use_review_count", result.review_required_count);
    onAssignmentChange("neighborhood_land_use_coverage_percent", result.coverage_percent);
    onAssignmentChange("neighborhood_land_use_confidence", result.confidence);
    if (result.property_profile) {
      onAssignmentChange("neighborhood_all_property_count", result.property_profile.property_count);
      onAssignmentChange("neighborhood_all_house_price_low", result.property_profile.house_price.low ?? "");
      onAssignmentChange("neighborhood_all_house_price_high", result.property_profile.house_price.high ?? "");
      onAssignmentChange(
        "neighborhood_all_house_price_predominant",
        result.property_profile.house_price.predominant ?? "",
      );
      onAssignmentChange("neighborhood_all_ppsf_low", result.property_profile.price_per_square_foot.low ?? "");
      onAssignmentChange("neighborhood_all_ppsf_high", result.property_profile.price_per_square_foot.high ?? "");
      onAssignmentChange(
        "neighborhood_all_ppsf_predominant",
        result.property_profile.price_per_square_foot.predominant ?? "",
      );
      onAssignmentChange("neighborhood_all_age_low", result.property_profile.age.low ?? "");
      onAssignmentChange("neighborhood_all_age_high", result.property_profile.age.high ?? "");
      onAssignmentChange("neighborhood_all_age_predominant", result.property_profile.age.predominant ?? "");
      onAssignmentChange("neighborhood_all_gla_low", result.property_profile.living_area.low ?? "");
      onAssignmentChange("neighborhood_all_gla_high", result.property_profile.living_area.high ?? "");
      onAssignmentChange(
        "neighborhood_all_gla_predominant",
        result.property_profile.living_area.predominant ?? "",
      );
      onAssignmentChange("neighborhood_all_value_count", result.property_profile.house_price.count);
      onAssignmentChange("neighborhood_all_ppsf_count", result.property_profile.price_per_square_foot.count);
      onAssignmentChange("neighborhood_all_age_count", result.property_profile.age.count);
      onAssignmentChange("neighborhood_all_gla_count", result.property_profile.living_area.count);
    }
    onAssignmentChange("neighborhood_built_up", result.built_up_band);
    onAssignmentChange("neighborhood_built_up_pct", result.built_up_percent);
    if (locationType) onAssignmentChange("neighborhood_location_type", locationType);
    if (marketConditionsDraft) {
      const marketTrend = marketTrendFromRecommendation(
        marketConditionsDraft.response.recommendation.conclusion,
      );
      const marketingTime = marketingTimeFromMedianDom(medianDom);
      const growth = growthFromMarket(marketChange, medianDom, locationType ||
        (assignmentDraft.neighborhood_location_type as NeighborhoodLocationType));
      if (marketTrend) onAssignmentChange("neighborhood_market_trend", marketTrend);
      if (marketingTime) onAssignmentChange("neighborhood_marketing_time", marketingTime);
      if (growth) onAssignmentChange("neighborhood_growth", growth);
      onAssignmentChange("neighborhood_market_change_pct", marketChange ?? "");
      onAssignmentChange("neighborhood_median_dom", medianDom ?? "");
    }
    onAssignmentChange("highest_best_use_conclusion", highestBestUse.conclusion);
    onAssignmentChange("highest_best_use_summary", highestBestUse.summary);
    onAssignmentChange("highest_best_use_zoning_compatible", highestBestUse.zoningCompatible);
    onAssignmentChange("highest_best_use_flags", highestBestUse.flags);
    onAssignmentChange("highest_best_use_source", "automated_land_use_and_zoning_screening");
    onAssignmentChange("highest_best_use_analyzed_at", result.analyzed_at);
    onAssignmentChange("highest_best_use_subject_site_area_sqft", result.subject_site_area_sqft ?? "");
    onAssignmentChange(
      "highest_best_use_comparison_min_site_area_sqft",
      result.comparison_min_site_area_sqft ?? "",
    );
    onAssignmentChange(
      "highest_best_use_comparison_median_site_area_sqft",
      result.comparison_median_site_area_sqft ?? "",
    );
    onAssignmentChange("highest_best_use_comparison_parcel_count", result.comparison_parcel_count);
    onAssignmentChange(
      "neighborhood_land_use_boundary_signature",
      result.boundary_signature,
    );
    setLandUseAnalysisMessage(
      `Analysis completed from ${result.parcel_count.toLocaleString()} DCAD parcels${
        result.cache_hit
          ? " using the recent saved calculation"
          : result.processing_duration_ms > 0
            ? ` in ${(result.processing_duration_ms / 1000).toFixed(1)} seconds`
            : ""
      }. Land-use percentages, ${result.property_profile ? "the all-property neighborhood profile, " : ""}${result.built_up_label} built-up, location type, and highest-and-best-use screening were populated automatically.`,
    );
  };
  const analyzePresentLandUseRef = useRef(analyzePresentLandUse);
  useEffect(() => {
    analyzePresentLandUseRef.current = analyzePresentLandUse;
  });
  const automaticLandUseFingerprint = useMemo(() => {
    const geometry = assignmentDraft.neighborhood_boundary_geometry;
    return accountId && geometry
      ? `${accountId}:${JSON.stringify(geometry.coordinates)}`
      : "";
  }, [accountId, assignmentDraft.neighborhood_boundary_geometry]);
  const savedLandUseProfileIsComplete = hasSavedNeighborhoodLandUseProfile(assignmentDraft);
  useEffect(() => {
    if (
      !automaticLandUseFingerprint ||
      automaticLandUseFingerprintRef.current === automaticLandUseFingerprint
    ) return;

    automaticLandUseFingerprintRef.current = automaticLandUseFingerprint;
    if (savedLandUseProfileIsComplete) {
      setLandUseAnalysisMessage(
        "Saved present land use and Sales Sample Representativeness data loaded automatically.",
      );
      return;
    }

    void analyzePresentLandUseRef.current(true);
  }, [automaticLandUseFingerprint, savedLandUseProfileIsComplete]);
  const updateBoundarySide = (
    field: "neighborhood_boundary_north" | "neighborhood_boundary_east" |
      "neighborhood_boundary_south" | "neighborhood_boundary_west",
    value: string,
  ) => {
    const next = { ...assignmentDraft, [field]: value };
    onAssignmentChange(field, value);
    onAssignmentChange("neighborhood_boundary_streets", [
      ["North", next.neighborhood_boundary_north],
      ["East", next.neighborhood_boundary_east],
      ["South", next.neighborhood_boundary_south],
      ["West", next.neighborhood_boundary_west],
    ].filter(([, street]) => String(street || "").trim())
      .map(([side, street]) => `${side}: ${String(street).trim()}`)
      .join("; "));
  };

  const applyGeneratedBoundary = useCallback((
    result: NeighborhoodBoundaryAssessment,
    options: { overwriteGeometry: boolean; message: string },
  ) => {
    const cardinal = result.evidence.roads?.cardinal_boundaries;
    onBoundarySuggestionsChange(
      (cardinal || null) as NonNullable<
        NeighborhoodProfileResponse["boundary_streets"]
      >["cardinal_boundaries"] | null,
    );
    setGeneratedBoundary(result);
    setGeneratedBoundaryMessage(options.message);
    if (!options.overwriteGeometry) return;

    const north = cardinal?.north?.primary_street || "";
    const east = cardinal?.east?.primary_street || "";
    const south = cardinal?.south?.primary_street || "";
    const west = cardinal?.west?.primary_street || "";
    const streetSummary = [
      ["North", north],
      ["East", east],
      ["South", south],
      ["West", west],
    ].filter(([, street]) => street)
      .map(([side, street]) => `${side}: ${street}`)
      .join("; ");
    onAssignmentChange("neighborhood_boundary_geometry", result.boundary);
    onAssignmentChange("neighborhood_boundary_label", "Automatically generated broad neighborhood");
    onAssignmentChange(
      "neighborhood_boundary_source",
      `neighborhood_boundary_engine_v${result.methodology_version}`,
    );
    onAssignmentChange("neighborhood_boundary_saved_at", result.generated_at);
    onAssignmentChange("neighborhood_boundary_streets", streetSummary);
    onAssignmentChange("neighborhood_boundary_north", north);
    onAssignmentChange("neighborhood_boundary_east", east);
    onAssignmentChange("neighborhood_boundary_south", south);
    onAssignmentChange("neighborhood_boundary_west", west);
    onAssignmentChange("neighborhood_boundary_streets_source", result.evidence.roads?.source || "");
    onAssignmentChange("neighborhood_boundary_streets_retrieved_at", result.evidence.roads?.retrieved_at || "");
    onAssignmentChange("neighborhood_boundary_confirmed", false);
    onAssignmentChange("neighborhood_boundary_confirmed_at", "");
    onAssignmentChange("neighborhood_boundary_engine_assessment_id", result.id);
    onAssignmentChange(
      "neighborhood_boundary_engine_assignment_file_id",
      result.assignment_file_id ?? "",
    );
    onAssignmentChange("neighborhood_boundary_engine_methodology_version", result.methodology_version);
    onAssignmentChange("neighborhood_boundary_engine_confidence", result.confidence);
    onAssignmentChange("neighborhood_boundary_engine_disclosure", result.evidence.disclosure || "");
    onAssignmentChange("neighborhood_boundary_engine_warnings", result.evidence.warnings || []);
    onAssignmentChange("neighborhood_relevance_assessment_id", "");
    onAssignmentChange("neighborhood_relevance_methodology_version", "");
    onAssignmentChange("neighborhood_relevance_confidence", "");
    onAssignmentChange("neighborhood_relevance_candidate_count", "");
    onAssignmentChange("neighborhood_relevance_included_count", "");
    onAssignmentChange("neighborhood_relevance_excluded_count", "");
    onAssignmentChange("neighborhood_relevance_insufficient_data_count", "");
    onAssignmentChange("neighborhood_relevance_generated_at", "");
    setRelevanceAssessment(null);
    setRelevanceMessage("");
  }, [onAssignmentChange, onBoundarySuggestionsChange]);
  const applyGeneratedBoundaryRef = useRef(applyGeneratedBoundary);
  applyGeneratedBoundaryRef.current = applyGeneratedBoundary;
  const automaticBoundaryContextRef = useRef({
    geometry: assignmentDraft.neighborhood_boundary_geometry,
    source: assignmentDraft.neighborhood_boundary_source,
    savedCustomGeometry: marketConditionsDraft?.response.analyses.find(
      (analysis) => analysis.market.key === "custom",
    )?.market.custom_geometry || null,
  });
  automaticBoundaryContextRef.current = {
    geometry: assignmentDraft.neighborhood_boundary_geometry,
    source: assignmentDraft.neighborhood_boundary_source,
    savedCustomGeometry: marketConditionsDraft?.response.analyses.find(
      (analysis) => analysis.market.key === "custom",
    )?.market.custom_geometry || null,
  };

  const generateSuggestedBoundary = async () => {
    if (!accountId || generatedBoundaryLoading) return;
    setGeneratedBoundaryLoading(true);
    setGeneratedBoundaryMessage("Generating a broad neighborhood from saved parcel, road, and zoning data...");
    try {
      const result = await runNeighborhoodBoundaryGeneration(accountId, {
        assignmentFileId: assignmentFileId || null,
      });
      const discovery = result.evidence.discovery;
      const source = String(assignmentDraft.neighborhood_boundary_source || "").toLowerCase();
      const hasAppraiserGeometry = Boolean(assignmentDraft.neighborhood_boundary_geometry) &&
        !/^neighborhood_boundary_engine_v\d+$/i.test(source);
      applyGeneratedBoundary(result, {
        overwriteGeometry: !hasAppraiserGeometry,
        message: hasAppraiserGeometry
          ? "A new suggested boundary is ready. The appraiser-defined area was preserved; use Reset to Suggested Area on the map to adopt it."
          : `Suggested boundary generated from ${Number(discovery?.candidate_count || 0).toLocaleString()} parcels inside the ${discovery?.profile_label || result.search_profile} discovery area. It was loaded into the editable Appraiser-Defined Area for review.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Neighborhood boundary generation failed.";
      setGeneratedBoundaryMessage(
        /subject_parcel_geometry_unavailable/i.test(message)
          ? "A saved Dallas parcel geometry is required before the automatic boundary can run."
          : message,
      );
    } finally {
      setGeneratedBoundaryLoading(false);
    }
  };

  useEffect(() => {
    if (!accountId) return;
    const attemptSignature = `${accountId}:${assignmentFileId || "property"}`;
    if (automaticBoundaryAttemptRef.current === attemptSignature) return;
    automaticBoundaryAttemptRef.current = attemptSignature;
    let cancelled = false;
    const boundaryContext = automaticBoundaryContextRef.current;
    const currentGeometry = boundaryContext.geometry ||
      boundaryContext.savedCustomGeometry;
    const currentSource = String(
      boundaryContext.source ||
        (boundaryContext.savedCustomGeometry
          ? "sales_comparison_market_conditions"
          : ""),
    ).toLowerCase();
    const appraiserCleared = currentSource.includes("cleared");
    const appraiserAreaPresent = Boolean(currentGeometry) &&
      !/^neighborhood_boundary_engine_v\d+$/i.test(currentSource);

    setGeneratedBoundaryLoading(true);
    setGeneratedBoundaryMessage(
      currentGeometry
        ? "Loading the saved neighborhood suggestion for comparison..."
        : "Loading the automatically suggested neighborhood area...",
    );
    void (async () => {
      try {
        let result = await getNeighborhoodBoundary(
          accountId,
          assignmentFileId || null,
        );
        if (!result && !appraiserCleared) {
          result = await runNeighborhoodBoundaryGeneration(accountId, {
            assignmentFileId: assignmentFileId || null,
          });
        }
        if (cancelled) return;
        if (!result) {
          setGeneratedBoundaryMessage(
            appraiserCleared
              ? "The appraiser-defined area is intentionally cleared. Use Generate Suggested Boundary when a new suggestion is wanted."
              : "No saved neighborhood suggestion is available yet.",
          );
          return;
        }
        const discovery = result.evidence.discovery;
        applyGeneratedBoundaryRef.current(result, {
          overwriteGeometry: !currentGeometry && !appraiserCleared,
          message: appraiserAreaPresent
            ? "The saved automatic suggestion is available for comparison. The appraiser-defined area remains unchanged."
            : appraiserCleared
              ? "The saved automatic suggestion is available, but the appraiser-cleared area remains empty until Reset to Suggested Area is selected."
              : `The suggested neighborhood loaded automatically from ${Number(discovery?.candidate_count || 0).toLocaleString()} candidate parcels and is ready for appraisal review.`,
        });
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error
            ? error.message
            : "The automatic neighborhood suggestion could not be loaded.";
          setGeneratedBoundaryMessage(
            /subject_parcel_geometry_unavailable/i.test(message)
              ? "A saved parcel geometry is required before the automatic neighborhood area can load. Manual drawing remains available."
              : message,
          );
        }
      } finally {
        if (!cancelled) setGeneratedBoundaryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, assignmentFileId]);

  const handleCustomGeometryChange = useCallback((
    geometry: AssignmentDetails["neighborhood_boundary_geometry"],
    origin: MarketAreaOrigin,
  ) => {
    if (origin === "automatic" && generatedBoundary) {
      applyGeneratedBoundary(generatedBoundary, {
        overwriteGeometry: true,
        message: "The automatically suggested neighborhood was restored and is ready for appraisal review.",
      });
      return;
    }

    const now = new Date().toISOString();
    onAssignmentChange("neighborhood_boundary_geometry", geometry);
    onAssignmentChange(
      "neighborhood_boundary_label",
      origin === "cleared"
        ? "Appraiser-defined market area cleared"
        : "Appraiser-edited market area",
    );
    onAssignmentChange(
      "neighborhood_boundary_source",
      origin === "cleared"
        ? "appraiser_defined_area_cleared"
        : "appraiser_defined_area_manual_v1",
    );
    onAssignmentChange("neighborhood_boundary_saved_at", now);
    onAssignmentChange("neighborhood_boundary_confirmed", false);
    onAssignmentChange("neighborhood_boundary_confirmed_at", "");
    onAssignmentChange("neighborhood_boundary_streets", "");
    onAssignmentChange("neighborhood_boundary_north", "");
    onAssignmentChange("neighborhood_boundary_east", "");
    onAssignmentChange("neighborhood_boundary_south", "");
    onAssignmentChange("neighborhood_boundary_west", "");
    onAssignmentChange("neighborhood_boundary_streets_source", "");
    onAssignmentChange("neighborhood_boundary_streets_retrieved_at", "");
    onAssignmentChange("neighborhood_land_use_boundary_signature", "");
    onAssignmentChange("neighborhood_boundary_engine_assessment_id", "");
    onAssignmentChange("neighborhood_boundary_engine_assignment_file_id", "");
    onAssignmentChange("neighborhood_boundary_engine_methodology_version", "");
    onAssignmentChange("neighborhood_boundary_engine_confidence", "");
    onAssignmentChange("neighborhood_boundary_engine_disclosure", "");
    onAssignmentChange("neighborhood_boundary_engine_warnings", []);
    onAssignmentChange("neighborhood_relevance_assessment_id", "");
    onAssignmentChange("neighborhood_relevance_methodology_version", "");
    onAssignmentChange("neighborhood_relevance_confidence", "");
    onAssignmentChange("neighborhood_relevance_candidate_count", "");
    onAssignmentChange("neighborhood_relevance_included_count", "");
    onAssignmentChange("neighborhood_relevance_excluded_count", "");
    onAssignmentChange("neighborhood_relevance_insufficient_data_count", "");
    onAssignmentChange("neighborhood_relevance_generated_at", "");
    onBoundarySuggestionsChange(null);
    setRelevanceAssessment(null);
    setRelevanceMessage("");
    setGeneratedBoundaryMessage(
      origin === "cleared"
        ? "The automatic suggestion remains available, but the area will stay cleared until Reset to Suggested Area is selected."
        : "Appraiser edit recorded in this assignment draft. Refresh Area Data to calculate road labels and neighborhood statistics for the revised polygon.",
    );
  }, [
    applyGeneratedBoundary,
    generatedBoundary,
    onAssignmentChange,
    onBoundarySuggestionsChange,
  ]);

  const analyzeRelevantPropertyDataset = async () => {
    if (!accountId || relevanceLoading) return;
    const boundaryAssessmentId = Number(
      assignmentDraft.neighborhood_boundary_engine_assessment_id,
    );
    if (!Number.isSafeInteger(boundaryAssessmentId) || boundaryAssessmentId <= 0) {
      setRelevanceMessage("Generate a suggested boundary before analyzing the relevant property dataset.");
      return;
    }
    const boundaryAssignmentFileId = Number(
      assignmentDraft.neighborhood_boundary_engine_assignment_file_id,
    );
    setRelevanceLoading(true);
    setRelevanceMessage("Scoring parcels for age, site size, proximity, and unadjusted sale-price relevance...");
    try {
      const result = await runNeighborhoodRelevanceGeneration(accountId, {
        assignmentFileId: Number.isSafeInteger(boundaryAssignmentFileId) &&
          boundaryAssignmentFileId > 0
          ? boundaryAssignmentFileId
          : null,
        boundaryAssessmentId,
      });
      onAssignmentChange("neighborhood_relevance_assessment_id", result.id);
      onAssignmentChange("neighborhood_relevance_methodology_version", result.methodology_version);
      onAssignmentChange("neighborhood_relevance_confidence", result.confidence.confidence || "limited");
      onAssignmentChange("neighborhood_relevance_candidate_count", result.summary.candidate_count);
      onAssignmentChange("neighborhood_relevance_included_count", result.summary.included_count);
      onAssignmentChange("neighborhood_relevance_excluded_count", result.summary.excluded_count);
      onAssignmentChange(
        "neighborhood_relevance_insufficient_data_count",
        result.summary.insufficient_data_count,
      );
      onAssignmentChange("neighborhood_relevance_generated_at", result.generated_at);
      setRelevanceAssessment(result);
      setRelevanceMessage(
        `${result.summary.included_count.toLocaleString()} of ${result.summary.candidate_count.toLocaleString()} parcels remain in the relevant dataset; ${result.summary.excluded_count.toLocaleString()} were excluded and ${result.summary.insufficient_data_count.toLocaleString()} remain visible for insufficient-data review.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Relevant-property analysis failed.";
      setRelevanceMessage(
        /neighborhood_boundary_required/i.test(message)
          ? "Generate a suggested boundary before analyzing the relevant property dataset."
          : message,
      );
    } finally {
      setRelevanceLoading(false);
    }
  };

  useEffect(() => {
    if (!valuePosition.ready || !effectiveConcludedValue) return;
    if (assignmentDraft.neighborhood_value_conclusion_signature === valuePositionSignature) return;
    const currentNarrative = String(assignmentDraft.neighborhood_value_conclusion || "").trim();
    const previousAutomaticNarrative = String(
      assignmentDraft.neighborhood_value_conclusion_auto || "",
    ).trim();
    const preserveManualNarrative = Boolean(
      currentNarrative && currentNarrative !== previousAutomaticNarrative,
    );
    onAssignmentChange("subject_concluded_value", effectiveConcludedValue);
    onAssignmentChange("neighborhood_value_position", valuePosition.relationship);
    onAssignmentChange("neighborhood_value_difference", valuePosition.difference ?? "");
    onAssignmentChange("neighborhood_value_difference_pct", valuePosition.differencePercent ?? "");
    onAssignmentChange("neighborhood_value_conclusion_auto", valuePosition.narrative);
    onAssignmentChange("neighborhood_value_conclusion_signature", valuePositionSignature);
    onAssignmentChange("neighborhood_value_conclusion_generated_at", new Date().toISOString());
    onAssignmentChange(
      "neighborhood_value_source",
      valuePositionContext.source || "sales_comparison_approach",
    );
    if (!preserveManualNarrative) {
      onAssignmentChange("neighborhood_value_conclusion", valuePosition.narrative);
    }
  }, [
    assignmentDraft.neighborhood_value_conclusion,
    assignmentDraft.neighborhood_value_conclusion_auto,
    assignmentDraft.neighborhood_value_conclusion_signature,
    effectiveConcludedValue,
    onAssignmentChange,
    valuePosition.difference,
    valuePosition.differencePercent,
    valuePosition.narrative,
    valuePosition.ready,
    valuePosition.relationship,
    valuePositionContext.source,
    valuePositionSignature,
  ]);

  const regenerateValueConclusion = () => {
    if (!valuePosition.ready || !effectiveConcludedValue) return;
    onAssignmentChange("subject_concluded_value", effectiveConcludedValue);
    onAssignmentChange("neighborhood_value_position", valuePosition.relationship);
    onAssignmentChange("neighborhood_value_difference", valuePosition.difference ?? "");
    onAssignmentChange("neighborhood_value_difference_pct", valuePosition.differencePercent ?? "");
    onAssignmentChange("neighborhood_value_conclusion", valuePosition.narrative);
    onAssignmentChange("neighborhood_value_conclusion_auto", valuePosition.narrative);
    onAssignmentChange("neighborhood_value_conclusion_signature", valuePositionSignature);
    onAssignmentChange("neighborhood_value_conclusion_generated_at", new Date().toISOString());
    onAssignmentChange(
      "neighborhood_value_source",
      valuePositionContext.source || "sales_comparison_approach",
    );
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
      <section className="rounded-xl border border-slate-200 bg-white p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Present Land Use</h3>
            <p className="mt-0.5 text-xs text-slate-500">Loads automatically from the appraiser-defined area; use the button to refresh or enter the allocation manually.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-neutral btn-xs normal-case rounded-lg text-white"
              onClick={() => void analyzePresentLandUse()}
              disabled={landUseAnalysisLoading || !assignmentDraft.neighborhood_boundary_geometry}
            >
              {landUseAnalysisLoading ? "Analyzing..." : "Analyze Present Land Use"}
            </button>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              landUseTotal !== null && Math.abs(landUseTotal - 100) <= 0.1
                ? "bg-emerald-100 text-emerald-800"
                : "bg-amber-100 text-amber-900"
            }`}>
              Total {landUseTotal === null ? "0" : landUseTotal.toFixed(1)}%
            </span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
          {NEIGHBORHOOD_LAND_USE_FIELDS.map(([field, label]) => (
            <label key={field} className="block">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">{label}</span>
              <div className="relative mt-0.5">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  className="input input-bordered input-xs w-full bg-white pr-7"
                  value={assignmentDraft[field] ?? ""}
                  onChange={(event) => onAssignmentChange(field, event.target.value)}
                />
                <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-slate-500">%</span>
              </div>
            </label>
          ))}
        </div>
        {landUseAnalysisMessage ? (
          <p className={`mt-2 text-xs font-medium ${
            /failed|unavailable|too many|only|before analyzing/i.test(landUseAnalysisMessage)
              ? "text-amber-800"
              : "text-emerald-700"
          }`}>{landUseAnalysisMessage}</p>
        ) : null}
        {landUseAnalysis ? (
          <div className={`mt-2 rounded-lg border p-2 ${
            landUseAnalysisIsCurrent
              ? "border-slate-200 bg-slate-50"
              : "border-amber-300 bg-amber-50"
          }`}>
            {!landUseAnalysisIsCurrent ? (
              <p className="mb-2 text-xs font-semibold text-amber-900">
                The boundary changed after this run. Analyze again to refresh the automatic selections.
              </p>
            ) : null}
            <div className="grid grid-cols-2 gap-1.5 text-xs lg:grid-cols-5">
              <div><span className="text-slate-500">Confidence</span><div className="font-semibold capitalize text-slate-900">{landUseAnalysis.confidence}</div></div>
              <div><span className="text-slate-500">Parcel coverage</span><div className="font-semibold text-slate-900">{landUseAnalysis.coverage_percent.toFixed(1)}%</div></div>
              <div><span className="text-slate-500">CAD parcels</span><div className="font-semibold text-slate-900">{landUseAnalysis.parcel_count.toLocaleString()}</div></div>
              <div><span className="text-slate-500">Needs review</span><div className="font-semibold text-slate-900">{landUseAnalysis.review_required_count.toLocaleString()}</div></div>
              <div><span className="text-slate-500">Built-up</span><div className="font-semibold text-slate-900">{landUseAnalysis.built_up_percent.toFixed(1)}% · {landUseAnalysis.built_up_label}</div></div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1.5 lg:grid-cols-5">
              {landUseAnalysis.categories.map((category) => (
                <div key={category.key} className="rounded-md border border-slate-200 bg-white px-2 py-1.5">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{category.label}</div>
                  <div className="text-sm font-semibold text-slate-900">{category.percentage.toFixed(1)}%</div>
                  <div className="text-[10px] text-slate-500">{category.area_acres.toFixed(2)} acres</div>
                </div>
              ))}
            </div>
            {landUseAnalysis.warnings.length ? (
              <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] text-amber-900">
                {landUseAnalysis.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            ) : null}
            <p className="mt-2 text-[10px] leading-4 text-slate-500">
              {landUseAnalysis.denominator_note} Analyzed {formatDate(landUseAnalysis.analyzed_at)}.
            </p>
            {landUseAnalysis.review_parcels.length ? (
              <details className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5">
                <summary className="cursor-pointer text-xs font-semibold text-amber-950">
                  Review uncertain parcel classifications ({landUseAnalysis.review_required_count})
                </summary>
                <div className="mt-2 max-h-52 space-y-1 overflow-y-auto">
                  {landUseAnalysis.review_parcels.map((parcel, index) => (
                    <div key={`${parcel.object_id || parcel.account_id || "parcel"}-${index}`} className="rounded border border-amber-200 bg-white p-2 text-[11px]">
                      <div className="font-semibold text-slate-900">
                        {parcel.site_address || parcel.account_id || `DCAD parcel ${parcel.object_id || index + 1}`}
                      </div>
                      <div className="text-slate-600">
                        {parcel.use_description || parcel.property_description || "Use not reported"} · {parcel.category_label} · {parcel.clipped_area_acres.toFixed(3)} acres
                      </div>
                      <div className="text-amber-900">{parcel.review_reason}</div>
                    </div>
                  ))}
                  {landUseAnalysis.review_parcels_truncated ? (
                    <p className="text-[11px] font-medium text-amber-900">Only the 250 largest review parcels are shown.</p>
                  ) : null}
                </div>
              </details>
            ) : null}
          </div>
        ) : assignmentDraft.neighborhood_land_use_analysis_source ? (
          <p className="mt-2 text-[10px] text-slate-500">
            Saved analysis: {assignmentDraft.neighborhood_land_use_analysis_source} · {formatNumber(assignmentDraft.neighborhood_land_use_parcel_count)} parcels · {formatNumber(assignmentDraft.neighborhood_land_use_coverage_percent)}% coverage{assignmentDraft.neighborhood_built_up_pct !== "" && assignmentDraft.neighborhood_built_up_pct != null ? ` · ${formatNumber(assignmentDraft.neighborhood_built_up_pct)}% built-up` : ""}
          </p>
        ) : null}
      </section>

      <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
        <div className="grid grid-cols-2 gap-2">
          {NEIGHBORHOOD_CHOICE_GROUPS.map((group) => (
            <fieldset key={group.field} className="rounded-lg border border-slate-200 bg-white p-2">
              <legend className="px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">{group.label}</legend>
              <div className="flex flex-wrap gap-1">
                {group.options.map(([value, label]) => (
                  <CheckboxChoice
                    key={value}
                     checked={assignmentDraft[group.field] === value}
                     label={label}
                     compact
                    onChange={(checked) => onAssignmentChange(group.field, checked ? value : "")}
                  />
                ))}
              </div>
            </fieldset>
          ))}
        </div>
        {assignmentDraft.neighborhood_market_change_pct !== "" || assignmentDraft.neighborhood_median_dom !== "" ? (
          <p className="mt-2 text-[10px] leading-4 text-slate-500">
            Automated market review: {formatNumber(assignmentDraft.neighborhood_market_change_pct)}% reconciled annualized change · {formatNumber(assignmentDraft.neighborhood_median_dom)}-day reconciled median DOM. Selections remain editable until saved.
          </p>
        ) : null}
      </section>
      </div>

      <section className="grid gap-3 lg:grid-cols-2">
        <div className="order-2 rounded-xl border border-slate-200 bg-white p-3 lg:col-span-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Unemployment Comparison</h3>
              <p className="mt-0.5 text-xs text-slate-500">Official ACS 5-year rates for the subject ZIP and its city.</p>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-xs normal-case text-blue-700"
              onClick={onRefreshUnemployment}
              disabled={unemploymentLoading}
            >
              {unemploymentLoading ? "Loading..." : "Refresh Census"}
            </button>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <label className="block rounded-lg bg-slate-50 p-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                ZIP {assignmentDraft.neighborhood_unemployment_zip || postalCode || "Not reported"}
              </span>
              <div className="relative mt-0.5">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  className="input input-bordered input-xs w-full bg-white pr-7"
                  value={assignmentDraft.neighborhood_unemployment_pct ?? ""}
                  onChange={(event) => onAssignmentChange("neighborhood_unemployment_pct", event.target.value)}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500">%</span>
              </div>
            </label>
            <label className="block rounded-lg bg-slate-50 p-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                {assignmentDraft.neighborhood_city_unemployment_name || "Subject City"}
              </span>
              <div className="relative mt-0.5">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  className="input input-bordered input-xs w-full bg-white pr-7"
                  value={assignmentDraft.neighborhood_city_unemployment_pct ?? ""}
                  onChange={(event) => onAssignmentChange("neighborhood_city_unemployment_pct", event.target.value)}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500">%</span>
              </div>
            </label>
          </div>
          {unemploymentDifference !== null ? (
            <div className={`mt-2 rounded-lg px-2 py-1.5 text-xs font-semibold ${
              Math.abs(unemploymentDifference) < 0.05
                ? "bg-slate-100 text-slate-700"
                : unemploymentDifference > 0
                  ? "bg-amber-50 text-amber-900"
                  : "bg-emerald-50 text-emerald-800"
            }`}>
              Subject ZIP is {Math.abs(unemploymentDifference).toFixed(1)} percentage point{Math.abs(unemploymentDifference) === 1 ? "" : "s"} {unemploymentDifference >= 0 ? "above" : "below"} the city rate.
            </div>
          ) : null}
          <div className="mt-1 text-[10px] leading-4 text-slate-500">
            {assignmentDraft.neighborhood_unemployment_source ? (
              <>
                {assignmentDraft.neighborhood_unemployment_source}, {assignmentDraft.neighborhood_unemployment_dataset_year} ACS 5-Year, variable {assignmentDraft.neighborhood_unemployment_variable}
              </>
            ) : `Awaiting Census lookup for ZIP ${postalCode || "not reported"} and the subject city.`}
          </div>
          {unemploymentMessage ? (
              <div className={`mt-1 text-[11px] font-medium ${
              /needs review|failed|not reported|must be configured/i.test(unemploymentMessage)
                ? "text-amber-800"
                : "text-emerald-700"
            }`}>{unemploymentMessage}</div>
          ) : null}
        </div>

        <div className="order-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-3 lg:col-span-2">
          <div className="grid gap-3 xl:grid-cols-2">
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">Neighborhood Sales Data (only includes sales)</h3>
                  <p className="mt-0.5 text-xs text-slate-500">Closed-sale low, high, and predominant medians from the selected market period and defined neighborhood.</p>
                </div>
                <span className="rounded-full bg-blue-50 px-2 py-1 text-[11px] font-semibold text-blue-800">
                  {assignmentDraft.neighborhood_sale_count === "" || assignmentDraft.neighborhood_sale_count == null
                    ? "Sales pending"
                    : `${formatNumber(assignmentDraft.neighborhood_sale_count)} sales`}
                </span>
              </div>
              <NeighborhoodRangeGrid
                rows={NEIGHBORHOOD_RANGE_ROWS}
                assignment={assignmentDraft}
                onChange={onAssignmentChange}
              />
            </div>

            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-slate-50/70 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">Neighborhood Profile (All properties, sold and unsold)</h3>
                  <p className="mt-0.5 text-xs text-slate-500">All improved one-unit properties within the same boundary; values use current Dallas CAD market value.</p>
                </div>
                <span className="rounded-full bg-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-700">
                  {assignmentDraft.neighborhood_all_property_count === "" || assignmentDraft.neighborhood_all_property_count == null
                    ? "Analyze land use"
                    : `${formatNumber(assignmentDraft.neighborhood_all_property_count)} properties`}
                </span>
              </div>
              <NeighborhoodRangeGrid
                rows={NEIGHBORHOOD_ALL_PROPERTY_ROWS}
                assignment={assignmentDraft}
                readOnly
                onChange={onAssignmentChange}
              />
              <p className="mt-2 text-[10px] leading-4 text-slate-500">
                Data coverage — value: {formatNumber(assignmentDraft.neighborhood_all_value_count)}; $/SF: {formatNumber(assignmentDraft.neighborhood_all_ppsf_count)}; age: {formatNumber(assignmentDraft.neighborhood_all_age_count)}; GLA: {formatNumber(assignmentDraft.neighborhood_all_gla_count)}. Loads automatically from the saved boundary; use Analyze Present Land Use to refresh.
              </p>
            </div>
          </div>

          <div className={`mt-3 rounded-xl border p-3 ${
            representativeness.score === null
              ? "border-slate-200 bg-slate-50"
              : representativeness.score >= 80
                ? "border-emerald-200 bg-emerald-50"
                : representativeness.score >= 65
                  ? "border-amber-200 bg-amber-50"
                  : "border-rose-200 bg-rose-50"
          }`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="text-sm font-semibold text-slate-900">Sales Sample Representativeness</h4>
                <p className="mt-0.5 text-xs text-slate-600">Equal-weight comparison of predominant sale price/value, price/value per square foot, age, and GLA.</p>
              </div>
              <span className="rounded-full bg-white px-3 py-1 text-sm font-bold text-slate-900 shadow-sm">
                {representativeness.score === null ? "Pending" : `${representativeness.score.toFixed(1)}%`} · {representativeness.label}
              </span>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {representativeness.factors.map((factor) => (
                <div key={factor.key} className="rounded-lg border border-white/80 bg-white p-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{factor.label}</div>
                  <div className="mt-0.5 text-sm font-bold text-slate-900">{factor.similarityScore.toFixed(1)}% similar</div>
                  <div className="text-[10px] text-slate-500">{factor.deviationPercent.toFixed(1)}% median deviation</div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-700">{representativeness.narrative}</p>
            <p className="mt-1 text-[10px] leading-4 text-slate-500">This is a descriptive sample check, not a substitute for appraiser review. CAD market values and MLS sale prices have different valuation bases, so their comparison is shown transparently.</p>
          </div>
          <div className={`mt-3 rounded-xl border p-3 ${
            valuePosition.ready
              ? valuePosition.recommendedReview
                ? "border-amber-300 bg-amber-50"
                : "border-blue-200 bg-blue-50/60"
              : "border-slate-200 bg-slate-50"
          }`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h4 className="text-sm font-semibold text-slate-900">Median Predominant Value</h4>
                <p className="mt-0.5 text-xs text-slate-600">
                  Subject value positioning and conformity explanation based on the defined neighborhood.
                </p>
              </div>
              <span className={`rounded-full px-2 py-1 text-[11px] font-semibold ${
                valuePosition.ready
                  ? valuePosition.recommendedReview
                    ? "bg-amber-200 text-amber-950"
                    : "bg-blue-100 text-blue-900"
                  : "bg-slate-200 text-slate-700"
              }`}>
                {!valuePosition.ready
                  ? "Awaiting value conclusion"
                  : valuePosition.relationship === "above_predominant"
                    ? "Above predominant"
                    : valuePosition.relationship === "below_predominant"
                      ? "Below predominant"
                      : "At predominant"}
              </span>
            </div>
            {valuePosition.ready ? (
              <>
                <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
                  <div className="rounded-lg border border-white/80 bg-white p-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Concluded Subject Value</div>
                    <div className="mt-0.5 text-sm font-bold text-slate-900">{formatMoney(effectiveConcludedValue)}</div>
                  </div>
                  <div className="rounded-lg border border-white/80 bg-white p-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Predominant Value</div>
                    <div className="mt-0.5 text-sm font-bold text-slate-900">{formatMoney(assignmentDraft.neighborhood_house_price_predominant)}</div>
                  </div>
                  <div className="rounded-lg border border-white/80 bg-white p-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Dollar Difference</div>
                    <div className="mt-0.5 text-sm font-bold text-slate-900">{formatMoney(Math.abs(valuePosition.difference || 0))}</div>
                  </div>
                  <div className="rounded-lg border border-white/80 bg-white p-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Percent Difference</div>
                    <div className="mt-0.5 text-sm font-bold text-slate-900">{Math.abs(valuePosition.differencePercent || 0).toFixed(1)}%</div>
                  </div>
                </div>
                {valuePosition.recommendedReview ? (
                  <div className="mt-2 rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-950">
                    E&amp;O review: the concluded value falls outside the observed neighborhood range. Review whether the subject is an {valuePosition.recommendedReview === "over_improvement" ? "over-improvement" : "under-improvement"} before finalizing conformity.
                  </div>
                ) : null}
                <label className="mt-3 block">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">Value Position and Conformity Commentary</span>
                  <textarea
                    rows={4}
                    className="textarea textarea-bordered mt-1 w-full bg-white text-sm leading-5"
                    value={assignmentDraft.neighborhood_value_conclusion || valuePosition.narrative}
                    onChange={(event) => onAssignmentChange("neighborhood_value_conclusion", event.target.value)}
                  />
                </label>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[10px] leading-4 text-slate-500">
                    Factors reviewed: GLA, site size, age, condition, quality, neighborhood range, and the appraiser's conformity classification. The explanation remains editable.
                  </span>
                  <button
                    type="button"
                    className="btn btn-neutral btn-xs normal-case rounded-lg text-white"
                    onClick={regenerateValueConclusion}
                  >
                    Regenerate Explanation
                  </button>
                </div>
              </>
            ) : (
              <div className="mt-3 rounded-lg border border-dashed border-slate-300 bg-white px-3 py-3 text-sm text-slate-600">
                {valuePosition.narrative}
              </div>
            )}
          </div>
          <div className="mt-2 border-t border-slate-200 pt-2">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h4 className="text-sm font-semibold text-slate-900">Full-City Average Comparison</h4>
                <p className="mt-0.5 text-xs text-slate-500 lg:hidden">
                  {assignmentDraft.neighborhood_city_name || "Subject city"} closed-sale averages; this does not replace the appraiser-defined neighborhood ranges.
                </p>
              </div>
              <span className="text-xs font-medium text-slate-600">
                {assignmentDraft.neighborhood_city_sale_count === "" || assignmentDraft.neighborhood_city_sale_count == null
                  ? "Sample pending"
                  : `${formatNumber(assignmentDraft.neighborhood_city_sale_count)} sales`}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4">
              {NEIGHBORHOOD_CITY_AVERAGE_ROWS.map((row) => (
                <div key={row.field} className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Average {row.label}</div>
                  <div className="mt-0.5 text-sm font-semibold text-slate-900">
                    {row.format === "money"
                      ? formatMoney(assignmentDraft[row.field])
                      : formatNumber(assignmentDraft[row.field], row.label === "GLA" ? " sq. ft." : " years")}
                  </div>
                </div>
              ))}
            </div>
            {assignmentDraft.neighborhood_city_comparison_as_of ? (
              <p className="mt-2 text-[11px] text-slate-500">Analysis through {formatDate(assignmentDraft.neighborhood_city_comparison_as_of)}</p>
            ) : null}
          </div>
        </div>
      </section>

      <section className={`rounded-xl border p-3 ${
        boundaryErrors.length ? "border-amber-300 bg-amber-50" : "border-emerald-300 bg-emerald-50"
      }`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Neighborhood Boundaries</h3>
            <p className="mt-0.5 text-xs text-slate-600">
              {assignmentDraft.neighborhood_boundary_geometry
                ? `${assignmentDraft.neighborhood_boundary_label || "Appraiser-defined market area"} · ${Math.max(boundaryRing.length - 1, 0)} boundary vertices`
                : "The automatic neighborhood suggestion is loading; manual drawing remains available if needed."}
            </p>
            {assignmentDraft.neighborhood_boundary_saved_at ? (
              <p className="mt-0.5 text-[10px] text-slate-500">Market study saved {formatDate(assignmentDraft.neighborhood_boundary_saved_at)}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-neutral btn-sm normal-case rounded-lg text-white"
              onClick={() => void generateSuggestedBoundary()}
              disabled={!accountId || generatedBoundaryLoading}
            >
              {generatedBoundaryLoading ? "Loading..." : "Regenerate Suggested Boundary"}
            </button>
            <button
              type="button"
              className="btn btn-neutral btn-sm normal-case rounded-lg text-white"
              onClick={() => void analyzeRelevantPropertyDataset()}
              disabled={
                !accountId || relevanceLoading ||
                !assignmentDraft.neighborhood_boundary_engine_assessment_id
              }
            >
              {relevanceLoading ? "Analyzing..." : "Analyze Relevant Properties"}
            </button>
            <button
              type="button"
              className="btn btn-outline btn-sm normal-case"
              onClick={onRefreshBoundary}
              disabled={!customAreaAvailable || profileLoading}
            >
              {profileLoading ? "Refreshing..." : "Refresh Area Data"}
            </button>
          </div>
        </div>
        {generatedBoundaryMessage ? (
          <div className={`mt-2 rounded-lg border px-3 py-2 text-xs ${
            generatedBoundary
              ? "border-blue-200 bg-blue-50 text-blue-950"
              : "border-amber-200 bg-amber-50 text-amber-950"
          }`}>
            <div className="font-medium">{generatedBoundaryMessage}</div>
            {generatedBoundary ? (
              <>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                  <span>Confidence: <strong className="capitalize">{generatedBoundary.confidence}</strong></span>
                  <span>Profile: <strong>{generatedBoundary.evidence.discovery?.profile_label || generatedBoundary.search_profile}</strong></span>
                  <span>Radius: <strong>{generatedBoundary.discovery_radius_miles} miles</strong></span>
                </div>
                {(generatedBoundary.evidence.warnings || []).length ? (
                  <ul className="mt-1 list-disc pl-4 text-[11px]">
                    {(generatedBoundary.evidence.warnings || []).map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                ) : null}
                {generatedBoundary.evidence.disclosure ? (
                  <p className="mt-1 text-[10px] leading-4 text-blue-900">
                    {generatedBoundary.evidence.disclosure}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
        {relevanceMessage ? (
          <div className={`mt-2 rounded-lg border px-3 py-2 text-xs ${
            relevanceAssessment
              ? "border-emerald-200 bg-emerald-50 text-emerald-950"
              : "border-amber-200 bg-amber-50 text-amber-950"
          }`}>
            <div className="font-medium">{relevanceMessage}</div>
            {relevanceAssessment ? (
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                <span>Confidence: <strong className="capitalize">{relevanceAssessment.confidence.confidence || "limited"}</strong></span>
                <span>Low-score exclusions: <strong>{relevanceAssessment.summary.low_relevance_excluded_count}</strong></span>
                <span>Dissimilar-pocket exclusions: <strong>{relevanceAssessment.summary.dissimilar_pocket_excluded_count}</strong></span>
                <span>Sale prices time-adjusted: <strong>No</strong></span>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="mt-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Appraisal Boundary Summary</span>
          <div className="mt-1 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {([
              ["neighborhood_boundary_north", "North"],
              ["neighborhood_boundary_east", "East"],
              ["neighborhood_boundary_south", "South"],
              ["neighborhood_boundary_west", "West"],
            ] as const).map(([field, label]) => (
              <label key={field} className="block">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</span>
                <input
                  type="text"
                  list={`boundary-${label.toLowerCase()}-candidates`}
                  className="input input-bordered input-xs mt-0.5 w-full bg-white"
                  value={assignmentDraft[field] || ""}
                  onChange={(event) => updateBoundarySide(field, event.target.value)}
                  placeholder={`${label} boundary road`}
                />
                <datalist id={`boundary-${label.toLowerCase()}-candidates`}>
                  {boundarySuggestions?.[label.toLowerCase() as "north" | "east" | "south" | "west"]?.candidates.map((candidate) => (
                    <option
                      key={candidate.name}
                      value={candidate.name}
                      label={`Score ${candidate.score.toFixed(2)} · ${candidate.analysis_edge_relation || "edge"} ${candidate.signed_distance_to_analysis_edge_miles ?? candidate.distance_to_analysis_edge_miles ?? "?"} mi`}
                    />
                  ))}
                </datalist>
                {boundarySuggestions?.[label.toLowerCase() as "north" | "east" | "south" | "west"]?.confidence ? (
                    <span className="mt-0.5 block text-[10px] text-slate-500">
                    Automated confidence: {boundarySuggestions[label.toLowerCase() as "north" | "east" | "south" | "west"].confidence}
                  </span>
                ) : null}
              </label>
            ))}
          </div>
          <label className="mt-2 block">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Exclusions / Irregular Areas</span>
            <textarea
              rows={5}
              className="textarea textarea-bordered mt-0.5 min-h-24 w-full bg-white py-2 text-xs leading-5"
              value={assignmentDraft.neighborhood_boundary_exclusions || ""}
              onChange={(event) => onAssignmentChange("neighborhood_boundary_exclusions", event.target.value)}
              placeholder="Describe excluded subdivisions, pockets, or irregular boundary sections"
            />
          </label>
          <span className="mt-0.5 block text-[10px] leading-4 text-slate-500">
            The system suggests the dominant road on each side. Review and edit these fields for appraisal use; record irregular exclusions separately.
            {assignmentDraft.neighborhood_boundary_streets_source
              ? ` Source: ${assignmentDraft.neighborhood_boundary_streets_source}.`
              : ""}
          </span>
        </div>
        {profileMessage ? (
            <div className={`mt-2 text-xs font-medium ${/updated|loaded|refreshed/i.test(profileMessage) ? "text-emerald-800" : "text-amber-900"}`}>
            {profileMessage}
          </div>
        ) : null}
        <div className="mt-2 max-w-xl">
          <CheckboxChoice
            checked={Boolean(assignmentDraft.neighborhood_boundary_confirmed)}
            disabled={!assignmentDraft.neighborhood_boundary_geometry}
            label="I reviewed this boundary for the current appraisal file"
            compact
            onChange={onConfirmBoundary}
          />
        </div>
        {boundaryErrors.length ? (
          <div className="mt-2 text-xs font-medium text-amber-950">
            PDF E&amp;O blocker: {boundaryErrors.join(" ")}
          </div>
        ) : (
          <div className="mt-2 text-xs font-medium text-emerald-900">Boundary is confirmed and ready for the appraisal PDF.</div>
        )}
      </section>

      {accountId ? (
        <section className="border-t border-slate-200 pt-3">
          <MarketConditionsAnalysis
            key={`property-report-market-conditions-${accountId}`}
            subjectAccountId={accountId}
            onCompletionChange={onMarketConditionsChange}
            initialCustomGeometry={assignmentDraft.neighborhood_boundary_geometry}
            initialCustomGeometrySource={assignmentDraft.neighborhood_boundary_source}
            suggestedCustomGeometry={generatedBoundary?.boundary || null}
            onCustomGeometryChange={handleCustomGeometryChange}
            embedded
          />
        </section>
      ) : (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">
          A property account is required before the market conditions analysis can be run.
        </section>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-slate-500">
          {assignmentSaveMessage || (assignmentDirty ? "Unsaved neighborhood changes" : "No unsaved changes")}
        </span>
        <button
          type="button"
          onClick={onSave}
          className="btn btn-primary btn-sm normal-case rounded-lg shadow-sm"
          disabled={assignmentSaveDisabled}
        >
          {savingAssignmentFile ? "Saving..." : "Save Neighborhood Characteristics"}
        </button>
      </div>
    </div>
  );
}

function ListingsContractsSalesContent({
  listingRows,
  salesHistoryRows,
  assignmentDraft,
  purchaseTransactionSelected,
  assignmentErrors,
  assignmentDirty,
  assignmentSaveMessage,
  assignmentSaveDisabled,
  savingAssignmentFile,
  contractSellerComparison,
  onAssignmentChange,
  onSave,
}: {
  listingRows: DcadSaleHistoryRow[];
  salesHistoryRows: DcadSaleHistoryRow[];
  assignmentDraft: AssignmentDetails;
  purchaseTransactionSelected: boolean;
  assignmentErrors: string[];
  assignmentDirty: boolean;
  assignmentSaveMessage: string;
  assignmentSaveDisabled: boolean;
  savingAssignmentFile: boolean;
  contractSellerComparison: ReturnType<typeof sellerComparisonSummary>;
  onAssignmentChange: <K extends keyof AssignmentDetails>(
    key: K,
    value: AssignmentDetails[K],
  ) => void;
  onSave: () => void;
}) {
  const listingColumns =
    "minmax(150px,1.2fr) minmax(115px,.85fr) minmax(115px,.85fr) minmax(115px,.85fr) minmax(150px,1.1fr) minmax(130px,1fr)";
  const salesColumns =
    "minmax(100px,.9fr) minmax(100px,.8fr) minmax(70px,.6fr) minmax(160px,1.3fr) minmax(110px,.9fr) minmax(110px,.9fr) minmax(70px,.5fr) minmax(190px,1.5fr)";

  return (
    <>
      <section>
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-slate-900">Listings</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Consolidated MLS listing dates, contract activity, and closing terms.
          </p>
        </div>
        {listingRows.length ? (
          <div className="overflow-x-auto">
            <div className="min-w-[900px]">
              <div
                className="grid items-end gap-x-4 border-b border-slate-300 px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-600"
                style={{ gridTemplateColumns: listingColumns }}
              >
                <div>MLS / Source #</div>
                <div>List Date</div>
                <div>Contract Date</div>
                <div>Closing Date</div>
                <div>Financing Type</div>
                <div>Concessions</div>
              </div>
              {listingRows.slice(0, 20).map((event, index) => (
                <div
                  key={event.listing_id || event.listing_key || event.source_record_id || index}
                  className="grid items-start gap-x-4 border-b border-slate-200 px-1 py-2.5 text-sm last:border-b-0"
                  style={{ gridTemplateColumns: listingColumns }}
                >
                  <div>
                    <div className="font-medium text-slate-800">
                      {displayValue(
                        event.listing_id || event.listing_key || event.source_record_id,
                        "—",
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {displayValue(event.source, "Source not reported")}
                    </div>
                  </div>
                  <div className="whitespace-nowrap">{formatDate(event.listing_date)}</div>
                  <div className="whitespace-nowrap">{formatDate(event.contract_date)}</div>
                  <div className="whitespace-nowrap">{formatDate(event.closing_date)}</div>
                  <div>{displayValue(event.buyer_financing)}</div>
                  <div>{displayValue(event.concessions)}</div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-600">
            No linked MLS listing records are currently available for this parcel.
          </div>
        )}
      </section>

      <section className="mt-6 border-t border-slate-200 pt-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Contract Analysis</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Assignment-specific contract terms and seller-to-public-record verification.
            </p>
          </div>
          <div className="min-w-[230px]">
            <CheckboxChoice
              checked={Boolean(assignmentDraft.subject_under_contract)}
              label="Subject Under Contract"
              disabled={!purchaseTransactionSelected}
              onChange={(checked) => onAssignmentChange("subject_under_contract", checked)}
            />
          </div>
        </div>

        {!purchaseTransactionSelected ? (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
            Select Purchase Transaction in Assignment Details before marking the subject under contract.
          </div>
        ) : null}

        {assignmentDraft.subject_under_contract ? (
          <div className="mt-4 space-y-4">
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              <label className="block lg:col-span-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Contract Seller Name(s)
                </span>
                <input
                  type="text"
                  maxLength={1000}
                  className="input input-bordered input-sm mt-1 w-full bg-white"
                  value={assignmentDraft.contract_seller_names || ""}
                  onChange={(event) => onAssignmentChange("contract_seller_names", event.target.value)}
                  placeholder="Seller name exactly as shown in the contract"
                />
              </label>
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Contract Date
                </span>
                <input
                  type="date"
                  className="input input-bordered input-sm mt-1 w-full bg-white"
                  value={String(assignmentDraft.contract_date || "").slice(0, 10)}
                  onChange={(event) => onAssignmentChange("contract_date", event.target.value)}
                />
              </label>
              {CONTRACT_AMOUNT_FIELDS.map(([field, label]) => (
                <label key={field} className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                    {label}
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    className="input input-bordered input-sm mt-1 w-full bg-white"
                    value={assignmentDraft[field] ?? ""}
                    onChange={(event) => onAssignmentChange(field, event.target.value)}
                    placeholder="Dollar amount"
                  />
                </label>
              ))}
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <fieldset className="rounded-xl border border-slate-200 bg-white p-3">
                <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Arms Length
                </legend>
                <div className="grid grid-cols-2 gap-2">
                  <CheckboxChoice
                    checked={assignmentDraft.contract_arms_length === true}
                    label="Yes"
                    onChange={(checked) => onAssignmentChange(
                      "contract_arms_length",
                      checked ? true : null,
                    )}
                  />
                  <CheckboxChoice
                    checked={assignmentDraft.contract_arms_length === false}
                    label="No"
                    onChange={(checked) => onAssignmentChange(
                      "contract_arms_length",
                      checked ? false : null,
                    )}
                  />
                </div>
              </fieldset>

              <fieldset className="rounded-xl border border-slate-200 bg-white p-3">
                <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Does Seller Match Public Records?
                </legend>
                <div className="grid grid-cols-2 gap-2">
                  <CheckboxChoice
                    checked={assignmentDraft.seller_matches_public_records === true}
                    label="Yes"
                    onChange={(checked) => onAssignmentChange(
                      "seller_matches_public_records",
                      checked ? true : null,
                    )}
                  />
                  <CheckboxChoice
                    checked={assignmentDraft.seller_matches_public_records === false}
                    label="No"
                    onChange={(checked) => onAssignmentChange(
                      "seller_matches_public_records",
                      checked ? false : null,
                    )}
                  />
                </div>
              </fieldset>
            </div>

            <div className={`rounded-xl border p-3 text-sm ${
              contractSellerComparison.matches === true
                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                : contractSellerComparison.matches === false
                  ? "border-amber-300 bg-amber-50 text-amber-950"
                  : "border-slate-200 bg-slate-50 text-slate-700"
            }`}>
              <div className="text-xs font-semibold uppercase tracking-wide">Seller Comparison</div>
              <p className="mt-1">{contractSellerComparison.summary}</p>
            </div>

            {assignmentDraft.seller_matches_public_records === false ? (
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Seller Difference Explanation
                </span>
                <textarea
                  maxLength={3000}
                  className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
                  value={assignmentDraft.seller_mismatch_explanation || ""}
                  onChange={(event) => onAssignmentChange(
                    "seller_mismatch_explanation",
                    event.target.value,
                  )}
                  placeholder="Required when the contract seller does not match CAD ownership"
                />
              </label>
            ) : null}
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-500">
            Contract terms remain hidden until Subject Under Contract is selected.
          </p>
        )}

        {assignmentErrors.length ? (
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            <ul className="list-disc space-y-1 pl-5">
              {assignmentErrors.map((error) => <li key={error}>{error}</li>)}
            </ul>
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-slate-500">
            {assignmentSaveMessage || (assignmentDirty ? "Unsaved assignment changes" : "No unsaved changes")}
          </span>
          <button
            type="button"
            onClick={onSave}
            className="btn btn-primary btn-sm normal-case rounded-lg shadow-sm"
            disabled={assignmentSaveDisabled}
          >
            {savingAssignmentFile ? "Saving..." : "Save Contract Analysis"}
          </button>
        </div>
      </section>

      <section className="mt-6 border-t border-slate-200 pt-5">
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-slate-900">Sales History</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Closed MLS sales and CAD deed-transfer records.
          </p>
        </div>
        {salesHistoryRows.length ? (
          <div className="overflow-x-auto">
            <div className="min-w-[1120px]">
              <div
                className="grid items-end gap-x-4 border-b border-slate-300 px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-600"
                style={{ gridTemplateColumns: salesColumns }}
              >
                <div>Activity</div>
                <div>Date</div>
                <div>MLS</div>
                <div>Status / Source</div>
                <div className="text-right">List Price</div>
                <div className="text-right">Sale Price</div>
                <div className="text-right">DOM</div>
                <div>Financing / Concessions</div>
              </div>
              {salesHistoryRows.slice(0, 20).map((event, index) => (
                <div
                  key={event.source_record_id || event.sale_id || `${event.record_type}-${event.activity_date}-${index}`}
                  className="grid items-start gap-x-4 border-b border-slate-200 px-1 py-2.5 text-sm last:border-b-0"
                  style={{ gridTemplateColumns: salesColumns }}
                >
                  <div>
                    <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${activityTypeClass(event.record_type)}`}>
                      {activityTypeLabel(event.record_type)}
                    </span>
                    {event.requires_additional_review ? (
                      <span className="ml-1 text-xs font-semibold text-amber-700" title="Source record needs review">!</span>
                    ) : null}
                  </div>
                  <div className="whitespace-nowrap">
                    {formatDate(event.activity_date || event.closing_date || event.listing_date)}
                  </div>
                  <div>{displayValue(event.listing_id, "—")}</div>
                  <div>
                    <div className="font-medium text-slate-800">
                      {displayValue(event.mls_status, activityTypeLabel(event.record_type))}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {displayValue(event.source, "Source not reported")}
                    </div>
                  </div>
                  <div className="whitespace-nowrap text-right">{formatMoney(event.list_price)}</div>
                  <div className="whitespace-nowrap text-right">{formatMoney(event.sale_price)}</div>
                  <div className="text-right">{displayValue(event.days_on_market, "—")}</div>
                  <div className="text-xs leading-5">
                    <div>{displayValue(event.buyer_financing, "Financing not reported")}</div>
                    {hasValue(event.concessions) ? (
                      <div className="mt-0.5 text-slate-500">Concessions: {displayValue(event.concessions)}</div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-600">
            No linked closed-sale or CAD deed-transfer records are currently available.
          </div>
        )}
      </section>
    </>
  );
}

function formatReportedBoolean(value: unknown): string {
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (!hasValue(value)) return "Not reported";
  const normalized = String(value).trim().toLowerCase();
  if (["yes", "y", "true", "1"].includes(normalized)) return "Yes";
  if (["no", "n", "false", "0"].includes(normalized)) return "No";
  return String(value);
}

function formatBaths(improvement?: DcadMainImprovement): string {
  const full = parseNumber(improvement?.baths_full);
  const half = parseNumber(improvement?.baths_half);
  if (full !== null || half !== null) {
    return `${full ?? 0} full / ${half ?? 0} half`;
  }
  return displayValue(improvement?.bath_count);
}

function SummarySection({
  title,
  subtitle,
  children,
  onEdit,
  actions,
  manuallyVerified = false,
  compact = false,
  collapsible = false,
  defaultExpanded = true,
  className = "",
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onEdit?: () => void;
  actions?: ReactNode;
  manuallyVerified?: boolean;
  compact?: boolean;
  collapsible?: boolean;
  defaultExpanded?: boolean;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <section className={`rounded-2xl border border-slate-200 bg-slate-50/70 ${
      compact ? "p-3 sm:p-4" : "p-4 sm:p-5"
    } ${className}`}>
      <div className={`${compact ? "mb-3" : "mb-4"} flex items-start justify-between gap-3`}>
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-slate-800">
              {title}
            </h2>
            {manuallyVerified ? (
              <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold normal-case tracking-normal text-blue-800">
                Manually verified
              </span>
            ) : null}
          </div>
          {subtitle ? <p className="mt-1 text-xs text-slate-500">{subtitle}</p> : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {(!collapsible || expanded) && (actions || (onEdit ? (
            <button
              type="button"
              onClick={onEdit}
              className="btn btn-sm normal-case border-slate-300 bg-white text-slate-800 hover:border-blue-400 hover:bg-blue-50"
            >
              Edit
            </button>
          ) : null))}
          {collapsible ? (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
              className="btn btn-sm normal-case rounded-lg border-slate-950 bg-slate-950 text-white hover:border-black hover:bg-black"
            >
              {expanded ? "Collapse" : "Expand"}
            </button>
          ) : null}
        </div>
      </div>
      {!collapsible || expanded ? children : null}
    </section>
  );
}

function SummaryField({
  label,
  value,
  className = "",
}: {
  label: string;
  value?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 break-words text-sm font-semibold text-slate-900">
        {value ?? "Not reported"}
      </div>
    </div>
  );
}

function editorLabel(key: string): string {
  const overrides: Record<string, string> = {
    mls_status: "MLS Status",
    listing_id: "MLS Number",
    area_sqft: "Area (Sq. Ft.)",
    living_area_sqft: "Living Area (Sq. Ft.)",
    total_area_sqft: "Total Area (Sq. Ft.)",
    postal_code: "ZIP Code",
    baths_full: "Full Baths",
    baths_half: "Half Baths",
    homestead_yes: "Homestead",
  };
  return overrides[key] || key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function cloneEditorValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? {})) as T;
}

function editorValueAtPath(
  root: Record<string, unknown>,
  path: Array<string | number>,
): unknown {
  let cursor: unknown = root;
  path.forEach((segment) => {
    if (Array.isArray(cursor) && typeof segment === "number") {
      cursor = cursor[segment];
    } else if (cursor && typeof cursor === "object") {
      cursor = (cursor as Record<string, unknown>)[String(segment)];
    } else {
      throw new Error("Invalid report editor field path");
    }
  });
  return cursor;
}

function ReportSectionEditor({
  section,
  initialValue,
  saving,
  onCancel,
  onSave,
}: {
  section: EditableReportSection;
  initialValue: Record<string, unknown>;
  saving: boolean;
  onCancel: () => void;
  onSave: (value: Record<string, unknown>) => void;
}) {
  const [draft, setDraft] = useState<Record<string, unknown>>(() =>
    cloneEditorValue(initialValue),
  );

  useEffect(() => {
    setDraft(cloneEditorValue(initialValue));
  }, [initialValue, section.key]);

  const updateAtPath = (path: Array<string | number>, nextValue: unknown) => {
    setDraft((current) => {
      const next = cloneEditorValue(current);
      const parent = editorValueAtPath(next, path.slice(0, -1));
      const finalSegment = path[path.length - 1];
      if (Array.isArray(parent) && typeof finalSegment === "number") {
        parent[finalSegment] = nextValue;
      } else if (parent && typeof parent === "object") {
        (parent as Record<string, unknown>)[String(finalSegment)] = nextValue;
      }
      return next;
    });
  };

  const removeArrayItem = (path: Array<string | number>, index: number) => {
    setDraft((current) => {
      const next = cloneEditorValue(current);
      const cursor = editorValueAtPath(next, path);
      if (Array.isArray(cursor)) cursor.splice(index, 1);
      return next;
    });
  };

  const addArrayItem = (path: Array<string | number>, key: string) => {
    setDraft((current) => {
      const next = cloneEditorValue(current);
      const cursor = editorValueAtPath(next, path);
      if (Array.isArray(cursor)) {
        cursor.push(cloneEditorValue(ARRAY_ROW_TEMPLATES[key] || {}));
      }
      return next;
    });
  };

  const assignment = draft as AssignmentDetails;
  const assignmentTypes = Array.isArray(assignment.assignment_types)
    ? assignment.assignment_types
    : [];
  const assignmentErrors = section.key === "report.assignment_details"
    ? assignmentValidationErrors(assignment)
    : [];

  const checkboxOption = (
    checked: boolean,
    label: string,
    onChange: (checked: boolean) => void,
  ) => (
    <label className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium ${
      checked
        ? "border-blue-400 bg-blue-50 text-blue-900"
        : "border-slate-200 bg-white text-slate-700"
    }`}>
      <input
        type="checkbox"
        className="checkbox checkbox-sm checkbox-primary"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );

  const assignmentEditor = section.key === "report.assignment_details" ? (
    <div className="space-y-5">
      <fieldset className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <legend className="px-1 text-sm font-semibold text-slate-900">Lender / Client</legend>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              Lender / Client
            </span>
            <input
              type="text"
              maxLength={500}
              className="input input-bordered mt-1 w-full bg-white"
              value={assignment.lender_client_name || ""}
              onChange={(event) => updateAtPath(["lender_client_name"], event.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              Lender / Client Address
            </span>
            <textarea
              maxLength={2000}
              className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
              value={assignment.lender_client_address || ""}
              onChange={(event) => updateAtPath(["lender_client_address"], event.target.value)}
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <legend className="px-1 text-sm font-semibold text-slate-900">Planned Unit Development</legend>
        <div className="mt-1 max-w-xs">
          {checkboxOption(Boolean(assignment.pud), "PUD", (checked) =>
            updateAtPath(["pud"], checked),
          )}
        </div>
        {assignment.pud ? (
          <div className="mt-4 space-y-4">
            <label className="block max-w-sm">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                HOA Dues Amount
              </span>
              <input
                type="number"
                min="0"
                step="0.01"
                className="input input-bordered mt-1 w-full bg-white"
                value={assignment.hoa_dues_amount ?? ""}
                onChange={(event) => updateAtPath(["hoa_dues_amount"], event.target.value)}
                placeholder="Dollar amount"
              />
            </label>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                HOA Dues Frequency
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {HOA_FREQUENCY_OPTIONS.map(([value, label]) =>
                  <div key={value}>
                    {checkboxOption(assignment.hoa_frequency === value, label, (checked) =>
                      updateAtPath(["hoa_frequency"], checked ? value : ""),
                    )}
                  </div>
                )}
              </div>
            </div>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                HOA Explanation
              </span>
              <textarea
                className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
                value={assignment.hoa_explanation || ""}
                onChange={(event) => updateAtPath(["hoa_explanation"], event.target.value)}
                placeholder="Required when dues are unavailable or the frequency is Other"
              />
            </label>
          </div>
        ) : null}
      </fieldset>

      <fieldset className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <legend className="px-1 text-sm font-semibold text-slate-900">Occupancy</legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {OCCUPANCY_OPTIONS.map(([value, label]) =>
            <div key={value}>
              {checkboxOption(assignment.occupancy === value, label, (checked) =>
                updateAtPath(["occupancy"], checked ? value : ""),
              )}
            </div>
          )}
        </div>
        {assignment.occupancy === "unknown" ? (
          <label className="mt-4 block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              Unknown Occupancy Explanation
            </span>
            <textarea
              className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
              value={assignment.occupancy_explanation || ""}
              onChange={(event) => updateAtPath(["occupancy_explanation"], event.target.value)}
            />
          </label>
        ) : null}
      </fieldset>

      <fieldset className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <legend className="px-1 text-sm font-semibold text-slate-900">Assignment Type</legend>
        <p className="mb-3 text-xs text-slate-600">Select every type that applies to the assignment.</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {ASSIGNMENT_TYPE_OPTIONS.map(([value, label]) =>
            <div key={value}>
              {checkboxOption(assignmentTypes.includes(value), label, (checked) => {
                const next = checked
                  ? [...new Set([...assignmentTypes, value])]
                  : assignmentTypes.filter((item) => item !== value);
                updateAtPath(["assignment_types"], next);
              })}
            </div>
          )}
        </div>
        {assignmentTypes.includes("other") ? (
          <label className="mt-4 block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              Other Assignment Explanation
            </span>
            <textarea
              className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
              value={assignment.assignment_explanation || ""}
              onChange={(event) => updateAtPath(["assignment_explanation"], event.target.value)}
            />
          </label>
        ) : null}
      </fieldset>

      {assignmentErrors.length ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          <ul className="list-disc space-y-1 pl-5">
            {assignmentErrors.map((error) => <li key={error}>{error}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  ) : null;

  const renderValue = (
    value: unknown,
    path: Array<string | number>,
    key: string,
  ): ReactNode => {
    if (Array.isArray(value)) {
      if (value.every((item) => typeof item === "string")) {
        return (
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              {editorLabel(key)}
            </span>
            <textarea
              className="textarea textarea-bordered mt-1 min-h-24 w-full bg-white"
              value={value.join("\n")}
              onChange={(event) =>
                updateAtPath(path, event.target.value.split("\n").filter(Boolean))
              }
            />
          </label>
        );
      }
      return (
        <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-slate-800">{editorLabel(key)}</div>
            <button
              type="button"
              onClick={() => addArrayItem(path, key)}
              className="btn btn-xs normal-case border-blue-300 bg-white text-blue-800"
            >
              Add record
            </button>
          </div>
          {value.length ? value.map((item, index) => (
            <div key={index} className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500">Record {index + 1}</span>
                <button
                  type="button"
                  onClick={() => removeArrayItem(path, index)}
                  className="btn btn-ghost btn-xs normal-case text-rose-700"
                >
                  Remove
                </button>
              </div>
              {renderValue(item, [...path, index], `${key}_${index + 1}`)}
            </div>
          )) : (
            <div className="text-xs text-slate-500">No records. Select Add record to create one.</div>
          )}
        </div>
      );
    }
    if (value && typeof value === "object") {
      return (
        <fieldset className="rounded-xl border border-slate-200 bg-white p-3">
          <legend className="px-1 text-sm font-semibold text-slate-800">
            {editorLabel(key)}
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => (
              <div
                key={childKey}
                className={Array.isArray(childValue) || (childValue && typeof childValue === "object")
                  ? "sm:col-span-2"
                  : ""}
              >
                {renderValue(childValue, [...path, childKey], childKey)}
              </div>
            ))}
          </div>
        </fieldset>
      );
    }
    if (typeof value === "boolean") {
      return (
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
            {editorLabel(key)}
          </span>
          <select
            className="select select-bordered mt-1 w-full bg-white"
            value={value ? "true" : "false"}
            onChange={(event) => updateAtPath(path, event.target.value === "true")}
          >
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </label>
      );
    }
    if (key === "attachment_type") {
      return (
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
            Attachment Type
          </span>
          <select
            className="select select-bordered mt-1 w-full bg-white"
            value={value == null ? "unknown" : String(value)}
            onChange={(event) => updateAtPath(path, event.target.value)}
          >
            <option value="detached">Detached</option>
            <option value="attached">Attached</option>
            <option value="mixed">Mixed</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
      );
    }
    const isLongText = ["legal_text", "mailing_address", "notes"].includes(key);
    return (
      <label className="block">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
          {editorLabel(key)}
        </span>
        {isLongText ? (
          <textarea
            className="textarea textarea-bordered mt-1 w-full bg-white"
            value={value == null ? "" : String(value)}
            onChange={(event) => updateAtPath(path, event.target.value)}
          />
        ) : (
          <input
            type={key.includes("date") ? "date" : typeof value === "number" ? "number" : "text"}
            className="input input-bordered mt-1 w-full bg-white"
            value={value == null ? "" : String(value)}
            onChange={(event) =>
              updateAtPath(
                path,
                typeof value === "number" && event.target.value !== ""
                  ? Number(event.target.value)
                  : event.target.value,
              )
            }
          />
        )}
      </label>
    );
  };

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-950/60 p-3 sm:p-6">
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-bold text-slate-950">Edit {section.title}</h2>
            <p className="mt-1 text-xs text-slate-600">
              Saved values override the report display and are retained with revision history.
            </p>
          </div>
          <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm" disabled={saving}>
            Close
          </button>
        </div>
        <div className="space-y-4 overflow-y-auto p-5">
          {assignmentEditor || Object.entries(draft).map(([key, value]) => (
            <div key={key}>{renderValue(value, [key], key)}</div>
          ))}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-4">
          <button type="button" onClick={onCancel} className="btn btn-ghost normal-case" disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(draft)}
            className="btn normal-case border-blue-600 bg-blue-600 text-white hover:bg-blue-700"
            disabled={saving || assignmentErrors.length > 0}
          >
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddressHero({
  detail,
  accountId,
  onReload,
}: {
  detail: DcadDetail | null;
  accountId?: string;
  onReload: () => Promise<void>;
}) {
  const [photoIndex, setPhotoIndex] = useState(0);
  const [relatedParcelSearchVersion, setRelatedParcelSearchVersion] = useState(0);
  const [relatedParcels, setRelatedParcels] = useState<RelatedParcelsResponse | null>(null);
  const [relatedParcelsLoading, setRelatedParcelsLoading] = useState(false);
  const [relatedParcelsError, setRelatedParcelsError] = useState("");
  const [editingSection, setEditingSection] = useState<EditableReportSection | null>(null);
  const [savingSection, setSavingSection] = useState(false);
  const [assignmentDraft, setAssignmentDraft] = useState<AssignmentDetails>(() =>
    assignmentDraftFromDetail(),
  );
  const [assignmentDirty, setAssignmentDirty] = useState(false);
  const [assignmentSaveMessage, setAssignmentSaveMessage] = useState("");
  const [assignmentFiles, setAssignmentFiles] = useState<AppraisalAssignmentFile[]>([]);
  const [assignmentFilesLoading, setAssignmentFilesLoading] = useState(false);
  const [assignmentFilesLoaded, setAssignmentFilesLoaded] = useState(false);
  const [assignmentFilesError, setAssignmentFilesError] = useState("");
  const [activeAssignmentFile, setActiveAssignmentFile] = useState<AppraisalAssignmentFile | null>(null);
  const [assignmentFileNumber, setAssignmentFileNumber] = useState("");
  const [savingAssignmentFile, setSavingAssignmentFile] = useState(false);
  const [censusLookupLoading, setCensusLookupLoading] = useState(false);
  const [censusLookupMessage, setCensusLookupMessage] = useState("");
  const [unemploymentLookupLoading, setUnemploymentLookupLoading] = useState(false);
  const [unemploymentLookupMessage, setUnemploymentLookupMessage] = useState("");
  const [unemploymentAutoAttemptedSignature, setUnemploymentAutoAttemptedSignature] = useState("");
  const unemploymentLookupSucceeded = useRef(false);
  const unemploymentHydrationAccount = useRef("");
  const [neighborhoodProfileLoading, setNeighborhoodProfileLoading] = useState(false);
  const [neighborhoodSectionReady, setNeighborhoodSectionReady] = useState(false);
  const [neighborhoodProfileMessage, setNeighborhoodProfileMessage] = useState("");
  const [neighborhoodBoundarySuggestions, setNeighborhoodBoundarySuggestions] = useState<
    NonNullable<NeighborhoodProfileResponse["boundary_streets"]>["cardinal_boundaries"] | null
  >(null);
  const neighborhoodProfileAttemptedSignature = useRef("");
  const [marketConditionsDraft, setMarketConditionsDraft] = useState<MarketConditionsDraft | null>(
    () => readMarketConditionsDraft(accountId || ""),
  );
  const [salesComparisonDraft, setSalesComparisonDraft] = useState<AppraisalReportSalesDraft | null>(
    () => readAppraisalReportDraft(accountId || ""),
  );
  const [propertyContext, setPropertyContext] = useState<PropertyComplexityAssessment | null>(
    () => detail?.property_context || null,
  );
  const [propertyContextLoading, setPropertyContextLoading] = useState(false);
  const [propertyContextSaving, setPropertyContextSaving] = useState(false);
  const [propertyContextMessage, setPropertyContextMessage] = useState("");
  const [zoningEvidence, setZoningEvidence] = useState<PropertyZoningEvidence | null>(null);
  const [zoningEvidenceOpen, setZoningEvidenceOpen] = useState(false);
  const [zoningEvidenceLoading, setZoningEvidenceLoading] = useState(false);
  const [zoningEvidenceMessage, setZoningEvidenceMessage] = useState("");
  const [zoningDraft, setZoningDraft] = useState({
    sourceDocumentId: "",
    sourceType: "map_pdf" as "map_pdf" | "interactive_map" | "city_confirmation" | "official_gis" | "manual",
    zoningCode: "",
    zoningDescription: "",
    pageNumber: "",
    confirmationReference: "",
    notes: "",
    reviewer: "",
  });
  const [propertyComplexityDraft, setPropertyComplexityDraft] = useState<PropertyComplexityLevel>(
    () => detail?.property_context?.effective_complexity || "simple",
  );
  const [propertyComplexityNotes, setPropertyComplexityNotes] = useState(
    () => detail?.property_context?.appraiser_notes || "",
  );
  const photos = useMemo(
    () => (detail?.photos || []).filter((photo) => Boolean(photo?.trim())),
    [detail?.photos],
  );
  const customMarketStudy = useMemo(
    () => marketConditionsDraft?.response.analyses.find(
      (analysis) => analysis.market.key === "custom" && Boolean(analysis.market.custom_geometry),
    ) || null,
    [marketConditionsDraft],
  );
  const detailLoaded = Boolean(detail);
  const exactAddress = detail?.property_location?.address?.trim() || "";

  const hydrateZoningEvidence = useCallback((evidence: PropertyZoningEvidence) => {
    setZoningEvidence(evidence);
    const verification = evidence.verification;
    const automatic = evidence.automatic_result;
    const firstDocument = evidence.documents[0];
    setZoningDraft((current) => ({
      sourceDocumentId: verification?.source_document_id
        ? String(verification.source_document_id)
        : firstDocument ? String(firstDocument.id) : "",
      sourceType: verification?.source_type || (firstDocument
        ? "map_pdf"
        : automatic ? "official_gis" : "city_confirmation"),
      zoningCode: verification?.zoning_code || automatic?.zoning_code || current.zoningCode,
      zoningDescription:
        verification?.zoning_description || automatic?.zoning_description || current.zoningDescription,
      pageNumber: verification?.page_number ? String(verification.page_number) : "",
      confirmationReference: verification?.confirmation_reference || "",
      notes: verification?.notes || "",
      reviewer: verification?.reviewer || current.reviewer,
    }));
  }, []);

  const loadZoningEvidence = useCallback(async ({ open = false } = {}) => {
    if (!accountId) return;
    if (open) setZoningEvidenceOpen(true);
    setZoningEvidenceLoading(true);
    setZoningEvidenceMessage("");
    try {
      const response = await getPropertyZoningEvidence(
        accountId,
        activeAssignmentFile?.id || null,
      );
      hydrateZoningEvidence(response.evidence);
    } catch (error) {
      setZoningEvidenceMessage(
        error instanceof Error ? error.message : "Zoning evidence could not be loaded.",
      );
    } finally {
      setZoningEvidenceLoading(false);
    }
  }, [accountId, activeAssignmentFile?.id, hydrateZoningEvidence]);

  useEffect(() => {
    if (!detailLoaded || !accountId) return;
    void loadZoningEvidence();
  }, [accountId, detailLoaded, loadZoningEvidence]);

  useEffect(() => {
    if (photoIndex >= photos.length) setPhotoIndex(0);
  }, [photoIndex, photos.length]);

  useEffect(() => {
    let cancelled = false;
    const fallback = assignmentDraftFromDetail();
    if (unemploymentHydrationAccount.current !== (accountId || "")) {
      unemploymentHydrationAccount.current = accountId || "";
      unemploymentLookupSucceeded.current = false;
    }
    const hydrateAssignmentDraft = (value: AssignmentDetails) => {
      const next = assignmentDraftFromDetail(value);
      setAssignmentDraft((current) => {
        if (!unemploymentLookupSucceeded.current) return next;
        const zipComparison = hasValue(current.neighborhood_unemployment_pct) ? {
          neighborhood_unemployment_pct: current.neighborhood_unemployment_pct,
          neighborhood_unemployment_zip: current.neighborhood_unemployment_zip,
          neighborhood_unemployment_source: current.neighborhood_unemployment_source,
          neighborhood_unemployment_dataset_year:
            current.neighborhood_unemployment_dataset_year,
          neighborhood_unemployment_variable: current.neighborhood_unemployment_variable,
        } : {};
        const cityComparison = hasValue(current.neighborhood_city_unemployment_pct) ? {
          neighborhood_city_unemployment_pct: current.neighborhood_city_unemployment_pct,
          neighborhood_city_unemployment_name: current.neighborhood_city_unemployment_name,
          neighborhood_city_unemployment_source:
            current.neighborhood_city_unemployment_source,
          neighborhood_city_unemployment_dataset_year:
            current.neighborhood_city_unemployment_dataset_year,
          neighborhood_city_unemployment_variable:
            current.neighborhood_city_unemployment_variable,
        } : {};
        return { ...next, ...zipComparison, ...cityComparison };
      });
    };
    hydrateAssignmentDraft(fallback);
    setAssignmentDirty(false);
    setAssignmentSaveMessage("");
    setNeighborhoodProfileMessage("");
    neighborhoodProfileAttemptedSignature.current = "";
    setAssignmentFiles([]);
    setAssignmentFilesLoaded(false);
    setActiveAssignmentFile(null);
    setAssignmentFileNumber("");
    setAssignmentFilesError("");
    setCensusLookupMessage("");
    setUnemploymentLookupMessage("");
    setUnemploymentAutoAttemptedSignature("");
    setMarketConditionsDraft(readMarketConditionsDraft(accountId || ""));
    setSalesComparisonDraft(readAppraisalReportDraft(accountId || ""));
    setPropertyContext(detail?.property_context || null);
    setPropertyComplexityDraft(detail?.property_context?.effective_complexity || "simple");
    setPropertyComplexityNotes(detail?.property_context?.appraiser_notes || "");
    setPropertyContextMessage("");
    if (!accountId?.trim() || !detailLoaded) {
      setAssignmentFilesLoading(false);
      setAssignmentFilesLoaded(true);
      return () => {
        cancelled = true;
      };
    }

    setAssignmentFilesLoading(true);
    void getAssignmentFiles(accountId)
      .then((response) => {
        if (cancelled) return;
        setAssignmentFiles(response.files || []);
        if (response.latest_file) {
          hydrateAssignmentDraft(response.latest_file.assignment_details);
          setActiveAssignmentFile(response.latest_file);
          setAssignmentFileNumber(response.latest_file.file_number);
          void getPropertyContextAssessment(accountId, response.latest_file.id)
            .then((assessment) => {
              if (cancelled || !assessment) return;
              setPropertyContext(assessment);
              setPropertyComplexityDraft(assessment.effective_complexity);
              setPropertyComplexityNotes(assessment.appraiser_notes || "");
            })
            .catch(() => {
              // The core report remains usable; source and assessment notices
              // are shown when the appraiser runs the local context analysis.
            });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setAssignmentFilesError(
            error instanceof Error ? error.message : "The assignment log could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAssignmentFilesLoading(false);
          setAssignmentFilesLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [accountId, detail?.assignment_details, detail?.property_context, detailLoaded]);

  useEffect(() => {
    const refreshSalesComparisonDraft = () => {
      setSalesComparisonDraft(readAppraisalReportDraft(accountId || ""));
    };
    window.addEventListener("focus", refreshSalesComparisonDraft);
    window.addEventListener("storage", refreshSalesComparisonDraft);
    return () => {
      window.removeEventListener("focus", refreshSalesComparisonDraft);
      window.removeEventListener("storage", refreshSalesComparisonDraft);
    };
  }, [accountId]);

  useEffect(() => {
    let cancelled = false;
    setRelatedParcels(null);
    setRelatedParcelsError("");
    if (!accountId?.trim() || !detailLoaded) {
      setRelatedParcelsLoading(false);
      return () => {
        cancelled = true;
      };
    }

    const startRelatedParcelLookup = () => {
      if (cancelled) return;
      setRelatedParcelsLoading(true);
      void getRelatedParcels(accountId, exactAddress || undefined)
        .then((response) => {
          if (!cancelled) setRelatedParcels(response);
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setRelatedParcelsError(
              error instanceof Error ? error.message : "The related-parcel check was unavailable.",
            );
          }
        })
        .finally(() => {
          if (!cancelled) setRelatedParcelsLoading(false);
        });
    };
    // Related-parcel review is useful but is not required to display the
    // subject. Let the browser paint the primary report before starting it.
    const relatedParcelTimer = window.setTimeout(startRelatedParcelLookup, 900);

    return () => {
      cancelled = true;
      window.clearTimeout(relatedParcelTimer);
    };
  }, [accountId, detailLoaded, exactAddress, relatedParcelSearchVersion]);

  const address = displayValue(detail?.property_location?.address, "Property address unavailable");
  const streetAddress = address.split(",")[0].trim() || address;
  const city = displayValue(detail?.property_location?.city);
  const state = displayValue(detail?.property_location?.state, "TX");
  const postalCode = displayValue(detail?.property_location?.postal_code);
  const censusZip = String(detail?.property_location?.postal_code || "")
    .replace(/\D/g, "")
    .slice(0, 5);
  const neighborhood = displayValue(detail?.property_location?.neighborhood);
  const subdivision = displayValue(detail?.property_location?.subdivision);
  const county = displayValue(detail?.property_location?.county);
  const ownerParties = (detail?.owner?.parties || []).filter((party) =>
    hasValue(party.owner_name),
  );
  const ownerName = displayValue(
    ownerParties.length
      ? ownerParties.map((party) => party.owner_name).join(" / ")
      : detail?.owner?.owner_name,
  );
  const ownerMailing = displayValue(detail?.owner?.mailing_address);
  const legalLines = detail?.legal_description?.lines?.filter((line) => Boolean(line?.trim())) || [];
  const legalDescription = legalLines.length
    ? legalLines.join("\n")
    : "No legal description is available for this parcel.";
  const deedTransferDate = detail?.legal_description?.deed_transfer_date;
  const assignmentPropertyCharacteristics = activeAssignmentFile
    ?.custom_appraisal_sections?.["report.property_characteristics"]?.value;
  const assignmentMainImprovement = assignmentPropertyCharacteristics?.main_improvement;
  const assignmentHousingProfile = assignmentPropertyCharacteristics?.housing_profile;
  const assignmentInspectionDetails = assignmentPropertyCharacteristics?.inspection_details;
  const improvement: DcadMainImprovement | undefined = detail?.main_improvement || assignmentMainImprovement
    ? {
        ...(detail?.main_improvement || {}),
        ...(assignmentMainImprovement && typeof assignmentMainImprovement === "object" && !Array.isArray(assignmentMainImprovement)
          ? assignmentMainImprovement
          : {}),
      }
    : undefined;
  const housing: DcadHousingProfile | undefined = detail?.housing_profile || assignmentHousingProfile
    ? {
        ...(detail?.housing_profile || {}),
        ...(assignmentHousingProfile && typeof assignmentHousingProfile === "object" && !Array.isArray(assignmentHousingProfile)
          ? assignmentHousingProfile
          : {}),
      }
    : undefined;
  const inspectionDetails = assignmentInspectionDetails && typeof assignmentInspectionDetails === "object" && !Array.isArray(assignmentInspectionDetails)
    ? assignmentInspectionDetails as Record<string, unknown>
    : {};
  const landRows = detail?.land_detail || [];
  const assignmentAdditionalImprovements = assignmentPropertyCharacteristics?.additional_improvements;
  const additionalImprovements = Array.isArray(assignmentAdditionalImprovements)
    ? assignmentAdditionalImprovements as DcadImprovementRow[]
    : detail?.additional_improvements || [];
  const mobileInspectionPhotos = activeAssignmentFile?.mobile_inspection_photos || [];
  const salesHistory = detail?.sales_history || [];
  const propertyActivityHistory = detail?.property_activity_history || salesHistory;
  const values = detail?.value_summary;
  const subjectGla = parseNumber(
    improvement?.living_area_sqft ??
    improvement?.total_living_area ??
    improvement?.total_area_sqft,
  );
  const reportedSubjectAge = parseNumber(improvement?.actual_age);
  const subjectYearBuilt = parseNumber(
    improvement?.effective_year_built ?? improvement?.year_built,
  );
  const subjectAge = reportedSubjectAge ?? (
    subjectYearBuilt !== null
      ? Math.max(0, new Date().getFullYear() - subjectYearBuilt)
      : null
  );
  const salesComparisonValue = parseNumber(
    salesComparisonDraft?.opinionAfterCostToCure ?? salesComparisonDraft?.opinionOfValue,
  );
  const salesComparisonValueSource = salesComparisonDraft?.opinionAfterCostToCure !== null &&
    salesComparisonDraft?.opinionAfterCostToCure !== undefined
    ? "Sales Comparison Approach after cost to cure"
    : salesComparisonDraft?.opinionOfValue !== null && salesComparisonDraft?.opinionOfValue !== undefined
      ? "Sales Comparison Approach"
      : "";

  const editableSectionValue = (sectionKey: ReportManualSectionKey): Record<string, unknown> => {
    switch (sectionKey) {
      case "report.subject_identification":
        return {
          property_location: {
            address: detail?.property_location?.address || "",
            neighborhood: detail?.property_location?.neighborhood || "",
            city: detail?.property_location?.city || "",
            state: detail?.property_location?.state || "TX",
            postal_code: detail?.property_location?.postal_code || "",
            county: detail?.property_location?.county || "",
            subdivision: detail?.property_location?.subdivision || "",
            census_tract: detail?.property_location?.census_tract || "",
          },
          owner: {
            owner_name: detail?.owner?.owner_name || "",
            mailing_address: detail?.owner?.mailing_address || "",
            parties: cloneEditorValue(detail?.owner?.parties || []),
          },
          legal_description: {
            lines: detail?.legal_description?.lines || [],
            deed_transfer_date: detail?.legal_description?.deed_transfer_date || "",
          },
        };
      case "report.exemptions":
        {
          const emptyExemption = () => ({
            taxing_jurisdiction: "",
            homestead_exemption: "",
            disabled_vet: "",
            taxable_value: "",
          });
        return {
          homestead_yes: Boolean(detail?.homestead_yes),
          exemptions: {
            city: cloneEditorValue(detail?.exemptions?.city || emptyExemption()),
            school: cloneEditorValue(detail?.exemptions?.school || emptyExemption()),
            county: cloneEditorValue(detail?.exemptions?.county || emptyExemption()),
            college: cloneEditorValue(detail?.exemptions?.college || emptyExemption()),
            hospital: cloneEditorValue(detail?.exemptions?.hospital || emptyExemption()),
            special_district: cloneEditorValue(
              detail?.exemptions?.special_district || emptyExemption(),
            ),
          },
        };
        }
      case "report.sales_history":
        return {
          property_activity_history: cloneEditorValue(
            detail?.property_activity_history || detail?.sales_history || [],
          ),
        };
      case "report.property_characteristics":
        return {
          main_improvement: {
            living_area_sqft: improvement?.living_area_sqft || "",
            total_area_sqft: improvement?.total_area_sqft || "",
            bedroom_count: improvement?.bedroom_count || "",
            bath_count: improvement?.bath_count || "",
            baths_full: improvement?.baths_full || "",
            baths_half: improvement?.baths_half || "",
            stories: improvement?.stories || "",
            year_built: improvement?.year_built || "",
            effective_year_built: improvement?.effective_year_built || "",
            actual_age: improvement?.actual_age || "",
            building_class: improvement?.building_class || "",
            desirability: improvement?.desirability || "",
            construction_type: improvement?.construction_type || "",
            foundation: improvement?.foundation || "",
            exterior_material: improvement?.exterior_material || "",
            roof_type: improvement?.roof_type || "",
            roof_material: improvement?.roof_material || "",
            heating: improvement?.heating || "",
            air_conditioning: improvement?.air_conditioning || "",
            fireplaces: improvement?.fireplaces || "",
            kitchens: improvement?.kitchens || "",
            wetbars: improvement?.wetbars || "",
            pool: improvement?.pool ?? "",
            sprinkler: improvement?.sprinkler ?? "",
            fence_type: improvement?.fence_type || "",
          },
          housing_profile: {
            structural_style: housing?.structural_style || "",
            housing_type: housing?.housing_type || "",
            attachment_type: housing?.attachment_type || "unknown",
            architectural_style: housing?.architectural_style || "",
          },
          inspection_details: cloneEditorValue(inspectionDetails),
          additional_improvements: cloneEditorValue(additionalImprovements),
        };
      case "report.land_details":
        return { land_detail: cloneEditorValue(detail?.land_detail || []) };
      case "report.appraisal_values":
        return {
          value_summary: {
            certified_year: detail?.value_summary?.certified_year || "",
            market_value: detail?.value_summary?.market_value || "",
            capped_value: detail?.value_summary?.capped_value || "",
            improvement_value: detail?.value_summary?.improvement_value || "",
            land_value: detail?.value_summary?.land_value || "",
          },
        };
      case "report.assignment_details":
        return {
          pud: Boolean(detail?.assignment_details?.pud),
          hoa_dues_amount: detail?.assignment_details?.hoa_dues_amount || "",
          hoa_frequency: detail?.assignment_details?.hoa_frequency || "",
          hoa_explanation: detail?.assignment_details?.hoa_explanation || "",
          occupancy: detail?.assignment_details?.occupancy || "",
          occupancy_explanation: detail?.assignment_details?.occupancy_explanation || "",
          assignment_types: cloneEditorValue(detail?.assignment_details?.assignment_types || []),
          assignment_explanation: detail?.assignment_details?.assignment_explanation || "",
          lender_client_name: detail?.assignment_details?.lender_client_name || "",
          lender_client_address: detail?.assignment_details?.lender_client_address || "",
          subject_under_contract: Boolean(detail?.assignment_details?.subject_under_contract),
          contract_arms_length: typeof detail?.assignment_details?.contract_arms_length === "boolean"
            ? detail.assignment_details.contract_arms_length
            : true,
          contract_seller_names: detail?.assignment_details?.contract_seller_names || "",
          contract_price: detail?.assignment_details?.contract_price || "",
          contract_date: detail?.assignment_details?.contract_date || "",
          loan_amount: detail?.assignment_details?.loan_amount || "",
          down_payment: detail?.assignment_details?.down_payment || "",
          earnest_money: detail?.assignment_details?.earnest_money || "",
          seller_concessions: detail?.assignment_details?.seller_concessions || "",
          seller_matches_public_records:
            typeof detail?.assignment_details?.seller_matches_public_records === "boolean"
              ? detail.assignment_details.seller_matches_public_records
              : null,
          seller_mismatch_explanation:
            detail?.assignment_details?.seller_mismatch_explanation || "",
        };
    }
  };

  const editorKeyForSave = (): string => {
    let editorKey = sessionStorage.getItem("homenode-editor-key") || "";
    if (!editorKey) {
      editorKey = window.prompt("Enter the HomeNode editor key to save verified changes:") || "";
      if (!editorKey) return "";
      sessionStorage.setItem("homenode-editor-key", editorKey);
    }
    return editorKey;
  };

  const saveZoningEvidence = async () => {
    if (!accountId || !zoningEvidence?.jurisdiction) return;
    if (!zoningDraft.zoningCode.trim()) {
      setZoningEvidenceMessage("Enter the confirmed zoning code before saving.");
      return;
    }
    if (!zoningDraft.zoningDescription.trim()) {
      setZoningEvidenceMessage("Enter or prefill the exact official zoning description before saving.");
      return;
    }
    if (!zoningDraft.reviewer.trim()) {
      setZoningEvidenceMessage("Enter the appraiser or reviewer name before saving.");
      return;
    }
    const editorKey = editorKeyForSave();
    if (!editorKey) return;
    setZoningEvidenceLoading(true);
    setZoningEvidenceMessage("");
    try {
      const response = await savePropertyZoningVerification(
        accountId,
        {
          assignment_file_id: activeAssignmentFile?.id || null,
          jurisdiction_city: zoningEvidence.jurisdiction.city,
          source_document_id: zoningDraft.sourceDocumentId
            ? Number(zoningDraft.sourceDocumentId)
            : null,
          source_type: zoningDraft.sourceType,
          zoning_code: zoningDraft.zoningCode.trim(),
          zoning_description: zoningDraft.zoningDescription.trim(),
          page_number: zoningDraft.pageNumber ? Number(zoningDraft.pageNumber) : null,
          confirmation_reference: zoningDraft.confirmationReference.trim(),
          notes: zoningDraft.notes.trim(),
          reviewer: zoningDraft.reviewer.trim(),
        },
        editorKey,
      );
      hydrateZoningEvidence({
        ...zoningEvidence,
        review_required: false,
        verification: response.verification,
      });
      setZoningEvidenceMessage("Confirmed zoning and source provenance saved to this property file.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "The zoning verification could not be saved.";
      if (/401|invalid_editor_key/i.test(message)) {
        sessionStorage.removeItem("homenode-editor-key");
      }
      setZoningEvidenceMessage(message);
    } finally {
      setZoningEvidenceLoading(false);
    }
  };

  const prefillVerbatimZoningDescription = async () => {
    const sourceDocument = zoningEvidence?.documents.find(
      (document) => String(document.id) === zoningDraft.sourceDocumentId,
    ) || zoningEvidence?.documents[0] || null;
    if (!sourceDocument || !zoningDraft.zoningCode.trim()) {
      setZoningEvidenceMessage("Select an official PDF and enter the zoning code first.");
      return;
    }
    setZoningEvidenceLoading(true);
    setZoningEvidenceMessage("");
    try {
      const result = await getZoningDocumentDescriptionSuggestion(
        sourceDocument.id,
        zoningDraft.zoningCode.trim(),
      );
      if (!result.suggestion?.raw_value) {
        setZoningEvidenceMessage(
          "That code was not found beside a reliable description in the PDF text layer. Review the visible document and city contact before confirming.",
        );
        return;
      }
      setZoningDraft((current) => ({
        ...current,
        zoningDescription: result.suggestion?.raw_value || current.zoningDescription,
        pageNumber: result.suggestion?.page_number
          ? String(result.suggestion.page_number)
          : current.pageNumber,
      }));
      setZoningEvidenceMessage(
        `Prefilled the exact wording found on PDF page ${result.suggestion.page_number || "unknown"}. Appraiser confirmation is still required.`,
      );
    } catch (error) {
      setZoningEvidenceMessage(
        error instanceof Error ? error.message : "The zoning description could not be suggested.",
      );
    } finally {
      setZoningEvidenceLoading(false);
    }
  };

  const saveManualSection = async (
    sectionKey: ReportManualSectionKey,
    value: Record<string, unknown>,
  ): Promise<boolean> => {
    if (!accountId) return false;
    const editorKey = editorKeyForSave();
    if (!editorKey) return false;
    setSavingSection(true);
    try {
      await updatePropertyReportSections(
        accountId,
        { [sectionKey]: value },
        editorKey,
      );
      await onReload();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The report changes could not be saved.";
      if (/401|invalid_editor_key/i.test(message)) {
        sessionStorage.removeItem("homenode-editor-key");
      }
      window.alert(message);
      return false;
    } finally {
      setSavingSection(false);
    }
  };

  const lookUpCensusTractNow = async () => {
    if (!accountId || censusLookupLoading) return;
    const editorKey = editorKeyForSave();
    if (!editorKey) return;
    setCensusLookupLoading(true);
    setCensusLookupMessage("");
    try {
      const response = await lookupAccountCensusGeography(accountId, editorKey);
      const tract = response.census_geography?.tract_code;
      setCensusLookupMessage(
        response.census_geography?.status === "matched"
          ? `Census tract ${formatCensusTract(tract)} added.`
          : "The Census response needs review before it can be treated as a verified tract.",
      );
      await onReload();
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "The Census tract could not be looked up.";
      if (/401|invalid_editor_key/i.test(message)) {
        sessionStorage.removeItem("homenode-editor-key");
      }
      setCensusLookupMessage(
        message === "census_lookup_input_missing"
          ? "This property needs a usable address or coordinate before Census lookup."
          : message,
      );
    } finally {
      setCensusLookupLoading(false);
    }
  };

  const saveEditedSection = async (value: Record<string, unknown>) => {
    if (!editingSection) return;
    if (await saveManualSection(editingSection.key, value)) {
      setEditingSection(null);
    }
  };

  const updateAssignment = <K extends keyof AssignmentDetails,>(
    key: K,
    value: AssignmentDetails[K],
  ) => {
    setAssignmentDraft((current) => ({ ...current, [key]: value }));
    setAssignmentDirty(true);
    setAssignmentSaveMessage("");
  };

  const updateMarketConditions = (draft: MarketConditionsDraft | null) => {
    setMarketConditionsDraft(draft);
    if (!draft) return;
    const medianDom = reconciledMedianDaysOnMarket(draft.response);
    const marketChange = draft.response.recommendation.recommended_change_percent;
    const marketTrend = marketTrendFromRecommendation(draft.response.recommendation.conclusion);
    const marketingTime = marketingTimeFromMedianDom(medianDom);
    setAssignmentDraft((current) => {
      const growth = growthFromMarket(
        marketChange,
        medianDom,
        (current.neighborhood_location_type || "") as NeighborhoodLocationType,
      );
      return {
        ...current,
        ...(marketTrend ? { neighborhood_market_trend: marketTrend } : {}),
        ...(marketingTime ? { neighborhood_marketing_time: marketingTime } : {}),
        ...(growth ? { neighborhood_growth: growth } : {}),
        neighborhood_market_change_pct: marketChange ?? "",
        neighborhood_median_dom: medianDom ?? "",
      };
    });
    setAssignmentDirty(true);
    setAssignmentSaveMessage("");
  };

  const updateSubjectConformity = (value: boolean | null) => {
    setAssignmentDraft((current) => ({
      ...current,
      subject_conforms_to_neighborhood: value,
      ...(value === false
        ? {}
        : {
            subject_nonconformity_type: "",
            subject_nonconformity_explanation: "",
          }),
    }));
    setAssignmentDirty(true);
    setAssignmentSaveMessage("");
  };

  const updateAssignmentTypes = (nextTypes: string[]) => {
    setAssignmentDraft((current) => ({
      ...current,
      assignment_types: nextTypes,
      subject_under_contract: nextTypes.includes("purchase_transaction")
        ? current.subject_under_contract
        : false,
    }));
    setAssignmentDirty(true);
    setAssignmentSaveMessage("");
  };

  const applyConfirmedDocumentCandidate = (
    fieldKey: string,
    value: string,
    documentType: AssignmentDocumentType,
  ) => {
    const assignmentFieldByCandidate: Record<string, keyof AssignmentDetails> = {
      lender_client_name: "lender_client_name",
      lender_client_address: "lender_client_address",
      contract_price: "contract_price",
      contract_date: "contract_date",
      loan_amount: "loan_amount",
      down_payment: "down_payment",
      earnest_money: "earnest_money",
      seller_concessions: "seller_concessions",
      seller_name: "contract_seller_names",
    };
    const assignmentField = assignmentFieldByCandidate[fieldKey];
    if (!assignmentField) {
      setAssignmentSaveMessage("The confirmed document field remains attached as page-cited evidence.");
      return;
    }
    setAssignmentDraft((current) => {
      const next: AssignmentDetails = { ...current, [assignmentField]: value };
      if (documentType === "purchase_contract") {
        const types = new Set(current.assignment_types || []);
        types.add("purchase_transaction");
        next.assignment_types = Array.from(types);
        next.subject_under_contract = true;
      }
      return next;
    });
    setAssignmentDirty(true);
    setAssignmentSaveMessage(
      "Confirmed document evidence prefills this assignment. Save Assignment Details to retain it.",
    );
  };

  const importCustomMarketArea = useCallback(() => {
    const geometry = customMarketStudy?.market.custom_geometry;
    if (!geometry) {
      setAssignmentSaveMessage("Run and save an Appraiser-Defined Area in the Market Conditions Analysis below first.");
      return;
    }
    const summary = customMarketStudy.summary;
    setNeighborhoodBoundarySuggestions(null);
    setAssignmentDraft((current) => ({
      ...current,
      neighborhood_boundary_geometry: cloneEditorValue(geometry),
      neighborhood_boundary_label:
        customMarketStudy.market.label || "Appraiser-defined market area",
      neighborhood_boundary_source: "sales_comparison_market_conditions",
      neighborhood_boundary_saved_at: marketConditionsDraft?.savedAt || new Date().toISOString(),
      neighborhood_boundary_streets: "",
      neighborhood_boundary_north: "",
      neighborhood_boundary_east: "",
      neighborhood_boundary_south: "",
      neighborhood_boundary_west: "",
      neighborhood_boundary_exclusions: DEFAULT_NEIGHBORHOOD_BOUNDARY_NARRATIVE,
      neighborhood_boundary_streets_source: "",
      neighborhood_boundary_streets_retrieved_at: "",
      neighborhood_boundary_confirmed: false,
      neighborhood_boundary_confirmed_at: "",
      neighborhood_house_price_low: summary.minimum_sale_price ?? "",
      neighborhood_house_price_high: summary.maximum_sale_price ?? "",
      neighborhood_house_price_predominant: summary.median_sale_price ?? "",
      neighborhood_ppsf_low: summary.minimum_price_per_square_foot ?? "",
      neighborhood_ppsf_high: summary.maximum_price_per_square_foot ?? "",
      neighborhood_ppsf_predominant: summary.median_price_per_square_foot ?? "",
      neighborhood_age_low: summary.minimum_age ?? "",
      neighborhood_age_high: summary.maximum_age ?? "",
      neighborhood_age_predominant: summary.median_age ?? "",
      neighborhood_gla_low: summary.minimum_living_area ?? "",
      neighborhood_gla_high: summary.maximum_living_area ?? "",
      neighborhood_gla_predominant: summary.median_living_area ?? "",
      neighborhood_market_trend:
        marketTrendFromChange(customMarketStudy.statistics.annualized_change_percent) ||
        current.neighborhood_market_trend || "",
    }));
    setAssignmentDirty(true);
    setAssignmentSaveMessage("Appraiser-defined area imported. Review and confirm it for this file.");
  }, [customMarketStudy, marketConditionsDraft?.savedAt]);

  const refreshNeighborhoodProfile = useCallback(async () => {
    const geometry = assignmentDraft.neighborhood_boundary_geometry ||
      customMarketStudy?.market.custom_geometry;
    if (!accountId || !geometry || !marketConditionsDraft || neighborhoodProfileLoading) {
      if (!geometry) {
        setNeighborhoodProfileMessage("Run and save an Appraiser-Defined Area in the Market Conditions Analysis below first.");
      }
      return;
    }
    setNeighborhoodProfileLoading(true);
    setNeighborhoodProfileMessage("Refreshing market-area ranges, city averages, and boundary streets...");
    try {
      const profile = await getNeighborhoodProfile({
        subjectAccountId: accountId,
        asOf: marketConditionsDraft.asOfDate,
        periodMonths: marketConditionsDraft.periodMonths,
        customGeometry: geometry,
        contextOverride: marketConditionsDraft.contextOverride || null,
      });
      const customStudy = profile.analyses.find((analysis) => analysis.market.key === "custom");
      const cityStudy = profile.analyses.find((analysis) => analysis.market.key === "city");
      if (!customStudy) throw new Error("The appraiser-defined area did not return a usable market study.");
      const summary = customStudy.summary;
      const boundaryStreets = profile.boundary_streets;
      setNeighborhoodBoundarySuggestions(boundaryStreets?.cardinal_boundaries || null);
      setAssignmentDraft((current) => {
        const geometryChanged = JSON.stringify(current.neighborhood_boundary_geometry) !== JSON.stringify(geometry);
        const suggested = boundaryStreets?.cardinal_boundaries;
        const north = geometryChanged
          ? suggested?.north?.primary_street || ""
          : current.neighborhood_boundary_north || suggested?.north?.primary_street || "";
        const east = geometryChanged
          ? suggested?.east?.primary_street || ""
          : current.neighborhood_boundary_east || suggested?.east?.primary_street || "";
        const south = geometryChanged
          ? suggested?.south?.primary_street || ""
          : current.neighborhood_boundary_south || suggested?.south?.primary_street || "";
        const west = geometryChanged
          ? suggested?.west?.primary_street || ""
          : current.neighborhood_boundary_west || suggested?.west?.primary_street || "";
        const boundarySummary = [
          ["North", north],
          ["East", east],
          ["South", south],
          ["West", west],
        ].filter(([, street]) => street)
          .map(([side, street]) => `${side}: ${street}`)
          .join("; ");
        return {
          ...current,
          neighborhood_boundary_geometry: cloneEditorValue(geometry),
          neighborhood_boundary_label:
            customStudy.market.label || "Appraiser-defined market area",
          neighborhood_boundary_source: "sales_comparison_market_conditions",
          neighborhood_boundary_saved_at: marketConditionsDraft.savedAt || new Date().toISOString(),
          neighborhood_boundary_confirmed: geometryChanged
            ? false
            : current.neighborhood_boundary_confirmed,
          neighborhood_boundary_confirmed_at: geometryChanged
            ? ""
            : current.neighborhood_boundary_confirmed_at,
          neighborhood_house_price_low: summary.minimum_sale_price ?? "",
          neighborhood_house_price_high: summary.maximum_sale_price ?? "",
          neighborhood_house_price_predominant: summary.median_sale_price ?? "",
          neighborhood_ppsf_low: summary.minimum_price_per_square_foot ?? "",
          neighborhood_ppsf_high: summary.maximum_price_per_square_foot ?? "",
          neighborhood_ppsf_predominant: summary.median_price_per_square_foot ?? "",
          neighborhood_age_low: summary.minimum_age ?? "",
          neighborhood_age_high: summary.maximum_age ?? "",
          neighborhood_age_predominant: summary.median_age ?? "",
          neighborhood_gla_low: summary.minimum_living_area ?? "",
          neighborhood_gla_high: summary.maximum_living_area ?? "",
          neighborhood_gla_predominant: summary.median_living_area ?? "",
          neighborhood_sale_count: customStudy.population.eligible_sale_count ?? "",
          neighborhood_market_trend:
            marketTrendFromChange(customStudy.statistics.annualized_change_percent) ||
            current.neighborhood_market_trend || "",
          neighborhood_city_name:
            cityStudy?.market.city || profile.subject.city ||
            detail?.property_location?.city || current.neighborhood_city_name || "",
          neighborhood_city_sale_count: cityStudy?.population.eligible_sale_count ?? "",
          neighborhood_city_average_sale_price: cityStudy?.summary.average_sale_price ?? "",
          neighborhood_city_average_ppsf:
            cityStudy?.summary.average_price_per_square_foot ?? "",
          neighborhood_city_average_age: cityStudy?.summary.average_age ?? "",
          neighborhood_city_average_gla: cityStudy?.summary.average_living_area ?? "",
          neighborhood_city_comparison_as_of:
            cityStudy?.period.end || marketConditionsDraft.asOfDate || "",
          neighborhood_boundary_streets:
            boundarySummary || current.neighborhood_boundary_streets || "",
          neighborhood_boundary_north: north,
          neighborhood_boundary_east: east,
          neighborhood_boundary_south: south,
          neighborhood_boundary_west: west,
          neighborhood_boundary_exclusions:
            current.neighborhood_boundary_exclusions ||
            DEFAULT_NEIGHBORHOOD_BOUNDARY_NARRATIVE,
          neighborhood_boundary_streets_source:
            boundaryStreets?.source || current.neighborhood_boundary_streets_source || "",
          neighborhood_boundary_streets_retrieved_at:
            boundaryStreets?.retrieved_at ||
            current.neighborhood_boundary_streets_retrieved_at || "",
        };
      });
      setAssignmentDirty(true);
      setNeighborhoodProfileMessage(
        profile.boundary_street_warning
          ? "Market ranges and city averages refreshed. Boundary streets could not be refreshed and still require review."
          : "Appraiser-defined ranges, city averages, and four-side boundary suggestions refreshed.",
      );
    } catch (error) {
      setNeighborhoodProfileMessage(
        error instanceof Error ? error.message : "The neighborhood profile could not be refreshed.",
      );
    } finally {
      setNeighborhoodProfileLoading(false);
    }
  }, [
    accountId,
    assignmentDraft.neighborhood_boundary_geometry,
    customMarketStudy,
    detail?.property_location?.city,
    marketConditionsDraft,
    neighborhoodProfileLoading,
  ]);

  const confirmNeighborhoodBoundary = (checked: boolean) => {
    setAssignmentDraft((current) => ({
      ...current,
      neighborhood_boundary_confirmed: checked,
      neighborhood_boundary_confirmed_at: checked ? new Date().toISOString() : "",
    }));
    setAssignmentDirty(true);
    setAssignmentSaveMessage("");
    const assessmentId = Number(assignmentDraft.neighborhood_boundary_engine_assessment_id);
    const boundaryAssignmentFileId = Number(
      assignmentDraft.neighborhood_boundary_engine_assignment_file_id,
    );
    if (accountId && Number.isSafeInteger(assessmentId) && assessmentId > 0) {
      void saveNeighborhoodBoundaryReview(accountId, assessmentId, {
        assignmentFileId: Number.isSafeInteger(boundaryAssignmentFileId) &&
          boundaryAssignmentFileId > 0
          ? boundaryAssignmentFileId
          : null,
        confirmed: checked,
      }).catch((error) => {
        setAssignmentSaveMessage(
          error instanceof Error
            ? `Boundary confirmation needs to be retried: ${error.message}`
            : "Boundary confirmation needs to be retried.",
        );
      });
    }
  };

  const lookupUnemploymentComparison = useCallback(async () => {
    if ((!censusZip && !city) || unemploymentLookupLoading) return;
    const lookupSignature = `${censusZip}:${city}:${state}`;
    setUnemploymentAutoAttemptedSignature(lookupSignature);
    setUnemploymentLookupLoading(true);
    setUnemploymentLookupMessage("");
    const [zipResult, cityResult] = await Promise.allSettled([
      censusZip ? getCensusZipProfile(censusZip) : Promise.reject(new Error("ZIP not reported")),
      city && city !== "Not reported"
        ? getCensusCityProfile(city, state)
        : Promise.reject(new Error("City not reported")),
    ]);
    if (zipResult.status === "fulfilled" || cityResult.status === "fulfilled") {
      unemploymentLookupSucceeded.current = true;
      setAssignmentDraft((current) => ({
        ...current,
        ...(zipResult.status === "fulfilled" ? {
          neighborhood_unemployment_pct: zipResult.value.unemployment_percent,
          neighborhood_unemployment_zip: zipResult.value.postal_code,
          neighborhood_unemployment_source: zipResult.value.source,
          neighborhood_unemployment_dataset_year: zipResult.value.dataset_year,
          neighborhood_unemployment_variable: zipResult.value.variable,
        } : {}),
        ...(cityResult.status === "fulfilled" ? {
          neighborhood_city_unemployment_pct: cityResult.value.unemployment_percent,
          neighborhood_city_unemployment_name:
            cityResult.value.geography_name || `${cityResult.value.city}, ${cityResult.value.state}`,
          neighborhood_city_unemployment_source: cityResult.value.source,
          neighborhood_city_unemployment_dataset_year: cityResult.value.dataset_year,
          neighborhood_city_unemployment_variable: cityResult.value.variable,
        } : {}),
      }));
      setAssignmentDirty(true);
    }
    const failures = [zipResult, cityResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
    if (!failures.length) {
      setUnemploymentLookupMessage(`Census unemployment updated for ZIP ${censusZip} and ${city}.`);
    } else if (zipResult.status === "fulfilled" || cityResult.status === "fulfilled") {
      setUnemploymentLookupMessage(`One Census geography updated; the other lookup needs review (${failures.join(", ")}).`);
    } else {
      const message = failures.join(", ") || "Census unemployment lookup failed.";
      setUnemploymentLookupMessage(
        /census_api_key_not_configured/i.test(message)
          ? "A Census API key must be configured before automatic lookup can run; manual entry remains available."
          : message,
      );
    }
    setUnemploymentLookupLoading(false);
  }, [censusZip, city, state, unemploymentLookupLoading]);

  useEffect(() => {
    const geometry = customMarketStudy?.market.custom_geometry;
    if (!geometry || assignmentFilesLoading || !assignmentFilesLoaded) return;
    const boundarySource = String(
      assignmentDraft.neighborhood_boundary_source || "",
    ).toLowerCase();
    if (
      /^neighborhood_boundary_engine_v\d+$/i.test(boundarySource) ||
      boundarySource.includes("appraiser") ||
      boundarySource.includes("sales_comparison_market_conditions") ||
      boundarySource.includes("cleared") ||
      assignmentDraft.neighborhood_boundary_geometry
    ) return;
    if (JSON.stringify(assignmentDraft.neighborhood_boundary_geometry) === JSON.stringify(geometry)) return;
    importCustomMarketArea();
  }, [
    assignmentDraft.neighborhood_boundary_geometry,
    assignmentDraft.neighborhood_boundary_source,
    assignmentFilesLoading,
    assignmentFilesLoaded,
    customMarketStudy,
    importCustomMarketArea,
  ]);

  useEffect(() => {
    const geometry = customMarketStudy?.market.custom_geometry;
    if (!neighborhoodSectionReady || !geometry || !accountId || !marketConditionsDraft || assignmentFilesLoading || !assignmentFilesLoaded) return;
    const structuredBoundariesPresent = [
      assignmentDraft.neighborhood_boundary_north,
      assignmentDraft.neighborhood_boundary_east,
      assignmentDraft.neighborhood_boundary_south,
      assignmentDraft.neighborhood_boundary_west,
    ].every((value) => String(value || "").trim());
    const profileValuesPresent = structuredBoundariesPresent && [
      assignmentDraft.neighborhood_ppsf_predominant,
      assignmentDraft.neighborhood_age_predominant,
      assignmentDraft.neighborhood_gla_predominant,
      assignmentDraft.neighborhood_city_average_sale_price,
    ].every(hasValue);
    if (profileValuesPresent) return;
    const signature = `${accountId}:${marketConditionsDraft.savedAt}:${JSON.stringify(geometry)}`;
    if (neighborhoodProfileAttemptedSignature.current === signature) return;
    neighborhoodProfileAttemptedSignature.current = signature;
    void refreshNeighborhoodProfile();
  }, [
    accountId,
    assignmentDraft.neighborhood_age_predominant,
    assignmentDraft.neighborhood_boundary_east,
    assignmentDraft.neighborhood_boundary_north,
    assignmentDraft.neighborhood_boundary_south,
    assignmentDraft.neighborhood_boundary_west,
    assignmentDraft.neighborhood_city_average_sale_price,
    assignmentDraft.neighborhood_gla_predominant,
    assignmentDraft.neighborhood_ppsf_predominant,
    assignmentFilesLoading,
    assignmentFilesLoaded,
    customMarketStudy,
    marketConditionsDraft,
    neighborhoodSectionReady,
    refreshNeighborhoodProfile,
  ]);

  useEffect(() => {
    if (
      !neighborhoodSectionReady ||
      assignmentFilesLoading ||
      !assignmentFilesLoaded ||
      (!/^\d{5}$/.test(censusZip) && (!city || city === "Not reported")) ||
      unemploymentAutoAttemptedSignature === `${censusZip}:${city}:${state}` ||
      (
        hasValue(assignmentDraft.neighborhood_unemployment_pct) &&
        hasValue(assignmentDraft.neighborhood_city_unemployment_pct)
      )
    ) return;
    void lookupUnemploymentComparison();
  }, [
    assignmentDraft.neighborhood_city_unemployment_pct,
    assignmentDraft.neighborhood_unemployment_pct,
    assignmentFilesLoaded,
    assignmentFilesLoading,
    censusZip,
    city,
    lookupUnemploymentComparison,
    neighborhoodSectionReady,
    state,
    unemploymentAutoAttemptedSignature,
  ]);

  const saveAssignmentDetails = async () => {
    const validationErrors = assignmentValidationErrors(assignmentDraft);
    if (validationErrors.length) {
      setAssignmentSaveMessage(`Resolve before saving: ${validationErrors.join(" ")}`);
      return;
    }
    if (!accountId || !activeAssignmentFile) {
      setAssignmentSaveMessage("Enter a file number and choose Save New File first.");
      return;
    }
    const editorKey = editorKeyForSave();
    if (!editorKey) return;
    setSavingAssignmentFile(true);
    try {
      const response = await updateAssignmentFile(
        accountId,
        activeAssignmentFile.id,
        {
          assignment_details: cloneEditorValue(assignmentDraft),
          expected_revision: activeAssignmentFile.revision,
        },
        editorKey,
      );
      const updatedFile = {
        ...response.assignment_file,
        custom_appraisal_sections: activeAssignmentFile.custom_appraisal_sections,
        mobile_inspection_photos: activeAssignmentFile.mobile_inspection_photos,
      };
      setActiveAssignmentFile(updatedFile);
      setAssignmentFiles((current) => current.map((file) =>
        file.id === updatedFile.id ? updatedFile : file
      ));
      setAssignmentDirty(false);
      setAssignmentSaveMessage(`Saved to file ${response.assignment_file.file_number}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The assignment file could not be saved.";
      if (/401|invalid_editor_key/i.test(message)) {
        sessionStorage.removeItem("homenode-editor-key");
      }
      setAssignmentSaveMessage(
        message === "assignment_file_revision_conflict"
          ? "This file changed elsewhere. Reload the report before saving again."
          : message,
      );
    } finally {
      setSavingAssignmentFile(false);
    }
  };

  const saveNewAssignmentFile = async () => {
    if (!accountId) return;
    const validationErrors = assignmentValidationErrors(assignmentDraft);
    if (validationErrors.length) {
      setAssignmentSaveMessage(`Resolve before saving: ${validationErrors.join(" ")}`);
      return;
    }
    const fileNumber = assignmentFileNumber.trim();
    if (!fileNumber) {
      setAssignmentSaveMessage("Enter a file number before saving a new appraisal file.");
      return;
    }
    const editorKey = editorKeyForSave();
    if (!editorKey) return;
    setSavingAssignmentFile(true);
    setAssignmentSaveMessage("");
    try {
      const response = await createAssignmentFile(
        accountId,
        {
          file_number: fileNumber,
          assignment_details: cloneEditorValue(assignmentDraft),
          inherited_from_file_id: null,
        },
        editorKey,
      );
      const created = response.assignment_file;
      setAssignmentFiles((current) => [created, ...current.filter((file) => file.id !== created.id)]);
      setActiveAssignmentFile(created);
      setAssignmentFileNumber(created.file_number);
      setAssignmentDirty(false);
      setAssignmentSaveMessage(`New appraisal file ${created.file_number} saved.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The appraisal file could not be created.";
      if (/401|invalid_editor_key/i.test(message)) {
        sessionStorage.removeItem("homenode-editor-key");
      }
      setAssignmentSaveMessage(
        message === "assignment_file_number_exists"
          ? "That file number already exists for this property. Enter a different file number."
          : message,
      );
    } finally {
      setSavingAssignmentFile(false);
    }
  };

  const saveAssignmentFromSection = async () => {
    const validationErrors = assignmentValidationErrors(assignmentDraft);
    if (validationErrors.length) {
      setAssignmentSaveMessage(`Resolve before saving: ${validationErrors.join(" ")}`);
      return;
    }
    if (!activeAssignmentFile) {
      if (!assignmentFileNumber.trim()) {
        setAssignmentSaveMessage(
          "Enter a File Number at the top of the report, then select Save again to create the new appraisal file.",
        );
        return;
      }
      await saveNewAssignmentFile();
      return;
    }
    await saveAssignmentDetails();
  };

  const analyzeCurrentPropertyContext = async () => {
    if (!accountId || propertyContextLoading) return;
    setPropertyContextLoading(true);
    setPropertyContextMessage("Analyzing locally stored property and neighborhood context...");
    try {
      const assessment = await runPropertyContextAnalysis(accountId, {
        assignmentFileId: activeAssignmentFile?.id || null,
        customGeometry:
          assignmentDraft.neighborhood_boundary_geometry ||
          customMarketStudy?.market.custom_geometry ||
          null,
        geography: assignmentDraft.neighborhood_location_type || null,
      });
      setPropertyContext(assessment);
      setPropertyComplexityDraft(assessment.effective_complexity);
      setPropertyComplexityNotes(assessment.appraiser_notes || "");
      const stale = assessment.source_health.filter((source) => source.serving_stale_data);
      const unavailable = assessment.source_health.filter((source) => !source.usable);
      setPropertyContextMessage(
        stale.length
          ? "Analysis completed from the most recent locally stored data; one or more source synchronizations currently need attention."
          : unavailable.length
            ? "Core characteristics were analyzed. GIS factors will populate after the first county parcel and road synchronization."
            : "Property context and complexity screening updated from local data.",
      );
    } catch (error) {
      setPropertyContextMessage(
        error instanceof Error ? error.message : "Property-context analysis could not be completed.",
      );
    } finally {
      setPropertyContextLoading(false);
    }
  };

  const saveCurrentPropertyComplexity = async () => {
    if (!accountId || !propertyContext || propertyContextSaving) return;
    setPropertyContextSaving(true);
    setPropertyContextMessage("");
    try {
      const assessment = await savePropertyContextReview(accountId, {
        assignmentFileId: activeAssignmentFile?.id || null,
        complexity: propertyComplexityDraft,
        notes: propertyComplexityNotes,
      });
      setPropertyContext(assessment);
      setPropertyContextMessage(
        assessment.review_status === "overridden"
          ? "Appraiser complexity override saved without changing the automated source evidence."
          : "Automated complexity recommendation reviewed and confirmed.",
      );
    } catch (error) {
      setPropertyContextMessage(
        error instanceof Error ? error.message : "The complexity review could not be saved.",
      );
    } finally {
      setPropertyContextSaving(false);
    }
  };

  const startNewAssignmentFile = () => {
    setAssignmentDraft(assignmentDraftFromDetail());
    setActiveAssignmentFile(null);
    setAssignmentFileNumber("");
    setAssignmentDirty(false);
    setAssignmentSaveMessage("Enter a unique file number to begin a fresh appraisal assignment.");
  };

  const recordLenderRevisionRequest = async () => {
    if (!accountId || !activeAssignmentFile) return;
    const note = window.prompt(
      "Record a lender/client-requested appraisal revision. Add an optional note, or choose Cancel.",
      "",
    );
    if (note === null) return;
    const editorKey = editorKeyForSave();
    if (!editorKey) return;
    const nextRevisionCount = Math.max(
      0,
      Number(assignmentDraft.lender_revision_count) || 0,
    ) + 1;
    const updatedDetails: AssignmentDetails = {
      ...cloneEditorValue(assignmentDraft),
      lender_revision_count: nextRevisionCount,
      lender_revision_last_requested_at: new Date().toISOString(),
      lender_revision_note: note.trim(),
    };
    setSavingAssignmentFile(true);
    try {
      const response = await updateAssignmentFile(
        accountId,
        activeAssignmentFile.id,
        {
          assignment_details: updatedDetails,
          expected_revision: activeAssignmentFile.revision,
        },
        editorKey,
      );
      const updatedFile = {
        ...response.assignment_file,
        custom_appraisal_sections: activeAssignmentFile.custom_appraisal_sections,
        mobile_inspection_photos: activeAssignmentFile.mobile_inspection_photos,
      };
      setAssignmentDraft(assignmentDraftFromDetail(updatedFile.assignment_details));
      setActiveAssignmentFile(updatedFile);
      setAssignmentFiles((current) => current.map((file) =>
        file.id === updatedFile.id ? updatedFile : file
      ));
      setAssignmentDirty(false);
      setAssignmentSaveMessage(
        `Recorded lender/client revision request ${nextRevisionCount} for file ${response.assignment_file.file_number}.`,
      );
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "The lender/client revision request could not be recorded.";
      if (/401|invalid_editor_key/i.test(message)) {
        sessionStorage.removeItem("homenode-editor-key");
      }
      setAssignmentSaveMessage(
        message === "assignment_file_revision_conflict"
          ? "This file changed elsewhere. Reload the report before recording the revision request."
          : message,
      );
    } finally {
      setSavingAssignmentFile(false);
    }
  };

  const editSection = (key: ReportManualSectionKey) => {
    const section = EDITABLE_REPORT_SECTIONS.find((item) => item.key === key);
    if (section) setEditingSection(section);
  };
  const sectionEditProps = (key: ReportManualSectionKey) => ({
    onEdit: () => editSection(key),
    manuallyVerified: Boolean(detail?.report_manual_values?.[key]),
  });

  const exemptionOrder: Array<[keyof DcadExemptionsMap, string]> = [
    ["city", "City"],
    ["school", "School"],
    ["county", "County"],
    ["college", "College"],
    ["hospital", "Hospital"],
    ["special_district", "Special District"],
  ];
  const exemptionRows = exemptionOrder
    .map(([key, fallbackLabel]) => ({
      key,
      fallbackLabel,
      row: detail?.exemptions?.[key],
    }))
    .filter(({ row }) =>
      Boolean(row && Object.values(row).some((value) => hasValue(value))),
    );
  const exemptJurisdictionCount = exemptionRows.filter(
    ({ row }) => (parseNumber(row?.homestead_exemption) || 0) > 0,
  ).length;
  const homestead = detail?.homestead_yes || exemptJurisdictionCount > 0;
  const assignmentTypes = assignmentDraft.assignment_types || [];
  const assignmentTypeLabels = assignmentTypes.map((value) =>
    ASSIGNMENT_TYPE_OPTIONS.find(([option]) => option === value)?.[1] ||
      value.replaceAll("_", " "),
  );
  const purchaseTransactionSelected = assignmentTypes.includes("purchase_transaction");
  const assignmentErrors = assignmentValidationErrors(assignmentDraft);
  const listingRows = listingTimelineRows(propertyActivityHistory);
  const salesHistoryRows = propertyActivityHistory.filter((event) => {
    const recordType = String(event.record_type || "");
    return ["closed_sale", "cad_transfer"].includes(recordType) ||
      (!recordType && (hasValue(event.sale_price) || hasValue(event.closing_date) || hasValue(event.activity_date)));
  });
  const contractSellerComparison = sellerComparisonSummary(
    assignmentDraft.contract_seller_names,
    ownerName,
  );
  const assignmentSaveDisabled = Boolean(
    assignmentFilesLoading || savingAssignmentFile || !assignmentDirty,
  );
  const priorAssignmentFiles = activeAssignmentFile
    ? assignmentFiles.filter((file) => file.id !== activeAssignmentFile.id)
    : assignmentFiles;
  const hasPriorAssignmentFiles = priorAssignmentFiles.length > 0;
  const neighborhoodBoundaryErrors = neighborhoodBoundaryReadinessErrors(assignmentDraft);
  const appraisalReportAssignmentFile = activeAssignmentFile;
  const relatedParcelsToShow = (relatedParcels?.parcels || []).filter(
    (parcel) => parcel.is_subject || parcel.materially_different,
  );
  const showRelatedParcelCheck = Boolean(
    relatedParcels?.material_difference_found,
  );

  const primaryZoning =
    zoningEvidence?.verification?.zoning_code ||
    zoningEvidence?.automatic_result?.zoning_code ||
    landRows.map((row) => row.zoning).find((value) => hasValue(value)) ||
    "Not reported";
  const selectedZoningDocument = zoningEvidence?.documents.find(
    (document) => String(document.id) === zoningDraft.sourceDocumentId,
  ) || zoningEvidence?.documents[0] || null;

  const protestUrl = accountId
    ? `/PropertyTaxProtest?propertyId=${encodeURIComponent(accountId)}${
        hasValue(detail?.owner?.owner_name)
          ? `&ownerName=${encodeURIComponent(String(detail?.owner?.owner_name))}`
          : ""
        }`
    : "/PropertyTaxProtest";

  const canSlide = photos.length > 1;
  const showPreviousPhoto = () =>
    setPhotoIndex((current) => (current - 1 + photos.length) % photos.length);
  const showNextPhoto = () =>
    setPhotoIndex((current) => (current + 1) % photos.length);

  return (
    <div
      className="card overflow-hidden rounded-2xl bg-white shadow-lg"
      style={{ backgroundColor: "#ffffff" }}
    >
      <section className="border-b border-slate-200 bg-slate-50/80 px-4 py-3 sm:px-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-end">
          {activeAssignmentFile ? (
            <span className="mb-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
              Active file {activeAssignmentFile.file_number}
            </span>
          ) : null}
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-end">
            <label className="block min-w-0 flex-1 xl:w-64 xl:flex-none">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                File Number
              </span>
              <input
                type="text"
                maxLength={100}
                className="input input-bordered input-sm mt-1 w-full bg-white font-medium"
                placeholder="Enter assignment number"
                value={assignmentFileNumber}
                readOnly={Boolean(activeAssignmentFile)}
                onChange={(event) => {
                  setAssignmentFileNumber(event.target.value);
                  if (event.target.value.trim() && !assignmentFileNumber.trim()) {
                    setAssignmentDraft((current) => ({
                      ...current,
                      neighborhood_boundary_confirmed: false,
                      neighborhood_boundary_confirmed_at: "",
                    }));
                    setAssignmentDirty(true);
                  }
                  setAssignmentSaveMessage("");
                }}
              />
            </label>
            {activeAssignmentFile ? (
              <button
                type="button"
                className="btn btn-outline btn-sm normal-case rounded-lg border-slate-300 bg-white shadow-sm"
                onClick={startNewAssignmentFile}
                disabled={savingAssignmentFile}
              >
                Start Another File
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-sm normal-case rounded-lg shadow-sm"
                onClick={() => void saveNewAssignmentFile()}
                disabled={
                  assignmentFilesLoading || savingAssignmentFile ||
                  !assignmentFileNumber.trim() || assignmentErrors.length > 0
                }
              >
                {savingAssignmentFile ? "Saving..." : "Save New File"}
              </button>
            )}
          </div>
        </div>

        <details className={`mt-3 rounded-xl border px-3 py-2 ${
          hasPriorAssignmentFiles
            ? "border-red-300 bg-red-50"
            : "border-slate-200 bg-white"
        }`}>
          <summary className={`cursor-pointer text-xs font-semibold ${
            hasPriorAssignmentFiles ? "text-red-800" : "text-slate-700"
          }`}>
            Assignment Log ({assignmentFiles.length})
            {hasPriorAssignmentFiles ? " - prior appraisal service found" : ""}
          </summary>
          <div className={`mt-2 max-h-52 space-y-2 overflow-y-auto border-t pt-2 ${
            hasPriorAssignmentFiles ? "border-red-200" : "border-slate-100"
          }`}>
            {assignmentFilesLoading ? (
              <p className="text-xs text-slate-500">Loading prior assignment files...</p>
            ) : assignmentFilesError ? (
              <p className="text-xs text-rose-700">{assignmentFilesError}</p>
            ) : assignmentFiles.length ? (
              assignmentFiles.map((file) => {
                const lenderRevisionCount = Math.max(
                  0,
                  Number(file.assignment_details.lender_revision_count) || 0,
                );
                const isActiveFile = file.id === activeAssignmentFile?.id;
                return (
                  <div
                    key={file.id}
                    className={`flex flex-col gap-2 rounded-lg border px-3 py-2 sm:flex-row sm:items-center sm:justify-between ${
                      isActiveFile
                        ? "border-emerald-200 bg-emerald-50"
                        : "border-slate-200 bg-white"
                    }`}
                  >
                    <div className="min-w-0 text-xs text-slate-600">
                      <span className="font-semibold text-slate-900">{file.file_number}</span>
                      {isActiveFile ? (
                        <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-800">
                          Current
                        </span>
                      ) : null}
                      <span className="mx-2 text-slate-300">|</span>
                      Created {formatDate(file.created_at)}
                      <span className="mx-2 text-slate-300">|</span>
                      {lenderRevisionCount} lender/client-requested {lenderRevisionCount === 1 ? "revision" : "revisions"}
                      {file.assignment_details.lender_revision_last_requested_at ? (
                        <span className="block pt-1 text-[11px] text-slate-500">
                          Last requested {formatDate(file.assignment_details.lender_revision_last_requested_at)}
                          {file.assignment_details.lender_revision_note
                            ? ` - ${file.assignment_details.lender_revision_note}`
                            : ""}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <a
                        className="btn btn-sm normal-case"
                        href={`/AppraisalReport?propertyId=${encodeURIComponent(accountId || "")}&assignmentFileId=${encodeURIComponent(String(file.id))}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View File
                      </a>
                      {isActiveFile ? (
                        <button
                          type="button"
                          className="btn btn-sm normal-case"
                          onClick={() => void recordLenderRevisionRequest()}
                          disabled={savingAssignmentFile}
                        >
                          Record Revision Request
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="text-xs text-slate-500">
                No appraisal files have been saved for this property yet.
              </p>
            )}
          </div>
        </details>
      </section>

      <figure className="relative h-64 bg-slate-100 sm:h-72">
        {photos.length ? (
          <img
            src={photos[photoIndex]}
            alt={`${address} property`}
            className="h-full w-full select-none object-cover"
            draggable={false}
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200 text-slate-500">
            <svg
              className="mb-3 h-14 w-14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M3 11.5 12 4l9 7.5" />
              <path d="M5 10.5V20h14v-9.5" />
              <path d="M9 20v-6h6v6" />
            </svg>
            <span className="text-sm font-medium">Property photo unavailable</span>
          </div>
        )}

        {canSlide ? (
          <>
            <button
              type="button"
              onClick={showPreviousPhoto}
              aria-label="Previous image"
              className="absolute left-3 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/70 bg-white/90 text-slate-800 shadow-lg hover:bg-white"
            >
              <span aria-hidden="true">‹</span>
            </button>
            <button
              type="button"
              onClick={showNextPhoto}
              aria-label="Next image"
              className="absolute right-3 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/70 bg-white/90 text-slate-800 shadow-lg hover:bg-white"
            >
              <span aria-hidden="true">›</span>
            </button>
            <div className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 gap-1.5 rounded-full bg-black/40 px-3 py-2">
              {photos.map((_, index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => setPhotoIndex(index)}
                  aria-label={`Go to image ${index + 1}`}
                  className={`h-2.5 w-2.5 rounded-full border border-white ${
                    index === photoIndex ? "bg-white" : "bg-white/40"
                  }`}
                />
              ))}
            </div>
          </>
        ) : null}
      </figure>

      <div className="card-body bg-white p-4 sm:p-6" style={{ backgroundColor: "#ffffff" }}>
        <header className="grid gap-5 border-b border-slate-200 pb-5 lg:grid-cols-3 lg:items-start">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-950">{streetAddress}</h1>
            <p className="mt-1 text-sm font-medium text-slate-700">
              {city}, {state} {postalCode} <span className="text-slate-400">&middot;</span> {county}
            </p>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-600">
              <span>
                Neighborhood Code: <strong className="text-slate-800">{neighborhood}</strong>
              </span>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3 text-center">
            <div className="flex flex-col items-center justify-center gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-700">Prepared For</h2>
            </div>
            <input
              type="text"
              maxLength={500}
              className="input input-bordered input-sm mt-2 w-full bg-white text-center placeholder:text-center"
              value={assignmentDraft.lender_client_name || ""}
              onChange={(event) => updateAssignment("lender_client_name", event.target.value)}
              placeholder="Lender / client name"
              aria-label="Prepared for lender or client"
            />
            <textarea
              maxLength={2000}
              className="textarea textarea-bordered textarea-sm mt-2 min-h-14 w-full bg-white text-center placeholder:text-center"
              value={assignmentDraft.lender_client_address || ""}
              onChange={(event) => updateAssignment("lender_client_address", event.target.value)}
              placeholder="Lender / client address"
              aria-label="Lender or client address"
            />
            <button
              type="button"
              onClick={() => void saveAssignmentFromSection()}
              className="btn btn-primary btn-xs mx-auto mt-2 normal-case rounded-lg"
              disabled={assignmentSaveDisabled}
            >
              {savingAssignmentFile ? "Saving..." : "Save Prepared For"}
            </button>
            {assignmentSaveMessage ? (
              <p className="mt-2 text-xs leading-5 text-slate-600">{assignmentSaveMessage}</p>
            ) : null}
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3 text-right">
            <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-700">Assignment Type</h2>
            {assignmentTypeLabels.length ? (
              <div className="mt-2 flex flex-wrap justify-end gap-1.5">
                {assignmentTypeLabels.map((label) => (
                  <span key={label} className="rounded-full bg-blue-100 px-2 py-1 text-xs font-semibold text-blue-900">
                    {label}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-sm text-slate-500">Not selected</p>
            )}
            {assignmentTypes.includes("other") && assignmentDraft.assignment_explanation ? (
              <p className="mt-2 text-xs leading-5 text-slate-600">{assignmentDraft.assignment_explanation}</p>
            ) : null}
            <p className="mt-2 text-[11px] leading-4 text-slate-500">
              Reflects the manual selection below and future engagement-letter imports.
            </p>
          </div>
        </header>

        {showRelatedParcelCheck ? (
        <section className="mt-5 rounded-2xl border border-amber-200 bg-amber-50/70 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-slate-800">
                  Same-Address CAD Parcel Check
                </h2>
                {relatedParcels?.review_required ? (
                  <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-semibold text-amber-900">
                    Review related parcels
                  </span>
                ) : null}
              </div>
              <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-600">
                HomeNode checks the official DCAD parcel map in the background for other accounts at
                this exact situs address. Results remain separate and are never merged automatically.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-sm normal-case border-amber-300 bg-white text-slate-800 hover:border-amber-400 hover:bg-amber-100"
              disabled={relatedParcelsLoading || !accountId}
              onClick={() => setRelatedParcelSearchVersion((current) => current + 1)}
            >
              {relatedParcelsLoading ? "Checking DCAD..." : "Check Again"}
            </button>
          </div>

          {relatedParcelsError ? (
            <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
              The live DCAD parcel check could not be completed: {relatedParcelsError}
            </div>
          ) : null}

          {relatedParcels && relatedParcels.live_query_status !== "complete" ? (
            <div className="mt-3 rounded-xl border border-amber-300 bg-amber-100 p-3 text-sm text-amber-950">
              The official DCAD live check is {relatedParcels.live_query_status.replace(/_/g, " ")}.
              Local exact-address matches are shown below, but this item remains flagged for manual
              parcel review.
            </div>
          ) : null}

          {relatedParcels && !relatedParcelsLoading ? (
            relatedParcels.parcels.length ? (
              <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
                {relatedParcelsToShow.map((parcel) => (
                  <div
                    key={parcel.account_id}
                    className={`rounded-xl border bg-white p-3 ${
                      parcel.is_subject ? "border-slate-200" : "border-amber-300"
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="font-semibold text-slate-950">
                          {parcel.site_address || parcel.address || relatedParcels.query_address}
                        </div>
                        <div className="mt-0.5 font-mono text-xs text-slate-600">
                          {parcel.account_id}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {parcel.is_subject ? (
                          <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-700">
                            Current subject
                          </span>
                        ) : (
                          <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-semibold text-amber-900">
                            Additional parcel
                          </span>
                        )}
                        {!parcel.in_database ? (
                          <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-800">
                            Not in database
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {!parcel.is_subject && (parcel.difference_fields || []).length ? (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {(parcel.difference_fields || []).map((field) => (
                          <span
                            key={field}
                            className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900"
                          >
                            Differs: {field}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-slate-600 sm:grid-cols-4">
                      <div>
                        <span className="block text-slate-500">Living Area</span>
                        <strong className="text-slate-800">
                          {parcel.living_area_sqft
                            ? `${new Intl.NumberFormat("en-US").format(parcel.living_area_sqft)} sq. ft.`
                            : "Land / not reported"}
                        </strong>
                      </div>
                      <div>
                        <span className="block text-slate-500">Land Value</span>
                        <strong className="text-slate-800">{formatMoney(parcel.land_value)}</strong>
                      </div>
                      <div>
                        <span className="block text-slate-500">Improvement Value</span>
                        <strong className="text-slate-800">
                          {formatMoney(parcel.improvement_value)}
                        </strong>
                      </div>
                      <div>
                        <span className="block text-slate-500">Total Value</span>
                        <strong className="text-slate-800">{formatMoney(parcel.total_value)}</strong>
                      </div>
                    </div>
                    {parcel.legal_description ? (
                      <p className="mt-3 border-t border-slate-100 pt-2 text-xs text-slate-600">
                        {parcel.legal_description}
                      </p>
                    ) : null}
                    {!parcel.is_subject && parcel.in_database ? (
                      <a
                        href={`/report/${encodeURIComponent(parcel.account_id)}`}
                        className="mt-3 inline-flex text-xs font-semibold text-blue-700 hover:text-blue-900 hover:underline"
                      >
                        Open this parcel&apos;s report →
                      </a>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-slate-600">
                No same-address parcel was returned by the official DCAD parcel map. Keep this item
                under manual review if the situs address is missing or incomplete.
              </p>
            )
          ) : null}
        </section>
        ) : null}

        <div className="mt-5 flex flex-col gap-5">
          <SummarySection
            title="Subject Identification"
            subtitle="Parcel, ownership, and recorded legal information"
            {...sectionEditProps("report.subject_identification")}
            className="order-1"
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <SummaryField label="Parcel / Account Number" value={displayValue(accountId)} />
              <SummaryField label="County" value={county} />
              <SummaryField label="Subdivision" value={subdivision} />
              <div className="hidden lg:block" aria-hidden="true" />
              <SummaryField label="Zoning" value={primaryZoning} />
              <SummaryField label="Latest Deed Transfer" value={formatDate(deedTransferDate)} />
              <SummaryField
                label={ownerParties.length > 1 ? "Owner Names" : "Owner Name"}
                value={
                  ownerParties.length ? (
                    <div className="space-y-1.5">
                      {ownerParties.map((party, index) => (
                        <div key={`${party.owner_name}-${index}`}>
                          {displayValue(party.owner_name)}
                        </div>
                      ))}
                    </div>
                  ) : ownerName
                }
              />
              <SummaryField
                label="Ownership Percentage"
                value={
                  ownerParties.length ? (
                    <div className="space-y-1.5">
                      {ownerParties.map((party, index) => (
                        <div key={`${party.owner_name}-share-${index}`}>
                          {formatOwnershipPercent(party.ownership_pct)}
                        </div>
                      ))}
                    </div>
                  ) : "Share not reported"
                }
              />
              <SummaryField
                label="Owner Mailing Address"
                value={ownerMailing}
                className="sm:col-span-2 lg:col-span-4"
              />
              <SummaryField
                label="Legal Description"
                value={<span className="whitespace-pre-line">{legalDescription}</span>}
                className="sm:col-span-2 lg:col-span-3"
              />
              <SummaryField
                label="Census Tract"
                value={
                  <div>
                    <span>{formatCensusTract(detail?.property_location?.census_tract)}</span>
                    {detail?.property_location?.census_tract_geoid ? (
                      <span className="mt-0.5 block font-mono text-[11px] font-normal text-slate-500">
                        GEOID {detail.property_location.census_tract_geoid}
                      </span>
                    ) : null}
                    {detail?.property_location?.census_tract_status === "review_required" ? (
                      <span className="mt-1 block text-[11px] font-medium text-amber-700">
                        Coordinate/county match needs review
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs -ml-2 mt-1 normal-case text-blue-700"
                      onClick={() => void lookUpCensusTractNow()}
                      disabled={censusLookupLoading || !accountId}
                    >
                      {censusLookupLoading
                        ? "Looking up..."
                        : detail?.property_location?.census_tract
                          ? "Refresh tract"
                          : "Look Up Now"}
                    </button>
                    {censusLookupMessage ? (
                      <span className={`mt-1 block text-[11px] font-medium ${
                        /added/i.test(censusLookupMessage) ? "text-emerald-700" : "text-amber-700"
                      }`}>
                        {censusLookupMessage}
                      </span>
                    ) : null}
                  </div>
                }
              />
            </div>

            <div className={`mt-5 rounded-xl border p-4 ${
              zoningEvidence?.review_required
                ? "border-amber-300 bg-amber-50/70"
                : "border-slate-200 bg-white/70"
            }`}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-slate-900">Zoning Evidence</h3>
                    {zoningEvidence?.verification ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
                        Appraiser confirmed
                      </span>
                    ) : zoningEvidence?.review_required ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                        Review required
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {zoningEvidence?.jurisdiction?.provider_label || "Loading the official municipal source..."}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-sm normal-case rounded-lg shadow-sm"
                  onClick={() => zoningEvidenceOpen
                    ? setZoningEvidenceOpen(false)
                    : void loadZoningEvidence({ open: true })}
                  disabled={zoningEvidenceLoading}
                >
                  {zoningEvidenceLoading
                    ? "Loading..."
                    : zoningEvidenceOpen ? "Close Evidence Viewer" : "Review Zoning Evidence"}
                </button>
              </div>
              {zoningEvidence?.review_reason ? (
                <p className="mt-2 text-xs leading-5 text-amber-800">{zoningEvidence.review_reason}</p>
              ) : null}
              {zoningEvidenceMessage ? (
                <p className="mt-2 text-xs font-medium text-slate-700">{zoningEvidenceMessage}</p>
              ) : null}

              {zoningEvidenceOpen && zoningEvidence?.jurisdiction ? (
                <div className="mt-4 grid gap-4 border-t border-slate-200 pt-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(22rem,1fr)]">
                  <div className="min-w-0">
                    {selectedZoningDocument ? (
                      <>
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <select
                            className="select select-bordered select-sm min-w-64 bg-white"
                            value={String(selectedZoningDocument.id)}
                            onChange={(event) => setZoningDraft((current) => ({
                              ...current,
                              sourceDocumentId: event.target.value,
                              sourceType: "map_pdf",
                            }))}
                          >
                            {zoningEvidence.documents.map((document) => (
                              <option key={document.id} value={document.id}>{document.title}</option>
                            ))}
                          </select>
                          <a
                            href={selectedZoningDocument.official_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs font-semibold text-blue-700 hover:underline"
                          >
                            Open official source
                          </a>
                        </div>
                        <iframe
                          title={selectedZoningDocument.title}
                          src={`/pdfjs-viewer.html?file=${encodeURIComponent(makeUrl(selectedZoningDocument.content_url))}`}
                          className="h-[32rem] w-full rounded-lg border border-slate-300 bg-slate-100"
                        />
                        <p className="mt-2 text-[11px] leading-4 text-slate-500">
                          Cached {formatDate(selectedZoningDocument.fetched_at)} · {selectedZoningDocument.page_count || "Unknown"} page(s) · Source version {selectedZoningDocument.checksum_sha256.slice(0, 12)}
                        </p>
                      </>
                    ) : (
                      <div className="flex h-64 flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-center">
                        <p className="text-sm font-semibold text-slate-800">No cacheable PDF is published for this city.</p>
                        <p className="mt-2 max-w-xl text-xs leading-5 text-slate-600">
                          Use the official interactive source and the city contact shown here. The confirmed result can still be saved with full provenance.
                        </p>
                        {zoningEvidence.jurisdiction.reference_url ? (
                          <a
                            href={zoningEvidence.jurisdiction.reference_url}
                            target="_blank"
                            rel="noreferrer"
                            className="btn btn-primary btn-sm mt-4 normal-case rounded-lg"
                          >
                            Open Official Zoning Resource
                          </a>
                        ) : null}
                      </div>
                    )}
                  </div>

                  <div className="space-y-4">
                    {zoningEvidence.jurisdiction.contact ? (
                      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-slate-700">
                        <h4 className="font-semibold text-slate-900">City verification contact</h4>
                        <p className="mt-1 font-medium">{zoningEvidence.jurisdiction.contact.department}</p>
                        {zoningEvidence.jurisdiction.contact.contactName ? <p>{zoningEvidence.jurisdiction.contact.contactName}</p> : null}
                        {zoningEvidence.jurisdiction.contact.phone ? (
                          <p className="mt-1"><a className="font-semibold text-blue-800 hover:underline" href={`tel:${zoningEvidence.jurisdiction.contact.phone}`}>{zoningEvidence.jurisdiction.contact.phone}</a></p>
                        ) : null}
                        {zoningEvidence.jurisdiction.contact.email ? (
                          <p><a className="font-semibold text-blue-800 hover:underline" href={`mailto:${zoningEvidence.jurisdiction.contact.email}`}>{zoningEvidence.jurisdiction.contact.email}</a></p>
                        ) : null}
                        {zoningEvidence.jurisdiction.contact.address ? <p className="mt-1">{zoningEvidence.jurisdiction.contact.address}</p> : null}
                        <a href={zoningEvidence.jurisdiction.contact.sourceUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block font-semibold text-blue-800 hover:underline">
                          Verify current contact on city site
                        </a>
                      </div>
                    ) : null}

                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                      <label className="block">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Confirmed Zoning Code</span>
                        <input className="input input-bordered input-sm mt-1 w-full bg-white" value={zoningDraft.zoningCode} onChange={(event) => setZoningDraft((current) => ({ ...current, zoningCode: event.target.value }))} />
                      </label>
                      <label className="block">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Source Type</span>
                        <select className="select select-bordered select-sm mt-1 w-full bg-white" value={zoningDraft.sourceType} onChange={(event) => setZoningDraft((current) => ({ ...current, sourceType: event.target.value as typeof current.sourceType }))}>
                          {selectedZoningDocument ? <option value="map_pdf">Official map / PDF</option> : null}
                          <option value="interactive_map">Official interactive map</option>
                          <option value="city_confirmation">Confirmed with city</option>
                          <option value="official_gis">Official GIS result</option>
                          <option value="manual">Other manual verification</option>
                        </select>
                      </label>
                      <label className="block sm:col-span-2 xl:col-span-1 2xl:col-span-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Verbatim Official Zoning Description</span>
                        <input className="input input-bordered input-sm mt-1 w-full bg-white" value={zoningDraft.zoningDescription} onChange={(event) => setZoningDraft((current) => ({ ...current, zoningDescription: event.target.value }))} />
                        {selectedZoningDocument ? (
                          <button
                            type="button"
                            className="btn btn-outline btn-xs mt-2 normal-case rounded-lg"
                            onClick={() => void prefillVerbatimZoningDescription()}
                            disabled={zoningEvidenceLoading || !zoningDraft.zoningCode.trim()}
                          >
                            Prefill Exact Wording from PDF
                          </button>
                        ) : null}
                      </label>
                      <label className="block">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">PDF Page</span>
                        <input type="number" min="1" className="input input-bordered input-sm mt-1 w-full bg-white" value={zoningDraft.pageNumber} onChange={(event) => setZoningDraft((current) => ({ ...current, pageNumber: event.target.value }))} />
                      </label>
                      <label className="block">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Reviewer</span>
                        <input className="input input-bordered input-sm mt-1 w-full bg-white" placeholder="Appraiser name" value={zoningDraft.reviewer} onChange={(event) => setZoningDraft((current) => ({ ...current, reviewer: event.target.value }))} />
                      </label>
                      <label className="block sm:col-span-2 xl:col-span-1 2xl:col-span-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">City Confirmation / Reference</span>
                        <input className="input input-bordered input-sm mt-1 w-full bg-white" placeholder="Contact name, call date, letter number, or ordinance" value={zoningDraft.confirmationReference} onChange={(event) => setZoningDraft((current) => ({ ...current, confirmationReference: event.target.value }))} />
                      </label>
                      <label className="block sm:col-span-2 xl:col-span-1 2xl:col-span-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Review Notes</span>
                        <textarea className="textarea textarea-bordered textarea-sm mt-1 min-h-20 w-full bg-white" value={zoningDraft.notes} onChange={(event) => setZoningDraft((current) => ({ ...current, notes: event.target.value }))} />
                      </label>
                    </div>
                    <p className="text-[11px] leading-4 text-slate-500">
                      Blurry or machine-read map labels are suggestions only. Saving requires an identified reviewer and never alters the official source document.
                    </p>
                    <button type="button" className="btn btn-primary btn-sm w-full normal-case rounded-lg shadow-sm" onClick={() => void saveZoningEvidence()} disabled={zoningEvidenceLoading}>
                      {zoningEvidenceLoading ? "Saving..." : "Save Confirmed Zoning"}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="mt-5 rounded-xl border border-slate-200 bg-white/70 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">Occupancy</h3>
                  <p className="mt-1 text-xs text-slate-500">Assignment-specific occupancy of the subject.</p>
                </div>
                <button
                  type="button"
                  onClick={() => void saveAssignmentFromSection()}
                  className="btn btn-primary btn-sm normal-case rounded-lg shadow-sm"
                  disabled={assignmentSaveDisabled}
                >
                  {savingAssignmentFile ? "Saving..." : "Save Occupancy"}
                </button>
              </div>
              {assignmentSaveMessage ? (
                <p className="mt-2 text-xs leading-5 text-slate-600">{assignmentSaveMessage}</p>
              ) : null}
              <div className="mt-3 grid gap-2 sm:grid-cols-4">
                {OCCUPANCY_OPTIONS.map(([value, label]) => (
                  <CheckboxChoice
                    key={value}
                    checked={assignmentDraft.occupancy === value}
                    label={label}
                    onChange={(checked) => updateAssignment("occupancy", checked ? value : "")}
                  />
                ))}
              </div>
              {assignmentDraft.occupancy === "unknown" ? (
                <label className="mt-3 block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Unknown Occupancy Explanation
                  </span>
                  <textarea
                    className="textarea textarea-bordered textarea-sm mt-1 min-h-16 w-full bg-white"
                    value={assignmentDraft.occupancy_explanation || ""}
                    onChange={(event) => updateAssignment("occupancy_explanation", event.target.value)}
                    placeholder="Explain why occupancy could not be confirmed"
                  />
                </label>
              ) : null}
            </div>

            <div className="mt-5 rounded-xl border border-slate-200 bg-white/70 p-4">
              <div className="mb-3">
                <h3 className="text-sm font-semibold text-slate-900">PUD and HOA</h3>
                <p className="mt-1 text-xs text-slate-500">
                  {activeAssignmentFile
                    ? `Saving to appraisal file ${activeAssignmentFile.file_number}.`
                    : "Enter a new file number above before saving changes."}
                </p>
              </div>
              <div className="max-w-xs">
                <CheckboxChoice
                  checked={Boolean(assignmentDraft.pud)}
                  label="PUD"
                  onChange={(checked) => updateAssignment("pud", checked)}
                />
              </div>
              {assignmentDraft.pud ? (
                <div className="mt-4 space-y-4">
                  <label className="block max-w-sm">
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                      HOA Dues Amount
                    </span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className="input input-bordered mt-1 w-full bg-white"
                      value={assignmentDraft.hoa_dues_amount ?? ""}
                      onChange={(event) =>
                        updateAssignment("hoa_dues_amount", event.target.value)
                      }
                      placeholder="Dollar amount"
                    />
                  </label>
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                      HOA Dues Frequency
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                      {HOA_FREQUENCY_OPTIONS.map(([value, label]) => (
                        <CheckboxChoice
                          key={value}
                          checked={assignmentDraft.hoa_frequency === value}
                          label={label}
                          onChange={(checked) =>
                            updateAssignment("hoa_frequency", checked ? value : "")
                          }
                        />
                      ))}
                    </div>
                  </div>
                  <label className="block">
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                      HOA Explanation
                    </span>
                    <textarea
                      className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
                      value={assignmentDraft.hoa_explanation || ""}
                      onChange={(event) =>
                        updateAssignment("hoa_explanation", event.target.value)
                      }
                      placeholder="Required when dues are unavailable or the frequency is Other"
                    />
                  </label>
                </div>
              ) : null}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-slate-500">
                  {assignmentSaveMessage || (assignmentDirty ? "Unsaved assignment changes" : "No unsaved changes")}
                </span>
                <button
                  type="button"
                  onClick={() => void saveAssignmentFromSection()}
                  className="btn btn-primary btn-sm normal-case rounded-lg shadow-sm"
                  disabled={assignmentSaveDisabled}
                >
                  {savingAssignmentFile ? "Saving..." : "Save PUD / HOA"}
                </button>
              </div>
            </div>
          </SummarySection>

          <SummarySection
            title="Assignment Details"
            subtitle={activeAssignmentFile
              ? `Saving to appraisal file ${activeAssignmentFile.file_number}`
              : "Choose a file number above to preserve these values as a new assignment"}
            manuallyVerified={Boolean(activeAssignmentFile || detail?.report_manual_values?.["report.assignment_details"])}
            compact
            className="order-5"
          >
            <div>
              <fieldset className="rounded-xl border border-slate-200 bg-white p-3">
                <legend className="px-1 text-sm font-semibold text-slate-900">Assignment Type</legend>
                <p className="mb-2 text-xs text-slate-600">Select every type that applies.</p>
                <div className="grid gap-1.5 sm:grid-cols-3 xl:grid-cols-5">
                  {ASSIGNMENT_TYPE_OPTIONS.map(([value, label]) => (
                    <CheckboxChoice
                      key={value}
                      checked={assignmentTypes.includes(value)}
                      label={label}
                      onChange={(checked) => updateAssignmentTypes(
                        checked
                          ? [...new Set([...assignmentTypes, value])]
                          : assignmentTypes.filter((item) => item !== value),
                      )}
                    />
                  ))}
                </div>
                {assignmentTypes.includes("other") ? (
                  <label className="mt-4 block">
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                      Other Assignment Explanation
                    </span>
                    <textarea
                      className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
                      value={assignmentDraft.assignment_explanation || ""}
                      onChange={(event) =>
                        updateAssignment("assignment_explanation", event.target.value)
                      }
                    />
                  </label>
                ) : null}
              </fieldset>
            </div>

            {assignmentErrors.length ? (
              <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                <ul className="list-disc space-y-1 pl-5">
                  {assignmentErrors.map((error) => <li key={error}>{error}</li>)}
                </ul>
              </div>
            ) : null}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-slate-500">
                {assignmentSaveMessage || (assignmentDirty ? "Unsaved assignment changes" : "No unsaved changes")}
              </span>
              <button
                type="button"
                onClick={() => void saveAssignmentFromSection()}
                className="btn btn-primary btn-sm normal-case rounded-lg shadow-sm"
                disabled={assignmentSaveDisabled}
              >
                {savingAssignmentFile ? "Saving..." : "Save Assignment Details"}
              </button>
            </div>
          </SummarySection>

          <AssignmentDocumentCenter
            accountId={accountId || ""}
            assignmentFileId={activeAssignmentFile?.id || null}
            getEditorKey={editorKeyForSave}
            onApplyConfirmedCandidate={applyConfirmedDocumentCandidate}
            className="order-6"
          />

          <div className="order-4 grid grid-cols-1 gap-5">
            <SummarySection
              title="Listings, Contracts, and Sales History"
              subtitle="MLS listing activity, contracts, closed sales, and CAD deed-transfer records"
              {...sectionEditProps("report.sales_history")}
            >
              <ListingsContractsSalesContent
                listingRows={listingRows}
                salesHistoryRows={salesHistoryRows}
                assignmentDraft={assignmentDraft}
                purchaseTransactionSelected={purchaseTransactionSelected}
                assignmentErrors={assignmentErrors}
                assignmentDirty={assignmentDirty}
                assignmentSaveMessage={assignmentSaveMessage}
                assignmentSaveDisabled={assignmentSaveDisabled}
                savingAssignmentFile={savingAssignmentFile}
                contractSellerComparison={contractSellerComparison}
                onAssignmentChange={updateAssignment}
                onSave={() => void saveAssignmentFromSection()}
              />
            </SummarySection>
          </div>

          <SummarySection
            title="Property Characteristics"
            subtitle={assignmentPropertyCharacteristics
              ? `Appraisal-district, verified MLS, and accepted mobile observations for ${activeAssignmentFile?.file_number}`
              : "Auto-populated appraisal-district and verified MLS characteristics"}
            {...sectionEditProps("report.property_characteristics")}
            className="order-2"
          >
            <div className="grid grid-cols-2 gap-x-5 gap-y-4 md:grid-cols-3 lg:grid-cols-5">
              <SummaryField
                label="Living Area"
                value={formatNumber(
                  improvement?.living_area_sqft || improvement?.total_living_area,
                  " sq. ft.",
                )}
              />
              <SummaryField
                label="Total Area"
                value={formatNumber(improvement?.total_area_sqft, " sq. ft.")}
              />
              <SummaryField label="Bedrooms" value={displayValue(improvement?.bedroom_count)} />
              <SummaryField label="Bathrooms" value={formatBaths(improvement)} />
              <SummaryField label="Stories" value={displayValue(improvement?.stories)} />
              <SummaryField label="Year Built" value={displayValue(improvement?.year_built)} />
              <SummaryField
                label="Effective Year"
                value={displayValue(improvement?.effective_year_built)}
              />
              <SummaryField label="Actual Age" value={displayValue(improvement?.actual_age)} />
              <SummaryField
                label="Building Class"
                value={displayValue(improvement?.building_class)}
              />
              <SummaryField
                label="Desirability"
                value={displayValue(improvement?.desirability)}
              />
              <SummaryField
                label="Housing Type"
                value={displayValue(housing?.housing_type)}
              />
              <SummaryField
                label="Attachment"
                value={displayValue(housing?.attachment_type)}
              />
              <SummaryField
                label="Architectural Style"
                value={displayValue(housing?.architectural_style)}
              />
              <SummaryField
                label="Construction"
                value={displayValue(improvement?.construction_type)}
              />
              <SummaryField label="Foundation" value={displayValue(improvement?.foundation)} />
              <SummaryField
                label="Exterior"
                value={displayValue(improvement?.exterior_material)}
              />
              <SummaryField
                label="Roof"
                value={[
                  improvement?.roof_type,
                  improvement?.roof_material,
                ]
                  .filter(hasValue)
                  .join(" · ") || "Not reported"}
              />
              <SummaryField label="Heating" value={displayValue(improvement?.heating)} />
              <SummaryField label="Air Conditioning" value={displayValue(improvement?.air_conditioning)} />
              <SummaryField
                label="Fireplaces"
                value={displayValue(improvement?.fireplaces)}
              />
              <SummaryField label="Kitchens" value={displayValue(improvement?.kitchens)} />
              <SummaryField label="Wet Bars" value={displayValue(improvement?.wetbars)} />
              <SummaryField label="Pool" value={formatReportedBoolean(improvement?.pool)} />
              <SummaryField
                label="Sprinkler"
                value={formatReportedBoolean(improvement?.sprinkler)}
              />
              <SummaryField label="Fence" value={displayValue(improvement?.fence_type)} />
              {Object.keys(inspectionDetails).length ? <>
                <SummaryField label="Skirting" value={displayValue(inspectionDetails.skirting)} />
                <SummaryField label="Window Type" value={displayValue(inspectionDetails.window_type)} />
                <SummaryField label="Interior Floor" value={displayValue(inspectionDetails.interior_floor_type)} />
                <SummaryField label="Bath Floor" value={displayValue(inspectionDetails.bath_floor_type)} />
                <SummaryField label="Kitchen Countertops" value={displayValue(inspectionDetails.kitchen_countertop_type)} />
                <SummaryField label="Interior Walls" value={displayValue(inspectionDetails.interior_wall_type)} />
                <SummaryField label="Garage / Carport" value={displayValue(inspectionDetails.garage_carport)} />
                <SummaryField label="Pool / Amenities" value={displayValue(inspectionDetails.pool_amenities)} />
                <SummaryField label="Updates / Remodeling" value={displayValue(inspectionDetails.updates_remodeling)} />
                <SummaryField label="Additions" value={displayValue(inspectionDetails.additions)} />
                <SummaryField label="Defects / Deferred Maintenance" value={displayValue(inspectionDetails.defects_deferred_maintenance)} />
                <SummaryField label="Repair Cost to Cure" value={displayValue(inspectionDetails.repair_cost_to_cure)} />
                <SummaryField label="Additional Improvements" value={displayValue(inspectionDetails.additional_improvements_notes)} />
                <SummaryField label="Field Comments" value={displayValue(inspectionDetails.appraiser_comments)} />
              </> : null}
              {additionalImprovements.map((row, index) => (
                <SummaryField
                  key={`${row.number || index}-${row.improvement_type || "improvement"}`}
                  label={displayValue(row.improvement_type, `Improvement ${index + 1}`)}
                  value={(
                    <div>
                      <span>{formatNumber(row.area_sqft, " sq. ft.")}</span>
                      <span className="mt-0.5 block text-xs font-normal leading-5 text-slate-600">
                        {[row.construction, row.floor, row.exterior_wall]
                          .filter(hasValue)
                          .join(" · ") || "Construction details not reported"}
                        {hasValue(row.year_built)
                          ? ` · Built ${displayValue(row.year_built)}`
                          : ""}
                      </span>
                    </div>
                  )}
                />
              ))}
            </div>

            {assignmentPropertyCharacteristics || mobileInspectionPhotos.length ? (
              <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs leading-5 text-emerald-900">
                Accepted mobile observations are scoped to appraisal file {activeAssignmentFile?.file_number}.
                {mobileInspectionPhotos.length
                  ? ` ${mobileInspectionPhotos.length} verified field photo${mobileInspectionPhotos.length === 1 ? " is" : "s are"} attached to this file and retained for five years.`
                  : " No verified mobile field photos are attached yet."}
              </div>
            ) : null}

            <div className="mt-5 border-t border-slate-200 pt-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-slate-800">
                      Property Context &amp; Complexity
                    </h3>
                    {propertyContext ? (
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        propertyContext.effective_complexity === "complex"
                          ? "bg-red-100 text-red-800"
                          : propertyContext.effective_complexity === "moderate"
                            ? "bg-amber-100 text-amber-900"
                            : "bg-emerald-100 text-emerald-800"
                      }`}>
                        {propertyContext.effective_complexity[0].toUpperCase() + propertyContext.effective_complexity.slice(1)}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">
                    Appraisal screening based on GLA, age, site size, amenities, parcel configuration,
                    nearby land uses, and road influences. The appraiser remains responsible for the final determination.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void analyzeCurrentPropertyContext()}
                  disabled={propertyContextLoading}
                  className="btn btn-sm normal-case rounded-lg border-slate-900 bg-slate-900 text-white hover:bg-black disabled:opacity-60"
                >
                  {propertyContextLoading ? "Analyzing..." : propertyContext ? "Refresh Context" : "Analyze Context"}
                </button>
              </div>

              {propertyContext ? (
                <div className="mt-4 space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <SummaryField
                      label="Automatic Recommendation"
                      value={`${propertyContext.automatic_complexity[0].toUpperCase()}${propertyContext.automatic_complexity.slice(1)} (${propertyContext.score}/100)`}
                    />
                    <SummaryField
                      label="Confidence"
                      value={`${propertyContext.confidence[0].toUpperCase()}${propertyContext.confidence.slice(1)}`}
                    />
                    <SummaryField
                      label="Comparable Search Profile"
                      value={propertyContext.recommended_search_profile
                        .split("_")
                        .map((part) => part[0].toUpperCase() + part.slice(1))
                        .join(" - ")}
                    />
                    <SummaryField
                      label="Peer Properties"
                      value={`${propertyContext.peer_statistics.peer_count.toLocaleString()} analyzed`}
                    />
                  </div>

                  {propertyContext.factors.length ? (
                    <div className="grid gap-2 md:grid-cols-2">
                      {propertyContext.factors.map((factor) => (
                        <div
                          key={factor.code}
                          className={`rounded-lg border px-3 py-2 ${
                            factor.severity === "high"
                              ? "border-red-200 bg-red-50"
                              : factor.severity === "moderate"
                                ? "border-amber-200 bg-amber-50"
                                : "border-slate-200 bg-slate-50"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3 text-xs font-semibold text-slate-900">
                            <span>{factor.label}</span>
                            <span>+{factor.points}</span>
                          </div>
                          <p className="mt-1 text-xs leading-5 text-slate-700">{factor.detail}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                      No measured characteristic or location factor currently raises the automatic complexity score.
                    </div>
                  )}

                  {propertyContext.warnings.length ? (
                    <details className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                      <summary className="cursor-pointer text-xs font-semibold text-amber-950">
                        Data coverage and source notices ({propertyContext.warnings.length})
                      </summary>
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 text-amber-950">
                        {propertyContext.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                      </ul>
                    </details>
                  ) : null}

                  <div className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 lg:grid-cols-[220px_minmax(0,1fr)_auto] lg:items-end">
                    <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
                      Appraiser Complexity
                      <select
                        value={propertyComplexityDraft}
                        onChange={(event) => setPropertyComplexityDraft(event.target.value as PropertyComplexityLevel)}
                        className="select select-bordered select-sm bg-white text-sm font-normal normal-case"
                      >
                        <option value="simple">Simple</option>
                        <option value="moderate">Moderate</option>
                        <option value="complex">Complex</option>
                      </select>
                    </label>
                    <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
                      Review Notes
                      <input
                        value={propertyComplexityNotes}
                        onChange={(event) => setPropertyComplexityNotes(event.target.value)}
                        placeholder="Optional support for confirmation or override"
                        className="input input-bordered input-sm bg-white text-sm font-normal normal-case"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => void saveCurrentPropertyComplexity()}
                      disabled={propertyContextSaving}
                      className="btn btn-sm normal-case rounded-lg border-slate-900 bg-slate-900 text-white hover:bg-black disabled:opacity-60"
                    >
                      {propertyContextSaving ? "Saving..." : "Save Complexity Review"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                  Run the local context analysis to establish the assignment-complexity recommendation before selecting comparable sales.
                </div>
              )}

              {propertyContextMessage ? (
                <p className="mt-3 text-xs font-medium text-slate-700">{propertyContextMessage}</p>
              ) : null}
            </div>

            <div className="mt-5 border-t border-slate-200 pt-4">
              <div className="mb-4">
                <h3 className="text-sm font-semibold text-slate-800">
                  Subject Condition and Neighborhood Conformity
                </h3>
                <p className="mt-1 text-xs text-slate-500">
                  Appraiser selections and comments saved with the active appraisal file.
                </p>
              </div>

              <div className="grid gap-4 lg:grid-cols-[minmax(180px,240px)_minmax(0,1fr)]">
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Condition Rating
                  </span>
                  <select
                    className="select select-bordered mt-1 w-full bg-white"
                    value={assignmentDraft.subject_condition_rating || ""}
                    onChange={(event) =>
                      updateAssignment("subject_condition_rating", event.target.value)
                    }
                  >
                    <option value="">Select condition rating</option>
                    {UAD_CONDITION_RATINGS.map((rating) => (
                      <option key={rating} value={rating}>{rating}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Subject Condition Comments
                  </span>
                  <textarea
                    className="textarea textarea-bordered mt-1 min-h-24 w-full bg-white"
                    value={assignmentDraft.subject_condition_notes || ""}
                    onChange={(event) =>
                      updateAssignment("subject_condition_notes", event.target.value)
                    }
                    placeholder="Describe the home's condition, updating, maintenance, and other relevant observations."
                  />
                </label>
              </div>

              <div className="mt-4 grid gap-4 xl:grid-cols-2">
                <fieldset className="rounded-xl border border-slate-200 bg-white p-3">
                  <legend className="px-1 text-sm font-semibold text-slate-900">
                    Significant Physical Deficiencies
                  </legend>
                  <p className="mb-3 text-xs leading-5 text-slate-600">
                    Do any deficiencies affect the subject&apos;s livability, soundness, or structural integrity?
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <CheckboxChoice
                      checked={assignmentDraft.significant_physical_deficiencies === true}
                      label="Yes"
                      onChange={(checked) => updateAssignment(
                        "significant_physical_deficiencies",
                        checked ? true : null,
                      )}
                    />
                    <CheckboxChoice
                      checked={assignmentDraft.significant_physical_deficiencies === false}
                      label="No"
                      onChange={(checked) => updateAssignment(
                        "significant_physical_deficiencies",
                        checked ? false : null,
                      )}
                    />
                  </div>
                </fieldset>

                <fieldset className="rounded-xl border border-slate-200 bg-white p-3">
                  <legend className="px-1 text-sm font-semibold text-slate-900">
                    Neighborhood Conformity
                  </legend>
                  <p className="mb-3 text-xs leading-5 text-slate-600">
                    Does the subject conform to the neighborhood?
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <CheckboxChoice
                      checked={assignmentDraft.subject_conforms_to_neighborhood === true}
                      label="Yes"
                      onChange={(checked) => updateSubjectConformity(checked ? true : null)}
                    />
                    <CheckboxChoice
                      checked={assignmentDraft.subject_conforms_to_neighborhood === false}
                      label="No"
                      onChange={(checked) => updateSubjectConformity(checked ? false : null)}
                    />
                  </div>

                  {assignmentDraft.subject_conforms_to_neighborhood === false ? (
                    <label className="mt-4 block">
                      <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                        Nonconformity Type
                      </span>
                      <select
                        className="select select-bordered mt-1 w-full bg-white"
                        value={assignmentDraft.subject_nonconformity_type || ""}
                        onChange={(event) =>
                          updateAssignment("subject_nonconformity_type", event.target.value)
                        }
                      >
                        <option value="">Select a type</option>
                        {SUBJECT_NONCONFORMITY_OPTIONS.map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                    </label>
                  ) : null}

                  {assignmentDraft.subject_conforms_to_neighborhood === false &&
                  assignmentDraft.subject_nonconformity_type ? (
                    <label className="mt-4 block">
                      <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                        Explanation
                      </span>
                      <textarea
                        className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
                        value={assignmentDraft.subject_nonconformity_explanation || ""}
                        onChange={(event) =>
                          updateAssignment("subject_nonconformity_explanation", event.target.value)
                        }
                        placeholder="Explain how the subject differs from the neighborhood."
                      />
                    </label>
                  ) : null}
                </fieldset>
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-slate-500">
                  {assignmentSaveMessage || (assignmentDirty ? "Unsaved assignment changes" : "No unsaved changes")}
                </span>
                <button
                  type="button"
                  onClick={() => void saveAssignmentFromSection()}
                  className="btn btn-primary btn-sm normal-case rounded-lg shadow-sm"
                  disabled={assignmentSaveDisabled}
                >
                  {savingAssignmentFile ? "Saving..." : "Save Condition & Conformity"}
                </button>
              </div>
            </div>

            <div className="mt-5 border-t border-slate-200 pt-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-slate-800">Land Details</h3>
                    {detail?.report_manual_values?.["report.land_details"] ? (
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-800">
                        Manually verified
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {landRows.length} land record{landRows.length === 1 ? "" : "s"} returned
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => editSection("report.land_details")}
                  className="btn btn-sm normal-case border-slate-300 bg-white text-slate-800 hover:border-blue-400 hover:bg-blue-50"
                >
                  Edit Land Details
                </button>
              </div>

              {landRows.length ? (
                <div className="mt-4 space-y-4">
                  {landRows.map((row, index) => {
                    const prefix = landRows.length > 1 ? `Land ${index + 1} ` : "";
                    return (
                      <div
                        key={row.number || index}
                        className="grid grid-cols-2 gap-x-5 gap-y-4 md:grid-cols-3 lg:grid-cols-5"
                      >
                        <SummaryField
                          label={`${prefix}Use / State Code`}
                          value={displayValue(row.state_code)}
                        />
                        <SummaryField
                          label={`${prefix}Area`}
                          value={formatNumber(row.area_sqft, " sq. ft.")}
                        />
                        <SummaryField
                          label={`${prefix}Frontage × Depth`}
                          value={
                            parseNumber(row.frontage_ft) !== null ||
                            parseNumber(row.depth_ft) !== null
                              ? `${formatNumber(row.frontage_ft, " ft.")} × ${formatNumber(
                                  row.depth_ft,
                                  " ft.",
                                )}`
                              : "Not reported"
                          }
                        />
                        <SummaryField
                          label={`${prefix}CAD Pricing`}
                          value={displayValue(row.pricing_method)}
                        />
                        <SummaryField
                          label={`${prefix}CAD Adjusted Price`}
                          value={formatMoney(row.adjusted_price)}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-4 text-sm text-slate-600">
                  No land detail records were returned for this parcel.
                </p>
              )}

              <div className="mt-5 border-t border-slate-200 pt-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-slate-800">Highest and Best Use</h3>
                      {assignmentDraft.highest_best_use_source ? (
                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-800">
                          Automated screening
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      Provisional as-improved conclusion based on current use, zoning, and the defined-area site comparison.
                    </p>
                  </div>
                  <select
                    className="select select-bordered select-sm bg-white"
                    value={assignmentDraft.highest_best_use_conclusion || ""}
                    onChange={(event) => updateAssignment("highest_best_use_conclusion", event.target.value)}
                  >
                    <option value="">Not analyzed</option>
                    <option value="current_use">Current use</option>
                    <option value="investigation_required">Investigation required</option>
                  </select>
                </div>

                <div className="mt-3 grid gap-3 md:grid-cols-4">
                  <SummaryField
                    label="Zoning Compatibility"
                    value={
                      assignmentDraft.highest_best_use_zoning_compatible === true
                        ? "Appears compatible"
                        : assignmentDraft.highest_best_use_zoning_compatible === false
                          ? "Potential mismatch"
                          : "Requires verification"
                    }
                  />
                  <SummaryField
                    label="Subject Site"
                    value={formatNumber(
                      assignmentDraft.highest_best_use_subject_site_area_sqft,
                      " sq. ft.",
                    )}
                  />
                  <SummaryField
                    label="Predominant Same-Use Site"
                    value={formatNumber(
                      assignmentDraft.highest_best_use_comparison_median_site_area_sqft,
                      " sq. ft.",
                    )}
                  />
                  <SummaryField
                    label="Smallest Same-Use Comparison Site"
                    value={
                      parseNumber(assignmentDraft.highest_best_use_comparison_min_site_area_sqft) !== null
                        ? `${formatNumber(assignmentDraft.highest_best_use_comparison_min_site_area_sqft, " sq. ft.")} · ${formatNumber(assignmentDraft.highest_best_use_comparison_parcel_count)} parcels reviewed`
                        : "Not available"
                    }
                  />
                </div>

                {(assignmentDraft.highest_best_use_flags || []).length ? (
                  <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-amber-950">
                      Investigation flags
                    </div>
                    <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-amber-950">
                      {(assignmentDraft.highest_best_use_flags || []).map((flag) => (
                        <li key={flag}>{flag}</li>
                      ))}
                    </ul>
                  </div>
                ) : assignmentDraft.highest_best_use_conclusion === "current_use" ? (
                  <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs font-medium text-emerald-900">
                    No automated zoning or site-size investigation flags were identified.
                  </div>
                ) : null}

                <label className="mt-3 block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Conclusion and Support</span>
                  <textarea
                    className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
                    value={assignmentDraft.highest_best_use_summary || ""}
                    onChange={(event) => updateAssignment("highest_best_use_summary", event.target.value)}
                    placeholder="Run Present Land Use to populate a provisional conclusion, then edit as needed."
                  />
                </label>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <span className="text-xs text-slate-500">
                    {assignmentDraft.highest_best_use_analyzed_at
                      ? `Screened ${formatDate(assignmentDraft.highest_best_use_analyzed_at)}. Final appraiser verification is required.`
                      : "Run Analyze Present Land Use to perform the automated screening."}
                  </span>
                  <button
                    type="button"
                    onClick={() => void saveAssignmentFromSection()}
                    className="btn btn-primary btn-sm normal-case rounded-lg shadow-sm"
                    disabled={assignmentSaveDisabled}
                  >
                    {savingAssignmentFile ? "Saving..." : "Save Highest and Best Use"}
                  </button>
                </div>
              </div>
            </div>
          </SummarySection>

          <DeferredReportSection
            label="Neighborhood Characteristics"
            className="order-3"
            minimumHeight={300}
            onReady={() => setNeighborhoodSectionReady(true)}
          >
            <SummarySection
              title="Neighborhood Characteristics"
              subtitle="Present land use, neighborhood factors, market ranges, and assignment boundary review"
              manuallyVerified={Boolean(activeAssignmentFile)}
            >
              <NeighborhoodCharacteristicsContent
              accountId={accountId}
              assignmentFileId={activeAssignmentFile?.id || null}
              assignmentDraft={assignmentDraft}
              postalCode={censusZip}
              unemploymentLoading={unemploymentLookupLoading}
              unemploymentMessage={unemploymentLookupMessage}
              profileLoading={neighborhoodProfileLoading}
              profileMessage={neighborhoodProfileMessage}
              boundarySuggestions={neighborhoodBoundarySuggestions}
              customAreaAvailable={Boolean(
                assignmentDraft.neighborhood_boundary_geometry ||
                customMarketStudy?.market.custom_geometry
              )}
              assignmentDirty={assignmentDirty}
              assignmentSaveMessage={assignmentSaveMessage}
              assignmentSaveDisabled={assignmentSaveDisabled}
              savingAssignmentFile={savingAssignmentFile}
              onAssignmentChange={updateAssignment}
              onRefreshUnemployment={() => void lookupUnemploymentComparison()}
              onRefreshBoundary={() => void refreshNeighborhoodProfile()}
              onBoundarySuggestionsChange={setNeighborhoodBoundarySuggestions}
              onConfirmBoundary={confirmNeighborhoodBoundary}
              marketConditionsDraft={marketConditionsDraft}
              highestBestUseContext={{
                zoning: String(primaryZoning || ""),
                currentUse: [
                  housing?.housing_type,
                  housing?.structural_style,
                  ...landRows.map((row) => row.state_code),
                ].filter(Boolean).join(" "),
              }}
              valuePositionContext={{
                concludedValue: salesComparisonValue,
                source: salesComparisonValueSource,
                subjectGla,
                subjectAge,
                subjectQuality: String(salesComparisonDraft?.subject?.quality || ""),
              }}
              onMarketConditionsChange={updateMarketConditions}
              onSave={() => void saveAssignmentFromSection()}
              />
            </SummarySection>
          </DeferredReportSection>

          <SummarySection
            title="CAD Values, Taxes, and Exemptions"
            subtitle={`Certified tax year ${displayValue(
              values?.certified_year || detail?.tax_year,
            )}`}
            actions={(
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => editSection("report.appraisal_values")}
                  className="btn btn-sm normal-case border-slate-300 bg-white text-slate-800 hover:border-blue-400 hover:bg-blue-50"
                >
                  Edit Values
                </button>
                <button
                  type="button"
                  onClick={() => editSection("report.exemptions")}
                  className="btn btn-sm normal-case border-slate-300 bg-white text-slate-800 hover:border-blue-400 hover:bg-blue-50"
                >
                  Edit Taxes &amp; Exemptions
                </button>
              </div>
            )}
            manuallyVerified={Boolean(
              detail?.report_manual_values?.["report.appraisal_values"] ||
              detail?.report_manual_values?.["report.exemptions"],
            )}
            collapsible
            defaultExpanded={false}
            className="order-6"
          >
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <SummaryField label="Market Value" value={formatMoney(values?.market_value)} />
              <SummaryField
                label="Assessed / Capped Value"
                value={formatMoney(values?.capped_value || values?.market_value)}
              />
              <SummaryField label="Improvement Value" value={formatMoney(values?.improvement_value)} />
              <SummaryField label="CAD Land Value" value={formatMoney(values?.land_value)} />
            </div>

            <div className="mt-5 border-t border-slate-200 pt-4">
              <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <SummaryField label="Homestead" value={homestead ? "Yes" : "No"} />
                <SummaryField
                  label="Taxing Units with Exemption"
                  value={new Intl.NumberFormat("en-US").format(exemptJurisdictionCount)}
                />
              </div>

              {exemptionRows.length ? (
                <div>
                  <div
                    className="grid gap-x-6 border-b border-slate-300 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-600"
                    style={{ gridTemplateColumns: "minmax(180px,1.4fr) minmax(160px,1fr) minmax(160px,1fr)" }}
                  >
                    <div>Taxing Unit</div>
                    <div className="text-right">Homestead Exemption</div>
                    <div className="text-right">Taxable Value</div>
                  </div>
                  {exemptionRows.map(({ key, fallbackLabel, row }) => (
                    <div
                      key={key}
                      className="grid gap-x-6 border-b border-slate-200 py-2.5 text-sm last:border-b-0"
                      style={{ gridTemplateColumns: "minmax(180px,1.4fr) minmax(160px,1fr) minmax(160px,1fr)" }}
                    >
                      <div>{displayValue(row?.taxing_jurisdiction, fallbackLabel)}</div>
                      <div className="text-right">{formatMoney(row?.homestead_exemption)}</div>
                      <div className="text-right">{formatMoney(row?.taxable_value)}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-600">
                  No current exemption or taxable-value records were returned for this parcel.
                </p>
              )}
            </div>
          </SummarySection>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-2 border-t border-slate-200 pt-5 sm:grid-cols-2 xl:grid-cols-5">
          <a
            href={
              accountId
                ? `/ComparableSalesAnalysis?propertyId=${encodeURIComponent(accountId)}`
                : "#"
            }
            aria-label="Sales Comparison Approach"
            aria-disabled={!accountId}
            className={`btn normal-case rounded-md px-4 py-2 ${
              accountId
                ? "border-emerald-600 bg-emerald-600 text-white hover:border-emerald-700 hover:bg-emerald-700"
                : "pointer-events-none border-slate-200 bg-slate-200 text-slate-500"
            }`}
          >
            Sales Comparison Approach
          </a>
          <button
            type="button"
            disabled
            title="Cost Approach is coming soon"
            aria-label="Cost Approach coming soon"
            className="btn normal-case rounded-md border-slate-200 bg-slate-200 px-4 py-2 text-slate-500"
          >
            Cost Approach
          </button>
          <button
            type="button"
            disabled
            title="Income Approach is coming soon"
            aria-label="Income Approach coming soon"
            className="btn normal-case rounded-md border-slate-200 bg-slate-200 px-4 py-2 text-slate-500"
          >
            Income Approach
          </button>
          <a
            href={protestUrl}
            aria-label="Property Tax Protest"
            className="btn normal-case rounded-md border-blue-600 bg-blue-600 px-4 py-2 text-white hover:border-blue-700 hover:bg-blue-700"
          >
            Property Tax Protest
          </a>
          <a
            href={
              accountId
                ? `/AppraisalReport?propertyId=${encodeURIComponent(accountId)}${
                    appraisalReportAssignmentFile
                      ? `&assignmentFileId=${encodeURIComponent(String(appraisalReportAssignmentFile.id))}`
                      : ""
                  }`
                : "#"
            }
            aria-label="Full Appraisal PDF"
            aria-disabled={!accountId}
            title={neighborhoodBoundaryErrors.length
              ? `PDF printing will be blocked until: ${neighborhoodBoundaryErrors.join(" ")}`
              : "Open the full appraisal report"}
            className={`btn normal-case rounded-md px-4 py-2 ${
              accountId
                ? neighborhoodBoundaryErrors.length
                  ? "border-amber-500 bg-amber-100 text-amber-950 hover:bg-amber-200"
                  : "border-slate-900 bg-slate-900 text-white hover:border-slate-950 hover:bg-slate-950"
                : "pointer-events-none border-slate-200 bg-slate-200 text-slate-500"
            }`}
          >
            {neighborhoodBoundaryErrors.length ? "PDF Setup Required" : "Full Appraisal PDF"}
          </a>
        </div>
      </div>
      {editingSection ? (
        <ReportSectionEditor
          section={editingSection}
          initialValue={editableSectionValue(editingSection.key)}
          saving={savingSection}
          onCancel={() => setEditingSection(null)}
          onSave={saveEditedSection}
        />
      ) : null}
    </div>
  );
}

export default function PropertyReport() {
  const location = useLocation();
  const { accountId: routeAccountId } = useParams<{ accountId?: string }>();
  const reportOpenedAt = useRef(performance.now());
  const subjectVisibleReported = useRef(false);

  const presetAccount = useMemo(() => {
    if (routeAccountId) return routeAccountId;
    const params = new URLSearchParams(location.search);
    return params.get("account_id") || params.get("account") || "";
  }, [location.search, routeAccountId]);

  const account = presetAccount;
  const [detail, setDetail] = useState<DcadDetail | null>(null);
  const hasAutoImported = useRef(false);
  const loadRequestId = useRef(0);

  async function importFromDatabase() {
    if (!account) {
      window.alert("Enter an Account ID first.");
      return;
    }
    const requestedAccount = account.trim();
    const requestId = ++loadRequestId.current;
    try {
      const response = await fetchDetail(requestedAccount);
      if (requestId !== loadRequestId.current) return;
      setDetail(response?.detail ?? null);

      // The account payload is complete without MLS media. Load any future
      // photo gallery in the background and never hold back the report.
      void getAccountPhotos(requestedAccount)
        .then((photoResponse) => {
          if (requestId !== loadRequestId.current) return;
          const photos = photoResponse?.photos
            ?.map((photo) => photo?.media_url)
            .filter((url): url is string => Boolean(url?.trim())) || [];
          if (!photos.length) return;
          setDetail((current) => (current ? { ...current, photos } : current));
        })
        .catch((error) => {
          console.warn("Property photos were unavailable", error);
        });
    } catch (error: unknown) {
      if (requestId !== loadRequestId.current) return;
      console.error(error);
      window.alert(error instanceof Error ? error.message : "Import failed");
    }
  }

  useEffect(() => {
    subjectVisibleReported.current = false;
    reportOpenedAt.current = performance.now();
  }, [account]);

  useEffect(() => {
    if (!detail || subjectVisibleReported.current) return;
    const frame = window.requestAnimationFrame(() => {
      subjectVisibleReported.current = true;
      const durationMs = Math.round((performance.now() - reportOpenedAt.current) * 10) / 10;
      performance.clearMeasures("homenode-property-report-subject-visible");
      performance.measure("homenode-property-report-subject-visible", {
        start: reportOpenedAt.current,
        end: performance.now(),
      });
      console.info("[performance] property report subject visible", { duration_ms: durationMs });
      window.dispatchEvent(new CustomEvent("homenode:report-subject-visible", {
        detail: { duration_ms: durationMs },
      }));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [detail]);

  useEffect(() => {
    if (!hasAutoImported.current && account) {
      hasAutoImported.current = true;
      void importFromDatabase();
    }
    // The account is intentionally imported only once when the routed report opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  return (
    <div className="min-h-screen bg-base-200">
      <div className="navbar bg-base-100 shadow-sm">
        <div className="container mx-auto px-4">
          <div className="flex w-full items-center justify-between">
            <span className="text-xl font-semibold">Property Report</span>
            <a href="/" className="btn btn-ghost btn-sm normal-case">
              ← Close Report
            </a>
          </div>
        </div>
      </div>

      <main
        className="container mx-auto space-y-4 px-4 py-4"
        data-report-subject-loaded={detail ? "true" : "false"}
      >
        <AddressHero detail={detail} accountId={account} onReload={importFromDatabase} />
      </main>
    </div>
  );
}

