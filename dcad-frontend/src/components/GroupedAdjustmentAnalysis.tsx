import { useMemo, useState } from 'react';
import * as api from '@/lib/api';
import type {
  GroupedAdjustmentOption,
  GroupedAnalysisDimension,
  GroupedAnalysisResponse,
  GroupedAnalysisTransition,
} from '@/lib/api';

export type AppliedGroupedAdjustment = {
  id: string;
  dimensionKey: GroupedAnalysisDimension['key'];
  dimensionLabel: string;
  transitionId: string;
  transitionLabel: string;
  fromGroupValue: number | boolean;
  toGroupValue: number | boolean;
  optionId: string;
  optionLabel: string;
  basis: string;
  reliability: GroupedAdjustmentOption['reliability'];
  baseAmount: number;
  factorPercent: number;
  amount: number;
};

type SelectedAdjustment = {
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

function transitionKey(dimensionKey: GroupedAnalysisDimension['key'], transitionId: string) {
  return `${dimensionKey}:${transitionId}`;
}

function recommendedOption(transition: GroupedAnalysisTransition) {
  return transition.options.find((option) => option.recommended) || transition.options[0];
}

function factoredAmount(amount: number, factorPercent: number) {
  return Math.round((amount * factorPercent) / 100 / 100) * 100;
}

function DimensionTable({
  dimension,
  selections,
  factors,
  appliedAdjustments,
  onSelect,
  onFactorChange,
  onApply,
  onRemove,
}: {
  dimension: GroupedAnalysisDimension;
  selections: Record<string, SelectedAdjustment>;
  factors: Record<string, string>;
  appliedAdjustments: Record<string, AppliedGroupedAdjustment>;
  onSelect: (key: string, option: GroupedAdjustmentOption) => void;
  onFactorChange: (key: string, factor: string) => void;
  onApply: (
    transition: GroupedAnalysisTransition,
    option: GroupedAdjustmentOption,
    factorPercent: number,
  ) => void;
  onRemove: (key: string) => void;
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
          {dimension.transitions.map((transition) => {
            const key = transitionKey(dimension.key, transition.id);
            const selectedOption = selections[key]?.option || recommendedOption(transition);
            const factorText = factors[key] ?? '100';
            const factorPercent = Number(factorText);
            const factorValid = factorText.trim() !== '' && Number.isFinite(factorPercent) && factorPercent >= 0;
            const result = selectedOption && factorValid
              ? factoredAmount(selectedOption.amount, factorPercent)
              : null;
            const applied = appliedAdjustments[key];
            const isCurrentApplied = Boolean(
              applied &&
              selectedOption &&
              factorValid &&
              applied.optionId === selectedOption.id &&
              applied.factorPercent === factorPercent &&
              applied.amount === result,
            );

            return (
              <div key={transition.id} className="flex flex-col rounded-lg border border-slate-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium text-slate-900">{transition.label}</div>
                  <div className="text-xs text-slate-500">
                    n={transition.fromSampleSize.toLocaleString()} / {transition.toSampleSize.toLocaleString()}
                  </div>
                </div>
                {transition.options.length ? (
                  <>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {transition.options.map((option) => {
                        const isSelected = selectedOption?.id === option.id;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            onClick={() => onSelect(key, option)}
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

                    <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <label htmlFor={`factor-${key}`} className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                        Apply Factoring
                      </label>
                      <div className="mt-1 flex items-center gap-2">
                        <input
                          id={`factor-${key}`}
                          type="number"
                          min="0"
                          step="1"
                          inputMode="decimal"
                          value={factorText}
                          onChange={(event) => onFactorChange(key, event.target.value)}
                          className="w-28 rounded-md border border-slate-300 bg-white px-3 py-2 text-right text-sm font-semibold text-slate-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200"
                          aria-describedby={`factor-help-${key}`}
                        />
                        <span className="font-semibold text-slate-700">%</span>
                        <span id={`factor-help-${key}`} className="text-xs text-slate-500">
                          of the selected market difference
                        </span>
                      </div>
                      {!factorValid && (
                        <div className="mt-1 text-xs font-medium text-red-700">
                          Enter a percentage of zero or greater.
                        </div>
                      )}
                    </div>

                    <div className="mt-auto pt-4">
                      <div className="flex items-end justify-between gap-3">
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Resulting adjustment
                          </div>
                          <div className="mt-1 text-xl font-semibold text-slate-900">
                            {result == null ? '—' : formatSignedCurrency(result)}
                          </div>
                          {selectedOption && factorValid && factorPercent !== 100 && (
                            <div className="text-xs text-slate-500">
                              {formatSignedCurrency(selectedOption.amount)} × {formatNumber(factorPercent, 0)}%
                            </div>
                          )}
                        </div>
                        {applied && !isCurrentApplied && (
                          <button
                            type="button"
                            onClick={() => onRemove(key)}
                            className="text-xs font-semibold text-slate-600 underline decoration-slate-300 underline-offset-2 hover:text-slate-900"
                          >
                            Remove applied
                          </button>
                        )}
                      </div>
                      <button
                        type="button"
                        disabled={!selectedOption || !factorValid}
                        onClick={() => {
                          if (selectedOption && factorValid) {
                            onApply(transition, selectedOption, factorPercent);
                          }
                        }}
                        className={`mt-3 w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500 ${
                          isCurrentApplied
                            ? 'bg-emerald-100 text-emerald-900 ring-1 ring-emerald-300'
                            : 'bg-emerald-700 text-white hover:bg-emerald-800'
                        }`}
                      >
                        {isCurrentApplied ? 'Applied to Sales Grid' : applied ? 'Update Adjustment' : 'Apply Adjustment'}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    An adjustment cannot be calculated because one of these groups has no sales.
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function GroupedAdjustmentAnalysis({
  subjectAccountId,
  appliedAdjustments,
  onApplyAdjustment,
  onRemoveAdjustment,
}: {
  subjectAccountId: string;
  appliedAdjustments: Record<string, AppliedGroupedAdjustment>;
  onApplyAdjustment: (adjustment: AppliedGroupedAdjustment) => void;
  onRemoveAdjustment: (adjustmentId: string) => void;
}) {
  const [active, setActive] = useState(false);
  const [analysis, setAnalysis] = useState<GroupedAnalysisResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selections, setSelections] = useState<Record<string, SelectedAdjustment>>({});
  const [factors, setFactors] = useState<Record<string, string>>({});
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

  const appliedEntries = Object.values(appliedAdjustments);
  const appliedDimensionCount = new Set(
    appliedEntries.map((adjustment) => adjustment.dimensionKey),
  ).size;

  return (
    <div className="mt-6 rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 p-5">
        <div className="text-xl font-semibold text-slate-900">Adjustment Methodologies</div>
        <div className="mt-1 text-sm text-slate-600">
          Run a methodology, review its market evidence, factor it when appropriate, and apply the supported adjustment to the grid.
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
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Applied studies</div>
                  <div className="mt-1 text-xl font-semibold text-slate-900">
                    {appliedEntries.length}
                    <span className="ml-1 text-sm font-medium text-slate-500">
                      across {appliedDimensionCount}/3 sections
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-950">
                This grouped analysis shows unadjusted market differences. Sale price can also reflect living area,
                age, condition, and location, so sample strength and professional judgment remain important.
              </div>

              {appliedEntries.length > 0 && (
                <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                  <div className="text-sm font-semibold text-emerald-950">Applied market adjustments</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {appliedEntries.map((adjustment) => (
                      <div key={adjustment.id} className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm shadow-sm">
                        <div>
                          <span className="font-semibold text-slate-900">{adjustment.dimensionLabel}: </span>
                          <span className="text-slate-700">{adjustment.transitionLabel} · </span>
                          <span className="font-semibold text-emerald-800">
                            {formatSignedCurrency(adjustment.amount)}
                          </span>
                          <span className="ml-1 text-xs text-slate-500">
                            ({adjustment.optionLabel}, {formatNumber(adjustment.factorPercent, 0)}%)
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => onRemoveAdjustment(adjustment.id)}
                          className="rounded-full px-1.5 py-0.5 text-xs font-bold text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                          aria-label={`Remove ${adjustment.transitionLabel} adjustment`}
                        >
                          ×
                        </button>
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
                    selections={selections}
                    factors={factors}
                    appliedAdjustments={appliedAdjustments}
                    onSelect={(key, option) =>
                      setSelections((current) => ({
                        ...current,
                        [key]: { option },
                      }))
                    }
                    onFactorChange={(key, factor) =>
                      setFactors((current) => ({
                        ...current,
                        [key]: factor,
                      }))
                    }
                    onApply={(transition, option, factorPercent) => {
                      const id = transitionKey(dimension.key, transition.id);
                      onApplyAdjustment({
                        id,
                        dimensionKey: dimension.key,
                        dimensionLabel: dimension.label,
                        transitionId: transition.id,
                        transitionLabel: transition.label,
                        fromGroupValue: transition.fromGroupValue,
                        toGroupValue: transition.toGroupValue,
                        optionId: option.id,
                        optionLabel: option.label,
                        basis: option.basis,
                        reliability: option.reliability,
                        baseAmount: option.amount,
                        factorPercent,
                        amount: factoredAmount(option.amount, factorPercent),
                      });
                    }}
                    onRemove={onRemoveAdjustment}
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
