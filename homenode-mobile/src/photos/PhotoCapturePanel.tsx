import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  Platform,
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
  clearStagedPhotoManifest,
  deletePreparedPhotoFiles,
  importLibraryPhotos,
  preparePickedPhoto,
  recoverInterruptedPickerPhotos,
  recoverStagedPhotos,
} from "./capture";
import {
  CUSTOM_PHOTO_CATEGORIES,
  isPhotoVisible,
  photoSyncErrorMessage,
  remainingPhotoCapacity,
  UAD_PHOTO_CATEGORIES,
  type PreparedPhoto,
} from "./model";
import { usePhotoSync } from "./sync";
import type { SelectedSketchRoom } from "../sketch/SketchEditorPanel";
import { isUnreadableSqliteDatabaseError } from "../offline/databaseRecovery";
import { COLORS } from "../theme";
import { savePhotosToCameraRoll } from "./cameraRoll";
import { cameraRollPhotos, cameraRollResultMessage } from "./cameraRollCore";

function photoError(reason: unknown) {
  if (reason instanceof Error && reason.message === "mobile_offline_database_key_unavailable") {
    return "HomeNode cannot access the offline encryption key. Keep the app installed; your local files were not deleted.";
  }
  if (isUnreadableSqliteDatabaseError(reason)) {
    return "HomeNode cannot open its encrypted photo queue right now. Photos already saved inside HomeNode are still on this device. Keep the app installed.";
  }
  const code = reason instanceof Error ? reason.message : "mobile_photo_failed";
  return photoSyncErrorMessage(code);
}

async function ensurePhotoDatabaseReady(store: OfflineStore) {
  for (const delayMs of [0, 300, 900, 1800]) {
    if (delayMs) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    try {
      await store.ensureReady();
      return;
    } catch (reason) {
      if (!isUnreadableSqliteDatabaseError(reason) || delayMs === 1800) throw reason;
    }
  }
}

