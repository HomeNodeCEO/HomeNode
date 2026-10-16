import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareCohortRecordedGroupPartitionReceiptV2 as prepare } from '../src/services/neighborhoodAssessment/cohortRecordedGroupPartitionReceiptV2.js';
import { createCustomCohortRecordedPartitionV2Repository as repository } from '../src/services/neighborhoodAssessment/customCohortRecordedPartitionV2Repository.js';
import { getNeighborhoodOriginalRecordedGroupV2Profile } from '../src/services/neighborhoodAssessment/neighborhoodOriginalRecordedGroupV2.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'});
const scope={organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'A'};
const binding={...scope,operation_id:id(3),generation_id:id(4),spatial_definition_sha256:'a'.repeat(64),source_original_sha256:'b'.repeat(64)};
const expected={binding,source_reference:ref(1),root:ref(2),graph_verification_reference:ref(3),stock_verification_reference:ref(4),
  identity_verification_reference:ref(5),stock_reference:ref(6),effective_date:'2026-10-07',stock_account_count:'2',
  traversal_reference:ref(7),profile_reference:getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref};
const initial={after_account:'',account_count:0,done:false},first={after_account:'A',account_count:1,done:false},last={after_account:'B',account_count:2,done:false};
const raw=(before=initial,after=first,sequence=1,previous=null,entry_reference=ref(8))=>({format:'cohort_recorded_group_partition_receipt_v2',
  ...structuredClone(expected),sequence,previous,before,after,entry_reference});

test('partition DATA requires fixed producer and one entry per nonempty ordinal, then a distinct empty probe',()=>{
  const a=prepare(raw(),expected),b=prepare(raw(first,last,2,ref(8)),expected),end=prepare(raw(last,{...last,done:true},3,ref(9),null),expected);
  assert.equal(a.after.account_count,1);assert.equal(b.after.account_count,2);assert.equal(end.after.done,true);assert.equal(end.entry_reference,null);
  assert.ok(Object.isFrozen(a)&&Object.isFrozen(a.before)&&Object.isFrozen(a.entry_reference));
  const source=raw(),copy=prepare(source,expected);source.traversal_reference.content_sha256='f'.repeat(64);
  source.entry_reference.canonical_utf8_bytes='999';assert.deepEqual(copy.traversal_reference,ref(7));assert.deepEqual(copy.entry_reference,ref(8));
});
test('partition DATA refuses callbacks, free DONE, altered roots/profile, bad counts, huge entries and hostile DATA',()=>{
  for(const r of [raw(initial,first,1,null,null),raw(last,{...last,done:true},3,ref(9),ref(8)),
    raw(initial,{...last,done:true},1,null,null),raw(first,last,2,null),raw(first,last,3,ref(9)),
    {...raw(),traversal_reference:ref(9)},{...raw(),profile_reference:ref(9)},
    {...raw(),entry_reference:{...ref(8),canonical_utf8_bytes:'1000001'}},{...raw(),group:()=>{}},new Proxy(raw(),{}),
    {...raw(),entry_reference:{...ref(8),get canonical_utf8_bytes(){assert.fail('getter');}}},
    {...raw(),after:{...first,get done(){assert.fail('getter');}}}])assert.throws(()=>prepare(r,expected),/invalid_receipt/);
  assert.throws(()=>prepare(raw(),{...expected,profile_reference:ref(9)}),/invalid_receipt/);
});

