import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { createCustomCohortCompletedIndexNextSourceV3Repository,
  createCustomCohortOwnedNextSourceV3Repository } from './customCohortCompletedIndexNextSourceV3Repository.js';
import { COMPLETED_INDEX_NEXT_SOURCE_CONTEXT_V3_SQL as NATIVE_NEXT,
  OWNED_NEXT_SOURCE_CONTEXT_V3_SQL as OWNED_NEXT } from './completedIndexNextSourceV3Sql.js';

const MEMBER=['account_id','ordinal','partition_ordinal','entry_reference','metric_row_reference','contribution_row_reference'];
const ORIGINAL_MEMBER=['account_id','ordinal','partition_ordinal','entry_reference','state','assigned_group_id','row_reference',
  'contribution_row_reference','numeric_index_ordinal','reported_year_built','reported_residential_area','reported_site_area',
  'numeric_population_ordinal','semantic_population_ordinal'];
const fail=reason=>{throw new TypeError(`custom_cohort_completed_index_next_source_account_v3_${reason}`);};
const same=(a,b)=>json(a)===json(b);
function data(v,keys){
  if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const d=Object.getOwnPropertyDescriptors(v);
  if(Reflect.ownKeys(d).length!==keys.length||!keys.every(k=>d[k]?.enumerable&&Object.hasOwn(d[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,d[k].value]));
}
function ref(v,max=4096){const r=data(v,['content_sha256','canonical_utf8_bytes']),p=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(p.canonical_utf8_bytes)>max)fail('native_member_corrupt');return p;}
function originalMember(value,selected){
  const raw=data(value,ORIGINAL_MEMBER),m={...raw,entry_reference:ref(raw.entry_reference,1000000),
    row_reference:ref(raw.row_reference),contribution_row_reference:ref(raw.contribution_row_reference)};
  if(!same(Object.fromEntries(MEMBER.map(k=>[k,k==='metric_row_reference'?m.row_reference:m[k]])),selected)
    ||!['assigned','unassigned'].includes(m.state)||(m.state==='assigned'?typeof m.assigned_group_id!=='string'
      ||!/^recorded-cad:[a-f0-9]{64}$/.test(m.assigned_group_id):m.assigned_group_id!==null)
    ||['numeric_index_ordinal','numeric_population_ordinal','semantic_population_ordinal'].some(k=>m[k]!==selected.ordinal))fail('native_member_corrupt');
  for(const key of ['reported_year_built','reported_residential_area','reported_site_area']){
    const v=m[key];if(v!==null&&(typeof v!=='string'||v.length>31||!/^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/.test(v)
      ||v.replace('.','').length>30||(v.split('.')[1]?.length??0)>12))fail('native_member_corrupt');
  }
  const {semantic_population_ordinal,...entry}=m;return Object.freeze(entry);
}
function key(value,maxOrdinal){
  const p=data(value,['kind','native_key','first_selected_ordinal']);
  if(!['source_record','legacy_sale'].includes(p.kind)||typeof p.native_key!=='string'||!/^[1-9][0-9]{0,18}$/.test(p.native_key)
    ||BigInt(p.native_key)>9223372036854775807n||!Number.isSafeInteger(p.first_selected_ordinal)
    ||p.first_selected_ordinal<1||p.first_selected_ordinal>maxOrdinal)fail('native_key_set_corrupt');
  return Object.freeze(p);
}
function compare(a,b){return a.kind===b.kind?(a.kind==='source_record'
  ?BigInt(a.native_key)<BigInt(b.native_key)?-1:BigInt(a.native_key)>BigInt(b.native_key)?1:0
  :Buffer.compare(Buffer.from(a.native_key),Buffer.from(b.native_key))):a.kind==='source_record'?-1:1;}

