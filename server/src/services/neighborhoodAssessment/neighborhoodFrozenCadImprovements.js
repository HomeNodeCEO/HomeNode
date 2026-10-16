import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlob } from './cohortEvidenceBlobRepository.js';

/** Deep-freeze owned DATA definitions and receipts; not hostile-input admission. */
const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
export const NEIGHBORHOOD_FROZEN_CAD_IMPROVEMENT_LIMITS=Object.freeze({
  batch_size:250,rows_per_layer:2_000_000,row_utf8_bytes:1_000_000,page_utf8_bytes:32_000_000,
  total_utf8_bytes:8_000_000_000,maximum_runtime_ms:3_600_000,
});
const L=NEIGHBORHOOD_FROZEN_CAD_IMPROVEMENT_LIMITS;
const FIELDS=freeze({
  primary:['account_id','year_built','living_area_sqft','bedroom_count','bath_count','number_units','pool'],
  secondary:['id','account_id','sec_imp_number','sec_imp_type','sec_imp_sqft'],
});
const DEFINITION=freeze({id:'neighborhood-frozen-CAD-improvement-originals-v1',revision:'1',format_version:1,
  source_format:1,fields:FIELDS,limits:L,scope:'whole_CAD_source_same_snapshot_as_seven_layer_original_generation',
  original:'fixed_local_columns_decimal_and_integer_text_before_JSON_no_summary_or_inferred_amenity',
  identity:'primary_exact_account_key_secondary_native_bigint_key_not_sec_imp_number_deduplication',
  associations:'exact_original_account_FK_including_accounts_outside_any_future_job_geometry',
  missing:'no_row_or_null_is_not_zero_or_no_pool_or_no_garage',
  semantics:'local_stored_current_CAD_literals_not_verified_GLA_at_sale_or_historical_stock',
  limitations:['no_provider_dictionary_or_source_rights','no_amenity_resolution_or_sums','no_job_acquisition',
    'no_selected_statistics_or_report_update','no_legacy_capture_backfill'],
});
const definitionText=canonicalAssessmentJson(DEFINITION),definitionRef=prepareNeighborhoodCohortBlob(definitionText);
const PROFILE=freeze({profile_ref:{id:DEFINITION.id,revision:DEFINITION.revision,content_sha256:definitionRef.content_sha256},
  definition_blob:{ref:definitionRef,canonical_json:definitionText}});
/** Return the fixed immutable original-retention profile, without source authority. */
export function getNeighborhoodFrozenCadImprovementProfile(){return PROFILE;}
/** Refuse the whole companion operation with its namespaced protocol reason. */
function fail(reason){throw new TypeError(`neighborhood_frozen_CAD_improvements_${reason}`);}
/** Require one acknowledged SQL result row before interpreting its counters. */
const one=r=>{if(r?.rowCount!==1||r.rows?.length!==1)fail('invalid_result');return r.rows[0];};
const SNAPSHOT=`/* neighborhood-frozen-CAD:snapshot */ SELECT txid_current()::text AS transaction_id,
  pg_current_snapshot()::text AS source_snapshot,current_setting('transaction_isolation') AS isolation,
  current_setting('transaction_read_only') AS read_only,current_setting('TimeZone') AS timezone,
  to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at,pg_backend_pid() AS backend_pid`;
const SOURCE=`/* neighborhood-frozen-CAD:source */ SELECT generation.generation_id::text,generation.status AS generation_status,
  source.format_version,source.status,source.source_snapshot,
  to_char(source.source_transaction_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at
  FROM app.neighborhood_group_generations generation JOIN app.neighborhood_frozen_source_generations source USING(generation_id)
  WHERE generation.generation_id=$1::uuid FOR UPDATE OF generation NOWAIT`;
