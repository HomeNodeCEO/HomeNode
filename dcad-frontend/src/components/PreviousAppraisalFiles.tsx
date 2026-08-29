import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  getPreviousAppraisalFiles,
  replicatePreviousAppraisalFile,
  type AppraisalHistoryWorkflow,
  type AppraisalReplicationMode,
  type PreviousAppraisalFile,
} from '@/lib/api';
import {
  forgetEditorCredential,
  requestEditorCredential,
} from '@/lib/editorCredential';

const WORKFLOW_LABELS: Record<AppraisalHistoryWorkflow, string> = {
  custom_appraisal: 'Custom Appraisal',
  uad_3_6: 'UAD 3.6',
};

function dateLabel(value: string | null): string {
  if (!value) return 'Not recorded';
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf())) return value;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}

function numberLabel(value: number | null, suffix = ''): string {
  if (value === null || !Number.isFinite(value)) return 'Not recorded';
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)}${suffix}`;
}

function changeReviewRows(current: PreviousAppraisalFile, source: PreviousAppraisalFile) {
  const rows = [
    { label: 'Condition', prior: source.summary.condition_rating, current: current.summary.condition_rating },
    { label: 'Quality', prior: source.summary.quality_rating, current: current.summary.quality_rating },
    {
      label: 'GLA',
      prior: source.summary.gross_living_area_sqft === null ? null : numberLabel(source.summary.gross_living_area_sqft, ' sq. ft.'),
      current: current.summary.gross_living_area_sqft === null ? null : numberLabel(current.summary.gross_living_area_sqft, ' sq. ft.'),
    },
    {
      label: 'Site area',
      prior: source.summary.site_area_acres === null ? null : numberLabel(source.summary.site_area_acres, ' ac.'),
      current: current.summary.site_area_acres === null ? null : numberLabel(current.summary.site_area_acres, ' ac.'),
    },
    { label: 'Parcels', prior: source.summary.parcel_count, current: current.summary.parcel_count },
  ];
  return rows.filter((row) => String(row.prior ?? '') !== String(row.current ?? ''));
}

function defaultEditorKey(): string {
  return requestEditorCredential('Enter the HomeNode editor key to replicate this appraisal file:');
}

function alternateWorkflow(workflow: AppraisalHistoryWorkflow): AppraisalHistoryWorkflow {
  return workflow === 'custom_appraisal' ? 'uad_3_6' : 'custom_appraisal';
}

function ReplicationForm({
  file,
  saving,
  onCancel,
  onReplicate,
}: {
  file: PreviousAppraisalFile;
  saving: boolean;
  onCancel: () => void;
  onReplicate: (input: {
    mode: AppraisalReplicationMode;
    target_workflow_type: AppraisalHistoryWorkflow;
    file_number?: string;
    effective_date?: string;
    inspection_date?: string;
    same_assignment_confirmed?: boolean;
  }) => Promise<void>;
}) {
  const [mode, setMode] = useState<AppraisalReplicationMode>('new_assignment_template');
  const [targetWorkflow, setTargetWorkflow] = useState<AppraisalHistoryWorkflow>(
    alternateWorkflow(file.workflow_type),
  );
  const [fileNumber, setFileNumber] = useState('');
  const [effectiveDate, setEffectiveDate] = useState(file.effective_date || '');
  const [inspectionDate, setInspectionDate] = useState(file.inspection_date || '');
  const [confirmed, setConfirmed] = useState(false);

  const setReplicationMode = (next: AppraisalReplicationMode) => {
    setMode(next);
    if (next === 'same_assignment_alternate') {
      setTargetWorkflow(alternateWorkflow(file.workflow_type));
    }
  };

  return (
    <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-4">
      <h4 className="font-semibold text-blue-950">Replicate {file.file_number}</h4>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="text-xs font-semibold text-slate-700">
          Replication mode
          <select
            className="select select-bordered select-sm mt-1 w-full bg-white"
            value={mode}
            onChange={(event) => setReplicationMode(event.target.value as AppraisalReplicationMode)}
          >
            <option value="new_assignment_template">New appraisal using prior work for review</option>
            <option value="same_assignment_alternate">Same assignment, alternate report format</option>
          </select>
        </label>
        <label className="text-xs font-semibold text-slate-700">
          Target report
          <select
            className="select select-bordered select-sm mt-1 w-full bg-white"
            disabled={mode === 'same_assignment_alternate'}
            value={targetWorkflow}
            onChange={(event) => setTargetWorkflow(event.target.value as AppraisalHistoryWorkflow)}
          >
            <option value="custom_appraisal">Custom Appraisal</option>
            <option value="uad_3_6">UAD 3.6</option>
          </select>
        </label>
        <label className="text-xs font-semibold text-slate-700">
          New file number <span className="font-normal text-slate-500">(optional)</span>
          <input
            className="input input-bordered input-sm mt-1 w-full bg-white"
            maxLength={100}
            placeholder="HomeNode can generate one"
            value={fileNumber}
            onChange={(event) => setFileNumber(event.target.value)}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs font-semibold text-slate-700">
            Effective date
            <input
              className="input input-bordered input-sm mt-1 w-full bg-white"
              type="date"
              value={effectiveDate}
              onChange={(event) => setEffectiveDate(event.target.value)}
            />
          </label>
          <label className="text-xs font-semibold text-slate-700">
            Inspection date
            <input
              className="input input-bordered input-sm mt-1 w-full bg-white"
              type="date"
              value={inspectionDate}
              onChange={(event) => setInspectionDate(event.target.value)}
            />
          </label>
        </div>
      </div>

      {mode === 'new_assignment_template' ? (
        <p className="mt-3 rounded-lg bg-white px-3 py-2 text-xs leading-5 text-slate-700">
          A clean assignment and subject snapshot will be created. Prior condition, measurements, parcels, and
          conclusions remain review suggestions and will not silently become current facts.
        </p>
      ) : (
        <label className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">
          <input
            checked={confirmed}
            className="checkbox checkbox-sm mt-0.5"
            type="checkbox"
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>
            I confirm this is the same assignment, effective date, inspection, scope, and subject evidence. The
            alternate report may share the existing subject snapshot.
          </span>
        </label>
      )}

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button className="hn-action-secondary btn btn-ghost btn-sm normal-case" disabled={saving} onClick={onCancel} type="button">
          Cancel
        </button>
        <button
          className="hn-action-primary btn btn-sm normal-case"
          disabled={saving || (mode === 'same_assignment_alternate' && !confirmed)}
          onClick={() => void onReplicate({
            mode,
            target_workflow_type: targetWorkflow,
            file_number: fileNumber.trim() || undefined,
            effective_date: effectiveDate || undefined,
            inspection_date: inspectionDate || undefined,
            same_assignment_confirmed: mode === 'same_assignment_alternate' ? confirmed : undefined,
          })}
          type="button"
        >
          {saving ? 'Creating…' : 'Create Replicated File'}
        </button>
      </div>
    </div>
  );
}

export default function PreviousAppraisalFiles({
  accountId,
  getEditorKey = defaultEditorKey,
  customTheme = false,
}: {
  accountId: string;
  getEditorKey?: () => string;
  customTheme?: boolean;
}) {
  const [files, setFiles] = useState<PreviousAppraisalFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeReplicationId, setActiveReplicationId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; url?: string } | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setError('');
    try {
      const response = await getPreviousAppraisalFiles(accountId);
      setFiles(response.files || []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Previous appraisal files could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const orderedFiles = useMemo(
    () => [...files].sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at)),
    [files],
  );

  async function replicate(file: PreviousAppraisalFile, input: Parameters<typeof replicatePreviousAppraisalFile>[2]) {
    const editorKey = getEditorKey();
    if (!editorKey) return;
    setSaving(true);
    setError('');
    setMessage(null);
    try {
      const result = await replicatePreviousAppraisalFile(accountId, file.id, input, editorKey);
      setActiveReplicationId(null);
      setMessage({
        text: result.change_review_required
          ? `${result.report_file.file_number} was created with prior information isolated for change review.`
          : `${result.report_file.file_number} was linked to the same assignment snapshot.`,
        url: result.report_file.view_url,
      });
      await load();
    } catch (reason) {
      const nextError = reason instanceof Error ? reason.message : 'The appraisal file could not be replicated.';
      if (/401|invalid_editor_key/i.test(nextError)) forgetEditorCredential();
      setError(nextError);
    } finally {
      setSaving(false);
    }
  }

  return (
    <details className={`group mt-2 overflow-hidden ${customTheme ? 'hn-custom-history hn-custom-section rounded-xl border' : 'border-y border-slate-200 bg-white shadow-sm'}`}>
      <summary className={`flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2 marker:content-none sm:px-6 ${customTheme ? 'hn-custom-section-header' : 'hover:bg-slate-50'}`}>
        <div className="flex min-w-0 items-center gap-2">
          <svg
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-slate-500 transition-transform group-open:rotate-90"
            fill="none"
            viewBox="0 0 20 20"
          >
            <path d="m7 5 5 5-5 5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" />
          </svg>
          <h2 className={`truncate text-sm font-semibold ${customTheme ? 'hn-custom-section-title' : 'text-slate-950'}`}>Previous Appraisal Files</h2>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
            {loading ? "…" : orderedFiles.length}
          </span>
        </div>
        <span className="shrink-0 text-[11px] font-medium text-slate-500 group-open:hidden">Expand</span>
        <span className="hidden shrink-0 text-[11px] font-medium text-slate-500 group-open:inline">Collapse</span>
      </summary>

      <div className="border-t border-slate-100 px-3 py-2 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] leading-4 text-slate-500">
            Custom and UAD files with preserved snapshots and lineage.
          </p>
          <button className="hn-action-primary btn btn-xs normal-case" disabled={loading} onClick={() => void load()} type="button">
            Refresh
          </button>
        </div>

      {message ? (
        <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-950">
          {message.text}{' '}
          {message.url ? <a className="font-semibold underline" href={message.url}>Open file</a> : null}
        </div>
      ) : null}
      {error ? (
        <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
          {error}
        </div>
      ) : null}

      {loading ? (
        <p className="mt-2 text-xs text-slate-500">Loading prior appraisal files…</p>
      ) : orderedFiles.length === 0 ? (
        <p className="mt-2 text-xs text-slate-500">No Custom or UAD appraisal files have been created for this subject.</p>
      ) : (
        <div className="mt-2 max-h-80 space-y-2 overflow-y-auto pr-1">
          {orderedFiles.map((file) => (
            <article className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2" key={file.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-950">{file.file_number}</span>
                    <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                      {WORKFLOW_LABELS[file.workflow_type]}
                    </span>
                    {file.is_current ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">Current</span>
                    ) : null}
                    {file.replication?.change_review_required ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">Change review required</span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    {file.status} · Revision {file.current_revision} · Updated {dateLabel(file.updated_at)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <a className="hn-action-primary btn btn-xs normal-case" href={file.view_url}>View File</a>
                  <button
                    className="hn-action-primary btn btn-xs normal-case"
                    disabled={saving}
                    onClick={() => setActiveReplicationId((current) => current === file.id ? null : file.id)}
                    type="button"
                  >
                    Replicate Results
                  </button>
                </div>
              </div>

              <dl className="mt-1.5 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 text-[11px] sm:grid-cols-4">
                <div className="bg-white px-2 py-1"><dt className="text-slate-500">Effective date</dt><dd className="font-semibold">{dateLabel(file.effective_date)}</dd></div>
                <div className="bg-white px-2 py-1"><dt className="text-slate-500">Condition / quality</dt><dd className="font-semibold">{file.summary.condition_rating || '—'} / {file.summary.quality_rating || '—'}</dd></div>
                <div className="bg-white px-2 py-1"><dt className="text-slate-500">GLA</dt><dd className="font-semibold">{numberLabel(file.summary.gross_living_area_sqft, ' sq. ft.')}</dd></div>
                <div className="bg-white px-2 py-1"><dt className="text-slate-500">Site / parcels</dt><dd className="font-semibold">{numberLabel(file.summary.site_area_acres, ' ac.')} · {file.summary.parcel_count ?? '—'} parcel(s)</dd></div>
              </dl>

              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
                <span>{file.summary.photo_count} verified photo(s)</span>
                <span>{file.summary.has_confirmed_sketch ? 'Confirmed sketch available' : 'No confirmed sketch recorded'}</span>
                <span>Snapshot {file.snapshot_version ?? 'pending'} · {file.snapshot_verification_status || 'pending'}</span>
                {file.replication?.source_file_number ? <span>Replicated from {file.replication.source_file_number}</span> : null}
              </div>

              {file.summary.legal_descriptions.length ? (
                <details className="mt-2 text-xs text-slate-600">
                  <summary className="cursor-pointer font-semibold">Legal description(s)</summary>
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    {file.summary.legal_descriptions.map((description) => <li key={description}>{description}</li>)}
                  </ul>
                </details>
              ) : null}

              {file.replication?.change_review_required ? (() => {
                const source = orderedFiles.find((item) => item.id === file.replication?.source_report_file_id);
                if (!source) return null;
                const differences = changeReviewRows(file, source);
                return (
                  <details className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
                    <summary className="cursor-pointer font-semibold">
                      Prior-versus-current change review ({differences.length} material difference{differences.length === 1 ? '' : 's'})
                    </summary>
                    {differences.length ? (
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        {differences.map((difference) => (
                          <div className="rounded-md bg-white px-3 py-2" key={difference.label}>
                            <div className="font-semibold">{difference.label}</div>
                            <div className="mt-0.5 text-slate-600">
                              Prior: {difference.prior ?? 'Not recorded'} · Current: {difference.current ?? 'Not recorded'}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2 leading-5">
                        No differences are currently visible in these summary fields. Inspection evidence and all
                        mutable subject details still require confirmation before analysis.
                      </p>
                    )}
                  </details>
                );
              })() : null}

              {activeReplicationId === file.id ? (
                <ReplicationForm
                  file={file}
                  saving={saving}
                  onCancel={() => setActiveReplicationId(null)}
                  onReplicate={(input) => replicate(file, input)}
                />
              ) : null}
            </article>
          ))}
        </div>
      )}
      </div>
    </details>
  );
}

