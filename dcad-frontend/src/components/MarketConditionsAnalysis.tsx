import { useEffect, useMemo, useRef, useState } from 'react';
import { useApplicationAuth } from '@/features/auth/ApplicationAuth';
import * as api from '@/lib/api';
import type {
  GeoJsonPolygon,
  MarketContextOverride,
  MarketConditionsAnalysis,
  MarketConditionsStudyAreaKey as MarketConditionsAreaKey,
  MarketConditionsResponse,
  MarketConditionsSeriesPoint,
  MarketConditionsSubject,
} from '@/lib/api';
import {
  readMarketConditionsDraft,
  saveMarketConditionsDraft,
  type MarketConditionsDraft,
  type MarketConditionsReconciliation,
  type MarketTrendConclusion,
} from '@/lib/marketConditionsDraft';
import type { MarketAreaOrigin } from '@/lib/marketAreaGeometry';
import type { CustomCohortPreviewGroup } from '@/features/neighborhood/customCohortPreviewController';
import { runMarketStudies, explorationAreaIdentity, marketExplorationIdentity, usableExplorationArea } from '@/features/neighborhood/customCohortMarketArea';
import MarketStudyPropertyContext from './MarketStudyPropertyContext';
import type { MarketStudyComplexity } from '@/lib/marketStudyComplexity';

type TrendInterval = 'monthly' | 'quarterly' | 'semiannual' | 'yearly';

type Props = {
  subjectAccountId: string;
  assignmentFileId?: number | null;
  initialDraft?: MarketConditionsDraft | null;
  initialAsOfDate?: string | null;
  onCompletionChange?: (draft: MarketConditionsDraft | null) => void;
  explorationArea?: CustomCohortPreviewGroup | null;
  initialCustomGeometry?: GeoJsonPolygon | null;
  initialCustomGeometrySource?: string | null;
  suggestedCustomGeometry?: GeoJsonPolygon | null;
  relevanceVisualization?: Array<{
    parcel_object_id: number;
    pocket_id?: string | null;
    cluster_id?: string | null;
    score: number | null;
    excluded: boolean;
    classification: string;
    system_selected?: boolean;
    primary_population: boolean;
    recommended_population?: boolean;
    relevance_band: string;
    appraiser_override?: 'included' | 'removed' | null;
    point: { type: 'Point'; coordinates: [number, number] };
  }>;
  onCustomGeometryChange?: (
    geometry: GeoJsonPolygon | null,
    origin: MarketAreaOrigin,
  ) => void;
  relevanceSummary?: {
    reliabilityScore: number;
    compositeCod: number | null;
    propertyCount: number;
    saleCount: number;
    pocketCount: number;
  } | null;
  onRelevancePocketToggle?: (
    pocketId: string,
    include: boolean,
    systemSelected: boolean,
  ) => void;
  onRelevancePocketInspect?: (pocketId: string) => void;
  embedded?: boolean;
  geography?: string | null;
};

const AREA_OPTIONS: Array<{
  key: MarketConditionsAreaKey;
  label: string;
  description: string;
}> = [
  {
    key: 'city',
    label: 'Entire city',
    description: 'All eligible detached sales in the subject city.',
  },
  {
    key: 'zip',
    label: 'Subject ZIP code',
    description: 'Eligible sales sharing the subject ZIP code.',
  },
  ...[1, 2, 3, 4, 5].map((miles) => ({
    key: `radius_${miles}` as MarketConditionsAreaKey,
    label: `${miles}-mile radius`,
    description: `A cumulative ${miles}-mile area centered on the verified study location.`,
  })),
  {
    key: 'exploration',
    label: 'Exploration Map Area',
    description: 'The exact properties selected on the neighborhood exploration map.',
  },
];

const TREND_OPTIONS: Array<{
  value: MarketTrendConclusion;
  label: string;
}> = [
  { value: 'increasing', label: 'Increasing' },
  { value: 'stable', label: 'Stable' },
  { value: 'decreasing', label: 'Decreasing' },
  { value: 'mixed', label: 'Mixed / transitional' },
  { value: 'insufficient', label: 'Insufficient evidence' },
];

const INTERVAL_OPTIONS: Array<{ value: TrendInterval; label: string }> = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'semiannual', label: 'Semiannual' },
  { value: 'yearly', label: 'Yearly' },
];

function todayInputValue(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function money(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'Not available';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

function numberText(value: number | null, digits = 0): string {
  if (value === null || !Number.isFinite(value)) return 'Not available';
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: digits,
  }).format(value);
}

function percentText(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'Not available';
  return `${numberText(value, 1)}%`;
}

function signedPercentText(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'Not available';
  return `${value > 0 ? '+' : ''}${numberText(value, 1)}%`;
}

function trendLabel(value: MarketTrendConclusion): string {
  return (
    TREND_OPTIONS.find((option) => option.value === value)?.label ||
    'Insufficient evidence'
  );
}

function dateText(value: string | null): string {
  if (!value) return 'Not available';
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(parsed.valueOf())) return value;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(parsed);
}

function periodLabel(value: string | null, interval: TrendInterval): string {
  if (!value) return 'Unknown';
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(parsed.valueOf())) return value;
  const year = parsed.getFullYear();
  const month = parsed.getMonth();
  if (interval === 'monthly') {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      year: '2-digit',
    }).format(parsed);
  }
  if (interval === 'quarterly') {
    return `Q${Math.floor(month / 3) + 1} ${year}`;
  }
  if (interval === 'semiannual') {
    return `${month < 6 ? 'H1' : 'H2'} ${year}`;
  }
  return String(year);
}

