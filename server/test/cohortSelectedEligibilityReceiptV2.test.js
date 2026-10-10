import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareCohortSelectedEligibilityReceiptV2 as prepare,
  SELECTED_RECORDED_ELIGIBILITY_METRICS as METRICS } from '../src/services/neighborhoodAssessment/cohortSelectedEligibilityReceiptV2.js';
import { createCustomCohortSelectedEligibilityV2Repository as repository } from '../src/services/neighborhoodAssessment/customCohortSelectedEligibilityV2Repository.js';
const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,
  ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
  expected={union_reference:ref(1),command_id:id(3),selected_stock_count:2},
  zero=Object.fromEntries(METRICS.map(k=>[k,0])),yes=Object.fromEntries(METRICS.map(k=>[k,true])),
  no=Object.fromEntries(METRICS.map(k=>[k,false])),one=Object.fromEntries(METRICS.map(k=>[k,1])),
  initial={selected_ordinal:0,done:false},first={selected_ordinal:1,done:false},last={selected_ordinal:2,done:false};
const raw=()=>({format:'cohort_selected_recorded_eligibility_receipt_v2',...structuredClone(expected),
  subject_housing:{state:'observed',category:'detached_single_family'},sequence:1,previous:null,before:initial,after:first,
  selected_entry:{account_id:'B',ordinal:1,partition_ordinal:2,entry_reference:ref(2)},eligible:yes,before_counts:zero,after_counts:one});

