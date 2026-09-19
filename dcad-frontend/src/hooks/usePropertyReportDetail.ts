import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAccountPhotos } from "@/lib/api";
import { fetchDetail } from "@/lib/dcad";
import { createTimedRequestCache } from "@/lib/timedRequestCache";

type DetailWithPhotos = { photos?: string[] };
type DetailEnvelope = { detail?: unknown } | null | undefined;

type UsePropertyReportDetailOptions = {
  accountId: string;
  assignmentFileId?: number | null;
  sessionKey: string;
  enabled: boolean;
  onError?: (error: unknown) => void;
};

export function usePropertyReportDetail<T extends DetailWithPhotos>({
  accountId,
  assignmentFileId,
  sessionKey,
  enabled,
  onError,
}: UsePropertyReportDetailOptions) {
  // Private detail must never share an account-only cache with another file or
  // login. Replacing the owner also abandons its pending/cache entries.
  const owner = useMemo(() => ({
    accountId: accountId.trim(), assignmentFileId, sessionKey, enabled,
    detailCache: createTimedRequestCache<DetailEnvelope>(30_000),
    photoCache: createTimedRequestCache<Awaited<ReturnType<typeof getAccountPhotos>>>(300_000),
  }), [accountId, assignmentFileId, sessionKey, enabled]);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const [loaded, setLoaded] = useState<{ owner: typeof owner; detail: T | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const requestGeneration = useRef(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const loadDetail = useCallback(async ({ force = false } = {}) => {
    const requestedAccount = owner.accountId;
    if (!requestedAccount || !owner.enabled || ownerRef.current !== owner) return;
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setLoading(true);
    try {
      const cacheKey = requestedAccount.toUpperCase();
      const response = await owner.detailCache.load(
        cacheKey,
        () => fetchDetail(requestedAccount, 1, { assignmentFileId: owner.assignmentFileId }),
        { force },
      );
      if (requestGeneration.current !== generation || ownerRef.current !== owner) return;
      setLoaded({ owner, detail: (response?.detail as T | undefined) ?? null });

      // Media is independent from the core subject payload and never blocks
      // first paint. A longer cache avoids reloading unchanged gallery data.
      void owner.photoCache.load(
        cacheKey,
        () => getAccountPhotos(requestedAccount),
        { force },
      ).then((photoResponse) => {
        if (requestGeneration.current !== generation || ownerRef.current !== owner) return;
        const photos = photoResponse?.photos
          ?.map((photo) => photo?.media_url)
          .filter((url): url is string => Boolean(url?.trim())) || [];
        if (photos.length) setLoaded((current) => current?.owner === owner && current.detail
          ? { owner, detail: { ...current.detail, photos } } : current);
      }).catch((error) => {
        console.warn("Property photos were unavailable", error);
      });
    } catch (error) {
      if (requestGeneration.current === generation && ownerRef.current === owner) {
        setLoaded(null);
        onErrorRef.current?.(error);
      }
    } finally {
      if (requestGeneration.current === generation && ownerRef.current === owner) setLoading(false);
    }
  }, [owner]);

  useEffect(() => {
    requestGeneration.current += 1;
    setLoaded(null);
    setLoading(false);
    if (owner.accountId && owner.enabled) void loadDetail();
    return () => {
      requestGeneration.current += 1;
    };
  }, [owner, loadDetail]);

  return {
    detail: loaded?.owner === owner ? loaded.detail : null,
    loading: owner.enabled && loading,
    reloadDetail: () => loadDetail({ force: true }),
  };
}
