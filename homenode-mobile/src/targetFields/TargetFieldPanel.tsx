import * as Crypto from "expo-crypto";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import {
  ApiError,
  type MobileApi,
  type TargetFieldDefinition,
  type TargetFieldProposal,
  type TargetFieldReview,
} from "../api/client";
import type { WorkflowType } from "../domain/workflows";
import type { FieldState } from "../offline/model";
import type { OfflineStore } from "../offline/store";
import { COLORS } from "../theme";
import { editableTargetValue, targetFieldChange, targetValueLabel } from "./model";

function errorMessage(reason: unknown) {
  const code = reason instanceof ApiError ? reason.code : reason instanceof Error ? reason.message : "request_failed";
  return code.replaceAll("_", " ");
}

function Action({ title, onPress, secondary = false, disabled = false }: {
  title: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, secondary && styles.buttonSecondary, disabled && styles.disabled, pressed && styles.pressed]}
    >
      <Text style={[styles.buttonText, secondary && styles.buttonSecondaryText]}>{title}</Text>
    </Pressable>
  );
}

function ProposalCard({ proposal, busy, onReview }: {
  proposal: TargetFieldProposal;
  busy: boolean;
  onReview: (proposal: TargetFieldProposal, decision: "accept" | "reject") => void;
}) {
  const conflict = proposal.status === "conflict";
  return (
    <View style={[styles.reviewCard, conflict && styles.conflictCard]}>
      <View style={styles.rowBetween}>
        <Text style={styles.cardTitle}>{proposal.label}</Text>
        <Text style={styles.badge}>{proposal.status}</Text>
      </View>
      <Text style={styles.meta}>{proposal.group}</Text>
      <Text style={styles.meta}>Current report value</Text>
      <Text style={styles.value}>{targetValueLabel(proposal.current || proposal.base)}</Text>
      <Text style={styles.meta}>Mobile observation</Text>
      <Text style={styles.value}>{targetValueLabel(proposal.proposed)}</Text>
      {conflict ? (
        <View style={styles.actions}>
          <Text style={styles.conflictText}>The canonical report changed after this observation was prepared. Enter and synchronize a deliberate replacement, or keep this observation out of the report.</Text>
          <Action title="Keep inspection-only" secondary disabled={busy} onPress={() => onReview(proposal, "reject")} />
        </View>
      ) : (
        <View style={styles.actions}>
          <Action title="Keep inspection-only" secondary disabled={busy} onPress={() => onReview(proposal, "reject")} />
          <Action title="Accept into report" disabled={busy} onPress={() => onReview(proposal, "accept")} />
        </View>
      )}
    </View>
  );
}

