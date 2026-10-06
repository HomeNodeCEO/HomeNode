import type { MarketConditionsResponse, MarketConditionsStudyAreaKey } from '@/lib/api';
import { selectedMarketDetermination } from '@/lib/marketStudyReconciliation';

const percent = (value: number | null) => value == null || !Number.isFinite(value) ? 'Unavailable' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
const number = (value: number | null) => value == null || !Number.isFinite(value) ? '—' : value.toFixed(1);

export default function MarketStudyDetermination({ response, appliedKeys, selectedKeys, onToggle, onApply, compact = false, current }: {
  response: MarketConditionsResponse;
  appliedKeys: MarketConditionsStudyAreaKey[];
  selectedKeys: MarketConditionsStudyAreaKey[];
  onToggle: (key: MarketConditionsStudyAreaKey) => void;
  onApply: () => void;
  compact?: boolean;
  current: boolean;
}) {
  const determination = selectedMarketDetermination(response, appliedKeys);
  const pending = [...appliedKeys].sort().join('|') !== [...selectedKeys].sort().join('|');
  const marketing = [[12, determination.marketingYear], [6, determination.marketingSixMonths], [3, determination.marketingThreeMonths]] as const;
  const recent = [['Past six months', determination.sixMonths], ['Past three months', determination.threeMonths]] as const;
  return <div className={`${compact ? 'mt-2 p-3' : 'mt-4 p-4'} rounded-xl border border-indigo-200 bg-white`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-indigo-700">Recommended determination</div>
        <div className="mt-1 flex flex-wrap items-baseline gap-2" aria-live="polite">
          <span className="text-xl font-bold capitalize text-slate-950">{determination.conclusion}</span>
          <span className="text-sm font-semibold text-indigo-800">{percent(determination.annual.value)} reconciled annualized change</span>
        </div>
        {determination.sampleLimitedStudies.length > 0 && <p role="status" className="mt-1 text-sm font-semibold text-amber-900">
          Provisional · insufficient sales sample: {determination.sampleLimitedStudies.join(', ')}
        </p>}
        {recent.map(([label, estimate]) => <div key={label} className="mt-1 text-sm text-indigo-950">
          {label}: <strong>{percent(estimate.value)}</strong><span className="ml-2 text-xs text-slate-600">{estimate.count}/{appliedKeys.length} studies</span>
        </div>)}
      </div>
      <div className="flex gap-5 text-right text-xs text-slate-600">
        <div>Study average<div className="font-semibold text-slate-900">{percent(determination.annual.average)}</div></div>
        <div>Study median<div className="font-semibold text-slate-900">{percent(determination.annual.median)}</div></div>
      </div>
    </div>
    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
      {marketing.map(([months, estimate]) => <div key={months} className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-950">
        <div className="text-xs">Marketing time · {months === 12 ? 'Past year' : `Past ${months} months`}</div>
        <strong>{estimate.value === null ? 'Unavailable' : `${number(estimate.value)} days`}</strong>
        <div className="text-xs text-violet-800">{estimate.count}/{appliedKeys.length} study medians reconciled</div>
      </div>)}
    </div>
    <p className="mt-2 text-xs text-slate-600">{response.recommendation.methodology_version < 3
      ? 'Rerun market studies for COD/CV ranking.' : 'Lower average COD/CV ranks higher.'}</p>
    <fieldset className="mt-3">
      <legend className="text-sm font-semibold text-slate-900">Studies given greatest weight</legend>
      <div className="mt-2 grid gap-2 md:grid-cols-3">
        {response.recommendation.ranked_studies.map(study => <label key={study.key}
          className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-xs ${selectedKeys.includes(study.key)
            ? 'border-violet-500 bg-violet-100 text-violet-950' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>
          <input type="checkbox" checked={selectedKeys.includes(study.key)} onChange={() => onToggle(study.key)} className="mt-0.5" />
          <span><span className="block font-semibold">#{study.rank} {study.label}</span>
            <span className="mt-1 block">Score {number(study.reliability_score)}/100 · {study.sale_count.toLocaleString()} sales · {percent(study.annualized_change_percent)}</span></span>
        </label>)}
      </div>
    </fieldset>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button type="button" onClick={onApply} disabled={!current || !selectedKeys.length}
        className="rounded-lg border border-amber-400 bg-violet-800 px-4 py-2 text-sm font-semibold text-amber-50 hover:bg-violet-700 disabled:opacity-50">
        Apply selected studies
      </button>
      {pending && <span role="status" className="text-xs font-medium text-amber-900">Apply to update the determination and explanation.</span>}
    </div>
    <p className="mt-2 text-xs text-slate-600">Changes compare monthly price medians. Marketing times reconcile independent study medians; overlapping sales are not pooled.</p>
  </div>;
}
