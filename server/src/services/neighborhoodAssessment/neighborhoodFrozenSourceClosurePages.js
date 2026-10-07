import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { createNeighborhoodFrozenSpatialPages } from './neighborhoodFrozenSpatialPages.js';

export const NEIGHBORHOOD_FROZEN_CLOSURE_LIMITS = Object.freeze({
  rows:250,page_utf8_bytes:1_500_000,operation_utf8_bytes:32_000_000,pages:32,operation_ms:60_000,
});
const KINDS = Object.freeze({parcels:'bigint',accounts:'text',source_records:'bigint',sales:'bigint',
  sale_links:'bigint',sync_state:'text',sync_runs:'uuid'});
function fail(reason) {throw new TypeError(`neighborhood_frozen_closure_${reason}`);}
function data(value,required,optional=[]) {
  if(!value||types.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_input');
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
  if(!required.every(key=>keys.includes(key))||keys.some(key=>typeof key!=='string'||![...required,...optional].includes(key)
    ||!Object.hasOwn(descriptors[key],'value')||!descriptors[key].enumerable))fail('invalid_input');
  return Object.fromEntries(keys.map(key=>[key,descriptors[key].value]));
}
function cursor(value,type) {
  if(typeof value!=='string'||Buffer.byteLength(value)>256||value.includes('\0'))fail('invalid_cursor');
  if(!value)return value;
  if(type==='bigint'&&(!/^-?(?:0|[1-9][0-9]{0,18})$/.test(value)||BigInt(value)<-9223372036854775808n
    ||BigInt(value)>9223372036854775807n))fail('invalid_cursor');
  if(type==='uuid'&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))fail('invalid_cursor');
  return value;
}
function advances(next,previous,type) {
  return next!==''&&(previous===''||(type==='bigint'?BigInt(next)>BigInt(previous)
    :Buffer.compare(Buffer.from(next),Buffer.from(previous))>0));
}
function one(result) {
  if(result?.rowCount!==1||!Array.isArray(result.rows)||result.rows.length!==1)fail('invalid_result');return result.rows[0];
}
// This roster is computed ONLY from original stock membership. Linked outside
// accounts never feed back into it and cannot seed a second transaction hop.
const STOCK = `selected_accounts AS MATERIALIZED (
  SELECT DISTINCT account_id FROM app.neighborhood_frozen_source_rows
  WHERE generation_id=$1::uuid AND kind='parcels' AND account_id IS NOT NULL AND geom IS NOT NULL
    AND ST_DWithin(geom::geography,ST_SetSRID(ST_MakePoint($2::double precision,$3::double precision),4326)::geography,
      $4::double precision,true)
), seeds AS MATERIALIZED (
  SELECT DISTINCT original.source_record_id FROM selected_accounts selected
  JOIN app.neighborhood_frozen_source_rows original ON original.account_id=selected.account_id
  WHERE original.generation_id=$1::uuid AND original.kind IN ('source_records','sales','sale_links')
    AND original.source_record_id IS NOT NULL
)`;
const FILTER = Object.freeze({
  parcels:`EXISTS(SELECT 1 FROM selected_accounts selected WHERE selected.account_id=original.account_id)`,
  accounts:`EXISTS(SELECT 1 FROM selected_accounts selected WHERE selected.account_id=original.account_id)`,
  source_records:`EXISTS(SELECT 1 FROM seeds WHERE seeds.source_record_id=original.source_record_id)`,
  sale_links:`EXISTS(SELECT 1 FROM seeds WHERE seeds.source_record_id=original.source_record_id)`,
  sales:`(EXISTS(SELECT 1 FROM seeds WHERE seeds.source_record_id=original.source_record_id)
    OR (original.source_record_id IS NULL AND EXISTS(SELECT 1 FROM selected_accounts selected WHERE selected.account_id=original.account_id)))`,
  sync_state:`original.row_key='dcad_parcels'`,
  sync_runs:`EXISTS(SELECT 1 FROM app.neighborhood_frozen_source_rows state
      WHERE state.generation_id=$1::uuid AND state.kind='sync_state' AND state.row_key='dcad_parcels'
        AND state.payload->>'last_run_id'=original.row_key)
    OR EXISTS(SELECT 1 FROM app.neighborhood_frozen_source_rows parcel
      JOIN selected_accounts selected ON selected.account_id=parcel.account_id
      WHERE parcel.generation_id=$1::uuid AND parcel.kind='parcels' AND parcel.payload->>'sync_run_id'=original.row_key)`,
});
export const NEIGHBORHOOD_FROZEN_CLOSURE_SQL = Object.freeze(Object.fromEntries(Object.entries(KINDS).map(([kind,type])=>{
  const order=type==='text'?'original.row_key COLLATE "C"':`original.row_key::${type}`;
  return [kind,`/* neighborhood-frozen-closure:${kind} */ WITH ${STOCK}, candidates AS MATERIALIZED (
    SELECT original.row_key,${order} AS ordering,
      jsonb_build_object('row_key',original.row_key,'payload_text',original.payload::text) AS encoded
    FROM app.neighborhood_frozen_source_rows original
    WHERE original.generation_id=$1::uuid AND original.kind='${kind}' AND (${FILTER[kind]})
      AND ($5::text='' OR ${order}>NULLIF($5,'')::${type}${type==='text'?' COLLATE "C"':''})
    ORDER BY ${order} LIMIT $6::integer
  ), sized AS (SELECT *,sum(octet_length(encoded::text)+2) OVER(ORDER BY ordering) AS prefix_bytes FROM candidates),
  admitted AS (SELECT * FROM sized WHERE prefix_bytes+2<=$7::bigint), page AS (
    SELECT coalesce(jsonb_agg(encoded ORDER BY ordering),'[]'::jsonb)::text AS page_json,count(*)::integer AS page_count FROM admitted
  ) SELECT page_json,page_count,octet_length(page_json)::integer AS page_utf8_bytes,
    (SELECT count(*)::integer FROM candidates) AS candidate_count,
    coalesce((SELECT row_key FROM admitted ORDER BY ordering DESC LIMIT 1),$5)::text AS next_cursor FROM page`];
})));

