import * as Network from "expo-network";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { ApiError, type MobileApi, type UadEntityProposalRequest } from "../api/client";
import { synchronizeDuePhotos } from "../photos/sync";
import { synchronizeDueSketches } from "../sketch/sync";
import { networkAvailable } from "./model";
import {
  circuitAllowsSync,
  emptySyncLaneResult,
  initialSyncCircuit,
  MOBILE_SYNC_ACTIVE_INTERVAL_MS,
  recordSyncFailure,
  type SyncCircuitState,
  type SyncLane,
  type SyncLaneResult,
  updateSyncCircuit,
} from "./syncPolicy";
import { OfflineStore, type QueueSummary } from "./store";

const EMPTY_SUMMARY: QueueSummary = { pending: 0, conflicts: 0, synchronized: 0 };

export async function synchronizeDueOperations(store: OfflineStore, api: MobileApi, ownerUserId: string) {
  await store.ensureReady();
  const result = emptySyncLaneResult();
  const [rows, entityRows] = await Promise.all([
    store.dueOperations(ownerUserId),
    store.dueUadEntityProposals(ownerUserId),
  ]);
  if (!rows.length && !entityRows.length) return result;
  if (entityRows.length) {
    await store.markUadEntityProposalsUploading(entityRows.map((row) => row.client_operation_id));
    const refreshedSessions = new Set<string>();
    for (const row of entityRows) {
      result.attempted += 1;
      try {
        const request = JSON.parse(row.request_json) as UadEntityProposalRequest;
        await api.createUadEntityProposal(row.session_id, request);
        await store.completeUadEntityProposal(ownerUserId, row.client_operation_id);
        refreshedSessions.add(row.session_id);
        result.succeeded += 1;
      } catch (reason) {
        recordSyncFailure(result, reason);
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
    result.attempted += 1;
    await store.markUploading(group.map((row) => row.client_operation_id));
    try {
      const response = await api.syncInspection(
        sessionId,
        group.map((row) => store.operationRequest(row)),
      );
      await store.applySyncResponse(ownerUserId, response);
      result.succeeded += 1;
      try {
        const snapshot = await api.inspectionSnapshot(sessionId);
        await store.applySnapshot(ownerUserId, snapshot);
      } catch {
        // The write is durable; a later panel refresh can safely retrieve the snapshot.
      }
    } catch (reason) {
      recordSyncFailure(result, reason);
      const code = reason instanceof ApiError
        ? reason.code
        : reason instanceof Error ? reason.message : "sync_failed";
      await store.recordFailure(group, code);
    }
  }
  return result;
}

type MobileSyncResult = Record<SyncLane, SyncLaneResult>;

const ALL_SYNC_LANES: SyncLane[] = ["operations", "photos", "sketches"];

function freshCircuits(): Record<SyncLane, SyncCircuitState> {
  return {
    operations: initialSyncCircuit(),
    photos: initialSyncCircuit(),
    sketches: initialSyncCircuit(),
  };
}

export async function synchronizeDueMobileWork(
  store: OfflineStore,
  api: MobileApi,
  ownerUserId: string,
  enabledLanes: readonly SyncLane[] = ALL_SYNC_LANES,
): Promise<MobileSyncResult> {
  const enabled = new Set(enabledLanes);
  const [operations, photos, sketches] = await Promise.all([
    enabled.has("operations")
      ? synchronizeDueOperations(store, api, ownerUserId)
      : Promise.resolve(emptySyncLaneResult()),
    enabled.has("photos")
      ? synchronizeDuePhotos(store, api, ownerUserId)
      : Promise.resolve(emptySyncLaneResult()),
    enabled.has("sketches")
      ? synchronizeDueSketches(store, api, ownerUserId)
      : Promise.resolve(emptySyncLaneResult()),
  ]);
  return { operations, photos, sketches };
}

export function useOfflineSync(store: OfflineStore | null, api: MobileApi, ownerUserId: string | null) {
  const network = Network.useNetworkState();
  const [summary, setSummary] = useState<QueueSummary>(EMPTY_SUMMARY);
  const [syncing, setSyncing] = useState(false);
  const activeSync = useRef<Promise<void> | null>(null);
  const circuits = useRef<Record<SyncLane, SyncCircuitState>>(freshCircuits());
  const online = networkAvailable(network);

  const refresh = useCallback(async () => {
    if (!store || !ownerUserId) return;
    setSummary(await store.queueSummary(ownerUserId));
  }, [ownerUserId, store]);

  const runSync = useCallback(async (force: boolean) => {
    if (!store || !ownerUserId || !online) return;
    if (!activeSync.current) {
      const now = Date.now();
      const enabledLanes = ALL_SYNC_LANES.filter((lane) => (
        force || circuitAllowsSync(circuits.current[lane], now)
      ));
      if (enabledLanes.length) {
        setSyncing(true);
        activeSync.current = synchronizeDueMobileWork(store, api, ownerUserId, enabledLanes)
          .then((result) => {
            const completedAt = Date.now();
            for (const lane of enabledLanes) {
              circuits.current[lane] = updateSyncCircuit(circuits.current[lane], result[lane], completedAt);
            }
          })
          .finally(() => {
            activeSync.current = null;
            setSyncing(false);
          });
      }
    }
    if (activeSync.current) await activeSync.current;
    await refresh();
  }, [api, online, ownerUserId, refresh, store]);

  const syncNow = useCallback(() => runSync(false), [runSync]);
  const retryNow = useCallback(() => runSync(true), [runSync]);

  useEffect(() => { void refresh().catch(() => undefined); }, [refresh]);
  useEffect(() => {
    if (online) {
      circuits.current = freshCircuits();
      void retryNow().catch(() => undefined);
    }
  }, [online, retryNow]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (online && AppState.currentState === "active") void syncNow().catch(() => undefined);
    }, MOBILE_SYNC_ACTIVE_INTERVAL_MS);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && online) {
        void store?.ensureReady().then(retryNow).catch(() => undefined);
      }
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [online, retryNow, syncNow, store]);

  return { online, refresh, retryNow, summary, syncing, syncNow };
}

