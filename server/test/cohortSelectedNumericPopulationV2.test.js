import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareCohortSelectedNumericReceiptV2 as prepare } from '../src/services/neighborhoodAssessment/cohortSelectedNumericReceiptV2.js';
import { createCustomCohortSelectedNumericV2Repository as repository } from '../src/services/neighborhoodAssessment/customCohortSelectedNumericV2Repository.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,
  ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
  keys=['union_reference','eligibility_reference','evidence_reference','metrics_reference','statistics_reference'],
  expected={...Object.fromEntries(keys.map((k,i)=>[k,ref(i+1)])),command_id:id(3),selected_stock_count:2},
  entry={account_id:'B',ordinal:1,partition_ordinal:2,entry_reference:ref(4)},
  member={...entry,state:'unassigned',assigned_group_id:null,row_reference:ref(5),contribution_row_reference:ref(6),
    numeric_index_ordinal:1,reported_year_built:null,reported_residential_area:'9007199254740993.000000000001',reported_site_area:'0'};
const receipt=()=>({format:'cohort_selected_numeric_receipt_v2',...expected,sequence:1,previous:null,
  before:{selected_ordinal:0,done:false},after:{selected_ordinal:1,done:false},selected_entry:entry,contribution_row_reference:ref(6)});

test('ninth receipt is a small immutable reference-only transition, not original/value/count authority',()=>{
  const p=prepare(receipt(),expected);assert.deepEqual(p,receipt());
  assert.ok(Object.isFrozen(p)&&Object.isFrozen(p.before)&&Object.isFrozen(p.selected_entry)&&Object.isFrozen(p.statistics_reference));
  assert.ok(Buffer.byteLength(JSON.stringify(p))<4096);
  const second={...receipt(),sequence:2,previous:ref(7),before:p.after,after:{selected_ordinal:2,done:false},
    selected_entry:{...entry,account_id:'C',ordinal:2},contribution_row_reference:ref(8)},q=prepare(second,expected);
  assert.equal(q.after.done,false,'last account does not replace the fresh terminal EMPTY');
  const terminal={...receipt(),sequence:3,previous:ref(8),before:q.after,after:{selected_ordinal:2,done:true},
    selected_entry:null,contribution_row_reference:null};assert.equal(prepare(terminal,expected).after.done,true);
  const empty={...receipt(),selected_stock_count:0,selected_entry:null,contribution_row_reference:null,
    after:{selected_ordinal:0,done:true}};assert.equal(prepare(empty,{...expected,selected_stock_count:0}).after.done,true);
});

test('ninth receipt rejects skipped/early/reopened/extra/proxy/accessor DATA and never invokes authority callbacks',()=>{
  for(const patch of [
    {format:'legacy'},{command_id:id(9)},{statistics_reference:ref(9)},{selected_stock_count:3},{sequence:2},{previous:ref(7)},
    {before:{selected_ordinal:0,done:true}},{after:{selected_ordinal:2,done:false}},
    {after:{selected_ordinal:0,done:true},selected_entry:null,contribution_row_reference:null},
    {selected_entry:{...entry,ordinal:2}},{selected_entry:{...entry,account_id:' B'}},
    {selected_entry:{...entry,partition_ordinal:0}},{contribution_row_reference:null},
    {contribution_row_reference:{...ref(6),canonical_utf8_bytes:'4097'}},
    {before:{selected_ordinal:0,done:false,counts:{}}},{numeric_values:['0']},{counts:{eligible:2}},{readOriginal:()=>assert.fail('callback')},
  ])assert.throws(()=>prepare({...receipt(),...patch},expected));
  for(const args of [[],[receipt()],[receipt(),expected,true]])assert.throws(()=>prepare(...args));
  assert.throws(()=>prepare(new Proxy(receipt(),{}),expected));
  assert.throws(()=>prepare({...receipt(),get previous(){assert.fail('getter');}},expected));
  assert.throws(()=>prepare({...receipt(),[Symbol('caller')]:true},expected));
  assert.throws(()=>prepare(receipt(),{...expected,selected_accounts:['B','C']}));
});

