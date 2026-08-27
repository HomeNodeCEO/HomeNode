import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';

import * as api from '@/lib/api';
import {
  loadAssignmentFiles,
  loadCustomAppraisalWorkfile,
} from '@/lib/appraisalFileRequests';

export function useAppraisalFileRequest() {
  const location = useLocation();
  return useMemo(() => {
    const params = new URLSearchParams(location.search);
    const propertyId = (params.get('propertyId') || '').trim();
    const parsedFileId = Number(params.get('assignmentFileId'));
    return {
      propertyId,
      requestedFileId: Number.isSafeInteger(parsedFileId) && parsedFileId > 0
        ? parsedFileId
        : null,
    };
  }, [location.search]);
}

export async function loadAppraisalFileContext(
  propertyId: string,
  requestedFileId: number | null,
) {
  const [property, files] = await Promise.all([
    api.getAccount(propertyId),
    loadAssignmentFiles(propertyId),
  ]);
  const assignmentFile = requestedFileId
    ? files.files.find((file) => file.id === requestedFileId) || null
    : files.latest_file;
  const workfile = assignmentFile
    ? (await loadCustomAppraisalWorkfile(propertyId, assignmentFile.id)).workfile
    : null;
  return { property, assignmentFile, workfile };
}
