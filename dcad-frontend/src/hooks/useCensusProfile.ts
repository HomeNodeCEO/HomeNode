import { useCallback, useEffect, useRef, useState } from "react";
import {
  getCensusCityProfile,
  getCensusZipProfile,
  lookupAccountCensusGeography,
  type CensusCityProfile,
  type CensusZipProfile,
} from "@/lib/api";
import { formatCensusTract } from "@/lib/propertyReportPresentation";
import { createTimedRequestCache } from "@/lib/timedRequestCache";

const PROFILE_CACHE_TTL_MS = 15 * 60 * 1000;
const zipProfileCache = createTimedRequestCache<CensusZipProfile>(PROFILE_CACHE_TTL_MS);
const cityProfileCache = createTimedRequestCache<CensusCityProfile>(PROFILE_CACHE_TTL_MS);

export type CensusProfilesLoaded = {
  zipProfile: CensusZipProfile | null;
  cityProfile: CensusCityProfile | null;
};

export function useCensusProfile({
  accountId,
  censusZip,
  city,
  state,
  autoEnabled,
  hasExistingZipProfile,
  hasExistingCityProfile,
  onProfilesLoaded,
  onTractReload,
  onCredentialRejected,
}: {
  accountId?: string;
  censusZip: string;
  city: string;
  state: string;
  autoEnabled: boolean;
  hasExistingZipProfile: boolean;
  hasExistingCityProfile: boolean;
  onProfilesLoaded: (profiles: CensusProfilesLoaded) => void;
  onTractReload: () => Promise<void>;
  onCredentialRejected: () => void;
}) {
  const [censusLookupLoading, setCensusLookupLoading] = useState(false);
  const [censusLookupMessage, setCensusLookupMessage] = useState("");
  const [unemploymentLookupLoading, setUnemploymentLookupLoading] = useState(false);
  const [unemploymentLookupMessage, setUnemploymentLookupMessage] = useState("");
  const automaticAttemptRef = useRef("");
  const tractRequestRef = useRef(0);
  const unemploymentRequestRef = useRef(0);
  const profileHandlerRef = useRef(onProfilesLoaded);
  const tractReloadRef = useRef(onTractReload);
  const credentialRejectedRef = useRef(onCredentialRejected);

  useEffect(() => {
    profileHandlerRef.current = onProfilesLoaded;
  }, [onProfilesLoaded]);
  useEffect(() => {
    tractReloadRef.current = onTractReload;
  }, [onTractReload]);
  useEffect(() => {
    credentialRejectedRef.current = onCredentialRejected;
  }, [onCredentialRejected]);

  useEffect(() => {
    automaticAttemptRef.current = "";
    tractRequestRef.current += 1;
    unemploymentRequestRef.current += 1;
    setCensusLookupLoading(false);
    setUnemploymentLookupLoading(false);
    setCensusLookupMessage("");
    setUnemploymentLookupMessage("");
  }, [accountId]);

  const lookupCensusTractNow = useCallback(async (editorKey: string) => {
    if (!accountId || censusLookupLoading) return;
    const requestId = tractRequestRef.current + 1;
    tractRequestRef.current = requestId;
    setCensusLookupLoading(true);
    setCensusLookupMessage("");
    try {
      const response = await lookupAccountCensusGeography(accountId, editorKey);
      if (requestId !== tractRequestRef.current) return;
      const tract = response.census_geography?.tract_code;
      setCensusLookupMessage(
        response.census_geography?.status === "matched"
          ? `Census tract ${formatCensusTract(tract)} added.`
          : "The Census response needs review before it can be treated as a verified tract.",
      );
      await tractReloadRef.current();
    } catch (error) {
      if (requestId !== tractRequestRef.current) return;
      const message = error instanceof Error
        ? error.message
        : "The Census tract could not be looked up.";
      if (/401|invalid_editor_key/i.test(message)) credentialRejectedRef.current();
      setCensusLookupMessage(
        message === "census_lookup_input_missing"
          ? "This property needs a usable address or coordinate before Census lookup."
          : message,
      );
    } finally {
      if (requestId === tractRequestRef.current) setCensusLookupLoading(false);
    }
  }, [accountId, censusLookupLoading]);

  const loadUnemploymentComparison = useCallback(async (force = true) => {
    if ((!/^\d{5}$/.test(censusZip) && (!city || city === "Not reported")) || unemploymentLookupLoading) {
      return;
    }
    const requestId = unemploymentRequestRef.current + 1;
    unemploymentRequestRef.current = requestId;
    setUnemploymentLookupLoading(true);
    setUnemploymentLookupMessage("");
    const normalizedCity = String(city || "").trim();
    const normalizedState = String(state || "TX").trim().toUpperCase() || "TX";
    const [zipResult, cityResult] = await Promise.allSettled([
      /^\d{5}$/.test(censusZip)
        ? zipProfileCache.load(censusZip, () => getCensusZipProfile(censusZip), { force })
        : Promise.reject(new Error("ZIP not reported")),
      normalizedCity && normalizedCity !== "Not reported"
        ? cityProfileCache.load(
          `${normalizedCity.toUpperCase()}:${normalizedState}`,
          () => getCensusCityProfile(normalizedCity, normalizedState),
          { force },
        )
        : Promise.reject(new Error("City not reported")),
    ]);
    if (requestId !== unemploymentRequestRef.current) return;
    const zipProfile = zipResult.status === "fulfilled" ? zipResult.value : null;
    const cityProfile = cityResult.status === "fulfilled" ? cityResult.value : null;
    if (zipProfile || cityProfile) profileHandlerRef.current({ zipProfile, cityProfile });
    const failures = [zipResult, cityResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
    if (!failures.length) {
      setUnemploymentLookupMessage(`Census unemployment updated for ZIP ${censusZip} and ${city}.`);
    } else if (zipProfile || cityProfile) {
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
    const signature = `${censusZip}:${city}:${state}`;
    if (
      !autoEnabled ||
      (!/^\d{5}$/.test(censusZip) && (!city || city === "Not reported")) ||
      automaticAttemptRef.current === signature ||
      (hasExistingZipProfile && hasExistingCityProfile)
    ) return;
    automaticAttemptRef.current = signature;
    void loadUnemploymentComparison(false);
  }, [
    autoEnabled,
    censusZip,
    city,
    hasExistingCityProfile,
    hasExistingZipProfile,
    loadUnemploymentComparison,
    state,
  ]);

  return {
    censusLookupLoading,
    censusLookupMessage,
    lookupCensusTractNow,
    unemploymentLookupLoading,
    unemploymentLookupMessage,
    lookupUnemploymentComparison: () => loadUnemploymentComparison(true),
  };
}
