import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { assessmentEvidenceDigest } from './contract.js';
import { prepareNeighborhoodDiscoveryGeometryV1, prepareNeighborhoodDiscoveryChoice,
  NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V2 } from './selectorInputProfile.js';
import { createCustomCohortCaptureJobRepository, prepareCustomCohortCaptureJobClaim }
  from './customCohortCaptureJobRepository.js';

export const NEIGHBORHOOD_FROZEN_SPATIAL_LIMITS = Object.freeze({
  rows: 250, page_utf8_bytes: 128_000, pages: 64, queries: 2048,
  operation_utf8_bytes: 8_000_000, operation_ms: 60_000,
});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const KINDS = ['parcels','accounts','source_records','sales','sale_links','sync_state','sync_runs'];
function fail(reason) { throw new TypeError(`neighborhood_frozen_spatial_${reason}`); }
function data(value, required, optional = []) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('invalid_input');
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (!required.every(key => keys.includes(key)) || keys.some(key => typeof key !== 'string'
    || ![...required,...optional].includes(key) || !Object.hasOwn(descriptors[key],'value')
    || !descriptors[key].enumerable)) fail('invalid_input');
  return Object.fromEntries(keys.map(key => [key,descriptors[key].value]));
}
function count(value, maximum = 2_000_000) {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= BigInt(maximum);
}
function account(value) {
  return typeof value === 'string' && Buffer.byteLength(value) <= 64 && value.length > 0
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function cursor(value, kind) {
  if (value === '') return value;
  if (kind === 'accounts' ? !account(value) : !count(value,9223372036854775807n)) fail('invalid_cursor');
  return value;
}
function advances(next, previous, kind) {
  return next !== '' && (previous === '' || (kind === 'accounts'
    ? Buffer.compare(Buffer.from(next),Buffer.from(previous)) > 0 : BigInt(next) > BigInt(previous)));
}
function one(result) {
  if (result?.rowCount !== 1 || !Array.isArray(result.rows) || result.rows.length !== 1) fail('invalid_result');
  return result.rows[0];
}
const HEADER = `/* neighborhood-frozen-spatial:header */ SELECT generation_id::text,format_version,status,
  source_snapshot,to_char(source_transaction_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at,
  to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_at,
  layer_counts,row_count::text,payload_utf8_bytes::text FROM app.neighborhood_frozen_source_generations
  WHERE generation_id=$1::uuid`;
function metadata(result, generationId) {
  const row = one(result);
  if (row.generation_id !== generationId || row.format_version !== 1 || row.status !== 'complete'
    || typeof row.source_snapshot !== 'string' || row.source_snapshot.length > 65536
    || !/^[0-9]+:[0-9]+:(?:[0-9]+(?:,[0-9]+)*)?$/.test(row.source_snapshot)
    || !DATE.test(row.started_at ?? '') || !DATE.test(row.completed_at ?? '') || row.completed_at < row.started_at
    || !count(row.row_count,14_000_000) || !count(row.payload_utf8_bytes,8_000_000_000)) fail('header_corrupt');
  const counts = data(row.layer_counts,KINDS); let rows = 0, bytes = 0;
  for (const kind of KINDS) {
    const item = data(counts[kind],['row_count','payload_utf8_bytes']);
    if (!count(item.row_count) || !count(item.payload_utf8_bytes,8_000_000_000)
      || (item.row_count === '0' ? item.payload_utf8_bytes !== '0' : Number(item.payload_utf8_bytes) < Number(item.row_count))) fail('header_corrupt');
    rows += Number(item.row_count); bytes += Number(item.payload_utf8_bytes); counts[kind] = Object.freeze(item);
  }
  if (String(rows) !== row.row_count || String(bytes) !== row.payload_utf8_bytes) fail('header_corrupt');
  return Object.freeze({ generation_id:generationId,source_format_version:1,source_snapshot:row.source_snapshot,
    source_transaction_started_at:row.started_at,completed_at:row.completed_at,
    row_count:row.row_count,payload_utf8_bytes:row.payload_utf8_bytes,layer_counts:Object.freeze(counts) });
}
// Shared immutable-header validation for the actual stock owner. This is DATA,
// not an actor/source grant; callers retain the scoped live pin at both ends.
export async function readNeighborhoodFrozenSourceHeader(client, generationId) {
  return metadata(await client.query(HEADER,[generationId]),generationId);
}
export function neighborhoodFrozenSpatialDefinition(claim, generationId, geometryInput, rawDiscovery) {
  const geometry = prepareNeighborhoodDiscoveryGeometryV1(geometryInput);
  const discovery = prepareNeighborhoodDiscoveryChoice(rawDiscovery);
  if (geometry.status !== 'prepared' || discovery.profile_id !== NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V2) fail('invalid_discovery');
  return Object.freeze({spatial_format_version:1,operation_id:claim.operation_id,generation_id:generationId,
    geometry_input:geometry.geometry_input,discovery,distance_semantics:'postgis_geography_spheroid_v1',parcel_predicate:'all_intersecting_parcels'});
}
const WHERE = `generation_id=$1::uuid AND kind='parcels' AND geom IS NOT NULL
  AND ST_DWithin(geom::geography,ST_SetSRID(ST_MakePoint($2::double precision,$3::double precision),4326)::geography,
    $4::double precision,true)`;
// Missing/empty geometry is explicitly UNKNOWN location, never outside the
// study. Invalid nonempty geometry refuses the read before a geography cast.
const VALIDITY = `/* neighborhood-frozen-spatial:validity */ SELECT
  count(*) FILTER(WHERE geom IS NULL OR ST_IsEmpty(geom))::text AS unlocatable_global_parcels,
  count(*) FILTER(WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom) AND (
    NOT ST_IsValid(geom) OR ST_NDims(geom)<>2 OR ST_SRID(geom)<>4326
    OR NOT(ST_XMin(geom)>=-180 AND ST_XMax(geom)<=180 AND ST_YMin(geom)>=-90 AND ST_YMax(geom)<=90)))::text AS invalid_geometries
  FROM app.neighborhood_frozen_source_rows WHERE generation_id=$1::uuid AND kind='parcels'`;
const COUNTS = `/* neighborhood-frozen-spatial:counts */ SELECT count(*)::text AS parcel_count,
  count(DISTINCT account_id COLLATE "C")::text AS account_count,
  count(*) FILTER(WHERE account_id IS NULL)::text AS unassociated_parcel_count,
  coalesce(bool_or(account_id=$5),false) AS subject_included
  FROM app.neighborhood_frozen_source_rows WHERE ${WHERE}`;
const PROJECTIONS = {
  parcels: `SELECT row_key AS key,row_key::bigint AS ordering,
    jsonb_build_object('object_id',row_key,'account_id',account_id,
      'geometry_sha256',encode(sha256(ST_AsEWKB(geom)),'hex'),
      'source_record_hash',payload->>'source_record_hash') AS encoded
    FROM app.neighborhood_frozen_source_rows WHERE ${WHERE}
      AND ($5::text='' OR row_key::bigint>NULLIF($5,'')::bigint) ORDER BY row_key::bigint LIMIT $6::integer`,
  accounts: `SELECT account_id AS key,account_id COLLATE "C" AS ordering,
    jsonb_build_object('account_id',account_id,'parcel_count',count(*)::text) AS encoded
    FROM app.neighborhood_frozen_source_rows WHERE ${WHERE} AND account_id IS NOT NULL
      AND ($5::text='' OR account_id COLLATE "C">$5::text COLLATE "C")
    GROUP BY account_id COLLATE "C",account_id ORDER BY account_id COLLATE "C" LIMIT $6::integer`,
};
export const NEIGHBORHOOD_FROZEN_SPATIAL_SQL = Object.freeze(Object.fromEntries(Object.entries(PROJECTIONS).map(([kind,projection]) => [kind,
  `/* neighborhood-frozen-spatial:${kind} */ WITH candidates AS MATERIALIZED (${projection}), sized AS (
    SELECT *,sum(octet_length(encoded::text)+2) OVER(ORDER BY ordering) AS prefix_bytes FROM candidates
  ), admitted AS (SELECT * FROM sized WHERE prefix_bytes+2<=$7::bigint), page AS (
    SELECT coalesce(jsonb_agg(encoded ORDER BY ordering),'[]'::jsonb)::text AS page_json,count(*)::integer AS page_count FROM admitted
  ) SELECT page_json,page_count,octet_length(page_json)::integer AS page_utf8_bytes,
    (SELECT count(*)::integer FROM candidates) AS candidate_count,
    coalesce((SELECT key FROM admitted ORDER BY ordering DESC LIMIT 1),$5)::text AS next_cursor FROM page`
])));

/** Internal immutable-version spatial DATA reader, never current authorization.
 * The owner supplies a recorded subject point only after its fresh assignment,
 * subject and source-purpose checks, and must repeat those checks before use.
 * Every call reopens only an existing live scoped job pin, preserves the exact
 * spheroid predicate, and returns bounded identities/counts rather than a dense
 * city roster or simplified geometry. Cursor+definition+generation must remain
 * bound by the future acquisition owner. No pin creation, writes, commit, HTTP
 * mount, acquisition receipt, selected statistics or historical-stock claim.
 * Caller owns rollback and settled client cleanup on every failure.
 */
export function createNeighborhoodFrozenSpatialPages(client, rawOptions) {
  if (typeof client?.query !== 'function') fail('client_required');
  const options = data(rawOptions,['claim','scope','actorUserId','geometryInput','discovery'],['signal','checkBudget']);
  const claim = prepareCustomCohortCaptureJobClaim(data(options.claim,['operation_id','claim_token','attempts']));
  const scope = Object.freeze(data(options.scope,['organization_id','report_file_id','assignment_file_id','account_id']));
  if (typeof options.actorUserId !== 'string' || !UUID.test(options.actorUserId)) fail('invalid_input');
  const geometry = prepareNeighborhoodDiscoveryGeometryV1(options.geometryInput), discovery = prepareNeighborhoodDiscoveryChoice(options.discovery);
  if (geometry.status !== 'prepared' || discovery.profile_id !== NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V2) fail('invalid_discovery');
  const {signal} = options, checkBudget = options.checkBudget ?? (() => {});
  if (typeof checkBudget !== 'function' || (signal !== undefined && !(signal instanceof AbortSignal))) fail('invalid_input');
  const limits = NEIGHBORHOOD_FROZEN_SPATIAL_LIMITS, deadline = performance.now()+limits.operation_ms;
  let busy = false, pages = 0, queries = 0, bytes = 0, cachedPopulation = null;
  const check = () => { if (signal?.aborted) fail('cancelled'); checkBudget();
    if (signal?.aborted) fail('cancelled'); if (performance.now()>=deadline) fail('deadline'); };
  const port = { async query(text,values) { check(); if (++queries>limits.queries) fail('operation_limit');
    const config = typeof text === 'string' ? {text,values} : text;
    const result = await client.query({...config,query_timeout:Math.max(1,Math.min(5000,Math.ceil(deadline-performance.now())))});
    check(); return result; } };
  const jobs = createCustomCohortCaptureJobRepository(port), jobOptions = {scope,actorUserId:options.actorUserId};
  return Object.freeze({ async page(rawPage) {
    const input = data(rawPage,['kind','cursor'],['rowLimit']);
    if (!['parcels','accounts'].includes(input.kind)) fail('invalid_kind');
    const previous = cursor(input.cursor,input.kind), rowLimit = input.rowLimit ?? 100;
    if (!Number.isInteger(rowLimit) || rowLimit<1 || rowLimit>limits.rows) fail('invalid_limit');
    check(); if (busy) fail('concurrent_read'); if (++pages>limits.pages) fail('operation_limit'); busy = true;
    try {
      const pin = await jobs.readPreparedGeneration(claim,jobOptions); if (!pin) fail('pin_unavailable');
      const original = metadata(await port.query(HEADER,[pin.generation_id]),pin.generation_id);
      // Only this reader's fixed definition/version population is reused. The
      // original metadata and live scoped claim still reopen at BOTH ends of
      // every page; current owner rights cannot be cached by this primitive.
      if (cachedPopulation && JSON.stringify(cachedPopulation.original)!==JSON.stringify(original)) fail('source_changed');
      const validity = cachedPopulation?.validity ?? one(await port.query(VALIDITY,[pin.generation_id]));
      if (validity.invalid_geometries !== '0' || !count(validity.unlocatable_global_parcels)
        || Number(validity.unlocatable_global_parcels)>Number(original.layer_counts.parcels.row_count)) fail('geometry_unavailable');
      const params = [pin.generation_id,...geometry.geometry_input.coordinates,discovery.radius_metres];
      const population = cachedPopulation?.population ?? data(one(await port.query(COUNTS,[...params,scope.account_id])),
        ['parcel_count','account_count','unassociated_parcel_count','subject_included']);
      if (![population.parcel_count,population.account_count,population.unassociated_parcel_count].every(value=>count(value))
        || Number(population.parcel_count)>Number(original.layer_counts.parcels.row_count)
        || Number(population.account_count)>Number(population.parcel_count)
        || Number(population.unassociated_parcel_count)>Number(population.parcel_count)
        || typeof population.subject_included !== 'boolean') fail('population_corrupt');
      const row = one(await port.query(NEIGHBORHOOD_FROZEN_SPATIAL_SQL[input.kind],
        [...params,previous,rowLimit,limits.page_utf8_bytes]));
      if (!Number.isInteger(row.page_count) || row.page_count<0 || row.page_count>rowLimit
        || !Number.isInteger(row.candidate_count) || row.candidate_count<row.page_count || row.candidate_count>rowLimit
        || typeof row.page_json !== 'string' || row.page_utf8_bytes !== Buffer.byteLength(row.page_json)
        || row.page_utf8_bytes>limits.page_utf8_bytes) fail('page_corrupt');
      bytes += row.page_utf8_bytes; if (bytes>limits.operation_utf8_bytes) fail('operation_limit');
      let rows; try {rows=JSON.parse(row.page_json);} catch {fail('page_corrupt');}
      if (!Array.isArray(rows) || rows.length!==row.page_count || rows.length>Number(population[input.kind==='parcels'?'parcel_count':'account_count'])) fail('page_corrupt');
      let last = previous;
      rows = rows.map(raw => {
        const item = data(raw,input.kind==='parcels'?['object_id','account_id','geometry_sha256','source_record_hash']:['account_id','parcel_count']);
        const key = cursor(input.kind==='parcels'?item.object_id:item.account_id,input.kind);
        if (!advances(key,last,input.kind) || !account(item.account_id) && !(input.kind==='parcels' && item.account_id===null)) fail('page_corrupt');
        if (input.kind==='parcels' ? !HASH.test(item.geometry_sha256 ?? '') || (item.source_record_hash!==null && typeof item.source_record_hash!=='string')
          : !count(item.parcel_count) || item.parcel_count==='0' || Number(item.parcel_count)>Number(population.parcel_count)) fail('page_corrupt');
        last = key; return Object.freeze(item);
      });
      if (row.next_cursor!==last || rows.length===0 && row.candidate_count!==0
        || previous==='' && rows.length===0 && population[input.kind==='parcels'?'parcel_count':'account_count']!=='0') fail('page_unavailable');
      if (JSON.stringify(metadata(await port.query(HEADER,[pin.generation_id]),pin.generation_id))!==JSON.stringify(original)
        || JSON.stringify(await jobs.readPreparedGeneration(claim,jobOptions))!==JSON.stringify(pin)) fail('source_changed');
      check();
      cachedPopulation = Object.freeze({original,validity:Object.freeze(validity),population:Object.freeze(population)});
      const definition = neighborhoodFrozenSpatialDefinition(claim,pin.generation_id,geometry.geometry_input,discovery);
      return Object.freeze({status:'spatial_page',authority:'not_established',coverage:'page_only',original,definition,
        definition_sha256:assessmentEvidenceDigest(definition),population:Object.freeze({...population,...validity}),
        kind:input.kind,after:previous,next_cursor:last,rows:Object.freeze(rows),
        end_of_roster:row.candidate_count<rowLimit && rows.length===row.candidate_count,page_utf8_bytes:row.page_utf8_bytes});
    } finally {busy=false;}
  } });
}
