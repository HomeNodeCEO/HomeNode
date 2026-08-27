import { useCallback, useEffect, useRef, useState } from "react";
import { getAccountPhotos } from "@/lib/api";
import { fetchDetail } from "@/lib/dcad";
import { createTimedRequestCache } from "@/lib/timedRequestCache";

type DetailWithPhotos = { photos?: string[] };
type DetailEnvelope = { detail?: unknown } | null | undefined;

const detailCache = createTimedRequestCache<DetailEnvelope>(30_000);
const photoCache = createTimedRequestCache<Awaited<ReturnType<typeof getAccountPhotos>>>(300_000);

type UsePropertyReportDetailOptions = {
  accountId: string;
  onError?: (error: unknown) => void;
};

export function usePropertyReportDetail<T extends DetailWithPhotos>({
  accountId,
  onError,
}: UsePropertyReportDetailOptions) {
  const [detail, setDetail] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const requestGeneration = useRef(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const loadDetail = useCallback(async ({ force = false } = {}) => {
    const requestedAccount = accountId.trim();
    if (!requestedAccount) return;
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setLoading(true);
    try {
      const cacheKey = requestedAccount.toUpperCase();
      const response = await detailCache.load(
        cacheKey,
        () => fetchDetail(requestedAccount),
        { force },
      );
      if (requestGeneration.current !== generation) return;
      setDetail((response?.detail as T | undefined) ?? null);

      // Media is independent from the core subject payload and never blocks
      // first paint. A longer cache avoids reloading unchanged gallery data.
      void photoCache.load(
        cacheKey,
        () => getAccountPhotos(requestedAccount),
        { force },
      ).then((photoResponse) => {
        if (requestGeneration.current !== generation) return;
        const photos = photoResponse?.photos
          ?.map((photo) => photo?.media_url)
          .filter((url): url is string => Boolean(url?.trim())) || [];
        if (photos.length) setDetail((current) => current ? { ...current, photos } : current);
      }).catch((error) => {
        console.warn("Property photos were unavailable", error);
      });
    } catch (error) {
      if (requestGeneration.current === generation) onErrorRef.current?.(error);
    } finally {
      if (requestGeneration.current === generation) setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    requestGeneration.current += 1;
    setDetail(null);
    setLoading(false);
    if (accountId.trim()) void loadDetail();
    return () => {
      requestGeneration.current += 1;
    };
  }, [accountId, loadDetail]);

  return {
    detail,
    loading,
    reloadDetail: () => loadDetail({ force: true }),
  };
}
