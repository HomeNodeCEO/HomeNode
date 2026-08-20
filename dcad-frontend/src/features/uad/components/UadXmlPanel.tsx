import { useCallback, useEffect, useState } from "react";

import {
  generateUadXmlArtifact,
  getLatestUadXmlArtifact,
  UAD_WORKFILE_MUTATED_EVENT,
  type UadXmlArtifactResult,
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

export default function UadXmlPanel({ currentRevision, dirty, workfileId }: Props) {
  const [result, setResult] = useState<UadXmlArtifactResult>({ artifact: null, schema_validation: null });
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await getLatestUadXmlArtifact(workfileId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The latest MISMO XML result could not be loaded.");
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
  const ready = Boolean(result.artifact?.ready_for_download && result.schema_validation?.status === "passed" && !stale);
  const failed = Boolean(result.schema_validation?.status === "failed" && !stale);
  const findings = result.schema_validation?.findings || [];
  const visibleFindings = findings.slice(0, 100);
  const tone = ready
    ? "border-emerald-200 bg-emerald-50 text-emerald-950"
    : failed
      ? "border-red-200 bg-red-50 text-red-950"
      : "border-sky-200 bg-sky-50 text-sky-950";

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      setResult(await generateUadXmlArtifact(workfileId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "MISMO XML generation could not be completed.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <section className={`mb-5 rounded-xl border p-4 ${tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">MISMO 3.6 XML and official subschema gate</h3>
          <p className="mt-1 text-sm leading-6">
            {loading
              ? "Loading the latest XML generation result…"
              : ready
                ? `Revision ${result.artifact?.revision_number} produced deterministic XML and passed the official GSE UAD 3.6 subschema.`
                : failed
                  ? `The XML draft for revision ${result.schema_validation?.revision_number} has ${result.schema_validation?.fatal_count} official schema error${result.schema_validation?.fatal_count === 1 ? "" : "s"}. No exportable object was uploaded.`
                  : stale
                    ? "The saved workfile changed after this XML was generated. Run whole-workfile validation, then generate a new XML artifact."
                    : "After whole-workfile readiness passes, generate XML here. HomeNode validates it locally before any exportable file reaches object storage."}
          </p>
          {result.artifact && (
            <p className="mt-1 text-xs opacity-75">
              {byteLabel(result.artifact.byte_size)} · SHA-256 {result.artifact.checksum_sha256?.slice(0, 16) || "unavailable"}…
              {result.artifact.generated_at ? ` · ${new Date(result.artifact.generated_at).toLocaleString()}` : ""}
            </p>
          )}
          {result.schema_validation && (
            <p className="mt-1 text-xs opacity-75">
              {result.schema_validation.metadata.validator_version || "Official schema validator"}
              {result.schema_validation.metadata.generator_version ? ` · ${result.schema_validation.metadata.generator_version}` : ""}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {ready && result.artifact?.download?.url && (
            <a
              className="rounded-lg border border-emerald-700 bg-white px-4 py-2 text-sm font-semibold text-emerald-900 hover:bg-emerald-100"
              href={result.artifact.download.url}
            >
              Download XML
            </a>
          )}
          <button
            className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={dirty || loading || generating}
            onClick={() => { void generate(); }}
            type="button"
          >
            {generating ? "Generating and validating…" : ready ? "Regenerate XML" : "Generate and validate XML"}
          </button>
        </div>
      </div>

      {dirty && <p className="mt-3 text-xs font-medium">Save the displayed section before generating XML.</p>}
      {error && <div className="mt-3 rounded-lg border border-red-300 bg-white/70 px-3 py-2 text-sm text-red-900">{error.replaceAll("_", " ")}</div>}

      {visibleFindings.length > 0 && (
        <details className="mt-4 rounded-lg border border-current/20 bg-white/70 p-3" open>
          <summary className="cursor-pointer text-sm font-semibold">Official XSD findings · {findings.length}</summary>
          <ul className="mt-3 space-y-2">
            {visibleFindings.map((finding) => (
              <li className="rounded-md border border-slate-200 bg-white p-3 text-sm text-slate-900" key={finding.id}>
                <div>{finding.message}</div>
                <div className="mt-1 text-xs text-slate-500">
                  {finding.metadata.line ? `XML line ${finding.metadata.line}` : "Schema structure"}
                  {finding.metadata.code ? ` · ${finding.metadata.code}` : ""}
                </div>
              </li>
            ))}
          </ul>
          {findings.length > visibleFindings.length && (
            <p className="mt-3 text-xs">Showing the first {visibleFindings.length} findings. Complete the earliest structural issues, then generate again.</p>
          )}
        </details>
      )}
    </section>
  );
}
