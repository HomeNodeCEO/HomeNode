import { useEffect, useState } from 'react';

import * as api from '@/lib/api';
import { loadAppraisalFileContext, useAppraisalFileRequest } from '@/hooks/useAppraisalFileContext';
import { requestEditorCredential } from '@/lib/editorCredential';
import {
  calculateFinalReconciliation,
  DEFAULT_APPRAISER_CERTIFICATION,
  finalReconciliationReadinessErrors,
  type FinalReconciliationApproachKey,
  type FinalReconciliationDraft,
} from '@/lib/finalReconciliation';

const APPROACHES: Array<{
  key: FinalReconciliationApproachKey;
  label: string;
  description: string;
  accent: string;
}> = [
  {
    key: 'sales_comparison',
    label: 'Sales Comparison Approach',
    description: 'Closed-sale evidence and the reconciled adjusted-sale indication.',
    accent: 'border-emerald-200 bg-emerald-50',
  },
  {
    key: 'income_approach',
    label: 'Income Approach',
    description: 'Market rent, GRM, and direct-capitalization evidence when developed.',
    accent: 'border-blue-200 bg-blue-50',
  },
  {
    key: 'cost_approach',
    label: 'Cost Approach',
    description: 'Site value plus depreciated replacement cost when developed.',
    accent: 'border-amber-200 bg-amber-50',
  },
];

