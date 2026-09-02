type UnknownRecord = Record<string, unknown>;

export type Base44Property = {
  account_number?: string;
  address?: string;
  photos?: string[];
  market_value?: number | '';
  appraised_value?: number | '';
  improvement_value?: number | '';
  land_value?: number | '';
  neighborhood_multiplier?: number | '';
  county?: string;
  neighborhood_code?: string;
  subdivision?: string;
  square_footage?: number | '';
  land_acreage?: number | '';
  bedroom_count?: number | '';
  bath_count?: number | '';
  garage_bay_count?: number | '';
  solar_panels?: boolean;
  functional_obsolescence?: boolean;
  classification?: string;
  year_built?: number | '';
  effective_year_built?: number | '';
  last_inspection_year?: number | '';
  tax_agent?: string | null;
  owner_name?: string | null;
  owner_mailing_address?: string | null;
  owner_type?: string | null;
  ownership_percent?: string | number | null;
  deed_date?: string | null;
  deed_type?: string | null;
  purchase_price?: string | number | null;
  grantor?: string | null;
  homestead_display?: string | null;
  ag_use_display?: string | null;
  mineral_rights_display?: string | null;
  legal_description?: string | null;
  owner_notes?: string | null;
  total_living_area?: string | number | null;
  percent_complete?: string | number | null;
  stories?: string | number | null;
  stories_num?: string | number | null;
  construction_type_display?: string | null;
  construction_type?: string | null;
  foundation_display?: string | null;
  foundation_type?: string | null;
  roof_type?: string | null;
  roof_material?: string | null;
  fence_type?: string | null;
  exterior_material?: string | null;
  basement_display?: string | null;
  basement?: boolean | string | null;
  heating_display?: string | null;
  heating_type?: string | null;
  cooling_display?: string | null;
  air_conditioning?: string | null;
  kitchen_count?: string | number | null;
  wet_bar_count?: string | number | null;
  fireplace_count?: string | number | null;
  sprinkler_display?: string | null;
  deck_porches_display?: string | null;
  spa_display?: string | null;
  pool_display?: string | null;
  pool?: boolean | null;
  sauna_display?: string | null;
  protest_history?: Array<{
    year: number;
    status: string;
    initial_value: number;
    final_value: number;
  }>;
};

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== null && value !== undefined);
}

function textValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = textValue(value);
    if (text) return text;
  }
  return '';
}

function nullableText(value: unknown): string | null {
  return textValue(value) || null;
}

function nullableScalar(value: unknown): string | number | null {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
    ? value
    : null;
}

function nullableBooleanOrText(value: unknown): boolean | string | null {
  if (typeof value === 'boolean') return value;
  return nullableText(value);
}

function strictBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') return /^(?:1|true|yes)$/i.test(value.trim());
  return false;
}

export function finitePropertyNumber(value: unknown): number | '' {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const number = Number(String(value).replace(/[,$\s]/g, ''));
  return Number.isFinite(number) ? number : '';
}

function photoUrls(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((photo): photo is string => typeof photo === 'string' && photo.trim().length > 0)
    : [];
}

function protestHistory(value: unknown): Base44Property['protest_history'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const row = asRecord(candidate);
    if (!row) return [];
    const year = finitePropertyNumber(row.year);
    const initialValue = finitePropertyNumber(row.initial_value);
    const finalValue = finitePropertyNumber(row.final_value);
    const status = textValue(row.status);
    if (year === '' || initialValue === '' || finalValue === '' || !status) return [];
    return [{ year, status, initial_value: initialValue, final_value: finalValue }];
  });
}

export function mapMergedToBase44Property(
  detail: unknown,
  fallbackAccountNumber: string,
): Partial<Base44Property> {
  const root = asRecord(detail) || {};
  const account = asRecord(root.account) || root;
  const improvement = asRecord(root.primary_improvements) || root;
  const owner = asRecord(root.owner_summary) || asRecord(root.owner) || {};
  const values = asRecord(root.value_summary) || {};
  const neighborhood = asRecord(root.neighborhood) || {};
  const land = asRecord(root.land) || {};
  const firstOwner = Array.isArray(root.owner_parties) ? asRecord(root.owner_parties[0]) : null;
  const bathNumber = finitePropertyNumber(firstDefined(
    improvement.bath_count,
    root.bath_count_num,
    typeof root.bath_count_display === 'number' ? root.bath_count_display : undefined,
  ));

  return {
    account_number: firstText(account.account_id, fallbackAccountNumber),
    address: firstText(account.address, root.situs_address, root.address),
    photos: photoUrls(root.photos),
    market_value: finitePropertyNumber(firstDefined(values.market_value, account.latest_market_value, root.market_value)),
    appraised_value: finitePropertyNumber(firstDefined(
      values.capped_value,
      account.latest_capped_value,
      root.taxable_value,
      root.appraised_value,
    )),
    improvement_value: finitePropertyNumber(firstDefined(values.improvement_value, account.latest_improvement_value)),
    land_value: finitePropertyNumber(firstDefined(values.land_value, account.latest_land_value)),
    neighborhood_multiplier: finitePropertyNumber(firstDefined(neighborhood.multiplier, root.neighborhood_multiplier)),
    county: firstText(account.county, root.county, root.county_name),
    square_footage: finitePropertyNumber(firstDefined(improvement.living_area_sqft, improvement.total_living_area)),
    total_living_area: nullableScalar(firstDefined(improvement.total_living_area, improvement.living_area_sqft)),
    land_acreage: finitePropertyNumber(firstDefined(root.land_acreage, land.acreage)),
    bedroom_count: finitePropertyNumber(improvement.bedroom_count),
    bath_count: bathNumber,
    garage_bay_count: finitePropertyNumber(root.garage_bay_count),
    solar_panels: strictBoolean(root.solar_panels),
    functional_obsolescence: strictBoolean(root.functional_obsolescence),
    classification: nullableText(firstDefined(improvement.building_class, root.classification)) || undefined,
    year_built: finitePropertyNumber(improvement.year_built),
    effective_year_built: finitePropertyNumber(improvement.effective_year_built),
    last_inspection_year: finitePropertyNumber(root.last_inspection_year),
    neighborhood_code: nullableText(firstDefined(account.neighborhood_code, neighborhood.code)) || undefined,
    subdivision: nullableText(firstDefined(account.subdivision, neighborhood.subdivision)) || undefined,
    owner_name: nullableText(owner.owner_name),
    owner_mailing_address: nullableText(owner.mailing_address),
    ownership_percent: nullableScalar(firstOwner?.ownership_pct),
    legal_description: nullableText(account.legal_description),
    percent_complete: nullableScalar(improvement.percent_complete),
    stories: nullableScalar(improvement.stories),
    construction_type: nullableText(improvement.construction_type),
    foundation_type: nullableText(improvement.foundation),
    roof_type: nullableText(improvement.roof_type),
    roof_material: nullableText(improvement.roof_material),
    fence_type: nullableText(improvement.fence_type),
    exterior_material: nullableText(improvement.exterior_material),
    basement: nullableBooleanOrText(improvement.basement),
    heating_type: nullableText(improvement.heating),
    air_conditioning: nullableText(improvement.air_conditioning),
    pool: typeof improvement.pool === 'boolean' ? improvement.pool : null,
    protest_history: protestHistory(root.protest_history),
  };
}

export function propertyLoadErrorMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message.trim()
    : textValue(valueAt(error, ['message']));
  return message ? message.slice(0, 160) : 'Load failed';
}
