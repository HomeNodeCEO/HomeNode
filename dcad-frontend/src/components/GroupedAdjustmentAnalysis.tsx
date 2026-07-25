import { useMemo, useState } from 'react';
import * as api from '@/lib/api';
import type {
  GroupedAdjustmentOption,
  GroupedAnalysisDimension,
  GroupedAnalysisResponse,
} from '@/lib/api';

type SelectedAdjustment = {
  transitionId: string;
  transitionLabel: string;
  option: GroupedAdjustmentOption;
};

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatCurrency(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

function formatSignedCurrency(value: number) {
  if (!Number.isFinite(value)) return '—';
  const formatted = formatCurrency(Math.abs(value));
  return `${value >= 0 ? '+' : '−'}${formatted}`;
}

function formatNumber(value: number | null | undefined, digits = 0) {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatDate(value: string | null) {
  if (!value) return '—';
  const parsed = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value,
  );
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleDateString()
    : value;
}

function reliabilityClasses(reliability: GroupedAdjustmentOption['reliability']) {
  if (reliability === 'strong') return 'bg-emerald-100 text-emerald-800';
  if (reliability === 'moderate') return 'bg-sky-100 text-sky-800';
  return 'bg-amber-100 text-amber-900';
}

function DimensionTable({
  dimension,
  selected,
  onSelect,
}: {
  dimension: GroupedAnalysisDimension;
  selected?: SelectedAdjustment;
  onSelect: (
    transitionId: string,
    transitionLabel: string,
    option: GroupedAdjustmentOption,
  ) => void;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-4 py-3">
        <div className="text-base font-semibold text-slate-900">{dimension.label}</div>
        <div className="text-xs text-slate-600">
          Groups include every category through the highest observed value. Empty categories remain visible.
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-[980px] w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
            <tr>
              <th className="px-3 py-2">Group</th>
              <th className="px-3 py-2 text-right">Sales</th>
              <th className="px-3 py-2 text-right">Price range</th>
              <th className="px-3 py-2 text-right">Middle 50%</th>
              <th className="px-3 py-2 text-right">Average price</th>
              <th className="px-3 py-2 text-right">Median price</th>
              <th className="px-3 py-2 text-right">Median PPSF</th>
              <th className="px-3 py-2 text-right">Median GLA</th>
              <th className="px-3 py-2 text-right">Median DOM</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {dimension.groups.map((group) => (
              <tr key={String(group.groupValue)} className={group.sampleSize ? '' : 'bg-slate-50 text-slate-400'}>
                <td className="px-3 py-2 font-medium">{group.label}</td>
                <td className="px-3 py-2 text-right">{group.sampleSize.toLocaleString()}</td>
                <td className="px-3 py-2 text-right">
                  {group.sampleSize
                    ? `${formatCurrency(group.minimumSalePrice)} – ${formatCurrency(group.maximumSalePrice)}`
                    : '—'}
                </td>
                <td className="px-3 py-2 text-right">
                  {group.sampleSize
                    ? `${formatCurrency(group.lowerQuartileSalePrice)} – ${formatCurrency(group.upperQuartileSalePrice)}`
                    : '—'}
                </td>
                <td className="px-3 py-2 text-right">{formatCurrency(group.averageSalePrice)}</td>
                <td className="px-3 py-2 text-right font-semibold text-slate-900">
                  {formatCurrency(group.medianSalePrice)}
                </td>
                <td className="px-3 py-2 text-right">
                  {group.medianPricePerSquareFoot == null
                    ? '—'
                    : `${formatCurrency(group.medianPricePerSquareFoot)}/sf`}
                </td>
                <td className="px-3 py-2 text-right">{formatNumber(group.medianLivingArea)}</td>
                <td className="px-3 py-2 text-right">{formatNumber(group.medianDaysOnMarket, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="border-t border-slate-200 bg-slate-50/70 p-4">
        <div className="text-sm font-semibold text-slate-900">Selectable adjacent-group adjustments</div>
        <div className="mt-1 text-xs text-slate-600">
          Median differences are recommended. Average differences remain available for professional judgment.
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
          {dimension.transitions.map((transition) => (
            <div key={transition.id} className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-medium text-slate-900">{transition.label}</div>
                <div className="text-xs text-slate-500">
                  n={transition.fromSampleSize.toLocaleString()} / {transition.toSampleSize.toLocaleString()}
                </div>
              </div>
              {transition.options.length ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {transition.options.map((option) => {
                    const isSelected =
                      selected?.transitionId === transition.id &&
                      selected.option.id === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => onSelect(transition.id, transition.label, option)}
                        className={`rounded-lg border px-3 py-2 text-left transition ${
                          isSelected
                            ? 'border-emerald-500 bg-emerald-50 ring-2 ring-emerald-200'
                            : 'border-slate-200 bg-white hover:border-slate-400 hover:bg-slate-50'
                        }`}
                        aria-pressed={isSelected}
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-slate-900">
                            {formatSignedCurrency(option.amount)}
                          </span>
                          {option.recommended && (
                            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">
                              Recommended
                            </span>
                          )}
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${reliabilityClasses(option.reliability)}`}>
                            {option.reliability} sample
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-slate-600">{option.label}</div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  An adjustment cannot be calculated because one of these groups has no sales.
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function GroupedAdjustmentAnalysis({
  subjectAccountId,
}: {
  subjectAccountId: string;
}) {
  const [active, setActive] = useState(false);
  const [analysis, setAnalysis] = useState<GroupedAnalysisResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, SelectedAdjustment>>({});
  const asOfDate = useMemo(() => localDateString(), []);

  const loadAnalysis = async () => {
    if (!subjectAccountId) {
      setError('A subject property is required before grouped analysis can run.');
      return;
    }
    setActive(true);
    if (analysis || loading) return;
    setLoading(true);
    setError(null);
    try {
      setAnalysis(
        await api.getGroupedAdjustmentAnalysis(subjectAccountId, asOfDate),
      );
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Grouped analysis could not be loaded.',
      );
    } finally {
      setLoading(false);
    }
  };

  const selectedEntries = Object.entries(selected);

  return (
    <div className="mt-6 rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 p-5">
        <div className="text-xl font-semibold text-slate-900">Adjustment Methodologies</div>
        <div className="mt-1 text-sm text-slate-600">
          Run a methodology, review its market evidence, and select the adjustment supported by the dataset.
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void loadAnalysis()}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
              active
                ? 'bg-emerald-700 text-white shadow-sm'
                : 'bg-slate-900 text-white hover:bg-slate-700'
            }`}
          >
            Grouped Analysis
          </button>
          <span className="text-xs text-slate-500">
            Additional methodology buttons can be added alongside this one.
          </span>
        </div>
      </div>

      {active && (
        <div className="p-5">
          {loading && (
            <div className="rounded-lg bg-slate-50 px-4 py-5 text-sm text-slate-600">
              Calculating the latest one-year groups…
            </div>
          )}
          {error && (
            <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
              {error}
            </div>
          )}
          {analysis && (
            <>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                <div className="rounded-lg bg-slate-50 p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Market</div>
                  <div className="mt-1 font-semibold text-slate-900">{analysis.market.label}</div>
                </div>
                <div className="rounded-lg bg-slate-50 p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Study period</div>
                  <div className="mt-1 font-semibold text-slate-900">
                    {formatDate(analysis.period.start)} – {formatDate(analysis.period.end)}
                  </div>
                </div>
                <div className="rounded-lg bg-slate-50 p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Eligible sales</div>
                  <div className="mt-1 text-xl font-semibold text-slate-900">
                    {analysis.population.eligible_sale_count.toLocaleString()}
                  </div>
                </div>
                <div className="rounded-lg bg-slate-50 p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Selected adjustments</div>
                  <div className="mt-1 text-xl font-semibold text-slate-900">{selectedEntries.length}/3</div>
                </div>
              </div>

              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-950">
                This first grouped analysis shows unadjusted market differences. Sale price can also reflect living area,
                age, condition, and location, so sample strength and professional judgment remain important.
              </div>

              {selectedEntries.length > 0 && (
                <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                  <div className="text-sm font-semibold text-emerald-950">Selected market adjustments</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selectedEntries.map(([dimensionKey, selection]) => (
                      <div key={dimensionKey} className="rounded-lg bg-white px-3 py-2 text-sm shadow-sm">
                        <span className="font-semibold capitalize text-slate-900">{dimensionKey}: </span>
                        <span className="text-slate-700">{selection.transitionLabel} · </span>
                        <span className="font-semibold text-emerald-800">
                          {formatSignedCurrency(selection.option.amount)}
                        </span>
                        <span className="ml-1 text-xs text-slate-500">({selection.option.label})</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-5 space-y-5">
                {analysis.dimensions.map((dimension) => (
                  <DimensionTable
                    key={dimension.key}
                    dimension={dimension}
                    selected={selected[dimension.key]}
                    onSelect={(transitionId, transitionLabel, option) =>
                      setSelected((current) => ({
                        ...current,
                        [dimension.key]: {
                          transitionId,
                          transitionLabel,
                          option,
                        },
                      }))
                    }
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
