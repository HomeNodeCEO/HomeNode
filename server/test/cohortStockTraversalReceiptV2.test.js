import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareCohortStockTraversalReceiptV2 as prepare } from '../src/services/neighborhoodAssessment/cohortStockTraversalReceiptV2.js';
import { createCustomCohortStockTraversalV2AnchorRepository as repository } from '../src/services/neighborhoodAssessment/customCohortStockTraversalV2AnchorRepository.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'});
const scope={organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'A'};
const binding={...scope,operation_id:id(3),generation_id:id(4),spatial_definition_sha256:'a'.repeat(64),source_original_sha256:'b'.repeat(64)};
const expected={binding,source_reference:ref(1),root:ref(2),graph_verification_reference:ref(3),stock_verification_reference:ref(4),
  identity_verification_reference:ref(5),stock_reference:ref(6),effective_date:'2026-10-07',stock_account_count:'2'};
const initial={after_account:'',account_count:0,done:false};
const first={after_account:'A',account_count:1,done:false},last={after_account:'B',account_count:2,done:false};
const raw=(before=initial,after=first,sequence=1,previous=null)=>({format:'cohort_stock_traversal_receipt_v2',...structuredClone(expected),sequence,previous,before,after});

test('stock traversal DATA retains the exact issued bindings and explicit fresh empty terminal step',()=>{
  const a=prepare(raw(),expected),b=prepare(raw(first,last,2,ref(7)),expected),
    end=prepare(raw(last,{...last,done:true},3,ref(8)),expected);
  assert.deepEqual(a.after,first);assert.deepEqual(b.after,last);assert.equal(end.after.done,true);
  assert.ok(Object.isFrozen(a)&&Object.isFrozen(a.binding)&&Object.isFrozen(a.after));
  assert.ok(!Object.hasOwn(a,'rows')&&!Object.hasOwn(a,'observations'));
  const source=raw(),copy=prepare(source,expected);source.before.after_account='changed';source.source_reference.content_sha256='f'.repeat(64);
  assert.equal(copy.before.after_account,'');assert.equal(copy.source_reference.content_sha256,'1'.repeat(64));
});

test('stock traversal DATA refuses free DONE, count/sequence jumps, altered bindings and hostile continuations',()=>{
  for(const r of [raw(initial,{after_account:'',account_count:0,done:true}),raw(initial,{...last,done:true}),
    raw(initial,{...first,account_count:2}),raw(first,last,3,ref(7)),raw(first,last,2,null),raw(initial,first,1,ref(7)),
    raw({...first,done:true},last,2,ref(7)),raw(first,{...last,after_account:'A'},2,ref(7)),
    {...raw(),effective_date:'2026-10-08'},{...raw(),stock_account_count:'1'},{...raw(),binding:{...binding,operation_id:id(9)}},
    {...raw(),identity_verification_reference:ref(9)},{...raw(),rows:[]},new Proxy(raw(),{}),
    {...raw(),before:{...initial,get done(){assert.fail('getter');}}},
    {...raw(),after:{...first,after_account:' A'}},{...raw(),after:{...first,after_account:'A\u0000'}},
    {...raw(),after:{...first,after_account:'\ud800'}}])
    assert.throws(()=>prepare(r,expected),/invalid_receipt/);
  const limit={...expected,stock_account_count:'2000000'},before={after_account:'Z',account_count:2000000,done:false};
  assert.equal(prepare({...raw(before,{...before,done:true},2000001,ref(7)),...limit},limit).sequence,2000001);
  assert.throws(()=>prepare({...raw(),stock_account_count:'2000001'},expected),/invalid_receipt/);
});

