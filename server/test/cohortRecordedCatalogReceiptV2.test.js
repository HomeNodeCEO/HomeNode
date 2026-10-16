import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareCohortRecordedCatalogReceiptV2 as prepare } from '../src/services/neighborhoodAssessment/cohortRecordedCatalogReceiptV2.js';
import { createCustomCohortRecordedCatalogV2Repository as repository } from '../src/services/neighborhoodAssessment/customCohortRecordedCatalogV2Repository.js';
import { getNeighborhoodOriginalRecordedGroupV2Profile } from '../src/services/neighborhoodAssessment/neighborhoodOriginalRecordedGroupV2.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
  scope={organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'A'},
  binding={...scope,operation_id:id(3),generation_id:id(4),spatial_definition_sha256:'a'.repeat(64),source_original_sha256:'b'.repeat(64)},
  expected={binding,source_reference:ref(1),root:ref(2),graph_verification_reference:ref(3),stock_verification_reference:ref(4),
    identity_verification_reference:ref(5),stock_reference:ref(6),effective_date:'2026-10-07',stock_account_count:'2',
    traversal_reference:ref(7),profile_reference:getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref,partition_reference:ref(8)},
  initial={after_account:'',account_count:0,done:false},first={after_account:'A',account_count:1,done:false},last={after_account:'B',account_count:2,done:false},
  zero={assigned_accounts:0,unassigned_accounts:0,assigned_groups:0},unassigned={...zero,unassigned_accounts:1},
  final={assigned_accounts:1,unassigned_accounts:1,assigned_groups:1};
const raw=()=>({format:'cohort_recorded_catalog_receipt_v2',...structuredClone(expected),sequence:1,previous:null,
  before:initial,after:first,entry_reference:ref(9),before_counts:zero,after_counts:unassigned});

test('catalog transition DATA retains assigned and full unassigned denominators, then a distinct empty terminal',()=>{
  const a=prepare(raw(),expected),b=prepare({...raw(),sequence:2,previous:ref(9),before:first,after:last,before_counts:unassigned,after_counts:final},expected),
    done=prepare({...raw(),sequence:3,previous:ref(9),before:last,after:{...last,done:true},entry_reference:null,before_counts:final,after_counts:final},expected);
  assert.equal(a.after_counts.unassigned_accounts,1);assert.deepEqual(b.after_counts,final);assert.equal(done.after.done,true);
  assert.ok(Object.isFrozen(done.after_counts)&&Object.isFrozen(done.partition_reference));
  const r=raw(),copy=prepare(r,expected);r.after_counts={...zero};r.partition_reference.content_sha256='f'.repeat(64);
  assert.deepEqual(copy.after_counts,unassigned);assert.deepEqual(copy.partition_reference,ref(8));
});
test('catalog DATA refuses omitted denominators, candidate promotion, group overflow, free DONE and hostile inputs',()=>{
  for(const r of [{...raw(),after_counts:zero},{...raw(),after_counts:{...unassigned,assigned_groups:1}},
    {...raw(),after_counts:{...unassigned,unassigned_accounts:0,assigned_accounts:2}},
    {...raw(),after_counts:{...unassigned,assigned_groups:2049}},
    {...raw(),partition_reference:ref(9)},{...raw(),account_ids:['A']},{...raw(),original:()=>{}},new Proxy(raw(),{}),
    {...raw(),after_counts:{...unassigned,get assigned_accounts(){assert.fail('getter');}}},
    {...raw(),after:{...last,done:true},entry_reference:null}])assert.throws(()=>prepare(r,expected),/invalid_receipt/);
});
function setup({auto=false,bad=false,group=null}={}){let current=null,tx=12,total={...zero};const calls=[],
  bound={source_reference:ref(1),root_reference:ref(2),graph_reference:ref(3),geographic_reference:ref(4),identity_reference:ref(5),
    stock_reference:ref(6),traversal_reference:ref(7),profile_reference:expected.profile_reference,partition_reference:ref(8)};
  const client={async query(sql,v){calls.push({sql,v});
    if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:String(auto?++tx:tx)}]};
    if(sql.includes(':anchor-read'))return {rowCount:1,rows:[current??Object.fromEntries([...Object.keys(bound),'receipt_reference','sequence'].map(k=>[k,null]))]};
    if(sql.includes(':counts'))return {rowCount:1,rows:[bad?{...total,assigned_groups:2049}:{...total}]};
    if(sql.includes(':group-read'))return {rowCount:1,rows:[group??{group_id:null,normalized_county:null,normalized_label:null,member_count:null,last_ordinal:null}]};
    if(sql.includes(':contribute')){if(v[8]==='discovery:unassigned')total.unassigned_accounts++;else{total.assigned_accounts++;total.assigned_groups=1;}
      return {rowCount:1,rows:[{last_ordinal:v[11]}]};}
    if(sql.includes(':anchor-insert')){current={...bound,receipt_reference:JSON.parse(v[17]),sequence:1};return {rowCount:1,rows:[{sequence:1}]};}
    if(sql.includes(':anchor-advance')){current={...bound,receipt_reference:JSON.parse(v[8]),sequence:v[9]};return {rowCount:1,rows:[{sequence:v[9]}]};}
    assert.fail(sql);}};
  return {calls,owner:repository({client,claim:{operation_id:id(3),claim_token:id(5),attempts:1},scope,actorUserId:id(6),...bound})};}