function setup({auto=false,next=member,corrupt=false,readback=false,rows=1,endingTx=false}={}){
  let head=null,tx=8,txCalls=0;const calls=[],empty={command_id:null,...Object.fromEntries(keys.map(k=>[k,null])),receipt_reference:null,sequence:null};
  const options={client:{async query(text,values){calls.push({text,values});
    if(text.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:String(auto||endingTx&&++txCalls===3?++tx:tx)}]};
    if(text.includes(':head-read'))return {rowCount:1,rows:[head??empty]};
    if(text.includes(':next-selected-entry'))return {rowCount:1,rows:[next??Object.fromEntries(Object.keys(member).map(k=>[k,null]))]};
    if(text.includes(':row-insert'))return {rowCount:rows,rows:Array.from({length:rows},()=>({ordinal:values[14]}))};
    if(text.includes(':head-insert')){head={command_id:values[8],...Object.fromEntries(keys.map((k,i)=>[k,JSON.parse(values[i+9])])),
      receipt_reference:JSON.parse(values[14]),sequence:1};if(readback)head.statistics_reference=ref(9);
      return {rowCount:1,rows:[{sequence:corrupt?2:1}]};}
    if(text.includes(':head-advance')){assert.deepEqual(JSON.parse(values[16]),head.receipt_reference);assert.equal(values[17],head.sequence);
      head={...head,receipt_reference:JSON.parse(values[14]),sequence:values[15]};return {rowCount:1,rows:[{sequence:values[15]}]};}
    assert.fail(text);}},claim:{operation_id:id(4),claim_token:id(5),attempts:2},
    scope:{organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'A'},actorUserId:id(6),
    command_id:id(3),...Object.fromEntries(keys.map(k=>[k,expected[k]]))};
  return {calls,options,owner:repository(options)};
}

test('ninth repository derives actual eighth member/index and native cursor, never caller ordinal/row/value/DONE',async()=>{
  const {owner,calls}=setup();assert.equal(await owner.read(),null);assert.deepEqual(await owner.readNextSelectedEntry(),member);
  const h=await owner.advance(null,ref(7));assert.equal(h.sequence,1);assert.deepEqual(h.statistics_reference,expected.statistics_reference);
  assert.equal((await owner.advance(h,ref(8))).sequence,2);
  const next=calls.find(c=>c.text.includes(':next-selected-entry')),row=calls.find(c=>c.text.includes(':row-insert'));
  assert.equal(next.values.length,14);assert.equal(row.values.length,15);assert.equal(row.values[14],1);
  for(const text of ['m.ordinal=coalesce(h.sequence,0)+1','indexed.contribution_row_reference=m.row_reference',
    'metric.row_reference=m.metric_row_reference','entry.entry_reference=u.entry_reference','eighth.receipt_reference=$14::jsonb',
    'neighborhood_selected_numeric_v2_admission_matches',"eighth_body.canonical_utf8::jsonb->'after'->>'done'='true'",
    'job.claim_token=$2::uuid','job.actor_user_id=$8::uuid'])assert.ok(next.text.includes(text),text);
  assert.match(row.text,/m.entry_reference,m.metric_row_reference,m.row_reference/);
  assert.doesNotMatch(row.text,/\$[0-9]+::jsonb\s*\n?\s*FROM|reported_site_area|reported_year_built|reported_residential_area/);
  assert.equal(await setup({next:null}).owner.readNextSelectedEntry(),null);
  assert.equal((await setup({rows:0}).owner.advance(null,ref(7))).sequence,1,'native guard must establish actual EMPTY, not caller flag');
  assert.ok(calls.every(c=>! /array_agg|jsonb_agg|ST_DWithin|FROM core\.|\bBEGIN\b|\bCOMMIT\b/.test(c.text)));
});

