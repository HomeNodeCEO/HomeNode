import { lazy, Suspense, useState } from 'react';

import type {
  AppraisalAssignmentFile,
  AssignmentDocumentApplication,
} from '@/lib/api';

const AppraisalWorkfileModal = lazy(() => import('@/components/AppraisalWorkfileModal'));

interface Props {
  accountId: string;
  assignmentFile: AppraisalAssignmentFile | null;
  getEditorKey: () => string;
  onAssignmentApplied: (application: AssignmentDocumentApplication) => void;
  subjectAddress: string;
}

export default function AppraisalWorkfileLauncher({
  accountId,
  assignmentFile,
  getEditorKey,
  onAssignmentApplied,
  subjectAddress,
}: Props) {
  const [open, setOpen] = useState(false);
  return <>
    <button
      type="button"
      className="hn-action-gold btn btn-sm normal-case rounded-lg shadow-sm"
      onClick={() => setOpen(true)}
      disabled={!assignmentFile}
    >
      Workfile
    </button>
    {open && assignmentFile ? <Suspense fallback={null}>
      <AppraisalWorkfileModal
        accountId={accountId}
        assignmentFileId={assignmentFile.id}
        fileNumber={assignmentFile.file_number}
        getEditorKey={getEditorKey}
        onClose={() => setOpen(false)}
        onCustomAssignmentApplied={onAssignmentApplied}
        open
        subjectAddress={subjectAddress}
      />
    </Suspense> : null}
  </>;
}
