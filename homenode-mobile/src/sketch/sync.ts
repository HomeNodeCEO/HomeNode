import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, type MobileApi } from "../api/client";
import { type LocalSketchDraft, OfflineStore } from "../offline/store";
import { preserveSketchAreaLabelOffsets, toSketchApiDocument } from "./model";

export async function synchronizeDueSketches(
  store: OfflineStore,
  api: MobileApi,
  ownerUserId: string,
  sessionId?: string,
) {
  const database = <T>(operation: () => Promise<T>) => store.withDatabaseActivity(operation);
  const drafts = await database(() => store.dueSketchDrafts(ownerUserId, sessionId));
  for (const draft of drafts) {
    await database(() => store.markSketchSynchronizing(ownerUserId, draft.sessionId));
    try {
      const response = await api.saveInspectionSketch(draft.sessionId, {
        clientOperationId: draft.clientOperationId,
        clientSketchId: draft.clientSketchId,
        baseRevision: draft.baseRevision,
        sketch: toSketchApiDocument(draft.draft),
      });
      await database(() => store.applyServerSketch(ownerUserId, draft.sessionId, {
        ...response.sketch,
        document: preserveSketchAreaLabelOffsets(response.sketch.document, draft.draft),
      }));
    } catch (reason) {
      const code = reason instanceof ApiError
        ? reason.code
        : reason instanceof Error ? reason.message : "sketch_sync_failed";
      if (code === "sketch_revision_conflict") {
        try {
          const current = await api.inspectionSketch(draft.sessionId);
          const currentSketch = current.sketch;
          if (currentSketch) {
            await database(() => store.markSketchConflict(ownerUserId, draft.sessionId, currentSketch));
            continue;
          }
        } catch {
          // Preserve the original conflict when the follow-up read is unavailable.
        }
      }
      await database(() => store.recordSketchFailure(ownerUserId, draft, code));
    }
  }
}

export function useSketchSync(
  store: OfflineStore,
  api: MobileApi,
  ownerUserId: string,
  sessionId: string,
  online: boolean,
) {
  const [draft, setDraft] = useState<LocalSketchDraft | null>(null);
  const [syncing, setSyncing] = useState(false);
  const active = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    setDraft(await store.withDatabaseActivity(() => store.sketchDraft(ownerUserId, sessionId)));
  }, [ownerUserId, sessionId, store]);

  const syncNow = useCallback(async () => {
    if (!online) return;
    if (!active.current) {
      setSyncing(true);
      active.current = synchronizeDueSketches(store, api, ownerUserId, sessionId).finally(() => {
        active.current = null;
        setSyncing(false);
      });
    }
    await active.current;
    await refresh();
  }, [api, online, ownerUserId, refresh, sessionId, store]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (online) void syncNow(); }, [online, syncNow]);

  return { draft, refresh, syncing, syncNow };
}
