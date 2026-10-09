import { types } from 'node:util';
import { assessmentEvidenceDigest, canonicalAssessmentJson } from './contract.js';
import { createNeighborhoodFrozenJobStock } from './neighborhoodFrozenJobStock.js';
import { COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS as KINDS } from './cohortOriginalSourceChainV1.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL, NEIGHBORHOOD_FROZEN_JOB_IDENTITY_COVERAGE_SQL }
  from './neighborhoodFrozenSourceClosurePages.js';

const FORMAT='frozen_job_source_identity_progress_v1',MAX=2_000_000;
function fail(reason){throw new TypeError(`neighborhood_frozen_source_identity_${reason}`);}
function data(value,keys){
  if(!value||types.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(ds);
  if(names.length!==keys.length||!keys.every(k=>names.includes(k)&&ds[k].enumerable&&Object.hasOwn(ds[k],'value')))
    fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
const same=(a,b)=>canonicalAssessmentJson(a)===canonicalAssessmentJson(b);
const integer=n=>Number.isSafeInteger(n)&&n>=0&&n<=MAX;
function cursor(value,kind){
  if(typeof value!=='string'||Buffer.byteLength(value)>256||/[\u0000-\u001f\u007f]/.test(value))fail('invalid_progress');
  if(!value)return value;
  if(kind==='accounts'||kind==='sync_state')return value;
  if(kind==='sync_runs'){if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))fail('invalid_progress');}
  else if(!/^(?:0|[1-9][0-9]{0,18})$/.test(value)||BigInt(value)>9223372036854775807n||kind!=='parcels'&&value==='0')fail('invalid_progress');
  return value;
}
function progressOf(raw){
  if(raw===null)return null;
  const p=data(raw,['format','binding_sha256','kind_index','after','layer_rows','unknown_parcel_origins','missing_account_count']);
  if(p.format!==FORMAT||typeof p.binding_sha256!=='string'||!/^[a-f0-9]{64}$/.test(p.binding_sha256)
    ||!Number.isInteger(p.kind_index)||p.kind_index<0||p.kind_index>KINDS.length||!integer(p.layer_rows)
    ||!integer(p.unknown_parcel_origins)||!(p.missing_account_count===null||integer(p.missing_account_count)))fail('invalid_progress');
  cursor(p.after,KINDS[p.kind_index]??'accounts');
  if((p.after==='')!==(p.layer_rows===0)||p.kind_index===KINDS.length&&(p.after!==''||p.missing_account_count===null)
    ||p.kind_index<KINDS.length&&p.missing_account_count!==null)fail('invalid_progress');
  return Object.freeze(p);
}
// Closed DATA validation only; an independently issued V2 head must establish
// continuation provenance. Exporting this shape does not make DONE a grant.
export const prepareNeighborhoodFrozenSourceIdentityProgress=progressOf;
function one(result){if(result?.rowCount!==1||result.rows?.length!==1)fail('invalid_result');return result.rows[0];}

/** ONE bounded identity/one-hop-association step, not a numerical acquisition
 * receipt. The actual owner must already have verified the full original graph
 * and geographic stock and must authorize CURRENT actor/source purpose at both
 * transaction ends. Progress is loaded solely from its fenced checkpoint.
 * All seven exact original scopes/counts are checked in SQL, no dense IDs or
 * decimal/geometry payloads enter Node, no fuzzy account matching or second hop.
 * Missing core-account rows and unknown parcel sync origins stay explicit;
 * source freshness, historical stock, observations and Apply remain unproved.
 */
