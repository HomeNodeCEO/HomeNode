import { fetch as expoFetch } from "expo/fetch";
import { File } from "expo-file-system";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, type MobileApi, type PresignedPhotoUpload } from "../api/client";
import { OfflineStore, type LocalPhotoDraft, type PhotoQueueSummary } from "../offline/store";
import { runWithConcurrency } from "../offline/concurrency";
import {
  MOBILE_PHOTO_UPLOAD_TIMEOUT_MS,
  RequestTimeoutError,
  runWithRequestTimeout,
} from "../offline/requestTimeout";
import { emptySyncLaneResult, recordSyncFailure } from "../offline/syncPolicy";
import { deletePreparedPhotoFiles } from "./capture";

const EMPTY_SUMMARY: PhotoQueueSummary = { total: 0, pending: 0, synchronized: 0, failed: 0 };
export const PHOTO_SYNC_CONCURRENCY = 3;

async function uploadObject(photo: LocalPhotoDraft, upload: PresignedPhotoUpload) {
  const object = photo.objects.find((item) => item.variant === upload.variant);
  if (!object) throw new Error("offline_photo_object_not_found");
  const file = new File(object.uri);
  if (!file.exists || Number(file.size) !== object.byteSize || object.byteSize <= 0) {
    throw new Error("empty_mobile_photo_file");
  }
  let response: Response;
  try {
    response = await runWithRequestTimeout(
      MOBILE_PHOTO_UPLOAD_TIMEOUT_MS,
      (signal) => expoFetch(upload.url, {
        method: "PUT",
        headers: upload.headers,
        body: file,
        signal,
      }),
    );
  } catch (reason) {
    if (reason instanceof RequestTimeoutError) throw new Error("mobile_photo_upload_timeout");
    const detail = (reason instanceof Error ? reason.message : "unknown")
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160) || "unknown";
    throw new Error(`mobile_photo_upload_transport_failed:${detail}`);
  }
  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    const providerCode = responseBody.match(/<Code>([^<]+)<\/Code>/i)?.[1]
      ?.replace(/[^A-Za-z0-9_.-]/g, "")
      .slice(0, 80);
    throw new Error(`mobile_photo_upload_http_${response.status}${providerCode ? `:${providerCode}` : ""}`);
  }
}

async function synchronizePhoto(store: OfflineStore, api: MobileApi, ownerUserId: string, photo: LocalPhotoDraft) {
  await store.markPhotoDraftState(ownerUserId, photo.clientPhotoId, "registering", { incrementAttempts: true });
  if (photo.removeOperationId && photo.serverPhotoId && photo.serverRevision) {
    let removed;
    try {
      removed = await api.removePhoto(
        photo.sessionId,
        photo.serverPhotoId,
        photo.removeOperationId,
        photo.serverRevision,
      );
    } catch (reason) {
      if (!(reason instanceof ApiError) || reason.code !== "mobile_photo_not_found") throw reason;
      await store.deletePhotoDraft(ownerUserId, photo.clientPhotoId);
      await deletePreparedPhotoFiles(photo);
      return;
    }
    if (removed.disposition === "placeholder_deleted") {
      await store.deletePhotoDraft(ownerUserId, photo.clientPhotoId);
      await deletePreparedPhotoFiles(photo);
      return;
    }
    await store.applyServerPhoto(ownerUserId, photo.clientPhotoId, removed.photo);
    await deletePreparedPhotoFiles(photo);
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
  const result = emptySyncLaneResult();
  await runWithConcurrency(due, PHOTO_SYNC_CONCURRENCY, async (photo) => {
    result.attempted += 1;
    try {
      await synchronizePhoto(store, api, ownerUserId, photo);
      result.succeeded += 1;
    } catch (reason) {
      recordSyncFailure(result, reason);
      const code = reason instanceof ApiError
        ? reason.code
        : reason instanceof Error ? reason.message : "mobile_photo_sync_failed";
      await store.recordPhotoFailure(ownerUserId, photo, code);
    }
  });
  return result;
}

export function usePhotoSync(
  store: OfflineStore,
  ownerUserId: string,
  sessionId: string,
  online: boolean,
  synchronize: () => Promise<void>,
  retrySynchronize: () => Promise<void>,
) {
  const [summary, setSummary] = useState<PhotoQueueSummary>(EMPTY_SUMMARY);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    setSummary(await store.photoQueueSummary(ownerUserId, sessionId));
  }, [ownerUserId, sessionId, store]);

  const runSync = useCallback(async (operation: () => Promise<void>) => {
    if (!online) return;
    while (active.current) await active.current;
    setSyncing(true);
    const task = operation();
    active.current = task;
    try {
      await task;
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "mobile_photo_sync_failed");
    } finally {
      if (active.current === task) active.current = null;
      setSyncing(false);
    }
    try {
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "mobile_photo_database_unavailable");
    }
  }, [online, refresh]);

  const syncNow = useCallback(() => runSync(synchronize), [runSync, synchronize]);
  const retryNow = useCallback(() => runSync(retrySynchronize), [retrySynchronize, runSync]);

  useEffect(() => { void refresh().catch((reason) => {
    setError(reason instanceof Error ? reason.message : "mobile_photo_database_unavailable");
  }); }, [refresh]);

  return { error, refresh, retryNow, summary, syncing, syncNow };
}
