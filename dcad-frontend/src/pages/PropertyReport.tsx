import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { fetchDetail } from "@/lib/dcad";
import {
  forgetEditorCredential,
  requestEditorCredential,
} from "@/lib/editorCredential";
import {
  readAppraisalReportDraft,
  type AppraisalReportSalesDraft,
} from "@/lib/appraisalReportDraft";
import {
  createAssignmentFile,
  downloadCustomAppraisalReportPdf,
  downloadCustomAppraisalWorkfile,
  analyzePropertyContext as runPropertyContextAnalysis,
  getPropertyZoningEvidence,
  getZoningDocumentDescriptionSuggestion,
  getCensusCityProfile,
  getCensusZipProfile,
  getNeighborhoodProfile,
  reviewNeighborhoodBoundary as saveNeighborhoodBoundaryReview,
  getPropertyContextAssessment,
  getAssignmentFiles,
  getCustomAppraisalWorkfile,
  getCustomAppraisalWorkfileReadiness,
  getAccountPhotos,
  getRelatedParcels,
  lookupAccountCensusGeography,
  savePropertyContextReview,
  savePropertyZoningVerification,
  saveCustomAppraisalWorkfileSection,
  signCustomAppraisalWorkfile,
  updateAssignmentFile,
  updatePropertyReportSections,
  type AppraisalAssignmentFile,
  type AssignmentDocumentType,
  type AssignmentDetailsPayload,
  type NeighborhoodProfileResponse,
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
  DEFAULT_NEIGHBORHOOD_BOUNDARY_NARRATIVE,
  marketTrendFromChange,
  neighborhoodBoundaryReadinessErrors,
} from "@/lib/neighborhoodCharacteristics";
import {
  growthFromMarket,
  marketTrendFromRecommendation,
  marketingTimeFromMedianDom,
  reconciledMedianDaysOnMarket,
  type NeighborhoodLocationType,
} from "@/lib/neighborhoodAutomation";
import { UAD_CONDITION_RATINGS } from "@/lib/conditionQualityRatings";
import DeferredReportSection from "@/components/DeferredReportSection";
import AssignmentDocumentCenter from "@/components/AssignmentDocumentCenter";
import AssignmentPhotoCenter from "@/components/AssignmentPhotoCenter";
import MobileSketchReview from "@/components/MobileSketchReview";
import PreviousAppraisalFiles from "@/components/PreviousAppraisalFiles";
import ReportSectionEditor, {
  type EditableReportSection,
} from "@/components/ReportSectionEditor";
import NeighborhoodCharacteristicsContent from "@/components/NeighborhoodCharacteristicsContent";
import ListingsContractsSalesContent, {
  type PropertyActivityRow,
} from "@/components/ListingsContractsSalesContent";
import {
  CheckboxChoice,
  SummaryField,
  SummarySection,
} from "@/components/PropertyReportControls";
import {
  displayValue,
  formatBaths,
  formatCensusTract,
  formatDate,
  formatMoney,
  formatNumber,
  formatOwnershipPercent,
  formatReportedBoolean,
  hasValue,
  listingTimelineRows,
  parseNumber,
  sellerComparisonSummary,
} from "@/lib/propertyReportPresentation";
import {
  ASSIGNMENT_TYPE_OPTIONS,
  HOA_FREQUENCY_OPTIONS,
  OCCUPANCY_OPTIONS,
  assignmentValidationErrors,
  cloneEditorValue,
} from "@/lib/propertyReportAssignment";

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

type DcadSaleHistoryRow = PropertyActivityRow;

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

const EDITABLE_REPORT_SECTIONS: EditableReportSection[] = [
  { key: "report.subject_identification", title: "Subject Identification" },
  { key: "report.exemptions", title: "Current Exemptions" },
  { key: "report.sales_history", title: "Listings, Contracts, and Sales History" },
  { key: "report.property_characteristics", title: "Property Characteristics" },
  { key: "report.land_details", title: "Land Details" },
  { key: "report.appraisal_values", title: "Appraisal District Values" },
];

