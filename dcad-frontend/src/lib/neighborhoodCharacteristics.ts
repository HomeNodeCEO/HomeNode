import type { AssignmentDetailsPayload, GeoJsonPolygon } from './api';

export const DEFAULT_NEIGHBORHOOD_BOUNDARY_NARRATIVE =
  'These neighborhood boundaries are intentionally broad to show the immediate competing area. Areas outside of this may not be significantly different to the extent that comparable sales are not present in these areas. The purpose of defining the neighborhood is to show competing areas close to the subject but this does not mean properties in areas outside of this defined boundary were completely irrelevant to the analysis. An additional search was performed to ensure that the data within this area was studied but that properties which are truly dissimilar were excluded. This was done to ensure only the most relevant data is being relied on while still giving the client a rough boundary of the competing area.';

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

export const NEIGHBORHOOD_ALL_PROPERTY_ROWS = [
  {
    label: 'House Value',
    low: 'neighborhood_all_house_price_low',
    high: 'neighborhood_all_house_price_high',
    predominant: 'neighborhood_all_house_price_predominant',
    format: 'money',
  },
  {
    label: 'Value per Sq. Ft.',
    low: 'neighborhood_all_ppsf_low',
    high: 'neighborhood_all_ppsf_high',
    predominant: 'neighborhood_all_ppsf_predominant',
    format: 'money',
  },
  {
    label: 'Age',
    low: 'neighborhood_all_age_low',
    high: 'neighborhood_all_age_high',
    predominant: 'neighborhood_all_age_predominant',
    format: 'number',
  },
  {
    label: 'GLA',
    low: 'neighborhood_all_gla_low',
    high: 'neighborhood_all_gla_high',
    predominant: 'neighborhood_all_gla_predominant',
    format: 'number',
  },
] as const;

export type NeighborhoodRepresentativenessFactor = {
  key: 'house_price' | 'price_per_square_foot' | 'age' | 'living_area';
  label: string;
  salesPredominant: number;
  propertyPredominant: number;
  deviationPercent: number;
  similarityScore: number;
};

export type NeighborhoodRepresentativeness = {
  score: number | null;
  label: 'Highly representative' | 'Representative' | 'Moderately representative' | 'Limited representation' | 'Insufficient data';
  factors: NeighborhoodRepresentativenessFactor[];
  narrative: string;
};

export function calculateNeighborhoodRepresentativeness(
  details?: AssignmentDetailsPayload | null,
): NeighborhoodRepresentativeness {
  const comparisons = [
    ['house_price', 'Value / Sale Price', 'neighborhood_house_price_predominant', 'neighborhood_all_house_price_predominant'],
    ['price_per_square_foot', 'Value / Price per Sq. Ft.', 'neighborhood_ppsf_predominant', 'neighborhood_all_ppsf_predominant'],
    ['age', 'Age', 'neighborhood_age_predominant', 'neighborhood_all_age_predominant'],
    ['living_area', 'GLA', 'neighborhood_gla_predominant', 'neighborhood_all_gla_predominant'],
  ] as const;
  const factors = comparisons.flatMap(([key, label, salesField, propertyField]) => {
    const salesPredominant = numericValue(details?.[salesField]);
    const propertyPredominant = numericValue(details?.[propertyField]);
    if (salesPredominant === null || propertyPredominant === null || propertyPredominant <= 0) return [];
    const deviationPercent = Math.abs(salesPredominant - propertyPredominant) / propertyPredominant * 100;
    return [{
      key,
      label,
      salesPredominant,
      propertyPredominant,
      deviationPercent: Math.round(deviationPercent * 10) / 10,
      similarityScore: Math.round(Math.max(0, 100 - deviationPercent) * 10) / 10,
    } satisfies NeighborhoodRepresentativenessFactor];
  });
  if (factors.length < 3) {
    return {
      score: null,
      label: 'Insufficient data',
      factors,
      narrative: 'At least three matched predominant characteristics are required before the sales sample can be compared with the full neighborhood housing stock.',
    };
  }
  const score = Math.round(
    factors.reduce((sum, factor) => sum + factor.similarityScore, 0) / factors.length * 10,
  ) / 10;
  const label = score >= 90
    ? 'Highly representative'
    : score >= 80
      ? 'Representative'
      : score >= 65
        ? 'Moderately representative'
        : 'Limited representation';
  const largestDeviation = factors.reduce((largest, factor) => (
    factor.deviationPercent > largest.deviationPercent ? factor : largest
  ));
  return {
    score,
    label,
    factors,
    narrative: `${label}: the sales-only predominant characteristics are ${score.toFixed(1)}% similar to the complete one-unit neighborhood profile across ${factors.length} available measures. ${largestDeviation.label} has the largest median deviation at ${largestDeviation.deviationPercent.toFixed(1)}%.`,
  };
}

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
    errors.push('Draw and save an Appraiser-Defined Area in the Property Report Market Conditions Analysis.');
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
