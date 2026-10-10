import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortSelectedEvidenceV2Repository as repository }
  from '../src/services/neighborhoodAssessment/customCohortSelectedEvidenceV2Repository.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,
  ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
  empty={command_id:null,union_reference:null,eligibility_reference:null,receipt_reference:null,sequence:null},
  member={account_id:'B',ordinal:1,partition_ordinal:2,entry_reference:ref(5),state:'unassigned',assigned_group_id:null};
// SQL doubles verify storage mechanics ONLY. They do not issue a native graph,
// establish source rights, reconcile originals, run the migration or an owner.
function setup({auto=false,next=member,native=null,corrupt=false,readback=false}={}){
  const calls=[];let tx=12,head=native;
  const client={async query(sql,v){calls.push({sql,v});
    if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:String(auto?++tx:tx)}]};
    if(sql.includes(':head-read'))return {rowCount:1,rows:[head??empty]};
    if(sql.includes(':next-selected-entry'))return {rowCount:1,rows:[next??{account_id:null,ordinal:null,partition_ordinal:null,entry_reference:null,state:null,assigned_group_id:null}]};
    if(sql.includes(':head-insert')){head={command_id:v[8],union_reference:JSON.parse(v[9]),eligibility_reference:JSON.parse(v[10]),
      receipt_reference:JSON.parse(v[11]),sequence:1};
      if(readback)head.eligibility_reference=ref(8);return {rowCount:1,rows:[{sequence:corrupt?2:1}]};}
    if(sql.includes(':head-advance')){head={...head,receipt_reference:JSON.parse(v[8]),sequence:v[9]};return {rowCount:1,rows:[{sequence:v[9]}]};}
    assert.fail(sql);}};
  const options={client,claim:{operation_id:id(4),claim_token:id(5),attempts:2},
    scope:{organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'A'},actorUserId:id(6),
    command_id:id(3),union_reference:ref(1),eligibility_reference:ref(2)};
  return {calls,options,owner:repository(options)};
}

test('unmounted sixth storage binds BOTH DONE native parents and derives next ordinal without caller membership',async()=>{
  const {owner,calls}=setup();assert.equal(await owner.read(),null);
  assert.deepEqual(await owner.readNextSelectedEntry(),member);
  const head=await owner.advance(null,ref(3));assert.deepEqual(head,{command_id:id(3),union_reference:ref(1),
    eligibility_reference:ref(2),receipt_reference:ref(3),sequence:1});
  assert.equal((await owner.advance(head,ref(4))).sequence,2);
  const next=calls.find(c=>c.sql.includes(':next-selected-entry')).sql;
  for(const s of ['r.ordinal=coalesce(h.sequence,0)+1','entry.account_id=r.account_id','entry.entry_reference=r.entry_reference',
    'h.eligibility_reference=$11::jsonb','neighborhood_selected_eligibility_v2_checkpoint_matches',
    'neighborhood_selected_evidence_v2_checkpoint_matches',"union_body.canonical_utf8::jsonb->'after'->>'done'='true'",
    "fifth_body.canonical_utf8::jsonb->'after'->>'done'='true'",'fifth.union_reference=u.receipt_reference',
    'job.actor_user_id=$8::uuid','job.claim_token=$2::uuid','job.context_sha256 IS NULL'])assert.ok(next.includes(s),s);
  const write=calls.find(c=>c.sql.includes(':head-advance'));
  assert.deepEqual([write.v[10],...write.v.slice(11,14).map(v=>JSON.parse(v)),write.v[14]],
    [id(3),ref(1),ref(2),ref(3),1]);
  for(const c of calls.filter(c=>c.sql.includes(':head-read')||c.sql.includes(':head-insert')))
    assert.ok(c.sql.includes("fifth_body.canonical_utf8::jsonb->'after'->>'done'='true'"));
  assert.ok(!calls.some(c=>/array_agg|jsonb_agg|ST_DWithin|original_text|typed_value|FROM core\.|\bBEGIN\b|\bCOMMIT\b/.test(c.sql)));
  const none=setup({next:null});assert.equal(await none.owner.readNextSelectedEntry(),null);
  await assert.rejects(owner.advance(null,ref(6)),/conflict/);
});

