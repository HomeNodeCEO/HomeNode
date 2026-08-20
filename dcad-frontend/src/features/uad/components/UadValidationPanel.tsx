import { useCallback, useEffect, useMemo, useState } from "react";

import {
  getLatestUadValidation,
  runLocalUadValidation,
  UAD_WORKFILE_MUTATED_EVENT,
  type UadSectionKey,
  type UadValidationFinding,
  type UadValidationRun,
} from "../api";

interface Props {
  currentRevision: number;
  dirty: boolean;
  onValidated: (validation: UadValidationRun) => Promise<void> | void;
  workfileId: string;
}

const SECTION_LABELS: Partial<Record<UadSectionKey | "catalog", string>> = {
  assignment: "Assignment",
  subject: "Subject",
  site: "Site",
  disaster_mitigation: "Disaster Mitigation",
  energy_green: "Energy-Efficient and Green Features",
  sketch: "Sketch",
  dwelling_exterior: "Dwelling Exterior",
  manufactured_home: "Manufactured Home",
  unit_interior: "Unit Interior",
  functional_obsolescence: "Functional Obsolescence",
  outbuilding: "Outbuildings",
  vehicle_storage: "Vehicle Storage",
  subject_property_amenities: "Subject Property Amenities",
  overall_quality_condition: "Overall Quality and Condition",
  highest_best_use: "Highest and Best Use",
  market: "Market",
  project_information: "Project Information",
  subject_listing_information: "Subject Listing Information",
  sales_contract: "Sales Contract",
  prior_sale_transfer_history: "Prior Sale and Transfer History",
  sales_comparison: "Sales Comparison Approach",
  catalog: "UAD field catalog",
};

function findingSection(finding: UadValidationFinding) {
  return finding.metadata.section || "catalog";
}

export default function UadValidationPanel({ currentRevision, dirty, onValidated, workfileId }: Props) {
  const [validation, setValidation] = useState<UadValidationRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadValidation = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setValidation(await getLatestUadValidation(workfileId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The latest validation result could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [workfileId]);

  useEffect(() => { void loadValidation(); }, [loadValidation, currentRevision]);
  useEffect(() => {
    const refreshAfterMutation = (event: Event) => {
      const detail = (event as CustomEvent<{ workfileId?: string }>).detail;
      if (detail?.workfileId === workfileId) void loadValidation();
    };
    window.addEventListener(UAD_WORKFILE_MUTATED_EVENT, refreshAfterMutation);
    return () => window.removeEventListener(UAD_WORKFILE_MUTATED_EVENT, refreshAfterMutation);
  }, [loadValidation, workfileId]);

  const groupedFindings = useMemo(() => {
    const groups = new Map<string, UadValidationFinding[]>();
    for (const finding of validation?.findings || []) {
      const section = findingSection(finding);
      groups.set(section, [...(groups.get(section) || []), finding]);
    }
    return [...groups.entries()];
  }, [validation]);

  async function runValidation() {
    setRunning(true);
    setError(null);
    try {
      const result = await runLocalUadValidation(workfileId);
      setValidation(result);
      await onValidated(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The UAD workfile could not be validated.");
    } finally {
      setRunning(false);
    }
  }

  const stale = Boolean(validation && (!validation.is_current_revision || validation.revision_number !== currentRevision));
  const ready = Boolean(validation?.ready_for_export && !stale);
  const failed = validation?.status === "failed" && !stale;
  const tone = ready
    ? "border-emerald-200 bg-emerald-50 text-emerald-950"
    : failed
      ? "border-red-200 bg-red-50 text-red-950"
      : "border-amber-200 bg-amber-50 text-amber-950";

  return (
    <section className={`mb-5 rounded-xl border p-4 ${tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Whole-workfile UAD readiness</h3>
          <p className="mt-1 text-sm leading-6">
            {loading
              ? "Loading the latest local validation run…"
              : ready
                ? `Revision ${validation?.revision_number} passed every current local UAD rule and is ready for the next generation step.`
                : failed
                  ? `Revision ${validation?.revision_number} has ${validation?.fatal_count} blocking finding${validation?.fatal_count === 1 ? "" : "s"}.`
                  : stale
                    ? "The saved workfile changed after its last validation run. Run validation again before generation or export."
                    : "No current validation run exists. Save the workfile, then run the complete local rule set."}
          </p>
          {validation && (
            <p className="mt-1 text-xs opacity-75">
              Local validator {validation.metadata.validator_version || "version unavailable"} · {validation.warning_count} warning{validation.warning_count === 1 ? "" : "s"}
              {validation.completed_at ? ` · ${new Date(validation.completed_at).toLocaleString()}` : ""}
            </p>
          )}
        </div>
        <button
          className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={dirty || loading || running}
          onClick={() => { void runValidation(); }}
          type="button"
        >
          {running ? "Validating…" : validation ? "Run validation again" : "Run full UAD validation"}
        </button>
      </div>

      {dirty && <p className="mt-3 text-xs font-medium">Save the displayed section before running whole-workfile validation.</p>}
      {error && <div className="mt-3 rounded-lg border border-red-300 bg-white/70 px-3 py-2 text-sm text-red-900">{error}</div>}

      {groupedFindings.length > 0 && (
        <div className="mt-4 space-y-2">
          {groupedFindings.map(([section, findings]) => (
            <details className="rounded-lg border border-current/20 bg-white/70 p-3" key={section} open={groupedFindings.length === 1}>
              <summary className="cursor-pointer text-sm font-semibold">
                {SECTION_LABELS[section as UadSectionKey | "catalog"] || section} · {findings.length}
              </summary>
              <ul className="mt-3 space-y-2">
                {findings.map((finding) => (
                  <li className="rounded-md border border-slate-200 bg-white p-3 text-sm text-slate-900" key={finding.id}>
                    <div>{finding.message}</div>
                    <div className="mt-1 text-xs text-slate-500">
                      {finding.report_field_id ? `Report field ${finding.report_field_id}` : "Workfile rule"}
                      {finding.uad_uid ? ` · UID ${finding.uad_uid}` : ""}
                      {finding.metadata.code ? ` · ${finding.metadata.code.replaceAll("_", " ")}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
