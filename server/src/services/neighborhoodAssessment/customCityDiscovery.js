import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isProxy } from 'node:util/types';
import { scanOriginalJsonText, classifyOriginalJsonTokenFailure } from './originalJsonTokens.js';

export const CUSTOM_CITY_DISCOVERY_PROFILE_ID = 'custom-city-polygon-v1';
export const CUSTOM_CITY_DISCOVERY_PARCEL_PREDICATE = 'postgis_geometry_intersects_city_v1';
export const CUSTOM_CITY_DISCOVERY_LIMITS = Object.freeze({
  asset_utf8_bytes: 1_000_000, catalog_utf8_bytes: 32_768, cities: 100,
  coordinates: 30_000, polygons: 256, rings: 2048, json_depth: 12,
});
const L = CUSTOM_CITY_DISCOVERY_LIMITS;
const DATA = new URL('../../../data/neighborhood-city-boundaries/', import.meta.url);
const HASH = /^[a-f0-9]{64}$/;
const SOURCE_KEYS = ['schemaVersion', 'vintage', 'retrievedAt', 'sourceName', 'sourceUrl', 'sourceQuery',
  'sourceSha256', 'nativeValidationSha256', 'purpose'];
const CITY_KEYS = ['geoid', 'name', 'bytes', 'sha256'];
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function fail(reason) {
  throw Object.assign(new TypeError(`invalid_custom_city_discovery:${reason}`), {
    code: 'CUSTOM_CITY_DISCOVERY_INVALID', reason,
  });
}
function check(ok, reason) { if (!ok) fail(reason); }
function closed(value, required, optional = []) {
  check(value !== null && typeof value === 'object' && !isProxy(value)
    && Object.getPrototypeOf(value) === Object.prototype, 'object');
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  check(required.every(key => Object.hasOwn(descriptors, key))
    && keys.every(key => [...required, ...optional].includes(key)), 'fields');
  const result = {};
  for (const key of keys) {
    const d = descriptors[key]; check(d.enumerable && Object.hasOwn(d, 'value'), 'data_property');
    result[key] = d.value;
  }
  return result;
}
function list(value, maximum) {
  check(Array.isArray(value) && !isProxy(value) && Object.getPrototypeOf(value) === Array.prototype
    && value.length <= maximum, 'array_limit');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(descriptors).length === value.length + 1, 'array_fields');
  const result = [];
  for (let i = 0; i < value.length; i++) {
    const d = descriptors[i]; check(d?.enumerable && Object.hasOwn(d, 'value'), 'data_property'); result.push(d.value);
  }
  return result;
}
function text(value, maximum) {
  check(typeof value === 'string' && value.length > 0 && value.length <= maximum && value.isWellFormed()
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
    && Buffer.byteLength(value) <= maximum, 'text'); return value;
}
function digest(value) { check(typeof value === 'string' && HASH.test(value), 'digest'); return value; }
function date(value) {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value.slice(0, 4) !== '0000', 'date');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  check(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value, 'date'); return value;
}
function geoid(value) { check(typeof value === 'string' && /^48\d{5}$/.test(value), 'geoid'); return value; }
function sourceUrl(value) {
  text(value, 8192);
  let parsed; try { parsed = new URL(value); } catch { fail('source_url'); }
  check(parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash, 'source_url');
  return value; // Exact original provenance text, never fetched or granted here.
}
function cityEntry(value) {
  const city = closed(value, CITY_KEYS);
  check(Number.isSafeInteger(city.bytes) && city.bytes > 0 && city.bytes <= L.asset_utf8_bytes, 'asset_bytes');
  return { geoid: geoid(city.geoid), name: text(city.name, 200), bytes: city.bytes, sha256: digest(city.sha256) };
}
function sourceOf(value, choice) {
  const source = closed(value, [...SOURCE_KEYS, 'city']), city = cityEntry(source.city);
  check(source.schemaVersion === 1 && date(source.vintage) === choice.city.vintage
    && city.geoid === choice.city.geoid && city.sha256 === choice.city.asset_sha256, 'source_identity');
  check(typeof source.retrievedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(source.retrievedAt)
    && Number.isFinite(Date.parse(source.retrievedAt)) && new Date(source.retrievedAt).toISOString() === source.retrievedAt, 'retrieval_time');
  return { schemaVersion: 1, vintage: source.vintage, retrievedAt: source.retrievedAt,
    sourceName: text(source.sourceName, 500), sourceUrl: sourceUrl(source.sourceUrl), sourceQuery: sourceUrl(source.sourceQuery),
    sourceSha256: digest(source.sourceSha256), nativeValidationSha256: digest(source.nativeValidationSha256),
    purpose: text(source.purpose, 2000), city };
}
function parseOriginal(value, maximum) {
  check(typeof value === 'string' && value.length > 0 && value.length <= maximum, 'asset_bytes');
  try {
    // Shared scanner rejects duplicate/escaped duplicate keys, invalid Unicode,
    // excessive depth/nodes and lossy/nonfinite numeric tokens before JSON.parse.
    const { usage } = scanOriginalJsonText(value, 'full_value');
    check(usage.input_utf8_bytes <= maximum, 'asset_bytes');
    check(usage.decoded_depth <= L.json_depth, 'json_depth');
    return { value: JSON.parse(value), bytes: usage.input_utf8_bytes };
  } catch (error) {
    if (error?.code === 'CUSTOM_CITY_DISCOVERY_INVALID') throw error;
    const classified = classifyOriginalJsonTokenFailure(error);
    fail(classified?.status === 'limit_exceeded' ? 'json_limit' : 'json_invalid');
  }
}
function geometryOf(value) {
  const geometry = closed(value, ['type', 'coordinates']);
  check(geometry.type === 'Polygon' || geometry.type === 'MultiPolygon', 'geometry_type');
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : list(geometry.coordinates, L.polygons);
  check(polygons.length > 0, 'empty_geometry');
  let coordinates = 0, rings = 0;
  const copy = polygons.map(polygon => {
    const originalRings = list(polygon, L.rings); check(originalRings.length > 0, 'empty_polygon');
    return originalRings.map(ring => {
      check(++rings <= L.rings, 'ring_limit');
      const positions = list(ring, L.coordinates); check(positions.length >= 4, 'ring_length');
      const result = positions.map(position => {
        check(++coordinates <= L.coordinates, 'coordinate_limit');
        const point = list(position, 2);
        check(point.length === 2 && point.every(number => typeof number === 'number' && Number.isFinite(number)
          && !Object.is(number, -0)) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90, 'coordinate');
        return point;
      });
      check(result[0][0] === result.at(-1)[0] && result[0][1] === result.at(-1)[1], 'ring_open');
      return result;
    });
  });
  // No winding repair, simplification, hull, centroid or topology assertion.
  // Self-intersection, empty/degenerate native geometry and spatial predicates
  // remain the actual owner's parameterized PostGIS admission responsibility.
  return { type: geometry.type, coordinates: geometry.type === 'Polygon' ? copy[0] : copy };
}
function featureOf(value, source) {
  const feature = closed(value, ['type', 'geometry', 'properties']);
  check(feature.type === 'Feature', 'feature_type');
  const p = closed(feature.properties, ['GEOID', 'STATE', 'PLACE', 'NAME', 'BASENAME', 'AREALAND', 'AREAWATER']);
  check(p.GEOID === source.city.geoid && p.STATE === '48' && p.PLACE === p.GEOID.slice(2)
    && p.BASENAME === source.city.name && p.NAME === `${source.city.name} city`, 'feature_identity');
  check(['AREALAND', 'AREAWATER'].every(key => Number.isSafeInteger(p[key]) && p[key] >= 0), 'feature_area');
  return geometryOf(feature.geometry);
}