const COUNTS=freeze({
  primary:`/* neighborhood-frozen-CAD:count-primary */ SELECT count(*)::text AS row_count,
    coalesce(bool_or(account_id IS NULL OR account_id='' OR octet_length(account_id)>64 OR account_id<>btrim(account_id)),false) AS invalid_key
    FROM core.primary_improvements`,
  secondary:`/* neighborhood-frozen-CAD:count-secondary */ SELECT count(*)::text AS row_count,
    coalesce(bool_or(id IS NULL OR id<1 OR account_id IS NULL OR account_id='' OR octet_length(account_id)>64
      OR account_id<>btrim(account_id)),false) AS invalid_key FROM core.secondary_improvements`,
});
const PLANS={
  primary:{table:'core.primary_improvements',alias:'p',key:'account_id',keyType:'text',
    projection:'p.account_id,p.year_built::text,p.living_area_sqft::text,p.bedroom_count::text,p.bath_count::text,p.number_units::text,p.pool'},
  secondary:{table:'core.secondary_improvements',alias:'s',key:'id',keyType:'bigint',
    projection:'s.id::text,s.account_id,s.sec_imp_number::text,s.sec_imp_type,s.sec_imp_sqft::text'},
};
const PAGES=freeze(Object.fromEntries(Object.entries(PLANS).map(([kind,p])=>[kind,
  `/* neighborhood-frozen-CAD:${kind} */ WITH batch AS MATERIALIZED (
    SELECT ${p.alias}.${p.key}${kind==='primary'?' COLLATE "C"':''} AS source_order_key,${p.alias}.${p.key}::text AS row_key,${p.alias}.account_id,
      (SELECT to_jsonb(projected) FROM (SELECT ${p.projection}) projected) AS payload
    FROM ${p.table} ${p.alias} WHERE ($2::text='' OR ${p.alias}.${p.key}${kind==='primary'?' COLLATE "C"':''}>NULLIF($2,'')::${p.keyType})
    ORDER BY ${p.alias}.${p.key}${kind==='primary'?' COLLATE "C"':''} LIMIT $3::integer
  ), copied AS (
    INSERT INTO app.neighborhood_frozen_cad_improvement_rows(generation_id,kind,row_key,account_id,payload,payload_utf8_bytes,payload_sha256)
    SELECT $1::uuid,'${kind}',row_key,account_id,payload,octet_length(payload::text),encode(sha256(convert_to(payload::text,'UTF8')),'hex')
    FROM batch RETURNING payload_utf8_bytes AS bytes
  ) SELECT coalesce((SELECT row_key FROM batch ORDER BY source_order_key DESC LIMIT 1),$2)::text AS cursor,
    count(*)::integer AS copied,coalesce(sum(bytes),0)::text AS payload_utf8_bytes FROM copied`
])));
const BEGIN=`/* neighborhood-frozen-CAD:begin */ INSERT INTO app.neighborhood_frozen_cad_improvement_generations
  (generation_id,format_version,status,source_snapshot,source_transaction_started_at,profile_sha256,definition_json,expected_counts)
  VALUES($1::uuid,1,'building',$2,$3::timestamptz,$4,$5,$6::jsonb)`;
const COMPLETE=`/* neighborhood-frozen-CAD:complete */ UPDATE app.neighborhood_frozen_cad_improvement_generations
  SET status='complete',completed_at=clock_timestamp(),layer_counts=$2::jsonb,row_count=$3::bigint,payload_utf8_bytes=$4::bigint
  WHERE generation_id=$1::uuid AND status='building'`;
