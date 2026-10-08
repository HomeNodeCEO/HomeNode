import { types } from 'node:util';
import { assessmentEvidenceDigest, canonicalAssessmentJson } from './contract.js';
import { createNeighborhoodFrozenJobStock } from './neighborhoodFrozenJobStock.js';

const MAX_SEEDS=6_000_000;
const DEFINITION=Object.freeze({id:'neighborhood-frozen-job-source-seeds-v1',revision:'1',
  population:'exact_completed_pinned_geographic_stock_accounts',
  seed_kinds:Object.freeze(['source_records','sales','sale_links']),
  seed_key:'distinct_nonnull_original_source_record_id',
  scope:'all_dates_one_hop_only_no_linked_account_CAD_or_second_hop',
  dangling_seeds:'retained_for_independent_identity_refusal',
  limits:Object.freeze({seeds:MAX_SEEDS,query_ms:5000}),
  authority:'not_established',coverage:'seed_lookup_only'});
const definitionText=canonicalAssessmentJson(DEFINITION),definitionHash=assessmentEvidenceDigest(DEFINITION);
const PROFILE=Object.freeze({id:DEFINITION.id,revision:DEFINITION.revision,content_sha256:definitionHash});
const KEYS=['generation_id','binding_sha256','definition_sha256','definition_json','status','seed_count','completed_at'];
export const NEIGHBORHOOD_FROZEN_JOB_SEED_SQL=Object.freeze({
  read:`/* neighborhood-frozen-job-seeds:read */ SELECT generation_id,binding_sha256,definition_sha256,
    definition_json,status,seed_count::text,
    to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_at
    FROM app.neighborhood_custom_cohort_seed_indexes
    WHERE operation_id=$1::uuid AND generation_id=$2::uuid FOR SHARE NOWAIT`,
  begin:`/* neighborhood-frozen-job-seeds:begin */ INSERT INTO app.neighborhood_custom_cohort_seed_indexes
    (operation_id,generation_id,binding_sha256,definition_sha256,definition_json)
    VALUES($1::uuid,$2::uuid,$3,$4,$5) ON CONFLICT(operation_id) DO NOTHING RETURNING operation_id`,
  rows:`/* neighborhood-frozen-job-seeds:rows */ WITH inserted AS (
    INSERT INTO app.neighborhood_custom_cohort_source_seeds(operation_id,generation_id,source_record_id)
    SELECT $1::uuid,$2::uuid,original.source_record_id
    FROM app.neighborhood_custom_cohort_stock_accounts stock
    JOIN app.neighborhood_frozen_source_rows original ON original.account_id=stock.account_id
    WHERE stock.operation_id=$1::uuid AND original.generation_id=$2::uuid
      AND original.kind IN ('source_records','sales','sale_links') AND original.source_record_id IS NOT NULL
    GROUP BY original.source_record_id RETURNING source_record_id
  ) SELECT count(*)::text AS inserted_count FROM inserted`,
  complete:`/* neighborhood-frozen-job-seeds:complete */ UPDATE app.neighborhood_custom_cohort_seed_indexes
    SET status='complete',seed_count=$3::bigint,completed_at=clock_timestamp()
    WHERE operation_id=$1::uuid AND generation_id=$2::uuid AND status='building'
    RETURNING seed_count::text`,
});
function fail(reason){throw new TypeError(`neighborhood_frozen_job_seeds_${reason}`);}
function data(value,required,optional=[]){
  if(!value||types.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(ds);
  if(!required.every(k=>keys.includes(k))||keys.some(k=>typeof k!=='string'||![...required,...optional].includes(k)
    ||!ds[k].enumerable||!Object.hasOwn(ds[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
const same=(a,b)=>canonicalAssessmentJson(a)===canonicalAssessmentJson(b);
const one=r=>{if(r?.rowCount!==1||r.rows?.length!==1)fail('invalid_result');return r.rows[0];};
const count=value=>typeof value==='string'&&/^(?:0|[1-9][0-9]{0,6})$/.test(value)&&Number(value)<=MAX_SEEDS;

/** Prepare or read one exact job-stock all-date source seed index.
 * This is internal DATA, not source authority. The actual capture owner checks
 * current actor/assignment/subject/CAD/source-purpose rights before constructing
 * it and again before commit. A caller owns the transaction and rollback. Every
 * method independently reopens the real scoped stock/claim/pin at both ends.
 * Preparation publishes atomically; the database independently verifies both
 * set differences, not just equal counts. Reads never rebuild a missing cache.
 */
export function createNeighborhoodFrozenJobSourceSeeds(client,rawOptions){
  const options=data(rawOptions,['claim','scope','actorUserId','geometryInput','discovery','subjectIntent','checkBudget'],['signal']);
  const {signal,...stockOptions}=options;
  if(typeof options.checkBudget!=='function'||signal!==undefined&&!(signal instanceof AbortSignal))fail('invalid_input');
  const stockStore=createNeighborhoodFrozenJobStock(client,stockOptions),check=()=>{
    if(signal?.aborted)fail('cancelled');options.checkBudget();if(signal?.aborted)fail('cancelled');
  };
  let busy=false,queries=0;
  const query=async(text,values)=>{
    check();if(++queries>128)fail('operation_limit');
    const result=await client.query({text,values,query_timeout:5000});check();return result;
  };
  async function execute(preparing){
    check();if(busy)fail('concurrent_operation');busy=true;
    try{
      const stock=await stockStore.read();check();
      const bindingHash=assessmentEvidenceDigest({profile_ref:PROFILE,stock});
      const parameters=[stock.operation_id,stock.generation_id];
      const maximum=Math.min(MAX_SEEDS,['source_records','sales','sale_links']
        .reduce((n,k)=>n+Number(stock.original.layer_counts[k].row_count),0));
      const decode=raw=>{
        const row=data(raw,KEYS);
        if(row.generation_id!==stock.generation_id||row.binding_sha256!==bindingHash
          ||row.definition_sha256!==definitionHash||row.definition_json!==definitionText
          ||row.status!=='complete'||!count(row.seed_count)||Number(row.seed_count)>maximum
          ||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(row.completed_at??''))fail('unfinished_or_changed_index');
        return Object.freeze(row);
      };
      let header=await query(NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.read,parameters);
      if(header?.rowCount===0&&header.rows?.length===0&&preparing){
        const begunResult=await query(NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.begin,
          [...parameters,bindingHash,definitionHash,definitionText]);
        // Another same-stock builder may commit between the miss and INSERT.
        // Reopen its exact header, never insert/complete its rows or repair it.
        // The ordinary decode and ending stock/claim fences still must pass.
        if(!(begunResult?.rowCount===0&&begunResult.rows?.length===0)){
          const begun=data(one(begunResult),['operation_id']);
          if(begun.operation_id!==stock.operation_id)fail('invalid_result');
          const inserted=data(one(await query(NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.rows,parameters)),['inserted_count']);
          if(!count(inserted.inserted_count)||Number(inserted.inserted_count)>maximum)fail('population_limit');
          const completed=data(one(await query(NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.complete,
            [...parameters,inserted.inserted_count])),['seed_count']);
          if(completed.seed_count!==inserted.inserted_count)fail('invalid_result');
        }
        header=await query(NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.read,parameters);
      }
      const decoded=decode(one(header));
      if(!same(await stockStore.read(),stock))fail('stock_changed');check();
      if(!same(decode(one(await query(NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.read,parameters))),decoded))fail('index_changed');
      return Object.freeze({seed_index_version:1,profile_ref:PROFILE,binding_sha256:bindingHash,
        generation_id:stock.generation_id,operation_id:stock.operation_id,seed_count:decoded.seed_count,
        authority:'not_established',coverage:'seed_lookup_only',stock});
    }finally{busy=false;}
  }
  return Object.freeze({prepare:()=>execute(true),read:()=>execute(false)});
}