// READ ONLY bounded native account metadata for the actual completed-index
// NEXT after FIRST. The context owner must separately reopen WHOLE originals and ENTIRE
// caches, reconcile every field/key in both directions and repeat this query
// after ALL ending fences. No receipt, economic progress or source grant.
function createRepository(args,owned){
  if(args.length!==1)fail('invalid_input');
  const raw=data(args[0],['client','claim','scope','actorUserId']),o={...raw,
    claim:Object.freeze(data(raw.claim,['operation_id','claim_token','attempts'])),
    scope:Object.freeze(data(raw.scope,['organization_id','report_file_id','assignment_file_id','account_id']))};
  // The prerequisite validates the closed scope/claim without accepting any
  // account, source key, ordinal, generation, callback or caller cursor.
  const first=(owned?createCustomCohortOwnedNextSourceV3Repository:createCustomCohortCompletedIndexNextSourceV3Repository)(o);
  let observed=null,transaction=null;
  return Object.freeze({async readNextAccount(...a){
    if(a.length)fail('invalid_input');
    if(transaction===null){
      const r=await o.client.query('/* custom-cohort-completed-index-next-source-account-v3:transaction */ SELECT txid_current()::text AS transaction_id');
      if(r?.rowCount!==1||r.rows?.length!==1)fail('caller_transaction_required');
      transaction=data(r.rows[0],['transaction_id']).transaction_id;
      if(typeof transaction!=='string'||!/^[1-9][0-9]{0,19}$/.test(transaction))fail('caller_transaction_required');
    }
    const source=await first.readNextSource();
    if(source.source===null||source.selected_entry===null)fail('no_registered_source');
    const result=await o.client.query(`/* custom-cohort-completed-index-next-source-account-v3:native-account */
     WITH selected AS MATERIALIZED (${owned?OWNED_NEXT:NATIVE_NEXT}
      AND job.claim_token=$3::uuid AND job.attempts=$4::integer AND job.organization_id=$5::uuid
      AND job.report_file_id=$6::uuid AND job.assignment_file_id=$7::bigint AND job.account_id=$8 AND job.actor_user_id=$9::uuid
     ), anchors AS MATERIALIZED (
      SELECT original.kind,original.row_key,original.source_record_id FROM selected
      CROSS JOIN (VALUES ('source_records'),('sales'),('sale_links')) k(kind)
      CROSS JOIN LATERAL (SELECT o.kind,o.row_key,o.source_record_id FROM app.neighborhood_frozen_source_rows o
       WHERE o.generation_id=selected.generation_id AND o.kind=k.kind AND o.account_id=selected.account_id
       ORDER BY o.row_key COLLATE "C" LIMIT 251) original
     ), gate AS MATERIALIZED (SELECT count(*)::integer AS anchor_count FROM anchors), packages AS MATERIALIZED (
      SELECT edge.kind,edge.native_key,CASE edge.kind WHEN 'source_record' THEN sr.first_selected_ordinal
       ELSE ls.first_selected_ordinal END AS first_selected_ordinal
      FROM selected s CROSS JOIN gate
      JOIN app.neighborhood_custom_cohort_selected_transaction_index_v2_edges edge ON edge.operation_id=$1::uuid
       AND edge.organization_id=$5::uuid AND edge.generation_id=s.generation_id AND edge.account_id=s.account_id AND edge.ordinal=s.ordinal
      LEFT JOIN app.neighborhood_custom_cohort_selected_transaction_source_v2_keys sr ON sr.operation_id=edge.operation_id
       AND sr.organization_id=edge.organization_id AND sr.generation_id=edge.generation_id AND edge.kind='source_record'
       AND sr.source_record_id=edge.source_record_id
      LEFT JOIN app.neighborhood_custom_cohort_selected_transaction_legacy_v2_keys ls ON ls.operation_id=edge.operation_id
       AND ls.organization_id=edge.organization_id AND ls.generation_id=edge.generation_id AND edge.kind='legacy_sale'
       AND ls.legacy_sale_key=edge.legacy_sale_key
      WHERE gate.anchor_count<=250
      ORDER BY CASE edge.kind WHEN 'source_record' THEN 0 ELSE 1 END,
       CASE WHEN edge.kind='source_record' THEN edge.native_key::bigint END,
       CASE WHEN edge.kind='legacy_sale' THEN edge.native_key END COLLATE "C" LIMIT 251
     ) SELECT txid_current()::text AS transaction_id,s.index_reference,s.index_sequence,gate.anchor_count,
      coalesce((SELECT jsonb_agg(to_jsonb(packages) ORDER BY CASE kind WHEN 'source_record' THEN 0 ELSE 1 END,
       CASE WHEN kind='source_record' THEN native_key::bigint END,CASE WHEN kind='legacy_sale' THEN native_key END COLLATE "C") FROM packages),'[]'::jsonb) AS native_packages,
      jsonb_build_object('account_id',m.account_id,'ordinal',m.ordinal,'partition_ordinal',m.partition_ordinal,'entry_reference',m.entry_reference,
       'state',entry.state,'assigned_group_id',entry.assigned_group_id,'row_reference',m.metric_row_reference,
       'contribution_row_reference',m.row_reference,'numeric_index_ordinal',indexed.ordinal,
       'reported_year_built',indexed.reported_year_built::text,'reported_residential_area',indexed.reported_residential_area::text,
       'reported_site_area',indexed.reported_site_area::text,'numeric_population_ordinal',n.ordinal,'semantic_population_ordinal',semantic.ordinal) AS original_member
     FROM selected s CROSS JOIN gate
     JOIN app.neighborhood_custom_cohort_selected_statistics_v2_rows m ON m.operation_id=$1::uuid AND m.organization_id=$5::uuid
      AND m.account_id=s.account_id AND m.ordinal=s.ordinal AND m.partition_ordinal=s.partition_ordinal
      AND m.entry_reference=s.entry_reference AND m.metric_row_reference=s.metric_row_reference AND m.row_reference=s.contribution_row_reference
     JOIN app.neighborhood_custom_cohort_selected_numeric_v2_rows n ON n.operation_id=m.operation_id AND n.organization_id=m.organization_id
      AND n.account_id=m.account_id AND n.ordinal=m.ordinal AND n.partition_ordinal=m.partition_ordinal AND n.entry_reference=m.entry_reference
      AND n.metric_row_reference=m.metric_row_reference AND n.contribution_row_reference=m.row_reference
     JOIN app.neighborhood_custom_cohort_selected_numeric_index_v2_rows indexed ON indexed.operation_id=m.operation_id AND indexed.organization_id=m.organization_id
      AND indexed.account_id=m.account_id AND indexed.ordinal=m.ordinal AND indexed.contribution_row_reference=m.row_reference
     JOIN app.neighborhood_custom_cohort_selected_semantic_v2_rows semantic ON semantic.operation_id=m.operation_id AND semantic.organization_id=m.organization_id
      AND semantic.account_id=m.account_id AND semantic.ordinal=m.ordinal AND semantic.partition_ordinal=m.partition_ordinal AND semantic.entry_reference=m.entry_reference
      AND semantic.metric_row_reference=m.metric_row_reference AND semantic.contribution_row_reference=m.row_reference
     JOIN app.neighborhood_custom_cohort_selected_metrics_v2_rows metric ON metric.operation_id=m.operation_id AND metric.organization_id=m.organization_id
      AND metric.account_id=m.account_id AND metric.ordinal=m.ordinal AND metric.partition_ordinal=m.partition_ordinal
      AND metric.entry_reference=m.entry_reference AND metric.row_reference=m.metric_row_reference
     JOIN app.neighborhood_custom_cohort_selected_union_v2_rows u ON u.operation_id=metric.operation_id AND u.organization_id=metric.organization_id
      AND u.account_id=metric.account_id AND u.ordinal=metric.ordinal AND u.partition_ordinal=metric.partition_ordinal AND u.entry_reference=metric.entry_reference
     JOIN app.neighborhood_custom_cohort_recorded_partition_v2_rows entry ON entry.operation_id=u.operation_id AND entry.organization_id=u.organization_id
      AND entry.account_id=u.account_id AND entry.ordinal=u.partition_ordinal AND entry.entry_reference=u.entry_reference`,
    [o.claim.operation_id,source.generation_id,o.claim.claim_token,o.claim.attempts,o.scope.organization_id,
      o.scope.report_file_id,o.scope.assignment_file_id,o.scope.account_id,o.actorUserId]);
    if(result?.rowCount!==1||result.rows?.length!==1)fail('native_member_missing');
    const r=data(result.rows[0],['transaction_id','index_reference','index_sequence','anchor_count','native_packages','original_member']);
    if(r.transaction_id!==transaction)fail('caller_transaction_required');
    if(!same(ref(r.index_reference),source.index_reference)||r.index_sequence!==source.index_sequence
      ||!Number.isSafeInteger(r.anchor_count)||r.anchor_count<1||r.anchor_count>250)fail('native_member_corrupt');
    const aKeys=r.native_packages;
    if(!Array.isArray(aKeys)||isProxy(aKeys)||Object.getPrototypeOf(aKeys)!==Array.prototype||aKeys.length<1||aKeys.length>250
      ||aKeys.length>r.anchor_count||Reflect.ownKeys(aKeys).length!==aKeys.length+1)fail('native_key_set_corrupt');
    const packages=[];
    for(let i=0;i<aKeys.length;i++){
      const d=Object.getOwnPropertyDescriptor(aKeys,String(i));if(!d?.enumerable||!Object.hasOwn(d,'value'))fail('native_key_set_corrupt');
      const p=key(d.value,source.selected_stock_count);
      if(p.first_selected_ordinal>source.selected_entry.ordinal||i>0&&compare(packages[i-1],p)>=0)fail('native_key_set_corrupt');
      packages.push(p);
    }
    if(packages.filter(p=>same(p,source.source)).length!==1)fail('native_key_set_corrupt');
    const packet=Object.freeze({source_plan:source,previous:source.index_reference,
      plan:Object.freeze({generation_id:source.generation_id,selected_stock_count:source.selected_stock_count,
        selected_entry:source.selected_entry,anchor_count:r.anchor_count,native_packages:Object.freeze(packages)}),
      selected_entry:originalMember(r.original_member,source.selected_entry)});
    if(Buffer.byteLength(json(packet))>64000)fail('byte_limit');
    if(observed!==null&&!same(observed,packet))fail('native_account_changed');
    observed=packet;return packet;
  }});
}

// UNREGISTERED recovered5 first account. No cursor or original/source authority.
export function createCustomCohortCompletedIndexNextSourceAccountV3Repository(...args){return createRepository(args,false);}
export function createCustomCohortOwnedNextSourceAccountV3Repository(...args){return createRepository(args,true);}
