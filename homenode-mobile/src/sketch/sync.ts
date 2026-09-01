import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, type MobileApi } from "../api/client";
import { type LocalSketchDraft, OfflineStore } from "../offline/store";
import { emptySyncLaneResult, recordSyncFailure } from "../offline/syncPolicy";
import { toSketchApiDocument } from "./model";

export async function synchronizeDueSketches(
  store: OfflineStore,
  api: MobileApi,
  ownerUserId: string,
  sessionId?: string,
) {
  const drafts = await store.dueSketchDrafts(ownerUserId, sessionId);
  const result = emptySyncLaneResult();
  for (const draft of drafts) {
    result.attempted += 1;
    await store.markSketchSynchronizing(ownerUserId, draft.sessionId);
    try {
      const response = await api.saveInspectionSketch(draft.sessionId, {
        clientOperationId: draft.clientOperationId,
        clientSketchId: draft.clientSketchId,
        baseRevision: draft.baseRevision,
        sketch: toSketchApiDocument(draft.draft),
      });
      await store.applyServerSketch(ownerUserId, draft.sessionId, response.sketch);
      result.succeeded += 1;
    } catch (reason) {
      const code = reason instanceof ApiError
        ? reason.code
        : reason instanceof Error ? reason.message : "sketch_sync_failed";
      if (code === "sketch_revision_conflict") {
        try {
          const current = await api.inspectionSketch(draft.sessionId);
          if (current.sketch) {
            await store.markSketchConflict(ownerUserId, draft.sessionId, current.sketch);
            result.permanentFailures += 1;
            continue;
          }
        } catch {
          // Preserve the original conflict when the follow-up read is unavailable.
        }
      }
      recordSyncFailure(result, reason);
      await store.recordSketchFailure(ownerUserId, draft, code);
    }
  }
  return result;
}

export function useSketchSync(
  store: OfflineStore,
  ownerUserId: string,
  sessionId: string,
  online: boolean,
  synchronize: () => Promise<void>,
) {
  const [draft, setDraft] = useState<LocalSketchDraft | null>(null);
  const [syncing, setSyncing] = useState(false);
  const active = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    setDraft(await store.sketchDraft(ownerUserId, sessionId));
  }, [ownerUserId, sessionId, store]);

  const syncNow = useCallback(async () => {
    if (!online) return;
    if (!active.current) {
      setSyncing(true);
      active.current = synchronize().finally(() => {
        active.current = null;
        setSyncing(false);
      });
    }
    await active.current;
    await refresh();
  }, [online, refresh, synchronize]);

  useEffect(() => { void refresh(); }, [refresh]);

  return { draft, refresh, syncing, syncNow };
}
