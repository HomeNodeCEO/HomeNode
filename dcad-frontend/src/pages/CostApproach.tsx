import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';

import * as api from '@/lib/api';
import {
  calculateCostApproach,
  costApproachReadinessErrors,
  type CostApproachDraft,
  type CostApproachLine,
} from '@/lib/costApproach';

const MONEY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

function money(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? MONEY.format(parsed) : 'Not reported';
}

function initialDraft(detail: api.AccountDetail): CostApproachDraft {
  const improvement = detail.primary_improvements || {};
  const currentYear = new Date().getFullYear();
  const effectiveYear = Number(improvement.effective_year_built || improvement.year_built || 0);
  const effectiveAge = Number(improvement.actual_age) || (effectiveYear > 0 ? Math.max(0, currentYear - effectiveYear) : null);
  const rawAdditional = Array.isArray((detail as any).additional_improvements)
    ? (detail as any).additional_improvements
    : [];
  const otherImprovements: CostApproachLine[] = rawAdditional.slice(0, 12).map((row: any, index: number) => ({
    id: `cad-improvement-${index + 1}`,
    description: String(row?.improvement_type || row?.description || `Additional improvement ${index + 1}`),
    quantity: Number(row?.area_sqft || row?.area || 1) || 1,
    unit: Number(row?.area_sqft || row?.area || 0) > 0 ? 'sf' : 'lump_sum',
    unit_cost: 0,
  }));
  return calculateCostApproach({
    living_area_sqft: Number(improvement.living_area_sqft || improvement.total_living_area || 0) || null,
    site_value: Number(detail.account.latest_land_value || 0) || 0,
    effective_age: effectiveAge,
    economic_life: 60,
    local_multiplier: 1,
    rounding_increment: 1_000,
    other_improvements: otherImprovements,
    methodology: 'Replacement cost new is developed from the identified cost source and local multiplier. Accrued depreciation is estimated using the age-life method, with separately identified curable physical deterioration and functional or external obsolescence. The depreciated improvement value is added to the supported site value and site improvements.',
  });
}

function NumericField({ label, value, onChange, step = '1', prefix, readOnly = false }: {
  label: string;
  value: number | null | undefined;
  onChange?: (value: number | null) => void;
  step?: string;
  prefix?: string;
  readOnly?: boolean;
}) {
  return (
    <label className="grid gap-1 text-sm text-slate-700">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      <div className="flex rounded-md border border-slate-300 bg-white focus-within:border-slate-900">
        {prefix ? <span className="px-3 py-2 text-slate-500">{prefix}</span> : null}
        <input
          type="number"
          min="0"
          step={step}
          readOnly={readOnly}
          className={`min-w-0 flex-1 rounded-md px-3 py-2 outline-none ${readOnly ? 'bg-slate-100 font-semibold' : 'bg-white'}`}
          value={value ?? ''}
          onChange={(event) => onChange?.(event.target.value === '' ? null : Number(event.target.value))}
        />
      </div>
    </label>
  );
}

