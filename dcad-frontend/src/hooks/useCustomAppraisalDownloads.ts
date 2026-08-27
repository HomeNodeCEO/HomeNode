import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  downloadCustomAppraisalReportPdf,
  downloadCustomAppraisalWorkfile,
  type AppraisalAssignmentFile,
} from "@/lib/api";

type UseCustomAppraisalDownloadsOptions = {
  accountId?: string;
  getEditorKey: () => string;
  setStatusMessage: Dispatch<SetStateAction<string>>;
};

function triggerBrowserDownload(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

export function useCustomAppraisalDownloads({
  accountId,
  getEditorKey,
  setStatusMessage,
}: UseCustomAppraisalDownloadsOptions) {
  const [downloadInProgress, setDownloadInProgress] = useState<string | null>(null);
  const activeDownload = useRef<string | null>(null);

  const runDownload = useCallback(async (
    file: AppraisalAssignmentFile,
    format: "workfile" | "pdf",
  ) => {
    if (!accountId || activeDownload.current) return;
    const editorKey = getEditorKey();
    if (!editorKey) return;
    const actionKey = `${format}:${file.id}`;
    activeDownload.current = actionKey;
    setDownloadInProgress(actionKey);
    setStatusMessage(
      format === "pdf"
        ? `Building ${file.file_number} appraisal PDF...`
        : `Preparing ${file.workfile?.canonical_file_name || file.file_number}...`,
    );
    try {
      if (format === "pdf") {
        const download = await downloadCustomAppraisalReportPdf(accountId, file.id, editorKey);
        triggerBrowserDownload(download.blob, download.fileName);
        setStatusMessage(
          `${download.immutable ? "Immutable signed" : "Current draft"} appraisal PDF downloaded as ${download.fileName}${download.pageCount ? ` (${download.pageCount} pages)` : ""}.`,
        );
      } else {
        const download = await downloadCustomAppraisalWorkfile(accountId, file.id, editorKey);
        triggerBrowserDownload(download.blob, download.fileName);
        setStatusMessage(
          `${download.immutable ? "Immutable signed file" : "Current database draft"} downloaded as ${download.fileName}.`,
        );
      }
    } catch (error) {
      setStatusMessage(
        error instanceof Error
          ? error.message
          : format === "pdf"
            ? "The appraisal PDF could not be generated."
            : "The appraisal workfile could not be downloaded.",
      );
    } finally {
      if (activeDownload.current === actionKey) activeDownload.current = null;
      setDownloadInProgress((current) => current === actionKey ? null : current);
    }
  }, [accountId, getEditorKey, setStatusMessage]);

  return {
    downloadInProgress,
    downloadCustomAppraisalFile: (file: AppraisalAssignmentFile) =>
      runDownload(file, "workfile"),
    downloadCustomAppraisalPdf: (file: AppraisalAssignmentFile) =>
      runDownload(file, "pdf"),
  };
}

export { triggerBrowserDownload };
