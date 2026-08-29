import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import type { MobileApi } from "../api/client";
import type { WorkflowType } from "../domain/workflows";
import { OfflineStore, type LocalPhotoDraft } from "../offline/store";
import {
  captureCameraPhoto,
  deletePreparedPhotoFiles,
  importLibraryPhotos,
  preparePickedPhoto,
  recoverInterruptedPickerPhotos,
} from "./capture";
import {
  CUSTOM_PHOTO_CATEGORIES,
  isPhotoVisible,
  photoSyncErrorMessage,
  remainingPhotoCapacity,
  UAD_PHOTO_CATEGORIES,
} from "./model";
import { usePhotoSync } from "./sync";
import type { SelectedSketchRoom } from "../sketch/SketchEditorPanel";
import { isUnreadableSqliteDatabaseError } from "../offline/databaseRecovery";

function photoError(reason: unknown) {
  if (isUnreadableSqliteDatabaseError(reason)) {
    return "HomeNode could not repair encrypted offline storage. Close and reopen HomeNode, and do not delete the app.";
  }
  const code = reason instanceof Error ? reason.message : "mobile_photo_failed";
  return photoSyncErrorMessage(code);
}

function Action({ title, onPress, disabled = false, secondary = false }: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        secondary && styles.actionSecondary,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Text style={[styles.actionText, secondary && styles.actionSecondaryText]}>{title}</Text>
    </Pressable>
  );
}

function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.choice, selected && styles.choiceSelected]}>
      <Text style={[styles.choiceText, selected && styles.choiceSelectedText]}>{label}</Text>
    </Pressable>
  );
}

function PhotoCard({
  photo,
  caption,
  onCaption,
  onSaveCaption,
  onRemove,
}: {
  photo: LocalPhotoDraft;
  caption: string;
  onCaption: (value: string) => void;
  onSaveCaption: () => void;
  onRemove: () => void;
}) {
  const display = photo.objects.find((object) => object.variant === "display");
  const original = photo.objects.find((object) => object.variant === "original");
  const preferredUri = display?.uri || original?.uri || null;
  const [previewUri, setPreviewUri] = useState(preferredUri);
  useEffect(() => setPreviewUri(preferredUri), [preferredUri]);

  const handlePreviewFailure = () => {
    if (original?.uri && previewUri !== original.uri) {
      setPreviewUri(original.uri);
      return;
    }
    setPreviewUri(null);
  };
  return (
    <View style={styles.photoCard}>
      {previewUri ? (
        <Image
          accessibilityLabel={photo.caption}
          onError={handlePreviewFailure}
          source={{ uri: previewUri }}
          style={styles.preview}
        />
      ) : (
        <View style={[styles.preview, styles.previewUnavailable]}>
          <Text style={styles.previewUnavailableText}>Photo saved · preview unavailable</Text>
        </View>
      )}
      <View style={styles.photoBody}>
        <View style={styles.rowBetween}>
          <Text style={styles.photoTitle}>{photo.roomLabel || photo.category}</Text>
          <Text style={[styles.state, photo.state === "failed" && styles.stateFailed]}>
            {photo.state.replaceAll("_", " ")}
          </Text>
        </View>
        {photo.state === "failed" && photo.errorCode ? (
          <Text style={styles.photoError}>{photoSyncErrorMessage(photo.errorCode)}</Text>
        ) : null}
        <TextInput
          maxLength={200}
          onChangeText={onCaption}
          placeholder="Photo caption"
          style={styles.caption}
          value={caption}
        />
        <View style={styles.row}>
          <Pressable onPress={onSaveCaption}><Text style={styles.link}>Save caption</Text></Pressable>
          <Pressable onPress={onRemove}><Text style={styles.removeLink}>Remove</Text></Pressable>
        </View>
        {photo.serverPhoto?.retention_until ? (
          <Text style={styles.retention}>Verified evidence retained through {new Date(photo.serverPhoto.retention_until).toLocaleDateString()}.</Text>
        ) : null}
      </View>
    </View>
  );
}

