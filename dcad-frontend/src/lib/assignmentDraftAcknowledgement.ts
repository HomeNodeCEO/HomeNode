import type { AssignmentDetailsPayload } from './api';
import { customAppraisalDraftsMatch, reconcileCustomAppraisalDraft, type CustomAppraisalAutosaveState } from './customAppraisalAutosave.ts';
import { cloneEditorValue } from './propertyReportAssignment.ts';

type Draft = AssignmentDetailsPayload;
type Ref<T> = { current: T };
type Reconciliation = ReturnType<typeof reconcileCustomAppraisalDraft<Draft>>;

interface Editor {
  assignmentDraftRef: Ref<Draft>;
  assignmentRenderedDraftRef: Ref<Draft>;
  assignmentSavedDraftRef: Ref<Draft>;
  assignmentDirtyRef: Ref<boolean>;
  assignmentFirstDirtyAtRef: Ref<number | null>;
  assignmentConflictKeysRef: Ref<string[]>;
  setAssignmentDraft: (value: Draft | ((current: Draft) => Draft)) => void;
  setAssignmentDirty: (value: boolean) => void;
  setAssignmentConflictKeys: (value: string[]) => void;
  setAssignmentAutosaveState: (value: CustomAppraisalAutosaveState) => void;
  setAssignmentSaveMessage: (value: string) => void;
}

/** Reconcile acknowledged saves without mistaking a not-yet-rendered server
 * acknowledgement for a local edit, or dropping edits queued before ref sync. */
export function createAssignmentDraftAcknowledgement(editor: Editor) {
  return ({ baseDraft, remoteDraft, canApply, message }: {
    baseDraft: Draft;
    remoteDraft: Draft;
    canApply: () => boolean;
    message: (conflicted: boolean, dirty: boolean) => string;
  }) => {
    const renderedDraft = cloneEditorValue(editor.assignmentRenderedDraftRef.current);
    const acknowledge = (reconciliation: Reconciliation) => {
      const draft = cloneEditorValue(reconciliation.rebased);
      const dirty = !customAppraisalDraftsMatch(draft, remoteDraft);
      const conflicted = reconciliation.conflictKeys.length > 0;
      editor.assignmentDraftRef.current = draft;
      editor.assignmentDirtyRef.current = dirty;
      editor.assignmentFirstDirtyAtRef.current = dirty ? editor.assignmentFirstDirtyAtRef.current || Date.now() : null;
      editor.setAssignmentDirty(dirty);
      editor.setAssignmentConflictKeys(reconciliation.conflictKeys);
      editor.setAssignmentAutosaveState(conflicted ? 'conflict' : dirty ? 'pending' : 'saved');
      editor.setAssignmentSaveMessage(message(conflicted, dirty));
      return { ...reconciliation, rebased: draft, dirty };
    };
    const initial = reconcileCustomAppraisalDraft(baseDraft, editor.assignmentDraftRef.current,
      remoteDraft, editor.assignmentConflictKeysRef.current);
    editor.assignmentSavedDraftRef.current = cloneEditorValue(remoteDraft);
    const result = acknowledge(initial);
    editor.setAssignmentDraft(current => {
      if (!canApply()) return current;
      // The rendered baseline is captured at response time, not from an old
      // async caller's closure. Layer only still-unrendered edits onto the ack.
      const latest = reconcileCustomAppraisalDraft(renderedDraft, current, result.rebased, editor.assignmentConflictKeysRef.current);
      return customAppraisalDraftsMatch(latest.rebased, result.rebased)
        && customAppraisalDraftsMatch(latest.conflictKeys, result.conflictKeys)
        ? result.rebased : acknowledge(latest).rebased;
    });
    return result;
  };
}
