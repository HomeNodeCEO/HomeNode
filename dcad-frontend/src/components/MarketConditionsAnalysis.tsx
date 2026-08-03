import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '@/lib/api';
import type {
  GeoJsonPolygon,
  MarketContextOverride,
  MarketConditionsAnalysis,
  MarketConditionsAreaKey,
  MarketConditionsMapSale,
  MarketConditionsResponse,
  MarketConditionsSeriesPoint,
  MarketConditionsSubject,
  RelatedParcel,
  RelatedParcelsResponse,
} from '@/lib/api';
import {
  readMarketConditionsDraft,
  saveMarketConditionsDraft,
  type MarketConditionsDraft,
  type MarketConditionsReconciliation,
  type MarketTrendConclusion,
} from '@/lib/marketConditionsDraft';

const MAPLIBRE_SCRIPT =
  'https://unpkg.com/maplibre-gl@5.12.0/dist/maplibre-gl.js';
const MAPLIBRE_STYLE =
  'https://unpkg.com/maplibre-gl@5.12.0/dist/maplibre-gl.css';
const TERRADRAW_SCRIPT =
  'https://cdn.jsdelivr.net/npm/@watergis/maplibre-gl-terradraw@1.0.1/dist/maplibre-gl-terradraw.umd.js';
const TERRADRAW_STYLE =
  'https://cdn.jsdelivr.net/npm/@watergis/maplibre-gl-terradraw@1.0.1/dist/maplibre-gl-terradraw.css';
const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/bright';

type GeoJsonFeature = {
  type: 'Feature';
  id?: string | number;
  geometry: {
    type: string;
    coordinates: unknown;
  };
  properties: Record<string, unknown>;
};

type GeoJsonFeatureCollection = {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
};

type MapSource = {
  setData: (data: GeoJsonFeatureCollection) => void;
};

type BoundaryCoordinate = [number, number];

type MapClickEvent = {
  lngLat: { lng: number; lat: number };
  point: { x: number; y: number };
};

type MapInstance = {
  on: {
    (event: 'load', callback: () => void): void;
    (event: 'click', callback: (event: MapClickEvent) => void): void;
  };
  addControl: (control: unknown, position?: string) => void;
  addSource: (id: string, source: Record<string, unknown>) => void;
  getSource: (id: string) => MapSource | undefined;
  addLayer: (layer: Record<string, unknown>) => void;
  getLayer: (id: string) => unknown;
  project: (coordinate: BoundaryCoordinate) => { x: number; y: number };
  remove: () => void;
};

type MarkerInstance = {
  setLngLat: (coordinate: [number, number]) => MarkerInstance;
  addTo: (map: MapInstance) => MarkerInstance;
};

type MapLibreGlobal = {
  Map: new (options: Record<string, unknown>) => MapInstance;
  Marker: new (options?: Record<string, unknown>) => MarkerInstance;
};

type TerraDrawInstance = {
  on: (event: string, callback: () => void) => void;
  getSnapshot: () => GeoJsonFeature[];
  addFeatures?: (features: GeoJsonFeature[]) => Array<{
    id?: string | number;
    valid: boolean;
    reason?: string;
  }>;
  clear: () => void;
  getMode: () => string;
  setMode: (mode: string) => void;
};

type TerraDrawControlInstance = {
  getTerraDrawInstance: () => TerraDrawInstance;
};

type TerraDrawGlobal = {
  MaplibreTerradrawControl: new (
    options: Record<string, unknown>,
  ) => TerraDrawControlInstance;
};

declare global {
  interface Window {
    maplibregl?: MapLibreGlobal;
    MaplibreTerradrawControl?: TerraDrawGlobal;
  }
}

type TrendInterval = 'monthly' | 'quarterly' | 'semiannual' | 'yearly';

type Props = {
  subjectAccountId: string;
  onCompletionChange?: (draft: MarketConditionsDraft | null) => void;
};

const CLOSE_BOUNDARY_PIXEL_TOLERANCE = 18;

function coordinatesMatch(
  left: BoundaryCoordinate,
  right: BoundaryCoordinate,
): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function normalizeOpenBoundary(
  coordinates: BoundaryCoordinate[],
): BoundaryCoordinate[] {
  const normalized: BoundaryCoordinate[] = [];
  for (const coordinate of coordinates) {
    if (
      !Number.isFinite(coordinate[0]) ||
      !Number.isFinite(coordinate[1]) ||
      (normalized.length > 0 &&
        coordinatesMatch(normalized.at(-1) as BoundaryCoordinate, coordinate))
    ) {
      continue;
    }
    normalized.push([coordinate[0], coordinate[1]]);
  }
  if (
    normalized.length > 1 &&
    coordinatesMatch(
      normalized[0],
      normalized.at(-1) as BoundaryCoordinate,
    )
  ) {
    normalized.pop();
  }
  return normalized;
}

function boundaryToPolygon(
  coordinates: BoundaryCoordinate[],
): GeoJsonPolygon | null {
  const boundary = normalizeOpenBoundary(coordinates);
  if (boundary.length < 3) return null;
  return {
    type: 'Polygon',
    coordinates: [[...boundary, [...boundary[0]]]],
  };
}

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
    key: 'custom',
    label: 'Appraiser-drawn area',
    description: 'A custom polygon drawn and edited on the map.',
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

