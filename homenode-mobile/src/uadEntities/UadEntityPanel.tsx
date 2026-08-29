import * as Crypto from "expo-crypto";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import type {
  MobileApi,
  UadEntity,
  UadEntityGroup,
  UadEntityProposal,
  UadEntityReview,
} from "../api/client";
import type { OfflineStore } from "../offline/store";
import { COLORS } from "../theme";
import {
  entityDisplayLabel,
  entityMatchesGroup,
  parentCandidates,
  suggestedEntityLabel,
} from "./model";

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message.replaceAll("_", " ") : "UAD entity operation failed";
}

function Action({ title, onPress, disabled = false, secondary = false }: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return <Pressable
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [styles.button, secondary && styles.secondaryButton, disabled && styles.disabled, pressed && styles.pressed]}
  ><Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>{title}</Text></Pressable>;
}

function ProposalCard({ proposal, busy, onReview }: {
  proposal: UadEntityProposal;
  busy: boolean;
  onReview: (proposal: UadEntityProposal, decision: "accept" | "reject") => void;
}) {
  return <View style={[styles.card, proposal.status === "conflict" && styles.conflictCard]}>
    <Text style={styles.cardTitle}>{proposal.action === "create" ? "Add" : "Remove"} {proposal.label || proposal.entity_type.replaceAll("_", " ")}</Text>
    <Text style={styles.meta}>{proposal.status} · base UAD revision {proposal.base_target_revision}</Text>
    {proposal.conflict ? <Text style={styles.conflictText}>The underlying entity changed. Reject this proposal and capture the change again from the refreshed report.</Text> : null}
    {proposal.status === "pending" ? <Action title="Accept and update UAD report" disabled={busy} onPress={() => onReview(proposal, "accept")} /> : null}
    <Action title="Reject proposal" secondary disabled={busy} onPress={() => onReview(proposal, "reject")} />
  </View>;
}