function resultFingerprint(
  areaKeys: MarketConditionsAreaKey[],
  asOfDate: string,
  periodMonths: number,
  explorationIdentity: string | null,
  contextOverride: MarketContextOverride | null,
): string {
  return JSON.stringify({
    areaKeys: [...areaKeys].sort(),
    asOfDate,
    periodMonths,
    explorationIdentity: areaKeys.includes('exploration') ? explorationIdentity : null,
    contextOverride,
  });
}

function defaultReconciliation(
  response: MarketConditionsResponse,
): MarketConditionsReconciliation {
  const labels = response.analyses.map((analysis) => analysis.market.label);
  const populations = response.analyses
    .map((analysis) => analysis.population.eligible_sale_count)
    .filter((count) => count > 0);
  const populationText = populations.length
    ? `${Math.min(...populations).toLocaleString()} to ${Math.max(
        ...populations,
      ).toLocaleString()} sales`
    : 'no eligible sales';
  const recommendation = response.recommendation;
  const rankedLabels = recommendation.ranked_studies
    .map((study) => study.label)
    .join(', ');
  return {
    trendConclusion: recommendation.conclusion,
    reliedUponAreaKeys: response.analyses.map(
      (analysis) => analysis.market.key,
    ),
    explanation:
      `The appraiser reviewed ${labels.join(', ') || 'the selected market areas'}. ` +
      `The independent study populations range from ${populationText}. ` +
      (recommendation.recommended_change_percent === null
        ? 'The automated analysis did not have enough complete monthly observations to recommend a market trend. '
        : `The automated analysis indicates ${trendLabel(
            recommendation.conclusion,
          ).toLowerCase()} conditions based on a ${signedPercentText(
            recommendation.recommended_change_percent,
          )} reconciled annualized change. `) +
      (rankedLabels
        ? `The highest-ranked study populations are ${rankedLabels}. `
        : '') +
      'Explain which geography and time interval receive the greatest weight, why that evidence best reflects the subject market, and how the reported trend conclusion was reconciled.',
  };
}

