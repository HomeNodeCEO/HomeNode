import { File, UploadType } from "expo-file-system";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { ApiError, type MobileApi, type PresignedPhotoUpload } from "../api/client";
import { OfflineStore, type LocalPhotoDraft, type PhotoQueueSummary } from "../offline/store";

const EMPTY_SUMMARY: PhotoQueueSummary = { total: 0, pending: 0, synchronized: 0, failed: 0 };

async function uploadObject(photo: LocalPhotoDraft, upload: PresignedPhotoUpload) {
  const object = photo.objects.find((item) => item.variant === upload.variant);
  if (!object) throw new Error("offline_photo_object_not_found");
  const file = new File(object.uri);
  if (!file.exists || Number(file.size) !== object.byteSize || object.byteSize <= 0) {
    throw new Error("empty_mobile_photo_file");
  }
  const result = await file.upload(upload.url, {
    httpMethod: "PUT",
    uploadType: UploadType.BINARY_CONTENT,
    headers: upload.headers,
    mimeType: object.contentType,
    sessionType: "background",
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`mobile_photo_upload_http_${result.status}`);
  }
}

async function synchronizePhoto(store: OfflineStore, api: MobileApi, ownerUserId: string, photo: LocalPhotoDraft) {
  await store.markPhotoDraftState(ownerUserId, photo.clientPhotoId, "registering", { incrementAttempts: true });
  if (photo.removeOperationId && photo.serverPhotoId && photo.serverRevision) {
    const removed = await api.removePhoto(
      photo.sessionId,
      photo.serverPhotoId,
      photo.removeOperationId,
      photo.serverRevision,
    );
    await store.applyServerPhoto(ownerUserId, photo.clientPhotoId, removed.photo);
    return;
  }
  if (photo.metadataOperationId && photo.serverPhotoId && photo.serverRevision) {
    const updated = await api.updatePhoto(photo.sessionId, photo.serverPhotoId, {
      clientOperationId: photo.metadataOperationId,
      baseRevision: photo.serverRevision,
      caption: photo.caption,
    });
    await store.applyServerPhoto(ownerUserId, photo.clientPhotoId, updated);
    return;
  }

  const batch = await api.createPhotoUploadRequests(photo.sessionId, [store.photoUploadRequest(photo)]);
  const registered = batch.photos[0];
  if (!registered) throw new Error("mobile_photo_registration_failed");
  await store.cacheRegisteredPhoto(ownerUserId, photo.clientPhotoId, registered.photo);
  if (registered.photo.status === "verified" || registered.photo.status === "excluded") {
    await store.applyServerPhoto(ownerUserId, photo.clientPhotoId, registered.photo);
    return;
  }
  await store.markPhotoDraftState(ownerUserId, photo.clientPhotoId, "uploading");
  for (const upload of registered.uploads) await uploadObject(photo, upload);
  await store.markPhotoDraftState(ownerUserId, photo.clientPhotoId, "verifying");
  const verified = await api.verifyPhoto(photo.sessionId, registered.photo.id);
  await store.applyServerPhoto(ownerUserId, photo.clientPhotoId, verified);
}

export async function synchronizeDuePhotos(store: OfflineStore, api: MobileApi, ownerUserId: string) {
  await store.ensureReady();
  const due = await store.duePhotoDrafts(ownerUserId);
  for (const photo of due) {
    try {
      await synchronizePhoto(store, api, ownerUserId, photo);
    } catch (reason) {
      const code = reason instanceof ApiError
        ? reason.code
        : reason instanceof Error ? reason.message : "mobile_photo_sync_failed";
      await store.recordPhotoFailure(ownerUserId, photo, code);
    }
  }
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
  const active = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    setSummary(await store.photoQueueSummary(ownerUserId, sessionId));
  }, [ownerUserId, sessionId, store]);

  const syncNow = useCallback(async () => {
    if (!online) return;
    if (!active.current) {
      setSyncing(true);
      active.current = synchronizeDuePhotos(store, api, ownerUserId)
        .then(() => setError(null))
        .catch((reason) => {
          setError(reason instanceof Error ? reason.message : "mobile_photo_sync_failed");
        })
        .finally(() => {
          active.current = null;
          setSyncing(false);
        });
    }
    await active.current;
    try {
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "mobile_photo_database_unavailable");
    }
  }, [api, online, ownerUserId, refresh, store]);

  useEffect(() => { void refresh().catch((reason) => {
    setError(reason instanceof Error ? reason.message : "mobile_photo_database_unavailable");
  }); }, [refresh]);
  useEffect(() => { if (online) void syncNow(); }, [online, syncNow]);
  useEffect(() => {
    const timer = setInterval(() => { if (online && AppState.currentState === "active") void syncNow(); }, 15_000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && online) {
        void store.ensureReady().then(syncNow).catch((reason) => {
          setError(reason instanceof Error ? reason.message : "mobile_photo_database_unavailable");
        });
      }
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [online, syncNow]);

  return { error, refresh, summary, syncing, syncNow };
}
