export const SCHOOL_SOURCE_URL = 'https://services2.arcgis.com/5MVN2jsqIrNZD4tP/arcgis/rest/services/Schools_2024_to_2025/FeatureServer/0';
export interface NearbySchoolContext {
  status: 'available'; account_id: string; assignment_file_id: string; captured_at: string;
  source: { provider: 'Texas Education Agency'; school_year: '2024-2025'; url: string };
  school: { name: string; distance_miles: number };
  interpretation: 'approximate_nearby_amenity_not_attendance_or_travel_time';
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
export function checkedNearbySchoolContext(value: unknown, accountId: string, fileId: string): NearbySchoolContext | null {
  const row = object(value), school = object(row.school), source = object(row.source);
  if (row.status !== 'available' || row.account_id !== accountId || row.assignment_file_id !== fileId
    || row.interpretation !== 'approximate_nearby_amenity_not_attendance_or_travel_time'
    || typeof row.captured_at !== 'string' || row.captured_at.length > 40 || !Number.isFinite(Date.parse(row.captured_at))
    || source.provider !== 'Texas Education Agency' || source.school_year !== '2024-2025' || source.url !== SCHOOL_SOURCE_URL
    || typeof school.name !== 'string' || !school.name.trim() || school.name.length > 160 || /\p{Cc}/u.test(school.name)
    || typeof school.distance_miles !== 'number' || !Number.isFinite(school.distance_miles)
    || school.distance_miles < 0 || school.distance_miles > 5) return null;
  return { status: 'available', account_id: accountId, assignment_file_id: fileId,
    captured_at: row.captured_at, interpretation: 'approximate_nearby_amenity_not_attendance_or_travel_time',
    source: { provider: 'Texas Education Agency', school_year: '2024-2025', url: SCHOOL_SOURCE_URL },
    school: { name: school.name.trim(), distance_miles: school.distance_miles } };
}
