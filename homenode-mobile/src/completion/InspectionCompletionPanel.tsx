import * as Crypto from "expo-crypto";
import React, { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";

import {
  ApiError,
  type InspectionCompletionReadiness,
  type InspectionSession,
  type MobileApi,
} from "../api/client";
import type { LocalInspectionCompletionReadiness } from "./model";
import type { OfflineStore } from "../offline/store";

type Props = {
  api: MobileApi;
  store: OfflineStore;
  ownerUserId: string;
  session: InspectionSession;
  online: boolean;
  onSync: () => Promise<void>;
  onCompleted: (session: InspectionSession) => Promise<void>;
};

function message(reason: unknown) {
  const code = reason instanceof ApiError
    ? reason.code
    : reason instanceof Error ? reason.message : "inspection_completion_failed";
  return code.replaceAll("_", " ");
}

function readinessFromError(reason: unknown) {
  if (!(reason instanceof ApiError) || !reason.details || typeof reason.details !== "object") return null;
  const readiness = (reason.details as { readiness?: unknown }).readiness;
  return readiness && typeof readiness === "object"
    ? readiness as InspectionCompletionReadiness
    : null;
}

function ActionButton({ title, onPress, disabled = false, secondary = false }: {
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
        styles.button,
        secondary && styles.secondaryButton,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>{title}</Text>
    </Pressable>
  );
}

function CheckRow({ label, passed, count }: { label: string; passed: boolean; count: number }) {
  return (
    <View style={styles.checkRow}>
      <Text style={[styles.checkMark, passed ? styles.passed : styles.blocked]}>{passed ? "Ready" : count ? String(count) : "Review"}</Text>
      <Text style={styles.checkLabel}>{label}</Text>
    </View>
  );
}

export function InspectionCompletionPanel({
  api,
  store,
  ownerUserId,
  session,
  online,
  onSync,
  onCompleted,
}: Props) {
  const [local, setLocal] = useState<LocalInspectionCompletionReadiness | null>(null);
  const [server, setServer] = useState<InspectionCompletionReadiness | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (syncFirst = false) => {
    setBusy(true);
    setError(null);
    try {
      if (syncFirst) {
        if (!online) throw new Error("online_connection_required");
        await onSync();
      }
      const nextLocal = await store.inspectionCompletionLocalReadiness(ownerUserId, session.id);
      const nextServer = online
        ? await api.inspectionCompletionReadiness(session.id)
        : null;
      setLocal(nextLocal);
      setServer(nextServer);
      if (nextServer?.completed && session.status !== "completed") {
        await store.cacheInspectionSession(ownerUserId, nextServer.session);
        await onCompleted(nextServer.session);
      }
      return { local: nextLocal, server: nextServer };
    } catch (reason) {
      const nextServer = readinessFromError(reason);
      if (nextServer) setServer(nextServer);
      setError(message(reason));
      return null;
    } finally {
      setBusy(false);
    }
  }, [api, online, onCompleted, onSync, ownerUserId, session.id, session.status, store]);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  const submit = async (readiness: InspectionCompletionReadiness) => {
    setBusy(true);
    setError(null);
    try {
      const response = await api.completeInspection(session.id, {
        clientOperationId: Crypto.randomUUID(),
        baseSessionRevision: readiness.session.revision,
      });
      setServer(response.readiness);
      await store.cacheInspectionSession(ownerUserId, response.session);
      await onCompleted(response.session);
    } catch (reason) {
      const nextServer = readinessFromError(reason);
      if (nextServer) setServer(nextServer);
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    const readiness = await refresh(true);
    if (!readiness) return;
    if (!readiness.local.ready || !readiness.server?.ready_to_complete) {
      setError("Resolve the remaining items before finishing this inspection.");
      return;
    }
    Alert.alert(
      "Finish inspection on site?",
      "This closes mobile capture and sends the file to desktop review. It does not sign or submit the appraisal report.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Finish inspection", onPress: () => void submit(readiness.server!) },
      ],
    );
  };

  const completed = session.status === "completed" || Boolean(server?.completed);
  const ready = Boolean(local?.ready && server?.ready_to_complete);

  return (
    <View style={styles.panel}>
      <Text style={styles.eyebrow}>ON-SITE COMPLETION</Text>
      <Text style={styles.title}>{completed ? "Inspection finished" : "Finish on site"}</Text>
      <Text style={styles.body}>
        {completed
          ? "Field capture is locked. The appraisal file remains available for desktop review, signing, and any separate submission workflow."
          : "HomeNode checks this device and the server before closing field capture. Finishing never signs or submits a report."}
      </Text>

      {local ? <View style={styles.group}>
        <Text style={styles.groupTitle}>This device</Text>
        {local.checks.map((check) => (
          <CheckRow key={check.key} label={check.label} passed={check.passed} count={check.openCount} />
        ))}
      </View> : null}

      {server ? <View style={styles.group}>
        <Text style={styles.groupTitle}>HomeNode file</Text>
        {server.checks.filter((check) => check.required).map((check) => (
          <CheckRow key={check.key} label={check.label} passed={check.passed} count={check.open_count} />
        ))}
      </View> : null}

      {!online && !completed ? <Text style={styles.warning}>Connect to the internet to perform the final server check.</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {!completed ? <>
        <ActionButton
          title={busy ? "Checking…" : "Sync and check readiness"}
          onPress={() => void refresh(true)}
          disabled={busy || !online}
          secondary
        />
        <ActionButton
          title={busy ? "Finishing…" : "Finish inspection on site"}
          onPress={() => void finish()}
          disabled={busy || !online || !ready}
        />
      </> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: "#ffffff", borderColor: "#b9cec2", borderWidth: 1, borderRadius: 16, padding: 18, marginTop: 28 },
  eyebrow: { color: "#547166", fontSize: 11, fontWeight: "800", letterSpacing: 1.4 },
  title: { color: "#17251f", fontSize: 22, fontWeight: "800", marginTop: 5 },
  body: { color: "#52675e", fontSize: 14, lineHeight: 21, marginTop: 8 },
  group: { borderTopColor: "#e1e8e4", borderTopWidth: 1, marginTop: 16, paddingTop: 12, gap: 8 },
  groupTitle: { color: "#17251f", fontSize: 15, fontWeight: "800", marginBottom: 2 },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  checkMark: { minWidth: 52, textAlign: "center", paddingHorizontal: 7, paddingVertical: 4, borderRadius: 12, overflow: "hidden", fontSize: 11, fontWeight: "800" },
  passed: { color: "#24543f", backgroundColor: "#deece5" },
  blocked: { color: "#805f19", backgroundColor: "#fff2ce" },
  checkLabel: { color: "#42574e", flex: 1, fontSize: 14, lineHeight: 19 },
  warning: { color: "#805f19", backgroundColor: "#fff2ce", padding: 10, borderRadius: 10, marginTop: 14 },
  error: { color: "#9d302a", backgroundColor: "#fbe8e5", padding: 10, borderRadius: 10, marginTop: 12 },
  button: { backgroundColor: "#1d5a43", borderRadius: 12, paddingVertical: 13, paddingHorizontal: 16, alignItems: "center", marginTop: 10 },
  secondaryButton: { backgroundColor: "#e0ece5", borderColor: "#a9c2b5", borderWidth: 1 },
  buttonText: { color: "#ffffff", fontSize: 15, fontWeight: "800" },
  secondaryButtonText: { color: "#1d5a43" },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.82 },
});
