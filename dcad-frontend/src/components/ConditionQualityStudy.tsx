import { useMemo, useState } from 'react';
import * as api from '@/lib/api';
import type {
  GroupedAnalysisBreakdownKey,
  SaleRow,
} from '@/lib/api';
import {
  UAD_CONDITION_RATINGS,
  UAD_QUALITY_RATINGS,
  type RatingDimension,
} from '@/lib/conditionQualityRatings';
import {
  calculateConditionQualityStudy,
  conditionQualitySaleKey,
  factoredStudyAmount,
  type AppliedConditionQualityAdjustment,
  type ConditionQualityDimensionResult,
  type ConditionQualityStudyOption,
  type ConditionQualityStudyResult,
  type StudyBasis,
} from '@/lib/conditionQualityStudy';

export type ConditionQualityRatingAssignment = {
  condition: string;
  quality: string;
};

export type ConditionQualityImpactPreview = {
  adjustments: number[];
  selectedCount: number;
  affectedCount: number;
};

const MARKET_OPTIONS: Array<{
  key: GroupedAnalysisBreakdownKey;
  label: string;
  description: string;
}> = [
  {
    key: 'city',
    label: 'Entire subject city',
    description: 'Ranks eligible sales throughout the subject city.',
  },
  {
    key: 'zip',
    label: 'Subject ZIP code',
    description: 'Ranks sales sharing the subject property’s five-digit ZIP code.',
  },
  ...([1, 2, 3, 4, 5] as const).map((miles) => ({
    key: `radius_${miles}` as GroupedAnalysisBreakdownKey,
    label: `Within ${miles} mile${miles === 1 ? '' : 's'}`,
    description: `Ranks every eligible sale from 0 to ${miles} mile${miles === 1 ? '' : 's'} from the subject.`,
  })),
];