/** SQL doubles cover mechanics ONLY, never independent native/source authority. */
function setup({autocommit=false,conflict=false,storedEntry=null}={}){
  let current=null,tx=40;const calls=[];
  const frozen={source_reference:ref(1),root_reference:ref(2),graph_reference:ref(3),geographic_reference:ref(4),identity_reference:ref(5),
    stock_reference:ref(6),traversal_reference:ref(7),profile_reference:expected.profile_reference};
  const client={async query(sql,values){calls.push({sql,values});
    if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:String(autocommit?++tx:tx)}]};
    if(sql.includes(':anchor-read'))return {rowCount:1,rows:[current??Object.fromEntries([...Object.keys(frozen),'receipt_reference','sequence'].map(k=>[k,null]))]};
    if(sql.includes(':entry-read'))return {rowCount:1,rows:[storedEntry??Object.fromEntries(['account_id','ordinal','entry_reference','state','assigned_group_id'].map(k=>[k,null]))]};
    if(sql.includes(':entry-insert'))return {rowCount:1,rows:[{ordinal:values[9]}]};
    if(sql.includes(':anchor-insert')){current={...frozen,receipt_reference:JSON.parse(values[16]),sequence:1};return {rowCount:1,rows:[{sequence:1}]};}
    if(sql.includes(':anchor-advance')){if(conflict)return {rowCount:0,rows:[]};current={...frozen,receipt_reference:JSON.parse(values[8]),sequence:values[9]};
      return {rowCount:1,rows:[{sequence:current.sequence}]};}assert.fail(sql);}};
  return {calls,owner:repository({client,claim:{operation_id:id(3),claim_token:id(5),attempts:1},scope,actorUserId:id(6),...frozen})};
}
const entry=(account='A',ordinal=1)=>({account_id:account,ordinal,entry_reference:ref(8),state:'unassigned',assigned_group_id:null});
test('partition repository writes one ordinal before exact live-claim CAS and never opens a nested transaction',async()=>{
  const {owner,calls}=setup();assert.equal(await owner.read(),null);const a=await owner.advance(null,ref(8),entry()),
    b=await owner.advance(a,ref(9),entry('B',2)),done=await owner.advance(b,ref(7),null);
  assert.equal(a.sequence,1);assert.equal(done.sequence,3);assert.deepEqual(await owner.read(),done);
  assert.equal(calls.filter(c=>c.sql.includes(':entry-insert')).length,2);
  assert.ok(calls.findIndex(c=>c.sql.includes(':entry-insert'))<calls.findIndex(c=>c.sql.includes(':anchor-insert')));
  await assert.rejects(owner.advance(a,ref(7),entry('B',2)),/conflict/);
  assert.ok(calls.filter(c=>c.sql.includes('job.operation_id')).every(c=>c.sql.includes("job.status='running'")&&c.sql.includes('job.actor_user_id=$8::uuid')));
  assert.ok(!calls.some(c=>/payload|ST_DWithin|\bBEGIN\b|\bCOMMIT\b/.test(c.sql)));
});
test('partition repository refuses autocommit, ordinal jumps, forged row state and lost CAS',async()=>{
  const auto=setup({autocommit:true});await assert.rejects(auto.owner.advance(null,ref(8),entry()),/caller_transaction_required/);
  assert.ok(!auto.calls.some(c=>c.sql.includes(':entry-insert')));
  const normal=setup();for(const e of [entry('A',2),{...entry(),state:'assigned'},
    {...entry(),assigned_group_id:'recorded-cad:'+'a'.repeat(64)},{...entry(),get account_id(){assert.fail('getter');}},new Proxy(entry(),{})])
    await assert.rejects(normal.owner.advance(null,ref(8),e),/binding_changed|invalid_entry|invalid_input/);
  const conflict=setup({conflict:true}),a=await conflict.owner.advance(null,ref(8),entry());
  await assert.rejects(conflict.owner.advance(a,ref(9),entry('B',2)),/claim_lost/);
});
test('partition prefix repository reads one exact indexed immutable row under the same claim, never a dense roster',async()=>{
  const found=setup({storedEntry:entry()});assert.deepEqual(await found.owner.readNextEntry(''),entry());
  assert.equal(await setup().owner.readNextEntry('B'),null);
  const query=found.calls[0];assert.ok(query.sql.includes('ORDER BY account_id LIMIT 1'));assert.equal(query.values[8],'');
  assert.ok(query.sql.includes('job.actor_user_id=$8::uuid')&&query.sql.includes('job.claim_token=$2::uuid'));
  for(const value of [null,{},new String(''),new Proxy({},{}),' A','A\u0000','\ud800','a'.repeat(65)])
    await assert.rejects(found.owner.readNextEntry(value),/invalid_cursor/);
  await assert.rejects(setup({storedEntry:{...entry(),ordinal:0}}).owner.readNextEntry(''),/invalid_entry/);
  await assert.rejects(setup({storedEntry:{...entry(),state:'assigned',assigned_group_id:null}}).owner.readNextEntry(''),/invalid_entry/);
});
test('registered additive native partition enforces exact next keys, immutable rows and same-TX head/checkpoint commit',()=>{
  const name='20261119_custom_cohort_recorded_partition_v2.sql',registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8'),
    sql=readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
  assert.ok(registry.indexOf(name)>registry.indexOf('20261118_custom_cohort_stock_traversal_v2_anchors.sql'));
  for(const m of sql.matchAll(/CREATE (?:TABLE|FUNCTION|TRIGGER|INDEX) (?:app\.)?([a-z0-9_]+)/g))assert.ok(Buffer.byteLength(m[1])<=63,m[1]);
  for(const required of ['PRIMARY KEY(operation_id,account_id)','UNIQUE(operation_id,ordinal)','ORDER BY account_id LIMIT 1',
    "traversal_receipt->'after'->>'done' IS DISTINCT FROM 'true'",'receipt->\'after\' IS DISTINCT FROM expected_after',
    'NEW.sequence<>OLD.sequence+1','DEFERRABLE INITIALLY DEFERRED','head.sequence<>NEW.ordinal',
    "checkpoint->'evidence_refs'->7 IS DISTINCT FROM head.receipt_reference",'BEFORE TRUNCATE','ON DELETE RESTRICT'])assert.ok(sql.includes(required),required);
  assert.doesNotMatch(sql,/ST_DWithin|DISABLE TRIGGER|DROP TABLE|UPDATE app\.report_files|jsonb_agg/);
});
