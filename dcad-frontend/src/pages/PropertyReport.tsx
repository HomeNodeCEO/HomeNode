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
    neighborhood_ppsf_high: value?.neighborhood_￿Ϻۋh�鬶��q�^￿�and Use to populate a provisional conclusion, then edit as needed."
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