export const NEIGHBORHOOD_FROZEN_CAD_IMPROVEMENT_SQL=freeze({snapshot:SNAPSHOT,source:SOURCE,counts:COUNTS,pages:PAGES,begin:BEGIN,complete:COMPLETE});
/** Validate a writable RR/UTC snapshot receipt, preserving its exact timestamp. */
function snapshot(result){
  const r=one(result);
  if(r.isolation!=='repeatable read'||r.read_only!=='off'||r.timezone!=='UTC'||!Number.isInteger(r.backend_pid)||r.backend_pid<1
    ||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(r.started_at??'')
    ||!/^\d+:\d+:(?:\d+(?:,\d+)*)?$/.test(r.source_snapshot??'')||r.source_snapshot.length>65536
    ||!(/^[1-9][0-9]{0,19}$/).test(r.transaction_id??''))fail('caller_snapshot_required');
  return r;
}
/** Detach only supported own DATA options and enforce generation/time/page bounds. */
function options(raw){
  if(!raw||types.isProxy(raw)||Object.getPrototypeOf(raw)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(raw),keys=Reflect.ownKeys(ds);
  if(keys.some(k=>!['generationId','batchSize','maximumRuntimeMs','signal','checkBudget'].includes(k)
    ||!ds[k].enumerable||!Object.hasOwn(ds[k],'value')))fail('invalid_input');
  const r={batchSize:100,maximumRuntimeMs:L.maximum_runtime_ms,checkBudget:()=>{},...Object.fromEntries(keys.map(k=>[k,ds[k].value]))};
  if(typeof r.generationId!=='string'||!(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/).test(r.generationId)
    ||!Number.isInteger(r.batchSize)||r.batchSize<1||r.batchSize>L.batch_size||!Number.isInteger(r.maximumRuntimeMs)
    ||r.maximumRuntimeMs<1||r.maximumRuntimeMs>L.maximum_runtime_ms||typeof r.checkBudget!=='function'
    ||r.signal!==undefined&&!(r.signal instanceof AbortSignal))fail('invalid_input');
  return r;
}
/** Explicit inactive writer companion, not a later backfill. The caller owns
 * the SAME writable RR/UTC snapshot as the original sweep, before publishing
 * its descriptive generation. Only counts cross into Node. Any failure must
 * roll back the candidate; source rights and final publication belong to the
 * actual offline owner. No job, current report, source grant or COMMIT here. */
export async function materializeNeighborhoodFrozenCadImprovements(client,rawOptions){
  if(typeof client?.query!=='function')fail('invalid_input');
  const o=options(rawOptions),deadline=performance.now()+o.maximumRuntimeMs;
  /** Recheck cancellation and both owner/local budgets at each I/O boundary. */
  const check=()=>{if(o.signal?.aborted)fail('cancelled');o.checkBudget();if(o.signal?.aborted)fail('cancelled');
    if(performance.now()>=deadline)fail('runtime_limit');};
  /** Await actual SQL settlement within the remaining timeout, then recheck budgets. */
  const query=async(text,values=[])=>{check();const r=await client.query({text,values,
    query_timeout:Math.max(1,Math.min(120000,Math.ceil(deadline-performance.now())))});check();return r;};
  const start=snapshot(await query(SNAPSHOT));
  if(canonicalAssessmentJson(snapshot(await query(SNAPSHOT)))!==canonicalAssessmentJson(start))fail('caller_snapshot_changed');
  const source=one(await query(SOURCE,[o.generationId]));
  if(source.generation_id!==o.generationId||source.generation_status!=='building'||source.format_version!==1
    ||source.status!=='complete'||source.source_snapshot!==start.source_snapshot||source.started_at!==start.started_at)
    fail('same_building_source_snapshot_required');
  const expected={};
  for(const [kind,sql] of Object.entries(COUNTS)){
    const r=one(await query(sql));
    if(r.invalid_key!==false||typeof r.row_count!=='string'||!(/^(0|[1-9][0-9]{0,7})$/).test(r.row_count)
      ||Number(r.row_count)>L.rows_per_layer)fail('source_population_invalid');
    expected[kind]=r.row_count;
  }
  if((await query(BEGIN,[o.generationId,start.source_snapshot,start.started_at,PROFILE.profile_ref.content_sha256,
    PROFILE.definition_blob.canonical_json,JSON.stringify(expected)])).rowCount!==1)fail('header_lost');
  const counts={};let totalRows=0,totalBytes=0;
  for(const [kind,sql] of Object.entries(PAGES)){
    let cursor='',rows=0,bytes=0;
    for(;;){
      const r=one(await query(sql,[o.generationId,cursor,o.batchSize]));
      if(!Number.isInteger(r.copied)||r.copied<0||r.copied>o.batchSize||typeof r.cursor!=='string'||Buffer.byteLength(r.cursor)>256
        ||typeof r.payload_utf8_bytes!=='string'||!(/^(0|[1-9][0-9]{0,10})$/).test(r.payload_utf8_bytes))fail('invalid_page');
      const size=Number(r.payload_utf8_bytes);
      const advances=kind==='primary'?Buffer.compare(Buffer.from(r.cursor),Buffer.from(cursor))>0
        :(/^[1-9][0-9]{0,18}$/).test(r.cursor)&&BigInt(r.cursor)<=9223372036854775807n&&BigInt(r.cursor)>BigInt(cursor||'0');
      if(size>L.page_utf8_bytes||(r.copied===0?r.cursor!==cursor||size!==0:!advances||size<r.copied))fail('invalid_page');
      rows+=r.copied;bytes+=size;totalRows+=r.copied;totalBytes+=size;
      if(rows>L.rows_per_layer||totalBytes>L.total_utf8_bytes)fail('population_limit');
      if(rows>Number(expected[kind]))fail('source_population_incomplete');
      if(r.copied===0)break;cursor=r.cursor;
    }
    if(String(rows)!==expected[kind])fail('source_population_incomplete');
    counts[kind]={row_count:String(rows),payload_utf8_bytes:String(bytes)};
  }
  if(canonicalAssessmentJson(snapshot(await query(SNAPSHOT)))!==canonicalAssessmentJson(start))fail('caller_snapshot_changed');
  if((await query(COMPLETE,[o.generationId,JSON.stringify(counts),String(totalRows),String(totalBytes)])).rowCount!==1)fail('completion_lost');
  return freeze({status:'materialized',authority:'not_established',format_version:1,generation_id:o.generationId,
    source_snapshot:start.source_snapshot,source_transaction_started_at:start.started_at,profile:PROFILE,layer_counts:counts,
    row_count:String(totalRows),payload_utf8_bytes:String(totalBytes),source_acquisition:'not_established',report_update:'none'});
}
