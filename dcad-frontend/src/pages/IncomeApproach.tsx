import { useEffect, useState } from 'react';

import * as api from '@/lib/api';
import NumericField from '@/components/NumericField';
import { loadAppraisalFileContext, useAppraisalFileRequest } from '@/hooks/useAppraisalFileContext';
import { requestEditorCredential } from '@/lib/editorCredential';
import {
  calculateIncomeApproach,
  incomeApproachReadinessErrors,
  type IncomeApproachDraft,
  type IncomeExpenseLine,
  type IncomeRentalComparable,
} from '@/lib/incomeApproach';

const MONEY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function money(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? MONEY.format(parsed) : 'Not reported';
}

function initialDraft(): IncomeApproachDraft {
  return calculateIncomeApproach({
    analysis_method: 'both',
    conclusion_method: 'reconciled',
    vacancy_rate: 5,
    rounding_increment: 1_000,
    expense_lines: [
      ['Property taxes', 0],
      ['Insurance', 0],
      ['Repairs and maintenance', 0],
      ['Management', 0],
      ['Utilities paid by owner', 0],
      ['Replacement reserves', 0],
      ['HOA dues', 0],
    ].map(([description, amount], index) => ({
      id: `default-expense-${index + 1}`,
      description: String(description),
      annual_amount: Number(amount),
    })),
    methodology: 'Monthly market rent is estimated from the selected competitive rental transactions. The gross rent multiplier and direct capitalization indications are developed from market-supported inputs and reconciled according to the quality and applicability of the available evidence.',
  });
}