async function waitForPhotoForeground() {
  if (Platform.OS !== "ios") return;
  if (AppState.currentState !== "active") {
    await new Promise<void>((resolve, reject) => {
      let subscription: { remove: () => void } | null = null;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        subscription?.remove();
        if (error) reject(error);
        else resolve();
      };
      subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") finish();
      });
      timeout = setTimeout(() => finish(new Error("mobile_photo_foreground_timeout")), 10_000);
      if (AppState.currentState === "active") finish();
    });
  }
  // ImagePicker can resolve during the iOS inactive-to-active transition.
  // Let the native file and SQLCipher handles settle before probing the queue.
  await new Promise<void>((resolve) => setTimeout(resolve, 500));
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
  const [stagedPhotos, setStagedPhotos] = useState<PreparedPhoto[]>([]);
  const [category, setCategory] = useState<string>(CUSTOM_PHOTO_CATEGORIES[0]);
  const [useSketchRoom, setUseSketchRoom] = useState(Boolean(selectedSketchRoom));
  const [captions, setCaptions] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingToPhotos, setSavingToPhotos] = useState(false);
  const [cameraRollProgress, setCameraRollProgress] = useState("");
  const [cameraRollMessage, setCameraRollMessage] = useState<string | null>(null);
  const captureCategories = workflowType === "uad_3_6" ? UAD_PHOTO_CATEGORIES : CUSTOM_PHOTO_CATEGORIES;
  const photoSync = usePhotoSync(store, api, ownerUserId, sessionId, online);
  const { refresh: refreshPhotoSummary, syncNow: syncPhotosNow } = photoSync;
  const activePhotos = photos.filter((photo) => isPhotoVisible(photo.state, photo.removeOperationId));
  const remaining = remainingPhotoCapacity(activePhotos.length + stagedPhotos.length);

  const load = useCallback(async () => {
    const next = await store.withDatabaseActivity(() => store.photoDrafts(ownerUserId, sessionId));
    setPhotos(next);
    setCaptions((current) => Object.fromEntries(next.map((photo) => [
      photo.clientPhotoId,
      current[photo.clientPhotoId] ?? photo.caption,
    ])));
    await refreshPhotoSummary();
  }, [ownerUserId, refreshPhotoSummary, sessionId, store]);

  useEffect(() => {
    void load().catch((reason) => setError(`${photoError(reason)} Stage: photo list refresh.`));
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

  const prepareAssets = useCallback(async (
    assets: Awaited<ReturnType<typeof captureCameraPhoto>>,
    source: "camera" | "library",
  ) => {
    const prepared: Awaited<ReturnType<typeof preparePickedPhoto>>[] = [];
    for (const asset of assets.slice(0, remaining)) {
      prepared.push(await preparePickedPhoto(asset, { ownerUserId, sessionId, source, label }));
    }
    return prepared;
  }, [label, ownerUserId, remaining, sessionId]);

  const cachePrepared = useCallback(async (
    prepared: Awaited<ReturnType<typeof preparePickedPhoto>>[],
  ) => {
    if (!prepared.length) return;
    setError(null);
    let stage = "photo queue write";
    try {
      await store.withDatabaseActivity(() => store.cachePreparedPhotos(ownerUserId, sessionId, prepared));
      stage = "photo list refresh";
      await load();
      for (const photo of prepared) {
        try { clearStagedPhotoManifest(ownerUserId, sessionId, photo.clientPhotoId); } catch { /* already queued */ }
      }
      setStagedPhotos((current) => current.filter((item) => !prepared.some((photo) => photo.clientPhotoId === item.clientPhotoId)));
      // The durable local copy is ready for the next shot. Cloud sync runs
      // separately and may still be uploading an earlier full-size original.
      if (online) void syncPhotosNow();
    } catch (reason) {
      // The manifest and original remain on-device if SQLite cannot accept the
      // queue row. A later launch can register the same client photo ID once.
      setError(`${photoError(reason)} Stage: ${stage}. The photo remains saved on this device; do not delete the app.`);
    }
  }, [load, online, ownerUserId, sessionId, store, syncPhotosNow]);

  const prepare = useCallback(async (
    assets: Awaited<ReturnType<typeof captureCameraPhoto>>,
    source: "camera" | "library",
  ) => cachePrepared(await prepareAssets(assets, source)), [cachePrepared, prepareAssets]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const staged = await recoverStagedPhotos(ownerUserId, sessionId);
      if (active && staged.length) {
        setStagedPhotos(staged);
        await cachePrepared(staged);
      }
      const assets = await recoverInterruptedPickerPhotos();
      if (active && assets.length) await prepare(assets, "library");
    })().catch((reason) => { if (active) setError(photoError(reason)); });
    return () => { active = false; };
  }, []);

  const pickWithDatabasePaused = async (
    picker: () => Promise<Awaited<ReturnType<typeof captureCameraPhoto>>>,
    source: "camera" | "library",
    onPrepared: (count: number) => void,
  ) => {
    // A photo upload may continue over the network while the picker is open,
    // but its SQLite transitions must wait until camera activity finishes.
    // Keep the keyed connection open: repeatedly closing it for every photo
    // makes iOS camera return depend on a fragile SQLCipher re-open.
    const resumeDatabaseActivity = await store.pauseDatabaseActivity();
    try {
      const assets = await picker();
      // Make the camera result durable before checking encrypted storage.
      const prepared = await prepareAssets(assets, source);
      onPrepared(prepared.length);
      if (prepared.length) setStagedPhotos((current) => [...current, ...prepared]);
      await waitForPhotoForeground();
      if (prepared.length) await ensurePhotoDatabaseReady(store);
      return prepared;
    } finally {
      resumeDatabaseActivity();
    }
  };

  const takePhoto = async () => {
    if (busy) return;
    setBusy(true);
    let stagedCount = 0;
    try {
      const prepared = await pickWithDatabasePaused(captureCameraPhoto, "camera", (count) => { stagedCount = count; });
      void cachePrepared(prepared);
    } catch (reason) {
      setError(`${photoError(reason)}${stagedCount ? " Stage: camera return. The photo remains saved on this device; do not delete the app." : ""}`);
    } finally {
      setBusy(false);
    }
  };

  const importPhotos = async () => {
    if (busy) return;
    setBusy(true);
    let stagedCount = 0;
    try {
      const prepared = await pickWithDatabasePaused(() => importLibraryPhotos(remaining), "library", (count) => { stagedCount = count; });
      void cachePrepared(prepared);
    } catch (reason) {
      setError(`${photoError(reason)}${stagedCount ? " Stage: library return. The photos remain saved on this device; do not delete the app." : ""}`);
    } finally {
      setBusy(false);
    }
  };

  const saveCaption = async (photo: LocalPhotoDraft) => {
    await store.withDatabaseActivity(() => store.queuePhotoCaption(ownerUserId, photo.clientPhotoId, captions[photo.clientPhotoId] || ""));
    await load();
    if (online) await syncPhotosNow();
    await load();
  };

  const remove = async (photo: LocalPhotoDraft) => {
    try {
      setError(null);
      const result = await store.withDatabaseActivity(() => store.queuePhotoRemoval(ownerUserId, photo.clientPhotoId));
      if (result.localOnly) await deletePreparedPhotoFiles(result.photo);
      await load();
      if (online && !result.localOnly) await syncPhotosNow();
      await load();
    } catch (reason) {
      setError(photoError(reason));
    }
  };

  const cleanEmpty = async () => {
    const removed = await store.withDatabaseActivity(() => store.pruneEmptyPhotoPlaceholders(ownerUserId, sessionId));
    for (const photo of removed) await deletePreparedPhotoFiles(photo);
    await load();
  };

  const retryFailed = async () => {
    if (retrying || photoSync.syncing) return;
    setRetrying(true);
    try {
      setError(null);
      await store.withDatabaseActivity(() => store.makeFailedPhotosImmediatelyRetryable(ownerUserId, sessionId));
      await syncPhotosNow();
      await load();
    } catch (reason) {
      setError(photoError(reason));
    } finally {
      setRetrying(false);
    }
  };

  const recoverSavedPhotos = async () => {
    if (busy || retrying) return;
    setRetrying(true);
    setError(null);
    try {
      const resume = await store.pauseDatabaseActivity();
      try {
        await ensurePhotoDatabaseReady(store);
      } finally {
        resume();
      }
      const staged = await recoverStagedPhotos(ownerUserId, sessionId);
      setStagedPhotos(staged);
      if (staged.length) await cachePrepared(staged);
      else await load();
    } catch (reason) {
      setError(`${photoError(reason)} Stage: manual recovery.`);
    } finally {
      setRetrying(false);
    }
  };

  const saveAllToPhotos = async () => {
    if (savingToPhotos || busy || retrying) return;
    setSavingToPhotos(true);
    setCameraRollMessage(null);
    setCameraRollProgress("Preparing originals…");
    try {
      // Include staged originals even if their queue rows have not been registered yet.
      const staged = await recoverStagedPhotos(ownerUserId, sessionId);
      const selected = cameraRollPhotos(photos, [...stagedPhotos, ...staged]);
      const result = await savePhotosToCameraRoll(ownerUserId, sessionId, selected, (completed, total) => {
        setCameraRollProgress(`Saving to Photos: ${completed}/${total}`);
      });
      setCameraRollMessage(selected.length ? cameraRollResultMessage(result) : "No local inspection photos to save.");
    } catch (reason) {
      const denied = reason instanceof Error && reason.message === "camera_roll_permission_required";
      setCameraRollMessage(denied
        ? "Photo-library permission was not granted. Allow HomeNode to add photos in your phone Settings, then try again. Your inspection photos are unchanged."
        : "HomeNode could not save to Photos right now. Your originals and upload queue are unchanged; try again.");
    } finally {
      setSavingToPhotos(false);
      setCameraRollProgress("");
    }
  };

  const confirmSaveAllToPhotos = () => Alert.alert(
    "Save inspection photos to your phone?",
    "Copy all local photos for this inspection at original quality. HomeNode originals and cloud uploads stay unchanged. Photos may sync to iCloud or your phone's photo backup. Repeated saves skip copies HomeNode already saved.",
    [{ text: "Cancel", style: "cancel" }, { text: "Save all photos", onPress: () => void saveAllToPhotos() }],
  );

  return (
    <View style={styles.container}>
      <View style={styles.rowBetween}>
        <View>
          <Text style={styles.eyebrow}>VERIFIED FIELD EVIDENCE</Text>
          <Text style={styles.title}>Photos</Text>
        </View>
        <Text style={styles.count}>{activePhotos.length + stagedPhotos.length}/100</Text>
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
        <Action title="Take photo" disabled={busy || retrying || remaining < 1} onPress={() => void takePhoto()} />
        <Action title={`Import photos (${remaining} available)`} secondary disabled={busy || retrying || remaining < 1} onPress={() => void importPhotos()} />
        <Action title={savingToPhotos ? cameraRollProgress : "Save all photos to phone"} secondary disabled={savingToPhotos || busy || retrying || activePhotos.length + stagedPhotos.length < 1} onPress={confirmSaveAllToPhotos} />
      </View>
      {cameraRollMessage ? <Text accessibilityLiveRegion="polite" style={styles.help}>{cameraRollMessage}</Text> : null}
      {busy || photoSync.syncing || retrying ? <View style={styles.progress}><ActivityIndicator color={COLORS.violet} /><Text style={styles.help}>{busy ? "Saving photo on this device…" : "Uploading saved photos… You can take another photo."}</Text></View> : null}
      <Text style={styles.syncLine}>
        {online ? "Online" : "Offline"} · {photoSync.summary.pending} pending · {photoSync.summary.failed} failed · {photoSync.summary.synchronized} verified
      </Text>
      {error || photoSync.error ? <Text style={styles.error}>{error || `Background sync: ${photoError(new Error(photoSync.error || ""))}`}</Text> : null}
      {stagedPhotos.length ? <View style={styles.stagedSection}>
        <Text style={styles.label}>{stagedPhotos.length} photo{stagedPhotos.length === 1 ? "" : "s"} saved inside HomeNode, waiting to be listed</Text>
        <Text style={styles.help}>These are in HomeNode's private device storage, not the iPhone Photos library. Keep the app installed.</Text>
        {stagedPhotos.map((photo) => <View key={photo.clientPhotoId} style={styles.photoCard}>
          <Image accessibilityLabel={photo.caption} source={{ uri: photo.objects.find((object) => object.variant === "display")?.uri || photo.objects[0]?.uri }} style={styles.preview} />
          <Text style={styles.stagedCaption}>{photo.caption}</Text>
        </View>)}
        <Action title="Recover saved photos" secondary disabled={busy || retrying} onPress={() => void recoverSavedPhotos()} />
      </View> : null}
      {online && (photoSync.summary.pending || photoSync.summary.failed) ? (
        <Action
          title={photoSync.summary.failed
            ? `Retry ${photoSync.summary.failed} failed photo${photoSync.summary.failed === 1 ? "" : "s"}`
            : `Upload ${photoSync.summary.pending} saved photo${photoSync.summary.pending === 1 ? "" : "s"}`}
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
  eyebrow: { color: COLORS.goldInk, fontSize: 11, fontWeight: "800", letterSpacing: 1.2 },
  title: { color: COLORS.deepPurple, fontSize: 25, fontWeight: "800" },
  count: { backgroundColor: COLORS.violetSoft, borderColor: COLORS.gold, borderRadius: 20, borderWidth: 1, color: COLORS.violet, fontWeight: "800", paddingHorizontal: 12, paddingVertical: 7 },
  help: { color: COLORS.muted, fontSize: 13, lineHeight: 19 },
  label: { color: COLORS.textPurple, fontSize: 13, fontWeight: "700", marginTop: 5 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  choice: { backgroundColor: COLORS.surface, borderColor: COLORS.borderStrong, borderRadius: 18, borderWidth: 1, paddingHorizontal: 11, paddingVertical: 8 },
  choiceSelected: { backgroundColor: COLORS.violet, borderColor: COLORS.violet },
  choiceText: { color: COLORS.textPurple, fontSize: 12, fontWeight: "600" },
  choiceSelectedText: { color: COLORS.white },
  actions: { gap: 8 },
  action: { alignItems: "center", backgroundColor: COLORS.violet, borderRadius: 11, minHeight: 48, justifyContent: "center", paddingHorizontal: 14 },
  actionSecondary: { backgroundColor: COLORS.surface, borderColor: COLORS.gold, borderWidth: 1 },
  actionText: { color: COLORS.white, fontSize: 14, fontWeight: "800" },
  actionSecondaryText: { color: COLORS.deepPurple },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.8 },
  progress: { alignItems: "center", flexDirection: "row", gap: 8 },
  syncLine: { color: COLORS.success, fontSize: 12, fontWeight: "700" },
  error: { backgroundColor: COLORS.dangerSoft, borderRadius: 8, color: COLORS.danger, padding: 10 },
  stagedSection: { backgroundColor: COLORS.goldSoft, borderColor: COLORS.gold, borderRadius: 12, borderWidth: 1, gap: 10, padding: 12 },
  stagedCaption: { color: COLORS.deepPurple, fontSize: 13, fontWeight: "700", padding: 10 },
  list: { gap: 12 },
  photoCard: { backgroundColor: COLORS.surface, borderColor: COLORS.border, borderRadius: 13, borderWidth: 1, overflow: "hidden" },
  preview: { aspectRatio: 4 / 3, backgroundColor: COLORS.surfaceMuted, width: "100%" },
  previewUnavailable: { alignItems: "center", justifyContent: "center" },
  previewUnavailableText: { color: COLORS.muted, fontSize: 12, fontWeight: "700" },
  photoBody: { gap: 9, padding: 12 },
  photoTitle: { color: COLORS.deepPurple, flex: 1, fontSize: 16, fontWeight: "800" },
  photoError: { backgroundColor: COLORS.dangerSoft, borderRadius: 8, color: COLORS.danger, fontSize: 12, lineHeight: 18, padding: 9 },
  state: { backgroundColor: COLORS.violetSoft, borderRadius: 12, color: COLORS.violet, fontSize: 10, fontWeight: "800", overflow: "hidden", paddingHorizontal: 8, paddingVertical: 4 },
  stateFailed: { backgroundColor: COLORS.dangerSoft, color: COLORS.danger },
  caption: { backgroundColor: COLORS.surfaceMuted, borderColor: COLORS.border, borderRadius: 8, borderWidth: 1, minHeight: 43, paddingHorizontal: 10 },
  row: { flexDirection: "row", gap: 20 },
  rowBetween: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  link: { color: COLORS.violet, fontSize: 13, fontWeight: "800" },
  removeLink: { color: COLORS.danger, fontSize: 13, fontWeight: "800" },
  retention: { color: COLORS.muted, fontSize: 11 },
  cleanLink: { color: COLORS.muted, fontSize: 12, fontWeight: "700", textDecorationLine: "underline" },
  retentionNote: { backgroundColor: COLORS.goldSoft, borderRadius: 9, color: COLORS.goldInk, fontSize: 11, lineHeight: 17, padding: 10 },
});
