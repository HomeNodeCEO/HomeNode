import * as Crypto from "expo-crypto";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import {
  ApiError,
  type CustomAppraisalFieldDefinition,
  type CustomAppraisalReview,
  type CustomAppraisalProposal,
  type MobileApi,
} from "../api/client";
import type { FieldState, JsonValue } from "../offline/model";
import type { OfflineStore } from "../offline/store";
import { COLORS } from "../theme";
import { customAppraisalFieldChange } from "./model";

function errorMessage(reason: unknown) {
  const code = reason instanceof ApiError ? reason.code : reason instanceof Error ? reason.message : "request_failed";
  return code.replaceAll("_", " ");
}

function stateLabel(state: FieldState | null) {
  if (!state || !state.exists) return "Not recorded";
  if (typeof state.value === "boolean") return state.value ? "Yes" : "No";
  return String(state.value);
}

function valueAtPath(value: Record<string, JsonValue>, path: string[]): FieldState {
  let current: JsonValue = value;
  for (const part of path) {
    if (current === null || Array.isArray(current) || typeof current !== "object" || !Object.hasOwn(current, part)) {
      return { exists: false };
    }
    current = current[part] as JsonValue;
  }
  return { exists: true, value: current };
}

function reportState(review: CustomAppraisalReview, field: CustomAppraisalFieldDefinition) {
  const section = review.sections[field.section_key];
  return section ? valueAtPath(section.value, field.target_path) : { exists: false } satisfies FieldState;
}

function editableValue(state: FieldState) {
  if (!state.exists) return "";
  if (typeof state.value === "boolean") return state.value ? "true" : "false";
  return String(state.value ?? "");
}

function ActionButton({ title, onPress, secondary = false, disabled = false }: {
  title: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.buttonSecondary,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Text style={[styles.buttonText, secondary && styles.buttonSecondaryText]}>{title}</Text>
    </Pressable>
  );
}

function ProposalCard({ proposal, busy, onReview }: {
  proposal: CustomAppraisalProposal;
  busy: boolean;
  onReview: (proposal: CustomAppraisalProposal, decision: "accept" | "reject") => void;
}) {
  const isConflict = proposal.status === "conflict";
  return (
    <View style={[styles.reviewCard, isConflict && styles.conflictCard]}>
      <View style={styles.rowBetween}>
        <Text style={styles.cardTitle}>{proposal.label}</Text>
        <Text style={styles.badge}>{proposal.status}</Text>
      </View>
      <Text style={styles.meta}>Inspection value</Text>
      <Text style={styles.value}>{stateLabel(proposal.proposed)}</Text>
      <Text style={styles.meta}>Value when observation was prepared</Text>
      <Text style={styles.value}>{stateLabel(proposal.base)}</Text>
      {isConflict ? <>
        <Text style={styles.warning}>The report changed after this observation was prepared. Nothing was overwritten.</Text>
        <Text style={styles.meta}>Current report value</Text>
        <Text style={styles.value}>{stateLabel(proposal.current)}</Text>
      </> : <>
        <ActionButton title="Accept into this appraisal file" disabled={busy} onPress={() => onReview(proposal, "accept")} />
        <ActionButton title="Keep inspection-only" secondary disabled={busy} onPress={() => onReview(proposal, "reject")} />
      </>}
      <Text style={styles.provenance}>{proposal.source_type} · appraiser {proposal.appraiser_confirmed ? "confirmed" : "not confirmed"}</Text>
    </View>
  );
}