export default function IncomeApproach() {
  const { propertyId, requestedFileId } = useAppraisalFileRequest();
  const [detail, setDetail] = useState<api.AccountDetail | null>(null);
  const [assignmentFile, setAssignmentFile] = useState<api.AppraisalAssignmentFile | null>(null);
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<IncomeApproachDraft | null>(null);
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
        if (!selected) {
          setDraft(initialDraft());
          return;
        }
        const section = workfile?.sections.income_approach;
        setRevision(section?.revision || 0);
        setDraft(section?.value
          ? calculateIncomeApproach(section.value as Partial<IncomeApproachDraft>)
          : initialDraft());
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : 'The Income Approach could not be loaded.'))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [propertyId, requestedFileId]);

  const update = (changes: Partial<IncomeApproachDraft>) => setDraft((current) => current
    ? calculateIncomeApproach({ ...current, ...changes, saved_at: new Date().toISOString() })
    : current);
  const errors = draft ? incomeApproachReadinessErrors(draft) : [];
  const signed = assignmentFile?.workfile?.status === 'signed';

  const save = async () => {
    if (!draft || !assignmentFile || signed) return;
    const editorKey = requestEditorCredential('Enter the HomeNode editor key:');
    if (!editorKey) return;
    setSaving(true);
    setMessage('Saving the Income Approach to this appraisal file...');
    try {
      const response = await api.saveCustomAppraisalWorkfileSection(
        propertyId,
        assignmentFile.id,
        'income_approach',
        { value: draft, expected_revision: revision, save_reason: 'manual_save' },
        editorKey,
      );
      setRevision(response.section.revision);
      setDraft(calculateIncomeApproach(response.section.value as Partial<IncomeApproachDraft>));
      setMessage(`Income Approach saved to ${assignmentFile.file_number}.`);
    } catch (error) {
      if (/revision_conflict/i.test(String(error))) setMessage('This section changed in another window. Refresh before saving again.');
      else setMessage(error instanceof Error ? error.message : 'The Income Approach could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <main className="min-h-screen bg-slate-100 p-8 text-slate-700">Loading Income Approach...</main>;
  if (!detail || !draft) return <main className="min-h-screen bg-slate-100 p-8 text-red-700">{message || 'Property not found.'}</main>;

  const account = detail.account;
  const setRental = (index: number, changes: Partial<IncomeRentalComparable>) => update({
    rental_comparables: draft.rental_comparables.map((row, rowIndex) => rowIndex === index ? { ...row, ...changes } : row),
  });
  const addRental = () => update({
    rental_comparables: [...draft.rental_comparables, {
      id: `rent-comparable-${Date.now()}`,
      selected: true,
      address: '',
      mls_number: null,
      lease_date: null,
      monthly_rent: 0,
      living_area_sqft: null,
      rent_per_sqft: null,
      distance_miles: null,
      source: null,
      notes: null,
    }],
  });
  const setExpense = (index: number, changes: Partial<IncomeExpenseLine>) => update({
    expense_lines: draft.expense_lines.map((row, rowIndex) => rowIndex === index ? { ...row, ...changes } : row),
  });
  const addExpense = () => update({
    expense_lines: [...draft.expense_lines, { id: `income-expense-${Date.now()}`, description: '', annual_amount: 0 }],
  });

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-6 text-slate-900 sm:px-8">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Custom Appraisal</div>
              <h1 className="mt-1 text-2xl font-bold">Income Approach</h1>
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
        {signed ? <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-emerald-950">This appraisal file is signed and immutable. The saved Income Approach is read-only.</div> : null}

        <fieldset disabled={signed} className="contents">
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-bold">Rental Market Support</h2>
            <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <label className="grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-slate-500">Rental Data Source</span><input className="rounded-md border border-slate-300 px-3 py-2" value={draft.rent_source_name || ''} onChange={(event) => update({ rent_source_name: event.target.value })} /></label>
              <label className="grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-slate-500">Source Reference</span><input className="rounded-md border border-slate-300 px-3 py-2" value={draft.rent_source_reference || ''} onChange={(event) => update({ rent_source_reference: event.target.value })} /></label>
              <label className="grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-slate-500">Effective Date</span><input type="date" className="rounded-md border border-slate-300 px-3 py-2" value={draft.as_of_date || ''} onChange={(event) => update({ as_of_date: event.target.value })} /></label>
              <label className="grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-slate-500">Analysis Methods</span><select className="rounded-md border border-slate-300 px-3 py-2" value={draft.analysis_method} onChange={(event) => update({ analysis_method: event.target.value as IncomeApproachDraft['analysis_method'] })}><option value="both">GRM + Direct Capitalization</option><option value="grm">Gross Rent Multiplier</option><option value="direct_capitalization">Direct Capitalization</option></select></label>
            </div>

            <div className="mt-6 flex items-center justify-between"><div><h3 className="font-bold">Rental Comparables</h3><p className="text-sm text-slate-500">Select the rentals relied upon for the median and average support.</p></div><button type="button" className="btn btn-sm normal-case rounded-md border-slate-900 bg-slate-900 text-white" onClick={addRental}>Add Rental</button></div>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[1100px] border-collapse text-sm">
                <thead><tr className="bg-slate-100 text-left text-xs uppercase text-slate-600"><th className="p-2">Use</th><th className="p-2">Address</th><th className="p-2">MLS #</th><th className="p-2">Lease Date</th><th className="p-2">Monthly Rent</th><th className="p-2">GLA</th><th className="p-2">Rent / SF</th><th className="p-2">Distance</th><th className="p-2">Source</th><th className="p-2"></th></tr></thead>
                <tbody>{draft.rental_comparables.map((row, index) => <tr key={row.id} className="border-b border-slate-200">
                  <td className="p-2"><input type="checkbox" checked={row.selected} onChange={(event) => setRental(index, { selected: event.target.checked })} /></td>
                  <td className="p-2"><input className="w-56 rounded border border-slate-300 px-2 py-1" value={row.address} onChange={(event) => setRental(index, { address: event.target.value })} /></td>
                  <td className="p-2"><input className="w-28 rounded border border-slate-300 px-2 py-1" value={row.mls_number || ''} onChange={(event) => setRental(index, { mls_number: event.target.value })} /></td>
                  <td className="p-2"><input type="date" className="rounded border border-slate-300 px-2 py-1" value={row.lease_date || ''} onChange={(event) => setRental(index, { lease_date: event.target.value })} /></td>
                  <td className="p-2"><input type="number" min="0" className="w-28 rounded border border-slate-300 px-2 py-1" value={row.monthly_rent || ''} onChange={(event) => setRental(index, { monthly_rent: Number(event.target.value) || 0 })} /></td>
                  <td className="p-2"><input type="number" min="0" className="w-24 rounded border border-slate-300 px-2 py-1" value={row.living_area_sqft ?? ''} onChange={(event) => setRental(index, { living_area_sqft: event.target.value ? Number(event.target.value) : null })} /></td>
                  <td className="p-2 font-semibold">{row.rent_per_sqft == null ? '—' : `$${row.rent_per_sqft.toFixed(2)}`}</td>
                  <td className="p-2"><input type="number" min="0" step="0.1" className="w-20 rounded border border-slate-300 px-2 py-1" value={row.distance_miles ?? ''} onChange={(event) => setRental(index, { distance_miles: event.target.value ? Number(event.target.value) : null })} /></td>
                  <td className="p-2"><input className="w-32 rounded border border-slate-300 px-2 py-1" value={row.source || ''} onChange={(event) => setRental(index, { source: event.target.value })} /></td>
                  <td className="p-2"><button type="button" className="text-red-700 underline" onClick={() => update({ rental_comparables: draft.rental_comparables.filter((_, rowIndex) => rowIndex !== index) })}>Remove</button></td>
                </tr>)}</tbody>
              </table>
            </div>
            {!draft.rental_comparables.length ? <p className="mt-3 rounded-md bg-slate-50 p-3 text-sm text-slate-600">No rental comparables have been entered. Trestle rental records can populate this table when that connection is activated.</p> : null}
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <div className="rounded-lg bg-slate-100 p-3"><div className="text-xs uppercase text-slate-500">Selected Rentals</div><strong>{draft.selected_rental_count}</strong></div>
              <div className="rounded-lg bg-slate-100 p-3"><div className="text-xs uppercase text-slate-500">Median Monthly Rent</div><strong>{money(draft.recommended_market_rent_median)}</strong><button type="button" className="ml-3 text-xs font-semibold underline" onClick={() => update({ market_rent: draft.recommended_market_rent_median })}>Use</button></div>
              <div className="rounded-lg bg-slate-100 p-3"><div className="text-xs uppercase text-slate-500">Average Monthly Rent</div><strong>{money(draft.recommended_market_rent_average)}</strong><button type="button" className="ml-3 text-xs font-semibold underline" onClick={() => update({ market_rent: draft.recommended_market_rent_average })}>Use</button></div>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-bold">Income and Operating Expenses</h2>
            <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <NumericField label="Monthly Market Rent" prefix="$" value={draft.market_rent} onChange={(value) => update({ market_rent: value || 0 })} />
              <NumericField label="Other Monthly Income" prefix="$" value={draft.other_income_monthly} onChange={(value) => update({ other_income_monthly: value || 0 })} />
              <NumericField label="Vacancy / Collection" suffix="%" step="0.1" value={draft.vacancy_rate} onChange={(value) => update({ vacancy_rate: value || 0 })} />
              <NumericField label="Potential Gross Income" prefix="$" value={draft.potential_gross_income} readOnly />
              <NumericField label="Vacancy and Collection Loss" prefix="$" value={draft.vacancy_collection_loss} readOnly />
              <NumericField label="Effective Gross Income" prefix="$" value={draft.effective_gross_income} readOnly />
              <NumericField label="Operating Expenses" prefix="$" value={draft.operating_expenses} readOnly />
              <NumericField label="Net Operating Income" prefix="$" value={draft.net_operating_income} readOnly />
            </div>
            <div className="mt-6 flex items-center justify-between"><h3 className="font-bold">Annual Operating Expenses</h3><button type="button" className="btn btn-sm normal-case rounded-md border-slate-900 bg-slate-900 text-white" onClick={addExpense}>Add Expense</button></div>
            <div className="mt-2 overflow-hidden rounded-lg border border-slate-200">
              {draft.expense_lines.map((row, index) => <div key={row.id} className="grid grid-cols-[1fr_180px_80px] items-center gap-3 border-b border-slate-200 p-2 last:border-b-0">
                <input className="rounded border border-slate-300 px-2 py-1" value={row.description} onChange={(event) => setExpense(index, { description: event.target.value })} />
                <div className="flex rounded border border-slate-300"><span className="px-2 py-1 text-slate-500">$</span><input type="number" min="0" className="min-w-0 flex-1 px-2 py-1" value={row.annual_amount || ''} onChange={(event) => setExpense(index, { annual_amount: Number(event.target.value) || 0 })} /></div>
                <button type="button" className="text-sm text-red-700 underline" onClick={() => update({ expense_lines: draft.expense_lines.filter((_, rowIndex) => rowIndex !== index) })}>Remove</button>
              </div>)}
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-bold">Valuation and Reconciliation</h2>
            <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <NumericField label="Gross Rent Multiplier" step="0.1" value={draft.grm} onChange={(value) => update({ grm: value })} />
              <NumericField label="GRM Indication" prefix="$" value={draft.grm_indicated_value} readOnly />
              <NumericField label="Capitalization Rate" suffix="%" step="0.01" value={draft.cap_rate} onChange={(value) => update({ cap_rate: value })} />
              <NumericField label="Direct Cap Indication" prefix="$" value={draft.direct_cap_indicated_value} readOnly />
              <label className="grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-slate-500">Conclusion Method</span><select className="rounded-md border border-slate-300 px-3 py-2" value={draft.conclusion_method} onChange={(event) => update({ conclusion_method: event.target.value as IncomeApproachDraft['conclusion_method'] })}><option value="reconciled">Appraiser Reconciliation</option><option value="grm">Gross Rent Multiplier</option><option value="direct_capitalization">Direct Capitalization</option></select></label>
              {draft.conclusion_method === 'reconciled' ? <NumericField label="Reconciled Indication" prefix="$" value={draft.reconciled_indicated_value_input} onChange={(value) => update({ reconciled_indicated_value_input: value || 0 })} /> : <NumericField label="Selected Indication" prefix="$" value={draft.indicated_value} readOnly />}
              <NumericField label="Rounding Increment" prefix="$" value={draft.rounding_increment} onChange={(value) => update({ rounding_increment: value || 1_000 })} />
              <NumericField label="Reconciliation Weight" suffix="%" value={draft.weight} onChange={(value) => update({ weight: value || 0 })} />
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-2"><div className="rounded-lg border border-blue-200 bg-blue-50 p-5"><div className="text-xs font-bold uppercase text-blue-700">Calculated Indication</div><div className="text-3xl font-bold">{money(draft.indicated_value)}</div></div><div className="rounded-lg border border-slate-300 bg-slate-900 p-5 text-white"><div className="text-xs font-bold uppercase text-slate-300">Rounded Income Approach</div><div className="text-3xl font-bold">{money(draft.rounded_indicated_value)}</div></div></div>
            <label className="mt-5 grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-slate-500">Methodology and Support</span><textarea rows={5} className="rounded-md border border-slate-300 p-3" value={draft.methodology || ''} onChange={(event) => update({ methodology: event.target.value })} /></label>
            <label className="mt-4 grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-slate-500">Income Approach Summary</span><textarea rows={3} className="rounded-md border border-slate-300 p-3" value={draft.summary || ''} onChange={(event) => update({ summary: event.target.value })} placeholder="Explain the selected indication and relevance of the approach." /></label>
          </section>
        </fieldset>

        <section className={`rounded-xl border p-5 ${errors.length ? 'border-amber-300 bg-amber-50' : 'border-emerald-300 bg-emerald-50'}`}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div><h2 className="font-bold">{errors.length ? 'Income Approach Draft — Review Required' : 'Income Approach Ready'}</h2>{errors.length ? <ul className="mt-2 list-disc pl-5 text-sm">{errors.map((error) => <li key={error}>{error}</li>)}</ul> : <p className="text-sm">The developed indication will populate the appraisal report and final reconciliation.</p>}{message ? <p className="mt-2 text-sm font-semibold">{message}</p> : null}</div>
            <button type="button" className="btn normal-case rounded-md border-slate-900 bg-slate-900 px-6 text-white" disabled={!assignmentFile || signed || saving} onClick={() => void save()}>{saving ? 'Saving...' : 'Save Income Approach'}</button>
          </div>
        </section>

        <p className="pb-8 text-xs text-slate-500">All displayed calculations are recalculated and validated by the server when saved. Browser-supplied totals are never trusted.</p>
      </div>
    </main>
  );
}
