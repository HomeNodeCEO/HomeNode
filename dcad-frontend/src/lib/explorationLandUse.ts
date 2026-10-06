export interface ExplorationLandUse {
  explorationIdentity: string;
  methodology_version: 'selected-parcels-edge-neighbors-v1';
  analyzed_at: string;
  source_updated_at: string | null;
  selected_parcel_count: number;
  neighbor_parcel_count: number;
  parcel_count: number;
  missing_selected_accounts: number;
  review_required_count: number;
  area_acres: number;
  built_up_percent: number;
  built_up_band: string;
  unknown_percent: number;
  categories: Array<{ key: string; percent: number; parcel_count: number }>;
  denominator_note: string;
  warnings: string[];
}

export function validExplorationLandUse(value: unknown): value is Omit<ExplorationLandUse, 'explorationIdentity'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  const count = (item: unknown) => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 && item <= 100000;
  const percent = (item: unknown) => typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 100;
  const keys = ['one_unit', 'two_to_four_unit', 'multifamily', 'commercial', 'other_vacant'];
  if (result.methodology_version !== 'selected-parcels-edge-neighbors-v1'
    || typeof result.analyzed_at !== 'string' || !Number.isFinite(Date.parse(result.analyzed_at))
    || (result.source_updated_at !== null && typeof result.source_updated_at !== 'string')
    || !['selected_parcel_count', 'neighbor_parcel_count', 'parcel_count', 'missing_selected_accounts', 'review_required_count'].every(key => count(result[key]))
    || Number(result.selected_parcel_count) < 1 || Number(result.selected_parcel_count) + Number(result.neighbor_parcel_count) !== result.parcel_count
    || typeof result.area_acres !== 'number' || !Number.isFinite(result.area_acres) || result.area_acres <= 0
    || !percent(result.built_up_percent) || !percent(result.unknown_percent) || !['over_75', '25_to_75', 'under_25'].includes(String(result.built_up_band))
    || typeof result.denominator_note !== 'string' || !Array.isArray(result.warnings) || !result.warnings.every(item => typeof item === 'string')
    || !Array.isArray(result.categories) || result.categories.length !== 5) return false;
  const seen = new Set(); let sum = Number(result.unknown_percent);
  for (const item of result.categories) {
    if (!item || typeof item !== 'object' || !keys.includes(item.key) || seen.has(item.key) || !percent(item.percent) || !count(item.parcel_count)) return false;
    seen.add(item.key); sum += item.percent;
  }
  return Math.abs(sum - 100) <= 0.06;
}