/** Internal fixed SQL source-closure DATA primitive, not a source grant.
 * A current-authorized owner must independently admit the NEW pinned spatial
 * roster purpose and original projection at both ends; the old account-array
 * capability cannot authorize this reader. It seeds all-date transactions only
 * from original stock accounts, retains every seeded sale/link (including
 * outside/unresolved package links), and only selected-stock cadastral rows.
 * No additional linked-account CAD read, second-hop sale discovery, date filter,
 * raw payload expansion, mutation, commit, HTTP mount or acquisition receipt.
 * Every source page is surrounded by real pinned spatial/claim/header checks.
 * Missing source identities remain for the later whole-acquisition validator;
 * a page/end is not whole-closure, current rights or report coverage proof.
 */
export function createNeighborhoodFrozenSourceClosurePages(client,rawOptions) {
  const options=data(rawOptions,['claim','scope','actorUserId','geometryInput','discovery'],['signal','checkBudget']);
  const spatial=createNeighborhoodFrozenSpatialPages(client,options),limits=NEIGHBORHOOD_FROZEN_CLOSURE_LIMITS;
  const checkBudget=options.checkBudget??(()=>{}),deadline=performance.now()+limits.operation_ms;
  let busy=false,pages=0,bytes=0;
  const check=()=>{if(options.signal?.aborted)fail('cancelled');checkBudget();
    if(options.signal?.aborted)fail('cancelled');if(performance.now()>=deadline)fail('deadline');};
  return Object.freeze({async page(rawPage) {
    const input=data(rawPage,['kind','cursor'],['rowLimit']);
    if(typeof input.kind!=='string'||!Object.hasOwn(KINDS,input.kind))fail('invalid_kind');
    const type=KINDS[input.kind],previous=cursor(input.cursor,type),rowLimit=input.rowLimit??100;
    if(!Number.isInteger(rowLimit)||rowLimit<1||rowLimit>limits.rows)fail('invalid_limit');
    check();if(busy)fail('concurrent_read');if(++pages>limits.pages)fail('operation_limit');busy=true;
    try {
      const start=await spatial.page({kind:'parcels',cursor:'',rowLimit:1});
      if(!start.population.subject_included)fail('subject_outside_scope');
      check();
      const row=one(await client.query({text:NEIGHBORHOOD_FROZEN_CLOSURE_SQL[input.kind],values:[
        start.original.generation_id,...start.definition.geometry_input.coordinates,start.definition.discovery.radius_metres,
        previous,rowLimit,limits.page_utf8_bytes],query_timeout:Math.max(1,Math.min(5000,Math.ceil(deadline-performance.now())))}));
      check();
      if(!Number.isInteger(row.page_count)||row.page_count<0||row.page_count>rowLimit
        ||!Number.isInteger(row.candidate_count)||row.candidate_count<row.page_count||row.candidate_count>rowLimit
        ||typeof row.page_json!=='string'||row.page_utf8_bytes!==Buffer.byteLength(row.page_json)
        ||row.page_utf8_bytes>limits.page_utf8_bytes)fail('page_corrupt');
      bytes+=row.page_utf8_bytes;if(bytes>limits.operation_utf8_bytes)fail('operation_limit');
      let rows;try{rows=JSON.parse(row.page_json);}catch{fail('page_corrupt');}
      if(!Array.isArray(rows)||rows.length!==row.page_count||rows.length>Number(start.original.layer_counts[input.kind].row_count))fail('page_corrupt');
      let last=previous;rows=rows.map(raw=>{
        const item=data(raw,['row_key','payload_text']);cursor(item.row_key,type);
        if(!advances(item.row_key,last,type)||typeof item.payload_text!=='string'||Buffer.byteLength(item.payload_text)>1_000_000)fail('page_corrupt');
        let payload;try{payload=JSON.parse(item.payload_text);}catch{fail('page_corrupt');}
        if(!payload||typeof payload!=='object'||Array.isArray(payload))fail('page_corrupt');
        last=item.row_key;return Object.freeze(item);
      });
      if(row.next_cursor!==last||rows.length===0&&row.candidate_count!==0)fail('page_unavailable');
      const end=await spatial.page({kind:'parcels',cursor:'',rowLimit:1});
      if(end.definition_sha256!==start.definition_sha256||JSON.stringify(end.original)!==JSON.stringify(start.original)
        ||JSON.stringify(end.population)!==JSON.stringify(start.population))fail('source_changed');
      check();return Object.freeze({status:'source_closure_page',authority:'not_established',coverage:'page_only',
        original:start.original,spatial_definition:start.definition,spatial_definition_sha256:start.definition_sha256,
        stock_population:start.population,source_scope:'all_dates_one_hop_seeded_only_from_original_stock_accounts',
        additional_cadastral_accounts:false,kind:input.kind,after:previous,next_cursor:last,rows:Object.freeze(rows),
        end_of_layer:row.candidate_count<rowLimit&&rows.length===row.candidate_count,page_utf8_bytes:row.page_utf8_bytes});
    } finally{busy=false;}
  } });
}