function FieldInput({ field, value, changed, onChange }: {
  field: TargetFieldDefinition;
  value: string;
  changed: boolean;
  onChange: (value: string) => void;
}) {
  const options = field.value_type === "boolean"
    ? [{ label: "Yes", value: "true" }, { label: "No", value: "false" }]
    : field.value_type === "enum"
      ? field.options.map((item) => ({ label: item, value: item }))
      : [];
  return (
    <View>
      <View style={styles.rowBetween}>
        <Text style={styles.label}>{field.label}{field.required ? " *" : ""}</Text>
        {changed ? <Text style={styles.changed}>changed</Text> : null}
      </View>
      {options.length ? (
        <View style={styles.choiceRow}>
          {options.map((option) => (
            <Pressable
              key={option.value}
              onPress={() => onChange(option.value)}
              style={[styles.choice, value === option.value && styles.choiceSelected]}
            ><Text style={styles.choiceText}>{option.label}</Text></Pressable>
          ))}
          {!field.required ? (
            <Pressable onPress={() => onChange("")} style={[styles.choice, value === "" && styles.choiceSelected]}>
              <Text style={styles.choiceText}>Clear</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <TextInput
          keyboardType={["number", "integer", "percentage"].includes(field.value_type) ? "decimal-pad" : "default"}
          multiline={field.multiline}
          onChangeText={onChange}
          placeholder={field.value_type === "measurement"
            ? `Amount Unit (${field.units.join(", ")})`
            : field.value_type === "multi_enum"
              ? `Comma separated: ${field.options.join(", ")}`
              : "Not recorded"}
          style={[styles.input, field.multiline && styles.multiline]}
          textAlignVertical={field.multiline ? "top" : "center"}
          value={value}
        />
      )}
    </View>
  );
}

export function TargetFieldPanel({ api, store, ownerUserId, sessionId, workflowType, online, onSync }: {
  api: MobileApi;
  store: OfflineStore;
  ownerUserId: string;
  sessionId: string;
  workflowType: Extract<WorkflowType, "uad_3_6" | "property_tax_protest">;
  online: boolean;
  onSync: () => Promise<void>;
}) {
  const [review, setReview] = useState<TargetFieldReview | null>(null);
  const [group, setGroup] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reviewOperationIds = useRef(new Map<string, string>());

  const cacheAndSet = useCallback(async (next: TargetFieldReview) => {
    await store.cacheTargetFieldReview(ownerUserId, sessionId, next);
    setReview(next);
  }, [ownerUserId, sessionId, store]);

  const load = useCallback(async () => {
    const cached = await store.cachedTargetFieldReview(ownerUserId, sessionId);
    if (cached) setReview(cached);
    if (!online) return;
    await cacheAndSet(await api.targetFieldReview(sessionId));
  }, [api, cacheAndSet, online, ownerUserId, sessionId, store]);

  useEffect(() => {
    void load().catch((reason) => setError(errorMessage(reason)));
  }, [load]);

  const fields = useMemo(() => review?.catalog || [], [review]);
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
          const state: FieldState = draft && (draft.state.exists || draft.syncState !== "synchronized")
            ? draft.state
            : review.values[field.field_path] || { exists: false };
          next[field.field_path] = editableTargetValue(state);
        }
        return next;
      });
    })();
  }, [fields, ownerUserId, review, sessionId, store, touched]);

  const change = (fieldPath: string, value: string) => {
    setValues((prior) => ({ ...prior, [fieldPath]: value }));
    setTouched((prior) => new Set(prior).add(fieldPath));
  };

  const refreshReview = async () => {
    await onSync();
    const refreshed = await api.refreshTargetFieldProposals(sessionId);
    if (refreshed.invalid_fields.length) {
      throw new Error(refreshed.invalid_fields.map((item) => `${item.field_path}: ${item.error}`).join("; "));
    }
    await cacheAndSet(await api.targetFieldReview(sessionId));
  };

  const saveGroup = async () => {
    const activeReview = review;
    if (!activeReview) return;
    const changedFields = groupFields.filter((field) => touched.has(field.field_path));
    if (!changedFields.length) {
      setError("Change or clear at least one field in this section before saving.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const changes: Record<string, FieldState> = {};
      for (const field of changedFields) changes[field.field_path] = targetFieldChange(field, values[field.field_path] || "");
      await store.queueFieldChanges(ownerUserId, sessionId, changes, {
        targetBaseStates: activeReview.values,
        targetBaseRevision: activeReview.target.revision,
      });
      setTouched((prior) => {
        const next = new Set(prior);
        changedFields.forEach((field) => next.delete(field.field_path));
        return next;
      });
      if (online) await refreshReview();
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
      await refreshReview();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const reviewProposal = async (proposal: TargetFieldProposal, decision: "accept" | "reject") => {
    const operationKey = `${proposal.id}:${decision}`;
    const clientOperationId = reviewOperationIds.current.get(operationKey) || Crypto.randomUUID();
    reviewOperationIds.current.set(operationKey, clientOperationId);
    setBusy(true);
    setError(null);
    try {
      await api.reviewTargetFieldProposal(sessionId, proposal.id, decision, clientOperationId);
      reviewOperationIds.current.delete(operationKey);
      await cacheAndSet(await api.targetFieldReview(sessionId));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const title = workflowType === "uad_3_6" ? "UAD 3.6 field inspection" : "Property Tax Protest inspection";
  const actionable = (review?.proposals || []).filter((proposal) => ["pending", "conflict"].includes(proposal.status));
  if (!review) return (
    <View style={styles.panel}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.muted}>{online ? "Loading the report field catalog…" : "Connect once to cache this report's fields for offline use."}</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.muted}>Fields save to encrypted device storage first. A synchronized observation changes the selected report only after explicit acceptance and an exact-value conflict check.</Text>
      <View style={styles.summary}>
        <Text style={styles.summaryValue}>{actionable.filter((item) => item.status === "pending").length}{"\n"}<Text style={styles.summaryLabel}>awaiting review</Text></Text>
        <Text style={styles.summaryValue}>{review.photos.verified_count}{"\n"}<Text style={styles.summaryLabel}>verified photos</Text></Text>
        <Text style={styles.summaryValue}>v{review.target.revision}{"\n"}<Text style={styles.summaryLabel}>target revision</Text></Text>
      </View>
      {workflowType === "uad_3_6" ? <Text style={styles.notice}>Official {review.target.specification_release_key || "UAD 3.6"} catalog · {review.entities.length} current report entities</Text> : null}

      <View style={styles.groupTabs}>{groups.map((item) => (
        <Pressable key={item} onPress={() => setGroup(item)} style={[styles.groupTab, selectedGroup === item && styles.groupTabSelected]}>
          <Text style={[styles.groupTabText, selectedGroup === item && styles.groupTabTextSelected]}>{item}</Text>
        </Pressable>
      ))}</View>
      <View style={styles.fieldList}>{groupFields.map((field) => (
        <FieldInput
          key={field.field_path}
          field={field}
          value={values[field.field_path] || ""}
          changed={touched.has(field.field_path)}
          onChange={(value) => change(field.field_path, value)}
        />
      ))}</View>
      <Action title={busy ? "Saving…" : `Save ${selectedGroup || "section"} offline`} disabled={busy} onPress={() => void saveGroup()} />
      {!online ? <Text style={styles.offline}>Offline · observations remain queued until the connection returns.</Text> : null}
      <Action title={busy ? "Synchronizing…" : "Synchronize & refresh review"} secondary disabled={busy || !online} onPress={() => void synchronizeForReview()} />
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {actionable.length ? <View style={styles.reviewList}>
        <Text style={styles.sectionTitle}>Review before report update</Text>
        {actionable.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} busy={busy} onReview={reviewProposal} />)}
      </View> : <Text style={styles.complete}>No observations are awaiting review.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { marginTop: 30, gap: 12 },
  title: { color: COLORS.deepPurple, fontSize: 20, fontWeight: "800" },
  sectionTitle: { color: COLORS.deepPurple, fontSize: 17, fontWeight: "800", marginTop: 12 },
  muted: { color: COLORS.muted, fontSize: 14, lineHeight: 20 },
  notice: { color: COLORS.success, backgroundColor: COLORS.successSoft, padding: 10, borderRadius: 10, fontSize: 12 },
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
  label: { color: COLORS.textPurple, fontSize: 13, fontWeight: "700", flex: 1 },
  changed: { color: COLORS.goldInk, fontSize: 11, fontWeight: "700" },
  input: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.borderStrong, borderRadius: 10, padding: 12, fontSize: 15, marginTop: 5 },
  multiline: { minHeight: 90 },
  choiceRow: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 6 },
  choice: { borderWidth: 1, borderColor: COLORS.borderStrong, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 9, backgroundColor: COLORS.surface },
  choiceSelected: { borderColor: COLORS.gold, backgroundColor: COLORS.goldSoft },
  choiceText: { color: COLORS.textPurple, fontSize: 12 },
  button: { backgroundColor: COLORS.violet, borderRadius: 11, paddingVertical: 13, paddingHorizontal: 14, alignItems: "center" },
  buttonSecondary: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.gold },
  buttonText: { color: COLORS.white, fontWeight: "800" },
  buttonSecondaryText: { color: COLORS.deepPurple },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.82 },
  actions: { gap: 7 },
  reviewList: { gap: 10, marginTop: 10 },
  reviewCard: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border, borderRadius: 13, padding: 14, gap: 7 },
  conflictCard: { backgroundColor: COLORS.goldSoft, borderColor: COLORS.gold },
  conflictText: { color: COLORS.goldInk, fontSize: 12, lineHeight: 18 },
  cardTitle: { color: COLORS.deepPurple, fontSize: 15, fontWeight: "800", flex: 1 },
  badge: { color: COLORS.violet, backgroundColor: COLORS.violetSoft, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 14, overflow: "hidden", fontSize: 11, fontWeight: "700" },
  meta: { color: COLORS.muted, fontSize: 11, fontWeight: "700" },
  value: { color: COLORS.text, fontSize: 14 },
  error: { color: COLORS.danger, backgroundColor: COLORS.dangerSoft, padding: 10, borderRadius: 10 },
  offline: { color: COLORS.warning, fontSize: 12 },
  complete: { color: COLORS.success, fontSize: 13, marginTop: 8 },
});
