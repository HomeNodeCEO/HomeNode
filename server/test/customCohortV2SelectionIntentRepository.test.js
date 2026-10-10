import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCustomCohortV2SelectionIntentRepository as repository,
  prepareCustomCohortV2SelectionIntent as prepare } from '../src/services/neighborhoodAssessment/customCohortV2SelectionIntentRepository.js';
import { getNeighborhoodOriginalRecordedGroupV2Profile } from '../src/services/neighborhoodAssessment/neighborhoodOriginalRecordedGroupV2.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,
  ref={content_sha256:'a'.repeat(64),canonical_utf8_bytes:'123'},group='recorded-cad:'+'b'.repeat(64),
  scope={organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'A'},
  intent={command_id:id(3),catalog_reference:ref,workspace_revision:1,included_recorded_group_ids:[group,'discovery:unassigned']},
  workspace={workspace_version:7,active:null,pending_capture:{operation_id:id(4),observation_period:{start_date:'2024-01-01',end_date:'2024-12-31'}}},
  options={scope,actorUserId:id(5),intent,workspaceTarget:{authority:'prior_workspace_target_only_not_new_selection',workspace_revision:1,workspace_checkpoint:workspace}},
  checkpoint={phase:'frozen_recorded_catalog_refs_v2',evidence_refs:Array.from({length:9},()=>ref)},
  command={command_id:id(3),request_sha256:'c'.repeat(64),checkpoint,profile_reference:getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref,
    workspace_revision:1,workspace_checkpoint:workspace,included_group_ids:intent.included_recorded_group_ids,issued_attempts:5,resume_claim_token:id(6)};
