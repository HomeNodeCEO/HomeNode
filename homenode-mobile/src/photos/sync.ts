import { fetch as expoFetch } from "expo/fetch";
import { File } from "expo-file-system";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";

import type { MobileApi } from "../api/client";
import { OfflineStore, type PhotoQueueSummary } from "../offline/store";
import { deletePreparedPhotoFiles } from "./capture";
import { createCoalescedSync, drainDuePhotoBatches } from "./coalescedSync";
import { uploadPhotoObject, synchronizeDuePhotosWithDependencies } from "./syncCore";

export { PHOTO_SYNC_CONCURRENCY } from "./syncCore";

const EMPTY_SUMMARY: PhotoQueueSummary = { total: 0, pending: 0, synchronized: 0, failed: 0 };

export async function synchronizeDuePhotos(store: OfflineStore, api: MobileApi, ownerUserId: string, dueBefore = Date.now()) {
  return synchronizeDuePhotosWithDependencies(store, api, ownerUserId, {
    uploadObject: (photo, upload) => uploadPhotoObject<File>(photo, upload, {
      createFile: (uri) => new File(uri),
      put: expoFetch,
    }),
    deletePreparedPhotoFiles,
  }, dueBefore);
}

export function usePhotoSync(
  store: OfflineStore,
  api: MobileApi,
  ownerUserId: string,
  sessionId: string,
  online: boolean,
) {
  const [summary, setSummary] = useState<PhotoQueueSummary>(EMPTY_SUMMARY);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setSummary(await store.withDatabaseActivity(() => store.photoQueueSummary(ownerUserId, sessionId)));
  }, [ownerUserId, sessionId, store]);

  const runQueue = useMemo(() => createCoalescedSync(async () => {
    // One pass may span many bounded batches. A fixed cutoff prevents a failed
    // upload from becoming due again later in the same pass as backoff elapses.
    await drainDuePhotoBatches((dueBefore) => synchronizeDuePhotos(store, api, ownerUserId, dueBefore));
  }), [api, ownerUserId, store]);

  const syncNow = useCallback(async () => {
    if (!online) return;
    setSyncing(true);
    try {
      await runQueue();
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "mobile_photo_sync_failed");
    } finally {
      setSyncing(false);
    }
    try {
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "mobile_photo_database_unavailable");
    }
  }, [online, refresh, runQueue]);

  useEffect(() => { void refresh().catch((reason) => {
    setError(reason instanceof Error ? reason.message : "mobile_photo_database_unavailable");
  }); }, [refresh]);
  useEffect(() => { if (online) void syncNow(); }, [online, syncNow]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && online) {
        void store.withDatabaseActivity(() => store.ensureReady()).then(syncNow).catch((reason) => {
          setError(reason instanceof Error ? reason.message : "mobile_photo_database_unavailable");
        });
      }
    });
    return () => {
      subscription.remove();
    };
  }, [online, syncNow]);

  return { error, refresh, summary, syncing, syncNow };
}
