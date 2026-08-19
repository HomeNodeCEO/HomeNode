import { useMemo, useState } from 'react';
import * as api from '@/lib/api';
import type {
  MarketConditionsAreaKey,
  RegressionAnalysisResponse,
  RegressionFeatureKey,
} from '@/lib/api';
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

function money(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

function signedMoney(value: number | null | undefined, digits = 0) {
  if (value == null || !Number.isFinite(value)) return '—';
  const absolute = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Math.abs(value));
  return `${value >= 0 ? '+' : '−'}${absolute}`;
}

function unitLabel(key: RegressionFeatureKey) {
  if (key === 'living_area' || key === 'site_size') return 'per SF';
  if (key === 'bathrooms') return 'per full-bath equivalent';
  if (key === 'garage') return 'per garage space';
  if (key === 'age') return 'per year of age';
  return 'for a pool';
}

export default function RegressionAnalysis({
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
  const [result, setResult] = useState<RegressionAnalysisResponse | null>(null);
  const [factors, setFactors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asOfDate = appraiserDefinedArea?.asOfDate || localDateString();
  const appliedRegression = useMemo(() => Object.values(appliedAdjustments).filter((item) => item.id.startsWith('regression:')), [appliedAdjustments]);

  const calculate = async () => {
    if (!marketKey) return setError('Select one market area before running regression.');
    if (marketKey === 'custom' && !appraiserDefinedArea?.geometry) return setError('Save an appraiser-defined area before using that option.');
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.runRegressionAnalysis({
        subjectAccountId,
        marketKey,
        asOf: asOfDate,
        customGeometry: marketKey === 'custom' ? appraiserDefinedArea?.geometry : null,
      }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Regression analysis could not be calculated.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-5">
      <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-5">
        <div className="text-lg font-semibold text-indigo-950">Regression Analysis</div>
        <p className="mt-2 text-sm leading-6 text-indigo-900">Ordinary least squares measures the simultaneous relationship between sale price and GLA, baths, garage spaces, pool, age, and site size. Missing fields are never replaced with zero, unlike housing types are excluded, and sale prices are not time adjusted.</p>
      </div>

      <fieldset className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <legend className="px-1 font-semibold text-slate-900">Required: choose the regression market area</legend>
        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          {AREA_OPTIONS.map((option) => {
            const disabled = option.key === 'custom' && !appraiserDefinedArea?.geometry;
            return <label key={option.key} className={`flex gap-2 rounded-lg border p-3 ${marketKey === option.key ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 bg-white'} ${disabled ? 'opacity-50' : 'cursor-pointer'}`}><input type="radio" name="regression-area" checked={marketKey === option.key} disabled={disabled || loading} onChange={() => { setMarketKey(option.key); setResult(null); }} /><span className="text-sm font-semibold">{option.label}</span></label>;
          })}
        </div>
        <button type="button" disabled={!marketKey || loading} onClick={() => void calculate()} className="mt-4 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300">{loading ? 'Fitting regression model…' : 'Calculate regression'}</button>
      </fieldset>

      {error ? <div className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{error}</div> : null}
      {result ? <div className="mt-5 space-y-4">
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap justify-between gap-3"><div><div className="text-xs font-semibold uppercase text-emerald-700">Completed regression study</div><h3 className="text-xl font-semibold">{result.market.label}</h3><p className="text-sm text-slate-600">{result.period.start} through {result.period.end} · {result.subject.housingGroup} housing</p></div><div className="grid grid-cols-3 gap-2 text-center"><div className="rounded-lg bg-slate-100 p-3"><div className="text-xs uppercase text-slate-500">Eligible</div><strong>{result.population.eligibleSaleCount}</strong></div><div className="rounded-lg bg-slate-100 p-3"><div className="text-xs uppercase text-slate-500">Model</div><strong>{result.population.modelSaleCount}</strong></div><div className="rounded-lg bg-slate-100 p-3"><div className="text-xs uppercase text-slate-500">Incomplete</div><strong>{result.population.excludedIncompleteCount}</strong></div></div></div>
          {result.model ? <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-5">{[
            ['Reliability', result.model.reliability],
            ['R²', result.model.rSquared.toFixed(3)],
            ['Adjusted R²', result.model.adjustedRSquared.toFixed(3)],
            ['RMSE', money(result.model.rootMeanSquaredError)],
            ['Parameters', String(result.model.parameterCount)],
          ].map(([label, value]) => <div key={label} className="rounded-lg border border-slate-200 p-3"><div className="text-xs uppercase text-slate-500">{label}</div><strong className="capitalize">{value}</strong></div>)}</div> : null}
          {result.warnings.length ? <ul className="mt-4 list-disc rounded-lg bg-amber-50 p-4 pl-8 text-sm text-amber-950">{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
        </section>

        {appliedRegression.length ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4"><div className="text-sm font-semibold">Applied regression adjustments</div><div className="mt-2 flex flex-wrap gap-2">{appliedRegression.map((item) => <button type="button" key={item.id} onClick={() => onRemoveAdjustment(item.id)} className="rounded-lg bg-white px-3 py-2 text-sm">{item.dimensionLabel}: {signedMoney(item.amount, item.dimensionKey === 'living_area' || item.dimensionKey === 'site_size' ? 2 : 0)} ×</button>)}</div></div> : null}

        <section className="grid gap-4 lg:grid-cols-2">
          {result.coefficients.map((coefficient) => {
            const id = `regression:${result.market.key}:${coefficient.key}`;
            const factorText = factors[id] ?? '100';
            const factor = Number(factorText);
            const factored = Number.isFinite(factor) && factor >= 0 ? coefficient.recommendedAdjustment * factor / 100 : null;
            const amount = factored == null ? null : coefficient.key === 'living_area' || coefficient.key === 'site_size' ? Math.round(factored * 100) / 100 : Math.round(factored / 100) * 100;
            const adjustment: AppliedGroupedAdjustment | null = amount == null ? null : {
              id,
              marketKey: result.market.key,
              marketLabel: result.market.label,
              dimensionKey: coefficient.key,
              dimensionLabel: coefficient.label,
              transitionId: coefficient.key,
              transitionLabel: `OLS coefficient ${unitLabel(coefficient.key)}`,
              fromGroupValue: 0,
              toGroupValue: 1,
              optionId: 'regression_coefficient',
              optionLabel: 'Multiple-regression coefficient',
              basis: 'ordinary_least_squares',
              reliability: coefficient.reliability,
              baseAmount: coefficient.recommendedAdjustment,
              factorPercent: factor,
              amount,
            };
            const preview = adjustment ? getImpactPreview(adjustment) : null;
            const applied = appliedAdjustments[id];
            return <div key={coefficient.key} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex justify-between gap-3"><div><h4 className="font-semibold">{coefficient.label}</h4><p className="text-xs text-slate-500">{coefficient.coverageCount} records · {coefficient.reliability}</p></div><div className="text-right"><div className="text-xs uppercase text-slate-500">Coefficient</div><strong>{signedMoney(coefficient.coefficient, coefficient.key === 'living_area' || coefficient.key === 'site_size' ? 2 : 0)} {unitLabel(coefficient.key)}</strong></div></div>
              <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm">Recommended rounded rate: <strong>{signedMoney(coefficient.recommendedAdjustment, coefficient.key === 'living_area' || coefficient.key === 'site_size' ? 2 : 0)}</strong> {unitLabel(coefficient.key)}</div>
              <label className="mt-3 grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-slate-500">Apply Factoring %</span><input type="number" min="0" value={factorText} onChange={(event) => setFactors((current) => ({ ...current, [id]: event.target.value }))} className="rounded border border-slate-300 px-3 py-2" /></label>
              <div className="mt-3 text-xs text-slate-600">Grid preview: {preview?.affectedCount || 0} of {preview?.selectedCount || 0} selected comparables affected.</div>
              <button type="button" disabled={!adjustment} onClick={() => adjustment && (applied ? onRemoveAdjustment(id) : onApplyAdjustment(adjustment))} className={`mt-3 w-full rounded-lg px-4 py-2 text-sm font-semibold text-white ${applied ? 'bg-red-700' : 'bg-emerald-700'} disabled:bg-slate-300`}>{applied ? 'Remove Adjustment' : 'Apply Adjustment'}</button>
            </div>;
          })}
        </section>

        <details className="rounded-xl border border-slate-200 bg-white p-4"><summary className="cursor-pointer font-semibold">Predictor coverage audit</summary><div className="mt-3 overflow-x-auto"><table className="w-full text-sm"><thead><tr className="bg-slate-100 text-left"><th className="p-2">Predictor</th><th className="p-2">Known Records</th><th className="p-2">Coverage</th></tr></thead><tbody>{result.coverage.map((row) => <tr key={row.key} className="border-b"><td className="p-2">{row.label}</td><td className="p-2">{row.count}</td><td className="p-2">{row.percent.toFixed(1)}%</td></tr>)}</tbody></table></div></details>
      </div> : null}
    </div>
  );
}