function MedianPriceBars({
  points,
  interval,
}: {
  points: MarketConditionsSeriesPoint[];
  interval: TrendInterval;
}) {
  const visible = points.filter(
    (point) =>
      point.median_sale_price !== null &&
      Number.isFinite(point.median_sale_price),
  );
  const maximum = Math.max(
    ...visible.map((point) => point.median_sale_price || 0),
    1,
  );
  const plotHeight = 180;
  const maximumBarHeight = 170;
  const chartWidth = visible.length * 100;
  const plottedPoints = visible.map((point, index) => {
    const value = point.median_sale_price || 0;
    const height = Math.max(
      12,
      Math.round((value / maximum) * maximumBarHeight),
    );
    return {
      point,
      value,
      height,
      x: index * 100 + 50,
      y: plotHeight - height,
    };
  });
  if (!visible.length) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
        No median sale-price series is available for this interval.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white p-4">
      <div
        className="relative"
        style={{ minWidth: Math.max(620, visible.length * 74) }}
      >
        <div className="h-[180px]">
          <svg
            aria-label={`${interval} median sale-price chart`}
            className="block h-full w-full overflow-visible"
            preserveAspectRatio="none"
            viewBox={`0 0 ${chartWidth} ${plotHeight}`}
          >
            <defs>
              <linearGradient id={`median-bars-${interval}`} x1="0" y1="1" x2="0" y2="0">
                <stop offset="0%" stopColor="#047857" />
                <stop offset="100%" stopColor="#34d399" />
              </linearGradient>
            </defs>
            {plottedPoints.map(({ point, value, height, x, y }) => (
              <g key={`${interval}:${point.period_start}`}>
                <title>{`${periodLabel(point.period_start, interval)}: ${money(
                  value,
                )} median from ${point.sale_count} sales`}</title>
                <rect
                  x={x - 27}
                  y={y}
                  width="54"
                  height={height}
                  rx="5"
                  fill={`url(#median-bars-${interval})`}
                />
                <text
                  x={x}
                  y={Math.max(11, y - 8)}
                  fill="#334155"
                  fontSize="11"
                  fontWeight="600"
                  textAnchor="middle"
                >
                  {money(value)}
                </text>
              </g>
            ))}
            <polyline
              fill="none"
              points={plottedPoints
                .map(({ x, y }) => `${x},${y}`)
                .join(' ')}
              stroke="#0f172a"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="3"
              vectorEffect="non-scaling-stroke"
            />
            {plottedPoints.map(({ point, x, y }) => (
              <circle
                key={`dot:${interval}:${point.period_start}`}
                cx={x}
                cy={y}
                r="5"
                fill="#0f172a"
                stroke="#ffffff"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
        </div>

        <div className="flex">
          {plottedPoints.map(({ point }) => (
            <div
              key={`${interval}:${point.period_start}`}
              className="min-w-[74px] flex-1 px-1 pt-2 text-center"
            >
              <div className="text-[11px] font-medium text-slate-600">
                {periodLabel(point.period_start, interval)}
              </div>
              <div className="text-[10px] text-slate-400">
                {point.sale_count} sale{point.sale_count === 1 ? '' : 's'}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StudyComparisonTable({
  analyses,
}: {
  analyses: MarketConditionsAnalysis[];
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200">
      <table className="min-w-full divide-y divide-slate-200 bg-white text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
          <tr>
            <th className="px-4 py-3">Study area</th>
            <th className="px-4 py-3 text-right">Sales</th>
            <th className="px-4 py-3 text-right">Median sale price</th>
            <th className="px-4 py-3 text-right">Median DOM</th>
            <th className="px-4 py-3 text-right">Median sale/list</th>
            <th className="px-4 py-3 text-right">Median price/SF</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {analyses.map((analysis) => (
            <tr key={analysis.market.key}>
              <td className="px-4 py-3 font-semibold text-slate-900">
                {analysis.market.label}
              </td>
              <td className="px-4 py-3 text-right">
                {analysis.population.eligible_sale_count.toLocaleString()}
              </td>
              <td className="px-4 py-3 text-right">
                {money(analysis.summary.median_sale_price)}
              </td>
              <td className="px-4 py-3 text-right">
                {numberText(analysis.summary.median_days_on_market, 1)}
              </td>
              <td className="px-4 py-3 text-right">
                {percentText(analysis.summary.median_sale_to_list_ratio)}
              </td>
              <td className="px-4 py-3 text-right">
                {money(analysis.summary.median_price_per_square_foot)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StudyStatistics({
  analysis,
}: {
  analysis: MarketConditionsAnalysis;
}) {
  const { statistics, summary } = analysis;
  const factorRows = [
    {
      label: 'Living area',
      factor: summary.congruency_factors.living_area,
    },
    {
      label: 'Price per SF',
      factor: summary.congruency_factors.price_per_square_foot,
    },
    {
      label: 'Sale price',
      factor: summary.congruency_factors.sale_price,
    },
    { label: 'Age', factor: summary.congruency_factors.age },
  ];
  const changeColor =
    statistics.annualized_change_percent === null
      ? 'text-slate-500'
      : Math.abs(statistics.annualized_change_percent) < 1
        ? 'text-slate-700'
        : statistics.annualized_change_percent > 0
          ? 'text-emerald-700'
          : 'text-rose-700';
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white px-3 py-3">
      <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-center">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Yearly change
          </div>
          <div className={`text-lg font-bold ${changeColor}`}>
            {signedPercentText(statistics.annualized_change_percent)}
          </div>
        </div>
        <div
          title="Weighted coefficient of dispersion. Living area is 40%, age 30%, housing-type mix 20%, and price/SF and sale price are 5% each. Lower is more congruent."
        >
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Composite COD
          </div>
          <div className="text-lg font-bold text-slate-900">
            {percentText(statistics.composite_cod)}
          </div>
        </div>
        <div
          title="Weighted coefficient of variation. Living area is 40%, age 30%, housing-type mix 20%, and price/SF and sale price are 5% each. Lower is more congruent."
        >
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Composite CV
          </div>
          <div className="text-lg font-bold text-slate-900">
            {percentText(statistics.composite_cv)}
          </div>
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Reliability
          </div>
          <div className="text-lg font-bold text-indigo-800">
            {numberText(statistics.reliability_score, 1)}/100
          </div>
        </div>
      </div>
      <div className="mt-2 text-center text-[11px] text-slate-500">
        Congruency weights: living area 40%, age 30%, housing type 20%, price
        per SF 5%, and sale price 5%. Lower COD and CV indicate a more
        consistent study population.
      </div>
      <details className="mt-2 text-xs text-slate-600">
        <summary className="cursor-pointer text-center font-semibold text-slate-700">
          View congruency calculation
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="mx-auto min-w-[520px] text-left">
            <thead className="text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-2 py-1">Factor</th>
                <th className="px-2 py-1 text-right">Weight</th>
                <th className="px-2 py-1 text-right">Records</th>
                <th className="px-2 py-1 text-right">COD</th>
                <th className="px-2 py-1 text-right">CV</th>
              </tr>
            </thead>
            <tbody>
              {factorRows.map(({ label, factor }) => (
                <tr key={label} className="border-t border-slate-100">
                  <td className="px-2 py-1.5 font-medium">{label}</td>
                  <td className="px-2 py-1.5 text-right">
                    {percentText(factor.weight * 100)}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {factor.count.toLocaleString()}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {percentText(factor.cod)}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {percentText(factor.cv)}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-slate-100">
                <td className="px-2 py-1.5 font-medium">
                  Housing type mix
                  {summary.congruency_factors.housing_type.dominant_type
                    ? ` (${summary.congruency_factors.housing_type.dominant_type})`
                    : ''}
                </td>
                <td className="px-2 py-1.5 text-right">10.0%</td>
                <td className="px-2 py-1.5 text-right">
                  {summary.congruency_factors.housing_type.count.toLocaleString()}
                </td>
                <td className="px-2 py-1.5 text-right" colSpan={2}>
                  {percentText(
                    summary.congruency_factors.housing_type.dispersion,
                  )}{' '}
                  outside dominant type
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function RecommendedDetermination({
  response,
  compact = false,
}: {
  response: MarketConditionsResponse;
  compact?: boolean;
}) {
  const recommendation = response.recommendation;
  return (
    <div className={`${compact ? 'mt-2 p-3' : 'mt-4 p-4'} rounded-xl border border-indigo-200 bg-white`}>
      <div className={`flex flex-wrap items-start justify-between ${compact ? 'gap-2' : 'gap-3'}`}>
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
            Recommended determination
          </div>
          <div className={`${compact ? 'mt-0.5' : 'mt-1'} flex flex-wrap items-baseline gap-2`}>
            <span className={`${compact ? 'text-lg' : 'text-xl'} font-bold text-slate-950`}>
              {trendLabel(recommendation.conclusion)}
            </span>
            <span className="text-sm font-semibold text-indigo-800">
              {signedPercentText(recommendation.recommended_change_percent)}
              {' '}reconciled annualized change
            </span>
          </div>
        </div>
        <div className="flex gap-5 text-right text-xs text-slate-500">
          <div>
            <div>Study average</div>
            <div className="font-semibold text-slate-900">
              {signedPercentText(
                recommendation.average_annualized_change_percent,
              )}
            </div>
          </div>
          <div>
            <div>Study median</div>
            <div className="font-semibold text-slate-900">
              {signedPercentText(
                recommendation.median_annualized_change_percent,
              )}
            </div>
          </div>
        </div>
      </div>
      <p className={`${compact ? 'hidden' : 'mt-2 leading-5'} text-xs text-slate-600`}>
        Studies are ranked by sample sufficiency, monthly coverage, composite
        COD/CV congruency, and characteristic coverage. A reconciled change
        within ±{numberText(recommendation.stable_threshold_percent, 1)}% is
        classified as stable. The appraiser may override this recommendation.
      </p>
      {recommendation.weighting_method === 'appraiser_defined_area_60_percent' ? (
        <div className={`${compact ? 'mt-1 px-2 py-1.5' : 'mt-2 px-3 py-2'} rounded-lg border border-indigo-200 bg-indigo-50 text-xs font-medium text-indigo-900`}>
          The appraiser-defined area receives 60% of the reconciliation weight.
          The remaining 40% is divided among the other studies according to their
          reliability scores.
        </div>
      ) : null}
      {recommendation.ranked_studies.length > 0 && (
        <div className={`${compact ? 'mt-2 gap-1.5' : 'mt-3 gap-2'} grid md:grid-cols-3`}>
          {recommendation.ranked_studies.map((study) => (
            <div
              key={study.key}
              className={`rounded-lg border border-slate-200 bg-slate-50 text-xs ${compact ? 'px-2 py-1.5' : 'px-3 py-2'}`}
            >
              <div className="font-semibold text-slate-900">
                #{study.rank} {study.label}
              </div>
              <div className={`${compact ? 'mt-0.5' : 'mt-1'} text-slate-600`}>
                Score {numberText(study.reliability_score, 1)}/100 ·{' '}
                {study.sale_count.toLocaleString()} sales ·{' '}
                {signedPercentText(study.annualized_change_percent)}
              </div>
              {study.reconciliation_weight_percent != null ? (
                <div className={`${compact ? 'mt-0.5' : 'mt-1'} font-semibold text-indigo-700`}>
                  {numberText(study.reconciliation_weight_percent, 1)}% reconciliation weight
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MarketConditionsAnalysis({
  subjectAccountId,
  assignmentFileId = null,
  initialDraft = null,
  initialAsOfDate = null,
  onCompletionChange,
  explorationArea = null,
  embedded = false,
  geography = null,
}: Props) {
  const { session: applicationSession } = useApplicationAuth();
  const selectedExploration = usableExplorationArea(explorationArea, subjectAccountId, assignmentFileId);
  const explorationIdentity = selectedExploration ? explorationAreaIdentity(selectedExploration.binding) : null;
  const onCompletionChangeRef = useRef(onCompletionChange);
  onCompletionChangeRef.current = onCompletionChange;
  const savedDraft = useMemo(
    () => {
      const value = initialDraft || readMarketConditionsDraft(subjectAccountId, assignmentFileId, applicationSession);
      return value?.accountId.trim().toUpperCase() === subjectAccountId.trim().toUpperCase()
        && value.assignmentFileId === assignmentFileId ? value : null;
    },
    [applicationSession, assignmentFileId, initialDraft, subjectAccountId],
  );
  const [subject, setSubject] = useState<MarketConditionsSubject | null>(
    savedDraft?.response.subject || null,
  );
  const [selectedAreaKeys, setSelectedAreaKeys] = useState<
    MarketConditionsAreaKey[]
  >(() => savedDraft?.selectedAreaKeys?.length
    ? savedDraft.selectedAreaKeys.filter(key => key !== 'custom')
    : embedded ? ['exploration'] : AREA_OPTIONS.filter(option => option.key !== 'exploration').map(option => option.key));
  const [asOfDate, setAsOfDate] = useState(
    savedDraft?.asOfDate || initialAsOfDate || todayInputValue(),
  );
  const [periodMonths, setPeriodMonths] = useState<12 | 24 | 36>(
    savedDraft?.periodMonths || 24,
  );
  const [analysisResult, setAnalysisResult] =
    useState<MarketConditionsResponse | null>(savedDraft?.response || null);
  const [studyComplexity, setStudyComplexity] = useState<MarketStudyComplexity | null>(savedDraft?.propertyComplexity ?? null);
  const [studyRevision, setStudyRevision] = useState(0);
  const draftHydrated = useRef(Boolean(savedDraft));
  const studyEdited = useRef(false);
  const [reconciliation, setReconciliation] =
    useState<MarketConditionsReconciliation>(
      savedDraft?.reconciliation || {
        trendConclusion: 'insufficient',
        reliedUponAreaKeys: [],
        explanation: '',
      },
    );
  const [runSignature, setRunSignature] = useState(
    savedDraft
      ? resultFingerprint(
          savedDraft.selectedAreaKeys,
          savedDraft.asOfDate,
          savedDraft.periodMonths,
          marketExplorationIdentity(savedDraft.response),
          savedDraft.contextOverride || null,
        )
      : '',
  );
  const [chartInterval, setChartInterval] =
    useState<TrendInterval>('monthly');
  const [studyResultsExpanded, setStudyResultsExpanded] = useState(false);
  const [loadingContext, setLoadingContext] = useState(!subject);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [savingNarrative, setSavingNarrative] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const activeContextOverride = null;
  const currentSignature = useMemo(
    () =>
      resultFingerprint(
        selectedAreaKeys,
        asOfDate,
        periodMonths,
        explorationIdentity,
        activeContextOverride,
      ),
    [
      activeContextOverride,
      asOfDate,
      explorationIdentity,
      periodMonths,
      selectedAreaKeys,
    ],
  );
  const studyIsCurrent =
    Boolean(analysisResult?.analyses.length) &&
    runSignature === currentSignature &&
    (!selectedAreaKeys.includes('exploration') || Boolean(selectedExploration
      && analysisResult && marketExplorationIdentity(analysisResult) === explorationIdentity));

  useEffect(() => {
    // The lazy editor can mount before its database workfile arrives. Adopt
    // that exact-file draft once, but never overwrite edits or rehydrate our
    // own save callbacks. Map identity still decides whether it is current.
    if (draftHydrated.current || studyEdited.current || !savedDraft) return;
    draftHydrated.current = true;
    setSubject(savedDraft.response.subject);
    setSelectedAreaKeys(savedDraft.selectedAreaKeys.filter(key => key !== 'custom'));
    setAsOfDate(savedDraft.asOfDate);
    setPeriodMonths(savedDraft.periodMonths);
    setAnalysisResult(savedDraft.response);
    setReconciliation(savedDraft.reconciliation);
    setStudyComplexity(savedDraft.propertyComplexity ?? null);
    setRunSignature(resultFingerprint(savedDraft.selectedAreaKeys, savedDraft.asOfDate,
      savedDraft.periodMonths, marketExplorationIdentity(savedDraft.response), savedDraft.contextOverride || null));
  }, [savedDraft]);

  useEffect(() => {
    let cancelled = false;
    if (!subjectAccountId || !assignmentFileId) return () => undefined;
    setLoadingContext(true);
    void api
      .getMarketConditionsContext(subjectAccountId, assignmentFileId)
      .then((response) => {
        if (!cancelled) {
          setSubject(response.subject);
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : 'The subject market context could not be loaded.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingContext(false);
      });
    return () => {
      cancelled = true;
    };
  }, [assignmentFileId, subjectAccountId]);

  useEffect(() => {
    if (studyIsCurrent && analysisResult) {
      const draft: MarketConditionsDraft = {
        version: 3,
        accountId: subjectAccountId,
        assignmentFileId,
        savedAt: new Date().toISOString(),
        asOfDate,
        periodMonths,
        selectedAreaKeys,
        contextOverride: activeContextOverride,
        response: analysisResult,
        reconciliation,
        propertyComplexity: studyComplexity,
      };
      onCompletionChangeRef.current?.(draft);
    } else {
      onCompletionChangeRef.current?.(null);
    }
  }, [
    analysisResult,
    activeContextOverride,
    assignmentFileId,
    asOfDate,
    periodMonths,
    reconciliation,
    selectedAreaKeys,
    studyIsCurrent,
    studyComplexity,
    subjectAccountId,
  ]);

  function toggleArea(key: MarketConditionsAreaKey): void {
    studyEdited.current = true;
    setSelectedAreaKeys((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key],
    );
    setNotice(null);
  }


  async function runAnalysis(): Promise<void> {
    studyEdited.current = true;
    if (!selectedAreaKeys.length) {
      setError('Select at least one market area before running the study.');
      return;
    }
    if (selectedAreaKeys.length === 1 && selectedAreaKeys.includes('exploration') && !selectedExploration) {
      setError('Select subdivisions on the exploration map and wait for their statistics to finish updating.');
      return;
    }
    setLoadingAnalysis(true);
    setError(null);
    setNotice(null);
    try {
      const request = {
        subjectAccountId,
        assignmentFileId,
        areaKeys: selectedAreaKeys,
        asOf: asOfDate,
        periodMonths,
        contextOverride: activeContextOverride,
      };
      const response = await runMarketStudies(request, selectedExploration);
      const nextReconciliation = defaultReconciliation(response);
      const signature = resultFingerprint(
        selectedAreaKeys,
        asOfDate,
        periodMonths,
        explorationIdentity,
        activeContextOverride,
      );
      const draft: MarketConditionsDraft = {
        version: 3,
        accountId: subjectAccountId,
        assignmentFileId,
        savedAt: new Date().toISOString(),
        asOfDate,
        periodMonths,
        selectedAreaKeys,
        contextOverride: activeContextOverride,
        response,
        reconciliation: nextReconciliation,
        propertyComplexity: null,
      };
      setAnalysisResult(response);
      setReconciliation(nextReconciliation);
      setRunSignature(signature);
      setStudyComplexity(null);
      setStudyRevision(revision => revision + 1);
      // The coherence effect above is the only report callback owner. A late
      // response after a map click must never publish a superseded selection.
      if (!onCompletionChange) saveMarketConditionsDraft(draft, applicationSession);
      setNotice(
        `${response.analyses.length} independent market ${
          response.analyses.length === 1 ? 'study is' : 'studies are'
        } complete. Comparable inventory remains unchanged.`,
      );
    } catch (analysisError: unknown) {
      setError(
        analysisError instanceof Error
          ? analysisError.message
          : 'The market-condition studies could not be completed.',
      );
    } finally {
      setLoadingAnalysis(false);
    }
  }

  function saveReconciliation(): void {
    if (!analysisResult || !studyIsCurrent) {
      setError('Run the current market-study selections before saving reconciliation.');
      return;
    }
    setSavingNarrative(true);
    setError(null);
    const draft: MarketConditionsDraft = {
      version: 3,
      accountId: subjectAccountId,
      assignmentFileId,
      savedAt: new Date().toISOString(),
      asOfDate,
      periodMonths,
      selectedAreaKeys,
      contextOverride: activeContextOverride,
      response: analysisResult,
      reconciliation,
      propertyComplexity: studyComplexity,
    };
    if (onCompletionChange) onCompletionChange(draft);
    else saveMarketConditionsDraft(draft, applicationSession);
    setNotice('Market conclusion and reconciliation were saved to the appraisal workfile.');
    window.setTimeout(() => setSavingNarrative(false), 350);
  }

  const mappedCoverage = analysisResult?.analyses.reduce(
    (totals, analysis) => ({
      eligible:
        totals.eligible + analysis.population.eligible_sale_count,
      mapped: totals.mapped + analysis.population.mapped_sale_count,
    }),
    { eligible: 0, mapped: 0 },
  );
  const coordinateCoverageIssues =
    analysisResult?.analyses.filter((analysis) => {
      if (!['city', 'zip'].includes(analysis.market.scope)) return false;
      const eligible = analysis.population.eligible_sale_count;
      return (
        eligible > 0 &&
        analysis.population.mapped_sale_count / eligible < 0.9
      );
    }) || [];
  const smallSampleAreas =
    analysisResult?.analyses.filter(
      (analysis) => analysis.population.eligible_sale_count < 30,
    ) || [];

  return (
    <section
      className={
        embedded
          ? 'rounded-xl border border-emerald-200 bg-white shadow-sm'
          : 'mb-4 rounded-2xl border border-emerald-200 bg-white shadow-sm'
      }
    >
      <div className={`border-b border-emerald-100 bg-emerald-50/60 ${embedded ? 'p-2.5' : 'p-5'}`}>
        <div className={`flex justify-between gap-2 ${embedded ? 'items-center' : 'flex-wrap items-start gap-3'}`}>
          <div className={embedded ? 'min-w-0' : ''}>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
              Required before comparable selection
            </div>
            <h2 className={`${embedded ? 'mt-0.5 text-lg' : 'mt-1 text-xl'} font-semibold text-slate-950`}>
              Market Conditions Analysis
            </h2>
            <p className={`${embedded ? 'mt-0.5 truncate text-xs' : 'mt-1 max-w-4xl text-sm'} text-slate-600`}>
              {embedded
                ? 'Compare study areas and reconcile the market trend.'
                : 'Compare multiple independent geographies, review time-based market evidence, and reconcile the market trend. These studies do not filter or change the comparable-sales inventory.'}
            </p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              studyIsCurrent
                ? 'bg-emerald-700 text-white'
                : 'bg-amber-100 text-amber-900'
            }`}
          >
            {studyIsCurrent ? 'Study complete' : 'Study required'}
          </span>
        </div>
      </div>

      <div className={embedded ? 'space-y-2 p-2.5' : 'space-y-5 p-5'}>
        <div className={embedded ? 'grid grid-cols-1 gap-1.5 sm:grid-cols-2' : 'grid grid-cols-1 gap-4 sm:grid-cols-2'}>
          <label className="grid gap-1 text-sm text-slate-700">
            <span className="font-medium">Analysis as of</span>
            <input
              type="date"
              value={asOfDate}
              onChange={(event) => { studyEdited.current = true; setAsOfDate(event.target.value); }}
              className={`rounded-lg border border-slate-300 px-3 ${embedded ? 'py-1.5' : 'py-2'}`}
            />
          </label>
          <label className="grid gap-1 text-sm text-slate-700">
            <span className="font-medium">Historical period</span>
            <select
              value={periodMonths}
              onChange={(event) => {
                studyEdited.current = true;
                setPeriodMonths(Number(event.target.value) as 12 | 24 | 36);
              }}
              className={`rounded-lg border border-slate-300 bg-white px-3 ${embedded ? 'py-1.5' : 'py-2'}`}
            >
              <option value={12}>12 months</option>
              <option value={24}>24 months</option>
              <option value={36}>36 months</option>
            </select>
            <span className={`${embedded ? 'text-[10px] leading-4' : 'text-xs'} text-slate-500`}>
              Uses complete calendar months ending with the latest fully
              completed month.
            </span>
          </label>
        </div>

        <MarketStudyPropertyContext key={`${runSignature}:${studyRevision}`} accountId={subjectAccountId} assignmentFileId={assignmentFileId}
          // Retain the completed run identity while its map selection restores.
          // current still prevents stale assessment display and saving.
          response={analysisResult} current={studyIsCurrent} studySignature={runSignature} studyRevision={studyRevision}
          geography={geography} reliedUpon={reconciliation.reliedUponAreaKeys} initialScreening={savedDraft?.propertyComplexity}
          onChange={setStudyComplexity} />

        <fieldset className={`rounded-xl border border-slate-200 bg-slate-50 ${embedded ? 'p-2.5' : 'p-4'}`}>
          <div className={`flex flex-wrap items-center justify-between ${embedded ? 'gap-2' : 'gap-3'}`}>
            <legend className={`${embedded ? 'text-sm' : 'text-base'} font-semibold text-slate-900`}>
              Select one or more independent study areas
            </legend>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  studyEdited.current = true;
                  setSelectedAreaKeys(AREA_OPTIONS.filter(option => option.key !== 'exploration' || selectedExploration).map((option) => option.key));
                }}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => { studyEdited.current = true; setSelectedAreaKeys([]); }}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
              >
                Clear
              </button>
            </div>
          </div>
          <div className={`grid grid-cols-1 md:grid-cols-2 ${embedded ? 'mt-1.5 gap-1.5 lg:grid-cols-8' : 'mt-3 gap-3 xl:grid-cols-4'}`}>
            {AREA_OPTIONS.map((option) => {
              const selected = selectedAreaKeys.includes(option.key);
              return (
                <label
                  key={option.key}
                  className={`flex cursor-pointer rounded-xl border ${embedded ? 'gap-1.5 p-1.5' : 'gap-3 p-3'} ${
                    selected
                      ? 'border-emerald-500 bg-emerald-50 ring-1 ring-emerald-200'
                      : 'border-slate-200 bg-white hover:border-slate-400'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={option.key === 'exploration' && !selectedExploration}
                    onChange={() => toggleArea(option.key)}
                    className="mt-1 h-4 w-4 rounded border-slate-300 text-emerald-700 focus:ring-emerald-500"
                  />
                  <span>
                    <span className={`${embedded ? 'text-[11px]' : 'text-sm'} block font-semibold text-slate-900`}>
                      {option.label}
                    </span>
                    <span className={embedded ? 'sr-only' : 'mt-1 block text-xs text-slate-500'}>
                      {option.description}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {selectedAreaKeys.includes('exploration') && <p role="status" className="text-sm font-medium text-violet-950">
          {selectedExploration ? 'Using the selected subdivisions on the exploration map.' : 'Waiting for the exploration map selection.'}
        </p>}

        <div className={`flex flex-wrap items-center ${embedded ? 'gap-2' : 'gap-3'}`}>
          <button
            type="button"
            onClick={() => void runAnalysis()}
            disabled={
              loadingAnalysis ||
              loadingContext ||
              !subject ||
              !selectedAreaKeys.length ||
              (selectedAreaKeys.length === 1 && selectedAreaKeys.includes('exploration') && !selectedExploration)
            }
            className={`rounded-lg bg-emerald-700 px-5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-300 ${embedded ? 'py-2' : 'py-2.5'}`}
          >
            {loadingAnalysis
              ? 'Calculating market studies...'
              : `Run ${selectedAreaKeys.length || ''} market ${
                  selectedAreaKeys.length === 1 ? 'study' : 'studies'
                }`}
          </button>
          <span className="text-xs text-slate-500">
            Closed, single-parcel detached sales are analyzed independently in
            every selected area.
          </span>
        </div>

        {analysisResult && !studyIsCurrent && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {runSignature === currentSignature && analysisResult.unavailable_areas.length
              ? 'Some selected areas could not be calculated. Completed studies are shown below.'
              : 'The area or observation dates changed. Rerun the market studies to update the results.'}
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-950">
            {notice}
          </div>
        )}

        {analysisResult && (
          <div className={embedded ? 'space-y-3 border-t border-slate-200 pt-3' : 'space-y-6 border-t border-slate-200 pt-5'}>
            {analysisResult.subject.context_override_active && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
                <span className="font-semibold">Flagged study geography:</span>{' '}
                this result used {analysisResult.subject.context_override_source?.replace(/_/g, ' ')}
                {analysisResult.subject.context_source_account_id
                  ? ` from CAD parcel ${analysisResult.subject.context_source_account_id}`
                  : ''}
                . The underlying subject account was not changed.
              </div>
            )}
            {coordinateCoverageIssues.length > 0 && (
              <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-950">
                <div className="font-semibold">Incomplete parcel-location coverage</div>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {coordinateCoverageIssues.map((analysis) => (
                    <li key={analysis.market.key}>
                      {analysis.market.label}: {analysis.population.mapped_sale_count.toLocaleString()} of{' '}
                      {analysis.population.eligible_sale_count.toLocaleString()} eligible sales have coordinates.
                    </li>
                  ))}
                </ul>
                Radius and custom-area results may be materially understated until the location backlog is complete.
              </div>
            )}
            {smallSampleAreas.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
                <span className="font-semibold">Limited sample:</span>{' '}
                {smallSampleAreas
                  .map(
                    (analysis) =>
                      `${analysis.market.label} (${analysis.population.eligible_sale_count})`,
                  )
                  .join(', ')}. Studies below 30 sales should be reconciled cautiously.
              </div>
            )}
            <div className="overflow-hidden rounded-2xl border border-slate-300 bg-white">
              <button
                type="button"
                aria-expanded={studyResultsExpanded}
                aria-controls="market-study-comparison-results"
                aria-label={studyResultsExpanded ? 'Collapse market study results' : 'Expand market study results'}
                onClick={() => setStudyResultsExpanded((current) => !current)}
                className={`flex w-full items-center justify-between text-left hover:bg-slate-50 ${embedded ? 'gap-3 px-3 py-2.5' : 'gap-4 px-4 py-4 md:px-5'}`}
              >
                <div>
                  <h3 className={`${embedded ? 'text-base' : 'text-lg'} font-semibold text-slate-950`}>
                    Study comparison and charts
                  </h3>
                  <p className={`${embedded ? 'mt-0.5 text-xs' : 'mt-1 text-sm'} text-slate-600`}>
                    {analysisResult.analyses.length} independent market{' '}
                    {analysisResult.analyses.length === 1 ? 'study' : 'studies'} available for review.
                  </p>
                </div>
                <span className="shrink-0 rounded-lg border border-slate-950 bg-slate-950 px-3 py-2 text-xs font-semibold text-white">
                  {studyResultsExpanded ? 'Collapse results' : 'Expand results'}
                </span>
              </button>

              {studyResultsExpanded && (
                <div
                  id="market-study-comparison-results"
                  className={embedded ? 'space-y-4 border-t border-slate-200 p-3' : 'space-y-6 border-t border-slate-200 p-4 md:p-5'}
                >
                  <div>
                    <div className="flex flex-wrap items-end justify-between gap-3">
                      <div>
                        <h3 className="text-lg font-semibold text-slate-950">
                          Study comparison
                        </h3>
                        <p className="mt-1 text-sm text-slate-600">
                          Compare population and median indicators before deciding
                          which evidence receives the greatest weight.
                        </p>
                      </div>
                      {mappedCoverage && mappedCoverage.eligible > 0 && (
                        <span className="text-xs font-medium text-slate-500">
                          {mappedCoverage.mapped.toLocaleString()} of{' '}
                          {mappedCoverage.eligible.toLocaleString()} study observations
                          have parcel coordinates across the independent results.
                        </span>
                      )}
                    </div>
                    <div className="mt-3">
                      <StudyComparisonTable analyses={analysisResult.analyses} />
                    </div>
                  </div>

            <div className="flex flex-wrap gap-2">
              {INTERVAL_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setChartInterval(option.value)}
                  className={`rounded-full px-4 py-2 text-sm font-semibold ${
                    chartInterval === option.value
                      ? 'bg-slate-900 text-white'
                      : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {analysisResult.unavailable_areas.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
                <div className="font-semibold">Some selected areas were unavailable</div>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {analysisResult.unavailable_areas.map((item) => (
                    <li key={item.key}>
                      {item.label}: {item.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {analysisResult.analyses.map((analysis) => (
              <article
                key={analysis.market.key}
                className="rounded-2xl border border-slate-300 bg-slate-50/40 p-4 md:p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                      Independent market study
                    </div>
                    <h3 className="mt-1 text-xl font-semibold text-slate-950">
                      {analysis.market.label}
                    </h3>
                    <div className="mt-1 text-sm text-slate-500">
                      {dateText(analysis.period.start)} through{' '}
                      {dateText(analysis.period.end)}
                    </div>
                  </div>
                  <div className="text-right text-xs text-slate-500">
                    <div className="font-semibold text-slate-900">
                      {analysis.population.eligible_sale_count.toLocaleString()}{' '}
                      eligible sales
                    </div>
                    {analysis.market.scope === 'custom' &&
                      analysis.market.area_square_miles !== null && (
                        <div>
                          {numberText(
                            analysis.market.area_square_miles,
                            2,
                          )}{' '}
                          square miles
                        </div>
                      )}
                  </div>
                </div>

                {analysis.market.scope === 'custom' &&
                  analysis.market.includes_subject === false && (
                    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                      The custom polygon does not include the selected study center.
                      The study remains available, but the appraiser should
                      explain why this separate area is relevant.
                    </div>
                  )}

                <StudyStatistics analysis={analysis} />

                <div className="mt-4">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h4 className="font-semibold text-slate-900">
                      {INTERVAL_OPTIONS.find(
                        (option) => option.value === chartInterval,
                      )?.label}{' '}
                      median sale price
                    </h4>
                    <span className="text-xs text-slate-500">
                      Bars and the trend line show each period median; labels
                      include the median and sample size.
                    </span>
                  </div>
                  <MedianPriceBars
                    points={analysis.series[chartInterval]}
                    interval={chartInterval}
                  />
                </div>
              </article>
            ))}
                </div>
              )}
            </div>

            <div className={`rounded-2xl border border-indigo-200 bg-indigo-50/40 ${embedded ? 'p-3' : 'p-5'}`}>
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
                  Appraiser reconciliation
                </div>
                <h3 className={`${embedded ? 'mt-0.5 text-base' : 'mt-1 text-lg'} font-semibold text-slate-950`}>
                  Market trend conclusion and evidence weighting
                </h3>
                <p className={`${embedded ? 'mt-0.5 text-xs' : 'mt-1 text-sm'} text-slate-600`}>
                  Explain why particular study populations and time intervals
                  are most relevant. This narrative will be carried into the
                  appraisal report.
                </p>
              </div>

              <RecommendedDetermination response={analysisResult} compact={embedded} />

              <div className={embedded ? 'mt-2 grid grid-cols-1 gap-2 lg:grid-cols-4' : 'mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]'}>
                <label className={`grid gap-1 text-sm text-slate-700 ${embedded ? 'lg:col-span-1' : ''}`}>
                  <span className="font-medium">Market trend conclusion</span>
                  <select
                    value={reconciliation.trendConclusion}
                    onChange={(event) =>
                      setReconciliation((current) => ({
                        ...current,
                        trendConclusion: event.target
                          .value as MarketTrendConclusion,
                      }))
                    }
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2"
                  >
                    {TREND_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <fieldset className={embedded ? 'lg:col-span-3' : ''}>
                  <legend className="text-sm font-medium text-slate-700">
                    Studies given greatest weight
                  </legend>
                  <div className={`${embedded ? 'mt-1 gap-1.5' : 'mt-2 gap-2'} flex flex-wrap`}>
                    {analysisResult.analyses.map((analysis) => {
                      const selected =
                        reconciliation.reliedUponAreaKeys.includes(
                          analysis.market.key,
                        );
                      return (
                        <label
                          key={analysis.market.key}
                          className={`inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 text-xs font-semibold ${embedded ? 'py-1.5' : 'py-2'} ${
                            selected
                              ? 'border-indigo-500 bg-indigo-100 text-indigo-950'
                              : 'border-slate-300 bg-white text-slate-600'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() =>
                              setReconciliation((current) => ({
                                ...current,
                                reliedUponAreaKeys: selected
                                  ? current.reliedUponAreaKeys.filter(
                                      (key) => key !== analysis.market.key,
                                    )
                                  : [
                                      ...current.reliedUponAreaKeys,
                                      analysis.market.key,
                                    ],
                              }))
                            }
                          />
                          {analysis.market.label}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              </div>

              <label className={`${embedded ? 'mt-2' : 'mt-4'} grid gap-1 text-sm text-slate-700`}>
                <span className="font-medium">Reconciliation explanation</span>
                <textarea
                  value={reconciliation.explanation}
                  onChange={(event) =>
                    setReconciliation((current) => ({
                      ...current,
                      explanation: event.target.value,
                    }))
                  }
                  rows={embedded ? 2 : 6}
                  className={`rounded-xl border border-slate-300 bg-white px-3 ${embedded ? 'py-2 leading-5' : 'py-3 leading-6'}`}
                  placeholder="Explain why the selected geography, population, and trend intervals best represent the subject's market."
                />
              </label>

              <div className={`${embedded ? 'mt-2 gap-2' : 'mt-4 gap-3'} flex flex-wrap items-center`}>
                <button
                  type="button"
                  onClick={saveReconciliation}
                  disabled={!studyIsCurrent || savingNarrative}
                  className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {savingNarrative ? 'Saving...' : 'Save market reconciliation'}
                </button>
                <span className="text-xs text-slate-500">
                  Choosing a study here documents evidentiary weight only; it
                  does not filter comparable sales.
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
