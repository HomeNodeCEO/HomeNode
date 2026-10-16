import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCohortRecordedCatalogBatchReceiptV3 as prepare } from '../src/services/neighborhoodAssessment/cohortRecordedCatalogBatchReceiptV3.js';
import { prepareCohortRecordedCatalogReceiptV2 as legacy } from '../src/services/neighborhoodAssessment/cohortRecordedCatalogReceiptV2.js';
import { createCustomCohortRecordedCatalogBatchV3Repository as repository } from '../src/services/neighborhoodAssessment/customCohortRecordedCatalogBatchV3Repository.js';
import { getNeighborhoodOriginalRecordedGroupV2Profile } from '../src/services/neighborhoodAssessment/neighborhoodOriginalRecordedGroupV2.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
  scope={organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'A'},
  binding={...scope,operation_id:id(3),generation_id:id(4),spatial_definition_sha256:'a'.repeat(64),source_original_sha256:'b'.repeat(64)},
  expected={binding,source_reference:ref(1),root:ref(2),graph_verification_reference:ref(3),stock_verification_reference:ref(4),
    identity_verification_reference:ref(5),stock_reference:ref(6),effective_date:'2026-10-16',stock_account_count:'9',
    traversal_reference:ref(7),profile_reference:getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref,partition_reference:ref(8)},
  group='recorded-cad:'+'a'.repeat(64),initial={after_account:'',account_count:0,done:false},
  count=n=>({assigned_accounts:Math.ceil(n/2),unassigned_accounts:Math.floor(n/2),assigned_groups:n?1:0}),
  account=n=>({account_id:'A'+n,geographic_parcel_count:'1',original_counts:{parcels:1,accounts:0}}),
  raw=(before=initial,ordinals=[1,2,3,4,5,6,7,8],sequence=1)=>({format:'cohort_recorded_catalog_batch_receipt_v3',...structuredClone(expected),
    sequence,previous:sequence===1?null:ref(9),before,after:ordinals.length?{after_account:'A'+ordinals.at(-1),account_count:before.account_count+ordinals.length,done:false}:{...before,done:true},
    accounts:ordinals.map(account),original_count:ordinals.length,entries:ordinals.map(n=>({account_id:'A'+n,ordinal:n,entry_reference:ref(9),
      state:n%2?'assigned':'unassigned',assigned_group_id:n%2?group:null})),before_counts:count(before.account_count),after_counts:count(before.account_count+ordinals.length)});

test('catalog batch DATA retains every assigned/unassigned ordinal in8+NEXT+EMPTY receipts without legacy reinterpretation',()=>{
  const a=prepare(raw(),expected),b=prepare(raw(a.after,[9],2),expected),empty=prepare(raw(b.after,[],3),expected);
  assert.equal(a.sequence,1);assert.equal(a.after.account_count,8);assert.deepEqual(a.after_counts,count(8));
  assert.equal(b.sequence,2);assert.equal(b.after.account_count,9);assert.equal(b.after.done,false);
  assert.equal(empty.sequence,3);assert.equal(empty.after.done,true);assert.deepEqual(empty.after_counts,count(9));
  assert.throws(()=>legacy(a,expected),/invalid/);assert.ok(Object.isFrozen(a.after_counts)&&Object.isFrozen(a.entries[0]));
  const r=raw(),copy=prepare(r,expected);r.after_counts.assigned_accounts=0;r.partition_reference.content_sha256='e'.repeat(64);
  assert.equal(copy.after_counts.assigned_accounts,4);assert.equal(copy.partition_reference.content_sha256,'8'.repeat(64));
});

test('catalog batch DATA refuses omitted denominator, changed native entries, over-cap groups, free DONE and executable data',()=>{
  for(const change of [r=>r.after_counts.assigned_accounts--,r=>r.after_counts.unassigned_accounts++,r=>r.after_counts.assigned_groups=2049,
    r=>r.after_counts.assigned_groups=0,r=>r.entries[0].state='unassigned',r=>r.entries.reverse(),r=>r.entries.pop(),
    r=>r.partition_reference=ref(1),r=>r.after.done=true,r=>r.members=[],r=>r.original_count=251]){
    const r=raw();change(r);assert.throws(()=>prepare(r,expected),/invalid/);
  }
  const hostile=raw();Object.defineProperty(hostile.after_counts,'assigned_groups',{enumerable:true,get(){assert.fail('getter');}});
  assert.throws(()=>prepare(hostile,expected),/invalid/);assert.throws(()=>prepare(new Proxy(raw(),{}),expected),/invalid/);
});

function setup(){
  const bound={source_reference:ref(1),root_reference:ref(2),graph_reference:ref(3),geographic_reference:ref(4),identity_reference:ref(5),
    stock_reference:ref(6),traversal_reference:ref(7),profile_reference:expected.profile_reference,partition_reference:ref(8)},calls=[];
  const client={async query(sql,values){calls.push({sql,values});
    if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:'40'}]};
    if(sql.includes(':anchor-read'))return {rowCount:1,rows:[Object.fromEntries([...Object.keys(bound),'receipt_reference','sequence'].map(k=>[k,null]))]};
    if(sql.includes(':contribute'))return {rowCount:1,rows:[{last_ordinal:values[11]}]};
    if(sql.includes(':counts'))return {rowCount:1,rows:[count(8)]};
    assert.fail(sql);
  }};
  return {calls,owner:repository({client,claim:{operation_id:id(3),claim_token:id(5),attempts:5},scope,actorUserId:id(6),...bound})};
}
const contribution=n=>({account_id:'A'+n,ordinal:n,group_id:n%2?group:'discovery:unassigned',normalized_county:n%2?'dallas':null,normalized_label:n%2?'alpha':null});

test('batch catalog storage charges one bounded count query after all8 native contributions, using existing tables and one caller transaction',async()=>{
  const f=setup();assert.deepEqual(await f.owner.contributeBatch(null,Array.from({length:8},(_,i)=>contribution(i+1))),count(8));
  assert.equal(f.calls.filter(c=>c.sql.includes(':counts')).length,1);assert.equal(f.calls.filter(c=>c.sql.includes(':contribute')).length,8);
  assert.ok(f.calls.at(-1).sql.includes(':counts'));
  for(const c of f.calls.filter(c=>c.sql.includes(':contribute'))){assert.match(c.sql,/recorded_catalog_v2_groups/);assert.doesNotMatch(c.sql,/recorded_catalog_batch_v3_groups/);}
  assert.equal(f.calls.some(c=>/\bBEGIN\b|\bCOMMIT\b|ST_DWithin/.test(c.sql)),false);
});

test('batch catalog storage rejects sparse, oversized, unordered and executable entries before SQL or coercion',async()=>{
  const sparse=[contribution(1)];delete sparse[0];let traps=0;
  const hostile={...contribution(2),account_id:{[Symbol.toPrimitive](){traps++;assert.fail('coercion');}}};
  for(const entries of [new Proxy([contribution(1)],{}),sparse,[contribution(1),hostile],[contribution(2),contribution(1)],
    Array.from({length:9},(_,i)=>contribution(i+1)),[{...contribution(1),get group_id(){traps++;assert.fail('getter');}}]]){
    const f=setup();await assert.rejects(f.owner.contributeBatch(null,entries),/invalid_entry|invalid_input/);assert.equal(f.calls.length,0);
  }
  assert.equal(traps,0);
});