function addStyle(href: string, key: string): void {
  if (document.querySelector(`link[data-homenode-map-style="${key}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.homenodeMapStyle = key;
  document.head.appendChild(link);
}

function loadScript(
  src: string,
  key: string,
  ready: () => boolean,
): Promise<void> {
  if (ready()) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>(
    `script[data-homenode-map-script="${key}"]`,
  );
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener(
        'error',
        () => reject(new Error(`${key}_load_failed`)),
        { once: true },
      );
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.homenodeMapScript = key;
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener(
      'error',
      () => reject(new Error(`${key}_load_failed`)),
      { once: true },
    );
    document.head.appendChild(script);
  });
}

async function ensureMapLibraries(): Promise<void> {
  addStyle(MAPLIBRE_STYLE, 'maplibre');
  addStyle(TERRADRAW_STYLE, 'terradraw');
  await loadScript(MAPLIBRE_SCRIPT, 'maplibre', () =>
    Boolean(window.maplibregl),
  );
  await loadScript(TERRADRAW_SCRIPT, 'terradraw', () =>
    Boolean(window.MaplibreTerradrawControl),
  );
}

function resultFingerprint(
  areaKeys: MarketConditionsAreaKey[],
  asOfDate: string,
  periodMonths: number,
  customGeometry: GeoJsonPolygon | null,
  contextOverride: MarketContextOverride | null,
): string {
  return JSON.stringify({
    areaKeys: [...areaKeys].sort(),
    asOfDate,
    periodMonths,
    customGeometry,
    contextOverride,
  });
}

function makeSalesFeatureCollection(
  sales: MarketConditionsMapSale[],
): GeoJsonFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: sales.flatMap((sale) => {
      if (sale.latitude === null || sale.longitude === null) return [];
      return [
        {
          type: 'Feature' as const,
          id: String(sale.sale_id || sale.source_record_id || sale.account_id),
          geometry: {
            type: 'Point',
            coordinates: [sale.longitude, sale.latitude],
          },
          properties: {
            address: sale.address || 'Address unavailable',
            salePrice: sale.sale_price,
            closingDate: sale.closing_date,
          },
        },
      ];
    }),
  };
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
    .slice(0, 3)
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
  const plotHeight = 220;
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
        <div className="relative h-[220px]">
          <div className="absolute inset-0 flex items-end">
            {plottedPoints.map(({ point, value, height }) => (
              <div
                key={`${interval}:${point.period_start}`}
                className="relative h-full min-w-[74px] flex-1"
              >
                <div
                  className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-center text-[11px] font-semibold text-slate-700"
                  style={{ bottom: height + 8 }}
                >
                  {money(value)}
                </div>
                <div
                  className="absolute bottom-0 left-1/2 w-full max-w-[54px] -translate-x-1/2 rounded-t-md bg-gradient-to-t from-emerald-700 to-emerald-400"
                  style={{ height }}
                  title={`${periodLabel(point.period_start, interval)}: ${money(
                    value,
                  )} median from ${point.sale_count} sales`}
                />
              </div>
            ))}
          </div>

          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
            preserveAspectRatio="none"
            viewBox={`0 0 ${chartWidth} ${plotHeight}`}
          >
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
          </svg>

          {plottedPoints.map(({ point, height }, index) => (
            <div
              key={`${interval}:${point.period_start}`}
              className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 rounded-full border-2 border-white bg-slate-900 shadow-sm"
              style={{
                bottom: height - 6,
                left: `${((index + 0.5) / plottedPoints.length) * 100}%`,
              }}
            />
          ))}
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
          title="Weighted coefficient of dispersion. Living area is 60%; price/SF, sale price, age, and housing-type mix are 10% each. Lower is more congruent."
        >
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Composite COD
          </div>
          <div className="text-lg font-bold text-slate-900">
            {percentText(statistics.composite_cod)}
          </div>
        </div>
        <div
          title="Weighted coefficient of variation. Living area is 60%; price/SF, sale price, age, and housing-type mix are 10% each. Lower is more congruent."
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
        Congruency weights: living area 60%; price/SF, sale price, age, and
        housing type 10% each. Lower COD and CV indicate a more consistent
        study population.
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
}: {
  response: MarketConditionsResponse;
}) {
  const recommendation = response.recommendation;
  return (
    <div className="mt-4 rounded-xl border border-indigo-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
            Recommended determination
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-2">
            <span className="text-xl font-bold text-slate-950">
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
      <p className="mt-2 text-xs leading-5 text-slate-600">
        Studies are ranked by sample sufficiency, monthly coverage, composite
        COD/CV congruency, and characteristic coverage. A reconciled change
        within ±{numberText(recommendation.stable_threshold_percent, 1)}% is
        classified as stable. The appraiser may override this recommendation.
      </p>
      {recommendation.ranked_studies.length > 0 && (
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          {recommendation.ranked_studies.slice(0, 3).map((study) => (
            <div
              key={study.key}
              className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs"
            >
              <div className="font-semibold text-slate-900">
                #{study.rank} {study.label}
              </div>
              <div className="mt-1 text-slate-600">
                Score {numberText(study.reliability_score, 1)}/100 ·{' '}
                {study.sale_count.toLocaleString()} sales ·{' '}
                {signedPercentText(study.annualized_change_percent)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MarketConditionsAnalysis({
  subjectAccountId,
  onCompletionChange,
}: Props) {
  const savedDraft = useMemo(
    () => readMarketConditionsDraft(subjectAccountId),
    [subjectAccountId],
  );
  const [subject, setSubject] = useState<MarketConditionsSubject | null>(
    savedDraft?.response.subject || null,
  );
  const [contextOverrideEnabled, setContextOverrideEnabled] = useState(
    Boolean(savedDraft?.contextOverride),
  );
  const [contextOverride, setContextOverride] = useState<MarketContextOverride>(
    savedDraft?.contextOverride || {
      source: 'manual',
      address: null,
      city: null,
      county: null,
      postal_code: null,
      latitude: null,
      longitude: null,
      source_account_id: null,
      review_note: null,
    },
  );
  const [parcelSearchAddress, setParcelSearchAddress] = useState(
    savedDraft?.contextOverride?.address ||
      savedDraft?.response.subject.address ||
      '',
  );
  const [relatedParcels, setRelatedParcels] =
    useState<RelatedParcelsResponse | null>(null);
  const [loadingRelatedParcels, setLoadingRelatedParcels] = useState(false);
  const [selectedAreaKeys, setSelectedAreaKeys] = useState<
    MarketConditionsAreaKey[]
  >(savedDraft?.selectedAreaKeys || ['city', 'zip', 'radius_1']);
  const [asOfDate, setAsOfDate] = useState(
    savedDraft?.asOfDate || todayInputValue(),
  );
  const [periodMonths, setPeriodMonths] = useState<12 | 24 | 36>(
    savedDraft?.periodMonths || 24,
  );
  const [customGeometry, setCustomGeometry] = useState<GeoJsonPolygon | null>(
    savedDraft?.response.analyses.find(
      (analysis) => analysis.market.key === 'custom',
    )?.market.custom_geometry || null,
  );
  const [draftBoundaryPointCount, setDraftBoundaryPointCount] = useState(0);
  const [analysisResult, setAnalysisResult] =
    useState<MarketConditionsResponse | null>(savedDraft?.response || null);
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
          savedDraft.response.analyses.find(
            (analysis) => analysis.market.key === 'custom',
          )?.market.custom_geometry || null,
          savedDraft.contextOverride || null,
        )
      : '',
  );
  const [chartInterval, setChartInterval] =
    useState<TrendInterval>('monthly');
  const [loadingContext, setLoadingContext] = useState(!subject);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [savingNarrative, setSavingNarrative] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapInstance | null>(null);
  const drawRef = useRef<TerraDrawInstance | null>(null);
  const draftBoundaryRef = useRef<BoundaryCoordinate[]>([]);
  const initialCustomGeometryRef = useRef(customGeometry);
  const customSelected = selectedAreaKeys.includes('custom');

  const activeContextOverride = contextOverrideEnabled
    ? contextOverride
    : null;
  const studyContext = useMemo<MarketConditionsSubject | null>(() => {
    if (!subject || !activeContextOverride) return subject;
    const hasCoordinates =
      activeContextOverride.latitude !== null &&
      activeContextOverride.latitude !== undefined &&
      activeContextOverride.longitude !== null &&
      activeContextOverride.longitude !== undefined;
    return {
      ...subject,
      address: activeContextOverride.address?.trim() || subject.address,
      city: activeContextOverride.city?.trim() || subject.city,
      county: activeContextOverride.county?.trim() || subject.county,
      postal_code:
        activeContextOverride.postal_code?.trim() || subject.postal_code,
      latitude: hasCoordinates
        ? Number(activeContextOverride.latitude)
        : subject.latitude,
      longitude: hasCoordinates
        ? Number(activeContextOverride.longitude)
        : subject.longitude,
      location_status: hasCoordinates ? 'matched' : subject.location_status,
      location_source: hasCoordinates
        ? activeContextOverride.source === 'dcad_related_parcel'
          ? 'dcad_related_parcel_override'
          : 'manual_market_context'
        : subject.location_source,
      location_precision: hasCoordinates
        ? 'study_origin'
        : subject.location_precision,
      location_confidence: hasCoordinates
        ? 'medium'
        : subject.location_confidence,
      location_review_required: true,
      location_review_reason: 'market_context_override_active',
      context_override_active: true,
      context_override_source: activeContextOverride.source,
      context_overridden_fields: [],
      context_source_account_id:
        activeContextOverride.source_account_id || null,
      context_review_note: activeContextOverride.review_note || null,
    };
  }, [activeContextOverride, subject]);

  const currentSignature = useMemo(
    () =>
      resultFingerprint(
        selectedAreaKeys,
        asOfDate,
        periodMonths,
        customGeometry,
        activeContextOverride,
      ),
    [
      activeContextOverride,
      asOfDate,
      customGeometry,
      periodMonths,
      selectedAreaKeys,
    ],
  );
  const studyIsCurrent =
    Boolean(analysisResult?.analyses.length) &&
    runSignature === currentSignature;

  const resetDraftBoundary = useCallback(() => {
    draftBoundaryRef.current = [];
    setDraftBoundaryPointCount(0);
  }, []);

  const setDrawingToolbarMode = useCallback((mode: string | null) => {
    const container = mapContainerRef.current;
    container
      ?.querySelectorAll<HTMLButtonElement>(
        '.maplibregl-terradraw-add-control.active',
      )
      .forEach((button) => button.classList.remove('active'));
    if (mode) {
      container
        ?.querySelector<HTMLButtonElement>(
          `.maplibregl-terradraw-add-${mode}-button`,
        )
        ?.classList.add('active');
    }
  }, []);

  const beginCustomBoundary = useCallback(() => {
    const draw = drawRef.current;
    if (!draw) return;
    draw.setMode('default');
    draw.clear();
    resetDraftBoundary();
    initialCustomGeometryRef.current = null;
    setCustomGeometry(null);
    setError(null);
    setNotice(
      'Boundary drawing started. Click around the area in order, then click the first point or use Close Area.',
    );
    draw.setMode('linestring');
    setDrawingToolbarMode('linestring');
  }, [resetDraftBoundary, setDrawingToolbarMode]);

  const completeCustomBoundary = useCallback(
    (method: 'button' | 'starting_point') => {
      const draw = drawRef.current;
      if (!draw) return;
      const snapshot = draw.getSnapshot();
      const lineFeature = snapshot.find(
        (feature) => feature.geometry.type === 'LineString',
      );
      const lineCoordinates = lineFeature?.geometry.coordinates as
        | BoundaryCoordinate[]
        | undefined;
      const boundaryCoordinates =
        method === 'starting_point' &&
        lineCoordinates &&
        lineCoordinates.length > draftBoundaryRef.current.length
          ? lineCoordinates.slice(0, draftBoundaryRef.current.length)
          : lineCoordinates;
      const polygon = boundaryToPolygon(
        boundaryCoordinates || draftBoundaryRef.current,
      );
      if (!polygon) {
        setError('Add at least three boundary points before closing the area.');
        return;
      }
      draw.setMode('default');
      const addResults = draw.addFeatures?.([
        {
          type: 'Feature',
          geometry: polygon,
          properties: { mode: 'polygon' },
        },
      ]);
      const invalidResult = addResults?.find((result) => !result.valid);
      if (!addResults?.length || invalidResult) {
        setError(
          invalidResult?.reason ||
            'The completed boundary could not be drawn. Please start a new boundary and try again.',
        );
        return;
      }
      initialCustomGeometryRef.current = polygon;
      setCustomGeometry(polygon);
      resetDraftBoundary();
      setDrawingToolbarMode(null);
      setError(null);
      setNotice(
        method === 'starting_point'
          ? 'Custom market area closed at the starting point.'
          : 'Custom market area closed and ready for analysis.',
      );
    },
    [resetDraftBoundary, setDrawingToolbarMode],
  );

  const clearCustomBoundary = useCallback(() => {
    const draw = drawRef.current;
    if (draw) {
      draw.setMode('default');
      draw.clear();
    }
    resetDraftBoundary();
    setDrawingToolbarMode(null);
    initialCustomGeometryRef.current = null;
    setCustomGeometry(null);
  }, [resetDraftBoundary, setDrawingToolbarMode]);

  useEffect(() => {
    initialCustomGeometryRef.current = customGeometry;
  }, [customGeometry]);

  useEffect(() => {
    let cancelled = false;
    if (!subjectAccountId) return () => undefined;
    setLoadingContext(true);
    void api
      .getMarketConditionsContext(subjectAccountId)
      .then((response) => {
        if (!cancelled) {
          setSubject(response.subject);
          setParcelSearchAddress((current) =>
            current || response.subject.address || '',
          );
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
  }, [subjectAccountId]);

  useEffect(() => {
    if (studyIsCurrent && analysisResult) {
      const draft: MarketConditionsDraft = {
        version: 3,
        accountId: subjectAccountId,
        savedAt: new Date().toISOString(),
        asOfDate,
        periodMonths,
        selectedAreaKeys,
        contextOverride: activeContextOverride,
        response: analysisResult,
        reconciliation,
      };
      onCompletionChange?.(draft);
    } else {
      onCompletionChange?.(null);
    }
  }, [
    analysisResult,
    activeContextOverride,
    asOfDate,
    onCompletionChange,
    periodMonths,
    reconciliation,
    selectedAreaKeys,
    studyIsCurrent,
    subjectAccountId,
  ]);

  useEffect(() => {
    if (
      !customSelected ||
      !mapContainerRef.current ||
      !studyContext ||
      studyContext.latitude === null ||
      studyContext.longitude === null ||
      mapRef.current
    ) {
      return () => undefined;
    }
    let cancelled = false;
    let map: MapInstance | null = null;
    void ensureMapLibraries()
      .then(() => {
        if (
          cancelled ||
          !mapContainerRef.current ||
          !window.maplibregl ||
          !window.MaplibreTerradrawControl ||
          studyContext.latitude === null ||
          studyContext.longitude === null
        ) {
          return;
        }
        map = new window.maplibregl.Map({
          container: mapContainerRef.current,
          style: MAP_STYLE_URL,
          center: [studyContext.longitude, studyContext.latitude],
          zoom: 12,
          attributionControl: true,
        });
        mapRef.current = map;
        map.on('load', () => {
          if (!map || cancelled || !window.maplibregl) return;
          new window.maplibregl.Marker({ color: '#dc2626' })
            .setLngLat([
              studyContext.longitude as number,
              studyContext.latitude as number,
            ])
            .addTo(map);
          const terraDrawGlobal = window.MaplibreTerradrawControl;
          if (!terraDrawGlobal) return;
          const control =
            new terraDrawGlobal.MaplibreTerradrawControl({
              modes: [
                'linestring',
                'polygon',
                'select',
                'delete-selection',
                'delete',
              ],
              open: true,
            });
          map.addControl(control, 'top-left');
          const polygonButton = mapContainerRef.current?.querySelector<HTMLElement>(
            '.maplibregl-terradraw-add-polygon-button',
          );
          if (polygonButton) {
            polygonButton.style.display = 'none';
            polygonButton.setAttribute('aria-hidden', 'true');
          }
          const lineButton = mapContainerRef.current?.querySelector<HTMLElement>(
            '.maplibregl-terradraw-add-linestring-button',
          );
          if (lineButton) {
            lineButton.style.display = 'none';
            lineButton.setAttribute('aria-hidden', 'true');
          }
          const draw = control.getTerraDrawInstance();
          drawRef.current = draw;
          draw.on('change', () => {
            const polygon = draw
              .getSnapshot()
              .filter((feature) => feature.geometry.type === 'Polygon')
              .at(-1);
            if (!polygon || !Array.isArray(polygon.geometry.coordinates)) {
              setCustomGeometry(null);
              return;
            }
            const nextGeometry: GeoJsonPolygon = {
              type: 'Polygon',
              coordinates: polygon.geometry.coordinates as number[][][],
            };
            initialCustomGeometryRef.current = nextGeometry;
            resetDraftBoundary();
            setCustomGeometry(nextGeometry);
          });
          map.on('click', (event) => {
            if (draw.getMode() !== 'linestring') return;
            const coordinate: BoundaryCoordinate = [
              event.lngLat.lng,
              event.lngLat.lat,
            ];
            const current = draftBoundaryRef.current;
            if (current.length >= 3) {
              const startPoint = map?.project(current[0]);
              if (startPoint) {
                const pixelDistance = Math.hypot(
                  event.point.x - startPoint.x,
                  event.point.y - startPoint.y,
                );
                if (pixelDistance <= CLOSE_BOUNDARY_PIXEL_TOLERANCE) {
                  completeCustomBoundary('starting_point');
                  return;
                }
              }
            }
            if (
              current.length === 0 ||
              !coordinatesMatch(
                current.at(-1) as BoundaryCoordinate,
                coordinate,
              )
            ) {
              const next = [...current, coordinate];
              draftBoundaryRef.current = next;
              setDraftBoundaryPointCount(next.length);
            }
          });
          if (initialCustomGeometryRef.current && draw.addFeatures) {
            draw.addFeatures([
              {
                type: 'Feature',
                geometry: initialCustomGeometryRef.current,
                properties: { mode: 'polygon' },
              },
            ]);
          }
          setMapReady(true);
        });
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setMapError(
            loadError instanceof Error
              ? loadError.message
              : 'The drawing map could not be loaded.',
          );
        }
      });
    return () => {
      cancelled = true;
      setMapReady(false);
      resetDraftBoundary();
      drawRef.current = null;
      mapRef.current = null;
      map?.remove();
    };
  }, [
    completeCustomBoundary,
    customSelected,
    resetDraftBoundary,
    studyContext,
  ]);

  const customMapSales = useMemo(
    () =>
      analysisResult?.analyses.find(
        (analysis) => analysis.market.key === 'custom',
      )?.map_sales || [],
    [analysisResult],
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const data = makeSalesFeatureCollection(customMapSales);
    const existing = map.getSource('market-sales');
    if (existing) {
      existing.setData(data);
      return;
    }
    map.addSource('market-sales', {
      type: 'geojson',
      data,
      cluster: true,
      clusterMaxZoom: 14,
      clusterRadius: 42,
    });
    map.addLayer({
      id: 'market-sales-clusters',
      type: 'circle',
      source: 'market-sales',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': '#047857',
        'circle-radius': [
          'step',
          ['get', 'point_count'],
          15,
          30,
          20,
          100,
          26,
        ],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    });
    map.addLayer({
      id: 'market-sales-points',
      type: 'circle',
      source: 'market-sales',
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': '#10b981',
        'circle-radius': 5,
        'circle-stroke-color': '#064e3b',
        'circle-stroke-width': 1,
      },
    });
  }, [customMapSales, mapReady]);

  function toggleArea(key: MarketConditionsAreaKey): void {
    setSelectedAreaKeys((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key],
    );
    setNotice(null);
  }

  function toggleContextOverride(): void {
    setContextOverrideEnabled((current) => {
      if (!current && subject) {
        setContextOverride((existing) => ({
          source: existing.source || 'manual',
          address: existing.address || subject.address,
          city: existing.city || subject.city,
          county: existing.county || subject.county,
          postal_code: existing.postal_code || subject.postal_code,
          latitude: existing.latitude ?? subject.latitude,
          longitude: existing.longitude ?? subject.longitude,
          source_account_id: existing.source_account_id || null,
          review_note: existing.review_note || null,
        }));
      }
      return !current;
    });
    setNotice(null);
  }

  async function checkRelatedParcels(): Promise<void> {
    if (!parcelSearchAddress.trim()) {
      setError('Enter a complete numbered situs address for the CAD parcel check.');
      return;
    }
    setLoadingRelatedParcels(true);
    setError(null);
    setNotice(null);
    try {
      const response = await api.getRelatedParcels(
        subjectAccountId,
        parcelSearchAddress,
      );
      setRelatedParcels(response);
      setNotice(
        response.parcels.length > 1
          ? `${response.parcels.length} same-address CAD parcels were found. Review them separately; no parcels were merged.`
          : `${response.parcels.length} same-address CAD parcel was found.`,
      );
    } catch (lookupError: unknown) {
      setError(
        lookupError instanceof Error
          ? lookupError.message
          : 'The related CAD parcel check could not be completed.',
      );
    } finally {
      setLoadingRelatedParcels(false);
    }
  }

  function selectParcelAsStudyContext(parcel: RelatedParcel): void {
    setContextOverrideEnabled(true);
    setContextOverride({
      source: 'dcad_related_parcel',
      address: parcel.site_address || parcel.address,
      city: parcel.city || subject?.city || null,
      county: parcel.county || subject?.county || null,
      postal_code: parcel.postal_code || subject?.postal_code || null,
      latitude: parcel.latitude,
      longitude: parcel.longitude,
      source_account_id: parcel.account_id,
      review_note:
        'Appraiser selected a same-address official CAD parcel as the market-study context.',
    });
    setNotice(
      `Parcel ${parcel.account_id} is now the flagged study context. The subject account and CAD records were not changed.`,
    );
  }

  async function runAnalysis(): Promise<void> {
    if (!selectedAreaKeys.length) {
      setError('Select at least one market area before running the study.');
      return;
    }
    if (selectedAreaKeys.includes('custom') && !customGeometry) {
      setError('Draw and complete a custom polygon before running that study.');
      return;
    }
    setLoadingAnalysis(true);
    setError(null);
    setNotice(null);
    try {
      const response = await api.runMarketConditionsAnalysis({
        subjectAccountId,
        areaKeys: selectedAreaKeys,
        asOf: asOfDate,
        periodMonths,
        customGeometry,
        contextOverride: activeContextOverride,
      });
      const nextReconciliation = defaultReconciliation(response);
      const signature = resultFingerprint(
        selectedAreaKeys,
        asOfDate,
        periodMonths,
        customGeometry,
        activeContextOverride,
      );
      const draft: MarketConditionsDraft = {
        version: 3,
        accountId: subjectAccountId,
        savedAt: new Date().toISOString(),
        asOfDate,
        periodMonths,
        selectedAreaKeys,
        contextOverride: activeContextOverride,
        response,
        reconciliation: nextReconciliation,
      };
      setAnalysisResult(response);
      setReconciliation(nextReconciliation);
      setRunSignature(signature);
      saveMarketConditionsDraft(draft);
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
      savedAt: new Date().toISOString(),
      asOfDate,
      periodMonths,
      selectedAreaKeys,
      contextOverride: activeContextOverride,
      response: analysisResult,
      reconciliation,
    };
    saveMarketConditionsDraft(draft);
    onCompletionChange?.(draft);
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
    <section className="mb-4 rounded-2xl border border-emerald-200 bg-white shadow-sm">
      <div className="border-b border-emerald-100 bg-emerald-50/60 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
              Required before comparable selection
            </div>
            <h2 className="mt-1 text-xl font-semibold text-slate-950">
              Market Conditions Analysis
            </h2>
            <p className="mt-1 max-w-4xl text-sm text-slate-600">
              Compare multiple independent geographies, review time-based market
              evidence, and reconcile the market trend. These studies do not
              filter or change the comparable-sales inventory.
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

      <div className="space-y-5 p-5">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[180px_180px_1fr]">
          <label className="grid gap-1 text-sm text-slate-700">
            <span className="font-medium">Analysis as of</span>
            <input
              type="date"
              value={asOfDate}
              onChange={(event) => setAsOfDate(event.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
          <label className="grid gap-1 text-sm text-slate-700">
            <span className="font-medium">Historical period</span>
            <select
              value={periodMonths}
              onChange={(event) =>
                setPeriodMonths(Number(event.target.value) as 12 | 24 | 36)
              }
              className="rounded-lg border border-slate-300 bg-white px-3 py-2"
            >
              <option value={12}>12 months</option>
              <option value={24}>24 months</option>
              <option value={36}>36 months</option>
            </select>
            <span className="text-xs text-slate-500">
              Uses complete calendar months ending with the latest fully
              completed month.
            </span>
          </label>
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-slate-900">Study geography:</span>
              {contextOverrideEnabled && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
                  Flagged override
                </span>
              )}
            </div>
            <div className="mt-1">
            {loadingContext
              ? 'Loading parcel location...'
              : studyContext
                ? `${studyContext.address || studyContext.account_id} · ${
                    studyContext.city || 'City unavailable'
                  } · ${studyContext.postal_code || 'ZIP unavailable'}`
                : 'Unavailable'}
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold text-slate-950">
                Study geography and related CAD parcels
              </h3>
              <p className="mt-1 max-w-4xl text-sm text-slate-600">
                Verify same-address CAD parcels or supply a reviewable city,
                ZIP, and study center. This does not change or merge stored
                property records.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={toggleContextOverride}
                className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-50"
              >
                {contextOverrideEnabled ? 'Disable override' : 'Edit study geography'}
              </button>
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto]">
            <label className="grid gap-1 text-sm text-slate-700">
              <span className="font-medium">Exact CAD situs address</span>
              <input
                type="text"
                value={parcelSearchAddress}
                onChange={(event) => setParcelSearchAddress(event.target.value)}
                placeholder="10010 Strait Ln"
                className="rounded-lg border border-slate-300 bg-white px-3 py-2"
              />
            </label>
            <button
              type="button"
              onClick={() => void checkRelatedParcels()}
              disabled={loadingRelatedParcels || loadingContext || !subject}
              className="self-end rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:bg-slate-300"
            >
              {loadingRelatedParcels ? 'Checking CAD...' : 'Check related CAD parcels'}
            </button>
          </div>

          {relatedParcels && (
            <div className="mt-4 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                <span>
                  {relatedParcels.parcels.length} exact same-address parcel
                  {relatedParcels.parcels.length === 1 ? '' : 's'} found
                </span>
                <span>
                  Live DCAD: {relatedParcels.live_query_status.replace(/_/g, ' ')} · No automatic merge
                </span>
              </div>
              {relatedParcels.parcels.map((parcel) => (
                <div
                  key={parcel.account_id}
                  className="grid gap-3 rounded-lg border border-amber-200 bg-white p-3 md:grid-cols-[1fr_auto]"
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-950">
                        {parcel.account_id}
                      </span>
                      {parcel.is_subject && (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-900">
                          Current subject parcel
                        </span>
                      )}
                      {!parcel.in_database && (
                        <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-800">
                          Not yet in database
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-sm text-slate-700">
                      {parcel.site_address || parcel.address || 'Address unavailable'}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {parcel.legal_description || parcel.property_description || 'Legal description unavailable'}
                      {' · '}
                      {parcel.living_area_sqft
                        ? `${parcel.living_area_sqft.toLocaleString()} SF`
                        : 'No residential area'}
                      {' · '}
                      {parcel.total_value !== null
                        ? money(parcel.total_value)
                        : 'CAD value unavailable'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => selectParcelAsStudyContext(parcel)}
                    disabled={parcel.latitude === null || parcel.longitude === null}
                    className="self-center rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-900 hover:bg-emerald-100 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
                  >
                    Use as study center
                  </button>
                </div>
              ))}
            </div>
          )}

          {contextOverrideEnabled && (
            <div className="mt-4 rounded-lg border border-amber-300 bg-white p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold text-slate-950">
                  Reviewable market-context override
                </div>
                <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900">
                  Saved with appraisal workfile
                </span>
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <label className="grid gap-1 text-sm text-slate-700 md:col-span-2">
                  <span className="font-medium">Study-center address</span>
                  <input
                    type="text"
                    value={contextOverride.address || ''}
                    onChange={(event) =>
                      setContextOverride((current) => ({
                        ...current,
                        source: 'manual',
                        address: event.target.value,
                      }))
                    }
                    className="rounded-lg border border-slate-300 px-3 py-2"
                  />
                </label>
                <label className="grid gap-1 text-sm text-slate-700">
                  <span className="font-medium">City</span>
                  <input
                    type="text"
                    value={contextOverride.city || ''}
                    onChange={(event) =>
                      setContextOverride((current) => ({
                        ...current,
                        source: 'manual',
                        city: event.target.value,
                      }))
                    }
                    className="rounded-lg border border-slate-300 px-3 py-2"
                  />
                </label>
                <label className="grid gap-1 text-sm text-slate-700">
                  <span className="font-medium">ZIP code</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={10}
                    value={contextOverride.postal_code || ''}
                    onChange={(event) =>
                      setContextOverride((current) => ({
                        ...current,
                        source: 'manual',
                        postal_code: event.target.value,
                      }))
                    }
                    className="rounded-lg border border-slate-300 px-3 py-2"
                  />
                </label>
                <label className="grid gap-1 text-sm text-slate-700">
                  <span className="font-medium">Latitude</span>
                  <input
                    type="number"
                    step="any"
                    value={contextOverride.latitude ?? ''}
                    onChange={(event) =>
                      setContextOverride((current) => ({
                        ...current,
                        source: 'manual',
                        latitude: event.target.value ? Number(event.target.value) : null,
                      }))
                    }
                    className="rounded-lg border border-slate-300 px-3 py-2"
                  />
                </label>
                <label className="grid gap-1 text-sm text-slate-700">
                  <span className="font-medium">Longitude</span>
                  <input
                    type="number"
                    step="any"
                    value={contextOverride.longitude ?? ''}
                    onChange={(event) =>
                      setContextOverride((current) => ({
                        ...current,
                        source: 'manual',
                        longitude: event.target.value ? Number(event.target.value) : null,
                      }))
                    }
                    className="rounded-lg border border-slate-300 px-3 py-2"
                  />
                </label>
                <label className="grid gap-1 text-sm text-slate-700 md:col-span-2">
                  <span className="font-medium">Override/review note</span>
                  <input
                    type="text"
                    value={contextOverride.review_note || ''}
                    onChange={(event) =>
                      setContextOverride((current) => ({
                        ...current,
                        review_note: event.target.value,
                      }))
                    }
                    placeholder="Explain why this geography is being used."
                    className="rounded-lg border border-slate-300 px-3 py-2"
                  />
                </label>
              </div>
              <p className="mt-3 text-xs text-amber-900">
                City controls the city study, ZIP controls the ZIP study, and
                the coordinates control every radius and custom-map center.
                Override use remains visibly flagged.
              </p>
            </div>
          )}
        </div>

        <fieldset className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <legend className="text-base font-semibold text-slate-900">
              Select one or more independent study areas
            </legend>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() =>
                  setSelectedAreaKeys(AREA_OPTIONS.map((option) => option.key))
                }
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => setSelectedAreaKeys([])}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
              >
                Clear
              </button>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {AREA_OPTIONS.map((option) => {
              const selected = selectedAreaKeys.includes(option.key);
              return (
                <label
                  key={option.key}
                  className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${
                    selected
                      ? 'border-emerald-500 bg-emerald-50 ring-1 ring-emerald-200'
                      : 'border-slate-200 bg-white hover:border-slate-400'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleArea(option.key)}
                    className="mt-1 h-4 w-4 rounded border-slate-300 text-emerald-700 focus:ring-emerald-500"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-slate-900">
                      {option.label}
                    </span>
                    <span className="mt-1 block text-xs text-slate-500">
                      {option.description}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {selectedAreaKeys.includes('custom') && (
          <div className="rounded-xl border border-indigo-200 bg-indigo-50/30 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold text-slate-950">
                  Draw the appraiser-defined market area
                </h3>
                <p className="mt-1 text-sm text-slate-600">
                  Start the boundary and click around the neighborhood in
                  order. Only the open boundary line is shown while drawing.
                  Click near the first point or use Close Area when finished.
                </p>
              </div>
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  customGeometry
                    ? 'bg-emerald-100 text-emerald-900'
                    : draftBoundaryPointCount > 0
                      ? 'bg-indigo-100 text-indigo-900'
                    : 'bg-amber-100 text-amber-900'
                }`}
              >
                {customGeometry
                  ? 'Area ready'
                  : draftBoundaryPointCount > 0
                    ? `${draftBoundaryPointCount} boundary points`
                    : 'Area required'}
              </span>
            </div>
            {studyContext &&
            studyContext.latitude !== null &&
            studyContext.longitude !== null ? (
              <div
                ref={mapContainerRef}
                className="mt-4 h-[440px] w-full overflow-hidden rounded-xl border border-slate-300 bg-slate-100"
                aria-label="Custom market area drawing map"
              />
            ) : (
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-900">
                The study-center location is unavailable. Select a related CAD
                parcel or enter verified coordinates to draw a custom area.
              </div>
            )}
            {mapError && (
              <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {mapError}
              </div>
            )}
            {studyContext &&
              studyContext.latitude !== null &&
              studyContext.longitude !== null && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={beginCustomBoundary}
                    disabled={!mapReady}
                    className="rounded-md border border-indigo-300 bg-white px-3 py-2 text-xs font-semibold text-indigo-800 hover:bg-indigo-50 disabled:border-slate-200 disabled:text-slate-400"
                  >
                    {customGeometry || draftBoundaryPointCount > 0
                      ? 'Start new boundary'
                      : 'Start boundary'}
                  </button>
                  <button
                    type="button"
                    onClick={() => completeCustomBoundary('button')}
                    disabled={
                      !mapReady ||
                      Boolean(customGeometry) ||
                      draftBoundaryPointCount < 3
                    }
                    className="rounded-md bg-indigo-700 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    Close Area
                  </button>
                  {!customGeometry && draftBoundaryPointCount > 0 && (
                    <span className="text-xs text-slate-600">
                      {draftBoundaryPointCount < 3
                        ? `Add ${3 - draftBoundaryPointCount} more point${
                            3 - draftBoundaryPointCount === 1 ? '' : 's'
                          } before closing.`
                        : 'Ready to close. Click the first point or use the button.'}
                    </span>
                  )}
                </div>
              )}
            {customGeometry && (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <span className="text-sm font-medium text-emerald-800">
                  {Math.max(
                    (customGeometry.coordinates[0]?.length || 1) - 1,
                    0,
                  )}{' '}
                  boundary points
                  recorded.
                </span>
                <button
                  type="button"
                  onClick={clearCustomBoundary}
                  className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50"
                >
                  Clear custom area
                </button>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void runAnalysis()}
            disabled={
              loadingAnalysis ||
              loadingContext ||
              !subject ||
              !selectedAreaKeys.length
            }
            className="rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-300"
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
            The area, date, period, or polygon changed after the last calculation.
            Rerun the market studies before selecting comparables.
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
          <div className="space-y-6 border-t border-slate-200 pt-5">
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

            <div className="rounded-2xl border border-indigo-200 bg-indigo-50/40 p-5">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
                  Appraiser reconciliation
                </div>
                <h3 className="mt-1 text-lg font-semibold text-slate-950">
                  Market trend conclusion and evidence weighting
                </h3>
                <p className="mt-1 text-sm text-slate-600">
                  Explain why particular study populations and time intervals
                  are most relevant. This narrative will be carried into the
                  appraisal report.
                </p>
              </div>

              <RecommendedDetermination response={analysisResult} />

              <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
                <label className="grid gap-1 text-sm text-slate-700">
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

                <fieldset>
                  <legend className="text-sm font-medium text-slate-700">
                    Studies given greatest weight
                  </legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {analysisResult.analyses.map((analysis) => {
                      const selected =
                        reconciliation.reliedUponAreaKeys.includes(
                          analysis.market.key,
                        );
                      return (
                        <label
                          key={analysis.market.key}
                          className={`inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold ${
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

              <label className="mt-4 grid gap-1 text-sm text-slate-700">
                <span className="font-medium">Reconciliation explanation</span>
                <textarea
                  value={reconciliation.explanation}
                  onChange={(event) =>
                    setReconciliation((current) => ({
                      ...current,
                      explanation: event.target.value,
                    }))
                  }
                  rows={6}
                  className="rounded-xl border border-slate-300 bg-white px-3 py-3 leading-6"
                  placeholder="Explain why the selected geography, population, and trend intervals best represent the subject's market."
                />
              </label>

              <div className="mt-4 flex flex-wrap items-center gap-3">
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