const entry={account_id:'A',ordinal:1,group_id:'discovery:unassigned',normalized_county:null,normalized_label:null};
test('fixed catalog repository contributes one account and bounded counts, never arrays or nested transactions',async()=>{
  const {owner,calls}=setup();assert.equal(await owner.read(),null);assert.deepEqual(await owner.counts(),zero);
  assert.deepEqual(await owner.contribute(null,entry),unassigned);const first=await owner.advance(null,ref(9));
  assert.deepEqual(await owner.read(),first);assert.equal((await owner.advance(first,ref(8))).sequence,2);
  const c=calls.find(c=>c.sql.includes(':contribute'));assert.equal(c.v[12],'A');assert.equal(c.v[11],1);
  assert.match(c.sql,/entry\.ordinal=\$12::integer/);assert.match(c.sql,/entry\.account_id=\$13/);
  assert.ok(calls.filter(c=>c.sql.includes('job.operation_id')).every(c=>c.sql.includes('job.actor_user_id=$8::uuid')&&c.sql.includes("job.status='running'")));
  assert.ok(!calls.some(c=>/jsonb_agg|array_agg|payload|ST_DWithin|\bBEGIN\b|\bCOMMIT\b/.test(c.sql)));
});
test('catalog repository refuses autocommit before writes, ordinal jumps, hostile metadata and oversized labels',async()=>{
  const a=setup({auto:true});await assert.rejects(a.owner.contribute(null,entry),/caller_transaction_required/);
  await assert.rejects(a.owner.advance(null,ref(9)),/caller_transaction_required/);assert.ok(!a.calls.some(c=>/:contribute|:anchor-insert/.test(c.sql)));
  const {owner,calls}=setup();for(const e of [{...entry,ordinal:2},{...entry,normalized_label:'candidate'},
    {...entry,account_id:'\ud800'},{...entry,group_id:'recorded-cad:'+'a'.repeat(64),normalized_county:'dallas',normalized_label:'a'.repeat(513)},
    new Proxy(entry,{}),{...entry,get group_id(){assert.fail('getter');}}])await assert.rejects(owner.contribute(null,e),/invalid_/);
  assert.equal(calls.length,0);await assert.rejects(setup({bad:true}).owner.counts(),/corrupt/);
});
test('one catalog storage identity is exact PK-scoped, claim-fenced and detached, never semantic group counts',async()=>{
  const assigned={group_id:'recorded-cad:'+'a'.repeat(64),normalized_county:'dallas',normalized_label:'é'.repeat(256),member_count:3,last_ordinal:5};
  for(const group of [assigned,{group_id:'discovery:unassigned',normalized_county:null,normalized_label:null,member_count:2,last_ordinal:5}]){
    const {owner,calls}=setup({group}),key={group_id:group.group_id},row=await owner.readGroup(key);
    assert.deepEqual(row,group);assert.ok(Object.isFrozen(row));assert.notEqual(row,group);
    assert.equal(calls.length,1);const {sql,v}=calls[0];
    assert.equal(v.length,9);assert.equal(v[8],key.group_id);assert.equal(v[0],id(3));assert.equal(v[7],id(6));
    for(const s of ['g.operation_id=job.operation_id','g.organization_id=job.organization_id','g.group_id=$9',
      'job.claim_token=$2::uuid','job.attempts=$3::integer',"job.status='running'",'job.lease_expires_at>clock_timestamp()',
      'job.cancellation_requested_at IS NULL'])assert.ok(sql.includes(s),s);
    assert.doesNotMatch(sql,/sum\(|count\(|jsonb_agg|array_agg|payload|ST_DWithin|INSERT|UPDATE|BEGIN|COMMIT/);
  }
  const missing=setup();assert.equal(await missing.owner.readGroup({group_id:'discovery:unassigned'}),null);
  const group={group_id:'discovery:unassigned',normalized_county:null,normalized_label:null,member_count:2,last_ordinal:5};
  assert.deepEqual(await setup({group}).owner.readGroup({group_id:group.group_id}),group);
});
test('catalog identity storage rejects hostile keys and malformed native rows without truncating labels or counts',async()=>{
  const a=setup();for(const key of [{group_id:'unknown'},{group_id:'discovery:unassigned',account_ids:['A']},
    {group_id:'discovery:unassigned',counts:final},{group_id:'discovery:unassigned',callback:()=>{}},
    new Proxy({group_id:'discovery:unassigned'},{}),{get group_id(){assert.fail('getter');}}])
    await assert.rejects(a.owner.readGroup(key),/invalid_/);
  assert.equal(a.calls.length,0);
  const key={group_id:'recorded-cad:'+'a'.repeat(64)},base={...key,normalized_county:'dallas',normalized_label:'one',member_count:1,last_ordinal:2};
  for(const group of [{...base,group_id:'recorded-cad:'+'b'.repeat(64)},{...base,normalized_county:null},
    {...base,normalized_label:'é'.repeat(257)},{...base,normalized_label:' One '},{...base,normalized_label:'\ud800'},
    {...base,normalized_label:'x\u0000y'},{...base,member_count:0},{...base,member_count:'1'},
    {...base,member_count:3},{...base,last_ordinal:2000001},{...base,last_ordinal:1.5},
    {...base,member_count:1,extra:true},{...base,get normalized_label(){assert.fail('getter');}},
    new Proxy(base,{}),{group_id:null,normalized_county:null,normalized_label:null,member_count:null,last_ordinal:1}])
    await assert.rejects(setup({group}).owner.readGroup(key),/corrupt|invalid_input/);
  await assert.rejects(setup({group:{...base,group_id:'discovery:unassigned'}}).owner.readGroup({group_id:'discovery:unassigned'}),/corrupt/);
});
test('registered native catalog bounds groups and issues exact next ordinals with same-TX head/root constraints',()=>{
  const name='20261121_custom_cohort_recorded_catalog_v2.sql',registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8'),
    sql=readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
  assert.ok(registry.indexOf(name)>registry.indexOf('20261120_custom_cohort_issued_continuations_v2.sql'));
  for(const m of sql.matchAll(/CREATE (?:TABLE|FUNCTION|TRIGGER|INDEX|CONSTRAINT TRIGGER) (?:app\.)?([a-z0-9_]+)/g))assert.ok(Buffer.byteLength(m[1])<=63,m[1]);
  for(const s of ['PRIMARY KEY(operation_id,group_id)','ordinal=next_ordinal','NEW.member_count<>OLD.member_count+1',
    'NEW.last_ordinal<=OLD.last_ordinal','>=2048','groups>2048','DEFERRABLE INITIALLY DEFERRED','head.sequence<>NEW.last_ordinal',
    "checkpoint->'evidence_refs'->8 IS DISTINCT FROM head.receipt_reference",'BEFORE TRUNCATE','ON DELETE RESTRICT'])assert.ok(sql.includes(s),s);
  assert.doesNotMatch(sql,/jsonb_agg|array_agg|DISABLE TRIGGER|DROP TABLE|UPDATE app\.report_files/);
});
