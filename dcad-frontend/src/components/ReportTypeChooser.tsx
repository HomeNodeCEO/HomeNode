import { useEffect, useMemo, useState } from "react";

import { useApplicationAuth } from "@/features/auth/ApplicationAuth";
import {
  createCanonicalReportFile,
  getCanonicalReportFiles,
  type CanonicalReportFile,
  type CanonicalReportWorkflow,
} from "@/lib/api";
import { reportDestination, type HomeNodeReportType } from "@/lib/reportDestinations";

export type ReportTypeChooserSubject = {
  accountId: string;
  address: string;
  ownerName?: string | null;
};

type Props = { subject: ReportTypeChooserSubject | null; onClose: () => void };

const REPORT_OPTIONS: Array<{
  type: HomeNodeReportType;
  workflow: CanonicalReportWorkflow;
  title: string;
  description: string;
  accent: string;
}> = [
  { type: "custom-appraisal", workflow: "custom_appraisal", title: "Custom Appraisal", description: "Open or create a custom appraisal assignment.", accent: "border-violet-200 bg-violet-50 hover:border-violet-500 hover:bg-violet-100" },
  { type: "uad-3.6", workflow: "uad_3_6", title: "UAD 3.6", description: "Open or create a structured UAD 3.6 assignment.", accent: "border-violet-300 bg-purple-50 hover:border-violet-600 hover:bg-purple-100" },
  { type: "property-tax-protest", workflow: "property_tax_protest", title: "Property Tax Protest", description: "Open or create a property-tax protest assignment.", accent: "border-amber-300 bg-amber-50 hover:border-amber-500 hover:bg-amber-100" },
];

function displayDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export default function ReportTypeChooser({ subject, onClose }: Props) {
  const auth = useApplicationAuth();
  const [selectedType, setSelectedType] = useState<HomeNodeReportType | null>(null);
  const [files, setFiles] = useState<CanonicalReportFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const option = REPORT_OPTIONS.find((item) => item.type === selectedType) || null;
  const writableOrganizations = useMemo(() => {
    if (!option) return [];
    return (auth.session?.organizations || []).filter(
      (organization) => organization.permissions[option.workflow]?.write,
    );
  }, [auth.session?.organizations, option]);
  const [organizationId, setOrganizationId] = useState("");

  useEffect(() => {
    if (!subject) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, subject]);

  useEffect(() => {
    setSelectedType(null);
    setFiles([]);
    setError("");
  }, [subject?.accountId]);

  useEffect(() => {
    setOrganizationId((current) => writableOrganizations.some((item) => item.organization_id === current)
      ? current
      : writableOrganizations[0]?.organization_id || "");
  }, [writableOrganizations]);

  useEffect(() => {
    if (!subject || !option) return undefined;
    let cancelled = false;
    setLoading(true);
    setError("");
    void getCanonicalReportFiles(subject.accountId, option.workflow)
      .then((response) => { if (!cancelled) setFiles(response.files || []); })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Assignment files could not be loaded.");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [option, subject]);

  if (!subject) return null;

  async function startNewAssignment() {
    if (!option || !organizationId || creating || !subject) return;
    setCreating(true);
    setError("");
    try {
      const result = await createCanonicalReportFile(subject.accountId, {
        workflow_type: option.workflow,
        organization_id: organizationId,
        client_request_id: crypto.randomUUID(),
      });
      window.location.assign(reportDestination(option.type, subject, result.report_file.target_id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The new assignment could not be created.");
      setCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section aria-labelledby="report-type-title" aria-modal="true" className="hn-workspace-surface max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border p-5" role="dialog">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="hn-eyebrow text-xs tracking-[0.16em]">{option ? "Assignment file" : "New or existing report"}</div>
            <h2 id="report-type-title" className="mt-1 text-2xl font-semibold text-slate-950">{option ? option.title : "Choose a report type"}</h2>
            <p className="mt-2 text-sm font-medium text-slate-800">{subject.address}</p>
            <p className="mt-0.5 text-xs text-slate-500">Account {subject.accountId}</p>
          </div>
          <button aria-label="Close report chooser" className="rounded-full border border-slate-200 px-3 py-1.5 text-lg leading-none text-slate-500 hover:bg-slate-100 hover:text-slate-800" onClick={onClose} type="button">×</button>
        </div>

        {!option ? (
          <div className="mt-5 grid gap-3 md:grid-cols-3">
            {REPORT_OPTIONS.map((item) => (
              <button key={item.type} className={`block rounded-xl border p-4 text-left transition ${item.accent}`} onClick={() => setSelectedType(item.type)} type="button">
                <span className="block text-base font-semibold text-slate-950">{item.title}</span>
                <span className="mt-2 block text-sm leading-5 text-slate-600">{item.description}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="mt-5 space-y-4">
            <button className="hn-action-secondary text-sm font-semibold" onClick={() => { setSelectedType(null); setFiles([]); setError(""); }} type="button">← Change report type</button>

            {loading ? (
              <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">Loading assignment files…</p>
            ) : files.length ? (
              <section>
                <h3 className="text-sm font-semibold text-slate-950">Continue an existing file</h3>
                <div className="mt-2 grid gap-2">
                  {files.map((file) => (
                    <a className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 px-4 py-3 no-underline transition ${file.target_id ? "hover:border-violet-400 hover:bg-violet-50" : "pointer-events-none opacity-60"}`} href={file.target_id ? reportDestination(option.type, subject, file.target_id) : undefined} key={file.id}>
                      <span>
                        <span className="block font-semibold text-slate-950">File {file.file_number}</span>
                        <span className="mt-0.5 block text-xs text-slate-500">Last updated {displayDate(file.updated_at)}</span>
                      </span>
                      <span className="rounded-full bg-violet-800 px-3 py-1.5 text-xs font-semibold text-white">{file.is_current ? "Continue current file" : "Open previous file"}</span>
                    </a>
                  ))}
                </div>
              </section>
            ) : (
              <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">No existing {option.title} files were found for this property.</p>
            )}

            <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <h3 className="font-semibold text-slate-950">Start a new assignment</h3>
              <p className="mt-1 text-sm text-slate-600">HomeNode will reserve the next file number for today before opening the report.</p>
              {writableOrganizations.length > 1 && (
                <label className="mt-3 block text-sm font-medium text-slate-700">
                  Organization
                  <select className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2" onChange={(event) => setOrganizationId(event.target.value)} value={organizationId}>
                    {writableOrganizations.map((organization) => <option key={organization.organization_id} value={organization.organization_id}>{organization.display_name || organization.organization_id}</option>)}
                  </select>
                </label>
              )}
              <button className="hn-action-primary mt-3 rounded-xl px-5 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50" disabled={!organizationId || creating} onClick={() => { void startNewAssignment(); }} type="button">
                {creating ? "Creating assignment…" : "Start New Assignment"}
              </button>
              {!writableOrganizations.length && <p className="mt-2 text-xs font-medium text-amber-800">Your account does not have permission to create this report type.</p>}
            </section>

            {error && <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
          </div>
        )}
      </section>
    </div>
  );
}
