import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { resolveNeighborhoodOriginalSourceResolutionV3 } from './neighborhoodOriginalSourceResolutionV3.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=()=>{throw new TypeError('neighborhood_first_source_resolution_candidate_v3_invalid');};
function data(v,keys){
  if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail();
  const d=Object.getOwnPropertyDescriptors(v);
  if(Reflect.ownKeys(d).length!==keys.length||!keys.every(k=>d[k]?.enumerable&&Object.hasOwn(d[k],'value')))fail();
  return Object.fromEntries(keys.map(k=>[k,d[k].value]));
}
function integer(v,max){if(!Number.isSafeInteger(v)||Object.is(v,-0)||v<0||v>max)fail();return v;}
function ref(v,max){const r=data(v,['content_sha256','canonical_utf8_bytes']),p=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(p.canonical_utf8_bytes)>max)fail();return p;}
function plan(value){
  const p=data(value,['format','command_id','generation_id','index_reference','index_sequence','selected_stock_count',
    'registered_source_keys','registered_legacy_keys','source','selected_entry','read_only','originals_reconciled','source_authority','economic_transaction']);
  if(p.format!=='cohort_completed_index_first_source_plan_v3'||p.read_only!==true||p.originals_reconciled!==false
    ||p.source_authority!==false||p.economic_transaction!==false||![p.command_id,p.generation_id].every(v=>typeof v==='string'&&UUID.test(v))
    ||integer(p.selected_stock_count,2000000)<1||p.index_sequence!==p.selected_stock_count+1)fail();
  integer(p.registered_source_keys,500000000);integer(p.registered_legacy_keys,500000000);
  if(p.registered_source_keys+p.registered_legacy_keys>p.selected_stock_count*250)fail();
  const source=data(p.source,['kind','native_key','first_selected_ordinal']);
  if(!['source_record','legacy_sale'].includes(source.kind)||typeof source.native_key!=='string'
    ||!/^[1-9][0-9]{0,18}$/.test(source.native_key)||BigInt(source.native_key)>9223372036854775807n
    ||integer(source.first_selected_ordinal,p.selected_stock_count)<1
    ||(source.kind==='source_record'?p.registered_source_keys<1:p.registered_source_keys!==0||p.registered_legacy_keys<1))fail();
  const member=data(p.selected_entry,['account_id','ordinal','partition_ordinal','entry_reference','metric_row_reference','contribution_row_reference']);
  if(member.ordinal!==source.first_selected_ordinal||integer(member.partition_ordinal,2000000)<1
    ||typeof member.account_id!=='string'||!member.account_id||member.account_id.length>64||!member.account_id.isWellFormed()
    ||member.account_id.trim()!==member.account_id||/[\u0000-\u001f\u007f]/.test(member.account_id))fail();
  return Object.freeze({...p,index_reference:ref(p.index_reference,4096),source:Object.freeze(source),
    selected_entry:Object.freeze({...member,entry_reference:ref(member.entry_reference,1000000),
      metric_row_reference:ref(member.metric_row_reference,4096),contribution_row_reference:ref(member.contribution_row_reference,4096)})});
}

function firstSeenMembership(value,p,check){
  const m=data(value,['subject_account_id','subject_selected_union_member','associations','coverage',
    'economic_property_membership','global_selected_native_deduplication']),a=m.associations;
  if(!Array.isArray(a)||isProxy(a)||Object.getPrototypeOf(a)!==Array.prototype||a.length>250
    ||Reflect.ownKeys(a).length!==a.length+1)fail();
  const rows=[];
  for(let i=0;i<a.length;i++){
    check();
    const d=Object.getOwnPropertyDescriptor(a,String(i));if(!d?.enumerable||!Object.hasOwn(d,'value'))fail();
    rows.push(Object.freeze(data(d.value,['kind','row_key','account_id','source_record_id','stock_member','selected_union_member'])));
  }
  // A selected association in another package from this whole account is not
  // evidence that this native FIRST package belongs to its first-seen account.
  if(!rows.some(r=>r.account_id===p.selected_entry.account_id&&r.stock_member===true&&r.selected_union_member===true
    &&(p.source.kind==='source_record'?r.source_record_id===p.source.native_key
      :r.kind==='sales'&&r.source_record_id===null&&r.row_key===p.source.native_key)))fail();
  return Object.freeze({...m,associations:Object.freeze(rows)});
}

/** Bounded DATA candidate, never a receipt, grant, cursor or phase-18 admission.
 * The closed original owner obtains/repeats this native FIRST plan itself and
 * supplies the entire reconciled package plus independent native membership.
 * The final argument checks its existing aggregate budget, not source rights.
 * This DATA function cannot establish the plan's origin or source authority.
 * No precomputed resolution, independent source key, DONE, sequence or prior
 * cursor input is accepted. Durable native row/head/checkpoint/yield guards
 * remain future work.
 */
export function prepareNeighborhoodFirstSourceResolutionCandidateV3(...args){
  if(args.length!==4||typeof args[3]!=='function')fail();
  const check=args[3];check();const p=plan(args[0]),membership=firstSeenMembership(args[2],p,check),
    resolution=resolveNeighborhoodOriginalSourceResolutionV3(args[1],membership,check);
  if(resolution.kind!==p.source.kind||resolution.native_key!==p.source.native_key)fail();
  const candidate=Object.freeze({format:'cohort_first_source_resolution_candidate_v3',command_id:p.command_id,
    generation_id:p.generation_id,transaction_index_reference:p.index_reference,transaction_index_sequence:p.index_sequence,
    selected_stock_count:p.selected_stock_count,selected_source:p.source,first_seen_selected_entry:p.selected_entry,resolution,
    usage:'first_whole_original_source_resolution_candidate_only',durable_source_resolution_issued:false,
    source_cursor_advanced:false,complete_selected_union:false,economic_transaction_eligibility:'not_established',
    quarter_statistics:'not_established',authority:'not_established',report_update:'none'});
  check();if(Buffer.byteLength(json(candidate))>12000)fail();return candidate;
}
