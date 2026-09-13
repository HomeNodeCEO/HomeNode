import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';

import * as api from '@/lib/api';
import { parseCustomAssignmentFileId, selectCustomAssignmentFile, CUSTOM_ASSIGNMENT_REQUEST_ERROR } from '@/lib/customAssignmentNavigation';
import {
  loadAssignmentFiles,
  loadCustomAppraisalWorkfile,
} from '@/lib/appraisalFileRequests';

export function useAppraisalFileRequest() {
  const location = useLocation();
  return useMemo(() => {
    const params = new URLSearchParams(location.search);
    const propertyId = (params.get('propertyId') || '').trim();
    return {
      propertyId,
      requestedFileId: parseCustomAssignmentFileId(location.search),
    };
  }, [location.search]);
}

export async function loadAppraisalFileContext(
  propertyId: string,
  requestedFileId: number | null | undefined,
) {
  if (!propertyId.trim() || requestedFileId === null) throw new Error(CUSTOM_ASSIGNMENT_REQUEST_ERROR);
  const files = await loadAssignmentFiles(propertyId);
  const assignmentFile = selectCustomAssignmentFile(files, propertyId, requestedFileId);
  const [property, workfileResult] = await Promise.all([
    api.getAccount(propertyId, { assignmentFileId: assignmentFile?.id }),
    assignmentFile ? loadCustomAppraisalWorkfile(propertyId, assignmentFile.id) : null,
  ]);
  const workfile = workfileResult?.workfile || null;
  if (property.account.account_id.trim().toUpperCase() !== propertyId.trim().toUpperCase()
    || (assignmentFile && (!workfileResult || !workfile
      || workfile.assignment_file_id !== assignmentFile.id
      || workfileResult.account_id.trim().toUpperCase() !== propertyId.trim().toUpperCase()))) {
    throw new Error(CUSTOM_ASSIGNMENT_REQUEST_ERROR);
  }
  return { property, assignmentFile, workfile };
}
