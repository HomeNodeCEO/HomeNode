import { useCallback, useEffect, useState } from "react";

import {
  generateUadSubmissionPackage,
  getLatestUadSubmissionPackage,
  UAD_WORKFILE_MUTATED_EVENT,
  type UadSubmissionPackageResult,
} from "../api";

interface Props {
  currentRevision: number;
  dirty: boolean;
  workfileId: string;
  workfileStatus: string;
}

function byteLabel(bytes: number | null | undefined) {
  if (bytes == null) return "size unavailable";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function UadSubmissionPackagePanel({
  currentRevision,
  dirty,
  workfileId,
  workfileStatus,
}: Props) {
  const [result, setResult] = useState<UadSubmissionPackageResult>({ manifest: null, package: null });
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await getLatestUadSubmissionPackage(workfileId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The latest submission package could not be loaded.");
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

  const stale = Boolean(result.package && (
    !result.package.is_current_revision || result.package.revision_number !== currentRevision
  ));
  const ready = Boolean(result.package?.ready_for_download && result.manifest?.ready_for_download && !stale);
  const signed = ["signed", "exported", "submitted"].includes(workfileStatus);
  const failed = Boolean(result.package?.generation_status === "failed" && !stale);
  const tone = ready
    ? "border-emerald-200 bg-emerald-50 text-emerald-950"
    : failed
      ? "border-red-200 bg-red-50 text-red-950"
      : "border-indigo-200 bg-indigo-50 text-indigo-950";

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      setResult(await generateUadSubmissionPackage(workfileId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The UAD delivery package could not be generated.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <section className={`mb-5 rounded-xl border p-4 ${tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Revision-bound UAD delivery package</h3>
          <p className="mt-1 text-sm leading-6">
            {loading
              ? "Loading the latest delivery package…"
              : ready
                ? `Revision ${result.package?.revision_number} has a verified PDF, MISMO XML, and external evidence files in the delivery ZIP, plus a separate audit manifest.`
                : stale
                  ? "The workfile revision changed after this package was created. Revalidate, regenerate PDF and XML, sign, and package the current revision."
                  : !signed
                    ? "Sign the validated revision after reviewing its PDF and schema-valid XML. Packaging is deliberately blocked before the appraiser signature."
                    : "Generate this only after the current native PDF and schema-valid MISMO XML are ready. HomeNode verifies every source object's size and SHA-256 digest before export."}
          </p>
          {result.package && (
            <p className="mt-1 text-xs opacity-75">
              {byteLabel(result.package.byte_size)} · {result.package.metadata.entry_count || 0} files · {result.package.metadata.image_count || 0} referenced images · SHA-256 {result.package.checksum_sha256?.slice(0, 16) || "unavailable"}…
              {result.package.generated_at ? ` · ${new Date(result.package.generated_at).toLocaleString()}` : ""}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {ready && result.manifest?.download?.url && (
            <a
              className="rounded-lg border border-emerald-700 bg-white px-4 py-2 text-sm font-semibold text-emerald-900 hover:bg-emerald-100"
              href={result.manifest.download.url}
            >
              Image manifest
            </a>
          )}
          {ready && result.package?.download?.url && (
            <a
              className="rounded-lg border border-emerald-700 bg-white px-4 py-2 text-sm font-semibold text-emerald-900 hover:bg-emerald-100"
              href={result.package.download.url}
            >
              Download ZIP
            </a>
          )}
          <button
            className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={dirty || loading || generating || !signed}
            onClick={() => { void generate(); }}
            type="button"
          >
            {generating ? "Verifying and packaging…" : ready ? "Regenerate package" : "Generate package"}
          </button>
        </div>
      </div>
      {dirty && <p className="mt-3 text-xs font-medium">Save the displayed section before packaging.</p>}
      {error && <div className="mt-3 rounded-lg border border-red-300 bg-white/70 px-3 py-2 text-sm text-red-900">{error.replaceAll("_", " ")}</div>}
      <p className="mt-3 text-xs opacity-75">
        The ZIP is a locally validated delivery artifact. GSE or lender compliance credentials and a successful external response are separate gates.
      </p>
    </section>
  );
}
