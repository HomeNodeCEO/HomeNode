import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  getNeighborhoodProfile,
  type AssignmentDetailsPayload,
  type MarketConditionsResponse,
  type NeighborhoodProfileResponse,
} from "@/lib/api";
import type { MarketConditionsDraft } from "@/lib/marketConditionsDraft";
import {
  DEFAULT_NEIGHBORHOOD_BOUNDARY_NARRATIVE,
  marketTrendFromChange,
} from "@/lib/neighborhoodCharacteristics";
import { retainCurrentDraftWhenUnchanged } from "@/lib/customAppraisalAutosave";
import { cloneEditorValue } from "@/lib/propertyReportAssignment";
import { hasValue } from "@/lib/propertyReportPresentation";

type MarketStudy = MarketConditionsResponse["analyses"][number];
type BoundarySuggestions = NonNullable<
  NeighborhoodProfileResponse["boundary_streets"]
>["cardinal_boundaries"] | null;

type UseNeighborhoodProfileOptions = {
  accountId?: string;
  assignmentFileId?: number | null;
  assignmentDraft: AssignmentDetailsPayload;
  setAssignmentDraft: Dispatch<SetStateAction<AssignmentDetailsPayload>>;
  customMarketStudy: MarketStudy | null;
  marketConditionsDraft: MarketConditionsDraft | null;
  detailCity?: string | null;
  sectionReady: boolean;
  assignmentFilesLoading: boolean;
  assignmentFilesLoaded: boolean;
};

function profileSignature(
  accountId: string | undefined,
  assignmentFileId: number | null | undefined,
  geometry: unknown,
  draft: MarketConditionsDraft | null,
): string {
  return JSON.stringify([
    accountId || "", assignmentFileId || null, geometry || null,
    draft?.asOfDate || new Date().toISOString().slice(0, 10),
    draft?.periodMonths || 12, draft?.contextOverride || null, draft?.savedAt || "",
  ]);
}

function profileGeometry(draft: AssignmentDetailsPayload, study: MarketStudy | null) {
  if (String(draft.neighborhood_boundary_source || "").toLowerCase().includes("cleared")) return null;
  return draft.neighborhood_boundary_geometry || study?.market.custom_geometry || null;
}

function hasPocketStatistics(draft: AssignmentDetailsPayload): boolean {
  return Boolean(
    draft.neighborhood_boundary_engine_assessment_id ||
    draft.neighborhood_relevance_assessment_id ||
    draft.neighborhood_relevance_generated_at ||
    draft.neighborhood_relevance_override_updated_at ||
    draft.neighborhood_relevance_removed_pocket_ids?.length ||
    draft.neighborhood_relevance_added_pocket_ids?.length,
  );
}