test('closed storage rejects caller ordinal, cursor, source, decision and descriptors before any SQL or callback',async()=>{
  const {owner,calls,options}=setup();
  for(const v of [undefined,1,{ordinal:1},{cursor:''},()=>assert.fail('callback')]){
    await assert.rejects(owner.read(v),/invalid_input/);await assert.rejects(owner.readNextSelectedEntry(v),/invalid_input/);
  }
  for(const args of [[],[null],[null,ref(3),true]])await assert.rejects(owner.advance(...args),/invalid_input/);
  await assert.rejects(owner.advance(new Proxy({}, {getPrototypeOf(){assert.fail('proxy');}}),ref(3)),/invalid_input/);
  assert.equal(calls.length,0);
  for(const key of ['readOriginal','sourceGrant','ordinal','cursor','account_id','profile','counts','decision','selected_accounts'])
    assert.throws(()=>repository({...options,[key]:true}),/invalid_input/);
  assert.throws(()=>repository({...options,get command_id(){assert.fail('getter');}}),/invalid_input/);
  assert.throws(()=>repository({...options,eligibility_reference:{...ref(2),canonical_utf8_bytes:'16001'}}),/invalid_reference/);
  assert.throws(()=>repository({...options,union_reference:new Proxy(ref(1),{ownKeys(){assert.fail('proxy');}})}),/invalid_input/);
});

test('native bindings, exact CAS/readback, transaction identity and selected rows refuse corruption without owning transaction',async()=>{
  await assert.rejects(setup({auto:true}).owner.advance(null,ref(3)),/caller_transaction_required/);
  await assert.rejects(setup({corrupt:true}).owner.advance(null,ref(3)),/corrupt/);
  await assert.rejects(setup({readback:true}).owner.advance(null,ref(3)),/binding_changed/);
  const head={command_id:id(3),union_reference:ref(1),eligibility_reference:ref(2),receipt_reference:ref(3),sequence:1};
  for(const bad of [{...head,command_id:id(8)},{...head,eligibility_reference:ref(8)},{...head,union_reference:ref(8)},
    {...head,sequence:'1'},{...head,sequence:2000002},{...head,receipt_reference:null},
    {...head,source_complete:true},new Proxy(head,{getPrototypeOf(){assert.fail('proxy');}}),
    {...head,get receipt_reference(){assert.fail('getter');}}])await assert.rejects(setup({native:bad}).owner.read());
  for(const next of [{...member,ordinal:0},{...member,partition_ordinal:2000001},{...member,ordinal:1.1},{...member,state:null},
    {...member,assigned_group_id:'recorded-cad:'+'a'.repeat(64)},{...member,state:'assigned'},
    {...member,account_id:'\ud800'},{...member,entry_reference:{...ref(5),canonical_utf8_bytes:'1000001'}},
    {...member,evidence:true},new Proxy(member,{ownKeys(){assert.fail('proxy');}}),
    {...member,get account_id(){assert.fail('getter');}}])await assert.rejects(setup({next}).owner.readNextSelectedEntry());
  const assigned={...member,state:'assigned',assigned_group_id:'recorded-cad:'+'a'.repeat(64)};
  assert.deepEqual(await setup({next:assigned}).owner.readNextSelectedEntry(),assigned);
});

test('repository detaches exact job/scope/root values before asynchronous SQL and returns immutable metadata',async()=>{
  const {owner,options,calls}=setup();
  options.claim.claim_token=id(9);options.scope.account_id='changed';options.union_reference.content_sha256='f'.repeat(64);
  options.eligibility_reference.canonical_utf8_bytes='999';
  const m=await owner.readNextSelectedEntry(),h=await owner.advance(null,ref(3));
  const next=calls.find(c=>c.sql.includes(':next-selected-entry'));
  assert.equal(next.v[1],id(5));assert.equal(next.v[6],'A');
  assert.deepEqual(JSON.parse(next.v[9]),ref(1));assert.deepEqual(JSON.parse(next.v[10]),ref(2));
  assert.ok(Object.isFrozen(h)&&Object.isFrozen(h.eligibility_reference)&&Object.isFrozen(h.receipt_reference));
  assert.ok(Object.isFrozen(m)&&Object.isFrozen(m.entry_reference));
});
