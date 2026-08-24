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
import {
  includeCustomMarketArea,
  marketAreaOriginFromSource,
  polygonsMatch,
  resolveInitialMarketAreaGeometry,
  shouldAdoptIncomingMarketArea,
  type MarketAreaOrigin,
} from '@/lib/marketAreaGeometry';

const MAPLIBRE_SCRIPT =
  'https://unpkg.com/maplibre-gl@5.12.0/dist/maplibre-gl.js';
const MAPLIBRE_STYLE =
  'https://unpkg.com/maplibre-gl@5.12.0/dist/maplibre-gl.css';
const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/bright';
const CUSTOM_BOUNDARY_SOURCE_ID = 'custom-market-boundary';

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
  addSource: (id: string, source: Record<string, unknown>) => void;
  getSource: (id: string) => MapSource | undefined;
  addLayer: (layer: Record<string, unknown>) => void;
  getLayer: (id: string) => unknown;
  getCanvas: () => { style: { cursor: string } };
  project: (coordinate: BoundaryCoordinate) => { x: number; y: number };
  fitBounds: (
    bounds: [BoundaryCoordinate, BoundaryCoordinate],
    options?: Record<string, unknown>,
  ) => void;
  resize: () => void;
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

declare global {
  interface Window {
    maplibregl?: MapLibreGlobal;
  }
}

type TrendInterval = 'monthly' | 'quarterly' | 'semiannual' | 'yearly';

type Props = {
  subjectAccountId: string;
  initialDraft?: MarketConditionsDraft | null;
  onCompletionChange?: (draft: MarketConditionsDraft | null) => void;
  initialCustomGeometry?: GeoJsonPolygon | null;
  initialCustomGeometrySource?: string | null;
  suggestedCustomGeometry?: GeoJsonPolygon | null;
  onCustomGeometryChange?: (
    geometry: GeoJsonPolygon | null,
    origin: MarketAreaOrigin,
  ) => void;
  embedded?: boolean;
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

function makeBoundaryFeatureCollection(
  customGeometry: GeoJsonPolygon | null,
  draftBoundary: BoundaryCoordinate[] = [],
): GeoJsonFeatureCollection {
  if (customGeometry) {
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: customGeometry,
          properties: { kind: 'completed' },
        },
      ],
    };
  }
  const boundary = normalizeOpenBoundary(draftBoundary);
  if (boundary.length === 0) {
    return { type: 'FeatureCollection', features: [] };
  }
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry:
          boundary.length === 1
            ? { type: 'Point', coordinates: boundary[0] }
            : { type: 'LineString', coordinates: boundary },
        properties: { kind: 'draft' },
      },
    ],
  };
}

function updateBoundaryMap(
  map: MapInstance | null,
  customGeometry: GeoJsonPolygon | null,
  draftBoundary: BoundaryCoordinate[] = [],
): void {
  map
    ?.getSource(CUSTOM_BOUNDARY_SOURCE_ID)
    ?.setData(makeBoundaryFeatureCollection(customGeometry, draftBoundary));
}

