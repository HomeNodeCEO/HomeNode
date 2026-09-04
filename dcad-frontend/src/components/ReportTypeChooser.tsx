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
}> = [
  { type: "custom-appraisal", workflow: "custom_appraisal", title: "Custom Appraisal", description: "Open or create a custom appraisal assignment." },
  { type: "uad-3.6", workflow: "uad_3_6", title: "UAD 3.6", description: "Open or create a structured UAD 3.6 assignment." },
  { type: "property-tax-protest", workflow: "property_tax_protest", title: "Property Tax Protest", description: "Open or create a property-tax protest assignment." },
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
    <div className="hn-report-chooser-backdrop fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section aria-labelledby="report-type-title" aria-modal="true" className="hn-report-chooser max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border p-5 sm:p-6" role="dialog">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="hn-report-chooser__eyebrow text-xs tracking-[0.16em]">{option ? "Assignment file" : "New or existing report"}</div>
            <h2 id="report-type-title" className="hn-report-chooser__title mt-1 text-2xl font-semibold">{option ? option.title : "Choose a report type"}</h2>
            <p className="hn-report-chooser__subject mt-2 text-sm font-medium">{subject.address}</p>
            <p className="hn-report-chooser__meta mt-0.5 text-xs">Account {subject.accountId}</p>
          </div>
          <button aria-label="Close report chooser" className="hn-report-chooser__close rounded-full border px-3 py-1.5 text-lg leading-none" onClick={onClose} type="button">×</button>
        </div>

        {!option ? (
          <div className="mt-5 grid gap-3 md:grid-cols-3">
            {REPORT_OPTIONS.map((item) => (
              <button key={item.type} className="hn-report-type-option block rounded-xl border p-4 text-left" onClick={() => setSelectedType(item.type)} type="button">
                <span className="hn-report-type-option__title block text-base font-semibold">{item.title}</span>
                <span className="hn-report-type-option__description mt-2 block text-sm leading-5">{item.description}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="mt-5 space-y-4">
            <button className="hn-report-chooser-button text-sm font-semibold" onClick={() => { setSelectedType(null); setFiles([]); setError(""); }} type="button">← Change report type</button>

            {loading ? (
              <p className="hn-report-chooser__notice rounded-xl p-4 text-sm">Loading assignment files…</p>
            ) : files.length ? (
              <section>
                <h3 className="hn-report-chooser__section-title text-sm font-semibold">Continue an existing file</h3>
                <div className="mt-2 grid gap-2">
                  {files.map((file) => (
                    <a className={`hn-report-existing-file flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 no-underline ${file.target_id ? "" : "pointer-events-none opacity-60"}`} href={file.target_id ? reportDestination(option.type, subject, file.target_id) : undefined} key={file.id}>
                      <span>
                        <span className="hn-report-existing-file__title block font-semibold">File {file.file_number}</span>
                        <span className="hn-report-existing-file__meta mt-0.5 block text-xs">Last updated {displayDate(file.updated_at)}</span>
                      </span>
                      <span className="hn-report-existing-file__action rounded-full px-3 py-1.5 text-xs font-semibold">{file.is_current ? "Continue current file" : "Open previous file"}</span>
                    </a>
                  ))}
                </div>
              </section>
            ) : (
              <p className="hn-report-chooser__notice rounded-xl p-4 text-sm">No existing {option.title} files were found for this property.</p>
            )}

            <section className="hn-report-chooser__panel rounded-xl border p-4">
              <h3 className="hn-report-chooser__section-title font-semibold">Start a new assignment</h3>
              <p className="hn-report-chooser__meta mt-1 text-sm">HomeNode will reserve the next file number for today before opening the report.</p>
              {writableOrganizations.length > 1 && (
                <label className="hn-report-chooser__label mt-3 block text-sm font-medium">
                  Organization
                  <select className="hn-report-chooser__select mt-1 w-full rounded-lg border px-3 py-2" onChange={(event) => setOrganizationId(event.target.value)} value={organizationId}>
                    {writableOrganizations.map((organization) => <option key={organization.organization_id} value={organization.organization_id}>{organization.display_name || organization.organization_id}</option>)}
                  </select>
                </label>
              )}
              <button className="hn-report-chooser-button mt-3 rounded-xl px-5 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50" disabled={!organizationId || creating} onClick={() => { void startNewAssignment(); }} type="button">
                {creating ? "Creating assignment…" : "Start New Assignment"}
              </button>
              {!writableOrganizations.length && <p className="hn-report-chooser__warning mt-2 text-xs font-medium">Your account does not have permission to create this report type.</p>}
            </section>

            {error && <p className="hn-report-chooser__error rounded-xl border p-3 text-sm">{error}</p>}
          </div>
        )}
      </section>
    </div>
  );
}
