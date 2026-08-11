import { useMemo, useState } from 'react';
import * as api from '@/lib/api';
import type {
  GeoJsonPolygon,
  MarketConditionsAreaKey,
  PairedAnalysisDimension,
  PairedAnalysisRange,
  PairedSaleSummary,
  PairedSalesAnalysisResponse,
} from '@/lib/api';
import type {
  AppliedGroupedAdjustment,
  GroupedAdjustmentImpactPreview,
} from '@/components/GroupedAdjustmentAnalysis';

export type AppraiserDefinedAdjustmentArea = {
  geometry: GeoJsonPolygon;
  label: string;
  asOfDate?: string;
};

const AREA_OPTIONS: ReadonlyArray<{
  key: MarketConditionsAreaKey;
  label: string;
  description: string;
}> = [
  {
    key: 'custom',
    label: 'Appraiser-defined area',
    description: 'Reuse the exact polygon saved in the Property Report Market Conditions Analysis.',
  },
  {
    key: 'city',
    label: 'Entire subject city',
    description: 'Use the subject city and county.',
  },
  {
    key: 'zip',
    label: 'Subject ZIP code',
    description: 'Use sales sharing the subject ZIP code.',
  },
  ...([1, 2, 3, 4, 5] as const).map((miles) => ({
    key: `radius_${miles}` as MarketConditionsAreaKey,
    label: `Within ${miles} mile${miles === 1 ? '' : 's'}`,
    description: `Use the cumulative ${miles}-mile radius centered on the subject.`,
  })),
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

function formatSignedCurrency(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—';
  const formatted = formatCurrency(Math.abs(value));
  return `${value >= 0 ? '+' : '−'}${formatted}`;
}

function formatNumber(value: number | null | undefined, digits = 1) {
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

function featureText(sale: PairedSaleSummary, dimension: PairedAnalysisDimension['key']) {
  if (dimension === 'bathrooms') return `${formatNumber(sale.bathrooms, 1)} baths`;
  if (dimension === 'garage') return `${formatNumber(sale.garageSpaces, 0)} garage spaces`;
  if (dimension === 'pool') return sale.pool ? 'Pool' : 'No pool';
  return `${formatNumber(sale.livingArea, 0)} SF`;
}

function resultSuffix(range: PairedAnalysisRange) {
  if (range.unit === 'per_square_foot') return ' / SF';
  if (range.unit === 'per_bath_equivalent') return ' / full-bath equivalent';
  if (range.unit === 'per_garage_space') return ' / garage space';
  return '';
}

function factoredAmount(range: PairedAnalysisRange, basis: 'median' | 'mean', factorPercent: number) {
  const base = basis === 'median'
    ? range.statistics.median
    : range.statistics.mean;
  if (base == null || !Number.isFinite(base)) return null;
  const factored = (base * factorPercent) / 100;
  return range.unit === 'per_square_foot'
    ? Math.round(factored)
    : Math.round(factored / 100) * 100;
}

function appliedId(
  marketKey: MarketConditionsAreaKey,
  dimensionKey: PairedAnalysisDimension['key'],
  rangeId: string,
) {
  return `paired:${marketKey}:${dimensionKey}:${rangeId}`;
}

type PairedSaleUse = {
  sale: PairedSaleSummary;
  studyUses: string[];
  pairAppearances: number;
};

function pairedSaleIdentity(sale: PairedSaleSummary) {
  return (
    sale.sourceRecordId ||
    sale.saleId ||
    sale.accountId ||
    [sale.address, sale.closingDate, sale.salePrice].join('|')
  );
}

function collectUsedSales(
  dimensions: PairedAnalysisDimension[],
): PairedSaleUse[] {
  const usedSales = new Map<
    string,
    { sale: PairedSaleSummary; studyUses: Set<string>; pairAppearances: number }
  >();

  const addSale = (sale: PairedSaleSummary, studyUse: string) => {
    const identity = pairedSaleIdentity(sale);
    const current = usedSales.get(identity) || {
      sale,
      studyUses: new Set<string>(),
      pairAppearances: 0,
    };
    current.studyUses.add(studyUse);
    current.pairAppearances += 1;
    usedSales.set(identity, current);
  };

  dimensions.forEach((dimension) => {
    dimension.ranges.forEach((range) => {
      const studyUse = `${dimension.label}: ${range.label}`;
      range.pairs.forEach((pair) => {
        addSale(pair.inferior, studyUse);
        addSale(pair.superior, studyUse);
      });
    });
  });

  return Array.from(usedSales.values())
    .map((entry) => ({
      ...entry,
      studyUses: Array.from(entry.studyUses).sort((left, right) =>
        left.localeCompare(right),
      ),
    }))
    .sort((left, right) => {
      const dateOrder = String(right.sale.closingDate || '').localeCompare(
        String(left.sale.closingDate || ''),
      );
      if (dateOrder !== 0) return dateOrder;
      return String(left.sale.address || '').localeCompare(
        String(right.sale.address || ''),
      );
    });
}

function UsedSalesDropdown({ sales }: { sales: PairedSaleUse[] }) {
  return (
    <details
      data-testid="paired-sales-used-dropdown"
      className="group rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 marker:content-none">
        <span>
          <span className="block text-base font-semibold text-slate-950">
            Sales Used in Paired Calculations ({sales.length})
          </span>
          <span className="mt-0.5 block text-xs leading-5 text-slate-600">
            These are the unique sales retained in at least one calculation pair. Expand to audit every property and the ranges that used it.
          </span>
        </span>
        <span
          aria-hidden="true"
          className="shrink-0 text-xl text-slate-500 transition-transform group-open:rotate-180"
        >
          â–¾
        </span>
      </summary>

      <div className="border-t border-slate-200 p-4">
        {sales.length ? (
          <div className="max-h-[32rem] overflow-auto rounded-lg border border-slate-200">
            <table className="min-w-[1120px] w-full text-sm">
              <thead className="sticky top-0 z-10 bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
                <tr>
                  <th className="px-3 py-2">Sale</th>
                  <th className="px-3 py-2">Date and price</th>
                  <th className="px-3 py-2">Characteristics</th>
                  <th className="px-3 py-2">Used in study ranges</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {sales.map(({ sale, studyUses, pairAppearances }) => (
                  <tr key={pairedSaleIdentity(sale)}>
                    <td className="px-3 py-3 align-top">
                      <div className="font-semibold text-slate-950">
                        {sale.address || sale.accountId || 'Address unavailable'}
                      </div>
                      <div className="mt-1 text-xs leading-5 text-slate-600">
                        {sale.accountId ? `Parcel ${sale.accountId}` : 'Parcel not matched'}
                        {sale.sourceRecordId ? ` Â· Record ${sale.sourceRecordId}` : ''}
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <div className="font-semibold text-slate-900">
                        {formatCurrency(sale.salePrice)}
                      </div>
                      <div className="mt-1 text-xs text-slate-600">
                        {formatDate(sale.closingDate)}
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top text-xs leading-5 text-slate-700">
                      <div>
                        {formatNumber(sale.livingArea, 0)} SF GLA Â· {formatNumber(sale.bedrooms, 0)} bed Â· {formatNumber(sale.bathrooms, 1)} bath
                      </div>
                      <div>
                        {formatNumber(sale.garageSpaces, 0)} garage Â· {sale.pool == null ? 'Pool unknown' : sale.pool ? 'Pool' : 'No pool'}
                      </div>
                      <div>
                        Built {formatNumber(sale.yearBuilt, 0)} Â· Site {formatNumber(sale.siteSize, 0)} SF
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <div className="flex max-w-xl flex-wrap gap-1.5">
                        {studyUses.map((studyUse) => (
                          <span
                            key={studyUse}
                            className="rounded-full bg-indigo-50 px-2 py-1 text-[11px] font-semibold text-indigo-800"
                          >
                            {studyUse}
                          </span>
                        ))}
                      </div>
                      <div className="mt-2 text-[11px] text-slate-500">
                        {pairAppearances} pair appearance{pairAppearances === 1 ? '' : 's'}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            No sales met the retained-pair safeguards for this study.
          </div>
        )}
      </div>
    </details>
  );
}

function PairEvidenceTable({
  dimension,
  range,
}: {
  dimension: PairedAnalysisDimension;
  range: PairedAnalysisRange;
}) {
  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
      <table className="min-w-[1180px] w-full text-sm">
        <thead className="bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
          <tr>
            <th className="px-3 py-2">Inferior sale</th>
            <th className="px-3 py-2">Superior sale</th>
            <th className="px-3 py-2 text-right">Raw price difference</th>
            <th className="px-3 py-2 text-right">Normalized result</th>
            <th className="px-3 py-2">Similarity controls</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {range.pairs.map((pair) => (
            <tr key={pair.id}>
              <td className="px-3 py-3 align-top">
                <div className="font-semibold text-slate-900">
                  {pair.inferior.address || pair.inferior.accountId || 'Address unavailable'}
                </div>
                <div className="mt-1 text-xs text-slate-600">
                  {formatCurrency(pair.inferior.salePrice)} · {formatDate(pair.inferior.closingDate)}
                </div>
                <div className="mt-1 text-xs font-medium text-slate-700">
                  {featureText(pair.inferior, dimension.key)}
                </div>
              </td>
              <td className="px-3 py-3 align-top">
                <div className="font-semibold text-slate-900">
                  {pair.superior.address || pair.superior.accountId || 'Address unavailable'}
                </div>
                <div className="mt-1 text-xs text-slate-600">
                  {formatCurrency(pair.superior.salePrice)} · {formatDate(pair.superior.closingDate)}
                </div>
                <div className="mt-1 text-xs font-medium text-slate-700">
                  {featureText(pair.superior, dimension.key)}
                </div>
              </td>
              <td className="px-3 py-3 text-right align-top font-semibold text-slate-900">
                {formatSignedCurrency(pair.salePriceDifference)}
              </td>
              <td className="px-3 py-3 text-right align-top font-semibold text-emerald-800">
                {formatSignedCurrency(pair.unitPriceDifference)}{resultSuffix(range)}
              </td>
              <td className="px-3 py-3 align-top text-xs leading-5 text-slate-600">
                <div>Match score {formatNumber(pair.matchScore, 1)}</div>
                <div>{formatNumber(pair.controlDifferences.distanceMiles, 2)} mi apart · {pair.controlDifferences.closingDateDays} days</div>
                <div>
                  GLA {formatNumber(pair.controlDifferences.livingAreaPercent, 1)}%
                  {pair.controlDifferences.yearBuiltYears == null
                    ? ' · age unavailable'
                    : ` · age ${pair.controlDifferences.yearBuiltYears} years`}
                  {pair.controlDifferences.siteSizePercent == null
                    ? ' · site unavailable'
                    : ` · site ${formatNumber(pair.controlDifferences.siteSizePercent, 1)}%`}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PairedSalesAnalysis({
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
  const [analysisResult, setAnalysisResult] = useState<PairedSalesAnalysisResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [factors, setFactors] = useState<Record<string, string>>({});
  const [selectedBases, setSelectedBases] = useState<Record<string, 'median' | 'mean'>>({});
  const [expandedPairs, setExpandedPairs] = useState<Record<string, boolean>>({});
  const asOfDate = appraiserDefinedArea?.asOfDate || localDateString();

  const appliedPairedAdjustments = useMemo(
    () => Object.values(appliedAdjustments).filter((adjustment) =>
      adjustment.id.startsWith('paired:'),
    ),
    [appliedAdjustments],
  );

  const usedSales = useMemo(
    () => collectUsedSales(analysisResult?.dimensions || []),
    [analysisResult],
  );

  const selectMarket = (nextKey: MarketConditionsAreaKey) => {
    if (nextKey === 'custom' && !appraiserDefinedArea?.geometry) return;
    setMarketKey(nextKey);
    setAnalysisResult(null);
    setError(null);
  };

  const calculate = async () => {
    if (!marketKey) {
      setError('Select one market area before calculating paired sales.');
      return;
    }
    if (marketKey === 'custom' && !appraiserDefinedArea?.geometry) {
      setError('Draw and save an appraiser-defined area in the Property Report Market Conditions Analysis first.');
      return;
    }
    setLoading(true);
    setError(null);
    setAnalysisResult(null);
    try {
      setAnalysisResult(await api.runPairedSalesAnalysis({
        subjectAccountId,
        marketKey,
        asOf: asOfDate,
        customGeometry: marketKey === 'custom'
          ? appraiserDefinedArea?.geometry
          : null,
      }));
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Paired sales analysis could not be calculated.',
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-5">
      <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-5">
        <div className="text-lg font-semibold text-indigo-950">Paired Sales Analysis</div>
        <p className="mt-2 text-sm leading-6 text-indigo-900">
          Closely matched sales are compared while one studied feature changes. Negative differences remain in the evidence, and every range reports the mean, median, coefficient of variation, COD, and standard deviation.
        </p>
        <div className="mt-3 rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs font-medium text-slate-700">
          A sale is used only once within each feature range, and every non-target housing characteristic used as an exact control must be known. The recommended adjustment is the median normalized difference; the average remains available as an alternative.
        </div>
      </div>

      <fieldset className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <legend className="px-1 text-base font-semibold text-slate-900">
          Required: choose the paired-sales market area
        </legend>
        <div className="mt-1 text-sm text-slate-600">
          The appraiser-defined option reuses the exact completed polygon from the Property Report Market Conditions Analysis.
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {AREA_OPTIONS.map((option) => {
            const selected = marketKey === option.key;
            const customUnavailable = option.key === 'custom' && !appraiserDefinedArea?.geometry;
            return (
              <label
                key={option.key}
                className={`flex gap-3 rounded-lg border p-3 transition ${
                  selected
                    ? 'border-emerald-500 bg-emerald-50 ring-1 ring-emerald-200'
                    : 'border-slate-200 bg-white'
                } ${customUnavailable || loading ? 'cursor-not-allowed opacity-55' : 'cursor-pointer hover:border-slate-400'}`}
              >
                <input
                  type="radio"
                  name="paired-sales-market-area"
                  value={option.key}
                  checked={selected}
                  disabled={customUnavailable || loading}
                  onChange={() => selectMarket(option.key)}
                  className="mt-1 h-4 w-4 border-slate-300 text-emerald-700 focus:ring-emerald-500"
                />
                <span>
                  <span className="block text-sm font-semibold text-slate-900">{option.label}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-slate-600">
                    {customUnavailable
                      ? 'Complete and save a custom market boundary above to enable this option.'
                      : option.key === 'custom'
                        ? appraiserDefinedArea?.label || option.description
                        : option.description}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={loading || !marketKey}
            onClick={() => void calculate()}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {loading ? 'Finding practical sale pairs…' : 'Calculate paired sales'}
          </button>
          <span className="text-xs font-medium text-slate-500">
            Analysis as of {formatDate(asOfDate)} · latest 12 complete months
          </span>
        </div>
      </fieldset>

      {error && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          {error}
        </div>
      )}

      {analysisResult && (
        <div className="mt-5 space-y-6">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Completed paired study</div>
                <div className="mt-1 text-xl font-semibold text-slate-950">{analysisResult.market.label}</div>
                <div className="mt-1 text-sm text-slate-700">
                  {formatDate(analysisResult.period.start)} – {formatDate(analysisResult.period.end)}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-center">
                <div className="rounded-lg bg-white px-3 py-2 shadow-sm">
                  <div className="text-xs uppercase tracking-wide text-slate-500">Eligible sales</div>
                  <div className="text-xl font-semibold text-slate-900">{analysisResult.population.eligibleSaleCount.toLocaleString()}</div>
                </div>
                <div className="rounded-lg bg-white px-3 py-2 shadow-sm">
                  <div className="text-xs uppercase tracking-wide text-slate-500">Pairable sales</div>
                  <div className="text-xl font-semibold text-slate-900">{analysisResult.population.pairableSaleCount.toLocaleString()}</div>
                </div>
              </div>
            </div>
            <div className="mt-3 text-xs leading-5 text-slate-700">
              Safeguards: within {analysisResult.methodology.maximumPairDistanceMiles} miles and {analysisResult.methodology.maximumClosingDateDifferenceDays} days; when available, within {analysisResult.methodology.maximumYearBuiltDifferenceYears} years of age and {analysisResult.methodology.maximumSiteSizeDifferencePercent}% site-size difference; and within {analysisResult.methodology.maximumControlLivingAreaDifferencePercent}% GLA difference when GLA is not the studied feature.
            </div>
          </div>

          <UsedSalesDropdown sales={usedSales} />

          {appliedPairedAdjustments.length > 0 && (
            <div className="rounded-xl border border-emerald-200 bg-white p-4">
              <div className="text-sm font-semibold text-slate-900">Applied paired-sale adjustments</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {appliedPairedAdjustments.map((adjustment) => (
                  <div key={adjustment.id} className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm">
                    <span className="font-semibold text-slate-900">{adjustment.dimensionLabel}:</span>
                    <span>{adjustment.transitionLabel}</span>
                    <span className="font-semibold text-emerald-800">{formatSignedCurrency(adjustment.amount)}</span>
                    <button
                      type="button"
                      onClick={() => onRemoveAdjustment(adjustment.id)}
                      className="rounded-full px-1.5 text-xs font-bold text-slate-500 hover:bg-white"
                      aria-label={`Remove paired ${adjustment.dimensionLabel} adjustment`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {analysisResult.dimensions.map((dimension) => (
            <section key={dimension.key} className="rounded-2xl border border-slate-300 bg-slate-50/50 p-4 md:p-5">
              <h3 className="text-xl font-semibold text-slate-950">{dimension.label}</h3>
              <p className="mt-1 text-sm leading-6 text-slate-600">{dimension.explanation}</p>

              {dimension.ranges.length ? (
                <div className="mt-4 space-y-4">
                  {dimension.ranges.map((range) => {
                    const key = appliedId(analysisResult.market.key, dimension.key, range.id);
                    const basis = selectedBases[key] || 'median';
                    const factorText = factors[key] ?? '100';
                    const factorPercent = Number(factorText);
                    const factorValid = factorText.trim() !== '' && Number.isFinite(factorPercent) && factorPercent >= 0;
                    const result = factorValid
                      ? factoredAmount(range, basis, factorPercent)
                      : null;
                    const baseAmount = basis === 'median'
                      ? range.statistics.median
                      : range.statistics.mean;
                    const applied = appliedAdjustments[key];
                    const draftAdjustment: AppliedGroupedAdjustment | null =
                      result == null || baseAmount == null
                        ? null
                        : {
                            id: key,
                            marketKey: analysisResult.market.key,
                            marketLabel: analysisResult.market.label,
                            dimensionKey: dimension.key,
                            dimensionLabel: dimension.label,
                            transitionId: range.id,
                            transitionLabel: range.label,
                            fromGroupValue: range.fromValue,
                            toGroupValue: range.toValue,
                            optionId: basis === 'median' ? 'paired_median' : 'paired_mean',
                            optionLabel: basis === 'median' ? 'Paired-sale median' : 'Paired-sale average',
                            basis: basis === 'median' ? 'paired_sale_median' : 'paired_sale_mean',
                            reliability: range.statistics.reliability,
                            baseAmount,
                            factorPercent,
                            amount: result,
                          };
                    const impact = draftAdjustment
                      ? getImpactPreview(draftAdjustment)
                      : null;
                    const expanded = Boolean(expandedPairs[key]);
                    return (
                      <div key={range.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className="text-lg font-semibold text-slate-950">{range.label}</div>
                            <div className="mt-1 text-xs text-slate-500">
                              {range.statistics.sampleSize} non-overlapping pair{range.statistics.sampleSize === 1 ? '' : 's'} · {range.statistics.reliability} sample
                            </div>
                          </div>
                          <div className="rounded-lg bg-emerald-50 px-3 py-2 text-right">
                            <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Recommended adjustment</div>
                            <div className="mt-1 text-xl font-semibold text-emerald-900">
                              {formatSignedCurrency(range.statistics.recommendedAdjustment)}{resultSuffix(range)}
                            </div>
                          </div>
                        </div>

                        <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-5">
                          {[
                            ['Mean', formatSignedCurrency(range.statistics.mean)],
                            ['Median', formatSignedCurrency(range.statistics.median)],
                            ['Std. deviation', formatCurrency(range.statistics.standardDeviation)],
                            ['CoV', range.statistics.coefficientOfVariation == null ? '—' : `${formatNumber(range.statistics.coefficientOfVariation, 1)}%`],
                            ['COD', range.statistics.coefficientOfDispersion == null ? '—' : `${formatNumber(range.statistics.coefficientOfDispersion, 1)}%`],
                          ].map(([label, value]) => (
                            <div key={label} className="rounded-lg bg-slate-50 px-3 py-2">
                              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
                              <div className="mt-1 font-semibold text-slate-900">{value}{label === 'Mean' || label === 'Median' ? resultSuffix(range) : ''}</div>
                            </div>
                          ))}
                        </div>

                        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_14rem_minmax(0,1fr)] lg:items-end">
                          <div>
                            <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">Adjustment basis</div>
                            <div className="mt-2 flex flex-wrap gap-2">
                              {([
                                ['median', 'Median (recommended)', range.statistics.median],
                                ['mean', 'Average', range.statistics.mean],
                              ] as const).map(([basisKey, label, value]) => (
                                <button
                                  key={basisKey}
                                  type="button"
                                  aria-pressed={basis === basisKey}
                                  onClick={() => setSelectedBases((current) => ({ ...current, [key]: basisKey }))}
                                  className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                                    basis === basisKey
                                      ? 'border-emerald-500 bg-emerald-50 text-emerald-900'
                                      : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400'
                                  }`}
                                >
                                  {label}: {formatSignedCurrency(value)}
                                </button>
                              ))}
                            </div>
                          </div>

                          <label className="block">
                            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Apply factoring</span>
                            <div className="mt-2 flex items-center gap-2">
                              <input
                                type="number"
                                min="0"
                                step="1"
                                value={factorText}
                                onChange={(event) => setFactors((current) => ({ ...current, [key]: event.target.value }))}
                                className="w-28 rounded-lg border border-slate-300 px-3 py-2 text-right text-sm font-semibold focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                                aria-label={`${dimension.label} ${range.label} factoring percentage`}
                              />
                              <span className="font-semibold text-slate-700">%</span>
                            </div>
                          </label>

                          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Factored result</div>
                            <div className="mt-1 text-xl font-semibold text-slate-950">
                              {formatSignedCurrency(result)}{result == null ? '' : resultSuffix(range)}
                            </div>
                            <div className="mt-1 text-xs text-slate-600">
                              {impact
                                ? `${impact.affectedCount} of ${impact.selectedCount} selected comparables would change.`
                                : 'Enter a valid factor to preview the grid impact.'}
                            </div>
                          </div>
                        </div>

                        <div className="mt-4 flex flex-wrap items-center gap-3">
                          <button
                            type="button"
                            disabled={!draftAdjustment}
                            onClick={() => draftAdjustment && onApplyAdjustment(draftAdjustment)}
                            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                          >
                            {applied ? 'Update Grid Adjustment' : 'Apply Adjustment'}
                          </button>
                          {applied && (
                            <button
                              type="button"
                              onClick={() => onRemoveAdjustment(key)}
                              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
                            >
                              Remove Adjustment
                            </button>
                          )}
                          <button
                            type="button"
                            aria-expanded={expanded}
                            onClick={() => setExpandedPairs((current) => ({ ...current, [key]: !expanded }))}
                            className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-900 hover:bg-indigo-100"
                          >
                            {expanded ? 'Hide paired properties' : `Show paired properties (${range.pairs.length})`}
                          </button>
                        </div>

                        {expanded && (
                          <PairEvidenceTable dimension={dimension} range={range} />
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
                  No non-overlapping sale pairs met all practical-similarity safeguards for this feature in the selected area.
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