export function useNeighborhoodProfile({
  accountId,
  assignmentFileId,
  assignmentDraft,
  setAssignmentDraft,
  customMarketStudy,
  marketConditionsDraft,
  detailCity,
  sectionReady,
  assignmentFilesLoading,
  assignmentFilesLoaded,
}: UseNeighborhoodProfileOptions) {
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileMessage, setProfileMessage] = useState("");
  const [retryNonce, setRetryNonce] = useState(0);
  const [boundarySuggestions, setBoundarySuggestions] = useState<BoundarySuggestions>(null);
  const attemptedSignature = useRef("");
  const retryTimer = useRef<number | null>(null);
  const retryAttempts = useRef<Record<string, number>>({});
  const requestGeneration = useRef(0);
  const loadingRef = useRef(false);
  const effectiveGeometry = profileGeometry(assignmentDraft, customMarketStudy);
  const inputSignature = profileSignature(accountId, assignmentFileId, effectiveGeometry, marketConditionsDraft);
  // Check render-current context as well as effect cleanup: a request can finish
  // after a file/period change but before the old effect has been cleaned up.
  const latestContextRef = useRef({ signature: inputSignature, draft: assignmentDraft });
  latestContextRef.current = { signature: inputSignature, draft: assignmentDraft };

  const resetProfileTracking = useCallback(() => {
    attemptedSignature.current = "";
    retryAttempts.current = {};
    requestGeneration.current += 1;
    loadingRef.current = false;
    setProfileLoading(false);
    setProfileMessage("");
    setBoundarySuggestions(null);
    if (retryTimer.current !== null) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  }, []);

  useEffect(() => resetProfileTracking(), [accountId, assignmentFileId, resetProfileTracking]);

  useEffect(() => {
    requestGeneration.current += 1;
    loadingRef.current = false;
    attemptedSignature.current = "";
    setProfileLoading(false);
    setProfileMessage("");
    setBoundarySuggestions(null);
    if (retryTimer.current !== null) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  }, [inputSignature]);

  const refreshProfile = useCallback(async (force = false) => {
    const geometry = effectiveGeometry;
    if (!accountId || !assignmentFileId || !geometry || loadingRef.current) {
      if (!geometry) {
        setProfileMessage("Generate or draw a neighborhood boundary before refreshing area data.");
      }
      return;
    }
    const profileAsOf = marketConditionsDraft?.asOfDate || new Date().toISOString().slice(0, 10);
    const profilePeriodMonths = marketConditionsDraft?.periodMonths || 12;
    const profileContextOverride = marketConditionsDraft?.contextOverride || null;
    const signature = inputSignature;
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    const isCurrentRequest = () => requestGeneration.current === generation &&
      latestContextRef.current.signature === signature;
    loadingRef.current = true;
    setProfileLoading(true);
    setProfileMessage("Refreshing market-area ranges, city averages, and boundary streets...");
    try {
      const profile = await getNeighborhoodProfile(
        {
          subjectAccountId: accountId,
          assignmentFileId,
          asOf: profileAsOf,
          periodMonths: profilePeriodMonths,
          customGeometry: geometry,
          contextOverride: profileContextOverride,
        },
        { force },
      );
      if (!isCurrentRequest()) return;
      const customStudy = profile.analyses.find((analysis) => analysis.market.key === "custom");
      const cityStudy = profile.analyses.find((analysis) => analysis.market.key === "city");
      if (!customStudy) throw new Error("The appraiser-defined area did not return a usable market study.");
      const summary = customStudy.summary;
      const boundaryStreets = profile.boundary_streets;
      setBoundarySuggestions(boundaryStreets?.cardinal_boundaries || null);
      setAssignmentDraft((current) => {
        if (!isCurrentRequest() || JSON.stringify(profileGeometry(current, customMarketStudy)) !== JSON.stringify(geometry)) {
          return current;
        }
        const preservePocketStatistics = hasPocketStatistics(current);
        const canFillNarrative = !current.neighborhood_boundary_confirmed;
        const suggested = boundaryStreets?.cardinal_boundaries;
        const north = current.neighborhood_boundary_north || (canFillNarrative ? suggested?.north?.primary_street || "" : "");
        const east = current.neighborhood_boundary_east || (canFillNarrative ? suggested?.east?.primary_street || "" : "");
        const south = current.neighborhood_boundary_south || (canFillNarrative ? suggested?.south?.primary_street || "" : "");
        const west = current.neighborhood_boundary_west || (canFillNarrative ? suggested?.west?.primary_street || "" : "");
        const boundarySummary = [["North", north], ["East", east], ["South", south], ["West", west]]
          .filter(([, street]) => street)
          .map(([side, street]) => `${side}: ${street}`)
          .join("; ");
        const updated = {
          ...current,
          // Only an empty, uncleared file may adopt its saved market area.
          // Refreshing never changes an existing appraiser boundary's identity.
          ...(current.neighborhood_boundary_geometry ? {} : {
            neighborhood_boundary_geometry: cloneEditorValue(geometry),
            neighborhood_boundary_label: customStudy.market.label || "Appraiser-defined market area",
            neighborhood_boundary_source: "sales_comparison_market_conditions",
            neighborhood_boundary_saved_at: marketConditionsDraft?.savedAt || new Date().toISOString(),
            neighborhood_boundary_confirmed: false,
            neighborhood_boundary_confirmed_at: "",
          }),
          // Broad-area sales are not the selected-pocket statistical population.
          // Recheck inside the update so a selection made during loading wins.
          ...(preservePocketStatistics ? {} : {
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
            neighborhood_market_trend: marketTrendFromChange(customStudy.statistics.annualized_change_percent) || current.neighborhood_market_trend || "",
          }),
          neighborhood_city_name: cityStudy?.market.city || profile.subject.city || detailCity || current.neighborhood_city_name || "",
          neighborhood_city_sale_count: cityStudy?.population.eligible_sale_count ?? "",
          neighborhood_city_average_sale_price: cityStudy?.summary.average_sale_price ?? "",
          neighborhood_city_average_ppsf: cityStudy?.summary.average_price_per_square_foot ?? "",
          neighborhood_city_average_age: cityStudy?.summary.average_age ?? "",
          neighborhood_city_average_gla: cityStudy?.summary.average_living_area ?? "",
          neighborhood_city_comparison_as_of: cityStudy?.period.end || profileAsOf,
          neighborhood_boundary_streets: current.neighborhood_boundary_streets || (canFillNarrative ? boundarySummary : ""),
          neighborhood_boundary_north: north,
          neighborhood_boundary_east: east,
          neighborhood_boundary_south: south,
          neighborhood_boundary_west: west,
          neighborhood_boundary_exclusions: current.neighborhood_boundary_exclusions || (canFillNarrative ? DEFAULT_NEIGHBORHOOD_BOUNDARY_NARRATIVE : ""),
          neighborhood_boundary_streets_source: current.neighborhood_boundary_streets_source || (canFillNarrative ? boundaryStreets?.source || "" : ""),
          neighborhood_boundary_streets_retrieved_at: current.neighborhood_boundary_streets_retrieved_at || (canFillNarrative ? boundaryStreets?.retrieved_at || "" : ""),
        };
        return retainCurrentDraftWhenUnchanged(current, updated);
      });
      setProfileMessage(hasPocketStatistics(latestContextRef.current.draft)
        ? "City comparisons refreshed. Your boundary and selected-pocket statistics were preserved." +
          (profile.boundary_street_warning ? " Boundary street suggestions remain unavailable and require review." : " Available missing boundary suggestions were filled for review.")
        : profile.boundary_street_warning
          ? "Market ranges and city averages refreshed. Boundary streets could not be refreshed and still require review."
          : "Appraiser-defined ranges, city averages, and four-side boundary suggestions refreshed.");
      delete retryAttempts.current[signature];
    } catch (error) {
      if (!isCurrentRequest()) return;
      setProfileMessage(error instanceof Error ? error.message : "The neighborhood profile could not be refreshed.");
      const attempts = Number(retryAttempts.current[signature] || 0);
      if (attempts < 2) {
        retryAttempts.current[signature] = attempts + 1;
        if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
        retryTimer.current = window.setTimeout(() => {
          if (!isCurrentRequest()) return;
          if (attemptedSignature.current === signature) attemptedSignature.current = "";
          retryTimer.current = null;
          setRetryNonce((current) => current + 1);
        }, 3_000 * 2 ** attempts);
      }
    } finally {
      if (isCurrentRequest()) {
        loadingRef.current = false;
        setProfileLoading(false);
      }
    }
  }, [accountId, assignmentFileId, customMarketStudy, detailCity, effectiveGeometry, inputSignature, marketConditionsDraft, setAssignmentDraft]);

  useEffect(() => {
    const geometry = effectiveGeometry;
    if (!sectionReady || !geometry || !accountId || !assignmentFileId || assignmentFilesLoading || !assignmentFilesLoaded) return;
    const structuredBoundariesPresent = [assignmentDraft.neighborhood_boundary_north, assignmentDraft.neighborhood_boundary_east, assignmentDraft.neighborhood_boundary_south, assignmentDraft.neighborhood_boundary_west]
      .every((value) => String(value || "").trim());
    const profileValuesPresent = structuredBoundariesPresent && [assignmentDraft.neighborhood_ppsf_predominant, assignmentDraft.neighborhood_age_predominant, assignmentDraft.neighborhood_gla_predominant, assignmentDraft.neighborhood_city_average_sale_price, assignmentDraft.neighborhood_sale_count]
      .every(hasValue);
    if (profileValuesPresent) return;
    const signature = inputSignature;
    if (attemptedSignature.current === signature) return;
    attemptedSignature.current = signature;
    void refreshProfile(false);
  }, [accountId, assignmentDraft.neighborhood_age_predominant, assignmentDraft.neighborhood_boundary_east, assignmentDraft.neighborhood_boundary_north, assignmentDraft.neighborhood_boundary_south, assignmentDraft.neighborhood_boundary_west, assignmentDraft.neighborhood_city_average_sale_price, assignmentDraft.neighborhood_gla_predominant, assignmentDraft.neighborhood_ppsf_predominant, assignmentDraft.neighborhood_sale_count, assignmentFileId, assignmentFilesLoaded, assignmentFilesLoading, effectiveGeometry, inputSignature, refreshProfile, retryNonce, sectionReady]);

  useEffect(() => () => {
    requestGeneration.current += 1;
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
  }, []);

  return {
    profileLoading,
    profileMessage,
    boundarySuggestions,
    setBoundarySuggestions,
    refreshProfile: () => refreshProfile(true),
    resetProfileTracking,
  };
}