/** Repository SQL doubles test CAS/transaction mechanics only, never issuance. */
function setup({autocommit=false,conflict=false}={}){
  let current=null,tx=40;const calls=[];
  const frozen={source_reference:ref(1),root_reference:ref(2),graph_reference:ref(3),geographic_reference:ref(4),identity_reference:ref(5),stock_reference:ref(6)};
  const client={async query(sql,values){calls.push({sql,values});
    if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:String(autocommit?++tx:tx)}]};
    if(sql.includes(':anchor-read'))return {rowCount:1,rows:[current??Object.fromEntries([...Object.keys(frozen),'receipt_reference','sequence'].map(k=>[k,null]))]};
    if(sql.includes(':anchor-insert')){current={...frozen,receipt_reference:JSON.parse(values[14]),sequence:1};return {rowCount:1,rows:[{sequence:1}]};}
    if(sql.includes(':anchor-advance')){
      if(conflict)return {rowCount:0,rows:[]};current={...frozen,receipt_reference:JSON.parse(values[8]),sequence:values[9]};
      return {rowCount:1,rows:[{sequence:current.sequence}]};}
    assert.fail(sql);
  }};
  return {calls,owner:repository({client,claim:{operation_id:id(3),claim_token:id(5),attempts:1},scope,actorUserId:id(6),...frozen})};
}
test('stock traversal head repository uses exact live claim, same TX and CAS without acquiring a source',async()=>{
  const {owner,calls}=setup();assert.equal(await owner.read(),null);
  const a=await owner.advance(null,ref(7)),b=await owner.advance(a,ref(8));
  assert.equal(a.sequence,1);assert.equal(b.sequence,2);assert.deepEqual(await owner.read(),b);
  await assert.rejects(owner.advance(a,ref(9)),/conflict/);
  assert.ok(calls.filter(c=>c.sql.includes('anchor-')).every(c=>c.sql.includes("job.status='running'")&&c.sql.includes('job.actor_user_id=$8::uuid')));
  assert.ok(!calls.some(c=>/payload|ST_DWithin|\bBEGIN\b|\bCOMMIT\b/.test(c.sql)));
});
test('stock traversal repository refuses implicit autocommit and a lost CAS',async()=>{
  const auto=setup({autocommit:true});await assert.rejects(auto.owner.advance(null,ref(7)),/caller_transaction_required/);
  assert.ok(!auto.calls.some(c=>c.sql.includes('anchor-insert')));
  const conflict=setup({conflict:true}),a=await conflict.owner.advance(null,ref(7));
  await assert.rejects(conflict.owner.advance(a,ref(8)),/claim_lost/);
});

test('additive native traversal guard is registered, independently checks next key and retains immutable roots',()=>{
  const name='20261118_custom_cohort_stock_traversal_v2_anchors.sql',
    registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8'),
    sql=readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
  assert.ok(registry.indexOf(name)>registry.indexOf('20261117_neighborhood_shared_typed_cad_generations.sql'));
  for(const m of sql.matchAll(/CREATE (?:TABLE|FUNCTION|TRIGGER) (?:app\.)?([a-z0-9_]+)/g))assert.ok(Buffer.byteLength(m[1])<=63);
  for(const required of ["identity_receipt->'after'->>'kind_index' IS DISTINCT FROM '7'",
    'identity_anchor.receipt_reference<>NEW.identity_reference','graph_anchor.receipt_reference<>NEW.graph_reference',
    'geo_anchor.receipt_reference<>NEW.geographic_reference','ORDER BY account_id LIMIT 1','receipt->\'after\' IS DISTINCT FROM expected_after',
    'NEW.sequence<>OLD.sequence+1',"job.checkpoint->'evidence_refs'->6 IS DISTINCT FROM OLD.receipt_reference",
    "receipt->>'effective_date' IS DISTINCT FROM subject_intent->>'effective_date'",'BEFORE TRUNCATE','ON DELETE RESTRICT'])assert.ok(sql.includes(required),required);
  assert.doesNotMatch(sql,/ST_DWithin|DISABLE TRIGGER|DROP TABLE|UPDATE app\.report_files|jsonb_agg\(.*payload/);
});
