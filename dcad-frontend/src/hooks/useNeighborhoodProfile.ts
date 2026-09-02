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
  assignmentDraft: AssignmentDetailsPayload;
  setAssignmentDraft: Dispatch<SetStateAction<AssignmentDetailsPayload>>;
  customMarketStudy: MarketStudy | null;
  marketConditionsDraft: MarketConditionsDraft | null;
  detailCity?: string | null;
  sectionReady: boolean;
  assignmentFilesLoading: boolean;
  assignmentFilesLoaded: boolean;
};

function profileSignature(accountId: string, version: string, geometry: unknown): string {
  return `${accountId}:${version}:${JSON.stringify(geometry)}`;
}

export function useNeighborhoodProfile({
  accountId,
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
  const effectiveGeometry = assignmentDraft.neighborhood_boundary_geometry ||
    customMarketStudy?.market.custom_geometry;
  const effectiveProfileVersion = marketConditionsDraft?.savedAt ||
    marketConditionsDraft?.asOfDate || "";
  const inputSignature = `${accountId || ""}:${effectiveProfileVersion}:${JSON.stringify(effectiveGeometry || null)}`;

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

  useEffect(() => resetProfileTracking(), [accountId, resetProfileTracking]);

  useEffect(() => {
    requestGeneration.current += 1;
    loadingRef.current = false;
    attemptedSignature.current = "";
    setProfileLoading(false);
    if (retryTimer.current !== null) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  }, [inputSignature]);

  const refreshProfile = useCallback(async (force = false) => {
    const geometry = assignmentDraft.neighborhood_boundary_geometry ||
      customMarketStudy?.market.custom_geometry;
    if (!accountId || !geometry || loadingRef.current) {
      if (!geometry) {
        setProfileMessage("Generate or draw a neighborhood boundary before refreshing area data.");
      }
      return;
    }
    const profileAsOf = marketConditionsDraft?.asOfDate || new Date().toISOString().slice(0, 10);
    const profilePeriodMonths = marketConditionsDraft?.periodMonths || 12;
    const profileContextOverride = marketConditionsDraft?.contextOverride || null;
    const profileVersion = marketConditionsDraft?.savedAt || profileAsOf;
    const signature = profileSignature(accountId, profileVersion, geometry);
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    loadingRef.current = true;
    setProfileLoading(true);
    setProfileMessage("Refreshing market-area ranges, city averages, and boundary streets...");
    try {
      const profile = await getNeighborhoodProfile(
        {
          subjectAccountId: accountId,
          asOf: profileAsOf,
          periodMonths: profilePeriodMonths,
          customGeometry: geometry,
          contextOverride: profileContextOverride,
        },
        { force },
      );
      if (requestGeneration.current !== generation) return;
      const customStudy = profile.analyses.find((analysis) => analysis.market.key === "custom");
      const cityStudy = profile.analyses.find((analysis) => analysis.market.key === "city");
      if (!customStudy) throw new Error("The appraiser-defined area did not return a usable market study.");
      const summary = customStudy.summary;
      const boundaryStreets = profile.boundary_streets;
      setBoundarySuggestions(boundaryStreets?.cardinal_boundaries || null);
      setAssignmentDraft((current) => {
        const geometryChanged = JSON.stringify(current.neighborhood_boundary_geometry) !== JSON.stringify(geometry);
        const suggested = boundaryStreets?.cardinal_boundaries;
        const north = geometryChanged ? suggested?.north?.primary_street || "" : current.neighborhood_boundary_north || suggested?.north?.primary_street || "";
        const east = geometryChanged ? suggested?.east?.primary_street || "" : current.neighborhood_boundary_east || suggested?.east?.primary_street || "";
        const south = geometryChanged ? suggested?.south?.primary_street || "" : current.neighborhood_boundary_south || suggested?.south?.primary_street || "";
        const west = geometryChanged ? suggested?.west?.primary_street || "" : current.neighborhood_boundary_west || suggested?.west?.primary_street || "";
        const boundarySummary = [["North", north], ["East", east], ["South", south], ["West", west]]
          .filter(([, street]) => street)
          .map(([side, street]) => `${side}: ${street}`)
          .join("; ");
        const updated = {
          ...current,
          neighborhood_boundary_geometry: cloneEditorValue(geometry),
          neighborhood_boundary_label: customStudy.market.label || "Appraiser-defined market area",
          neighborhood_boundary_source: "sales_comparison_market_conditions",
          neighborhood_boundary_saved_at: marketConditionsDraft?.savedAt ||
            current.neighborhood_boundary_saved_at || new Date().toISOString(),
          neighborhood_boundary_confirmed: geometryChanged ? false : current.neighborhood_boundary_confirmed,
          neighborhood_boundary_confirmed_at: geometryChanged ? "" : current.neighborhood_boundary_confirmed_at,
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
          neighborhood_city_name: cityStudy?.market.city || profile.subject.city || detailCity || current.neighborhood_city_name || "",
          neighborhood_city_sale_count: cityStudy?.population.eligible_sale_count ?? "",
          neighborhood_city_average_sale_price: cityStudy?.summary.average_sale_price ?? "",
          neighborhood_city_average_ppsf: cityStudy?.summary.average_price_per_square_foot ?? "",
          neighborhood_city_average_age: cityStudy?.summary.average_age ?? "",
          neighborhood_city_average_gla: cityStudy?.summary.average_living_area ?? "",
          neighborhood_city_comparison_as_of: cityStudy?.period.end || profileAsOf,
          neighborhood_boundary_streets: boundarySummary || current.neighborhood_boundary_streets || "",
          neighborhood_boundary_north: north,
          neighborhood_boundary_east: east,
          neighborhood_boundary_south: south,
          neighborhood_boundary_west: west,
          neighborhood_boundary_exclusions: current.neighborhood_boundary_exclusions || DEFAULT_NEIGHBORHOOD_BOUNDARY_NARRATIVE,
          neighborhood_boundary_streets_source: boundaryStreets?.source || current.neighborhood_boundary_streets_source || "",
          neighborhood_boundary_streets_retrieved_at: boundaryStreets?.retrieved_at || current.neighborhood_boundary_streets_retrieved_at || "",
        };
        return retainCurrentDraftWhenUnchanged(current, updated);
      });
      setProfileMessage(profile.boundary_street_warning
        ? "Market ranges and city averages refreshed. Boundary streets could not be refreshed and still require review."
        : "Appraiser-defined ranges, city averages, and four-side boundary suggestions refreshed.");
      delete retryAttempts.current[signature];
    } catch (error) {
      if (requestGeneration.current !== generation) return;
      setProfileMessage(error instanceof Error ? error.message : "The neighborhood profile could not be refreshed.");
      const attempts = Number(retryAttempts.current[signature] || 0);
      if (attempts < 2) {
        retryAttempts.current[signature] = attempts + 1;
        if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
        retryTimer.current = window.setTimeout(() => {
          if (attemptedSignature.current === signature) attemptedSignature.current = "";
          retryTimer.current = null;
          setRetryNonce((current) => current + 1);
        }, 3_000 * 2 ** attempts);
      }
    } finally {
      if (requestGeneration.current === generation) {
        loadingRef.current = false;
        setProfileLoading(false);
      }
    }
  }, [accountId, assignmentDraft.neighborhood_boundary_geometry, customMarketStudy, detailCity, marketConditionsDraft, setAssignmentDraft]);

  useEffect(() => {
    const geometry = assignmentDraft.neighborhood_boundary_geometry || customMarketStudy?.market.custom_geometry;
    if (!sectionReady || !geometry || !accountId || assignmentFilesLoading || !assignmentFilesLoaded) return;
    const structuredBoundariesPresent = [assignmentDraft.neighborhood_boundary_north, assignmentDraft.neighborhood_boundary_east, assignmentDraft.neighborhood_boundary_south, assignmentDraft.neighborhood_boundary_west]
      .every((value) => String(value || "").trim());
    const profileValuesPresent = structuredBoundariesPresent && [assignmentDraft.neighborhood_ppsf_predominant, assignmentDraft.neighborhood_age_predominant, assignmentDraft.neighborhood_gla_predominant, assignmentDraft.neighborhood_city_average_sale_price, assignmentDraft.neighborhood_sale_count]
      .every(hasValue);
    if (profileValuesPresent) return;
    const profileVersion = marketConditionsDraft?.savedAt || new Date().toISOString().slice(0, 10);
    const signature = profileSignature(accountId, profileVersion, geometry);
    if (attemptedSignature.current === signature) return;
    attemptedSignature.current = signature;
    void refreshProfile(false);
  }, [accountId, assignmentDraft.neighborhood_age_predominant, assignmentDraft.neighborhood_boundary_east, assignmentDraft.neighborhood_boundary_geometry, assignmentDraft.neighborhood_boundary_north, assignmentDraft.neighborhood_boundary_south, assignmentDraft.neighborhood_boundary_west, assignmentDraft.neighborhood_city_average_sale_price, assignmentDraft.neighborhood_gla_predominant, assignmentDraft.neighborhood_ppsf_predominant, assignmentDraft.neighborhood_sale_count, assignmentFilesLoaded, assignmentFilesLoading, customMarketStudy, marketConditionsDraft, refreshProfile, retryNonce, sectionReady]);

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