const SUBJECT_NONCONFORMITY_OPTIONS = [
  ["under_improvement", "Under-Improvement"],
  ["over_improvement", "Over-Improvement"],
  ["functional_obsolescence", "Functional Obsolescence"],
  ["other", "Other"],
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

function AddressHero({
  detail,
  accountId,
  requestedAssignmentFileId,
  onReload,
}: {
  detail: DcadDetail | null;
  accountId?: string;
  requestedAssignmentFileId?: number | null;
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
  const [neighborhoodProfileRetryNonce, setNeighborhoodProfileRetryNonce] = useState(0);
  const [neighborhoodBoundarySuggestions, setNeighborhoodBoundarySuggestions] = useState<
    NonNullable<NeighborhoodProfileResponse["boundary_streets"]>["cardinal_boundaries"] | null
  >(null);
  const neighborhoodProfileAttemptedSignature = useRef("");
  const neighborhoodProfileRetryTimer = useRef<number | null>(null);
  const neighborhoodProfileRetryAttempts = useRef<Record<string, number>>({});
  const [marketConditionsDraft, setMarketConditionsDraft] = useState<MarketConditionsDraft | null>(
    () => readMarketConditionsDraft(accountId || ""),
  );
  const [salesComparisonDraft, setSalesComparisonDraft] = useState<AppraisalReportSalesDraft | null>(
    () => readAppraisalReportDraft(accountId || ""),
  );
  const marketWorkfileRevisionRef = useRef(0);
  const marketWorkfileSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [workfileStatusMessage, setWorkfileStatusMessage] = useState("");
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
    const context = detail?.property_context || null;
    setPropertyContext(context);
    setPropertyComplexityDraft(context?.effective_complexity || "simple");
    setPropertyComplexityNotes(context?.appraiser_notes || "");
    setPropertyContextMessage("");
  }, [accountId, detail?.property_context]);

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
    marketWorkfileRevisionRef.current = 0;
    setWorkfileStatusMessage("");
    setMarketConditionsDraft(readMarketConditionsDraft(accountId || ""));
    setSalesComparisonDraft(readAppraisalReportDraft(accountId || ""));
    if (!accountId?.trim() || !detailLoaded) {
      setAssignmentFilesLoading(false);
      setAssignmentFilesLoaded(true);
      return () => {
        cancelled = true;
      };
    }

    setAssignmentFilesLoading(true);
    void getAssignmentFiles(accountId)
      .then(async (response) => {
        if (cancelled) return;
        setAssignmentFiles(response.files || []);
        const requestedFile = requestedAssignmentFileId
          ? response.files.find((file) => file.id === requestedAssignmentFileId) || null
          : null;
        const selectedFile = requestedFile || response.latest_file;
        if (selectedFile) {
          hydrateAssignmentDraft(selectedFile.assignment_details);
          setActiveAssignmentFile(selectedFile);
          setAssignmentFileNumber(selectedFile.file_number);
          try {
            const workfileResult = await getCustomAppraisalWorkfile(accountId, selectedFile.id);
            if (cancelled) return;
            const marketSection = workfileResult.workfile.sections.market_conditions;
            const salesSection = workfileResult.workfile.sections.sales_comparison;
            marketWorkfileRevisionRef.current = Number(marketSection?.revision || 0);
            setMarketConditionsDraft(
              (marketSection?.value as MarketConditionsDraft | undefined) ||
                readMarketConditionsDraft(accountId || ""),
            );
            setSalesComparisonDraft(
              (salesSection?.value as AppraisalReportSalesDraft | undefined) ||
                readAppraisalReportDraft(accountId || ""),
            );
            setWorkfileStatusMessage(
              workfileResult.workfile.status === "signed"
                ? `Signed and locked: ${workfileResult.workfile.canonical_file_name}`
                : `Database workfile: ${workfileResult.workfile.canonical_file_name}`,
            );
          } catch (workfileError) {
            if (!cancelled) {
              setWorkfileStatusMessage(
                workfileError instanceof Error
                  ? `Workfile could not be loaded: ${workfileError.message}`
                  : "Workfile could not be loaded.",
              );
            }
          }
          void getPropertyContextAssessment(accountId, selectedFile.id)
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
  }, [
    accountId,
    detailLoaded,
    requestedAssignmentFileId,
  ]);

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
  const mobileInspectionSketch = activeAssignmentFile?.mobile_inspection_sketch || null;
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
    return requestEditorCredential("Enter the HomeNode editor key to save verified changes:");
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
        forgetEditorCredential();
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
        forgetEditorCredential();
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
        forgetEditorCredential();
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
    if (accountId && activeAssignmentFile) {
      const editorKey = editorKeyForSave();
      if (editorKey) {
        setWorkfileStatusMessage(`Saving market study to ${activeAssignmentFile.file_number}...`);
        marketWorkfileSaveQueueRef.current = marketWorkfileSaveQueueRef.current
          .catch(() => undefined)
          .then(async () => {
            const response = await saveCustomAppraisalWorkfileSection(
              accountId,
              activeAssignmentFile.id,
              "market_conditions",
              {
                value: draft,
                expected_revision: marketWorkfileRevisionRef.current,
                save_reason: marketWorkfileRevisionRef.current === 0
                  ? "legacy_import"
                  : "manual_save",
                reviewer: "HomeNode market conditions",
              },
              editorKey,
            );
            marketWorkfileRevisionRef.current = response.section.revision;
            setWorkfileStatusMessage(
              `Market study saved to ${activeAssignmentFile.workfile?.canonical_file_name || activeAssignmentFile.file_number}.`,
            );
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            setWorkfileStatusMessage(
              /custom_appraisal_workfile_signed/i.test(message)
                ? "This appraisal is signed and locked. Start another file to change its market study."
                : `Market study save needs attention: ${message}`,
            );
          });
      }
    }
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
    if (fieldKey === "assignment_type") {
      const supportedTypes = new Set([
        "purchase_transaction",
        "refinance",
        "heloc",
        "rtl",
        "rehab",
        "bridge_loan",
        "new_construction",
        "dscr",
      ]);
      if (!supportedTypes.has(value)) {
        setAssignmentSaveMessage("The confirmed assignment type remains attached as page-cited evidence for manual review.");
        return;
      }
      setAssignmentDraft((current) => {
        const types = new Set(current.assignment_types || []);
        types.add(value);
        return {
          ...current,
          assignment_types: Array.from(types),
          subject_under_contract: value === "purchase_transaction"
            ? true
            : current.subject_under_contract,
        };
      });
      setAssignmentDirty(true);
      setAssignmentSaveMessage(
        "Confirmed document evidence prefills the assignment type. Save Assignment Details to retain it.",
      );
      return;
    }
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
    if (!accountId || !geometry || neighborhoodProfileLoading) {
      if (!geometry) {
        setNeighborhoodProfileMessage("Generate or draw a neighborhood boundary before refreshing area data.");
      }
      return;
    }
    const profileAsOf = marketConditionsDraft?.asOfDate || new Date().toISOString().slice(0, 10);
    const profilePeriodMonths = marketConditionsDraft?.periodMonths || 12;
    const profileContextOverride = marketConditionsDraft?.contextOverride || null;
    const profileVersion = marketConditionsDraft?.savedAt || profileAsOf;
    setNeighborhoodProfileLoading(true);
    setNeighborhoodProfileMessage("Refreshing market-area ranges, city averages, and boundary streets...");
    try {
      const profile = await getNeighborhoodProfile({
        subjectAccountId: accountId,
        asOf: profileAsOf,
        periodMonths: profilePeriodMonths,
        customGeometry: geometry,
        contextOverride: profileContextOverride,
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
          neighborhood_boundary_saved_at: marketConditionsDraft?.savedAt || new Date().toISOString(),
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
            cityStudy?.period.end || profileAsOf,
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
      const signature = `${accountId}:${profileVersion}:${JSON.stringify(geometry)}`;
      delete neighborhoodProfileRetryAttempts.current[signature];
    } catch (error) {
      setNeighborhoodProfileMessage(
        error instanceof Error ? error.message : "The neighborhood profile could not be refreshed.",
      );
      const signature = `${accountId}:${profileVersion}:${JSON.stringify(geometry)}`;
      const attempts = Number(neighborhoodProfileRetryAttempts.current[signature] || 0);
      if (attempts < 2) {
        neighborhoodProfileRetryAttempts.current[signature] = attempts + 1;
        if (neighborhoodProfileRetryTimer.current !== null) {
          window.clearTimeout(neighborhoodProfileRetryTimer.current);
        }
        neighborhoodProfileRetryTimer.current = window.setTimeout(() => {
          if (neighborhoodProfileAttemptedSignature.current === signature) {
            neighborhoodProfileAttemptedSignature.current = "";
          }
          neighborhoodProfileRetryTimer.current = null;
          setNeighborhoodProfileRetryNonce((current) => current + 1);
        }, 3_000 * 2 ** attempts);
      }
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
    const geometry = assignmentDraft.neighborhood_boundary_geometry ||
      customMarketStudy?.market.custom_geometry;
    if (!neighborhoodSectionReady || !geometry || !accountId || assignmentFilesLoading || !assignmentFilesLoaded) return;
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
      assignmentDraft.neighborhood_sale_count,
    ].every(hasValue);
    if (profileValuesPresent) return;
    const profileVersion = marketConditionsDraft?.savedAt || new Date().toISOString().slice(0, 10);
    const signature = `${accountId}:${profileVersion}:${JSON.stringify(geometry)}`;
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
    assignmentDraft.neighborhood_sale_count,
    assignmentFilesLoading,
    assignmentFilesLoaded,
    customMarketStudy,
    marketConditionsDraft,
    neighborhoodSectionReady,
    neighborhoodProfileRetryNonce,
    refreshNeighborhoodProfile,
  ]);

  useEffect(() => () => {
    if (neighborhoodProfileRetryTimer.current !== null) {
      window.clearTimeout(neighborhoodProfileRetryTimer.current);
    }
  }, []);

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
        mobile_inspection_sketch: activeAssignmentFile.mobile_inspection_sketch,
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
        forgetEditorCredential();
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
      marketWorkfileRevisionRef.current = 0;
      setMarketConditionsDraft(null);
      setSalesComparisonDraft(null);
      setWorkfileStatusMessage(
        `New database workfile: ${created.workfile?.canonical_file_name || created.file_number}`,
      );
      setAssignmentDirty(false);
      setAssignmentSaveMessage(`New appraisal file ${created.file_number} saved.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The appraisal file could not be created.";
      if (/401|invalid_editor_key/i.test(message)) {
        forgetEditorCredential();
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
    marketWorkfileRevisionRef.current = 0;
    setMarketConditionsDraft(null);
    setSalesComparisonDraft(null);
    setWorkfileStatusMessage("");
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
        mobile_inspection_sketch: activeAssignmentFile.mobile_inspection_sketch,
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
        forgetEditorCredential();
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

  const finalizeCustomAppraisalFile = async () => {
    if (!accountId || !activeAssignmentFile) return;
    const localBlockers = [
      ...assignmentValidationErrors(assignmentDraft),
      ...neighborhoodBoundaryReadinessErrors(assignmentDraft),
      ...(salesComparisonDraft?.comparables?.length
        ? []
        : ["Complete and save the Sales Comparison Approach before finalizing."]),
      ...((Number(salesComparisonDraft?.opinionOfValue) || 0) > 0
        ? []
        : ["Reconcile a positive Sales Comparison Approach value before finalizing."]),
      ...(marketConditionsDraft?.response?.analyses?.length
        ? []
        : ["Complete and save at least one Market Conditions study before finalizing."]),
      ...(assignmentDirty ? ["Save the current Property Report changes before finalizing."] : []),
    ];
    if (localBlockers.length) {
      setAssignmentSaveMessage(`Cannot finalize yet: ${localBlockers.join(" ")}`);
      return;
    }
    const editorKey = editorKeyForSave();
    if (!editorKey) return;
    setSavingAssignmentFile(true);
    try {
      await marketWorkfileSaveQueueRef.current;
      setWorkfileStatusMessage("Running final E&O and source-data readiness checks...");
      const preflight = await getCustomAppraisalWorkfileReadiness(
        accountId,
        activeAssignmentFile.id,
        editorKey,
      );
      if (!preflight.readiness.ready) {
        setAssignmentSaveMessage(
          `Cannot finalize yet: ${preflight.readiness.blocker_messages.join(" ")}`,
        );
        setWorkfileStatusMessage("Final E&O review found required corrections.");
        return;
      }
      const warningCodes = preflight.readiness.warning_codes;
      if (preflight.readiness.warnings.length) {
        const warningAccepted = window.confirm(
          `E&O review found ${preflight.readiness.warnings.length} item${preflight.readiness.warnings.length === 1 ? "" : "s"} requiring appraiser acknowledgment:\n\n${preflight.readiness.warning_messages.join("\n\n")}\n\nContinue only if you reviewed and accept these items for this appraisal file.`,
        );
        if (!warningAccepted) {
          setWorkfileStatusMessage("Finalization paused for source-data review.");
          return;
        }
      }
      const confirmed = window.confirm(
        `Finalize and lock ${activeAssignmentFile.file_number}? This creates the immutable signed snapshot. Future changes must be made in a new appraisal file.`,
      );
      if (!confirmed) return;
      const signedBy = window.prompt(
        "Enter the appraiser name that is signing/finalizing this file:",
        activeAssignmentFile.reviewer || "",
      )?.trim();
      if (!signedBy) return;
      const response = await signCustomAppraisalWorkfile(
        accountId,
        activeAssignmentFile.id,
        {
          signed_by: signedBy,
          acknowledged_warning_codes: warningCodes,
        },
        editorKey,
      );
      const workfile = response.workfile;
      const updatedFile: AppraisalAssignmentFile = {
        ...activeAssignmentFile,
        workfile: {
          key: workfile.workfile_key,
          canonical_file_name: workfile.canonical_file_name,
          status: workfile.status,
          signed_at: workfile.signed_at,
          signed_by: workfile.signed_by,
          updated_at: workfile.updated_at,
        },
      };
      setActiveAssignmentFile(updatedFile);
      setAssignmentFiles((current) => current.map((file) =>
        file.id === updatedFile.id ? updatedFile : file
      ));
      setWorkfileStatusMessage(
        `Signed and locked: ${workfile.canonical_file_name} · SHA-256 ${workfile.checksum_sha256 || "recorded"}`,
      );
      setAssignmentSaveMessage(
        `Finalized ${activeAssignmentFile.file_number}. The signed snapshot is immutable.`,
      );
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "The appraisal file could not be finalized.";
      setAssignmentSaveMessage(
        message === "custom_appraisal_eo_warnings_unacknowledged"
          ? "Finalization stopped because the source-data warnings changed after preflight. Run Finalize & Lock again to review the current warnings."
          : message === "custom_appraisal_eo_incomplete"
            ? "Finalization stopped because a required E&O item changed after preflight. Run Finalize & Lock again to see the current blockers."
            : message,
      );
    } finally {
      setSavingAssignmentFile(false);
    }
  };

  const downloadCustomAppraisalFile = async (file: AppraisalAssignmentFile) => {
    if (!accountId) return;
    const editorKey = editorKeyForSave();
    if (!editorKey) return;
    setWorkfileStatusMessage(`Preparing ${file.workfile?.canonical_file_name || file.file_number}...`);
    try {
      const download = await downloadCustomAppraisalWorkfile(accountId, file.id, editorKey);
      const objectUrl = URL.createObjectURL(download.blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = download.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      setWorkfileStatusMessage(
        `${download.immutable ? "Immutable signed file" : "Current database draft"} downloaded as ${download.fileName}.`,
      );
    } catch (error) {
      setWorkfileStatusMessage(
        error instanceof Error ? error.message : "The appraisal workfile could not be downloaded.",
      );
    }
  };

  const downloadCustomAppraisalPdf = async (file: AppraisalAssignmentFile) => {
    if (!accountId) return;
    const editorKey = editorKeyForSave();
    if (!editorKey) return;
    setWorkfileStatusMessage(`Building ${file.file_number} appraisal PDF...`);
    try {
      const download = await downloadCustomAppraisalReportPdf(accountId, file.id, editorKey);
      const objectUrl = URL.createObjectURL(download.blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = download.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      setWorkfileStatusMessage(
        `${download.immutable ? "Immutable signed" : "Current draft"} appraisal PDF downloaded as ${download.fileName}${download.pageCount ? ` (${download.pageCount} pages)` : ""}.`,
      );
    } catch (error) {
      setWorkfileStatusMessage(
        error instanceof Error ? error.message : "The appraisal PDF could not be generated.",
      );
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
    assignmentFilesLoading || savingAssignmentFile || !assignmentDirty ||
      activeAssignmentFile?.workfile?.status === "signed",
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
        <div className="flex min-h-[52px] flex-col gap-2 sm:flex-row sm:items-end sm:justify-end">
          {activeAssignmentFile ? (
            <span className={`mb-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
              activeAssignmentFile.workfile?.status === "signed"
                ? "bg-amber-100 text-amber-900"
                : "bg-emerald-100 text-emerald-800"
            }`}>
              {activeAssignmentFile.workfile?.status === "signed" ? "Signed file" : "Active file"}{" "}
              {activeAssignmentFile.file_number}
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
        <p
          className="mt-2 min-h-4 break-words text-right text-[11px] font-medium leading-4 text-slate-600"
          aria-live="polite"
        >
          {workfileStatusMessage || "\u00a0"}
        </p>

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
                      {file.workfile?.status === "signed" ? (
                        <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-900">
                          Signed &amp; locked
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
                      {file.workfile?.canonical_file_name ? (
                        <span className="block break-all pt-1 font-mono text-[10px] text-slate-500">
                          {file.workfile.canonical_file_name}
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
                      <button
                        type="button"
                        className="btn btn-sm normal-case"
                        onClick={() => void downloadCustomAppraisalFile(file)}
                      >
                        {file.workfile?.status === "signed" ? "Download Signed File" : "Download Draft"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm normal-case border-slate-900 bg-slate-900 text-white hover:bg-slate-800"
                        onClick={() => void downloadCustomAppraisalPdf(file)}
                      >
                        {file.workfile?.status === "signed" ? "Download Signed PDF" : "Download Draft PDF"}
                      </button>
                      {isActiveFile && file.workfile?.status !== "signed" ? (
                        <button
                          type="button"
                          className="btn btn-sm normal-case"
                          onClick={() => void recordLenderRevisionRequest()}
                          disabled={savingAssignmentFile}
                        >
                          Record Revision Request
                        </button>
                      ) : null}
                      {isActiveFile && file.workfile?.status !== "signed" ? (
                        <button
                          type="button"
                          className="btn btn-sm normal-case border-amber-600 bg-amber-600 text-white hover:bg-amber-700"
                          onClick={() => void finalizeCustomAppraisalFile()}
                          disabled={savingAssignmentFile}
                        >
                          Finalize &amp; Lock
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

      {accountId ? (
        <PreviousAppraisalFiles accountId={accountId} getEditorKey={editorKeyForSave} />
      ) : null}

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

          <AssignmentPhotoCenter
            accountId={accountId || ""}
            assignmentFileId={activeAssignmentFile?.id || null}
            getEditorKey={editorKeyForSave}
            readOnly={activeAssignmentFile?.workfile?.status === "signed"}
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

            {mobileInspectionSketch && activeAssignmentFile && accountId ? (
              <MobileSketchReview
                accountId={accountId}
                assignmentFile={activeAssignmentFile}
                getEditorKey={editorKeyForSave}
                onSaved={(savedSketch) => {
                  const updatedFile = {
                    ...activeAssignmentFile,
                    mobile_inspection_sketch: savedSketch,
                  };
                  setActiveAssignmentFile(updatedFile);
                  setAssignmentFiles((current) => current.map((file) =>
                    file.id === updatedFile.id ? updatedFile : file
                  ));
                }}
              />
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

        <div className="mt-6 grid grid-cols-1 gap-2 border-t border-slate-200 pt-5 sm:grid-cols-2 xl:grid-cols-6">
          <a
            href={
              accountId
                ? `/ComparableSalesAnalysis?propertyId=${encodeURIComponent(accountId)}${
                    activeAssignmentFile
                      ? `&assignmentFileId=${encodeURIComponent(String(activeAssignmentFile.id))}`
                      : ""
                  }`
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
          <a
            href={
              accountId
                ? `/CostApproach?propertyId=${encodeURIComponent(accountId)}${
                    activeAssignmentFile
                      ? `&assignmentFileId=${encodeURIComponent(String(activeAssignmentFile.id))}`
                      : ""
                  }`
                : "#"
            }
            aria-label="Cost Approach"
            aria-disabled={!accountId}
            className={`btn normal-case rounded-md px-4 py-2 ${
              accountId
                ? "border-slate-900 bg-slate-900 text-white hover:border-slate-950 hover:bg-slate-950"
                : "pointer-events-none border-slate-200 bg-slate-200 text-slate-500"
            }`}
          >
            Cost Approach
          </a>
          <a
            href={
              accountId
                ? `/IncomeApproach?propertyId=${encodeURIComponent(accountId)}${
                    activeAssignmentFile
                      ? `&assignmentFileId=${encodeURIComponent(String(activeAssignmentFile.id))}`
                      : ""
                  }`
                : "#"
            }
            aria-label="Income Approach"
            aria-disabled={!accountId}
            className={`btn normal-case rounded-md px-4 py-2 ${
              accountId
                ? "border-slate-900 bg-slate-900 text-white hover:border-slate-950 hover:bg-slate-950"
                : "pointer-events-none border-slate-200 bg-slate-200 text-slate-500"
            }`}
          >
            Income Approach
          </a>
          <a
            href={
              accountId
                ? `/FinalReconciliation?propertyId=${encodeURIComponent(accountId)}${
                    activeAssignmentFile
                      ? `&assignmentFileId=${encodeURIComponent(String(activeAssignmentFile.id))}`
                      : ""
                  }`
                : "#"
            }
            aria-label="Final Reconciliation"
            aria-disabled={!accountId}
            className={`btn normal-case rounded-md px-4 py-2 ${
              accountId
                ? "border-violet-700 bg-violet-700 text-white hover:border-violet-800 hover:bg-violet-800"
                : "pointer-events-none border-slate-200 bg-slate-200 text-slate-500"
            }`}
          >
            Final Reconciliation
          </a>
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
  const requestedAssignmentFileId = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const parsed = Number(params.get("assignmentFileId"));
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }, [location.search]);

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
        <AddressHero
          detail={detail}
          accountId={account}
          requestedAssignmentFileId={requestedAssignmentFileId}
          onReload={importFromDatabase}
        />
      </main>
    </div>
  );
}


