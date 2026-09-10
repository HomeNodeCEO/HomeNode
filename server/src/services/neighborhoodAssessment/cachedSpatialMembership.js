import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { normalizePublicCadastralAccountId } from '../../security/publicCadastralCatalog.js';
import { assessmentEvidenceDigest, canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodDiscoveryGeometryV1, prepareNeighborhoodDiscoveryChoice,
  NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_CITY, NEIGHBORHOOD_CITY_PARCEL_PREDICATE } from './selectorInputProfile.js';
import { validateRetainedCustomCityDiscovery } from './customCityDiscovery.js';

const LIMITS = Object.freeze({ page_size: 500, parcels: 100000, accounts: 50000,
  bytes: 16777216, duration_ms: 15000, query_ms: 5000 });
const HASH = /^[0-9a-f]{64}$/;
const SNAPSHOT_SQL = `SELECT current_setting('transaction_isolation') AS isolation,
  current_setting('transaction_read_only') AS read_only,
  pg_backend_pid() AS backend_pid, pg_current_snapshot()::text AS snapshot,
  to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS transaction_started_at`;
const INELIGIBLE_SQL = `SELECT object_id::text AS object_id FROM gis.dcad_parcels
  WHERE geom IS NULL OR ST_IsEmpty(geom) OR NOT ST_IsValid(geom)
    OR ST_SRID(geom) <> 4326 OR ST_GeometryType(geom) <> 'ST_MultiPolygon'
    OR NOT (ST_XMin(geom) >= -180 AND ST_XMax(geom) <= 180
      AND ST_YMin(geom) >= -90 AND ST_YMax(geom) <= 90)
  LIMIT 1`;
const PAGE_SQL = `WITH page AS MATERIALIZED (
  SELECT object_id, account_id, source_record_hash, sync_run_id,
    to_char(synced_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS synced_at,
    to_char(source_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_updated_at,
    encode(sha256(ST_AsEWKB(geom)), 'hex') AS geometry_sha256
  FROM gis.dcad_parcels
  WHERE ($3::bigint IS NULL OR object_id > $3::bigint)
    AND ST_DWithin(geom::geography,
      ST_SetSRID(ST_MakePoint($1::double precision, $2::double precision), 4326)::geography,
      4828.032, true)
  ORDER BY object_id LIMIT $4
), encoded AS (
  SELECT object_id, jsonb_build_object('object_id', object_id::text, 'account_id', account_id,
    'source_record_hash', source_record_hash, 'sync_run_id', sync_run_id::text,
    'synced_at', synced_at, 'source_updated_at', source_updated_at,
    'geometry_sha256', geometry_sha256) AS payload FROM page
)
SELECT CASE WHEN octet_length(payload::text) <= 2048 THEN payload ELSE NULL END AS payload
FROM encoded ORDER BY object_id`;
// Keep v1's SQL literal/parameter positions exactly unchanged. v2 adds only a
// bounded numeric distance parameter; no caller expression or alternate predicate.
const PAGE_SQL_V2 = PAGE_SQL.replace('4828.032, true', '$5::double precision, true');
// Separate predicate/parameter domain: the envelope is an index prefilter,
// never membership. Keep crossing/touching parcels whole, and preserve holes.
const CITY_PAGE_SQL = PAGE_SQL
  .replace('($3::bigint IS NULL OR object_id > $3::bigint)', '($2::bigint IS NULL OR object_id > $2::bigint)')
  .replace(`ST_DWithin(geom::geography,
      ST_SetSRID(ST_MakePoint($1::double precision, $2::double precision), 4326)::geography,
      4828.032, true)`, `geom && ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326)
    AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326))`)
  .replace('LIMIT $4', 'LIMIT $3');
const CITY_VALIDITY_SQL = `WITH city AS (
  SELECT ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326) AS geom
) SELECT (NOT ST_IsEmpty(geom) AND ST_IsValid(geom)
  AND ST_GeometryType(geom) IN ('ST_Polygon','ST_MultiPolygon')
  AND ST_SRID(geom)=4326 AND ST_NDims(geom)=2) AS valid FROM city`;