function localDateString(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function oneYearBefore(value: string): string {
  const date = new Date(`${value}T12:00:00`);
  date.setFullYear(date.getFullYear() - 1);
  return localDateString(date);
}

function finitePrice(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatCurrency(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

function formatSignedCurrency(value: number): string {
  const formatted = formatCurrency(Math.abs(value));
  return `${value >= 0 ? '+' : '−'}${formatted}`;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString() : value;
}

function displayAddress(sale: SaleRow): string {
  return sale.address?.trim() ||
    (sale.primary_account_id
      ? `Account ${sale.primary_account_id}`
      : 'Address unavailable');
}

function reliabilityClasses(
  reliability: ConditionQualityStudyOption['reliability'],
): string {
  if (reliability === 'strong') return 'bg-emerald-100 text-emerald-800';
  if (reliability === 'moderate') return 'bg-sky-100 text-sky-800';
  return 'bg-amber-100 text-amber-900';
}

function StudyRatingSelect({
  value,
  ratings,
  ariaLabel,
  onChange,
}: {
  value: string;
  ratings: readonly string[];
  ariaLabel: string;
  onChange: (value: string) => void;
}) {
  return (
    <select
      value={value}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value)}
      className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
    >
      <option value="">Select</option>
      {ratings.map((rating) => (
        <option key={rating} value={rating}>{rating}</option>
      ))}
    </select>
  );
}

function StudyGroupsTable({
  result,
}: {
  result: ConditionQualityDimensionResult;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
          <tr>
            <th className="px-3 py-2">Rating</th>
            <th className="px-3 py-2 text-right">Sales</th>
            <th className="px-3 py-2 text-right">Price range</th>
            <th className="px-3 py-2 text-right">Average</th>
            <th className="px-3 py-2 text-right">Median</th>
          </tr>
        </thead>
        <tbody>
          {result.groups.map((group) => (
            <tr key={`${result.dimension}-${group.rating}`} className="border-t border-slate-200 bg-white">
              <td className="px-3 py-2 font-semibold text-slate-900">{group.rating}</td>
              <td className="px-3 py-2 text-right">{group.sampleSize}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right">
                {formatCurrency(group.minimumPrice)}–{formatCurrency(group.maximumPrice)}
              </td>
              <td className="px-3 py-2 text-right">{formatCurrency(group.averagePrice)}</td>
              <td className="px-3 py-2 text-right">{formatCurrency(group.medianPrice)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ConditionQualityStudy({
  subjectAccountId,
  subjectCondition,
  subjectQuality,
  ratingAssignments,
  appliedAdjustments,
  onRatingChange,
  onApplyAdjustment,
  onRemoveAdjustment,
  getImpactPreview,
  onOpenSale,
  onSalesLoaded,
}: {
  subjectAccountId: string;
  subjectCondition: string;
  subjectQuality: string;
  ratingAssignments: Record<string, ConditionQualityRatingAssignment>;
  appliedAdjustments: Partial<Record<RatingDimension, AppliedConditionQualityAdjustment>>;
  onRatingChange: (
    sale: SaleRow,
    dimension: RatingDimension,
    value: string,
  ) => void;
  onApplyAdjustment: (adjustment: AppliedConditionQualityAdjustment) => void;
  onRemoveAdjustment: (dimension: RatingDimension) => void;
  getImpactPreview: (
    adjustment: AppliedConditionQualityAdjustment,
  ) => ConditionQualityImpactPreview;
  onOpenSale?: (sale: SaleRow) => void;
  onSalesLoaded?: (sales: SaleRow[]) => void;
}) {
  const [active, setActive] = useState(false);
  const [marketKey, setMarketKey] = useState<GroupedAnalysisBreakdownKey | ''>('');
  const [rankedSales, setRankedSales] = useState<SaleRow[]>([]);
  const [marketLabel, setMarketLabel] = useState('');
  const [coverageCount, setCoverageCount] = useState(0);
  const [selectedSaleKeys, setSelectedSaleKeys] = useState<string[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConditionQualityStudyResult | null>(null);
  const [selectedOptions, setSelectedOptions] = useState<Record<string, StudyBasis>>({});
  const [factors, setFactors] = useState<Record<string, string>>({});
  const asOfDate = useMemo(() => localDateString(), []);
  const dateFrom = useMemo(() => oneYearBefore(asOfDate), [asOfDate]);

  const selectedSales = useMemo(() => {
    const selected = new Set(selectedSaleKeys);
    return rankedSales.filter((sale) => selected.has(conditionQualitySaleKey(sale)));
  }, [rankedSales, selectedSaleKeys]);

  const selectMarket = (key: GroupedAnalysisBreakdownKey) => {
    setMarketKey(key);
    setRankedSales([]);
    setSelectedSaleKeys([]);
    setResult(null);
    setMarketLabel('');
    setCoverageCount(0);
    setError(null);
  };

  const loadRankedSales = async () => {
    if (!subjectAccountId) {
      setError('A subject property is required before this study can run.');
      return;
    }
    if (!subjectCondition || !subjectQuality) {
      setError('Apply the subject’s condition and quality ratings before starting the study.');
      return;
    }
    if (!marketKey) {
      setError('Choose one market area before reviewing ranked sales.');
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const response = await api.getComparableRecommendations({
        subjectAccountId,
        analysisAsOf: asOfDate,
        periodMonths: 12,
        limit: 100,
        marketBreakdown: marketKey,
      });
      setRankedSales(response.sales || []);
      onSalesLoaded?.(response.sales || []);
      setMarketLabel(
        response.study_market?.label ||
        MARKET_OPTIONS.find((option) => option.key === marketKey)?.label ||
        marketKey,
      );
      setCoverageCount(
        response.coverage.scope_eligible_count ??
        response.coverage.eligible_count ??
        response.sales.length,
      );
      setSelectedSaleKeys([]);
      setModalOpen(true);
      if (!response.sales.length) {
        setError('No eligible one-year sales were available in this market area.');
      }
    } catch (loadError) {
      setRankedSales([]);
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'The ranked sales could not be loaded.',
      );
    } finally {
      setLoading(false);
    }
  };

  const toggleSale = (sale: SaleRow) => {
    const key = conditionQualitySaleKey(sale);
    setSelectedSaleKeys((current) => {
      if (current.includes(key)) return current.filter((item) => item !== key);
      if (current.length >= 20) return current;
      return [...current, key];
    });
  };

  const selectTop20 = () => {
    setSelectedSaleKeys(
      rankedSales.slice(0, 20).map(conditionQualitySaleKey),
    );
    setError(null);
  };

  const calculateStudy = () => {
    if (selectedSales.length < 2) {
      setError('Select at least two ranked sales before calculating the study.');
      return;
    }
    const unrated = selectedSales.filter((sale) => {
      const assignment = ratingAssignments[conditionQualitySaleKey(sale)];
      return !assignment?.condition || !assignment?.quality;
    });
    if (unrated.length) {
      setError(
        `Assign both condition and quality to all selected sales. ${unrated.length} selected sale${unrated.length === 1 ? ' is' : 's are'} incomplete.`,
      );
      return;
    }

    const study = calculateConditionQualityStudy(
      selectedSales.flatMap((sale) => {
        const price = finitePrice(sale.sale_price);
        const assignment = ratingAssignments[conditionQualitySaleKey(sale)];
        return price && assignment
          ? [{
              id: conditionQualitySaleKey(sale),
              price,
              condition: assignment.condition,
              quality: assignment.quality,
            }]
          : [];
      }),
    );
    setResult(study);
    setModalOpen(false);
    setError(null);
  };

  const transitionKey = (
    dimension: RatingDimension,
    transitionId: string,
  ) => `${dimension}:${transitionId}`;

  const buildAppliedAdjustment = (
    dimensionResult: ConditionQualityDimensionResult,
    transitionIndex: number,
  ): AppliedConditionQualityAdjustment | null => {
    const transition = dimensionResult.transitions[transitionIndex];
    if (!transition || !marketKey) return null;
    const key = transitionKey(dimensionResult.dimension, transition.id);
    const basis = selectedOptions[key] || 'median';
    const option = transition.options.find((item) => item.id === basis) ||
      transition.options[0];
    if (!option) return null;
    const parsedFactor = Number(factors[key] ?? '100');
    const factorPercent = Number.isFinite(parsedFactor) ? parsedFactor : 100;
    return {
      id: `${marketKey}:${dimensionResult.dimension}:${transition.id}`,
      dimension: dimensionResult.dimension,
      dimensionLabel: dimensionResult.label,
      marketKey,
      marketLabel,
      transitionId: transition.id,
      transitionLabel: transition.label,
      betterRating: transition.betterRating,
      worseRating: transition.worseRating,
      optionId: option.id,
      optionLabel: option.label,
      basis: option.basis,
      reliability: option.reliability,
      baseAmount: option.amount,
      factorPercent,
      amount: factoredStudyAmount(option.amount, factorPercent),
      betterGroupPrice: option.betterGroupPrice,
      worseGroupPrice: option.worseGroupPrice,
      rawDifference: option.rawDifference,
      gradeDifference: option.gradeDifference,
      selectedSaleCount: selectedSales.length,
    };
  };

  const renderDimension = (dimensionResult: ConditionQualityDimensionResult) => {
    const applied = appliedAdjustments[dimensionResult.dimension];
    return (
      <div key={dimensionResult.dimension} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-lg font-semibold text-slate-900">{dimensionResult.label} Study</h4>
            <p className="text-sm text-slate-600">
              Lower UAD numbers represent better ratings. Each tile produces one universal per-grade grid rate.
            </p>
          </div>
          {applied && (
            <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">
              {formatSignedCurrency(applied.amount)} per grade applied
            </span>
          )}
        </div>

        <div className="mt-4">
          <StudyGroupsTable result={dimensionResult} />
        </div>

        {!dimensionResult.transitions.length ? (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            At least two different {dimensionResult.label.toLowerCase()} rating groups are required to calculate a difference.
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
            {dimensionResult.transitions.map((transition, transitionIndex) => {
              const key = transitionKey(dimensionResult.dimension, transition.id);
              const basis = selectedOptions[key] || 'median';
              const option = transition.options.find((item) => item.id === basis) ||
                transition.options[0];
              const draft = buildAppliedAdjustment(dimensionResult, transitionIndex);
              const preview = draft ? getImpactPreview(draft) : null;
              const isApplied = applied?.id === draft?.id &&
                applied?.optionId === draft?.optionId &&
                applied?.factorPercent === draft?.factorPercent;
              return (
                <div key={transition.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold text-slate-900">{transition.label}</div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        {transition.betterSampleSize} better-rated sale{transition.betterSampleSize === 1 ? '' : 's'} vs. {transition.worseSampleSize} worse-rated sale{transition.worseSampleSize === 1 ? '' : 's'}
                      </div>
                    </div>
                    {option && (
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${reliabilityClasses(option.reliability)}`}>
                        {option.reliability}
                      </span>
                    )}
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    {transition.options.map((candidate) => (
                      <button
                        key={candidate.id}
                        type="button"
                        onClick={() => setSelectedOptions((current) => ({
                          ...current,
                          [key]: candidate.id,
                        }))}
                        className={`rounded-lg border px-3 py-2 text-left text-xs ${
                          basis === candidate.id
                            ? 'border-indigo-500 bg-indigo-50 text-indigo-950 ring-1 ring-indigo-200'
                            : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400'
                        }`}
                      >
                        <span className="block font-semibold">{candidate.label}</span>
                        <span className="mt-1 block text-base font-bold">
                          {formatSignedCurrency(candidate.amount)} / grade
                        </span>
                      </button>
                    ))}
                  </div>

                  {option && (
                    <>
                      <div className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-xs leading-5 text-slate-700">
                        {formatCurrency(option.betterGroupPrice)} − {formatCurrency(option.worseGroupPrice)}
                        {' = '}{formatSignedCurrency(option.rawDifference)}
                        {' ÷ '}{option.gradeDifference} grade{option.gradeDifference === 1 ? '' : 's'}
                        {' = '}{formatSignedCurrency(option.amount)} per grade.
                      </div>
                      {option.amount <= 0 && (
                        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                          This sample does not show the expected positive premium for the better-rated group. Review the ratings before applying it.
                        </div>
                      )}
                    </>
                  )}

                  <label className="mt-3 grid gap-1 text-sm text-slate-700">
                    <span className="font-medium">Apply Factoring (%)</span>
                    <input
                      type="number"
                      step="1"
                      value={factors[key] ?? '100'}
                      onChange={(event) => setFactors((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))}
                      className="rounded-md border border-slate-300 px-3 py-2"
                    />
                  </label>

                  <div className="mt-3 rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-2">
                    <div className="text-xs font-medium text-indigo-800">Resulting adjustment</div>
                    <div className="text-xl font-bold text-indigo-950">
                      {draft ? `${formatSignedCurrency(draft.amount)} per full grade` : '—'}
                    </div>
                    <div className="mt-1 text-xs text-indigo-800">
                      Half-grade ranges receive half this amount. This would affect {preview?.affectedCount || 0} of {preview?.selectedCount || 0} current grid comparables.
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={!draft}
                      onClick={() => draft && onApplyAdjustment(draft)}
                      className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isApplied ? 'Adjustment Applied' : `Apply ${dimensionResult.label} Adjustment`}
                    </button>
                    {applied && (
                      <button
                        type="button"
                        onClick={() => onRemoveAdjustment(dimensionResult.dimension)}
                        className="rounded-lg border border-red-300 bg-white px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50"
                      >
                        Remove {dimensionResult.label} Adjustment
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="mt-6 rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 p-5">
        <div className="text-xl font-semibold text-slate-900">Condition and Quality Study</div>
        <p className="mt-1 text-sm text-slate-600">
          Rank a separate one-year market sample, review up to 20 sales, assign UAD ratings, and calculate supported per-grade adjustments.
        </p>
        <button
          type="button"
          onClick={() => setActive((current) => !current)}
          className={`mt-4 rounded-lg px-4 py-2 text-sm font-semibold text-white ${
            active
              ? 'bg-indigo-700'
              : 'bg-slate-900 hover:bg-slate-700'
          }`}
        >
          Condition and Quality Study
        </button>
      </div>

      {active && (
        <div className="p-5">
          <fieldset className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <legend className="px-1 text-base font-semibold text-slate-900">
              Required: choose one market area
            </legend>
            <p className="mt-1 text-sm text-slate-600">
              The same 40% location, 30% living-area, 15% year-built, and 15% sale-date score orders the one-year sales within the selected area.
            </p>
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {MARKET_OPTIONS.map((option) => (
                <label
                  key={option.key}
                  className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${
                    marketKey === option.key
                      ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-200'
                      : 'border-slate-200 bg-white hover:border-slate-400'
                  }`}
                >
                  <input
                    type="radio"
                    name="condition-quality-market"
                    value={option.key}
                    checked={marketKey === option.key}
                    onChange={() => selectMarket(option.key)}
                    className="mt-1 h-4 w-4 border-slate-300 text-indigo-700 focus:ring-indigo-500"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-slate-900">{option.label}</span>
                    <span className="mt-0.5 block text-xs leading-5 text-slate-600">{option.description}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void loadRankedSales()}
                disabled={loading || !marketKey}
                className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? 'Ranking sales…' : rankedSales.length ? 'Review / change selected sales' : 'Open ranked sales'}
              </button>
              <span className="text-xs text-slate-500">
                Study period: {formatDate(dateFrom)} through {formatDate(asOfDate)}.
              </span>
            </div>
          </fieldset>

          {error && !modalOpen && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {error}
            </div>
          )}

          {result && (
            <div className="mt-5 space-y-5">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-950">
                Calculated from {result.ratedSaleCount} user-rated sale{result.ratedSaleCount === 1 ? '' : 's'} selected from {coverageCount.toLocaleString()} eligible {marketLabel} sale{coverageCount === 1 ? '' : 's'}.
              </div>
              {renderDimension(result.condition)}
              {renderDimension(result.quality)}
            </div>
          )}
        </div>
      )}

      {modalOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/70 p-3 md:p-6">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Condition and quality ranked sales"
            className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
          >
            <div className="border-b border-slate-200 px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-xl font-semibold text-slate-900">Ranked Sales — {marketLabel}</h3>
                  <p className="mt-1 text-sm text-slate-600">
                    Select no more than 20 sales, then assign both UAD ratings to every selected sale.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setModalOpen(false);
                    setError(null);
                  }}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
                >
                  Close
                </button>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={selectTop20}
                  className="rounded-lg bg-indigo-700 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-800"
                >
                  Select Top 20
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedSaleKeys([]);
                    setError(null);
                  }}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
                >
                  Clear selection
                </button>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-sm font-semibold text-slate-800">
                  {selectedSaleKeys.length} / 20 selected
                </span>
                <span className="text-xs text-slate-500">
                  {rankedSales.length} ranked results shown from {coverageCount.toLocaleString()} eligible sales.
                </span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto bg-slate-50 p-4">
              <div className="space-y-3">
                {rankedSales.map((sale, index) => {
                  const key = conditionQualitySaleKey(sale);
                  const selected = selectedSaleKeys.includes(key);
                  const assignment = ratingAssignments[key] || {
                    condition: '',
                    quality: '',
                  };
                  return (
                    <div
                      key={key}
                      className={`rounded-xl border p-3 ${
                        selected
                          ? 'border-indigo-400 bg-indigo-50 ring-1 ring-indigo-200'
                          : 'border-slate-200 bg-white'
                      }`}
                    >
                      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[auto_100px_minmax(200px,1fr)_100px_140px_140px] lg:items-center">
                        <label className="flex cursor-pointer items-center gap-2">
                          <input
                            type="checkbox"
                            checked={selected}
                            disabled={!selected && selectedSaleKeys.length >= 20}
                            onChange={() => toggleSale(sale)}
                            className="h-4 w-4 rounded border-slate-300 text-indigo-700 focus:ring-indigo-500"
                          />
                          <span className="text-sm font-bold text-slate-700">#{sale.score_rank || index + 1}</span>
                        </label>
                        {sale.primary_photo_url ? (
                          <button
                            type="button"
                            onClick={() => onOpenSale?.(sale)}
                            className="h-16 overflow-hidden rounded-lg border border-slate-200 bg-slate-100"
                          >
                            <img
                              src={sale.primary_photo_url}
                              alt={displayAddress(sale)}
                              className="h-full w-full object-cover"
                            />
                          </button>
                        ) : (
                          <div className="flex h-16 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-100 px-2 text-center text-[10px] text-slate-500">
                            MLS photo unavailable
                          </div>
                        )}
                        <div>
                          <div className="font-semibold text-slate-900">{displayAddress(sale)}</div>
                          <div className="mt-1 text-xs text-slate-600">
                            {sale.city || 'City unavailable'} · MLS {sale.listing_id || 'unavailable'} · {formatDate(sale.closing_date)}
                          </div>
                          <div className="mt-1 text-xs text-slate-600">
                            {Number(sale.distanceMiles || 0).toFixed(2)} mi · {Number(sale.comparable_square_feet || 0).toLocaleString()} SF · score {Number(sale.comparableScore || 0).toFixed(1)}
                          </div>
                        </div>
                        <div className="text-right text-base font-bold text-slate-900">
                          {formatCurrency(finitePrice(sale.sale_price))}
                        </div>
                        <label className={`grid gap-1 text-xs font-medium text-slate-700 ${selected ? '' : 'opacity-50'}`}>
                          <span>Condition</span>
                          <StudyRatingSelect
                            ariaLabel={`${displayAddress(sale)} condition`}
                            value={assignment.condition}
                            ratings={UAD_CONDITION_RATINGS}
                            onChange={(value) => onRatingChange(sale, 'condition', value)}
                          />
                        </label>
                        <label className={`grid gap-1 text-xs font-medium text-slate-700 ${selected ? '' : 'opacity-50'}`}>
                          <span>Quality</span>
                          <StudyRatingSelect
                            ariaLabel={`${displayAddress(sale)} quality`}
                            value={assignment.quality}
                            ratings={UAD_QUALITY_RATINGS}
                            onChange={(value) => onRatingChange(sale, 'quality', value)}
                          />
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="border-t border-slate-200 bg-white px-5 py-4">
              {error && (
                <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  {error}
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-slate-500">
                  Ratings are manual study inputs and remain editable after the study is calculated.
                </div>
                <button
                  type="button"
                  onClick={calculateStudy}
                  disabled={selectedSaleKeys.length < 2}
                  className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Calculate Average and Median Differences Among the Groups
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