export default function CostApproach() {
  const location = useLocation();
  const propertyId = useMemo(() => (new URLSearchParams(location.search).get('propertyId') || '').trim(), [location.search]);
  const requestedFileId = useMemo(() => {
    const parsed = Number(new URLSearchParams(location.search).get('assignmentFileId'));
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }, [location.search]);
  const [detail, setDetail] = useState<api.AccountDetail | null>(null);
  const [assignmentFile, setAssignmentFile] = useState<api.AppraisalAssignmentFile | null>(null);
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<CostApproachDraft | null>(null);
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
    void Promise.all([api.getAccount(propertyId), api.getAssignmentFiles(propertyId)])
      .then(async ([property, files]) => {
        if (cancelled) return;
        const selected = requestedFileId
          ? files.files.find((file) => file.id === requestedFileId) || null
          : files.latest_file;
        setDetail(property);
        setAssignmentFile(selected);
        if (!selected) {
          setDraft(initialDraft(property));
          return;
        }
        const result = await api.getCustomAppraisalWorkfile(propertyId, selected.id);
        if (cancelled) return;
        const section = result.workfile.sections.cost_approach;
        setRevision(section?.revision || 0);
        setDraft(section?.value
          ? calculateCostApproach(section.value as Partial<CostApproachDraft>)
          : initialDraft(property));
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : 'The Cost Approach could not be loaded.'))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [propertyId, requestedFileId]);

  const update = (changes: Partial<CostApproachDraft>) => setDraft((current) => current
    ? calculateCostApproach({ ...current, ...changes, saved_at: new Date().toISOString() })
    : current);
  const errors = draft ? costApproachReadinessErrors(draft) : [];
  const signed = assignmentFile?.workfile?.status === 'signed';

  const save = async () => {
    if (!draft || !assignmentFile || signed) return;
    const editorKey = sessionStorage.getItem('homenode-editor-key') || window.prompt('Enter the HomeNode editor key:', '')?.trim();
    if (!editorKey) return;
    sessionStorage.setItem('homenode-editor-key', editorKey);
    setSaving(true);
    setMessage('Saving the Cost Approach to this appraisal file...');
    try {
      const response = await api.saveCustomAppraisalWorkfileSection(
        propertyId,
        assignmentFile.id,
        'cost_approach',
        { value: draft, expected_revision: revision, save_reason: 'manual_save' },
        editorKey,
      );
      setRevision(response.section.revision);
      setDraft(calculateCostApproach(response.section.value as Partial<CostApproachDraft>));
      setMessage(`Cost Approach saved to ${assignmentFile.file_number}.`);
    } catch (error) {
      if (/revision_conflict/i.test(String(error))) setMessage('This section changed in another window. Refresh before saving again.');
      else setMessage(error instanceof Error ? error.message : 'The Cost Approach could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <main className="min-h-screen bg-slate-100 p-8 text-slate-700">Loading Cost Approach...</main>;
  if (!detail || !draft) return <main className="min-h-screen bg-slate-100 p-8 text-red-700">{message || 'Property not found.'}</main>;

  const account = detail.account;
  const setLine = (index: number, changes: Partial<CostApproachLine>) => update({
    other_improvements: draft.other_improvements.map((line, lineIndex) => lineIndex === index ? { ...line, ...changes } : line),
  });
  const addLine = () => update({
    other_improvements: [...draft.other_improvements, {
      id: `cost-line-${Date.now()}`,
      description: '',
      quantity: 1,
      unit: 'lump_sum',
      unit_cost: 0,
    }],
  });

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-6 text-slate-900 sm:px-8">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-700">Custom Appraisal</div>
              <h1 className="mt-1 text-2xl font-bold">Cost Approach</h1>
              <p className="mt-1 text-slate-600">{account.address || propertyId} · Parcel {account.account_id}</p>
              <p className="text-sm text-slate-500">{assignmentFile ? `File ${assignmentFile.file_number}` : 'Create an appraisal file before saving.'}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <a className="btn normal-case rounded-md border-slate-900 bg-white text-slate-900" href={`/report/${encodeURIComponent(propertyId)}`}>Property Report</a>
              <a className="btn normal-case rounded-md border-slate-900 bg-slate-900 text-white" href={`/AppraisalReport?propertyId=${encodeURIComponent(propertyId)}${assignmentFile ? `&assignmentFileId=${assignmentFile.id}` : ''}`}>Full Report</a>
            </div>
          </div>
        </header>

        {!assignmentFile ? <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950">Create or select an appraisal file on the Property Report before saving this approach.</div> : null}
        {signed ? <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-emerald-950">This appraisal file is signed and immutable. The saved Cost Approach is read-only.</div> : null}

        <fieldset disabled={signed} className="contents">
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-bold">Cost Source and Replacement Cost New</h2>
          <p className="mb-4 text-sm text-slate-500">Subject data are prefilled where available. Cost-source inputs remain appraiser-controlled.</p>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <label className="grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-slate-500">Cost Data Source</span><input className="rounded-md border border-slate-300 px-3 py-2" value={draft.source_name || ''} onChange={(e) => update({ source_name: e.target.value })} /></label>
            <label className="grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-slate-500">Source Reference / Version</span><input className="rounded-md border border-slate-300 px-3 py-2" value={draft.source_reference || ''} onChange={(e) => update({ source_reference: e.target.value })} /></label>
            <label className="grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-slate-500">Effective Date</span><input type="date" className="rounded-md border border-slate-300 px-3 py-2" value={draft.as_of_date || ''} onChange={(e) => update({ as_of_date: e.target.value })} /></label>
            <NumericField label="Living Area" value={draft.living_area_sqft} onChange={(value) => update({ living_area_sqft: value })} />
            <NumericField label="Base Cost / SF" prefix="$" step="0.01" value={draft.cost_per_sqft} onChange={(value) => update({ cost_per_sqft: value })} />
            <NumericField label="Local Multiplier" step="0.001" value={draft.local_multiplier} onChange={(value) => update({ local_multiplier: value || 1 })} />
            <NumericField label="Entrepreneurial Incentive %" step="0.1" value={draft.entrepreneurial_incentive_percent} onChange={(value) => update({ entrepreneurial_incentive_percent: value || 0 })} />
            <NumericField label="Dwelling Base Cost" prefix="$" value={draft.dwelling_base_cost} readOnly />
          </div>

          <div className="mt-6 flex items-center justify-between"><h3 className="font-bold">Other Improvements</h3><button type="button" className="btn btn-sm normal-case rounded-md border-slate-900 bg-slate-900 text-white" onClick={addLine} disabled={signed}>Add Improvement</button></div>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead><tr className="bg-slate-100 text-left text-xs uppercase text-slate-600"><th className="p-2">Description</th><th className="p-2">Quantity</th><th className="p-2">Unit</th><th className="p-2">Unit Cost</th><th className="p-2 text-right">Total</th><th className="p-2"></th></tr></thead>
              <tbody>{draft.other_improvements.map((line, index) => <tr key={line.id} className="border-b border-slate-200">
                <td className="p-2"><input className="w-full rounded border border-slate-300 px-2 py-1" value={line.description} onChange={(e) => setLine(index, { description: e.target.value })} /></td>
                <td className="p-2"><input type="number" min="0" className="w-28 rounded border border-slate-300 px-2 py-1" value={line.quantity} onChange={(e) => setLine(index, { quantity: Number(e.target.value) || 0 })} /></td>
                <td className="p-2"><select className="rounded border border-slate-300 px-2 py-1" value={line.unit} onChange={(e) => setLine(index, { unit: e.target.value as CostApproachLine['unit'] })}><option value="sf">SF</option><option value="lf">LF</option><option value="ea">Each</option><option value="lump_sum">Lump Sum</option></select></td>
                <td className="p-2"><input type="number" min="0" step="0.01" className="w-32 rounded border border-slate-300 px-2 py-1" value={line.unit_cost} onChange={(e) => setLine(index, { unit_cost: Number(e.target.value) || 0 })} /></td>
                <td className="p-2 text-right font-semibold">{money(line.total_cost)}</td>
                <td className="p-2 text-right"><button type="button" className="text-red-700 underline" onClick={() => update({ other_improvements: draft.other_improvements.filter((_, i) => i !== index) })} disabled={signed}>Remove</button></td>
              </tr>)}</tbody>
            </table>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-4">
            <div className="rounded-lg bg-slate-100 p-3"><div className="text-xs uppercase text-slate-500">Other Improvements</div><strong>{money(draft.other_improvements_total)}</strong></div>
            <div className="rounded-lg bg-slate-100 p-3"><div className="text-xs uppercase text-slate-500">Direct Cost</div><strong>{money(draft.direct_cost_before_incentive)}</strong></div>
            <div className="rounded-lg bg-slate-100 p-3"><div className="text-xs uppercase text-slate-500">Incentive</div><strong>{money(draft.entrepreneurial_incentive)}</strong></div>
            <div className="rounded-lg bg-emerald-50 p-3"><div className="text-xs uppercase text-emerald-700">Replacement Cost New</div><strong>{money(draft.replacement_cost_new)}</strong></div>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-bold">Accrued Depreciation</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <NumericField label="Effective Age" value={draft.effective_age} onChange={(value) => update({ effective_age: value })} />
            <NumericField label="Economic Life" value={draft.economic_life} onChange={(value) => update({ economic_life: value })} />
            <NumericField label="Override Physical %" step="0.1" value={draft.physical_depreciation_override_percent} onChange={(value) => update({ physical_depreciation_override_percent: value })} />
            <NumericField label="Applied Physical %" value={draft.physical_depreciation_percent} readOnly />
            <NumericField label="Curable Physical" prefix="$" value={draft.curable_physical_deterioration} onChange={(value) => update({ curable_physical_deterioration: value || 0 })} />
            <NumericField label="Incurable Physical" prefix="$" value={draft.incurable_physical_depreciation} readOnly />
            <NumericField label="Functional Obsolescence" prefix="$" value={draft.functional_obsolescence} onChange={(value) => update({ functional_obsolescence: value || 0 })} />
            <NumericField label="External Obsolescence" prefix="$" value={draft.external_obsolescence} onChange={(value) => update({ external_obsolescence: value || 0 })} />
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3"><div className="rounded-lg bg-slate-100 p-3"><div className="text-xs uppercase text-slate-500">Physical Depreciation</div><strong>{money(draft.physical_depreciation)}</strong></div><div className="rounded-lg bg-slate-100 p-3"><div className="text-xs uppercase text-slate-500">Total Depreciation</div><strong>{money(draft.total_depreciation)}</strong></div><div className="rounded-lg bg-emerald-50 p-3"><div className="text-xs uppercase text-emerald-700">Depreciated Improvements</div><strong>{money(draft.depreciated_improvement_value)}</strong></div></div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-bold">Site and Cost Approach Indication</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <NumericField label="Site Value" prefix="$" value={draft.site_value} onChange={(value) => update({ site_value: value || 0 })} />
            <NumericField label="Site Improvements" prefix="$" value={draft.site_improvements_value} onChange={(value) => update({ site_improvements_value: value || 0 })} />
            <NumericField label="Rounding Increment" prefix="$" value={draft.rounding_increment} onChange={(value) => update({ rounding_increment: value || 1_000 })} />
            <NumericField label="Reconciliation Weight %" value={draft.weight} onChange={(value) => update({ weight: value || 0 })} />
          </div>
          <div className="mt-5 grid gap-3 md:grid-cols-2"><div className="rounded-lg border border-emerald-200 bg-emerald-50 p-5"><div className="text-xs font-bold uppercase text-emerald-700">Calculated Indication</div><div className="text-3xl font-bold">{money(draft.indicated_value)}</div></div><div className="rounded-lg border border-slate-300 bg-slate-900 p-5 text-white"><div className="text-xs font-bold uppercase text-slate-300">Rounded Cost Approach</div><div className="text-3xl font-bold">{money(draft.rounded_indicated_value)}</div></div></div>
          <label className="mt-5 grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-slate-500">Methodology and Support</span><textarea rows={5} className="rounded-md border border-slate-300 p-3" value={draft.methodology || ''} onChange={(e) => update({ methodology: e.target.value })} /></label>
          <label className="mt-4 grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-slate-500">Cost Approach Summary</span><textarea rows={3} className="rounded-md border border-slate-300 p-3" value={draft.summary || ''} onChange={(e) => update({ summary: e.target.value })} placeholder="Explain the final indication and relevance of the approach." /></label>
        </section>
        </fieldset>

        <section className={`rounded-xl border p-5 ${errors.length ? 'border-amber-300 bg-amber-50' : 'border-emerald-300 bg-emerald-50'}`}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div><h2 className="font-bold">{errors.length ? 'Cost Approach Draft — Review Required' : 'Cost Approach Ready'}</h2>{errors.length ? <ul className="mt-2 list-disc pl-5 text-sm">{errors.map((error) => <li key={error}>{error}</li>)}</ul> : <p className="text-sm">The developed indication will populate the appraisal report and final reconciliation.</p>}{message ? <p className="mt-2 text-sm font-semibold">{message}</p> : null}</div>
            <button type="button" className="btn normal-case rounded-md border-slate-900 bg-slate-900 px-6 text-white" disabled={!assignmentFile || signed || saving} onClick={() => void save()}>{saving ? 'Saving...' : 'Save Cost Approach'}</button>
          </div>
        </section>

        <p className="pb-8 text-xs text-slate-500">All displayed calculations are recalculated and validated by the server when saved. Browser-supplied totals are never trusted.</p>
      </div>
    </main>
  );
}