test('ninth repository rejects unbound/corrupt/missing indexed DATA, stale CAS and all autocommit paths',async()=>{
  const {owner,options,calls}=setup();
  for(const args of [[1],[{ordinal:1}],[()=>assert.fail('callback')],[undefined]]){
    await assert.rejects(owner.read(...args));await assert.rejects(owner.readNextSelectedEntry(...args));}
  for(const args of [[],[null],[null,ref(7),true],[null,ref(7),member]])await assert.rejects(owner.advance(...args));
  assert.equal(calls.length,0);
  for(const key of ['ordinal','cursor','decision','done','counts','readOriginal','selected_accounts','numeric_values'])
    assert.throws(()=>repository({...options,[key]:true}));
  assert.throws(()=>repository({...options,get statistics_reference(){assert.fail('getter');}}));
  for(const patch of [{ordinal:0},{state:'caller'},{numeric_index_ordinal:null},{numeric_index_ordinal:2},
    {row_reference:null},{contribution_row_reference:null},{reported_site_area:0},{reported_site_area:'0.0'},
    {reported_residential_area:'1e3'},{reported_residential_area:'1.0000000000001'}])
    await assert.rejects(setup({next:{...member,...patch}}).owner.readNextSelectedEntry());
  await assert.rejects(setup({auto:true}).owner.advance(null,ref(7)),/caller_transaction_required/);
  await assert.rejects(setup({endingTx:true}).owner.advance(null,ref(7)),/corrupt/);
  await assert.rejects(setup({corrupt:true}).owner.advance(null,ref(7)),/corrupt/);
  await assert.rejects(setup({readback:true}).owner.advance(null,ref(7)),/binding_changed/);
  await assert.rejects(setup({rows:2}).owner.advance(null,ref(7)),/corrupt/);
  await owner.advance(null,ref(7));await assert.rejects(owner.advance(null,ref(8)),/conflict/);
});

test('registered ninth native foundation is fail-closed, exact15, reference-only and atomic, not an implemented owner',()=>{
  const name='20261201_custom_cohort_selected_numeric_v2.sql',s=readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'),
    registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8');
  assert.ok(registry.indexOf(name)>registry.indexOf('20261130_custom_cohort_selected_numeric_index_v2.sql'));
  for(const text of ["jsonb_array_length(cp->'evidence_refs')=15","cp->'evidence_refs'->14=h.receipt_reference", "(cp->'evidence_refs')-14",
    'app.neighborhood_selected_statistics_v2_checkpoint_matches','h.statistics_reference=eighth.receipt_reference',
    'NEW.ordinal<>coalesce(h.sequence,0)+1','m.metric_row_reference=NEW.metric_row_reference','m.row_reference=NEW.contribution_row_reference',
    'i.contribution_row_reference=m.row_reference','jsonb_object_keys(body))<>14',"body->'sequence' IS DISTINCT FROM to_jsonb(NEW.sequence)",
    "body->'before' IS DISTINCT FROM before_state","body->'after' IS DISTINCT FROM after_state",'NEW.sequence<>OLD.sequence+1',
    'neighborhood_selected_numeric_v2_orphan_row','neighborhood_selected_numeric_v2_orphan_progress',
    "c.phase<>'frozen_selected_numeric_refs_v2'",'c.issued_attempts<>job.attempts','c.consumed_claim_token IS NOT NULL',
    "job.status<>'retry'",'job.claim_token IS NOT NULL','job.lease_expires_at IS NOT NULL','DEFERRABLE INITIALLY DEFERRED',
    'count(*),count(reported_year_built),count(reported_residential_area),count(reported_site_area)',
    'neighborhood_selected_numeric_v2_index_incomplete','BEFORE TRUNCATE','no numeric/original/typed copies'])assert.ok(s.includes(text),text);
  const tables=s.slice(s.indexOf('CREATE TABLE'),s.indexOf('-- Keep every old checkpoint'));
  assert.doesNotMatch(tables,/reported_year_built|reported_residential_area|reported_site_area|\bnumeric\b|canonical_utf8|payload|typed|diagnostic/);
  assert.doesNotMatch(s,/CREATE OR REPLACE|ALTER TABLE|DROP |DISABLE TRIGGER|SECURITY DEFINER|GRANT |array_agg|jsonb_agg|OFFSET |FROM core\./i);
  assert.equal((s.match(/CREATE CONSTRAINT TRIGGER/g)??[]).length,2);
});

test('cloud foundation checks are unconditional native DDL and specific refusal, never a successful original-owner claim',()=>{
  const helper=readFileSync(new URL('./helpers/neighborhoodSelectedNumericPopulationV2DatabaseChecks.js',import.meta.url),'utf8'),
    native=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8');
  assert.ok(native.includes('await runNeighborhoodSelectedNumericPopulationV2DatabaseChecks(pool)'));
  for(const text of ['information_schema.columns','pg_get_constraintdef','tgdeferrable','tginitdeferred',
    "error.code==='55000'&&/custom_cohort_context_immutable/",'original_owner_integrated:false',
    'successful_ninth_transition:false','complete_indexed_population:false','licensed_acquisition:false'])assert.ok(helper.includes(text),text);
});