test('closed fifth-pass DATA preserves exact selected ordinals, unknown denominator and fresh EMPTY only after all members',()=>{
  const a=prepare(raw(),expected),b=prepare({...raw(),sequence:2,previous:ref(3),before:first,after:last,
    selected_entry:{account_id:'Z',ordinal:2,partition_ordinal:9,entry_reference:ref(4)},eligible:no,before_counts:one,after_counts:one},expected),
    done=prepare({...raw(),sequence:3,previous:ref(5),before:last,after:{...last,done:true},selected_entry:null,eligible:null,
      before_counts:one,after_counts:one},expected);
  assert.deepEqual(a.after_counts,one);assert.deepEqual(b.after_counts,one);assert.equal(done.after.done,true);
  assert.equal(done.selected_entry,null);assert.equal(done.eligible,null);assert.ok(Object.isFrozen(done)&&Object.isFrozen(done.after_counts));
  const emptyExpected={...expected,selected_stock_count:0},empty=prepare({...raw(),...emptyExpected,before:initial,
    after:{...initial,done:true},selected_entry:null,eligible:null,before_counts:zero,after_counts:zero},emptyExpected);
  assert.equal(empty.sequence,1);assert.equal(empty.after.selected_ordinal,0);
  const unknown=prepare({...raw(),subject_housing:{state:'partial',category:null},eligible:no,after_counts:zero},expected);
  assert.deepEqual(unknown.after_counts,zero);
});
test('receipt refuses free done/ordinal/count/eligibility/value authority, changed union and hostile grammar before evaluating getters',()=>{
  const bad=[{...raw(),after:{...first,done:true},selected_entry:null,eligible:null},
    {...raw(),sequence:2},{...raw(),previous:ref(7)},{...raw(),before_counts:one},{...raw(),after_counts:zero},
    {...raw(),eligible:{...yes,reported_market_value:true}},{...raw(),eligible:{...yes,reported_year_built:1}},
    {...raw(),selected_entry:{...raw().selected_entry,ordinal:2}},{...raw(),selected_entry:{...raw().selected_entry,exact_value:'2000'}},
    {...raw(),selected_entry:{...raw().selected_entry,account_id:'\ud800'}},{...raw(),union_reference:ref(8)},
    {...raw(),subject_housing:{state:'unknown',category:null}},{...raw(),subject_housing:{state:'observed',category:'single_family'}},
    {...raw(),full_eligibility:true},new Proxy(raw(),{getPrototypeOf(){assert.fail('proxy');}}),
    {...raw(),get after_counts(){assert.fail('getter');}}];
  for(const r of bad)assert.throws(()=>prepare(r,expected));
  const r=raw(),p=prepare(r,expected);r.union_reference.content_sha256='f'.repeat(64);assert.deepEqual(p.union_reference,ref(1));
  assert.throws(()=>prepare(raw(),{...expected,account_ids:['B']}));
});
// SQL doubles test mechanics ONLY, not native issuance, originals or rights.
function setup({auto=false,next=null,corrupt=false}={}){const calls=[];let tx=12,head=null;
  const client={async query(sql,v){calls.push({sql,v});
    if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:String(auto?++tx:tx)}]};
    if(sql.includes(':head-read'))return {rowCount:1,rows:[head??{command_id:null,union_reference:null,receipt_reference:null,sequence:null}]};
    if(sql.includes(':next-selected-entry'))return {rowCount:1,rows:[next??{account_id:null,ordinal:null,partition_ordinal:null,entry_reference:null,state:null,assigned_group_id:null}]};
    if(sql.includes(':head-insert')){head={command_id:v[8],union_reference:JSON.parse(v[9]),receipt_reference:JSON.parse(v[10]),sequence:1};
      return {rowCount:1,rows:[{sequence:corrupt?2:1}]};}
    if(sql.includes(':head-advance')){head={...head,receipt_reference:JSON.parse(v[8]),sequence:v[9]};return {rowCount:1,rows:[{sequence:v[9]}]};}
    assert.fail(sql);}};
  const options={client,claim:{operation_id:id(4),claim_token:id(5),attempts:2},
    scope:{organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'A'},actorUserId:id(6),
    command_id:expected.command_id,union_reference:expected.union_reference};
  return {calls,options,owner:repository(options)};
}
test('storage next ordinal derives only from native head; closed CAS/head readback never owns a transaction or source authority',async()=>{
  const next={...raw().selected_entry,state:'unassigned',assigned_group_id:null},{owner,calls}=setup({next});
  assert.equal(await owner.read(),null);assert.deepEqual(await owner.readNextSelectedEntry(),next);
  const h=await owner.advance(null,ref(3));assert.equal(h.sequence,1);assert.equal((await owner.advance(h,ref(4))).sequence,2);
  const sql=calls.find(c=>c.sql.includes(':next-selected-entry')).sql;
  for(const s of ['r.ordinal=coalesce(h.sequence,0)+1','entry.account_id=r.account_id','entry.entry_reference=r.entry_reference',
    'neighborhood_selected_eligibility_v2_checkpoint_matches',"body.canonical_utf8::jsonb->'after'->>'done'='true'",
    'job.claim_token=$2::uuid','job.context_sha256 IS NULL'])assert.ok(sql.includes(s),s);
  assert.ok(!calls.some(c=>/array_agg|jsonb_agg|ST_DWithin|original_text|typed_value|\bBEGIN\b|\bCOMMIT\b/.test(c.sql)));
  assert.equal(await setup().owner.readNextSelectedEntry(),null);
  await assert.rejects(owner.advance(null,ref(5)),/conflict/);
});
test('storage refuses caller ordinal/cursor/decision/callback, transaction changes and malformed native row',async()=>{
  const {owner,calls,options}=setup();
  for(const v of [1,{ordinal:1},{cursor:''},()=>assert.fail('callback')])await assert.rejects(owner.readNextSelectedEntry(v),/invalid_input/);
  assert.equal(calls.length,0);
  for(const key of ['nextOrdinal','readOriginal','decision','selected_accounts'])assert.throws(()=>repository({...options,[key]:true}));
  await assert.rejects(setup({auto:true}).owner.advance(null,ref(2)),/caller_transaction_required/);
  await assert.rejects(setup({corrupt:true}).owner.advance(null,ref(2)),/corrupt/);
  const next={...raw().selected_entry,state:'unassigned',assigned_group_id:null};
  for(const n of [{...next,ordinal:0},{...next,partition_ordinal:2000001},{...next,state:null},{...next,account_id:'\ud800'},
    {...next,eligible:true},new Proxy(next,{ownKeys(){assert.fail('proxy');}}),{...next,get account_id(){assert.fail('getter');}}])
    await assert.rejects(setup({next:n}).owner.readNextSelectedEntry());
});
test('additive migration preserves exact ten roots, terminal native ordinal, unknown counts and atomic fifth-phase continuation',()=>{
  const name='20261126_custom_cohort_selected_recorded_eligibility_v2.sql',sql=readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'),
    registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8');
  assert.ok(registry.indexOf(name)>registry.indexOf('20261125_custom_cohort_selected_union_replay_v2.sql'));
  for(const s of ["(cp->'evidence_refs')-10",'jsonb_array_length(cp->\'evidence_refs\')=11',
    'DEFERRABLE INITIALLY DEFERRED','orphan_progress','member.ordinal','member.partition_ordinal',
    "prior->'after'->>'done' IS DISTINCT FROM 'false'",'before_counts->>metric','CHECK(sequence BETWEEN 1 AND 10000005)',
    'h.union_reference=OLD.progress_reference','actual_sequence<>1','OLD.consumed_claim_token IS NULL','AND NOT first_union_bridge',
    "OLD.phase='frozen_selected_eligibility_refs_v2' AND NEW.phase<>'frozen_selected_eligibility_refs_v2'",'BEFORE TRUNCATE'])assert.ok(sql.includes(s),s);
  for(const m of sql.matchAll(/CREATE (?:TABLE|FUNCTION|TRIGGER|INDEX|CONSTRAINT TRIGGER) (?:app\.)?([a-z0-9_]+)/g))assert.ok(Buffer.byteLength(m[1])<=63,m[1]);
  assert.doesNotMatch(sql,/DISABLE TRIGGER|DROP TABLE|DROP TRIGGER|UPDATE app\.report_files|ST_DWithin|array_agg|jsonb_agg/);
});
