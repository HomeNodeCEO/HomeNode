import { ApiError, type MobileApi, type PresignedPhotoUpload } from "../api/client";
import { NetworkTimeoutError, withNetworkTimeout } from "../api/networkTimeout";
import { runWithConcurrency } from "../offline/concurrency";
import type { OfflineStore, LocalPhotoDraft } from "../offline/store";
import { photoUploadTimeoutMs } from "./model";

export const PHOTO_SYNC_CONCURRENCY = 3;

class PhotoUploadHttpError extends Error {}

type PhotoFileBody = { exists: boolean; size: number };

export async function uploadPhotoObject<FileBody extends PhotoFileBody>(
  photo: LocalPhotoDraft,
  upload: PresignedPhotoUpload,
  dependencies: {
    createFile: (uri: string) => FileBody;
    put: (url: string, request: {
      method: "PUT";
      headers: Record<string, string>;
      body: FileBody;
      signal: AbortSignal;
    }) => Promise<Response>;
    timeoutMs?: number;
  },
) {
  const object = photo.objects.find((item) => item.variant === upload.variant);
  if (!object) throw new Error("offline_photo_object_not_found");
  const file = dependencies.createFile(object.uri);
  if (!file.exists || Number(file.size) !== object.byteSize || object.byteSize <= 0) {
    throw new Error("empty_mobile_photo_file");
  }
  try {
    await withNetworkTimeout(async (signal) => {
      const response = await dependencies.put(upload.url, {
        method: "PUT",
        headers: upload.headers,
        body: file,
        signal,
      });
      if (!response.ok) {
        const responseBody = await response.text().catch((reason: unknown) => {
          if (signal.aborted) throw reason;
          return "";
        });
        const providerCode = responseBody.match(/<Code>([^<]+)<\/Code>/i)?.[1]
          ?.replace(/[^A-Za-z0-9_.-]/g, "")
          .slice(0, 80);
        throw new PhotoUploadHttpError(`mobile_photo_upload_http_${response.status}${providerCode ? `:${providerCode}` : ""}`);
      }
    }, dependencies.timeoutMs ?? photoUploadTimeoutMs(object.byteSize));
  } catch (reason) {
    if (reason instanceof NetworkTimeoutError) throw new Error("mobile_photo_upload_timeout");
    if (reason instanceof PhotoUploadHttpError) throw reason;
    // Native transport errors can contain the presigned URL; never persist it in the offline queue.
    throw new Error("mobile_photo_upload_transport_failed");
  }
}

export type PhotoSyncDependencies = {
  uploadObject: (photo: LocalPhotoDraft, upload: PresignedPhotoUpload) => Promise<void>;
  deletePreparedPhotoFiles: (photo: LocalPhotoDraft) => Promise<void>;
};

async function synchronizePhoto(
  store: OfflineStore,
  api: MobileApi,
  ownerUserId: string,
  photo: LocalPhotoDraft,
  dependencies: PhotoSyncDependencies,
) {
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
      await dependencies.deletePreparedPhotoFiles(photo);
      return;
    }
    if (removed.disposition === "placeholder_deleted") {
      await store.deletePhotoDraft(ownerUserId, photo.clientPhotoId);
      await dependencies.deletePreparedPhotoFiles(photo);
      return;
    }
    await store.applyServerPhoto(ownerUserId, photo.clientPhotoId, removed.photo);
    await dependencies.deletePreparedPhotoFiles(photo);
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
  for (const upload of registered.uploads) await dependencies.uploadObject(photo, upload);
  await store.markPhotoDraftState(ownerUserId, photo.clientPhotoId, "verifying");
  const verified = await api.verifyPhoto(photo.sessionId, registered.photo.id);
  await store.applyServerPhoto(ownerUserId, photo.clientPhotoId, verified);
}

export async function synchronizeDuePhotosWithDependencies(
  store: OfflineStore,
  api: MobileApi,
  ownerUserId: string,
  dependencies: PhotoSyncDependencies,
) {
  await store.ensureReady();
  const due = await store.duePhotoDrafts(ownerUserId);
  await runWithConcurrency(due, PHOTO_SYNC_CONCURRENCY, async (photo) => {
    try {
      await synchronizePhoto(store, api, ownerUserId, photo, dependencies);
    } catch (reason) {
      const code = reason instanceof ApiError
        ? reason.code
        : reason instanceof Error ? reason.message : "mobile_photo_sync_failed";
      await store.recordPhotoFailure(ownerUserId, photo, code);
    }
  });
}