export function UadEntityPanel({ api, store, ownerUserId, sessionId, online, onSync }: {
  api: MobileApi;
  store: OfflineStore;
  ownerUserId: string;
  sessionId: string;
  online: boolean;
  onSync: () => Promise<void>;
}) {
  const [review, setReview] = useState<UadEntityReview | null>(null);
  const [selectedKey, setSelectedKey] = useState("");
  const [label, setLabel] = useState("");
  const [parentId, setParentId] = useState("");
  const [localQueued, setLocalQueued] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reviewOperationIds = useRef(new Map<string, string>());

  const cacheAndSet = useCallback(async (next: UadEntityReview) => {
    await store.cacheUadEntityReview(ownerUserId, sessionId, next);
    setReview(next);
    setSelectedKey((prior) => prior || next.catalog.find((group) => group.create_enabled)?.key || "");
  }, [ownerUserId, sessionId, store]);

  const load = useCallback(async () => {
    const [cached, queued] = await Promise.all([
      store.cachedUadEntityReview(ownerUserId, sessionId),
      store.localUadEntityProposalCount(ownerUserId, sessionId),
    ]);
    if (cached) await cacheAndSet(cached);
    setLocalQueued(queued);
    if (online) await cacheAndSet(await api.uadEntityReview(sessionId));
  }, [api, cacheAndSet, online, ownerUserId, sessionId, store]);

  useEffect(() => { void load().catch((reason) => setError(errorMessage(reason))); }, [load]);

  const group = useMemo(
    () => review?.catalog.find((item) => item.key === selectedKey) || null,
    [review, selectedKey],
  );
  const parents = useMemo(
    () => group && review ? parentCandidates(review.entities, group) : [],
    [group, review],
  );
  const visibleEntities = useMemo(
    () => group && review ? review.entities.filter((entity) => entityMatchesGroup(entity, group)) : [],
    [group, review],
  );
  const proposals = (review?.proposals || []).filter((item) => ["pending", "conflict"].includes(item.status));

  useEffect(() => {
    if (!group) return;
    setLabel(suggestedEntityLabel(group, review?.entities || []));
    setParentId((prior) => parents.some((entity) => entity.id === prior)
      ? prior
      : parents.length === 1 ? parents[0]?.id || "" : "");
  }, [group, parents, review?.entities]);

  const queueCreate = async () => {
    if (!review || !group) return;
    if (group.parent_entity_types.length && !parentId) {
      setError("Choose the parent record before adding this item.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await store.queueUadEntityProposal(ownerUserId, sessionId, {
        client_operation_id: Crypto.randomUUID(),
        action: "create",
        entity_type: group.entity_type,
        ...(parentId ? { parent_entity_id: parentId } : {}),
        label: label.trim() || suggestedEntityLabel(group, review.entities),
        data: group.data,
        base_target_revision: review.target.revision,
      });
      setLocalQueued(await store.localUadEntityProposalCount(ownerUserId, sessionId));
      if (online) {
        await onSync();
        await load();
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const queueDelete = async (entity: UadEntity) => {
    if (!review) return;
    setBusy(true);
    setError(null);
    try {
      await store.queueUadEntityProposal(ownerUserId, sessionId, {
        client_operation_id: Crypto.randomUUID(),
        action: "delete",
        entity_type: entity.entity_type,
        target_entity_id: entity.id,
        base_target_revision: review.target.revision,
        base_entity: entity,
      });
      setLocalQueued(await store.localUadEntityProposalCount(ownerUserId, sessionId));
      if (online) {
        await onSync();
        await load();
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const reviewProposal = async (proposal: UadEntityProposal, decision: "accept" | "reject") => {
    const key = `${proposal.id}:${decision}`;
    const operationId = reviewOperationIds.current.get(key) || Crypto.randomUUID();
    reviewOperationIds.current.set(key, operationId);
    setBusy(true);
    setError(null);
    try {
      await api.reviewUadEntityProposal(sessionId, proposal.id, decision, operationId);
      reviewOperationIds.current.delete(key);
      await cacheAndSet(await api.uadEntityReview(sessionId));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const synchronizeQueued = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSync();
      await load();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  if (!review) return <View style={styles.panel}>
    <Text style={styles.title}>UAD 3.6 property components</Text>
    <Text style={styles.muted}>{online ? "Loading the official repeatable-item catalog…" : "Connect once to cache the UAD entity catalog for offline use."}</Text>
    {error ? <Text style={styles.error}>{error}</Text> : null}
  </View>;

  return <View style={styles.panel}>
    <Text style={styles.title}>UAD 3.6 property components</Text>
    <Text style={styles.muted}>Add rooms, levels, defects, amenities, outbuildings, vehicle storage, and other official repeatable records. Changes are queued offline and require explicit review before updating the report.</Text>
    <Text style={styles.notice}>UAD v{review.target.revision} · {review.entities.length} records · {localQueued} queued on device · {proposals.length} awaiting review</Text>
    <View style={styles.tabs}>{review.catalog.map((item) => <Pressable
      key={item.key}
      disabled={!item.create_enabled}
      onPress={() => setSelectedKey(item.key)}
      style={[styles.tab, selectedKey === item.key && styles.tabSelected, !item.create_enabled && styles.disabled]}
    ><Text style={[styles.tabText, selectedKey === item.key && styles.tabTextSelected]}>{item.title}</Text></Pressable>)}</View>
    {group ? <View style={styles.creator}>
      <Text style={styles.cardTitle}>{group.add_label}</Text>
      {parents.length ? <View style={styles.tabs}>{parents.map((entity) => <Pressable
        key={entity.id}
        onPress={() => setParentId(entity.id)}
        style={[styles.tab, parentId === entity.id && styles.tabSelected]}
      ><Text style={[styles.tabText, parentId === entity.id && styles.tabTextSelected]}>{entityDisplayLabel(entity)}</Text></Pressable>)}</View> : null}
      <TextInput value={label} onChangeText={setLabel} placeholder="Record label" style={styles.input} />
      <Action title={busy ? "Saving…" : online ? "Queue and synchronize" : "Save to offline queue"} disabled={busy} onPress={() => void queueCreate()} />
      <View style={styles.list}>{visibleEntities.map((entity) => <View style={styles.entityRow} key={entity.id}>
        <View style={styles.flex}><Text style={styles.cardTitle}>{entityDisplayLabel(entity)}</Text><Text style={styles.meta}>{entity.entity_type.replaceAll("_", " ")} · #{entity.ordinal}</Text></View>
        <Pressable disabled={busy} onPress={() => void queueDelete(entity)}><Text style={styles.remove}>Propose removal</Text></Pressable>
      </View>)}</View>
    </View> : null}
    {!online ? <Text style={styles.offline}>Offline · entity changes remain encrypted on this device until connectivity returns.</Text> : null}
    {online && localQueued ? <Action title="Synchronize queued entity changes" secondary disabled={busy} onPress={() => void synchronizeQueued()} /> : null}
    {error ? <Text style={styles.error}>{error}</Text> : null}
    {proposals.length ? <View style={styles.list}><Text style={styles.sectionTitle}>Review entity changes</Text>{proposals.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} busy={busy} onReview={reviewProposal} />)}</View> : null}
  </View>;
}

const styles = StyleSheet.create({
  panel: { marginTop: 30, gap: 12 },
  title: { color: COLORS.deepPurple, fontSize: 20, fontWeight: "800" },
  sectionTitle: { color: COLORS.deepPurple, fontSize: 17, fontWeight: "800", marginTop: 10 },
  muted: { color: COLORS.muted, fontSize: 14, lineHeight: 20 },
  notice: { color: COLORS.success, backgroundColor: COLORS.successSoft, padding: 10, borderRadius: 10, fontSize: 12 },
  tabs: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  tab: { borderWidth: 1, borderColor: COLORS.borderStrong, backgroundColor: COLORS.surface, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 8 },
  tabSelected: { borderColor: COLORS.gold, backgroundColor: COLORS.goldSoft },
  tabText: { color: COLORS.muted, fontSize: 11, fontWeight: "700" },
  tabTextSelected: { color: COLORS.deepPurple },
  creator: { backgroundColor: COLORS.violetSoft, borderColor: COLORS.border, borderRadius: 13, borderWidth: 1, padding: 13, gap: 10 },
  input: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.borderStrong, borderRadius: 10, padding: 12, fontSize: 15 },
  button: { backgroundColor: COLORS.violet, borderRadius: 11, paddingVertical: 13, paddingHorizontal: 14, alignItems: "center" },
  secondaryButton: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.gold },
  buttonText: { color: COLORS.white, fontWeight: "800" },
  secondaryButtonText: { color: COLORS.deepPurple },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.82 },
  list: { gap: 9 },
  card: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border, borderRadius: 13, padding: 13, gap: 7 },
  conflictCard: { backgroundColor: COLORS.goldSoft, borderColor: COLORS.gold },
  entityRow: { backgroundColor: COLORS.surface, borderColor: COLORS.divider, borderRadius: 10, borderWidth: 1, padding: 11, flexDirection: "row", alignItems: "center", gap: 10 },
  flex: { flex: 1 },
  cardTitle: { color: COLORS.deepPurple, fontSize: 14, fontWeight: "800" },
  meta: { color: COLORS.muted, fontSize: 11 },
  remove: { color: COLORS.danger, fontSize: 11, fontWeight: "700" },
  conflictText: { color: COLORS.goldInk, fontSize: 12, lineHeight: 18 },
  offline: { color: COLORS.warning, fontSize: 12 },
  error: { color: COLORS.danger, backgroundColor: COLORS.dangerSoft, padding: 10, borderRadius: 10 },
});
