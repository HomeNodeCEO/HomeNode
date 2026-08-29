import * as Network from "expo-network";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { ApiError, type MobileApi, type UadEntityProposalRequest } from "../api/client";
import { networkAvailable } from "./model";
import { OfflineStore, type QueueSummary } from "./store";

const EMPTY_SUMMARY: QueueSummary = { pending: 0, conflicts: 0, synchronized: 0 };

export async function synchronizeDueOperations(store: OfflineStore, api: MobileApi, ownerUserId: string) {
  await store.ensureReady();
  const [rows, entityRows] = await Promise.all([
    store.dueOperations(ownerUserId),
    store.dueUadEntityProposals(ownerUserId),
  ]);
  if (!rows.length && !entityRows.length) return;
  if (entityRows.length) {
    await store.markUadEntityProposalsUploading(entityRows.map((row) => row.client_operation_id));
    const refreshedSessions = new Set<string>();
    for (const row of entityRows) {
      try {
        const request = JSON.parse(row.request_json) as UadEntityProposalRequest;
        await api.createUadEntityProposal(row.session_id, request);
        await store.completeUadEntityProposal(ownerUserId, row.client_operation_id);
        refreshedSessions.add(row.session_id);
      } catch (reason) {
        const code = reason instanceof ApiError
          ? reason.code
          : reason instanceof Error ? reason.message : "uad_entity_sync_failed";
        await store.failUadEntityProposal(row, code);
      }
    }
    for (const sessionId of refreshedSessions) {
      try {
        await store.cacheUadEntityReview(ownerUserId, sessionId, await api.uadEntityReview(sessionId));
      } catch {
        // The proposal is durable on the server; the panel will retry this read when opened.
      }
    }
  }
  const sessions = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = sessions.get(row.session_id) || [];
    group.push(row);
    sessions.set(row.session_id, group);
  }
  for (const [sessionId, group] of sessions) {
    await store.markUploading(group.map((row) => row.client_operation_id));
    try {
      const response = await api.syncInspection(
        sessionId,
        group.map((row) => store.operationRequest(row)),
      );
      await store.applySyncResponse(ownerUserId, response);
      const snapshot = await api.inspectionSnapshot(sessionId);
      await store.applySnapshot(ownerUserId, snapshot);
    } catch (reason) {
      const code = reason instanceof ApiError
        ? reason.code
        : reason instanceof Error ? reason.message : "sync_failed";
      await store.recordFailure(group, code);
    }
  }
}

export function useOfflineSync(store: OfflineStore | null, api: MobileApi, ownerUserId: string | null) {
  const network = Network.useNetworkState();
  const [summary, setSummary] = useState<QueueSummary>(EMPTY_SUMMARY);
  const [syncing, setSyncing] = useState(false);
  const activeSync = useRef<Promise<void> | null>(null);
  const online = networkAvailable(network);

  const refresh = useCallback(async () => {
    if (!store || !ownerUserId) return;
    setSummary(await store.queueSummary(ownerUserId));
  }, [ownerUserId, store]);

  const syncNow = useCallback(async () => {
    if (!store || !ownerUserId || !online) return;
    if (!activeSync.current) {
      setSyncing(true);
      activeSync.current = synchronizeDueOperations(store, api, ownerUserId)
        .finally(() => {
          activeSync.current = null;
          setSyncing(false);
        });
    }
    await activeSync.current;
    await refresh();
  }, [api, online, ownerUserId, refresh, store]);

  useEffect(() => { void refresh().catch(() => undefined); }, [refresh]);
  useEffect(() => {
    if (online) void syncNow().catch(() => undefined);
  }, [online, syncNow]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (online && AppState.currentState === "active") void syncNow().catch(() => undefined);
    }, 15_000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && online) {
        void store?.ensureReady().then(syncNow).catch(() => undefined);
      }
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [online, syncNow]);

  return { online, refresh, summary, syncing, syncNow };
}

