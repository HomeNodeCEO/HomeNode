import { useMemo, useState } from 'react';
import * as api from '@/lib/api';
import type {
  GroupedAdjustmentOption,
  GroupedAnalysesResponse,
  GroupedAnalysisBreakdownKey,
  GroupedAnalysisDimension,
  GroupedAnalysisTransition,
} from '@/lib/api';
import PairedSalesAnalysis, {
  type AppraiserDefinedAdjustmentArea,
} from '@/components/PairedSalesAnalysis';
import RegressionAnalysis from '@/components/RegressionAnalysis';
import DepreciatedCostAnalysis from '@/components/DepreciatedCostAnalysis';

export type AdjustmentDimensionKey =
  | GroupedAnalysisDimension['key']
  | 'age'
  | 'site_size';

export type AppliedGroupedAdjustment = {
  id: string;
  marketKey: GroupedAnalysisBreakdownKey | 'cost_approach';
  marketLabel: string;
  dimensionKey: AdjustmentDimensionKey;
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
  sourcePriceDifference?: number;
  sourceLivingAreaDifference?: number;
  factorPercent: number;
  amount: number;
};

export type GroupedAdjustmentImpactPreview = {
  adjustments: number[];
  selectedCount: number;
  affectedCount: number;
};

type SelectedAdjustment = {
  option: GroupedAdjustmentOption;
};

type AdjustmentMethodologyKey =
  | 'paired_sales'
  | 'grouped'
  | 'regression'
  | 'depreciated_cost'
  | 'site_valuation'
  | 'qualitative';

const METHODOLOGY_OPTIONS: ReadonlyArray<{
  key: AdjustmentMethodologyKey;
  label: string;
  description: string;
}> = [
  {
    key: 'paired_sales',
    label: 'Paired Sales Analysis',
    description: 'Compare closely matched sale pairs to isolate a feature’s market contribution.',
  },
  {
    key: 'grouped',
    label: 'Grouped Analysis',
    description: 'Compare median results across selected market groups and apply supported adjustments.',
  },
  {
    key: 'regression',
    label: 'Regression Analysis',
    description: 'Measure relationships between sale price and multiple property characteristics.',
  },
  {
    key: 'depreciated_cost',
    label: 'Depreciated Cost',
    description: 'Estimate contributory value from cost new less observed depreciation.',
  },
  {
    key: 'site_valuation',
    label: 'Site Valuation',
    description: 'Analyze land and site evidence separately from the property’s improvements.',
  },
  {
    key: 'qualitative',
    label: 'Qualitative Analyses',
    description: 'Reconcile inferior, similar, and superior market evidence without unsupported dollar precision.',
  },
];

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

function transitionKey(
  marketKey: GroupedAnalysisBreakdownKey,
  dimensionKey: GroupedAnalysisDimension['key'],
  transitionId: string,
) {
  return `${marketKey}:${dimensionKey}:${transitionId}`;
}

function recommendedOption(transition: GroupedAnalysisTransition) {
  return transition.options.find((option) => option.recommended) || transition.options[0];
}

function factoredAmount(
  amount: number,
  factorPercent: number,
  dimensionKey: GroupedAnalysisDimension['key'],
) {
  const factored = (amount * factorPercent) / 100;
  return dimensionKey === 'living_area'
    ? Math.round(factored)
    : Math.round(factored / 100) * 100;
}

function buildAppliedAdjustment(
  marketKey: GroupedAnalysisBreakdownKey,
  marketLabel: string,
  dimension: GroupedAnalysisDimension,
  transition: GroupedAnalysisTransition,
  option: GroupedAdjustmentOption,
  factorPercent: number,
): AppliedGroupedAdjustment {
  const id = transitionKey(marketKey, dimension.key, transition.id);
  return {
    id,
    marketKey,
    marketLabel,
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
    sourcePriceDifference: option.priceDifference,
    sourceLivingAreaDifference: option.livingAreaDifference,
    factorPercent,
    amount: factoredAmount(option.amount, factorPercent, dimension.key),
  };
}