export function createNeighborhoodFrozenJobSourceIdentity(client,rawOptions,rawGraph){
  const options=data(rawOptions,['claim','scope','actorUserId','geometryInput','discovery','subjectIntent','checkBudget']);
  if(typeof options.checkBudget!=='function')fail('invalid_input');
  const graph=data(rawGraph,['root','layer_counts']),ref=data(graph.root,['content_sha256','canonical_utf8_bytes']);
  const root=prepareNeighborhoodCohortBlobReference(ref.content_sha256,ref.canonical_utf8_bytes);
  const counts=data(graph.layer_counts,KINDS);
  if(KINDS.some(k=>!integer(counts[k])))fail('invalid_input');
  const graphDigest=assessmentEvidenceDigest({root,layer_counts:counts}),store=createNeighborhoodFrozenJobStock(client,options);
  const check=options.checkBudget;let busy=false;
  return Object.freeze({async step(rawProgress){
    const saved=progressOf(rawProgress);check();if(busy)fail('concurrent_operation');busy=true;
    try{
      const stock=await store.read();check();const digest=assessmentEvidenceDigest({stock,graph_sha256:graphDigest});
      const p=saved??{format:FORMAT,binding_sha256:digest,kind_index:0,after:'',layer_rows:0,
        unknown_parcel_origins:0,missing_account_count:null};
      if(p.binding_sha256!==digest||p.unknown_parcel_origins>counts.parcels
        ||p.kind_index<KINDS.length&&p.layer_rows>counts[KINDS[p.kind_index]]
        ||p.missing_account_count!==null&&p.missing_account_count>Number(stock.population.account_count))fail('binding_changed');
      if(p.kind_index===KINDS.length)return Object.freeze({status:'source_identity_progress',authority:'not_established',
        coverage:'identity_and_one_hop_associations_only',progress:saved,advanced:false,all_layers_verified:true});
      const kind=KINDS[p.kind_index],row=one(await client.query({text:NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL[kind],
        values:[stock.generation_id,stock.operation_id,p.after],query_timeout:5000}));check();
      if(!Number.isInteger(row.page_count)||row.page_count<0||row.page_count>250
        ||!Number.isInteger(row.candidate_count)||row.candidate_count<row.page_count||row.candidate_count>250
        ||!Number.isInteger(row.invalid_count)||row.invalid_count!==0
        ||!Number.isInteger(row.unknown_origin_count)||row.unknown_origin_count<0||row.unknown_origin_count>row.page_count
        ||kind!=='parcels'&&row.unknown_origin_count!==0
        ||(row.page_count===0)!==(row.last_row_key===null)||row.page_count===0&&row.candidate_count!==0)fail('identity_mismatch');
      const after=row.last_row_key??p.after;cursor(after,kind);
      if(row.last_row_key!==null&&p.after!==''&&(kind==='accounts'||kind==='sync_state'||kind==='sync_runs'
        ?Buffer.compare(Buffer.from(after),Buffer.from(p.after))<=0:BigInt(after)<=BigInt(p.after)))fail('invalid_progress');
      const seen=p.layer_rows+row.page_count,ended=row.candidate_count<250&&row.page_count===row.candidate_count;
      if(seen>counts[kind]||ended&&seen!==counts[kind])fail('layer_count_mismatch');
      let next={...p,kind_index:p.kind_index+(ended?1:0),after:ended?'':after,layer_rows:ended?0:seen,
        unknown_parcel_origins:p.unknown_parcel_origins+row.unknown_origin_count};
      if(next.kind_index===KINDS.length){const coverage=one(await client.query({text:NEIGHBORHOOD_FROZEN_JOB_IDENTITY_COVERAGE_SQL,
        values:[stock.generation_id,stock.operation_id],query_timeout:5000}));check();
        if(!integer(coverage.missing_account_count)||coverage.missing_account_count>Number(stock.population.account_count))fail('invalid_result');
        next={...next,missing_account_count:coverage.missing_account_count};}
      next=progressOf(next);
      if(!same(await store.read(),stock))fail('binding_changed');check();
      return Object.freeze({status:'source_identity_progress',authority:'not_established',coverage:'identity_and_one_hop_associations_only',
        progress:next,advanced:true,all_layers_verified:next.kind_index===KINDS.length});
    }finally{busy=false;}
  }});
}
