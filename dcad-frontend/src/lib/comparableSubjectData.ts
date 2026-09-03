export type SubjectData = {
  accountId: string;
  address?: string | null;
  total_living_area?: number | string | null;
  market_value?: number | string | null;
  nbhd_code?: string | null;
  land_size_sqft?: number | null;
  view?: string | null;
  construction_type?: string | null;
  building_class?: string | null;
  actual_age?: number | string | null;
  stories?: number | string | null;
  bedroom_count?: number | string | null;
  baths_full?: number | string | null;
  baths_half?: number | string | null;
  bath_count?: number | string | null;
  basement?: boolean | string | null;
  basement_raw?: string | null;
  heating?: string | null;
  air_conditioning?: string | null;
  basement_sqft?: number | null;
  solar_panels?: boolean | null;
  solar_area_sqft?: number | null;
  garage_area_sqft?: number | null;
  pool?: boolean | string | null;
  structural_style?: string | null;
  housing_type?: string | null;
  attachment_type?: 'detached' | 'attached' | 'mixed' | 'unknown' | null;
  architectural_style?: string | null;
  deck?: boolean | string | null;
  fence_type?: string | null;
};

type JsonRecord = Record<string, unknown>;
type NumericValue = number | string;

function record(value: unknown): JsonRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as JsonRecord;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const normalized = record(item);
        return normalized ? [normalized] : [];
      })
    : [];
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numeric(value: unknown): NumericValue | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return typeof value === 'string' ? value : null;
}

function booleanOrString(value: unknown): boolean | string | null {
  return typeof value === 'boolean' || typeof value === 'string' ? value : null;
}