function DimensionTable({
  marketKey,
  marketLabel,
  dimension,
  selections,
  factors,
  appliedAdjustments,
  getImpactPreview,
  onSelect,
  onFactorChange,
  onApply,
  onRemove,
}: {
  marketKey: GroupedAnalysisBreakdownKey;
  marketLabel: string;
  dimension: GroupedAnalysisDimension;
  selections: Record<string, SelectedAdjustment>;
  factors: Record<string, string>;
  appliedAdjustments: Record<string, AppliedGroupedAdjustment>;
  getImpactPreview: (adjustment: AppliedGroupedAdjustment) => GroupedAdjustmentImpactPreview;
  onSelect: (key: string, option: GroupedAdjustmentOption) => void;
  onFactorChange: (key: string, factor: string) => void;
  onApply: (adjustment: AppliedGroupedAdjustment) => void;
  onRemove: (key: string) => void;
}) {
  const isLivingArea = dimension.key === 'living_area';
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-4 py-3">
        <div className="text-base font-semibold text-slate-900">{dimension.label}</div>
        <div className="text-xs text-slate-600">
          {isLivingArea
            ? 'All eligible sales are ordered by living area and divided into ten market bands. Each study divides the group price difference by the difference in median or average living area.'
            : 'Groups include every category through the highest observed value. Empty categories remain visible.'}
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
        <div className="text-sm font-semibold text-slate-900">Alternative market-supported unit adjustments</div>
        <div className="mt-1 text-xs text-slate-600">
          Each tile is an alternative study. Applying one uses its factored figure uniformly for every
          difference in this section and replaces the currently applied figure for this section.
        </div>
        <div className={`mt-3 grid grid-cols-1 gap-3 ${isLivingArea ? '' : 'lg:grid-cols-2'}`}>
          {dimension.transitions.map((transition) => {
            const key = transitionKey(marketKey, dimension.key, transition.id);
            const selectedOption = selections[key]?.option || recommendedOption(transition);
            const factorText = factors[key] ?? '100';
            const factorPercent = Number(factorText);
            const factorValid = factorText.trim() !== '' && Number.isFinite(factorPercent) && factorPercent >= 0;
            const result = selectedOption && factorValid
              ? factoredAmount(selectedOption.amount, factorPercent, dimension.key)
              : null;
            const draftAdjustment = selectedOption && factorValid
              ? buildAppliedAdjustment(
                  marketKey,
                  marketLabel,
                  dimension,
                  transition,
                  selectedOption,
                  factorPercent,
                )
              : null;
            const impactPreview = draftAdjustment
              ? getImpactPreview(draftAdjustment)
              : null;
            const applied = appliedAdjustments[key];
            const hasAppliedDimension = Object.values(appliedAdjustments).some(
              (adjustment) => adjustment.dimensionKey === dimension.key,
            );
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
                            onClick={() => {
                              onSelect(key, option);
                              if (applied) {
                                const nextFactor = Number(factorText);
                                if (
                                  factorText.trim() !== '' &&
                                  Number.isFinite(nextFactor) &&
                                  nextFactor >= 0
                                ) {
                                  onApply(buildAppliedAdjustment(
                                    marketKey,
                                    marketLabel,
                                    dimension,
                                    transition,
                                    option,
                                    nextFactor,
                                  ));
                                }
                              }
                            }}
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
                                {isLivingArea ? ' / SF' : ''}
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
                            {isLivingArea &&
                              option.priceDifference != null &&
                              option.livingAreaDifference != null &&
                              Number.isFinite(option.priceDifference) &&
                              Number.isFinite(option.livingAreaDifference) && (
                                <div className="mt-1 text-xs font-medium text-slate-700">
                                  {formatCurrency(option.priceDifference)} ÷{' '}
                                  {formatNumber(option.livingAreaDifference)} SF
                                </div>
                              )}
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
                          onChange={(event) => {
                            const nextFactorText = event.target.value;
                            onFactorChange(key, nextFactorText);
                            if (applied && selectedOption) {
                              const nextFactor = Number(nextFactorText);
                              if (
                                nextFactorText.trim() !== '' &&
                                Number.isFinite(nextFactor) &&
                                nextFactor >= 0
                              ) {
                                onApply(buildAppliedAdjustment(
                                  marketKey,
                                  marketLabel,
                                  dimension,
                                  transition,
                                  selectedOption,
                                  nextFactor,
                                ));
                              }
                            }
                          }}
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
                            {result == null
                              ? '—'
                              : `${formatSignedCurrency(result)}${isLivingArea ? ' / SF' : ''}`}
                          </div>
                          {selectedOption && factorValid && factorPercent !== 100 && (
                            <div className="text-xs text-slate-500">
                              {formatSignedCurrency(selectedOption.amount)} × {formatNumber(factorPercent, 0)}%
                            </div>
                          )}
                        </div>
                        {applied && (
                          <button
                            type="button"
                            onClick={() => onRemove(key)}
                            className="text-xs font-semibold text-slate-600 underline decoration-slate-300 underline-offset-2 hover:text-slate-900"
                          >
                            Remove applied
                          </button>
                        )}
                      </div>
                      {impactPreview && (
                        <div
                          className={`mt-3 rounded-lg border px-3 py-2 text-xs leading-5 ${
                            impactPreview.affectedCount > 0
                              ? 'border-emerald-200 bg-emerald-50 text-emerald-950'
                              : 'border-amber-200 bg-amber-50 text-amber-950'
                          }`}
                          aria-live="polite"
                          data-testid={`grid-preview-${key}`}
                        >
                          {impactPreview.selectedCount === 0 ? (
                            'Add comparables to preview how this figure will affect the grid.'
                          ) : impactPreview.affectedCount === 0 ? (
                            <>
                              This figure is ready to apply uniformly. The current comparables have no
                              {dimension.key === 'bathrooms'
                                ? ' equivalent-bath'
                                : dimension.key === 'garage'
                                  ? ' garage-space'
                                  : dimension.key === 'living_area'
                                    ? ' living-area'
                                    : ' pool-status'}{' '}
                              difference from the subject, so the current grid would remain unchanged.
                            </>
                          ) : (
                            <>
                              <span className="font-semibold">
                                Grid preview ({impactPreview.affectedCount} of {impactPreview.selectedCount} affected):
                              </span>{' '}
                              {impactPreview.adjustments
                                .map((amount, index) => amount !== 0
                                  ? `Comp ${index + 1}: ${formatSignedCurrency(amount)}`
                                  : null)
                                .filter(Boolean)
                                .join(' / ')}
                            </>
                          )}
                          {dimension.key === 'bathrooms' && result != null && (
                            <div className="mt-1 text-slate-600">
                              Uniform rate — full bath: {formatSignedCurrency(Math.abs(result))} / half bath:{' '}
                              {formatSignedCurrency(Math.abs(result) / 2)}
                            </div>
                          )}
                          {dimension.key === 'garage' && result != null && (
                            <div className="mt-1 text-slate-600">
                              Uniform rate per garage space: {formatSignedCurrency(Math.abs(result))}
                            </div>
                          )}
                          {dimension.key === 'pool' && result != null && (
                            <div className="mt-1 text-slate-600">
                              Applied to every subject/comparable pool-status difference.
                            </div>
                          )}
                          {dimension.key === 'living_area' && result != null && (
                            <div className="mt-1 text-slate-600">
                              Uniform rate per square foot: {formatSignedCurrency(Math.abs(result))}
                            </div>
                          )}
                        </div>
                      )}
                      <button
                        type="button"
                        disabled={!selectedOption || !factorValid}
                        onClick={() => {
                          if (draftAdjustment) {
                            onApply(draftAdjustment);
                          }
                        }}
                        className={`mt-3 w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500 ${
                          isCurrentApplied
                            ? 'bg-emerald-100 text-emerald-900 ring-1 ring-emerald-300'
                            : 'bg-emerald-700 text-white hover:bg-emerald-800'
                        }`}
                      >
                        {isCurrentApplied
                          ? impactPreview?.affectedCount
                            ? `Applied to ${impactPreview.affectedCount} Comparable${impactPreview.affectedCount === 1 ? '' : 's'}`
                            : 'Applied - No Current Difference'
                          : applied
                            ? 'Update Adjustment'
                            : hasAppliedDimension
                              ? 'Apply & Replace Current Rate'
                              : 'Apply Adjustment'}
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

const BREAKDOWN_OPTIONS: Array<{
  key: GroupedAnalysisBreakdownKey;
  label: string;
  description: string;
}> = [
  {
    key: 'city',
    label: 'Entire subject city',
    description: 'The existing citywide market study.',
  },
  {
    key: 'zip',
    label: 'Subject ZIP code',
    description: 'Sales sharing the subject property’s five-digit ZIP code.',
  },
  ...([1, 2, 3, 4, 5] as const).map((miles) => ({
    key: `radius_${miles}` as GroupedAnalysisBreakdownKey,
    label: `Within ${miles} mile${miles === 1 ? '' : 's'}`,
    description: `A cumulative radius including every eligible sale from 0 to ${miles} mile${miles === 1 ? '' : 's'} away.`,
  })),
];

export default function GroupedAdjustmentAnalysis({
  subjectAccountId,
  assignmentFileId,
  appraiserDefinedArea,
  appliedAdjustments,
  getImpactPreview,
  onApplyAdjustment,
  onRemoveAdjustment,
}: {
  subjectAccountId: string;
  assignmentFileId?: number | null;
  appraiserDefinedArea?: AppraiserDefinedAdjustmentArea | null;
  appliedAdjustments: Record<string, AppliedGroupedAdjustment>;
  getImpactPreview: (adjustment: AppliedGroupedAdjustment) => GroupedAdjustmentImpactPreview;
  onApplyAdjustment: (adjustment: AppliedGroupedAdjustment) => void;
  onRemoveAdjustment: (adjustmentId: string) => void;
}) {
  const [activeMethod, setActiveMethod] =
    useState<AdjustmentMethodologyKey | null>(null);
  const [selectedBreakdowns, setSelectedBreakdowns] = useState<GroupedAnalysisBreakdownKey[]>([]);
  const [analysisResult, setAnalysisResult] = useState<GroupedAnalysesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selections, setSelections] = useState<Record<string, SelectedAdjustment>>({});
  const [factors, setFactors] = useState<Record<string, string>>({});
  const asOfDate = useMemo(() => localDateString(), []);

  const updateBreakdowns = (next: GroupedAnalysisBreakdownKey[]) => {
    setSelectedBreakdowns(next);
    setAnalysisResult(null);
    setError(null);
  };

  const toggleBreakdown = (key: GroupedAnalysisBreakdownKey) => {
    updateBreakdowns(
      selectedBreakdowns.includes(key)
        ? selectedBreakdowns.filter((item) => item !== key)
        : [...selectedBreakdowns, key],
    );
  };

  const loadAnalysis = async () => {
    if (!subjectAccountId) {
      setError('A subject property is required before grouped analysis can run.');
      return;
    }
    if (!selectedBreakdowns.length) {
      setError('Select at least one market breakdown before calculating results.');
      return;
    }
    setLoading(true);
    setAnalysisResult(null);
    setError(null);
    try {
      setAnalysisResult(
        await api.getGroupedAdjustmentAnalyses(
          subjectAccountId,
          selectedBreakdowns,
          asOfDate,
        ),
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
        <div className={`mt-3 inline-flex rounded-full px-3 py-1 text-xs font-semibold ${
          appraiserDefinedArea
            ? 'bg-emerald-100 text-emerald-800'
            : 'bg-slate-100 text-slate-600'
        }`}>
          {appraiserDefinedArea
            ? 'Saved appraiser-defined area is available to adjustment studies'
            : 'Save an appraiser-defined market area above to reuse it here'}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {METHODOLOGY_OPTIONS.map((method) => (
            <button
              key={method.key}
              type="button"
              aria-pressed={activeMethod === method.key}
              onClick={() => setActiveMethod(method.key)}
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
                activeMethod === method.key
                  ? 'bg-emerald-700 text-white shadow-sm'
                  : 'bg-slate-900 text-white hover:bg-slate-700'
              }`}
            >
              {method.label}
            </button>
          ))}
        </div>
      </div>

      {activeMethod && !['grouped', 'paired_sales', 'regression', 'depreciated_cost'].includes(activeMethod) && (
        <div className="p-5">
          <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-5">
            <div className="text-lg font-semibold text-indigo-950">
              {METHODOLOGY_OPTIONS.find((method) => method.key === activeMethod)?.label}
            </div>
            <p className="mt-2 text-sm leading-6 text-indigo-900">
              {METHODOLOGY_OPTIONS.find((method) => method.key === activeMethod)?.description}
            </p>
            <div className="mt-3 rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs font-medium text-slate-600">
              Methodology workspace added. Calculation inputs, evidence rules, and grid-application logic will be configured in a dedicated implementation step.
            </div>
          </div>
        </div>
      )}

      {activeMethod === 'paired_sales' && (
        <PairedSalesAnalysis
          subjectAccountId={subjectAccountId}
          appraiserDefinedArea={appraiserDefinedArea}
          appliedAdjustments={appliedAdjustments}
          getImpactPreview={getImpactPreview}
          onApplyAdjustment={onApplyAdjustment}
          onRemoveAdjustment={onRemoveAdjustment}
        />
      )}

      {activeMethod === 'regression' && (
        <RegressionAnalysis
          subjectAccountId={subjectAccountId}
          appraiserDefinedArea={appraiserDefinedArea}
          appliedAdjustments={appliedAdjustments}
          getImpactPreview={getImpactPreview}
          onApplyAdjustment={onApplyAdjustment}
          onRemoveAdjustment={onRemoveAdjustment}
        />
      )}

      {activeMethod === 'depreciated_cost' && (
        <DepreciatedCostAnalysis
          subjectAccountId={subjectAccountId}
          assignmentFileId={assignmentFileId}
          appliedAdjustments={appliedAdjustments}
          getImpactPreview={getImpactPreview}
          onApplyAdjustment={onApplyAdjustment}
          onRemoveAdjustment={onRemoveAdjustment}
        />
      )}

      {activeMethod === 'grouped' && (
        <div className="p-5">
          <fieldset className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <legend className="px-1 text-base font-semibold text-slate-900">
              Required: choose market breakdowns
            </legend>
            <div className="mt-1 text-sm text-slate-600">
              Select any combination or all seven. Distance studies are cumulative radii centered on the subject parcel.
            </div>
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {BREAKDOWN_OPTIONS.map((option) => {
                const checked = selectedBreakdowns.includes(option.key);
                return (
                  <label
                    key={option.key}
                    className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition ${
                      checked
                        ? 'border-emerald-500 bg-emerald-50 ring-1 ring-emerald-200'
                        : 'border-slate-200 bg-white hover:border-slate-400'
                    } ${loading ? 'cursor-not-allowed opacity-60' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={loading}
                      onChange={() => toggleBreakdown(option.key)}
                      className="mt-1 h-4 w-4 rounded border-slate-300 text-emerald-700 focus:ring-emerald-500"
                    />
                    <span>
                      <span className="block text-sm font-semibold text-slate-900">{option.label}</span>
                      <span className="mt-0.5 block text-xs leading-5 text-slate-600">{option.description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={loading}
                onClick={() => updateBreakdowns(BREAKDOWN_OPTIONS.map((option) => option.key))}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Select all
              </button>
              <button
                type="button"
                disabled={loading || selectedBreakdowns.length === 0}
                onClick={() => updateBreakdowns([])}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Clear selection
              </button>
              <button
                type="button"
                disabled={loading || selectedBreakdowns.length === 0}
                onClick={() => void loadAnalysis()}
                className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {loading
                  ? 'Calculating selected breakdowns…'
                  : `Calculate ${selectedBreakdowns.length || ''} selected breakdown${selectedBreakdowns.length === 1 ? '' : 's'}`}
              </button>
              <span className="text-xs font-medium text-slate-500">
                {selectedBreakdowns.length} of {BREAKDOWN_OPTIONS.length} selected
              </span>
            </div>
          </fieldset>

          {loading && (
            <div className="mt-4 rounded-lg bg-slate-50 px-4 py-5 text-sm text-slate-600">
              Calculating the latest one-year groups for each selected market area…
            </div>
          )}
          {error && (
            <div className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
              {error}
            </div>
          )}
          {analysisResult && (
            <>
              {analysisResult.unavailable_breakdowns.length > 0 && (
                <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
                  <div className="font-semibold">Some selected breakdowns are unavailable</div>
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    {analysisResult.unavailable_breakdowns.map((item) => (
                      <li key={item.key}>{item.label}: {item.reason}</li>
                    ))}
                  </ul>
                </div>
              )}

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
                            ({adjustment.marketLabel}; {adjustment.optionLabel}, {formatNumber(adjustment.factorPercent, 0)}%)
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

              <div className="mt-5 space-y-8">
                {analysisResult.analyses.map((analysis) => (
                  <section
                    key={analysis.market.key}
                    data-testid={`grouped-breakdown-${analysis.market.key}`}
                    className="rounded-2xl border border-slate-300 bg-slate-50/40 p-4 md:p-5"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                          Selected market breakdown
                        </div>
                        <h3 className="mt-1 text-xl font-semibold text-slate-950">{analysis.market.label}</h3>
                      </div>
                      <span className="rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white">
                        {analysis.market.scope === 'radius'
                          ? `${analysis.market.radius_miles}-mile cumulative radius`
                          : analysis.market.scope === 'zip'
                            ? 'ZIP study'
                            : 'Citywide study'}
                      </span>
                    </div>

                    <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-4">
                      <div className="rounded-lg bg-white p-3 shadow-sm">
                        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Market</div>
                        <div className="mt-1 font-semibold text-slate-900">{analysis.market.label}</div>
                      </div>
                      <div className="rounded-lg bg-white p-3 shadow-sm">
                        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Study period</div>
                        <div className="mt-1 font-semibold text-slate-900">
                          {formatDate(analysis.period.start)} – {formatDate(analysis.period.end)}
                        </div>
                      </div>
                      <div className="rounded-lg bg-white p-3 shadow-sm">
                        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Eligible sales</div>
                        <div className="mt-1 text-xl font-semibold text-slate-900">
                          {analysis.population.eligible_sale_count.toLocaleString()}
                        </div>
                      </div>
                      <div className="rounded-lg bg-white p-3 shadow-sm">
                        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Applied studies</div>
                        <div className="mt-1 text-xl font-semibold text-slate-900">
                          {appliedEntries.length}
                          <span className="ml-1 text-sm font-medium text-slate-500">
                            across {appliedDimensionCount}/4 sections
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-950">
                      These are unadjusted market differences for this selected area. Sale price can also reflect
                      living area, age, condition, and location, so sample strength and professional judgment remain important.
                    </div>

                    <div className="mt-5 space-y-5">
                      {analysis.dimensions.map((dimension) => (
                        <DimensionTable
                          key={`${analysis.market.key}:${dimension.key}`}
                          marketKey={analysis.market.key}
                          marketLabel={analysis.market.label}
                          dimension={dimension}
                          selections={selections}
                          factors={factors}
                          appliedAdjustments={appliedAdjustments}
                          getImpactPreview={getImpactPreview}
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
                          onApply={onApplyAdjustment}
                          onRemove={onRemoveAdjustment}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>

              {analysisResult.analyses.length === 0 && (
                <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
                  None of the selected market breakdowns can be calculated for this subject.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
