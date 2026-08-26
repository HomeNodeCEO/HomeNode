import { useCallback, useEffect, useRef, useState } from "react";
import { getRelatedParcels, type RelatedParcelsResponse } from "@/lib/api";

type UseRelatedParcelsOptions = {
  accountId?: string;
  address?: string;
  enabled: boolean;
  initialDelayMs?: number;
};

export function useRelatedParcels({
  accountId,
  address,
  enabled,
  initialDelayMs = 900,
}: UseRelatedParcelsOptions) {
  const [relatedParcels, setRelatedParcels] = useState<RelatedParcelsResponse | null>(null);
  const [relatedParcelsLoading, setRelatedParcelsLoading] = useState(false);
  const [relatedParcelsError, setRelatedParcelsError] = useState("");
  const requestGeneration = useRef(0);
  const automaticLookupTimer = useRef<number | null>(null);

  const loadRelatedParcels = useCallback(async () => {
    if (!enabled || !accountId?.trim()) return;
    if (automaticLookupTimer.current !== null) {
      window.clearTimeout(automaticLookupTimer.current);
      automaticLookupTimer.current = null;
    }
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setRelatedParcelsLoading(true);
    setRelatedParcelsError("");
    try {
      const response = await getRelatedParcels(accountId, address || undefined);
      if (requestGeneration.current === generation) setRelatedParcels(response);
    } catch (error) {
      if (requestGeneration.current === generation) {
        setRelatedParcelsError(
          error instanceof Error ? error.message : "The related-parcel check was unavailable.",
        );
      }
    } finally {
      if (requestGeneration.current === generation) setRelatedParcelsLoading(false);
    }
  }, [accountId, address, enabled]);

  useEffect(() => {
    requestGeneration.current += 1;
    setRelatedParcels(null);
    setRelatedParcelsError("");
    setRelatedParcelsLoading(false);
    if (!enabled || !accountId?.trim()) return;

    // The check is helpful but not required for first paint, so automatic
    // loading yields briefly while an explicit refresh starts immediately.
    automaticLookupTimer.current = window.setTimeout(() => {
      automaticLookupTimer.current = null;
      void loadRelatedParcels();
    }, initialDelayMs);
    return () => {
      requestGeneration.current += 1;
      if (automaticLookupTimer.current !== null) {
        window.clearTimeout(automaticLookupTimer.current);
        automaticLookupTimer.current = null;
      }
    };
  }, [accountId, address, enabled, initialDelayMs, loadRelatedParcels]);

  useEffect(() => () => {
    requestGeneration.current += 1;
    if (automaticLookupTimer.current !== null) window.clearTimeout(automaticLookupTimer.current);
  }, []);

  return {
    relatedParcels,
    relatedParcelsLoading,
    relatedParcelsError,
    refreshRelatedParcels: loadRelatedParcels,
  };
}
