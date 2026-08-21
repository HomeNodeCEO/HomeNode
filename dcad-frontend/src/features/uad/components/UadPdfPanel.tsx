import { useCallback, useEffect, useState } from "react";

import {
  generateUadPdfArtifact,
  getLatestUadPdfArtifact,
  UAD_WORKFILE_MUTATED_EVENT,
  type UadPdfArtifactResult,
} from "../api";

interface Props {
  currentRevision: number;
  dirty: boolean;
  workfileId: string;
}

function byteLabel(bytes: number | null | undefined) {
  if (bytes == null) return "size unavailable";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export default function UadPdfPanel({ currentRevision, dirty, workfileId }: Props) {
  const [result, setResult] = useState<UadPdfArtifactResult>({ artifact: null });
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await getLatestUadPdfArtifact(workfileId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The latest native report could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [workfileId]);

  useEffect(() => { void load(); }, [load, currentRevision]);
  useEffect(() => {
    const refreshAfterMutation = (event: Event) => {
      const detail = (event as CustomEvent<{ workfileId?: string }>).detail;
      if (detail?.workfileId === workfileId) void load();
    };
    window.addEventListener(UAD_WORKFILE_MUTATED_EVENT, refreshAfterMutation);
    return () => window.removeEventListener(UAD_WORKFILE_MUTATED_EVENT, refreshAfterMutation);
  }, [load, workfileId]);

  const stale = Boolean(result.artifact && (
    !result.artifact.is_current_revision || result.artifact.revision_number !== currentRevision
  ));
  const ready = Boolean(result.artifact?.ready_for_download && !stale);
  const failed = Boolean(result.artifact?.generation_status === "failed" && !stale);
  const tone = ready
    ? "border-emerald-200 bg-emerald-50 text-emerald-950"
    : failed
      ? "border-red-200 bg-red-50 text-red-950"
      : "border-violet-200 bg-violet-50 text-violet-950";

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      setResult(await generateUadPdfArtifact(workfileId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The native UAD report could not be generated.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <section className={`mb-5 rounded-xl border p-4 ${tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Native Uniform Residential Appraisal Report</h3>
          <p className="mt-1 text-sm leading-6">
            {loading
              ? "Loading the latest native report…"
              : ready
                ? `Revision ${result.artifact?.revision_number} has a revision-bound legal-size PDF ready to review.`
                : failed
                  ? "The last PDF generation did not complete. Review the error and verified report images, then try again."
                  : stale
                    ? "The workfile changed after this PDF was generated. Validate the current revision and generate it again."
                    : "After whole-workfile validation passes, generate the native report from the same canonical UAD data used for MISMO XML."}
          </p>
          {result.artifact && (
            <p className="mt-1 text-xs opacity-75">
              {result.artifact.metadata.page_count ? `${result.artifact.metadata.page_count} pages · ` : ""}
              {byteLabel(result.artifact.byte_size)} · SHA-256 {result.artifact.checksum_sha256?.slice(0, 16) || "unavailable"}…
              {result.artifact.generated_at ? ` · ${new Date(result.artifact.generated_at).toLocaleString()}` : ""}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {ready && result.artifact?.download?.url && (
            <a
              className="rounded-lg border border-emerald-700 bg-white px-4 py-2 text-sm font-semibold text-emerald-900 hover:bg-emerald-100"
              href={result.artifact.download.url}
              rel="noreferrer"
              target="_blank"
            >
              Review PDF
            </a>
          )}
          <button
            className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={dirty || loading || generating}
            onClick={() => { void generate(); }}
            type="button"
          >
            {generating ? "Generating report…" : ready ? "Regenerate PDF" : "Generate PDF"}
          </button>
        </div>
      </div>
      {dirty && <p className="mt-3 text-xs font-medium">Save the displayed section before generating the report.</p>}
      {error && <div className="mt-3 rounded-lg border border-red-300 bg-white/70 px-3 py-2 text-sm text-red-900">{error.replaceAll("_", " ")}</div>}
      <p className="mt-3 text-xs opacity-75">
        The renderer is isolated from the Custom Appraisal PDF. JPEG and PNG display images are embedded; other verified originals remain preserved for packaging and require a compatible display copy.
      </p>
    </section>
  );
}
