import { readBoundedJsonResponse } from '../util/boundedResponse.js';

// TEA-owned public campus points, linked from its official open-data site.
// Approximate nearby amenities only: not attendance zones, routing, or proof
// that a campus existed on an earlier appraisal date.
export const NEARBY_SCHOOL_SOURCE = Object.freeze({
  provider: 'Texas Education Agency', school_year: '2024-2025',
  url: 'https://services2.arcgis.com/5MVN2jsqIrNZD4tP/arcgis/rest/services/Schools_2024_to_2025/FeatureServer/0',
});
const MAX_ROWS = 500, MAX_BYTES = 256 * 1024, TTL = 24 * 60 * 60 * 1000;
const radians = value => value * Math.PI / 180;
function distance(a, b) {
  const x = Math.sin(radians(b[1] - a[1]) / 2) ** 2
    + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(radians(b[0] - a[0]) / 2) ** 2;
  return 3958.7613 * 2 * Math.asin(Math.sqrt(Math.min(1, x)));
}
const texasPoint = (lon, lat) => typeof lon === 'number' && typeof lat === 'number'
  && Number.isFinite(lon) && Number.isFinite(lat) && lon >= -107 && lon <= -93 && lat >= 25 && lat <= 37;
const unavailable = reason => ({ status: 'unavailable', reason });

export function isRetainedNearbySchoolContext(value) {
  const plain = v => v && Object.getPrototypeOf(v) === Object.prototype;
  const text = (v, max) => typeof v === 'string' && v.trim() && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
  return plain(value) && Object.keys(value).length === 7 && value.status === 'available'
    && text(value.account_id, 64) && /^[1-9]\d{0,18}$/.test(value.assignment_file_id)
    && text(value.captured_at, 40) && Number.isFinite(Date.parse(value.captured_at))
    && value.interpretation === 'approximate_nearby_amenity_not_attendance_or_travel_time'
    && plain(value.source) && Object.keys(value.source).length === 3
    && Object.entries(NEARBY_SCHOOL_SOURCE).every(([k, v]) => value.source[k] === v)
    && plain(value.school) && Object.keys(value.school).length === 2 && text(value.school.name, 160)
    && typeof value.school.distance_miles === 'number' && Number.isFinite(value.school.distance_miles)
    && value.school.distance_miles >= 0 && value.school.distance_miles <= 5;
}

export function createNearbySchoolLookup({ pool, fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map(), pending = new Map();
  async function load(center, key) {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 8000);
    try {
      const url = new URL(`${NEARBY_SCHOOL_SOURCE.url}/query`);
      for (const [k, v] of Object.entries({ f: 'json', where: '1=1', geometry: center.join(','), inSR: '4326',
        geometryType: 'esriGeometryPoint', distance: '6', units: 'esriSRUnit_StatuteMile',
        spatialRel: 'esriSpatialRelIntersects', outFields: 'USER_School_Name', returnGeometry: 'true',
        outSR: '4326', resultRecordCount: String(MAX_ROWS) })) url.searchParams.set(k, v);
      const response = await fetchImpl(url.toString(), { signal: abort.signal, redirect: 'error',
        headers: { accept: 'application/json' } });
      if (!response.ok) { await response.body?.cancel(); throw new Error('provider_unavailable'); }
      const data = await readBoundedJsonResponse(response, { maximumBytes: MAX_BYTES });
      if (data?.error || data?.exceededTransferLimit === true || !Array.isArray(data?.features)
        || data.features.length > MAX_ROWS || data?.spatialReference?.wkid !== 4326) throw new Error('provider_incomplete');
      const rows = data.features.map(row => {
        const name = row?.attributes?.USER_School_Name, point = [row?.geometry?.x, row?.geometry?.y];
        if (typeof name !== 'string' || !name.trim() || name.length > 160 || /[\u0000-\u001f\u007f]/.test(name)
          || !texasPoint(...point)) throw new Error('provider_invalid');
        return { name: name.trim(), point };
      });
      const entry = { rows, at: now() };
      if (cache.size >= 32) cache.delete(cache.keys().next().value);
      cache.set(key, entry); return entry;
    } finally { clearTimeout(timer); }
  }
  return async ({ accountId }) => {
    // Existing indexed local location only. Never geocode/refresh the subject or
    // download parcels on this optional description lookup.
    const { rows } = await pool.query(`SELECT longitude, latitude FROM core.account_locations
      WHERE account_id = $1 AND status = 'matched' AND review_required = false LIMIT 1`, [accountId]);
    const point = [rows[0]?.longitude, rows[0]?.latitude];
    if (!texasPoint(...point)) return unavailable('subject_location_unavailable');
    // A 6-mile query around the rounded cell covers the subject's 5-mile search.
    // Cache contains public schools only, never assignment IDs or subject data.
    const center = point.map(n => Number(n.toFixed(2))), key = center.join(',');
    try {
      let entry = cache.get(key);
      if (!entry || now() - entry.at > TTL) {
        if (!pending.has(key)) {
          if (pending.size >= 2) return unavailable('provider_busy');
          pending.set(key, load(center, key).finally(() => pending.delete(key)));
        }
        entry = await pending.get(key);
      }
      const closest = entry.rows.map(row => ({ name: row.name, distance_miles: distance(point, row.point) }))
        .filter(row => row.distance_miles <= 5).sort((a, b) => a.distance_miles - b.distance_miles || a.name.localeCompare(b.name))[0];
      return closest ? { status: 'available', source: NEARBY_SCHOOL_SOURCE,
        captured_at: new Date(entry.at).toISOString(), school: { ...closest, distance_miles: Number(closest.distance_miles.toFixed(2)) },
        interpretation: 'approximate_nearby_amenity_not_attendance_or_travel_time' } : unavailable('no_nearby_school');
    } catch { return unavailable('provider_unavailable'); }
  };
}