class IncompleteMembership extends Error {}
function incomplete(reason) { throw new IncompleteMembership(reason); }
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function limitsOf(overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)
    || Object.keys(overrides).some(key => !Object.hasOwn(LIMITS, key))) throw new TypeError('invalid_spatial_membership_limits');
  const result = { ...LIMITS, ...overrides };
  for (const key of Object.keys(LIMITS)) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > LIMITS[key]) {
      throw new TypeError('invalid_spatial_membership_limits');
    }
  }
  return result;
}
function snapshotOf(rows) {
  if (rows.length !== 1 || rows[0].isolation !== 'repeatable read' || rows[0].read_only !== 'on'
    || !Number.isSafeInteger(rows[0].backend_pid) || typeof rows[0].snapshot !== 'string'
    || !/^\d+:\d+:(?:\d+(?:,\d+)*)?$/.test(rows[0].snapshot)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(rows[0].transaction_started_at ?? '')) {
    incomplete('repeatable_read_read_only_transaction_required');
  }
  return { backend_pid: rows[0].backend_pid, snapshot: rows[0].snapshot,
    transaction_started_at: rows[0].transaction_started_at };
}

/** Read exact three-mile polygon membership inside the caller's exclusive,
 * already-authorized, repeatable-read/read-only transaction. Never BEGIN,
 * COMMIT, ROLLBACK, release, or claim provider coverage/current authorization.
 * The caller owns rollback/release after any query failure or timeout.
 * A complete result describes this cache snapshot ONLY; admission must still
 * establish full source coverage, original subject evidence and current access.
 */
