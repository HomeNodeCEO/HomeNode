import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type AppraisalAssignmentFile } from "@/lib/api";
import { loadAssignmentFiles } from "@/lib/appraisalFileRequests";
import { customAssignmentFileMatches, selectCustomAssignmentFile, CUSTOM_ASSIGNMENT_REQUEST_ERROR } from "@/lib/customAssignmentNavigation";

type AssignmentFileSelectionHandler = (
  file: AppraisalAssignmentFile,
  isCancelled: () => boolean,
) => void | Promise<void>;

export function useAssignmentFiles({
  accountId,
  enabled,
  requestedAssignmentFileId,
  onSelectedFile,
}: {
  accountId?: string;
  enabled: boolean;
  requestedAssignmentFileId?: number | null;
  onSelectedFile?: AssignmentFileSelectionHandler;
}) {
  const [assignmentFiles, setAssignmentFiles] = useState<AppraisalAssignmentFile[]>([]);
  const [assignmentFilesLoading, setAssignmentFilesLoading] = useState(false);
  const [assignmentFilesLoaded, setAssignmentFilesLoaded] = useState(false);
  const [assignmentFilesError, setAssignmentFilesError] = useState("");
  const [activeAssignmentFile, setActiveAssignmentFile] = useState<AppraisalAssignmentFile | null>(null);
  const [assignmentFileNumber, setAssignmentFileNumber] = useState("");
  const selectionHandlerRef = useRef(onSelectedFile);
  const selectionGenerationRef = useRef(0);

  useLayoutEffect(() => {
    selectionGenerationRef.current += 1;
    setActiveAssignmentFile(null);
    setAssignmentFileNumber("");
  }, [accountId, enabled, requestedAssignmentFileId]);

  useEffect(() => {
    selectionHandlerRef.current = onSelectedFile;
  }, [onSelectedFile]);

  useEffect(() => {
    let cancelled = false;
    const generation = selectionGenerationRef.current;
    const isCancelled = () => cancelled || selectionGenerationRef.current !== generation;
    setAssignmentFiles([]);
    setAssignmentFilesLoaded(false);
    setActiveAssignmentFile(null);
    setAssignmentFileNumber("");
    setAssignmentFilesError("");

    if (!accountId?.trim() || !enabled || requestedAssignmentFileId === null) {
      if (requestedAssignmentFileId === null) setAssignmentFilesError(CUSTOM_ASSIGNMENT_REQUEST_ERROR);
      setAssignmentFilesLoading(false);
      setAssignmentFilesLoaded(true);
      return () => {
        cancelled = true;
      };
    }

    setAssignmentFilesLoading(true);
    void loadAssignmentFiles(accountId)
      .then(async (response) => {
        if (isCancelled()) return;
        const files = response.files || [];
        const selectedFile = selectCustomAssignmentFile(response, accountId, requestedAssignmentFileId);
        setAssignmentFiles(files);
        if (!selectedFile) return;
        setActiveAssignmentFile(selectedFile);
        setAssignmentFileNumber(selectedFile.file_number);
        await selectionHandlerRef.current?.(selectedFile, isCancelled);
      })
      .catch((error: unknown) => {
        if (!isCancelled()) {
          setAssignmentFilesError(
            error instanceof Error ? error.message : "The assignment log could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (!isCancelled()) {
          setAssignmentFilesLoading(false);
          setAssignmentFilesLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [accountId, enabled, requestedAssignmentFileId]);

  const currentFile = enabled && requestedAssignmentFileId !== null
    && customAssignmentFileMatches(activeAssignmentFile, accountId || "")
    && (requestedAssignmentFileId === undefined || activeAssignmentFile.id === requestedAssignmentFileId)
    ? activeAssignmentFile : null;

  return {
    assignmentFiles,
    setAssignmentFiles,
    assignmentFilesLoading,
    assignmentFilesLoaded,
    assignmentFilesError,
    setAssignmentFilesError,
    activeAssignmentFile: currentFile,
    setActiveAssignmentFile,
    assignmentFileNumber: currentFile ? assignmentFileNumber : "",
    setAssignmentFileNumber,
    selectionGenerationRef,
  };
}
