import { useCallback, useEffect, useState } from "react";

import {
  getUadCertificationReadiness,
  signUadWorkfile,
  UAD_WORKFILE_MUTATED_EVENT,
  type UadCertificationReadiness,
  type UadSignatureResult,
} from "../api";

interface Props {
  currentRevision: number;
  dirty: boolean;
  onSigned: (result: UadSignatureResult) => Promise<void> | void;
  workfileId: string;
  workfileStatus: string;
}

function displayMissing(value: string) {
  if (value === "current_pdf") return "generate and review the current native PDF";
  return value.replaceAll("_", " ");
}

export default function UadSignaturePanel({
  currentRevision,
  dirty,
  onSigned,
  workfileId,
  workfileStatus,
}: Props) {
  const [readiness, setReadiness] = useState<UadCertificationReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReadiness(await getUadCertificationReadiness(workfileId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Certification readiness could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [workfileId]);

  useEffect(() => { void load(); }, [load, currentRevision, workfileStatus]);
  useEffect(() => {
    const refreshAfterMutation = (event: Event) => {
      const detail = (event as CustomEvent<{ workfileId?: string }>).detail;
      if (detail?.workfileId === workfileId) void load();
    };
    window.addEventListener(UAD_WORKFILE_MUTATED_EVENT, refreshAfterMutation);
    return () => window.removeEventListener(UAD_WORKFILE_MUTATED_EVENT, refreshAfterMutation);
  }, [load, workfileId]);

  const signed = ["signed", "exported", "submitted"].includes(workfileStatus);
  const currentRevisionReady = Boolean(
    readiness?.ready
      && readiness.artifact_readiness?.pdf_ready
      && readiness.revision_number === currentRevision
      && readiness.workfile_status === "ready",
  );
  const signer = readiness?.current_signer;

  async function sign() {
    if (!signer?.signature_policy) return;
    setSigning(true);
    setError(null);
    try {
      const result = await signUadWorkfile(workfileId, {
        execution_date: new Date().toISOString().slice(0, 10),
        authentication_method: signer.signature_policy,
      });
      setAcknowledged(false);
      await onSigned(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The current UAD revision could not be signed.");
    } finally {
      setSigning(false);
    }
  }

  const tone = signed
    ? "border-emerald-200 bg-emerald-50 text-emerald-950"
    : currentRevisionReady
      ? "border-teal-200 bg-teal-50 text-teal-950"
      : "border-amber-200 bg-amber-50 text-amber-950";

  return (
    <section className={`mb-5 rounded-xl border p-4 ${tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Appraiser signature and credential snapshot</h3>
          <p className="mt-1 text-sm leading-6">
            {loading
              ? "Checking the assigned appraiser and license snapshot…"
              : signed
                ? `Revision ${currentRevision} is signed. The appraiser, organization, license, execution date, and workfile digest are preserved with the revision.`
                : currentRevisionReady
                  ? `Revision ${currentRevision} is locally validated and ready for ${signer?.display_name || "the assigned appraiser"} to sign using the current authenticated session.`
                  : "Complete whole-workfile validation and resolve any signer-profile issues before signing this revision."}
          </p>
          {signer && (
            <p className="mt-1 text-xs opacity-75">
              {signer.display_name || "Assigned signer"}
              {signer.organization_name ? ` · ${signer.organization_name}` : ""}
              {signer.license?.license_number ? ` · ${signer.license.jurisdiction || "License"} ${signer.license.license_number}` : ""}
              {signer.license?.expires_on ? ` · expires ${signer.license.expires_on}` : ""}
            </p>
          )}
        </div>
        {!signed && (
          <button
            className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={dirty || loading || signing || !acknowledged || !currentRevisionReady || !signer?.signature_policy}
            onClick={() => { void sign(); }}
            type="button"
          >
            {signing ? "Signing revision…" : "Sign current revision"}
          </button>
        )}
      </div>

      {!signed && currentRevisionReady && (
        <label className="mt-4 flex items-start gap-2 rounded-lg border border-current/20 bg-white/70 p-3 text-sm">
          <input
            checked={acknowledged}
            className="mt-0.5 h-4 w-4"
            onChange={(event) => setAcknowledged(event.target.checked)}
            type="checkbox"
          />
          <span>I reviewed the current PDF, scope of work, assumptions, limiting conditions, and appraiser certifications, and I intend to sign this exact revision. HomeNode will regenerate the signed PDF and create the official-subschema-validated MISMO XML after this signature is sealed.</span>
        </label>
      )}

      {dirty && <p className="mt-3 text-xs font-medium">Save the displayed section before signing.</p>}
      {readiness && !readiness.ready && (
        <ul className="mt-3 space-y-1 text-xs">
          {(readiness.artifact_readiness?.missing || ["current_pdf"]).map((missing) => (
            <li key={missing}>artifact: {displayMissing(missing)}</li>
          ))}
          {readiness.signers.flatMap((item) => item.missing.map((missing) => (
            <li key={`${item.role}-${missing}`}>{item.role.replaceAll("_", " ")}: {displayMissing(missing)}</li>
          )))}
        </ul>
      )}
      {error && <div className="mt-3 rounded-lg border border-red-300 bg-white/70 px-3 py-2 text-sm text-red-900">{error.replaceAll("_", " ")}</div>}
    </section>
  );
}
