import type { AssignmentDetailsPayload, GeoJsonPolygon } from './api';

export const NEIGHBORHOOD_LAND_USE_FIELDS = [
  ['neighborhood_land_use_one_unit_pct', 'One-Unit'],
  ['neighborhood_land_use_two_to_four_unit_pct', '2-4 Unit'],
  ['neighborhood_land_use_multifamily_pct', 'Multi-Family'],
  ['neighborhood_land_use_commercial_pct', 'Commercial'],
  ['neighborhood_land_use_other_vacant_pct', 'Other / Vacant Land'],
] as const;

export const NEIGHBORHOOD_RANGE_ROWS = [
  {
    label: 'House Price',
    low: 'neighborhood_house_price_low',
    high: 'neighborhood_house_price_high',
    predominant: 'neighborhood_house_price_predominant',
    format: 'money',
  },
  {
    label: 'Price per Sq. Ft.',
    low: 'neighborhood_ppsf_low',
    high: 'neighborhood_ppsf_high',
    predominant: 'neighborhood_ppsf_predominant',
    format: 'money',
  },
  {
    label: 'Age',
    low: 'neighborhood_age_low',
    high: 'neighborhood_age_high',
    predominant: 'neighborhood_age_predominant',
    format: 'number',
  },
  {
    label: 'GLA',
    low: 'neighborhood_gla_low',
    high: 'neighborhood_gla_high',
    predominant: 'neighborhood_gla_predominant',
    format: 'number',
  },
] as const;

export const NEIGHBORHOOD_CITY_AVERAGE_ROWS = [
  {
    label: 'House Price',
    field: 'neighborhood_city_average_sale_price',
    format: 'money',
  },
  {
    label: 'Price per Sq. Ft.',
    field: 'neighborhood_city_average_ppsf',
    format: 'money',
  },
  {
    label: 'Age',
    field: 'neighborhood_city_average_age',
    format: 'number',
  },
  {
    label: 'GLA',
    field: 'neighborhood_city_average_gla',
    format: 'number',
  },
] as const;

export function numericValue(value: unknown): number | null {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(/[$,%\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function neighborhoodLandUseTotal(details?: AssignmentDetailsPayload | null): number | null {
  const values = NEIGHBORHOOD_LAND_USE_FIELDS.map(([field]) => numericValue(details?.[field]));
  if (values.every((value) => value === null)) return null;
  return values.reduce<number>((sum, value) => sum + (value || 0), 0);
}

export function isNeighborhoodBoundary(value: unknown): value is GeoJsonPolygon {
  if (!value || typeof value !== 'object') return false;
  const polygon = value as GeoJsonPolygon;
  const ring = polygon.coordinates?.[0];
  if (polygon.type !== 'Polygon' || !Array.isArray(ring) || ring.length < 4) return false;
  const first = ring[0];
  const last = ring[ring.length - 1];
  return Boolean(
    Array.isArray(first) &&
    Array.isArray(last) &&
    Number(first[0]) === Number(last[0]) &&
    Number(first[1]) === Number(last[1]),
  );
}

export function neighborhoodBoundaryReadinessErrors(
  details?: AssignmentDetailsPayload | null,
): string[] {
  const errors: string[] = [];
  if (!isNeighborhoodBoundary(details?.neighborhood_boundary_geometry)) {
    errors.push('Draw and save an Appraiser-Defined Area in Market Conditions Analysis.');
  } else {
    const missingSides = [
      ['North', details?.neighborhood_boundary_north],
      ['East', details?.neighborhood_boundary_east],
      ['South', details?.neighborhood_boundary_south],
      ['West', details?.neighborhood_boundary_west],
    ].filter(([, value]) => !String(value || '').trim()).map(([label]) => label);
    if (missingSides.length) {
      errors.push(`Review and enter the ${missingSides.join(', ')} neighborhood ${missingSides.length === 1 ? 'boundary' : 'boundaries'}.`);
    }
    if (details?.neighborhood_boundary_confirmed !== true) {
      errors.push('Review and confirm the imported neighborhood boundary for this appraisal file.');
    }
  }
  return errors;
}

export function marketTrendFromChange(value: unknown): '' | 'increasing' | 'stable' | 'declining' {
  const change = numericValue(value);
  if (change === null) return '';
  if (change >= 1) return 'increasing';
  if (change <= -1) return 'declining';
  return 'stable';
}
