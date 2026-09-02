export type SecondaryImprovement = {
  improvement_type?: string;
  construction?: string;
  floor?: string;
  exterior_wall?: string;
  area_sqft?: number | string;
  [key: string]: unknown;
};

export type SectionEditData = {
  square_footage?: number | string;
  total_area_sqft?: number | string;
  stories?: number | string;
  bath_count?: number | string;
  secondary_improvements?: SecondaryImprovement[];
  [key: string]: unknown;
};

export type SectionChangeLog = {
  section: string;
  timestamp: string;
  user: string;
  changeType: string;
  before: unknown;
  after: SectionEditData;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' || Number.isFinite(Number(trimmed)) ? value : undefined;
  }
  return undefined;
}

export function normalizeSecondaryImprovements(value: unknown): SecondaryImprovement[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const record = asRecord(candidate);
    if (!record) return [];
    return [{
      ...record,
      improvement_type: optionalText(record.improvement_type),
      construction: optionalText(record.construction),
      floor: optionalText(record.floor),
      exterior_wall: optionalText(record.exterior_wall),
      area_sqft: optionalNumber(record.area_sqft),
    }];
  });
}

export function normalizeSectionEditData(value: unknown): SectionEditData {
  const record = asRecord(value);
  if (!record) return {};
  return {
    ...record,
    square_footage: optionalNumber(record.square_footage),
    total_area_sqft: optionalNumber(record.total_area_sqft),
    stories: optionalNumber(record.stories),
    bath_count: optionalNumber(record.bath_count),
    secondary_improvements: normalizeSecondaryImprovements(record.secondary_improvements),
  };
}

export function editableInputValue(value: unknown): string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
    ? value
    : '';
}
