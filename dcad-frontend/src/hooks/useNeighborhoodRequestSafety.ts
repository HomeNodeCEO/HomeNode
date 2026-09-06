import { useCallback, useEffect, useRef } from "react";
import type { AssignmentDetailsPayload } from "@/lib/api";

type Channel = "boundary" | "relevance";
type ChangeAssignment = <K extends keyof AssignmentDetailsPayload>(key: K, value: AssignmentDetailsPayload[K]) => void;

function analyticalContext(draft: AssignmentDetailsPayload, previous: { identity: string; geometry: unknown }) {
  const identity = JSON.stringify([
    draft.neighborhood_boundary_engine_assessment_id,
    draft.neighborhood_boundary_engine_assignment_file_id,
    draft.neighborhood_boundary_engine_methodology_version,
    draft.neighborhood_boundary_engine_disclosure,
    draft.neighborhood_boundary_engine_warnings,
  ]);
  // A narrative edit does not replace the analytical envelope. Track observed
  // engine geometry as well as IDs; this is a request guard, not historical identity.
  const geometry = /^neighborhood_boundary_engine_v\d+$/i.test(String(draft.neighborhood_boundary_source || ""))
    ? draft.neighborhood_boundary_geometry
    : identity === previous.identity ? previous.geometry : null;
  return { identity, geometry, key: JSON.stringify([identity, geometry]) };
}

export function useNeighborhoodRequestSafety(
  accountId: string | undefined,
  assignmentFileId: number | null | undefined,
  draft: AssignmentDetailsPayload,
  changeAssignment: ChangeAssignment,
) {
  const scopeKey = JSON.stringify([accountId || "", assignmentFileId ?? null]);
  const currentDraft = useRef(draft);
  const receivedDraft = useRef(draft);
  const scope = useRef(scopeKey);
  const context = useRef(analyticalContext(draft, { identity: "", geometry: null }));
  const epoch = useRef(0);
  const mounted = useRef(true);
  const sequences = useRef({ boundary: 0, relevance: 0 });
  const updateContext = useCallback((value: AssignmentDetailsPayload) => {
    const next = analyticalContext(value, context.current);
    if (next.key !== context.current.key) epoch.current += 1;
    context.current = next;
  }, []);
  if (scope.current !== scopeKey) {
    scope.current = scopeKey;
    epoch.current += 1;
    context.current = analyticalContext(draft, { identity: "", geometry: null });
    currentDraft.current = draft;
    receivedDraft.current = draft;
  } else if (receivedDraft.current !== draft) {
    receivedDraft.current = draft;
    currentDraft.current = draft;
    updateContext(draft);
  }
  const onAssignmentChange = useCallback<ChangeAssignment>((key, value) => {
    currentDraft.current = { ...currentDraft.current, [key]: value };
    updateContext(currentDraft.current);
    changeAssignment(key, value);
  }, [changeAssignment, updateContext]);
  const begin = useCallback((channel: Channel) => {
    const startedEpoch = epoch.current;
    const sequence = ++sequences.current[channel];
    return () => mounted.current && epoch.current === startedEpoch && sequences.current[channel] === sequence;
  }, []);
  const invalidate = useCallback((channel: Channel) => {
    sequences.current[channel] += 1;
  }, []);
  const currentContextKey = useCallback(() => context.current.key, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; epoch.current += 1; };
  }, []);
  return { currentDraft, onAssignmentChange, begin, invalidate, currentContextKey, scopeKey, contextKey: context.current.key };
}