export function PhotoCapturePanel({
  api,
  store,
  ownerUserId,
  sessionId,
  workflowType,
  online,
  selectedSketchRoom,
}: {
  api: MobileApi;
  store: OfflineStore;
  ownerUserId: string;
  sessionId: string;
  workflowType: WorkflowType;
  online: boolean;
  selectedSketchRoom: SelectedSketchRoom | null;
}) {
  const [photos, setPhotos] = useState<LocalPhotoDraft[]>([]);
  const [category, setCategory] = useState<string>(CUSTOM_PHOTO_CATEGORIES[0]);
  const [useSketchRoom, setUseSketchRoom] = useState(Boolean(selectedSketchRoom));
  const [captions, setCaptions] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const captureCategories = workflowType === "uad_3_6" ? UAD_PHOTO_CATEGORIES : CUSTOM_PHOTO_CATEGORIES;
  const photoSync = usePhotoSync(store, api, ownerUserId, sessionId, online);
  const { refresh: refreshPhotoSummary, syncNow: syncPhotosNow } = photoSync;
  const activePhotos = photos.filter((photo) => isPhotoVisible(photo.state, photo.removeOperationId));
  const remaining = remainingPhotoCapacity(activePhotos.length);

  const load = useCallback(async () => {
    const next = await store.photoDrafts(ownerUserId, sessionId);
    setPhotos(next);
    setCaptions((current) => Object.fromEntries(next.map((photo) => [
      photo.clientPhotoId,
      current[photo.clientPhotoId] ?? photo.caption,
    ])));
    await refreshPhotoSummary();
  }, [ownerUserId, refreshPhotoSummary, sessionId, store]);

  useEffect(() => {
    void load().catch((reason) => setError(photoError(reason)));
  }, [load, photoSync.summary.failed, photoSync.summary.pending, photoSync.summary.synchronized]);

  useEffect(() => {
    if (selectedSketchRoom) setUseSketchRoom(true);
  }, [selectedSketchRoom]);

  useEffect(() => {
    if (!captureCategories.some((item) => item === category)) setCategory(captureCategories[0]);
  }, [captureCategories, category]);

  const label = useMemo(() => useSketchRoom && selectedSketchRoom ? {
    category: selectedSketchRoom.label,
    categorySource: "sketch_room" as const,
    roomRef: selectedSketchRoom.roomRef,
    roomLabel: selectedSketchRoom.label,
  } : {
    category,
    categorySource: workflowType === "custom_appraisal"
      ? "custom_catalog" as const
      : workflowType === "uad_3_6"
        ? "uad_catalog" as const
        : "manual" as const,
    roomRef: null,
    roomLabel: null,
  }, [category, selectedSketchRoom, useSketchRoom, workflowType]);

  const prepare = useCallback(async (
    assets: Awaited<ReturnType<typeof captureCameraPhoto>>,
    source: "camera" | "library",
  ) => {
    if (!assets.length) return;
    setBusy(true);
    setError(null);
    const prepared: Awaited<ReturnType<typeof preparePickedPhoto>>[] = [];
    let cached = false;
    try {
      const bounded = assets.slice(0, remaining);
      for (const asset of bounded) {
        prepared.push(await preparePickedPhoto(asset, { ownerUserId, sessionId, source, label }));
      }
      await store.cachePreparedPhotos(ownerUserId, sessionId, prepared);
      cached = true;
      await load();
      if (online) await syncPhotosNow();
      await load();
    } catch (reason) {
      if (!cached) {
        for (const photo of prepared) await deletePreparedPhotoFiles(photo);
      }
      setError(photoError(reason));
    } finally {
      setBusy(false);
    }
  }, [label, load, online, ownerUserId, remaining, sessionId, store, syncPhotosNow]);

  useEffect(() => {
    let active = true;
    void recoverInterruptedPickerPhotos().then((assets) => {
      if (active && assets.length) void prepare(assets, "library");
    }).catch((reason) => { if (active) setError(photoError(reason)); });
    return () => { active = false; };
  }, []);

  const takePhoto = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const assets = await captureCameraPhoto();
      await store.ensureReady();
      await prepare(assets, "camera");
    } catch (reason) {
      await store.ensureReady().catch(() => undefined);
      setError(photoError(reason));
    } finally {
      setBusy(false);
    }
  };

  const importPhotos = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const assets = await importLibraryPhotos(remaining);
      await store.ensureReady();
      await prepare(assets, "library");
    } catch (reason) {
      await store.ensureReady().catch(() => undefined);
      setError(photoError(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveCaption = async (photo: LocalPhotoDraft) => {
    await store.queuePhotoCaption(ownerUserId, photo.clientPhotoId, captions[photo.clientPhotoId] || "");
    await load();
    if (online) await syncPhotosNow();
    await load();
  };

  const remove = async (photo: LocalPhotoDraft) => {
    try {
      setError(null);
      const result = await store.queuePhotoRemoval(ownerUserId, photo.clientPhotoId);
      if (result.localOnly) await deletePreparedPhotoFiles(result.photo);
      await load();
      if (online && !result.localOnly) await syncPhotosNow();
      await load();
    } catch (reason) {
      setError(photoError(reason));
    }
  };

  const cleanEmpty = async () => {
    const removed = await store.pruneEmptyPhotoPlaceholders(ownerUserId, sessionId);
    for (const photo of removed) await deletePreparedPhotoFiles(photo);
    await load();
  };

  const retryFailed = async () => {
    if (retrying || photoSync.syncing) return;
    setRetrying(true);
    try {
      setError(null);
      await store.makeFailedPhotosImmediatelyRetryable(ownerUserId, sessionId);
      await syncPhotosNow();
      await load();
    } catch (reason) {
      setError(photoError(reason));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.rowBetween}>
        <View>
          <Text style={styles.eyebrow}>VERIFIED FIELD EVIDENCE</Text>
          <Text style={styles.title}>Photos</Text>
        </View>
        <Text style={styles.count}>{activePhotos.length}/100</Text>
      </View>
      <Text style={styles.help}>Select a sketch room or category before capture. The room becomes the automatic label and can still be captioned manually.</Text>

      <Text style={styles.label}>Sketch room label</Text>
      <View style={styles.choices}>
        <Choice label="No room" selected={!useSketchRoom || !selectedSketchRoom} onPress={() => setUseSketchRoom(false)} />
        {selectedSketchRoom ? (
          <Choice label={selectedSketchRoom.label} selected={useSketchRoom} onPress={() => setUseSketchRoom(true)} />
        ) : null}
      </View>
      {!selectedSketchRoom ? <Text style={styles.help}>Tap a room marker in the measured sketch to make it available here.</Text> : null}
      {!useSketchRoom || !selectedSketchRoom ? <>
        <Text style={styles.label}>Photo category</Text>
        <View style={styles.choices}>{captureCategories.map((item) => (
          <Choice key={item} label={item} selected={category === item} onPress={() => setCategory(item)} />
        ))}</View>
      </> : null}

      <View style={styles.actions}>
        <Action title="Take photo" disabled={busy || remaining < 1} onPress={() => void takePhoto()} />
        <Action title={`Import photos (${remaining} available)`} secondary disabled={busy || remaining < 1} onPress={() => void importPhotos()} />
      </View>
      {busy || photoSync.syncing || retrying ? <View style={styles.progress}><ActivityIndicator color="#1d5a43" /><Text style={styles.help}>{busy ? "Preparing originals and display copies…" : "Uploading and verifying…"}</Text></View> : null}
      <Text style={styles.syncLine}>
        {online ? "Online" : "Offline"} · {photoSync.summary.pending} pending · {photoSync.summary.failed} failed · {photoSync.summary.synchronized} verified
      </Text>
      {error || photoSync.error ? <Text style={styles.error}>{error || photoError(new Error(photoSync.error || ""))}</Text> : null}
      {online && (photoSync.summary.pending || photoSync.summary.failed) ? (
        <Action
          title={photoSync.summary.failed
            ? `Retry ${photoSync.summary.failed} failed photo${photoSync.summary.failed === 1 ? "" : "s"}`
            : `Sync ${photoSync.summary.pending} pending photo${photoSync.summary.pending === 1 ? "" : "s"}`}
          secondary
          disabled={photoSync.syncing || retrying}
          onPress={() => void retryFailed()}
        />
      ) : null}

      <View style={styles.list}>{activePhotos.map((photo) => (
        <PhotoCard
          key={photo.clientPhotoId}
          photo={photo}
          caption={captions[photo.clientPhotoId] ?? photo.caption}
          onCaption={(value) => setCaptions((current) => ({ ...current, [photo.clientPhotoId]: value }))}
          onSaveCaption={() => void saveCaption(photo)}
          onRemove={() => void remove(photo)}
        />
      ))}</View>
      <Pressable onPress={() => void cleanEmpty()}><Text style={styles.cleanLink}>Delete empty photo slots</Text></Pressable>
      <Text style={styles.retentionNote}>Verified originals and display copies stay private, attached to this appraisal file, and carry a five-year retention record. Removing a verified photo excludes it from the report without destroying retained evidence.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12, marginTop: 24 },
  eyebrow: { color: "#5d786d", fontSize: 11, fontWeight: "800", letterSpacing: 1.2 },
  title: { color: "#183f31", fontSize: 25, fontWeight: "800" },
  count: { backgroundColor: "#e8f1ed", borderRadius: 20, color: "#1d5a43", fontWeight: "800", paddingHorizontal: 12, paddingVertical: 7 },
  help: { color: "#617069", fontSize: 13, lineHeight: 19 },
  label: { color: "#33443d", fontSize: 13, fontWeight: "700", marginTop: 5 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  choice: { backgroundColor: "#f2f4f2", borderColor: "#d8dfda", borderRadius: 18, borderWidth: 1, paddingHorizontal: 11, paddingVertical: 8 },
  choiceSelected: { backgroundColor: "#1d5a43", borderColor: "#1d5a43" },
  choiceText: { color: "#3f4d47", fontSize: 12, fontWeight: "600" },
  choiceSelectedText: { color: "white" },
  actions: { gap: 8 },
  action: { alignItems: "center", backgroundColor: "#1d5a43", borderRadius: 11, minHeight: 48, justifyContent: "center", paddingHorizontal: 14 },
  actionSecondary: { backgroundColor: "white", borderColor: "#1d5a43", borderWidth: 1 },
  actionText: { color: "white", fontSize: 14, fontWeight: "800" },
  actionSecondaryText: { color: "#1d5a43" },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.8 },
  progress: { alignItems: "center", flexDirection: "row", gap: 8 },
  syncLine: { color: "#3f5f52", fontSize: 12, fontWeight: "700" },
  error: { backgroundColor: "#fff0ef", borderRadius: 8, color: "#9e2c25", padding: 10 },
  list: { gap: 12 },
  photoCard: { backgroundColor: "white", borderColor: "#dce4df", borderRadius: 13, borderWidth: 1, overflow: "hidden" },
  preview: { aspectRatio: 4 / 3, backgroundColor: "#edf0ee", width: "100%" },
  previewUnavailable: { alignItems: "center", justifyContent: "center" },
  previewUnavailableText: { color: "#6b7772", fontSize: 12, fontWeight: "700" },
  photoBody: { gap: 9, padding: 12 },
  photoTitle: { color: "#183f31", flex: 1, fontSize: 16, fontWeight: "800" },
  photoError: { backgroundColor: "#fff0ef", borderRadius: 8, color: "#9e2c25", fontSize: 12, lineHeight: 18, padding: 9 },
  state: { backgroundColor: "#e8f1ed", borderRadius: 12, color: "#1d5a43", fontSize: 10, fontWeight: "800", overflow: "hidden", paddingHorizontal: 8, paddingVertical: 4 },
  stateFailed: { backgroundColor: "#fff0ef", color: "#9e2c25" },
  caption: { backgroundColor: "#f7f8f7", borderColor: "#d8dfda", borderRadius: 8, borderWidth: 1, minHeight: 43, paddingHorizontal: 10 },
  row: { flexDirection: "row", gap: 20 },
  rowBetween: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  link: { color: "#1d5a43", fontSize: 13, fontWeight: "800" },
  removeLink: { color: "#9e2c25", fontSize: 13, fontWeight: "800" },
  retention: { color: "#6b7772", fontSize: 11 },
  cleanLink: { color: "#6b7772", fontSize: 12, fontWeight: "700", textDecorationLine: "underline" },
  retentionNote: { backgroundColor: "#f2f6f4", borderRadius: 9, color: "#52635c", fontSize: 11, lineHeight: 17, padding: 10 },
});