function attachmentType(value: unknown): SubjectData['attachment_type'] {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized === 'detached' || normalized === 'attached' || normalized === 'mixed'
    ? normalized
    : normalized ? 'unknown' : null;
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function detailRoot(value: unknown): JsonRecord {
  const root = record(value) || {};
  return record(root.detail) || root;
}

function detailImprovement(detail: JsonRecord): JsonRecord {
  return record(detail.primary_improvements) || record(detail.main_improvement) || {};
}

function improvementRows(detail: JsonRecord): JsonRecord[] {
  const secondary = records(detail.secondary_improvements);
  return secondary.length ? secondary : records(detail.additional_improvements);
}

function improvementDescription(row: JsonRecord): string {
  return [row.imp_type, row.improvement_type, row.imp_desc, row.improvement_desc, row.description]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}

function totalArea(rows: JsonRecord[], matches: (description: string) => boolean): number {
  return rows.reduce((total, row) => {
    if (!matches(improvementDescription(row))) return total;
    return total + (finiteNumber(row.area_size ?? row.area_sqft) || 0);
  }, 0);
}

function positiveArea(value: number): number | null {
  return value > 0 ? value : null;
}

export function subjectFromAccountResponse(value: unknown, accountId: string): SubjectData {
  const data = record(value) || {};
  const account = record(data.account) || {};
  const improvement = record(data.primary_improvements) || {};
  const housing = record(data.housing_profile) || {};
  return {
    accountId,
    address: text(account.address),
    total_living_area: numeric(improvement.total_living_area ?? improvement.living_area_sqft),
    market_value: numeric(account.latest_market_value),
    nbhd_code: text(account.neighborhood_code),
    construction_type: text(improvement.construction_type),
    building_class: text(improvement.building_class),
    actual_age: numeric(improvement.actual_age),
    stories: numeric(improvement.stories),
    land_size_sqft: null,
    bedroom_count: numeric(improvement.bedroom_count),
    bath_count: numeric(improvement.bath_count),
    baths_full: numeric(improvement.baths_full),
    baths_half: numeric(improvement.baths_half),
    basement: booleanOrString(improvement.basement),
    basement_raw: text(improvement.basement_raw),
    heating: text(improvement.heating),
    air_conditioning: text(improvement.air_conditioning),
    deck: booleanOrString(improvement.deck),
    fence_type: text(improvement.fence_type),
    pool: booleanOrString(improvement.pool),
    structural_style: text(housing.structural_style),
    housing_type: text(housing.housing_type),
    attachment_type: attachmentType(housing.attachment_type),
    architectural_style: text(housing.architectural_style),
  };
}

export function accountNeedsRoomRefresh(value: unknown): boolean {
  const improvement = record(record(value)?.primary_improvements) || {};
  const blank = (candidate: unknown) => candidate === null || candidate === undefined || candidate === '';
  return blank(improvement.bedroom_count) || (
    blank(improvement.baths_full)
    && blank(improvement.baths_half)
    && blank(improvement.bath_count)
  );
}

export function subjectFromDetailResponse(
  value: unknown,
  accountId: string,
  { derivePool = false }: { derivePool?: boolean } = {},
): SubjectData {
  const detail = detailRoot(value);
  const improvement = detailImprovement(detail);
  const housing = record(detail.housing_profile) || {};
  const propertyLocation = record(detail.property_location) || {};
  const neighborhood = record(detail.neighborhood) || {};
  const valueSummary = record(detail.value_summary) || {};
  const rows = improvementRows(detail);
  const landArea = records(detail.land_detail).reduce(
    (total, row) => total + (finiteNumber(row.area_sqft) || 0),
    0,
  );
  const basementArea = totalArea(
    rows,
    (description) => description.includes('basement') || description.includes('bsmt'),
  );
  const garageArea = totalArea(
    rows,
    (description) => description.includes('garage') || description.includes('carport'),
  );
  const solarArea = totalArea(rows, (description) => description.includes('solar'));
  const hasSolar = rows.some((row) => improvementDescription(row).includes('solar'));
  const hasPool = rows.some((row) => improvementDescription(row).includes('pool'));

  return {
    accountId,
    address: text(propertyLocation.address),
    total_living_area: numeric(
      detail.total_living_area ?? improvement.total_living_area ?? improvement.living_area_sqft,
    ),
    market_value: numeric(valueSummary.market_value),
    nbhd_code: text(detail.neighborhood_code)
      || text(neighborhood.code)
      || text(propertyLocation.neighborhood),
    land_size_sqft: positiveArea(landArea),
    view: 'Neutral',
    construction_type: text(improvement.construction_type),
    building_class: text(improvement.building_class),
    actual_age: numeric(improvement.actual_age),
    stories: numeric(improvement.stories) ?? text(improvement.stories_text),
    bedroom_count: numeric(improvement.bedroom_count ?? detail.bedroom_count),
    baths_full: numeric(improvement.baths_full),
    baths_half: numeric(improvement.baths_half),
    bath_count: numeric(improvement.bath_count),
    basement: booleanOrString(improvement.basement ?? detail.basement),
    basement_raw: text(improvement.basement_raw),
    heating: text(improvement.heating ?? detail.heating),
    air_conditioning: text(improvement.air_conditioning ?? detail.air_conditioning),
    basement_sqft: positiveArea(basementArea),
    garage_area_sqft: positiveArea(garageArea),
    structural_style: text(housing.structural_style),
    housing_type: text(housing.housing_type),
    attachment_type: attachmentType(housing.attachment_type),
    architectural_style: text(housing.architectural_style),
    solar_panels: hasSolar || null,
    solar_area_sqft: positiveArea(solarArea),
    pool: derivePool ? (hasPool ? 'T' : 'N/A') : null,
  };
}

function prefer<T>(current: T | null | undefined, fallback: T | null | undefined): T | null {
  return current ?? fallback ?? null;
}

export function mergeSubjectData(
  current: SubjectData | null,
  fallback: SubjectData,
  accountId: string,
): SubjectData {
  return {
    accountId,
    address: prefer(current?.address, fallback.address),
    total_living_area: prefer(current?.total_living_area, fallback.total_living_area),
    market_value: prefer(current?.market_value, fallback.market_value),
    nbhd_code: prefer(current?.nbhd_code, fallback.nbhd_code),
    land_size_sqft: prefer(current?.land_size_sqft, fallback.land_size_sqft),
    view: prefer(current?.view, fallback.view),
    construction_type: prefer(current?.construction_type, fallback.construction_type),
    building_class: prefer(current?.building_class, fallback.building_class),
    actual_age: prefer(current?.actual_age, fallback.actual_age),
    stories: prefer(current?.stories, fallback.stories),
    bedroom_count: prefer(current?.bedroom_count, fallback.bedroom_count),
    baths_full: prefer(current?.baths_full, fallback.baths_full),
    baths_half: prefer(current?.baths_half, fallback.baths_half),
    bath_count: prefer(current?.bath_count, fallback.bath_count),
    basement: prefer(current?.basement, fallback.basement),
    basement_raw: prefer(current?.basement_raw, fallback.basement_raw),
    heating: prefer(current?.heating, fallback.heating),
    air_conditioning: prefer(current?.air_conditioning, fallback.air_conditioning),
    basement_sqft: prefer(current?.basement_sqft, fallback.basement_sqft),
    solar_panels: prefer(current?.solar_panels, fallback.solar_panels),
    solar_area_sqft: prefer(current?.solar_area_sqft, fallback.solar_area_sqft),
    garage_area_sqft: prefer(current?.garage_area_sqft, fallback.garage_area_sqft),
    pool: prefer(current?.pool, fallback.pool),
    structural_style: prefer(current?.structural_style, fallback.structural_style),
    housing_type: prefer(current?.housing_type, fallback.housing_type),
    attachment_type: prefer(current?.attachment_type, fallback.attachment_type),
    architectural_style: prefer(current?.architectural_style, fallback.architectural_style),
    deck: prefer(current?.deck, fallback.deck),
    fence_type: prefer(current?.fence_type, fallback.fence_type),
  };
}

export function responseSummary(value: unknown): string {
  const response = record(value);
  const candidate = response?.summary ?? response?.content;
  return typeof candidate === 'string' ? candidate.trim() : '';
}

export function boundedErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim().slice(0, 500)
    : fallback;
}
