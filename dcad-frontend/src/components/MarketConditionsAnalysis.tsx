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
                {…14853 tokens truncated…ton"
                      onClick={cancelCustomBoundary}
                      className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      Cancel edit
                    </button>
                  ) : null}
                  {suggestedCustomGeometry && (
                    customGeometryOrigin !== 'automatic' ||
                    !polygonsMatch(customGeometry, suggestedCustomGeometry)
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