// SQL doubles prove storage grammar/mechanics only, not actual authorization,
// originals, native guards or successful rollback/COMMIT. Those run in CI.
function setup({existing=false,auto=false,endAuto=false,conflict=false,expired=false,status}={}){
  const calls=[];let inserted=existing,transactions=0;
  return {calls,owner:repository({async query(sql,values){calls.push({sql,values});
    if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:String(auto?++transactions:endAuto&&++transactions===3?9:8)}]};
    if(sql.includes(':job-lock'))return {rowCount:1,rows:[{status:status??(existing?'running':'awaiting_selection'),attempts:5,
      claim_token:existing?id(6):null,live:existing?!expired:null,request_sha256:'c'.repeat(64),checkpoint}]};
    if(sql.includes(':read'))return {rowCount:inserted?1:0,rows:inserted?[{...command,...(conflict?{command_id:id(7)}:{})}]:[]};
    if(sql.includes(':insert')){inserted=true;return {rowCount:1,rows:[]};}
    if(sql.includes(':resume'))return {rowCount:1,rows:[{operation_id:id(4),claim_token:id(6),attempts:5}]};
    assert.fail(sql);
  }})};
}
test('explicit IDs detach without prior-choice inference, duplicate removal, sorting or truncation',()=>{
  const ids=[group,'discovery:unassigned'],prepared=prepare({...intent,included_recorded_group_ids:ids});ids.length=0;
  assert.deepEqual(prepared.included_recorded_group_ids,[group,'discovery:unassigned']);assert.ok(Object.isFrozen(prepared.included_recorded_group_ids));
  assert.deepEqual(prepare({...intent,included_recorded_group_ids:[]}).included_recorded_group_ids,[]);
});
test('intent rejects free source authority and hostile/oversized/duplicate group inputs without evaluating accessors',()=>{
  for(const value of [{...intent,claim_token:id(6)},{...intent,account_ids:['A']},{...intent,workspace_revision:0},
    {...intent,catalog_reference:{...ref,canonical_utf8_bytes:'16001'}},{...intent,included_recorded_group_ids:[group,group]},
    {...intent,included_recorded_group_ids:Array(2050).fill(group)},
    {...intent,included_recorded_group_ids:new Proxy([],{getPrototypeOf(){assert.fail('proxy');}})},
    {...intent,included_recorded_group_ids:Array(1)},new Proxy(intent,{getPrototypeOf(){assert.fail('proxy');}}),
    {...intent,get command_id(){assert.fail('getter');}}])assert.throws(()=>prepare(value));
});
test('resume writes one immutable intent and fresh lease preserving the fifth attempt, roots and history',async()=>{
  const {owner,calls}=setup(),result=await owner.resume(id(4),options);
  assert.deepEqual(result.claim,{operation_id:id(4),claim_token:id(6),attempts:5});assert.equal(result.replayed,false);
  const insert=calls.find(c=>c.sql.includes(':insert')),resume=calls.find(c=>c.sql.includes(':resume'));
  assert.ok(insert.sql.includes('head.profile_reference'));assert.ok(insert.sql.includes('gen_random_uuid()'));
  assert.deepEqual(insert.values.slice(0,7),[id(4),...Object.values(scope),id(5),id(3)]);
  assert.deepEqual(JSON.parse(insert.values[9]),intent.included_recorded_group_ids);
  assert.ok(resume.sql.includes("interval '120 seconds'"));assert.ok(!/SET[\s\S]*?(attempts|checkpoint|last_error_code|run_after)\s*=/i.test(resume.sql.split('WHERE')[0]));
  assert.equal(calls.filter(c=>c.sql.includes(':transaction')).length,3);
});
test('exact still-live replay is read-only and cannot mint/extend a second lease',async()=>{
  const {owner,calls}=setup({existing:true}),result=await owner.resume(id(4),options);
  assert.equal(result.replayed,true);assert.ok(!calls.some(c=>c.sql.includes(':insert')||c.sql.includes(':resume')));
  for(const opts of [{existing:true,conflict:true},{existing:true,expired:true},{status:'running'}])
    await assert.rejects(setup(opts).owner.resume(id(4),options),/command_conflict|claim_lost|waiting_required/);
});
test('same actual caller transaction is required before any insert and after resume',async()=>{
  const before=setup({auto:true});await assert.rejects(before.owner.resume(id(4),options),/caller_transaction_required/);
  assert.equal(before.calls.length,2);
  await assert.rejects(setup({endAuto:true}).owner.resume(id(4),options),/caller_transaction_required/);
  const hostile=setup();await assert.rejects(hostile.owner.resume(id(4),{...options,leaseSeconds:900}),/invalid_input/);assert.equal(hostile.calls.length,0);
});
test('additive native guard binds all nine roots, exact workspace and one immutable resume, without membership/publication authority',()=>{
  const sql=readFileSync(new URL('../migrations/20261124_custom_cohort_selection_intent_v2.sql',import.meta.url),'utf8'),
    registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8');
  assert.ok(registry.includes('20261124_custom_cohort_selection_intent_v2.sql'));
  for(let i=1;i<=8;i++)assert.ok(sql.includes(`job.checkpoint->'evidence_refs'->${i}`));
  for(const s of ['DEFERRABLE INITIALLY DEFERRED','orphan_resume','BEFORE TRUNCATE','intent_immutable',
    'NEW.resume_claim_token','workspace.section_value IS DISTINCT FROM NEW.workspace_checkpoint',
    "NEW.status IN ('succeeded','awaiting_selection')",'NEW.attempts<OLD.attempts','NEW.checkpoint IS DISTINCT FROM command.checkpoint'])assert.ok(sql.includes(s),s);
});

const workerOptions={scope,actorUserId:id(5),workspaceTarget:options.workspaceTarget},
  currentClaim={operation_id:id(4),claim_token:id(6),attempts:5};
function retainedSetup({patch={},auto=false,endAuto=false,missing=false}={}){
  const calls=[];let transactions=0;
  return {calls,owner:repository({async query(sql,values){calls.push({sql,values});
    if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:String(auto?++transactions:endAuto&&++transactions===3?9:8)}]};
    if(sql.includes(':retained-read'))return {rowCount:missing?0:1,rows:missing?[]:[{...structuredClone(command),
      job_request_sha256:command.request_sha256,job_checkpoint:structuredClone(checkpoint),...patch}]};
    assert.fail(sql);
  }})};
}

