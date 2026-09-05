import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type AppraisalAssignmentFile } from "@/lib/api";
import { loadAssignmentFiles } from "@/lib/appraisalFileRequests";
import { selectAssignmentFile } from "@/lib/assignmentFileSelection";

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
  }, [accountId, enabled, requestedAssignmentFileId]);

  useEffect(() => {
    selectionHandlerRef.current = onSelectedFile;
  }, [onSelectedFile]);

  useEffect(() => {
    let cancelled = false;
    setAssignmentFiles([]);
    setAssignmentFilesLoaded(false);
    setActiveAssignmentFile(null);
    setAssignmentFileNumber("");
    setAssignmentFilesError("");

    if (!accountId?.trim() || !enabled) {
      setAssignmentFilesLoading(false);
      setAssignmentFilesLoaded(true);
      return () => {
        cancelled = true;
      };
    }

    setAssignmentFilesLoading(true);
    void loadAssignmentFiles(accountId)
      .then(async (response) => {
        if (cancelled) return;
        const files = response.files || [];
        setAssignmentFiles(files);
        const selectedFile = selectAssignmentFile(
          files,
          response.latest_file,
          requestedAssignmentFileId,
        );
        if (!selectedFile) return;
        setActiveAssignmentFile(selectedFile);
        setAssignmentFileNumber(selectedFile.file_number);
        await selectionHandlerRef.current?.(selectedFile, () => cancelled);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setAssignmentFilesError(
            error instanceof Error ? error.message : "The assignment log could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAssignmentFilesLoading(false);
          setAssignmentFilesLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [accountId, enabled, requestedAssignmentFileId]);

  return {
    assignmentFiles,
    setAssignmentFiles,
    assignmentFilesLoading,
    assignmentFilesLoaded,
    assignmentFilesError,
    setAssignmentFilesError,
    activeAssignmentFile,
    setActiveAssignmentFile,
    assignmentFileNumber,
    setAssignmentFileNumber,
    selectionGenerationRef,
  };
}