function numeric(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : Number(String(value ?? '').replace(/[$,%\s,]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function money(value: unknown): string {
  const parsed = numeric(value);
  return parsed
    ? new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    }).format(parsed)
    : 'Not developed';
}

function deriveApproaches(workfile: api.CustomAppraisalWorkfile) {
  const salesSection = workfile.sections.sales_comparison;
  const incomeSection = workfile.sections.income_approach;
  const costSection = workfile.sections.cost_approach;
  const sales = (salesSection?.value || {}) as Record<string, unknown>;
  const income = (incomeSection?.value || {}) as Record<string, unknown>;
  const cost = (costSection?.value || {}) as Record<string, unknown>;
  const salesValue = numeric(sales.opinionAfterCostToCure) || numeric(sales.opinionOfValue);
  const incomeValue = income.developed === true
    ? numeric(income.rounded_indicated_value) || numeric(income.indicated_value)
    : 0;
  const costValue = cost.developed === true
    ? numeric(cost.rounded_indicated_value) || numeric(cost.indicated_value)
    : 0;
  return {
    sales_comparison: {
      developed: salesValue > 0,
      indicated_value: salesValue,
      source_revision: Number(salesSection?.revision || 0),
    },
    income_approach: {
      developed: incomeValue > 0,
      indicated_value: incomeValue,
      source_revision: Number(incomeSection?.revision || 0),
    },
    cost_approach: {
      developed: costValue > 0,
      indicated_value: costValue,
      source_revision: Number(costSection?.revision || 0),
    },
  };
}

function defaultEffectiveDate(workfile: api.CustomAppraisalWorkfile): string {
  const sales = (workfile.sections.sales_comparison?.value || {}) as {
    workspace?: { search?: { asOfDate?: string } };
  };
  return sales.workspace?.search?.asOfDate || new Date().toISOString().slice(0, 10);
}

export default function FinalReconciliation() {
  const { propertyId, requestedFileId } = useAppraisalFileRequest();
  const [detail, setDetail] = useState<api.AccountDetail | null>(null);
  const [assignmentFile, setAssignmentFile] =
    useState<api.AppraisalAssignmentFile | null>(null);
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<FinalReconciliationDraft | null>(null);
  const [sourceChanged, setSourceChanged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (!propertyId) {
      setMessage('No property account ID was provided.');
      setLoading(false);
      return () => { cancelled = true; };
    }
    void loadAppraisalFileContext(propertyId, requestedFileId)
      .then(({ property, assignmentFile: selected, workfile }) => {
        if (cancelled) return;
        setDetail(property);
        setAssignmentFile(selected);
        if (!selected || !workfile) return;
        const approaches = deriveApproaches(workfile);
        const savedSection = workfile.sections.final_reconciliation;
        const saved = savedSection?.value as Partial<FinalReconciliationDraft> | undefined;
        const stale = Boolean(saved?.approaches && APPROACHES.some(({ key }) =>
          Number(saved.approaches?.[key]?.source_revision || 0) !==
          approaches[key].source_revision ||
          Number(saved.approaches?.[key]?.indicated_value || 0) !==
          approaches[key].indicated_value
        ));
        setSourceChanged(stale);
        setRevision(savedSection?.revision || 0);
        setDraft(calculateFinalReconciliation({
          ...saved,
          effective_date: saved?.effective_date || defaultEffectiveDate(workfile),
          certification: saved?.certification || DEFAULT_APPRAISER_CERTIFICATION,
        }, approaches));
      })
      .catch((error) => {
        setMessage(error instanceof Error
          ? error.message
          : 'The Final Reconciliation could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [propertyId, requestedFileId]);

  const signed = assignmentFile?.workfile?.status === 'signed';
  const errors = draft ? finalReconciliationReadinessErrors(draft) : [];

  const update = (changes: Partial<FinalReconciliationDraft>) => {
    setDraft((current) => current
      ? calculateFinalReconciliation({
        ...current,
        ...changes,
        saved_at: new Date().toISOString(),
      }, current.approaches)
      : current);
  };

  const updateWeight = (key: FinalReconciliationApproachKey, value: number) => {
    if (!draft) return;
    update({ weights: { ...draft.weights, [key]: value } });
  };

  const applySalesOnly = () => {
    if (!draft) return;
    update({
      weights: {
        sales_comparison: 100,
        income_approach: 0,
        cost_approach: 0,
      },
      concluded_value_input: null,
    });
  };

  const distributeAcrossDeveloped = () => {
    if (!draft) return;
    const developed = APPROACHES.filter(({ key }) => draft.approaches[key].developed);
    if (!developed.length) return;
    const base = Math.floor((100 / developed.length) * 100) / 100;
    let remaining = 100;
    const weights = { sales_comparison: 0, income_approach: 0, cost_approach: 0 };
    developed.forEach(({ key }, index) => {
      const value = index === developed.length - 1 ? remaining : base;
      weights[key] = value;
      remaining = Math.round((remaining - value) * 100) / 100;
    });
    update({ weights, concluded_value_input: null });
  };

  const save = async () => {
    if (!draft || !assignmentFile || signed) return;
    const editorKey = requestEditorCredential('Enter the HomeNode editor key:');
    if (!editorKey) return;
    setSaving(true);
    setMessage('Saving the server-authoritative Final Reconciliation...');
    try {
      const response = await api.saveCustomAppraisalWorkfileSection(
        propertyId,
        assignmentFile.id,
        'final_reconciliation',
        {
          value: draft,
          expected_revision: revision,
          save_reason: 'manual_save',
        },
        editorKey,
      );
      const saved = response.section.value as FinalReconciliationDraft;
      setRevision(response.section.revision);
      setDraft(saved);
      setSourceChanged(false);
      setMessage(`Final Reconciliation saved to ${assignmentFile.file_number}.`);
    } catch (error) {
      if (/revision_conflict/i.test(String(error))) {
        setMessage('This section changed in another window. Refresh before saving again.');
      } else {
        setMessage(error instanceof Error
          ? error.message
          : 'The Final Reconciliation could not be saved.');
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <main className="hn-app-shell p-8 text-slate-700">Loading Final Reconciliation...</main>;
  }
  if (!detail || !draft) {
    return <main className="hn-app-shell p-8 text-red-700">{message || 'Create an appraisal file before completing the Final Reconciliation.'}</main>;
  }

  return (
    <main className="hn-app-shell px-4 py-6 sm:px-8">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-xs font-bold uppercase tracking-[0.18em] text-violet-700">Custom Appraisal</div>
              <h1 className="mt-1 text-2xl font-bold">Final Reconciliation</h1>
              <p className="mt-1 text-slate-600">{detail.account.address || propertyId} · Parcel {detail.account.account_id}</p>
              <p className="text-sm text-slate-500">{assignmentFile ? `File ${assignmentFile.file_number}` : 'Create an appraisal file before saving.'}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <a className="btn normal-case rounded-md border-slate-900 bg-white text-slate-900" href={`/report/${encodeURIComponent(propertyId)}`}>Property Report</a>
              <a className="btn normal-case rounded-md border-slate-900 bg-slate-900 text-white" href={`/AppraisalReport?propertyId=${encodeURIComponent(propertyId)}${assignmentFile ? `&assignmentFileId=${assignmentFile.id}` : ''}`}>Full Report</a>
            </div>
          </div>
        </header>

        {!assignmentFile ? <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950">Create or select an appraisal file on the Property Report before saving.</div> : null}
        {signed ? <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-emerald-950">This appraisal file is signed and immutable. Its final reconciliation is read-only.</div> : null}
        {sourceChanged ? <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950"><strong>Approach data changed.</strong> The calculation below uses the newest saved Sales, Income, and Cost indications. Review and save this reconciliation again before finalizing.</div> : null}

        <fieldset disabled={signed} className="contents">
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold">Approach Indications and Weight</h2>
                <p className="mt-1 text-sm text-slate-500">Values come directly from the saved approach sections. Undeveloped approaches cannot receive weight.</p>
              </div>
              <label className="grid gap-1 text-sm">
                <span className="text-xs font-semibold uppercase text-slate-500">Effective Date</span>
                <input type="date" className="rounded-md border border-slate-300 px-3 py-2" value={draft.effective_date || ''} onChange={(event) => update({ effective_date: event.target.value })} />
              </label>
            </div>
            <div className="mt-5 grid gap-4 lg:grid-cols-3">
              {APPROACHES.map(({ key, label, description, accent }) => {
                const approach = draft.approaches[key];
                return (
                  <article key={key} className={`rounded-xl border p-4 ${accent}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="font-bold">{label}</h3>
                        <p className="mt-1 text-xs leading-5 text-slate-600">{description}</p>
                      </div>
                      <span className={`rounded-full px-2 py-1 text-xs font-semibold ${approach.developed ? 'bg-emerald-100 text-emerald-900' : 'bg-slate-200 text-slate-600'}`}>{approach.developed ? 'Developed' : 'Not developed'}</span>
                    </div>
                    <div className="mt-4 text-2xl font-bold">{money(approach.indicated_value)}</div>
                    <label className="mt-4 grid gap-1 text-sm">
                      <span className="text-xs font-semibold uppercase text-slate-600">Reconciliation Weight %</span>
                      <input type="number" min="0" max="100" step="0.01" disabled={!approach.developed} className="rounded-md border border-slate-300 bg-white px-3 py-2 disabled:bg-slate-100" value={draft.weights[key]} onChange={(event) => updateWeight(key, Number(event.target.value) || 0)} />
                    </label>
                    <div className="mt-3 text-xs text-slate-500">Saved source revision {approach.source_revision || '—'}</div>
                  </article>
                );
              })}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button type="button" className="btn btn-sm normal-case rounded-md border-slate-900 bg-slate-900 text-white" onClick={applySalesOnly}>100% Sales Comparison</button>
              <button type="button" className="btn btn-sm normal-case rounded-md border-slate-400 bg-white text-slate-900" onClick={distributeAcrossDeveloped}>Distribute Across Developed</button>
              <div className={`ml-auto rounded-lg border px-4 py-2 text-sm font-bold ${Math.abs(draft.weight_total - 100) <= 0.01 ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'border-red-300 bg-red-50 text-red-900'}`}>Total Weight: {draft.weight_total}%</div>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-bold">Final Opinion of Value</h2>
            <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg bg-slate-100 p-4"><div className="text-xs font-bold uppercase text-slate-500">Weighted Indication</div><div className="mt-1 text-xl font-bold">{money(draft.calculated_weighted_value)}</div></div>
              <div className="rounded-lg bg-slate-100 p-4"><div className="text-xs font-bold uppercase text-slate-500">Rounded Indication</div><div className="mt-1 text-xl font-bold">{money(draft.rounded_weighted_value)}</div></div>
              <label className="grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-slate-500">Rounding Increment</span><input type="number" min="1" step="100" className="rounded-md border border-slate-300 px-3 py-2" value={draft.rounding_increment} onChange={(event) => update({ rounding_increment: Number(event.target.value) || 1000 })} /></label>
              <label className="grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-slate-500">Appraiser Concluded Value</span><input type="number" min="0" step="1000" className="rounded-md border border-slate-300 px-3 py-2 font-bold" value={draft.concluded_value_input ?? ''} placeholder={String(draft.rounded_weighted_value || '')} onChange={(event) => update({ concluded_value_input: event.target.value === '' ? null : Number(event.target.value) })} /></label>
            </div>
            <div className="mt-5 rounded-xl border border-violet-300 bg-violet-950 p-5 text-white">
              <div className="text-xs font-bold uppercase tracking-wide text-violet-200">Final Opinion of Value</div>
              <div className="mt-1 text-4xl font-bold">{money(draft.final_value)}</div>
              <div className="mt-2 text-sm text-violet-100">Variance from the calculated weighted indication: {draft.variance_from_weighted_percent.toFixed(2)}%</div>
            </div>
            <label className="mt-5 grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-slate-500">Final Reconciliation Explanation</span><textarea rows={6} className="rounded-md border border-slate-300 p-3" value={draft.explanation || ''} onChange={(event) => update({ explanation: event.target.value })} placeholder="Explain the reliability and relative weight given to each developed approach and support the final conclusion." /></label>
            {Math.abs(draft.variance_from_weighted_percent) > 10 ? <label className="mt-4 grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-red-700">Material Variance Explanation Required</span><textarea rows={3} className="rounded-md border border-red-300 bg-red-50 p-3" value={draft.override_explanation || ''} onChange={(event) => update({ override_explanation: event.target.value })} placeholder="Explain why the final opinion differs from the weighted indication by more than 10%." /></label> : null}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-bold">Appraiser Certification</h2>
            <textarea rows={5} className="mt-3 w-full rounded-md border border-slate-300 p-3 text-sm" value={draft.certification} onChange={(event) => update({ certification: event.target.value })} />
            <label className="mt-4 flex items-start gap-3 rounded-lg border border-slate-300 bg-slate-50 p-4 text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4" checked={draft.certification_confirmed} onChange={(event) => update({ certification_confirmed: event.target.checked })} />
              <span><strong>I confirm this certification for the current appraisal file.</strong><br /><span className="text-slate-600">Finalizing and locking the file will create the immutable signed snapshot and report artifact.</span></span>
            </label>
          </section>
        </fieldset>

        <section className={`rounded-xl border p-5 ${errors.length ? 'border-amber-300 bg-amber-50' : 'border-emerald-300 bg-emerald-50'}`}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="font-bold">{errors.length ? 'Final Reconciliation — Review Required' : 'Final Reconciliation Ready'}</h2>
              {errors.length ? <ul className="mt-2 list-disc pl-5 text-sm">{errors.map((error) => <li key={error}>{error}</li>)}</ul> : <p className="text-sm">The final value and approach weighting are ready for the report and E&amp;O preflight.</p>}
              {message ? <p className="mt-2 text-sm font-semibold">{message}</p> : null}
            </div>
            <button type="button" className="btn normal-case rounded-md border-slate-900 bg-slate-900 px-6 text-white" disabled={!assignmentFile || signed || saving} onClick={() => void save()}>{saving ? 'Saving...' : 'Save Final Reconciliation'}</button>
          </div>
        </section>

        <p className="pb-8 text-xs text-slate-500">Approach indications and weighted calculations are rebuilt by the server before saving. Changing a source approach requires this reconciliation to be reviewed and saved again.</p>
      </div>
    </main>
  );
}