/** Closed discovery data only. Installed membership is checked only by load;
 * this parser cannot authorize a source read or assert municipal applicability. */
export function prepareCustomCityDiscoveryChoice(value) {
  const choice = closed(value, ['profile_id', 'city']), city = closed(choice.city, ['geoid', 'vintage', 'asset_sha256']);
  check(choice.profile_id === CUSTOM_CITY_DISCOVERY_PROFILE_ID, 'profile');
  return freeze({ profile_id: CUSTOM_CITY_DISCOVERY_PROFILE_ID,
    city: { geoid: geoid(city.geoid), vintage: date(city.vintage), asset_sha256: digest(city.asset_sha256) } });
}

/** Retained integrity, not original provenance or authority. The caller owns
 * authenticated graph loading. Compact retention omits geometry; replay derives
 * it from exact original Feature text. This NEVER consults the current registry. */
export function validateRetainedCustomCityDiscovery(value) {
  const input = closed(value, ['choice', 'asset_utf8', 'asset_sha256', 'source'], ['geometry']);
  const choice = prepareCustomCityDiscoveryChoice(input.choice), source = sourceOf(input.source, choice);
  check(digest(input.asset_sha256) === choice.city.asset_sha256, 'asset_identity');
  const original = parseOriginal(input.asset_utf8, L.asset_utf8_bytes);
  check(original.bytes === source.city.bytes, 'asset_bytes');
  check(createHash('sha256').update(input.asset_utf8, 'utf8').digest('hex') === input.asset_sha256, 'asset_hash');
  const geometry = featureOf(original.value, source);
  if (Object.hasOwn(input, 'geometry')) {
    const supplied = geometryOf(input.geometry);
    check(JSON.stringify(supplied) === JSON.stringify(geometry), 'geometry_mismatch');
  }
  return freeze({ choice, asset_utf8: input.asset_utf8, asset_sha256: input.asset_sha256, geometry, source });
}