function fitMapToBoundary(
  map: MapInstance | null,
  geometry: GeoJsonPolygon | null,
): void {
  const ring = geometry?.coordinates?.[0] || [];
  if (!map || ring.length < 3) return;
  const longitudes = ring.map((coordinate) => Number(coordinate[0])).filter(Number.isFinite);
  const latitudes = ring.map((coordinate) => Number(coordinate[1])).filter(Number.isFinite);
  if (!longitudes.length || !latitudes.length) return;
  map.fitBounds(
    [
      [Math.min(...longitudes), Math.min(...latitudes)],
      [Math.max(...longitudes), Math.max(...latitudes)],
    ],
    { padding: 36, maxZoom: 14, duration: 0 },
  );
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
    label: 'Appraiser-defined area',
    description: 'The automated neighborhood polygon, editable by the appraiser.',
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
  await loadScript(MAPLIBRE_SCRIPT, 'maplibre', () =>
    Boolean(window.maplibregl),
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
          {recommendation.ranked_studies.slice(0, 3).map((study) => (
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
  initialDraft = null,
  onCompletionChange,
  initialCustomGeometry = null,
  initialCustomGeometrySource = null,
  suggestedCustomGeometry = null,
  onCustomGeometryChange,
  embedded = false,
}: Props) {
  const savedDraft = useMemo(
    () => initialDraft || readMarketConditionsDraft(subjectAccountId),
    [initialDraft, subjectAccountId],
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
  const savedStudyGeometry = savedDraft?.response.analyses.find(
    (analysis) => analysis.market.key === 'custom',
  )?.market.custom_geometry || null;
  const resolvedInitialGeometry = resolveInitialMarketAreaGeometry({
    assignmentGeometry: initialCustomGeometry,
    savedStudyGeometry,
    suggestedGeometry: suggestedCustomGeometry,
  });
  const resolvedInitialOrigin: MarketAreaOrigin = initialCustomGeometry
    ? marketAreaOriginFromSource(initialCustomGeometrySource, initialCustomGeometry)
    : savedStudyGeometry
      ? 'appraiser'
      : 'automatic';
  const [selectedAreaKeys, setSelectedAreaKeys] = useState<
    MarketConditionsAreaKey[]
  >(includeCustomMarketArea(
    savedDraft?.selectedAreaKeys || ['city', 'zip', 'radius_1'],
    resolvedInitialGeometry,
  ));
  const [asOfDate, setAsOfDate] = useState(
    savedDraft?.asOfDate || todayInputValue(),
  );
  const [periodMonths, setPeriodMonths] = useState<12 | 24 | 36>(
    savedDraft?.periodMonths || 24,
  );
  const [customGeometry, setCustomGeometry] = useState<GeoJsonPolygon | null>(
    resolvedInitialGeometry,
  );
  const [customGeometryOrigin, setCustomGeometryOrigin] = useState<MarketAreaOrigin>(
    resolvedInitialOrigin,
  );
  const [availableSuggestedGeometry, setAvailableSuggestedGeometry] =
    useState<GeoJsonPolygon | null>(
      suggestedCustomGeometry || resolvedInitialGeometry,
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
  const [studyResultsExpanded, setStudyResultsExpanded] = useState(false);
  const [geographyReviewExpanded, setGeographyReviewExpanded] = useState(
    !embedded,
  );
  const [loadingContext, setLoadingContext] = useState(!subject);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [savingNarrative, setSavingNarrative] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [isBoundaryDrawing, setIsBoundaryDrawing] = useState(false);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapInstance | null>(null);
  const draftBoundaryRef = useRef<BoundaryCoordinate[]>([]);
  const boundaryDrawingRef = useRef(false);
  const initialCustomGeometryRef = useRef(customGeometry);
  const onCustomGeometryChangeRef = useRef(onCustomGeometryChange);
  onCustomGeometryChangeRef.current = onCustomGeometryChange;
  const appraiserModifiedRef = useRef(
    resolvedInitialOrigin === 'appraiser' || resolvedInitialOrigin === 'cleared',
  );
  const geometryBeforeDrawingRef = useRef<{
    geometry: GeoJsonPolygon | null;
    origin: MarketAreaOrigin;
  } | null>(null);
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
  const studyLatitude = studyContext?.latitude ?? null;
  const studyLongitude = studyContext?.longitude ?? null;

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

  const setBoundaryDrawingMode = useCallback((active: boolean) => {
    boundaryDrawingRef.current = active;
    setIsBoundaryDrawing(active);
    const map = mapRef.current;
    if (map) {
      map.getCanvas().style.cursor = active ? 'crosshair' : '';
    }
  }, []);

  const beginCustomBoundary = useCallback(() => {
    const map = mapRef.current;
    if (!map) {
      setError('The drawing map is still loading. Please try again.');
      return;
    }
    geometryBeforeDrawingRef.current = {
      geometry: customGeometry,
      origin: customGeometryOrigin,
    };
    appraiserModifiedRef.current = true;
    setCustomGeometryOrigin('appraiser');
    resetDraftBoundary();
    updateBoundaryMap(map, null);
    initialCustomGeometryRef.current = null;
    setCustomGeometry(null);
    setBoundaryDrawingMode(true);
    setError(null);
    setNotice(
      'Boundary drawing started. Click around the area in order, then click the first point or use Close Area.',
    );
  }, [
    customGeometry,
    customGeometryOrigin,
    resetDraftBoundary,
    setBoundaryDrawingMode,
  ]);

  const completeCustomBoundary = useCallback(
    (method: 'button' | 'starting_point') => {
      const polygon = boundaryToPolygon(draftBoundaryRef.current);
      if (!polygon) {
        setError('Add at least three boundary points before closing the area.');
        return;
      }
      initialCustomGeometryRef.current = polygon;
      setCustomGeometry(polygon);
      setCustomGeometryOrigin('appraiser');
      appraiserModifiedRef.current = true;
      geometryBeforeDrawingRef.current = null;
      updateBoundaryMap(mapRef.current, polygon);
      fitMapToBoundary(mapRef.current, polygon);
      resetDraftBoundary();
      setBoundaryDrawingMode(false);
      setSelectedAreaKeys((current) => includeCustomMarketArea(current, polygon));
      onCustomGeometryChangeRef.current?.(polygon, 'appraiser');
      setError(null);
      setNotice(
        method === 'starting_point'
          ? 'Custom market area closed at the starting point.'
          : 'Custom market area closed and ready for analysis.',
      );
    },
    [resetDraftBoundary, setBoundaryDrawingMode],
  );

  const cancelCustomBoundary = useCallback(() => {
    const previous = geometryBeforeDrawingRef.current;
    const geometry = previous?.geometry || null;
    const origin = previous?.origin || 'cleared';
    setBoundaryDrawingMode(false);
    resetDraftBoundary();
    initialCustomGeometryRef.current = geometry;
    setCustomGeometry(geometry);
    setCustomGeometryOrigin(origin);
    appraiserModifiedRef.current = origin === 'appraiser' || origin === 'cleared';
    geometryBeforeDrawingRef.current = null;
    updateBoundaryMap(mapRef.current, geometry);
    fitMapToBoundary(mapRef.current, geometry);
    setError(null);
    setNotice('Boundary edit cancelled. The prior area was restored.');
  }, [resetDraftBoundary, setBoundaryDrawingMode]);

  const clearCustomBoundary = useCallback(() => {
    setBoundaryDrawingMode(false);
    resetDraftBoundary();
    updateBoundaryMap(mapRef.current, null);
    initialCustomGeometryRef.current = null;
    setCustomGeometry(null);
    setCustomGeometryOrigin('cleared');
    appraiserModifiedRef.current = true;
    geometryBeforeDrawingRef.current = null;
    if (customGeometry) {
      setAvailableSuggestedGeometry((current) => current || customGeometry);
    }
    onCustomGeometryChangeRef.current?.(null, 'cleared');
    setError(null);
    setNotice('Appraiser-defined market area cleared. It will not be regenerated automatically.');
  }, [customGeometry, resetDraftBoundary, setBoundaryDrawingMode]);

  const resetToSuggestedBoundary = useCallback(() => {
    if (!availableSuggestedGeometry) return;
    setBoundaryDrawingMode(false);
    resetDraftBoundary();
    initialCustomGeometryRef.current = availableSuggestedGeometry;
    setCustomGeometry(availableSuggestedGeometry);
    setCustomGeometryOrigin('automatic');
    appraiserModifiedRef.current = false;
    geometryBeforeDrawingRef.current = null;
    setSelectedAreaKeys((current) => includeCustomMarketArea(current, availableSuggestedGeometry));
    updateBoundaryMap(mapRef.current, availableSuggestedGeometry);
    fitMapToBoundary(mapRef.current, availableSuggestedGeometry);
    onCustomGeometryChangeRef.current?.(availableSuggestedGeometry, 'automatic');
    setError(null);
    setNotice('The automatically suggested neighborhood area was restored.');
  }, [
    availableSuggestedGeometry,
    resetDraftBoundary,
    setBoundaryDrawingMode,
  ]);
  useEffect(() => {
    initialCustomGeometryRef.current = customGeometry;
  }, [customGeometry]);

  useEffect(() => {
    if (!initialCustomGeometry) return;
    const incomingOrigin = marketAreaOriginFromSource(
      initialCustomGeometrySource,
      initialCustomGeometry,
    );
    if (!shouldAdoptIncomingMarketArea({
      currentGeometry: customGeometry,
      currentOrigin: customGeometryOrigin,
      incomingGeometry: initialCustomGeometry,
    })) return;
    initialCustomGeometryRef.current = initialCustomGeometry;
    setCustomGeometry(initialCustomGeometry);
    setAvailableSuggestedGeometry((current) => current || initialCustomGeometry);
    setCustomGeometryOrigin(incomingOrigin);
    appraiserModifiedRef.current = incomingOrigin === 'appraiser';
    setSelectedAreaKeys((current) => includeCustomMarketArea(current, initialCustomGeometry));
  }, [
    customGeometry,
    customGeometryOrigin,
    initialCustomGeometry,
    initialCustomGeometrySource,
  ]);
  useEffect(() => {
    if (!suggestedCustomGeometry || appraiserModifiedRef.current) return;
    if (!shouldAdoptIncomingMarketArea({
      currentGeometry: customGeometry,
      currentOrigin: customGeometryOrigin,
      incomingGeometry: suggestedCustomGeometry,
    })) return;
    initialCustomGeometryRef.current = suggestedCustomGeometry;
    setCustomGeometry(suggestedCustomGeometry);
    setCustomGeometryOrigin('automatic');
    setSelectedAreaKeys((current) => includeCustomMarketArea(current, suggestedCustomGeometry));
  }, [customGeometry, customGeometryOrigin, suggestedCustomGeometry]);

  useEffect(() => {
    if (suggestedCustomGeometry) {
      setAvailableSuggestedGeometry(suggestedCustomGeometry);
    }
  }, [suggestedCustomGeometry]);

  const completeCustomBoundaryRef = useRef(completeCustomBoundary);
  completeCustomBoundaryRef.current = completeCustomBoundary;

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
      studyLatitude === null ||
      studyLongitude === null ||
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
          studyLatitude === null ||
          studyLongitude === null
        ) {
          return;
        }
        map = new window.maplibregl.Map({
          container: mapContainerRef.current,
          style: MAP_STYLE_URL,
          center: [studyLongitude, studyLatitude],
          zoom: 12,
          attributionControl: true,
        });
        mapRef.current = map;
        map.on('load', () => {
          if (!map || cancelled || !window.maplibregl) return;
          new window.maplibregl.Marker({ color: '#dc2626' })
            .setLngLat([
              studyLongitude,
              studyLatitude,
            ])
            .addTo(map);
          map.addSource(CUSTOM_BOUNDARY_SOURCE_ID, {
            type: 'geojson',
            data: makeBoundaryFeatureCollection(
              initialCustomGeometryRef.current,
            ),
          });
          map.addLayer({
            id: 'custom-market-boundary-fill',
            type: 'fill',
            source: CUSTOM_BOUNDARY_SOURCE_ID,
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: {
              'fill-color': '#2563eb',
              'fill-opacity': 0.2,
            },
          });
          map.addLayer({
            id: 'custom-market-boundary-line',
            type: 'line',
            source: CUSTOM_BOUNDARY_SOURCE_ID,
            paint: {
              'line-color': '#0284c7',
              'line-width': 4,
            },
          });
          map.addLayer({
            id: 'custom-market-boundary-start',
            type: 'circle',
            source: CUSTOM_BOUNDARY_SOURCE_ID,
            filter: ['==', ['geometry-type'], 'Point'],
            paint: {
              'circle-color': '#0284c7',
              'circle-radius': 6,
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2,
            },
          });
          map.on('click', (event) => {
            if (!boundaryDrawingRef.current) return;
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
                  completeCustomBoundaryRef.current('starting_point');
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
              updateBoundaryMap(map, null, next);
            }
          });
          setMapReady(true);
          fitMapToBoundary(map, initialCustomGeometryRef.current);
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
      boundaryDrawingRef.current = false;
      setIsBoundaryDrawing(false);
      resetDraftBoundary();
      mapRef.current = null;
      map?.remove();
    };
  }, [
    customSelected,
    resetDraftBoundary,
    studyLatitude,
    studyLongitude,
  ]);

  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    if (!map) return;
    map.resize();
    updateBoundaryMap(map, customGeometry);
    fitMapToBoundary(map, customGeometry);
  }, [customGeometry, mapReady]);

  useEffect(() => {
    const container = mapContainerRef.current;
    const map = mapRef.current;
    if (!container || !map || !mapReady) return () => undefined;

    let animationFrame = 0;
    const synchronizeVisibleMap = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        if (!mapRef.current || container.offsetWidth === 0 || container.offsetHeight === 0) {
          return;
        }
        mapRef.current.resize();
        updateBoundaryMap(mapRef.current, initialCustomGeometryRef.current);
        fitMapToBoundary(mapRef.current, initialCustomGeometryRef.current);
      });
    };

    synchronizeVisibleMap();
    const observer = new ResizeObserver(synchronizeVisibleMap);
    observer.observe(container);
    window.addEventListener('resize', synchronizeVisibleMap);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
      window.removeEventListener('resize', synchronizeVisibleMap);
    };
  }, [mapReady]);

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
      setError('Generate, restore, or draw an appraiser-defined area before running that study.');
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
      if (onCompletionChange) onCompletionChange(draft);
      else saveMarketConditionsDraft(draft);
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
    if (onCompletionChange) onCompletionChange(draft);
    else saveMarketConditionsDraft(draft);
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
        <div className={embedded ? 'grid grid-cols-1 gap-1.5 lg:grid-cols-4' : 'grid grid-cols-1 gap-4 lg:grid-cols-[180px_180px_1fr]'}>
          <label className="grid gap-1 text-sm text-slate-700">
            <span className="font-medium">Analysis as of</span>
            <input
              type="date"
              value={asOfDate}
              onChange={(event) => setAsOfDate(event.target.value)}
              className={`rounded-lg border border-slate-300 px-3 ${embedded ? 'py-1.5' : 'py-2'}`}
            />
          </label>
          <label className="grid gap-1 text-sm text-slate-700">
            <span className="font-medium">Historical period</span>
            <select
              value={periodMonths}
              onChange={(event) =>
                setPeriodMonths(Number(event.target.value) as 12 | 24 | 36)
              }
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
          <div className={`rounded-xl border border-slate-200 bg-slate-50 text-slate-600 ${embedded ? 'px-3 py-2 text-xs lg:col-span-2' : 'px-4 py-3 text-sm'}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-slate-900">Study geography:</span>
              {contextOverrideEnabled && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
                  Flagged override
                </span>
              )}
            </div>
            <div className={embedded ? 'mt-0.5' : 'mt-1'}>
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

        <div className={`rounded-xl border border-amber-200 bg-amber-50/40 ${embedded ? 'p-2.5' : 'p-4'}`}>
          <div className={`flex flex-wrap items-start justify-between ${embedded ? 'gap-2' : 'gap-3'}`}>
            <div>
              <h3 className="font-semibold text-slate-950">
                Study geography and related CAD parcels
              </h3>
              <p className={`${embedded ? 'mt-0.5 text-xs' : 'mt-1 text-sm'} max-w-4xl text-slate-600`}>
                Verify same-address CAD parcels or supply a reviewable city,
                ZIP, and study center. This does not change or merge stored
                property records.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setGeographyReviewExpanded((current) => !current)}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
              >
                {geographyReviewExpanded ? 'Collapse review' : 'Review geography'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setGeographyReviewExpanded(true);
                  toggleContextOverride();
                }}
                className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-50"
              >
                {contextOverrideEnabled ? 'Disable override' : 'Edit study geography'}
              </button>
            </div>
          </div>

          {geographyReviewExpanded && (
            <>
          <div className={`${embedded ? 'mt-2 gap-2' : 'mt-4 gap-3'} grid md:grid-cols-[1fr_auto]`}>
            <label className="grid gap-1 text-sm text-slate-700">
              <span className="font-medium">Exact CAD situs address</span>
              <input
                type="text"
                value={parcelSearchAddress}
                onChange={(event) => setParcelSearchAddress(event.target.value)}
                placeholder="10010 Strait Ln"
                className={`rounded-lg border border-slate-300 bg-white px-3 ${embedded ? 'py-1.5' : 'py-2'}`}
              />
            </label>
            <button
              type="button"
              onClick={() => void checkRelatedParcels()}
              disabled={loadingRelatedParcels || loadingContext || !subject}
              className={`self-end rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 disabled:bg-slate-300 ${embedded ? 'py-2' : 'py-2.5'}`}
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
            </>
          )}
        </div>

        <fieldset className={`rounded-xl border border-slate-200 bg-slate-50 ${embedded ? 'p-2.5' : 'p-4'}`}>
          <div className={`flex flex-wrap items-center justify-between ${embedded ? 'gap-2' : 'gap-3'}`}>
            <legend className={`${embedded ? 'text-sm' : 'text-base'} font-semibold text-slate-900`}>
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

        {selectedAreaKeys.includes('custom') && (
          <div className="rounded-xl border border-indigo-200 bg-indigo-50/30 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold text-slate-950">
                  Appraiser-Defined Market Area
                </h3>
                <p className="mt-1 text-sm text-slate-600">
                  HomeNode loads the suggested neighborhood automatically. Redraw it only
                  when appraisal judgment requires a different study area; appraiser edits
                  remain authoritative until Reset to Suggested Area is selected.
                </p>
              </div>
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  customGeometry
                    ? 'bg-emerald-100 text-emerald-900'
                    : draftBoundaryPointCount > 0 || isBoundaryDrawing
                      ? 'bg-indigo-100 text-indigo-900'
                    : 'bg-amber-100 text-amber-900'
                }`}
              >
                {customGeometry
                  ? customGeometryOrigin === 'automatic'
                    ? 'Automatically suggested'
                    : 'Appraiser edited'
                  : draftBoundaryPointCount > 0
                    ? `${draftBoundaryPointCount} boundary points`
                    : isBoundaryDrawing
                      ? 'Drawing active'
                    : customGeometryOrigin === 'cleared'
                      ? 'Cleared by appraiser'
                      : 'Area required'}
              </span>
            </div>
            {studyContext &&
            studyContext.latitude !== null &&
            studyContext.longitude !== null ? (
              <div
                ref={mapContainerRef}
                className="mt-4 h-[340px] w-full overflow-hidden rounded-xl border border-slate-300 bg-slate-100"
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
                    {isBoundaryDrawing
                      ? 'Restart edit'
                      : customGeometry || draftBoundaryPointCount > 0
                        ? 'Edit / redraw area'
                        : 'Draw area'}
                  </button>
                  <button
                    type="button"
                    onClick={() => completeCustomBoundary('button')}
                    disabled={
                      !mapReady ||
                      !isBoundaryDrawing ||
                      Boolean(customGeometry) ||
                      draftBoundaryPointCount < 3
                    }
                    className="rounded-md bg-indigo-700 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    Close Area
                  </button>
                  {isBoundaryDrawing ? (
                    <button
                      type="button"
                      onClick={cancelCustomBoundary}
                      className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      Cancel edit
                    </button>
                  ) : null}
                  {availableSuggestedGeometry && (
                    customGeometryOrigin !== 'automatic' ||
                    !polygonsMatch(customGeometry, availableSuggestedGeometry)
                  ) ? (
                    <button
                      type="button"
                      onClick={resetToSuggestedBoundary}
                      className="rounded-md border border-blue-300 bg-white px-3 py-2 text-xs font-semibold text-blue-800 hover:bg-blue-50"
                    >
                      Reset to Suggested Area
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={clearCustomBoundary}
                    disabled={
                      !customGeometry &&
                      draftBoundaryPointCount === 0 &&
                      !isBoundaryDrawing
                    }
                    className="rounded-md border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
                  >
                    Clear appraiser-defined area
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
              </div>
            )}
          </div>
        )}

        <div className={`flex flex-wrap items-center ${embedded ? 'gap-2' : 'gap-3'}`}>
          <button
            type="button"
            onClick={() => void runAnalysis()}
            disabled={
              loadingAnalysis ||
              loadingContext ||
              !subject ||
              !selectedAreaKeys.length
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
