import { useMemo, useState } from 'react';
import * as api from '@/lib/api';
import type { MarketConditionsAreaKey, SiteValuationResponse } from '@/lib/api';
import type {
  AppliedGroupedAdjustment,
  GroupedAdjustmentImpactPreview,
} from '@/components/GroupedAdjustmentAnalysis';
import type { AppraiserDefinedAdjustmentArea } from '@/components/PairedSalesAnalysis';

const AREA_OPTIONS: ReadonlyArray<{ key: MarketConditionsAreaKey; label: string }> = [
  { key: 'custom', label: 'Appraiser-defined area' },
  { key: 'city', label: 'Entire subject city' },
  { key: 'zip', label: 'Subject ZIP code' },
  ...([1, 2, 3, 4, 5] as const).map((miles) => ({
    key: `radius_${miles}` as MarketConditionsAreaKey,
    label: `Within ${miles} mile${miles === 1 ? '' : 's'}`,
  })),
];

function localDateString(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function money(value: number | null | undefined, digits = 0) {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function dateDisplay(value: string | null) {
  if (!value) return '—';
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
}

export default function SiteValuationAnalysis({
  subjectAccountId,
  appraiserDefinedArea,
  appliedAdjustments,
  getImpactPreview,
  onApplyAdjustment,
  onRemoveAdjustment,
}: {
  subjectAccountId: string;
  appraiserDefinedArea?: AppraiserDefinedAdjustmentArea | null;
  appliedAdjustments: Record<string, AppliedGroupedAdjustment>;
  getImpactPreview: (adjustment: AppliedGroupedAdjustment) => GroupedAdjustmentImpactPreview;
  onApplyAdjustment: (adjustment: AppliedGroupedAdjustment) => void;
  onRemoveAdjustment: (adjustmentId: string) => void;
}) {
  const [marketKey, setMarketKey] = useState<MarketConditionsAreaKey | ''>('');
  const [result, setResult] = useState<SiteValuationResponse | null>(null);
  const [factors, setFactors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asOfDate = appraiserDefinedArea?.asOfDate || localDateString();
  const appliedSiteStudies = useMemo(
    () => Object.values(appliedAdjustments).filter((item) => item.id.startsWith('site_valuation:')),
    [appliedAdjustments],
  );

  const calculate = async () => {
    if (!marketKey) return setError('Select one market area before running Site Valuation.');
    if (marketKey === 'custom' && !appraiserDefinedArea?.geometry) return setError('Save an appraiser-defined area before using that option.');
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.runSiteValuation({
        subjectAccountId,
        marketKey,
        asOf: asOfDate,
        customGeometry: marketKey === 'custom' ? appraiserDefinedArea?.geometry : null,
      }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Site Valuation could not be calculated.');
    } finally {
      setLoading(false);
    }
  };

  return <div className="p-5">
    <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-5">
      <div className="text-lg font-semibold text-indigo-950">Site Valuation</div>
      <p className="mt-2 text-sm leading-6 text-indigo-900">The allocation method applies each sale’s CAD land-to-total value ratio to its actual, unadjusted sale price, then divides by the known site area. Median and average site value per square foot are shown separately and may be factored before application.</p>
    </div>

    <fieldset className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <legend className="px-1 font-semibold text-slate-900">Required: choose the Site Valuation market area</legend>
      <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">{AREA_OPTIONS.map((option) => {
        const disabled = option.key === 'custom' && !appraiserDefinedArea?.geometry;
        return <label key={option.key} className={`flex gap-2 rounded-lg border p-3 ${marketKey === option.key ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 bg-white'} ${disabled ? 'opacity-50' : 'cursor-pointer'}`}><input type="radio" name="site-valuation-area" checked={marketKey === option.key} disabled={disabled || loading} onChange={() => { setMarketKey(option.key); setResult(null); }} /><span className="text-sm font-semibold">{option.label}</span></label>;
      })}</div>
      <button type="button" disabled={!marketKey || loading} onClick={() => void calculate()} className="mt-4 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300">{loading ? 'Analyzing site evidence…' : 'Calculate Site Valuation'}</button>
    </fieldset>

    {error ? <div className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{error}</div> : null}
    {result ? <div className="mt-5 space-y-4">
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-4"><div><div className="text-xs font-semibold uppercase text-emerald-700">Completed allocation study</div><h3 className="text-xl font-semibold">{result.market.label}</h3><p className="text-sm text-slate-600">{result.period.start} through {result.period.end} · prices were not time adjusted</p></div><div className="grid grid-cols-2 gap-2 text-center md:grid-cols-4">{[
          ['Eligible', result.population.eligibleSaleCount],
          ['Analyzed', result.population.analyzedSaleCount],
          ['Missing ratio', result.population.missingAllocationCount],
          ['Missing site', result.population.missingSiteSizeCount],
        ].map(([label, value]) => <div key={label} className="rounded-lg bg-slate-100 p-3"><div className="text-xs uppercase text-slate-500">{label}</div><strong>{value}</strong></div>)}</div></div>
        {result.statistics ? <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">{[
          ['Median $/SF', money(result.statistics.medianSiteValuePerSquareFoot, 2)],
          ['Average $/SF', money(result.statistics.averageSiteValuePerSquareFoot, 2)],
          ['Low $/SF', money(result.statistics.minimumSiteValuePerSquareFoot, 2)],
          ['High $/SF', money(result.statistics.maximumSiteValuePerSquareFoot, 2)],
          ['Std. dev.', money(result.statistics.standardDeviation, 2)],
          ['COD', `${result.statistics.coefficientOfDispersion.toFixed(1)}%`],
          ['CV', `${result.statistics.coefficientOfVariation.toFixed(1)}%`],
        ].map(([label, value]) => <div key={label} className="rounded-lg border border-slate-200 p-3"><div className="text-xs uppercase text-slate-500">{label}</div><strong>{value}</strong></div>)}</div> : null}
        {result.warnings.length ? <ul className="mt-4 list-disc rounded-lg bg-amber-50 p-4 pl-8 text-sm text-amber-950">{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
      </section>

      {appliedSiteStudies.length ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4"><div className="text-sm font-semibold">Applied Site Valuation adjustment</div><div className="mt-2 flex flex-wrap gap-2">{appliedSiteStudies.map((item) => <button type="button" key={item.id} onClick={() => onRemoveAdjustment(item.id)} className="rounded-lg bg-white px-3 py-2 text-sm">{item.marketLabel}: {money(item.amount, 2)}/SF ×</button>)}</div></div> : null}

      <section className="grid gap-4 md:grid-cols-2">{result.options.map((option) => {
        const id = `site_valuation:${result.market.key}:${option.id}`;
        const factorText = factors[id] ?? '100';
        const factor = Number(factorText);
        const amount = Number.isFinite(factor) && factor >= 0 ? Math.round(option.amount * factor) / 100 : null;
        const adjustment: AppliedGroupedAdjustment | null = amount == null ? null : {
          id,
          marketKey: result.market.key,
          marketLabel: result.market.label,
          dimensionKey: 'site_size',
          dimensionLabel: 'Site Size',
          transitionId: option.id,
          transitionLabel: option.label,
          fromGroupValue: 0,
          toGroupValue: 1,
          optionId: option.id,
          optionLabel: option.label,
          basis: 'allocation_site_value_per_square_foot',
          reliability: option.reliability,
          baseAmount: option.amount,
          factorPercent: factor,
          amount,
        };
        const preview = adjustment ? getImpactPreview(adjustment) : null;
        const applied = appliedAdjustments[id];
        return <div key={option.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><div className="flex justify-between gap-3"><div><h4 className="font-semibold">{option.label}</h4><p className="text-xs capitalize text-slate-500">{option.reliability} support</p></div><div className="text-right"><div className="text-xs uppercase text-slate-500">Base rate</div><strong>{money(option.amount, 2)}/SF</strong></div></div><label className="mt-3 grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-slate-500">Apply Factoring %</span><input type="number" min="0" value={factorText} onChange={(event) => setFactors((current) => ({ ...current, [id]: event.target.value }))} className="rounded border border-slate-300 px-3 py-2" /></label><div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm">Factored rate: <strong>{money(amount, 2)}/SF</strong><br /><span className="text-xs text-slate-600">Grid preview: {preview?.affectedCount || 0} of {preview?.selectedCount || 0} selected comparables affected.</span></div><button type="button" disabled={!adjustment} onClick={() => adjustment && (applied ? onRemoveAdjustment(id) : onApplyAdjustment(adjustment))} className={`mt-3 w-full rounded-lg px-4 py-2 text-sm font-semibold text-white ${applied ? 'bg-red-700' : 'bg-emerald-700'} disabled:bg-slate-300`}>{applied ? 'Remove Adjustment' : 'Apply Adjustment'}</button></div>;
      })}</section>

      <details className="rounded-xl border border-slate-200 bg-white p-4"><summary className="cursor-pointer font-semibold">Sales used in the Site Valuation analysis ({result.evidence.length})</summary><div className="mt-3 max-h-96 overflow-auto"><table className="w-full min-w-[900px] text-sm"><thead className="sticky top-0 bg-slate-100 text-left"><tr><th className="p-2">Address</th><th className="p-2">Sale date</th><th className="p-2">Sale price</th><th className="p-2">CAD land ratio</th><th className="p-2">Site SF</th><th className="p-2">Allocated site</th><th className="p-2">Site $/SF</th></tr></thead><tbody>{result.evidence.map((row, index) => <tr key={row.saleId || row.sourceRecordId || index} className="border-b"><td className="p-2">{row.address || row.accountId || 'Unmatched sale'}</td><td className="p-2">{dateDisplay(row.closingDate)}</td><td className="p-2">{money(row.salePrice)}</td><td className="p-2">{(row.allocationRatio * 100).toFixed(1)}%</td><td className="p-2">{Math.round(row.siteSizeSquareFeet).toLocaleString()}</td><td className="p-2">{money(row.allocatedSiteValue)}</td><td className="p-2">{money(row.siteValuePerSquareFoot, 2)}</td></tr>)}</tbody></table></div></details>
    </div> : null}
  </div>;
}
