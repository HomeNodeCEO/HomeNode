import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { loadCustomAppraisalWorkfile } from '@/lib/appraisalFileRequests';
import { loadCustomNeighborhoodAccepted } from './loadCustomNeighborhoodAccepted';
import type { AcceptedNeighborhoodState } from './customNeighborhoodAcceptedState';

/** Refresh only the accepted group after its validated server acknowledgement.
 * Never rehydrate unrelated assignment drafts or allow a late read to switch
 * the report currently displayed by the parent. */
export function useCustomNeighborhoodAcceptedReload(accountId: string | undefined,
  activeFile: RefObject<{ id: number } | null>, selectionGeneration: RefObject<number>,
  onLoaded: (value: AcceptedNeighborhoodState) => void, readGeneration: RefObject<number>) {
  const live = useRef(false), renderedAccount = useRef(accountId);
  renderedAccount.current = accountId;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  return useCallback(async () => {
    const file = activeFile.current, epoch = selectionGeneration.current;
    if (!live.current || !accountId || !file) return false;
    const read = ++readGeneration.current;
    const current = () => live.current && renderedAccount.current === accountId
      && selectionGeneration.current === epoch && activeFile.current?.id === file.id && readGeneration.current === read;
    const unavailable = () => { if (current()) onLoaded({ accountId, assignmentFileId: file.id, status: 'unavailable',
      assessment: null, message: 'The neighborhood was saved but its accepted group could not be refreshed. Reload the accepted group before continuing.' }); return false; };
    onLoaded({ accountId, assignmentFileId: file.id, status: 'loading', assessment: null,
      message: 'Reopening the saved neighborhood group…' });
    try {
      const saved = await loadCustomAppraisalWorkfile(accountId, file.id);
      if (!current()) return false;
      if (!saved.ok) return unavailable();
      const restored = await loadCustomNeighborhoodAccepted(accountId, file.id, saved.workfile.sections.neighborhood_assessment);
      if (!current()) return false;
      if (restored.status !== 'accepted') return unavailable();
      onLoaded(restored); return true;
    } catch { return unavailable(); }
  }, [accountId, activeFile, selectionGeneration, onLoaded, readGeneration]);
}
