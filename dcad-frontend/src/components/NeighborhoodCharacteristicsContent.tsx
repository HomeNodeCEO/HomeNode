import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getNeighborhoodBoundary,
  generateNeighborhoodBoundary as runNeighborhoodBoundaryGeneration,
  generateNeighborhoodRelevance as runNeighborhoodRelevanceGeneration,
  runNeighborhoodLandUseAnalysis,
  type AssignmentDetailsPayload,
  type NeighborhoodProfileResponse,
  type NeighborhoodBoundaryAssessment,
  type NeighborhoodRelevanceAssessment,
  type NeighborhoodLandUseAnalysisResponse,
} from "@/lib/api";
import type { MarketConditionsDraft } from "@/lib/marketConditionsDraft";
import {
  calculateNeighborhoodRepresentativeness,
  hasSavedNeighborhoodLandUseProfile,
  neighborhoodBoundaryReadinessErrors,
  NEIGHBORHOOD_ALL_PROPERTY_ROWS,
  NEIGHBORHOOD_CITY_AVERAGE_ROWS,
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
import type { MarketAreaOrigin } from "@/lib/marketAreaGeometry";
import {
  applyPocketOverrides,
  recommendPocketSelection,
  summarizePockets,
} from "@/lib/neighborhoodPocketSelection";
import MarketConditionsAnalysis from "@/components/MarketConditionsAnalysis";
import { CheckboxChoice } from "@/components/PropertyReportControls";
import {
  formatDate,
  formatMoney,
  formatNumber,
  parseNumber,
} from "@/lib/propertyReportPresentation";

type AssignmentDetails = AssignmentDetailsPayload;

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


type NeighborhoodRangeRowDefinition = {
  label: string;
  low: keyof AssignmentDetails;
  high: keyof AssignmentDetails;
  predominant: keyof AssignmentDetails;
  format: string;
};

const DISCOVERY_ENVELOPE_METHODOLOGY_VERSION = 6;

function NeighborhoodRangeGrid({
  rows,
  assignment,
}: {
  rows: readonly NeighborhoodRangeRowDefinition[];
  assignment: AssignmentDetails;
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
            const value = parseNumber(assignment[field]);
            const formattedValue = value === null
              ? "Not reported"
              : new Intl.NumberFormat("en-US", {
                  minimumFractionDigits: isPricePerSquareFoot ? 2 : 0,
                  maximumFractionDigits: isPricePerSquareFoot
                    ? 2
                    : row.label === "Age"
                      ? 0
                      : 2,
                }).format(value);
            return (
              <div
                key={field}
                className={`grid min-h-7 min-w-0 items-center rounded-md border border-slate-200 bg-slate-50 px-2 ${isMoney
                    ? `grid-cols-[auto_minmax(0,1fr)${isPricePerSquareFoot ? "_auto" : ""}] gap-1`
                    : "grid-cols-1"
                }`}
              >
                {isMoney ? (
                  <span className={`text-xs font-medium text-slate-600 ${value === null ? "invisible" : ""}`} aria-hidden="true">$</span>
                ) : null}
                <span className="min-w-0 text-right text-xs font-medium tabular-nums text-slate-800">
                  {formattedValue}
                </span>
                {isPricePerSquareFoot ? (
                  <span className={`text-[10px] font-medium text-slate-500 ${value === null ? "invisible" : ""}`}>/SF</span>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
export default function NeighborhoodCharacteristicsContent({
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
  const automaticRelevanceAttemptRef = useRef("");
  const boundaryErrors = neighborhoodBoundaryReadinessErrors(assignmentDraft);
  const boundaryRing = assignmentDraft.neighborhood_boundary_geometry?.coordinates?.[0] || [];
  const removedPocketIds = useMemo(
    () => assignmentDraft.neighborhood_relevance_removed_pocket_ids || [],
    [assignmentDraft.neighborhood_relevance_removed_pocket_ids],
  );
  const addedPocketIds = useMemo(
    () => assignmentDraft.neighborhood_relevance_added_pocket_ids || [],
    [assignmentDraft.neighborhood_relevance_added_pocket_ids],
  );
  const effectiveRelevanceAssessment = useMemo(() => relevanceAssessment
    ? applyPocketOverrides(relevanceAssessment, removedPocketIds, addedPocketIds)
    : null, [
      relevanceAssessment,
      removedPocketIds,
      addedPocketIds,
    ]);
  const pocketRecommendation = useMemo(() => relevanceAssessment
    ? recommendPocketSelection(relevanceAssessment)
    : null, [relevanceAssessment]);
  const recommendedPocketIds = useMemo(
    () => new Set(pocketRecommendation?.recommendedPocketIds || []),
    [pocketRecommendation],
  );
  const relevanceMapVisualization = useMemo(() =>
    (effectiveRelevanceAssessment?.visualization || []).map((candidate) => ({
      ...candidate,
      recommended_population: recommendedPocketIds.has(
        candidate.pocket_id || candidate.cluster_id || "",
      ),
    })), [effectiveRelevanceAssessment, recommendedPocketIds]);
  const recommendationActive = useMemo(() => {
    if (!pocketRecommendation || !effectiveRelevanceAssessment?.visualization) return false;
    const current = new Set(effectiveRelevanceAssessment.visualization
      .filter((candidate) => candidate.primary_population)
      .map((candidate) => candidate.pocket_id || candidate.cluster_id)
      .filter((value): value is string => Boolean(value)));
    return current.size === recommendedPocketIds.size &&
      [...recommendedPocketIds].every((id) => current.has(id));
  }, [effectiveRelevanceAssessment, pocketRecommendation, recommendedPocketIds]);
  const relevancePockets = useMemo(() => summarizePockets(
    effectiveRelevanceAssessment?.visualization || [],
  ), [effectiveRelevanceAssessment]);
  const relevanceLiveSummary = useMemo(() => {
    const statistics = effectiveRelevanceAssessment?.summary.relevant_statistics;
    if (!statistics) return null;
    return {
      reliabilityScore: statistics.reliability_score,
      compositeCod: statistics.composite_cod,
      propertyCount: statistics.included_property_count,
      saleCount: statistics.included_sale_count,
      pocketCount: effectiveRelevanceAssessment?.summary.selected_pocket_count || 0,
    };
  }, [effectiveRelevanceAssessment]);
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
        assignmentFileId,
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
    const useBroadPropertyProfile = Boolean(result.property_profile) &&
      !assignmentDraft.neighborhood_boundary_engine_assessment_id;
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
    if (result.property_profile && useBroadPropertyProfile) {
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
      }. Land-use percentages, ${useBroadPropertyProfile ? "the all-property neighborhood profile, " : ""}${result.built_up_label} built-up, location type, and highest-and-best-use screening were populated automatically.${result.property_profile && !useBroadPropertyProfile ? " The profile and sales ranges remain tied to the selected relevance pockets." : ""}`,
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
    onAssignmentChange(
      "neighborhood_boundary_label",
      `${result.discovery_radius_miles}-mile analytical discovery envelope`,
    );
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
    onAssignmentChange("neighborhood_relevance_removed_pocket_ids", []);
    onAssignmentChange("neighborhood_relevance_added_pocket_ids", []);
    onAssignmentChange("neighborhood_relevance_override_updated_at", "");
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

  const generateSuggestedBoundary = async (discoveryRadiusMiles?: number) => {
    if (!accountId || generatedBoundaryLoading) return;
    setGeneratedBoundaryLoading(true);
    setGeneratedBoundaryMessage("Generating a broad neighborhood from saved parcel, road, and zoning data...");
    try {
      const result = await runNeighborhoodBoundaryGeneration(accountId, {
        assignmentFileId: assignmentFileId || null,
        discoveryRadiusMiles: discoveryRadiusMiles || null,
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
        // Methodology v6 separates the simple-suburban three-mile analytical
        // envelope from the appraiser's narrative road boundary.
        const needsDiscoveryEnvelopeUpgrade = Boolean(result) &&
          Number(result?.methodology_version || 0) < DISCOVERY_ENVELOPE_METHODOLOGY_VERSION;
        if (needsDiscoveryEnvelopeUpgrade && !appraiserCleared) {
          result = await runNeighborhoodBoundaryGeneration(accountId, {
            assignmentFileId: assignmentFileId || null,
          });
        }
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
          overwriteGeometry: !appraiserAreaPresent && !appraiserCleared,
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
    setGeneratedBoundaryMessage(
      origin === "cleared"
        ? "The narrative boundary was cleared. The saved analytical discovery envelope and relevance pockets remain available for review."
        : "Appraiser narrative boundary recorded. The three-mile analytical discovery population remains intact; Refresh Area Data recalculates the descriptive area fields for the edited polygon.",
    );
  }, [
    applyGeneratedBoundary,
    generatedBoundary,
    onAssignmentChange,
  ]);

  const applyRelevantStatistics = useCallback((
    assessment: NeighborhoodRelevanceAssessment,
  ) => {
    const relevant = assessment.summary.relevant_statistics;
    const sales = relevant?.sales_profile;
    const properties = relevant?.property_profile;
    if (!relevant || !sales || !properties) return;
    onAssignmentChange("neighborhood_sale_count", relevant.included_sale_count);
    onAssignmentChange("neighborhood_all_property_count", relevant.included_property_count);
    onAssignmentChange("neighborhood_house_price_low", sales.sale_price?.low ?? "");
    onAssignmentChange("neighborhood_house_price_high", sales.sale_price?.high ?? "");
    onAssignmentChange("neighborhood_house_price_predominant", sales.sale_price?.median ?? "");
    onAssignmentChange("neighborhood_ppsf_low", sales.price_per_square_foot?.low ?? "");
    onAssignmentChange("neighborhood_ppsf_high", sales.price_per_square_foot?.high ?? "");
    onAssignmentChange("neighborhood_ppsf_predominant", sales.price_per_square_foot?.median ?? "");
    onAssignmentChange("neighborhood_age_low", sales.age?.low ?? "");
    onAssignmentChange("neighborhood_age_high", sales.age?.high ?? "");
    onAssignmentChange("neighborhood_age_predominant", sales.age?.median ?? "");
    onAssignmentChange("neighborhood_gla_low", sales.gla?.low ?? "");
    onAssignmentChange("neighborhood_gla_high", sales.gla?.high ?? "");
    onAssignmentChange("neighborhood_gla_predominant", sales.gla?.median ?? "");
    onAssignmentChange("neighborhood_all_house_price_low", properties.market_value?.low ?? "");
    onAssignmentChange("neighborhood_all_house_price_high", properties.market_value?.high ?? "");
    onAssignmentChange(
      "neighborhood_all_house_price_predominant",
      properties.market_value?.median ?? "",
    );
    onAssignmentChange(
      "neighborhood_all_ppsf_low",
      properties.value_per_square_foot?.low ?? "",
    );
    onAssignmentChange(
      "neighborhood_all_ppsf_high",
      properties.value_per_square_foot?.high ?? "",
    );
    onAssignmentChange(
      "neighborhood_all_ppsf_predominant",
      properties.value_per_square_foot?.median ?? "",
    );
    onAssignmentChange("neighborhood_all_age_low", properties.age?.low ?? "");
    onAssignmentChange("neighborhood_all_age_high", properties.age?.high ?? "");
    onAssignmentChange("neighborhood_all_age_predominant", properties.age?.median ?? "");
    onAssignmentChange("neighborhood_all_gla_low", properties.gla?.low ?? "");
    onAssignmentChange("neighborhood_all_gla_high", properties.gla?.high ?? "");
    onAssignmentChange("neighborhood_all_gla_predominant", properties.gla?.median ?? "");
    onAssignmentChange("neighborhood_all_value_count", properties.market_value?.count ?? 0);
    onAssignmentChange(
      "neighborhood_all_ppsf_count",
      properties.value_per_square_foot?.count ?? 0,
    );
    onAssignmentChange("neighborhood_all_age_count", properties.age?.count ?? 0);
    onAssignmentChange("neighborhood_all_gla_count", properties.gla?.count ?? 0);
  }, [onAssignmentChange]);

  const analyzeRelevantPropertyDataset = useCallback(async () => {
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
    setRelevanceMessage("Scoring parcels with GLA, age, and housing type as the primary subject-similarity factors...");
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
      const effectiveResult = applyPocketOverrides(
        result,
        assignmentDraft.neighborhood_relevance_removed_pocket_ids || [],
        assignmentDraft.neighborhood_relevance_added_pocket_ids || [],
      );
      applyRelevantStatistics(effectiveResult);
      setRelevanceAssessment(result);
      const primaryCount = effectiveResult.summary.relevant_statistics?.included_property_count ??
        result.summary.included_count;
      setRelevanceMessage(
        `${primaryCount.toLocaleString()} properties across every system-selected relevant pocket form the primary statistical population. All available sales in those pockets are included; ${result.summary.included_count.toLocaleString()} properties remain reviewable on the map.`,
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
  }, [
    accountId,
    assignmentDraft.neighborhood_boundary_engine_assessment_id,
    assignmentDraft.neighborhood_boundary_engine_assignment_file_id,
    assignmentDraft.neighborhood_relevance_added_pocket_ids,
    assignmentDraft.neighborhood_relevance_removed_pocket_ids,
    applyRelevantStatistics,
    onAssignmentChange,
    relevanceLoading,
  ]);

  const setPocketIncluded = useCallback((
    pocketId: string,
    include: boolean,
    systemSelected: boolean,
  ) => {
    if (!relevanceAssessment) return;
    const removed = new Set(assignmentDraft.neighborhood_relevance_removed_pocket_ids || []);
    const added = new Set(assignmentDraft.neighborhood_relevance_added_pocket_ids || []);
    if (include) {
      removed.delete(pocketId);
      if (systemSelected) added.delete(pocketId);
      else added.add(pocketId);
    } else {
      added.delete(pocketId);
      if (systemSelected) removed.add(pocketId);
      else removed.delete(pocketId);
    }
    const nextRemoved = [...removed].sort();
    const nextAdded = [...added].sort();
    onAssignmentChange("neighborhood_relevance_removed_pocket_ids", nextRemoved);
    onAssignmentChange("neighborhood_relevance_added_pocket_ids", nextAdded);
    onAssignmentChange("neighborhood_relevance_override_updated_at", new Date().toISOString());
    const effective = applyPocketOverrides(relevanceAssessment, nextRemoved, nextAdded);
    applyRelevantStatistics(effective);
    const relevant = effective.summary.relevant_statistics;
    setRelevanceMessage(
      `${include ? "Included" : "Removed"} the selected analytical pocket. ` +
      `${relevant?.included_property_count.toLocaleString() || 0} properties and ` +
      `${relevant?.included_sale_count.toLocaleString() || 0} available sales now support the neighborhood statistics.`,
    );
  }, [
    applyRelevantStatistics,
    assignmentDraft.neighborhood_relevance_added_pocket_ids,
    assignmentDraft.neighborhood_relevance_removed_pocket_ids,
    onAssignmentChange,
    relevanceAssessment,
  ]);

  const resetPocketOverrides = useCallback(() => {
    if (!relevanceAssessment) return;
    onAssignmentChange("neighborhood_relevance_removed_pocket_ids", []);
    onAssignmentChange("neighborhood_relevance_added_pocket_ids", []);
    onAssignmentChange("neighborhood_relevance_override_updated_at", new Date().toISOString());
    applyRelevantStatistics(relevanceAssessment);
    setRelevanceMessage(
      "Appraiser pocket changes were reset. Every system-selected relevant pocket is included again.",
    );
  }, [applyRelevantStatistics, onAssignmentChange, relevanceAssessment]);

  const applyRecommendedPocketSelection = useCallback(() => {
    if (!relevanceAssessment || !pocketRecommendation) return;
    const removed = pocketRecommendation.removedSystemPocketIds;
    onAssignmentChange("neighborhood_relevance_removed_pocket_ids", removed);
    onAssignmentChange("neighborhood_relevance_added_pocket_ids", []);
    onAssignmentChange("neighborhood_relevance_override_updated_at", new Date().toISOString());
    const recommended = applyPocketOverrides(relevanceAssessment, removed, []);
    applyRelevantStatistics(recommended);
    const statistics = recommended.summary.relevant_statistics;
    setRelevanceMessage(
      `Applied HomeNode's recommended analytical area: ` +
      `${pocketRecommendation.recommendedPocketCount.toLocaleString()} pockets, ` +
      `${statistics?.included_property_count.toLocaleString() || 0} properties, and ` +
      `${statistics?.included_sale_count.toLocaleString() || 0} available sales. ` +
      "The rough narrative boundary remains available for appraiser editing.",
    );
  }, [
    applyRelevantStatistics,
    onAssignmentChange,
    pocketRecommendation,
    relevanceAssessment,
  ]);

  useEffect(() => {
    const boundaryAssessmentId = Number(
      assignmentDraft.neighborhood_boundary_engine_assessment_id,
    );
    if (!accountId || !Number.isSafeInteger(boundaryAssessmentId) || boundaryAssessmentId <= 0) {
      return;
    }
    const signature = `${accountId}:${assignmentFileId || "property"}:${boundaryAssessmentId}`;
    if (automaticRelevanceAttemptRef.current === signature || relevanceLoading) return;
    automaticRelevanceAttemptRef.current = signature;
    void analyzeRelevantPropertyDataset();
  }, [
    accountId,
    assignmentFileId,
    assignmentDraft.neighborhood_boundary_engine_assessment_id,
    analyzeRelevantPropertyDataset,
    relevanceLoading,
  ]);

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
            <p className="mt-0.5 text-xs text-slate-500">Loads automatically from the appraiser-defined area; use the button to refresh the parcel analysis.</p>
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
          </div>
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
              />
              <p className="mt-2 text-[10px] leading-4 text-slate-500">
                Selected-pocket coverage — value: {formatNumber(assignmentDraft.neighborhood_all_value_count)}; $/SF: {formatNumber(assignmentDraft.neighborhood_all_ppsf_count)}; age: {formatNumber(assignmentDraft.neighborhood_all_age_count)}; GLA: {formatNumber(assignmentDraft.neighborhood_all_gla_count)}. Updates automatically when a relevance pocket is added or removed.
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
            <h3 className="text-sm font-semibold text-slate-900">Neighborhood Study Area &amp; Boundaries</h3>
            <p className="mt-0.5 text-xs text-slate-600">
              {assignmentDraft.neighborhood_boundary_geometry
                ? `${assignmentDraft.neighborhood_boundary_label || "Appraiser-defined market area"} · ${Math.max(boundaryRing.length - 1, 0)} boundary vertices`
                : "The automatic neighborhood suggestion is loading; manual drawing remains available if needed."}
            </p>
            <p className="mt-0.5 max-w-3xl text-[10px] leading-4 text-slate-500">
              The analytical envelope finds and scores the complete available parcel and sales population. The appraiser may separately redraw the broad narrative boundary without discarding the analytical pockets.
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
            {generatedBoundary?.search_profile === "suburban_simple" ? (
              <button
                type="button"
                className="btn btn-outline btn-sm normal-case rounded-lg"
                onClick={() => void generateSuggestedBoundary(
                  generatedBoundary.discovery_radius_miles > 3 ? 3 : 5,
                )}
                disabled={!accountId || generatedBoundaryLoading}
              >
                {generatedBoundary.discovery_radius_miles > 3
                  ? "Restore 3-Mile Discovery"
                  : "Expand Discovery to 5 Miles"}
              </button>
            ) : null}
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
            {effectiveRelevanceAssessment ? (
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                <span>Confidence: <strong className="capitalize">{effectiveRelevanceAssessment.confidence.confidence || "limited"}</strong></span>
                <span>Low-score exclusions: <strong>{effectiveRelevanceAssessment.summary.low_relevance_excluded_count}</strong></span>
                <span>Dissimilar-pocket exclusions: <strong>{effectiveRelevanceAssessment.summary.dissimilar_pocket_excluded_count}</strong></span>
                {effectiveRelevanceAssessment.summary.relevant_statistics ? (
                  <>
                    <span>Relevant pockets: <strong>{effectiveRelevanceAssessment.summary.selected_pocket_count}</strong></span>
                    <span>Relevant properties: <strong>{effectiveRelevanceAssessment.summary.relevant_statistics.included_property_count}</strong></span>
                    <span>All available pocket sales: <strong>{effectiveRelevanceAssessment.summary.relevant_statistics.included_sale_count}</strong></span>
                    <span>Fixed relevance floor: <strong>{effectiveRelevanceAssessment.summary.primary_population_threshold}%</strong></span>
                    <span>Composite COD: <strong>{effectiveRelevanceAssessment.summary.relevant_statistics.composite_cod ?? "Pending"}</strong></span>
                    <span>Reliability: <strong>{effectiveRelevanceAssessment.summary.relevant_statistics.reliability_score}/100</strong></span>
                  </>
                ) : null}
                <span>Sale prices time-adjusted: <strong>No</strong></span>
              </div>
            ) : null}
          </div>
        ) : null}
        {pocketRecommendation && pocketRecommendation.baselinePocketCount > 0 ? (
          <div className="mt-2 rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-2.5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="max-w-4xl">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-cyan-950">
                    HomeNode Recommended Analytical Area
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    recommendationActive
                      ? "bg-emerald-100 text-emerald-900"
                      : "bg-cyan-100 text-cyan-900"
                  }`}>
                    {recommendationActive ? "Recommendation active" : "Ready for review"}
                  </span>
                </div>
                <p className="mt-1 text-[11px] leading-4 text-cyan-950">
                  {pocketRecommendation.rationale}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-cyan-900">
                  <span>Recommended pockets: <strong>{pocketRecommendation.recommendedPocketCount}</strong></span>
                  <span>Reliability: <strong>{pocketRecommendation.recommendedReliabilityScore}/100</strong></span>
                  <span>Change: <strong>{pocketRecommendation.reliabilityGain >= 0 ? "+" : ""}{pocketRecommendation.reliabilityGain}</strong></span>
                  <span>Average similarity: <strong>{pocketRecommendation.averageSimilarityScore ?? "Pending"}%</strong></span>
                  <span>Property coverage: <strong>{pocketRecommendation.propertyCoveragePercent}%</strong></span>
                  <span>Sale coverage: <strong>{pocketRecommendation.saleCoveragePercent}%</strong></span>
                </div>
              </div>
              <button
                type="button"
                className="hn-action-primary btn btn-sm normal-case rounded-lg text-white disabled:opacity-70"
                onClick={applyRecommendedPocketSelection}
                disabled={recommendationActive}
              >
                {recommendationActive ? "Recommended Area Applied" : "Use Recommended Area"}
              </button>
            </div>
          </div>
        ) : null}
        {relevancePockets.length ? (
          <details className="mt-2 rounded-lg border border-slate-200 bg-white" open>
            <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-800">
              Review analytical pockets ({relevancePockets.filter((pocket) => pocket.currentlyIncluded).length} included of {relevancePockets.length})
            </summary>
            <div className="border-t border-slate-200 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="max-w-3xl text-[11px] leading-4 text-slate-600">
                  The engine includes every property and every available closed sale in the selected relevant pockets. Remove or add a pocket to recalculate the displayed medians, COD, and reliability immediately; the choice is saved with this appraisal file.
                </p>
                {(removedPocketIds.length || addedPocketIds.length) ? (
                  <button
                    type="button"
                    className="btn btn-outline btn-xs normal-case"
                    onClick={resetPocketOverrides}
                  >
                    Reset Pocket Changes
                  </button>
                ) : null}
              </div>
              <div className="mt-2 grid max-h-56 gap-2 overflow-y-auto pr-1 md:grid-cols-2 xl:grid-cols-3">
                {relevancePockets.map((pocket, index) => (
                  <div
                    key={pocket.id}
                    className={`rounded-lg border px-2.5 py-2 ${pocket.currentlyIncluded
                      ? "border-emerald-200 bg-emerald-50"
                      : "border-slate-200 bg-slate-50"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-xs font-semibold text-slate-900">
                          Pocket {index + 1}
                          {pocket.containsSubjectSubdivision ? " · Subject subdivision" : ""}
                          {recommendedPocketIds.has(pocket.id) ? " · Recommended" : ""}
                        </div>
                        <div className="mt-0.5 text-[10px] text-slate-600">
                          {pocket.propertyCount.toLocaleString()} properties · {pocket.saleCount.toLocaleString()} sales · {pocket.averageScore ?? "—"}% avg. relevance
                        </div>
                      </div>
                      <button
                        type="button"
                        className={`btn btn-xs normal-case rounded-lg ${pocket.currentlyIncluded
                          ? "btn-outline"
                          : "btn-neutral text-white"
                        }`}
                        onClick={() => setPocketIncluded(
                          pocket.id,
                          !pocket.currentlyIncluded,
                          pocket.systemSelected,
                        )}
                      >
                        {pocket.currentlyIncluded ? "Remove Pocket" : "Add Pocket"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </details>
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
            key={`property-report-market-conditions-${accountId}-${assignmentFileId || "unfiled"}`}
            subjectAccountId={accountId}
            assignmentFileId={assignmentFileId}
            initialDraft={marketConditionsDraft}
            onCompletionChange={onMarketConditionsChange}
            initialCustomGeometry={assignmentDraft.neighborhood_boundary_geometry}
            initialCustomGeometrySource={assignmentDraft.neighborhood_boundary_source}
            suggestedCustomGeometry={generatedBoundary?.boundary || null}
            relevanceVisualization={relevanceMapVisualization}
            relevanceSummary={relevanceLiveSummary}
            onRelevancePocketToggle={setPocketIncluded}
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