export async function captureNeighborhoodSpatialMembership(client, geometryInput, overrides = {}, discoveryChoice, cityInput) {
  const discovery = discoveryChoice === undefined ? null : prepareNeighborhoodDiscoveryChoice(discoveryChoice);
  const city = discovery?.profile_id === NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_CITY
    ? validateRetainedCustomCityDiscovery(cityInput) : null;
  if (city && canonicalAssessmentJson(city.choice) !== canonicalAssessmentJson(discovery)) {
    throw new TypeError('spatial_city_binding_mismatch');
  }
  if (!city && cityInput !== undefined) throw new TypeError('spatial_city_scope_unexpected');
  const prepared = prepareNeighborhoodDiscoveryGeometryV1(geometryInput);
  if (prepared.status !== 'prepared') return prepared;
  if (!client || typeof client.query !== 'function') throw new TypeError('spatial_membership_client_required');
  const limits = limitsOf(overrides);
  const started = performance.now();
  const counts = { queries: 0, parcels: 0, accounts: 0, bytes: 0 };
  const check = () => { if (performance.now() - started > limits.duration_ms) incomplete('duration_limit'); };
  const query = async (tag, text, values = []) => {
    check(); counts.queries += 1;
    const result = await client.query({ text: `/* neighborhood-membership:${tag} */ ${text}`,
      values, query_timeout: Math.min(limits.query_ms, limits.duration_ms) });
    check();
    if (!Array.isArray(result?.rows)) incomplete('database_result_invalid');
    return result.rows;
  };
  try {
    const snapshot = snapshotOf(await query('snapshot', SNAPSHOT_SQL));
    const cityGeometry = city ? JSON.stringify(city.geometry) : null;
    if (city) {
      const validity = await query('city-geometry-eligibility', CITY_VALIDITY_SQL, [cityGeometry]);
      if (validity.length !== 1 || validity[0].valid !== true) incomplete('city_geometry_ineligible');
    }
    // Do not silently discard invalid polygons and report the remainder as complete.
    // This conservative cache-wide gate is separate from provider-coverage admission.
    if ((await query('geometry-eligibility', INELIGIBLE_SQL)).length) incomplete('cached_geometry_ineligible');
    const parcels = [];
    const accounts = new Set();
    const digest = createHash('sha256').update(city ? 'homenode-cached-spatial-membership-city-v1\n'
      : discovery ? 'homenode-cached-spatial-membership-v2\n' : 'homenode-cached-spatial-membership-v1\n')
      .update(canonicalAssessmentJson(city
        ? { geometry_input: prepared.geometry_input, discovery, parcel_predicate: NEIGHBORHOOD_CITY_PARCEL_PREDICATE }
        : discovery
        ? { geometry_input: prepared.geometry_input, discovery, distance_semantics: 'postgis_geography_spheroid_v1',
          parcel_predicate: 'all_intersecting_parcels' }
        : { geometry_input: prepared.geometry_input, radius_metres: '4828.032', distance_semantics: 'postgis_geography_spheroid_v1' })).update('\n');
    let cursor = null;
    while (true) {
      const rows = await query('parcels', city ? CITY_PAGE_SQL : discovery ? PAGE_SQL_V2 : PAGE_SQL,
        city ? [cityGeometry, cursor, limits.page_size + 1]
          : [...prepared.geometry_input.coordinates, cursor, limits.page_size + 1, ...(discovery ? [discovery.radius_metres] : [])]);
      if (rows.length > limits.page_size + 1) incomplete('database_page_invalid');
      for (const { payload } of rows.slice(0, limits.page_size)) {
        if (!payload) incomplete('row_bytes_limit');
        const { object_id: objectId, account_id: accountId } = payload;
        if (typeof objectId !== 'string' || !/^-?(?:0|[1-9]\d*)$/.test(objectId)
          || BigInt(objectId) < -9223372036854775808n || BigInt(objectId) > 9223372036854775807n
          || (cursor !== null && BigInt(objectId) <= BigInt(cursor))) incomplete('parcel_order_invalid');
        if (typeof accountId !== 'string' || !accountId.length || accountId.length > 64
          || accountId.trim() !== accountId || /[\u0000-\u001f\u007f]/.test(accountId)
          || normalizePublicCadastralAccountId(accountId) !== accountId) incomplete('parcel_account_unresolved');
        if (!HASH.test(payload.source_record_hash ?? '') || !HASH.test(payload.geometry_sha256 ?? '')
          || typeof payload.sync_run_id !== 'string' || !payload.sync_run_id.length
          || typeof payload.synced_at !== 'string') incomplete('parcel_provenance_incomplete');
        const json = canonicalAssessmentJson(payload);
        counts.parcels += 1; counts.bytes += Buffer.byteLength(json);
        accounts.add(accountId); counts.accounts = accounts.size;
        if (counts.parcels > limits.parcels) incomplete('parcel_limit');
        if (counts.accounts > limits.accounts) incomplete('account_limit');
        if (counts.bytes > limits.bytes) incomplete('byte_limit');
        digest.update(json).update('\n'); parcels.push(payload); cursor = objectId;
        check();
      }
      if (rows.length <= limits.page_size) break;
    }
    const finalSnapshot = snapshotOf(await query('snapshot-end', SNAPSHOT_SQL));
    if (canonicalAssessmentJson(finalSnapshot) !== canonicalAssessmentJson(snapshot)) incomplete('transaction_changed');
    const accountIds = [...accounts].sort();
    return freeze({ status: 'captured', query_complete: true, authority: 'not_established',
      source_coverage: 'not_established', geometry_input: prepared.geometry_input,
      geometry_input_sha256: prepared.geometry_input_sha256,
      ...(city ? { city_scope: { choice: city.choice, asset_utf8: city.asset_utf8, asset_sha256: city.asset_sha256, source: city.source } }
        : { radius_metres: discovery?.radius_metres ?? '4828.032' }),
      ...(discovery ? { discovery } : {}),
      snapshot, parcels, account_ids: accountIds,
      account_ids_sha256: assessmentEvidenceDigest({ account_ids: accountIds }),
      membership_sha256: digest.digest('hex'), counts });
  } catch (error) {
    if (error instanceof TypeError && error.message === 'invalid_neighborhood_assessment:json_bytes') {
      return freeze({ status: 'incomplete', query_complete: false, authority: 'not_established',
        source_coverage: 'not_established', reason: 'account_roster_canonical_byte_limit', counts });
    }
    if (!(error instanceof IncompleteMembership)) throw error;
    return freeze({ status: 'incomplete', query_complete: false, authority: 'not_established',
      source_coverage: 'not_established', reason: error.message, counts });
  }
}
