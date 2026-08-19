import { useEffect, useMemo, useState } from 'react';
import * as api from '@/lib/api';
import type {
  QualitativeAnalysisResponse,
  QualitativeClassification,
  QualitativeComparableInput,
  QualitativeSelectionInput,
  SaleRow,
} from '@/lib/api';

function compact(value: unknown) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function comparableKey(sale: SaleRow, index: number) {
  const stable = sale.source_record_id ?? sale.sale_id ?? sale.listing_key ?? sale.listing_id;
  if (stable !== null && stable !== undefined && String(stable).trim()) return `sale:${String(stable).trim()}`;
  const fallback = [sale.primary_account_id, sale.closing_date, sale.address]
    .map((value) => compact(value).toLowerCase())
    .filter(Boolean)
    .join('|');
  return fallback ? `fallback:${fallback}` : `slot:${index}`;
}

function money(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

type LocalSelection = {
  classification: QualitativeClassification | '';
  commentary: string;
};

export default function QualitativeAnalysis({
  comparables,
  savedAnalysis,
  onChange,
}: {
  comparables: QualitativeComparableInput[];
  savedAnalysis?: QualitativeAnalysisResponse | null;
  onChange: (analysis: QualitativeAnalysisResponse) => void;
}) {
  const [selections, setSelections] = useState<Record<string, LocalSelection>>({});
  const [result, setResult] = useState<QualitativeAnalysisResponse | null>(savedAnalysis || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signature = useMemo(
    () => comparables.map((comparable, index) => comparableKey(comparable.sale, index)).join('|'),
    [comparables],
  );

  useEffect(() => {
    const restored: Record<string, LocalSelection> = {};
    (savedAnalysis?.selections || []).forEach((selection) => {
      restored[selection.comparable_key] = {
        classification: selection.classification,
        commentary: selection.commentary || '',
      };
    });
    setSelections(restored);
    setResult(savedAnalysis || null);
    setError(null);
  }, [signature, savedAnalysis?.calculated_at]);

  const selectionPayload = (): QualitativeSelectionInput[] => comparables.flatMap((comparable, index) => {
    const key = comparableKey(comparable.sale, index);
    const selected = selections[key];
    if (!selected?.classification) return [];
    return [{
      comparable_key: key,
      classification: selected.classification,
      commentary: selected.commentary || null,
    }];
  });

  const calculate = async (applied: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.runQualitativeAnalysis({
        comparables,
        selections: selectionPayload(),
        applied,
      });
      setResult(response);
      onChange(response);
    } catch (calculateError) {
      setError(calculateError instanceof Error ? calculateError.message : 'Qualitative analysis could not be calculated.');
    } finally {
      setLoading(false);
    }
  };

  const updateSelection = (key: string, changes: Partial<LocalSelection>) => {
    setSelections((current) => ({
      ...current,
      [key]: { classification: '', commentary: '', ...current[key], ...changes },
    }));
    setResult(null);
  };

  return <div className="p-5">
    <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-5">
      <div className="text-lg font-semibold text-indigo-950">Qualitative Analyses</div>
      <p className="mt-2 text-sm leading-6 text-indigo-900">Classify the selected comparables relative to the subject. Inferior indications establish lower support, superior indications establish upper support, and similar indications guide reconciliation. This method does not invent line-item dollar adjustments.</p>
    </div>

    {!comparables.length ? <div className="mt-4 rounded-lg bg-amber-50 p-4 text-sm text-amber-900">Add comparable sales to the primary grid before completing qualitative bracketing.</div> : <div className="mt-4 space-y-3">{comparables.map((comparable, index) => {
      const key = comparableKey(comparable.sale, index);
      const selected = selections[key] || { classification: '', commentary: '' };
      return <div key={key} className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 lg:grid-cols-[minmax(240px,1fr)_220px_minmax(260px,1fr)] lg:items-center"><div><div className="text-xs font-semibold uppercase text-emerald-700">Comparable #{index + 1}</div><div className="font-semibold text-slate-900">{comparable.sale.address || comparable.sale.primary_account_id || 'Unmatched sale'}</div><div className="text-sm text-slate-600">Adjusted indication: <strong>{money(comparable.indicatedValue)}</strong> · Sale price {money(Number(comparable.sale.sale_price || 0))}</div></div><label className="grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-slate-500">Relative to subject</span><select value={selected.classification} onChange={(event) => updateSelection(key, { classification: event.target.value as QualitativeClassification | '' })} className="rounded border border-slate-300 px-3 py-2"><option value="">Not classified</option><option value="inferior">Inferior to subject</option><option value="similar">Similar to subject</option><option value="superior">Superior to subject</option><option value="excluded">Exclude from qualitative analysis</option></select></label><label className="grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-slate-500">Reason / commentary</span><input value={selected.commentary} onChange={(event) => updateSelection(key, { commentary: event.target.value })} placeholder="Why this comparable is inferior, similar, superior, or excluded" className="rounded border border-slate-300 px-3 py-2" /></label></div>;
    })}</div>}

    {error ? <div className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</div> : null}
    {comparables.length ? <button type="button" disabled={loading || selectionPayload().length < 2} onClick={() => void calculate(false)} className="mt-4 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300">{loading ? 'Calculating…' : 'Calculate Qualitative Conclusion'}</button> : null}

    {result ? <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-xs font-semibold uppercase text-emerald-700">Qualitative reconciliation</div><h3 className="text-xl font-semibold">Recommended {money(result.conclusion.recommended_value)}</h3></div><span className={`rounded-full px-3 py-1 text-xs font-semibold ${result.conclusion.bracket_consistent ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}`}>{result.conclusion.bracket_consistent ? 'Consistent bracket' : 'Inconsistent bracket'}</span></div>
      <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">{[
        ['Lower support', money(result.conclusion.lower_bound)],
        ['Similar median', money(result.conclusion.similar_median)],
        ['Upper support', money(result.conclusion.upper_bound)],
        ['Analyzed sales', result.conclusion.analyzed_count],
      ].map(([label, value]) => <div key={label} className="rounded-lg bg-slate-50 p-3"><div className="text-xs uppercase text-slate-500">{label}</div><strong>{value}</strong></div>)}</div>
      <p className="mt-4 rounded-lg bg-indigo-50 p-3 text-sm leading-6 text-indigo-950">{result.conclusion.narrative}</p>
      {result.conclusion.warnings.length ? <ul className="mt-3 list-disc rounded-lg bg-amber-50 p-4 pl-8 text-sm text-amber-950">{result.conclusion.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
      <button type="button" disabled={loading || result.conclusion.recommended_value == null || !result.conclusion.bracket_consistent} onClick={() => void calculate(!result.applied)} className={`mt-4 w-full rounded-lg px-4 py-2 text-sm font-semibold text-white ${result.applied ? 'bg-red-700' : 'bg-emerald-700'} disabled:bg-slate-300`}>{result.applied ? 'Remove Qualitative Conclusion' : 'Use as Sales Comparison Opinion'}</button>
      <p className="mt-2 text-xs text-slate-500">The quantitative median remains unchanged unless this conclusion is explicitly applied. Applying it changes the reconciled Sales Comparison opinion, not the individual line-item adjustments.</p>
    </section> : null}
  </div>;
}
