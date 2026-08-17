import type { GeoJsonPolygon, MarketConditionsAreaKey } from './api';

export type MarketAreaOrigin = 'automatic' | 'appraiser' | 'cleared';

export function polygonsMatch(
  left: GeoJsonPolygon | null | undefined,
  right: GeoJsonPolygon | null | undefined,
): boolean {
  if (!left || !right) return left === right;
  return JSON.stringify(left.coordinates) === JSON.stringify(right.coordinates);
}

export function marketAreaOriginFromSource(
  source: string | null | undefined,
  geometry: GeoJsonPolygon | null | undefined,
): MarketAreaOrigin {
  const normalized = String(source || '').trim().toLowerCase();
  if (!geometry && normalized.includes('cleared')) return 'cleared';
  if (
    normalized.includes('appraiser') ||
    normalized.includes('sales_comparison_market_conditions')
  ) {
    return 'appraiser';
  }
  return 'automatic';
}

export function resolveInitialMarketAreaGeometry({
  assignmentGeometry,
  savedStudyGeometry,
  suggestedGeometry,
}: {
  assignmentGeometry?: GeoJsonPolygon | null;
  savedStudyGeometry?: GeoJsonPolygon | null;
  suggestedGeometry?: GeoJsonPolygon | null;
}): GeoJsonPolygon | null {
  return assignmentGeometry || savedStudyGeometry || suggestedGeometry || null;
}

export function shouldAdoptIncomingMarketArea({
  currentGeometry,
  currentOrigin,
  incomingGeometry,
}: {
  currentGeometry?: GeoJsonPolygon | null;
  currentOrigin: MarketAreaOrigin;
  incomingGeometry?: GeoJsonPolygon | null;
}): boolean {
  if (!incomingGeometry || currentOrigin === 'cleared') return false;
  if (currentOrigin === 'appraiser' && currentGeometry) return false;
  return !polygonsMatch(currentGeometry, incomingGeometry);
}

export function includeCustomMarketArea(
  keys: MarketConditionsAreaKey[],
  geometry: GeoJsonPolygon | null | undefined,
): MarketConditionsAreaKey[] {
  if (!geometry || keys.includes('custom')) return keys;
  return [...keys, 'custom'];
}