export function CustomAppraisalPanel({ api, store, ownerUserId, sessionId, online, onSync }: {
  api: MobileApi;
  store: OfflineStore;
  ownerUserId: string;
  sessionId: string;
  online: boolean;
  onSync: () => Promise<void>;
}) {
  const [review, setReview] = useState<CustomAppraisalReview | null>(null);
  const [group, setGroup] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cacheAndSet = useCallback(async (next: CustomAppraisalReview) => {
    await store.cacheCustomAppraisalReview(ownerUserId, sessionId, next);
    setReview(next);
  }, [ownerUserId, sessionId, store]);

  const load = useCallback(async () => {
    const cached = await store.cachedCustomAppraisalReview(ownerUserId, sessionId);
    if (cached) setReview(cached);
    if (!online) return;
    const current = await api.customAppraisalReview(sessionId);
    await cacheAndSet(current);
  }, [api, cacheAndSet, online, ownerUserId, sessionId, store]);

  useEffect(() => {
    void load().catch((reason) => setError(errorMessage(reason)));
  }, [load]);

  const fields = useMemo(
    () => (review?.catalog || []).filter((field) => field.field_path !== "inspection.general.appraiser_comments"),
    [review],
  );
  const groups = useMemo(() => [...new Set(fields.map((field) => field.group))], [fields]);
  const selectedGroup = group && groups.includes(group) ? group : groups[0] || null;
  const groupFields = fields.filter((field) => field.group === selectedGroup);

  useEffect(() => {
    if (!review || !fields.length) return;
    void (async () => {
      const drafts = await store.fieldDraftValues(ownerUserId, sessionId, fields.map((field) => field.field_path));
      setValues((prior) => {
        const next = { ...prior };
        for (const field of fields) {
          if (touched.has(field.field_path)) continue;
          const draft = drafts[field.field_path];
          const state = draft && (draft.state.exists || draft.syncState !== "synchronized")
            ? draft.state
            : reportState(review, field);
          next[field.field_path] = editableValue(state);
        }
        return next;
      });
    })();
  }, [fields, ownerUserId, review, sessionId, store, touched]);

  const change = (fieldPath: string, value: string) => {
    setValues((prior) => ({ ...prior, [fieldPath]: value }));
    setTouched((prior) => new Set(prior).add(fieldPath));
  };

  const saveGroup = async () => {
    const changedFields = groupFields.filter((field) => touched.has(field.field_path));
    if (!changedFields.length) {
      setError("Change or clear at least one field in this section before saving.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const changes: Record<string, FieldState> = {};
      for (const field of changedFields) {
        changes[field.field_path] = customAppraisalFieldChange(field, values[field.field_path] || "");
      }
      await store.queueFieldChanges(ownerUserId, sessionId, changes);
      setTouched((prior) => {
        const next = new Set(prior);
        changedFields.forEach((field) => next.delete(field.field_path));
        return next;
      });
      if (online) {
        await onSync();
        const refreshed = await api.refreshCustomAppraisalProposals(sessionId);
        if (refreshed.invalid_fields.length) {
          throw new Error(refreshed.invalid_fields.map((item) => `${item.field_path}: ${item.error}`).join("; "));
        }
        await cacheAndSet(await api.customAppraisalReview(sessionId));
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const synchronizeForReview = async () => {
    if (!online) return;
    setBusy(true);
    setError(null);
    try {
      await onSync();
      const refreshed = await api.refreshCustomAppraisalProposals(sessionId);
      if (refreshed.invalid_fields.length) {
        throw new Error(refreshed.invalid_fields.map((item) => `${item.field_path}: ${item.error}`).join("; "));
      }
      await cacheAndSet(await api.customAppraisalReview(sessionId));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const reviewProposal = async (proposal: CustomAppraisalProposal, decision: "accept" | "reject") => {
    setBusy(true);
    setError(null);
    try {
      await api.reviewCustomAppraisalProposal(sessionId, proposal.id, decision, Crypto.randomUUID());
      await cacheAndSet(await api.customAppraisalReview(sessionId));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const actionable = (review?.proposals || []).filter((proposal) => ["pending", "conflict"].includes(proposal.status));
  if (!review) return (
    <View style={styles.panel}>
      <Text style={styles.title}>Custom Appraisal data</Text>
      <Text style={styles.muted}>{online ? "Loading this appraisal file…" : "Connect once to download the appraisal fields for offline use."}</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Custom Appraisal data</Text>
      <Text style={styles.muted}>Edits save to the device first. Each synchronized observation must be accepted before it changes this appraisal file.</Text>
      <View style={styles.summary}>
        <Text style={styles.summaryValue}>{actionable.filter((item) => item.status === "pending").length}{"\n"}<Text style={styles.summaryLabel}>awaiting review</Text></Text>
        <Text style={styles.summaryValue}>{review.photos.verified_count}{"\n"}<Text style={styles.summaryLabel}>verified photos</Text></Text>
        <Text style={styles.summaryValue}>v{review.report_file.registry_revision}{"\n"}<Text style={styles.summaryLabel}>file revision</Text></Text>
      </View>

      <Text style={styles.sectionTitle}>Property characteristics</Text>
      <View style={styles.groupTabs}>{groups.map((item) => (
        <Pressable key={item} onPress={() => setGroup(item)} style={[styles.groupTab, selectedGroup === item && styles.groupTabSelected]}>
          <Text style={[styles.groupTabText, selectedGroup === item && styles.groupTabTextSelected]}>{item}</Text>
        </Pressable>
      ))}</View>

      <View style={styles.fieldList}>{groupFields.map((field) => (
        <View key={field.field_path}>
          <View style={styles.rowBetween}>
            <Text style={styles.label}>{field.label}</Text>
            {touched.has(field.field_path) ? <Text style={styles.changed}>changed</Text> : null}
          </View>
          {field.value_type === "boolean" ? <View style={styles.booleanRow}>
            {[{ label: "Yes", value: "true" }, { label: "No", value: "false" }, { label: "Clear", value: "" }].map((choice) => (
              <Pressable
                key={choice.label}
                onPress={() => change(field.field_path, choice.value)}
                style={[styles.booleanChoice, values[field.field_path] === choice.value && styles.booleanChoiceSelected]}
              ><Text>{choice.label}</Text></Pressable>
            ))}
          </View> : <TextInput
            keyboardType={["number", "integer"].includes(field.value_type) ? "decimal-pad" : "default"}
            multiline={field.multiline}
            onChangeText={(value) => change(field.field_path, value)}
            placeholder="Not recorded"
            style={[styles.input, field.multiline && styles.multiline]}
            textAlignVertical={field.multiline ? "top" : "center"}
            value={values[field.field_path] || ""}
          />}
        </View>
      ))}</View>
      <ActionButton title={busy ? "Saving…" : `Save ${selectedGroup || "section"} offline`} disabled={busy} onPress={() => void saveGroup()} />
      {!online ? <Text style={styles.offline}>Offline · saved changes will remain inspection observations until synchronized and reviewed.</Text> : null}
      <ActionButton title={busy ? "Synchronizing…" : "Synchronize & refresh review"} secondary disabled={busy || !online} onPress={() => void synchronizeForReview()} />
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {actionable.length ? <View style={styles.reviewList}>
        <Text style={styles.sectionTitle}>Review before report update</Text>
        {actionable.map((proposal) => (
          <ProposalCard key={proposal.id} proposal={proposal} busy={busy} onReview={reviewProposal} />
        ))}
      </View> : <Text style={styles.complete}>No Custom Appraisal observations are awaiting review.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { marginTop: 30, gap: 12 },
  title: { color: COLORS.deepPurple, fontSize: 20, fontWeight: "800" },
  sectionTitle: { color: COLORS.deepPurple, fontSize: 17, fontWeight: "800", marginTop: 12 },
  muted: { color: COLORS.muted, fontSize: 14, lineHeight: 20 },
  summary: { flexDirection: "row", gap: 8 },
  summaryValue: { flex: 1, color: COLORS.deepPurple, backgroundColor: COLORS.violetSoft, borderRadius: 12, padding: 12, fontSize: 17, fontWeight: "800" },
  summaryLabel: { color: COLORS.muted, fontSize: 10, fontWeight: "600" },
  groupTabs: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  groupTab: { borderWidth: 1, borderColor: COLORS.borderStrong, backgroundColor: COLORS.surface, borderRadius: 20, paddingHorizontal: 11, paddingVertical: 8 },
  groupTabSelected: { borderColor: COLORS.gold, backgroundColor: COLORS.goldSoft },
  groupTabText: { color: COLORS.muted, fontSize: 12, fontWeight: "700" },
  groupTabTextSelected: { color: COLORS.deepPurple },
  fieldList: { gap: 14 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 },
  label: { color: COLORS.textPurple, fontSize: 13, fontWeight: "700" },
  changed: { color: COLORS.goldInk, fontSize: 11, fontWeight: "700" },
  input: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.borderStrong, borderRadius: 10, padding: 12, fontSize: 15, marginTop: 5 },
  multiline: { minHeight: 90 },
  booleanRow: { flexDirection: "row", gap: 8, marginTop: 6 },
  booleanChoice: { flex: 1, alignItems: "center", padding: 10, borderWidth: 1, borderColor: COLORS.borderStrong, borderRadius: 10, backgroundColor: COLORS.surface },
  booleanChoiceSelected: { borderColor: COLORS.gold, backgroundColor: COLORS.goldSoft },
  button: { backgroundColor: COLORS.violet, borderRadius: 11, paddingVertical: 13, paddingHorizontal: 14, alignItems: "center" },
  buttonSecondary: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.gold },
  buttonText: { color: COLORS.white, fontWeight: "800" },
  buttonSecondaryText: { color: COLORS.deepPurple },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.82 },
  reviewList: { gap: 10, marginTop: 10 },
  reviewCard: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border, borderRadius: 13, padding: 14, gap: 7 },
  conflictCard: { backgroundColor: COLORS.goldSoft, borderColor: COLORS.gold },
  cardTitle: { color: COLORS.deepPurple, fontSize: 15, fontWeight: "800", flex: 1 },
  badge: { color: COLORS.violet, backgroundColor: COLORS.violetSoft, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 14, overflow: "hidden", fontSize: 11, fontWeight: "700" },
  meta: { color: COLORS.muted, fontSize: 11, fontWeight: "700" },
  value: { color: COLORS.text, fontSize: 14 },
  provenance: { color: COLORS.mutedSoft, fontSize: 11 },
  warning: { color: COLORS.warning, lineHeight: 19 },
  offline: { color: COLORS.warning, backgroundColor: COLORS.warningSoft, borderRadius: 9, padding: 10, overflow: "hidden" },
  error: { color: COLORS.danger, backgroundColor: COLORS.dangerSoft, padding: 10, borderRadius: 9, overflow: "hidden" },
  complete: { color: COLORS.success, backgroundColor: COLORS.successSoft, padding: 11, borderRadius: 9, overflow: "hidden" },
});