test('retained command reopens read-only for its original claim or a fresh ordinary replacement attempt, never a new choice',async()=>{
  for(const [claim,patch] of [[currentClaim,{}],[{...currentClaim,claim_token:id(9)},{issued_attempts:4}]]){
    const {owner,calls}=retainedSetup({patch}),result=await owner.readRetained(claim,workerOptions);
    assert.deepEqual(result.claim,claim);assert.deepEqual(result.included_recorded_group_ids,intent.included_recorded_group_ids);
    assert.equal(result.issued_attempts,patch.issued_attempts??5);assert.equal(result.command_id,intent.command_id);
    assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.included_recorded_group_ids));
    assert.deepEqual(calls.find(c=>c.sql.includes(':retained-read')).values,[id(4),claim.claim_token,5,...Object.values(scope),id(5)]);
    assert.ok(calls.every(c=>!(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/.test(c.sql))));
    assert.equal(calls.filter(c=>c.sql.includes(':transaction')).length,3);
    for(const s of ['FOR SHARE OF job,command NOWAIT',"job.status='running'",'job.context_sha256 IS NULL',
      'job.lease_expires_at>clock_timestamp()','job.cancellation_requested_at IS NULL'])
      assert.ok(calls.find(c=>c.sql.includes(':retained-read')).sql.includes(s),s);
  }
  const empty=retainedSetup({patch:{included_group_ids:[]}});
  assert.deepEqual((await empty.owner.readRetained(currentClaim,workerOptions)).included_recorded_group_ids,[]);
});

test('retained command refuses wrong request, roots, profile, workspace, attempt and reused initial token',async()=>{
  for(const patch of [{job_request_sha256:'d'.repeat(64)},{job_checkpoint:{...checkpoint,phase:'frozen_stock_v1'}},
    {checkpoint:{phase:checkpoint.phase,evidence_refs:[ref]}},{profile_reference:ref},
    {workspace_revision:2},{workspace_checkpoint:{...workspace,pending_capture:null}},
    {issued_attempts:6},{issued_attempts:0},{issued_attempts:4},{resume_claim_token:id(9)},
    {included_group_ids:[group,group]}])
    await assert.rejects(retainedSetup({patch}).owner.readRetained(currentClaim,workerOptions),
      /checkpoint_changed|workspace_changed|claim_lost|invalid_|group_id/);
  await assert.rejects(retainedSetup({missing:true}).owner.readRetained(currentClaim,workerOptions),/operation_unavailable/);
});

test('retained worker has a closed read-only grammar and requires the same actual owner transaction',async()=>{
  for(const raw of [{...workerOptions,intent},{...workerOptions,leaseSeconds:900},
    {...workerOptions,workspaceTarget:{...workerOptions.workspaceTarget,readWorkspace:()=>assert.fail('callback')}},
    new Proxy(workerOptions,{getPrototypeOf(){assert.fail('proxy');}}),
    {...workerOptions,get actorUserId(){assert.fail('getter');}}]){
    const {owner,calls}=retainedSetup();await assert.rejects(owner.readRetained(currentClaim,raw));assert.equal(calls.length,0);
  }
  for(const claim of [{...currentClaim,readOriginal:()=>assert.fail('callback')},new Proxy(currentClaim,{getPrototypeOf(){assert.fail('proxy');}}),
    {...currentClaim,get claim_token(){assert.fail('getter');}}]){
    const {owner,calls}=retainedSetup();await assert.rejects(owner.readRetained(claim,workerOptions));assert.equal(calls.length,0);
  }
  const before=retainedSetup({auto:true});await assert.rejects(before.owner.readRetained(currentClaim,workerOptions),/caller_transaction_required/);
  assert.equal(before.calls.length,2);
  await assert.rejects(retainedSetup({endAuto:true}).owner.readRetained(currentClaim,workerOptions),/caller_transaction_required/);
});