async function readBounded(url, maximum) {
  let handle;
  try {
    handle = await open(url, 'r');
    const stat = await handle.stat();
    check(stat.isFile() && stat.size > 0 && stat.size <= maximum, 'installed_bytes');
    const bytes = Buffer.alloc(stat.size + 1); let used = 0;
    while (used < bytes.length) {
      const part = await handle.read(bytes, used, bytes.length - used, used);
      if (!part.bytesRead) break;
      used += part.bytesRead;
    }
    check(used === stat.size, 'installed_bytes');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, used));
  } catch (error) {
    if (error?.code === 'CUSTOM_CITY_DISCOVERY_INVALID') throw error;
    fail('installed_unavailable'); // No filesystem path, original error or URL leak.
  } finally { if (handle) await handle.close().catch(() => {}); }
}

/** Local fixed registry only; caller provides no path, URL, bytes or authority.
 * Original source purpose remains unmodified. The new analysis predicate is a
 * separate installed computational choice, not a claim about historical/current
 * municipal validity, complete provider coverage, or a report neighborhood. */
export async function loadInstalledCustomCityDiscovery(value) {
  const choice = prepareCustomCityDiscoveryChoice(value);
  const catalog = closed(parseOriginal(await readBounded(new URL('catalog.json', DATA), L.catalog_utf8_bytes),
    L.catalog_utf8_bytes).value, [...SOURCE_KEYS, 'cities']);
  const cities = list(catalog.cities, L.cities).map(cityEntry);
  check(cities.length > 0 && new Set(cities.map(city => city.geoid)).size === cities.length, 'installed_catalog');
  const city = cities.find(city => city.geoid === choice.city.geoid);
  check(catalog.vintage === choice.city.vintage && city?.sha256 === choice.city.asset_sha256, 'not_installed');
  const source = Object.fromEntries(SOURCE_KEYS.map(key => [key, catalog[key]]));
  source.city = city;
  const asset_utf8 = await readBounded(new URL(`${catalog.vintage}/${city.geoid}.geojson`, DATA), L.asset_utf8_bytes);
  return validateRetainedCustomCityDiscovery({ choice, asset_utf8, asset_sha256: choice.city.asset_sha256, source });
}
