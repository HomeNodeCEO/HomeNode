import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCustomCohortV2SelectionIntentRepository as create } from '../src/services/neighborhoodAssessment/customCohortV2SelectionIntentRepository.js';
import { getNeighborhoodOriginalRecordedGroupV2Profile } from '../src/services/neighborhoodAssessment/neighborhoodOriginalRecordedGroupV2.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,ref={content_sha256:'a'.repeat(64),canonical_utf8_bytes:'123'},
  scope={organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'SUBJECT'},
  claim={operation_id:id(4),claim_token:id(7),attempts:5},
  workspace={workspace_version:7,active:null,pending_capture:{operation_id:id(4),observation_period:{start_date:'2024-01-01',end_date:'2024-12-31'}}},
  options={scope,actorUserId:id(5),workspaceTarget:{authority:'prior_workspace_target_only_not_new_selection',workspace_revision:1,workspace_checkpoint:workspace}},
  command={command_id:id(3),request_sha256:'c'.repeat(64),checkpoint:{phase:'frozen_recorded_catalog_refs_v2',evidence_refs:Array(9).fill(ref)},
    profile_reference:getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref,workspace_revision:1,workspace_checkpoint:workspace,
    included_group_ids:['recorded-cad:'+'b'.repeat(64),'discovery:unassigned'],issued_attempts:4,resume_claim_token:id(6)};

// Protocol tests only. The native recursive graph, current source/workspace/
// assignment authorization and rollback/COMMIT still require the actual owner.
function fixture({phase='frozen_selected_semantic_refs_v2',patch={},auto=false,late=false,missing=false}={}){
  const queries=[];let transactions=0;
  const row={...structuredClone(command),job_request_sha256:command.request_sha256,transaction_index_binding:true,
    job_checkpoint:{phase,evidence_refs:Array(phase==='frozen_selected_semantic_refs_v2'?16:17).fill(ref)},...patch},
    repo=create({async query(sql,values){queries.push({sql,values});
      if(sql.includes(':transaction */')){transactions++;return {rowCount:1,rows:[{transaction_id:String(auto?transactions:late&&transactions===3?9:8)}]};}
      if(sql.includes(':transaction-index-read */'))return {rowCount:missing?0:1,rows:missing?[]:[row]};
      if(sql.includes(':semantic-statistics-read */')){
        const {transaction_index_binding,...old}=row;return {rowCount:1,rows:[{...old,semantic_binding:true}]};
      }
      assert.fail(sql);
    }});
  return {queries,repo,row};
}

test('dedicated admission retains exact actual16/17 roots and native consumed continuation/replacement claim, preserving original selection and attempt history',async()=>{
  for(const phase of ['frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2']){
    const f=fixture({phase}),r=await f.repo.readForTransactionIndex(claim,options);
    assert.deepEqual(r.claim,claim);assert.equal(r.issued_attempts,4);assert.equal(r.command_id,command.command_id);
    assert.deepEqual(r.included_recorded_group_ids,command.included_group_ids);assert.ok(Object.isFrozen(r)&&Object.isFrozen(r.included_recorded_group_ids));
    assert.equal(f.queries.filter(q=>q.sql.includes(':transaction */')).length,3);
    const q=f.queries.find(q=>q.sql.includes(':transaction-index-read */'));
    assert.deepEqual(q.values,[id(4),id(7),5,...Object.values(scope),id(5)]);
    for(const s of ['app.neighborhood_selected_transaction_index_v2_admission_matches(job.operation_id,job.organization_id,job.checkpoint)',
      'c.phase=job.checkpoint',"WHEN c.phase='frozen_selected_semantic_refs_v2' THEN s.receipt_reference ELSE indexed.receipt_reference",
      'c.consumed_claim_token IS NOT NULL','c.issued_attempts>=command.issued_attempts',
      'job.attempts=c.issued_attempts AND job.claim_token=c.consumed_claim_token',
      'job.attempts>c.issued_attempts AND job.claim_token<>c.issued_claim_token','job.claim_token<>c.consumed_claim_token',
      'job.claim_token<>command.resume_claim_token','FOR SHARE OF job,command NOWAIT',
      'job.context_sha256 IS NULL','job.actor_user_id=$8::uuid','job.lease_expires_at>clock_timestamp()',
      "semantic_body.canonical_utf8::jsonb->'selected_stock_count'=union_body.canonical_utf8::jsonb->'after_selected_count'",
      "semantic_body.canonical_utf8::jsonb->'after'->>'done'='true'","union_body.canonical_utf8::jsonb->'after'->>'done'='true'"])
      assert.ok(q.sql.includes(s),s);
    assert.ok(f.queries.every(q=>!(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/.test(q.sql))));
  }
  const empty=fixture({patch:{included_group_ids:[]}});
  assert.deepEqual((await empty.repo.readForTransactionIndex(claim,options)).included_recorded_group_ids,[]);
});

test('old semantic/source readers remain strict and cannot consume an actual17 job or delegate to the new reader',async()=>{
  for(const method of ['readForSemanticStatistics','readForTransactionSource']){
    const f=fixture({phase:'frozen_selected_transaction_index_refs_v2'});
    await assert.rejects(()=>f.repo[method](claim,options),/checkpoint_changed/);
    assert.ok(!f.queries.some(q=>q.sql.includes(':transaction-index-read */')));
  }
  const source=readFileSync(new URL('../src/services/neighborhoodAssessment/customCohortV2SelectionIntentRepository.js',import.meta.url),'utf8'),
    start=source.indexOf('async readForTransactionIndex('),end=source.indexOf('async readForSemanticStatistics(',start),q=source.slice(start,end);
  assert.doesNotMatch(q,/\.readForSemanticStatistics\(|\.readForTransactionSource\(|\.slice\(0,16\)|\.slice\(0,15\)/);
  assert.doesNotMatch(q,/jsonb_build_object\('phase'/,'admission reads actual job checkpoint without a JS/SQL projected substitute');
});

test('dedicated admission refuses native-false, wrong request/profile/root/phase, altered workspace, invalid attempt or reused human resume',async()=>{
  const cp={phase:'frozen_selected_transaction_index_refs_v2',evidence_refs:Array(17).fill(ref)};
  for(const patch of [{transaction_index_binding:false},{transaction_index_binding:'true'},{job_request_sha256:'d'.repeat(64)},
    {request_sha256:9},{profile_reference:ref},{checkpoint:{...command.checkpoint,evidence_refs:Array(8).fill(ref)}},
    {job_checkpoint:{...cp,phase:'frozen_selected_numeric_refs_v2'}},{job_checkpoint:{...cp,evidence_refs:Array(16).fill(ref)}},
    {job_checkpoint:{...cp,evidence_refs:[{...ref,content_sha256:'b'.repeat(64)},...cp.evidence_refs.slice(1)]}},
    {job_checkpoint:{...cp,extra:true}},{checkpoint:{...command.checkpoint,extra:true}},
    {workspace_revision:2},{workspace_checkpoint:{...workspace,pending_capture:null}},{issued_attempts:0},{issued_attempts:6},
    {resume_claim_token:id(7)},{included_group_ids:[command.included_group_ids[0],command.included_group_ids[0]]},
    {job_checkpoint:{...cp,evidence_refs:[...cp.evidence_refs.slice(0,16),{...ref,canonical_utf8_bytes:'4097'}]}}]){
    await assert.rejects(()=>fixture({patch}).repo.readForTransactionIndex(claim,options));
  }
  await assert.rejects(()=>fixture({missing:true}).repo.readForTransactionIndex(claim,options),/operation_unavailable/);
});

test('closed dense native references and nested profile/workspace DATA are validated before canonical comparison without invoking hostile getters',async()=>{
  const hostile=()=>assert.fail('hostile DATA must not execute'),cp={phase:'frozen_selected_transaction_index_refs_v2',evidence_refs:Array(17).fill(ref)},
    array=Array(17).fill(ref);Object.defineProperty(array,'0',{enumerable:true,get:hostile});
  for(const patch of [{job_checkpoint:new Proxy(cp,{get:hostile})},{job_checkpoint:{...cp,evidence_refs:Array(17)}},
    {job_checkpoint:{...cp,evidence_refs:new Proxy(cp.evidence_refs,{get:hostile})}},{job_checkpoint:{...cp,evidence_refs:array}},
    {job_checkpoint:{...cp,evidence_refs:[{...ref,toJSON:hostile},...cp.evidence_refs.slice(1)]}},
    {profile_reference:{...ref,toJSON:hostile}},{workspace_checkpoint:{...workspace,toJSON:hostile}},
    {job_checkpoint:{...cp,get phase(){hostile();}}}])await assert.rejects(()=>fixture({patch}).repo.readForTransactionIndex(claim,options));
});

test('same actual native transaction is checked before the read and after all grammar/command checks; no reset/resume/write can occur',async()=>{
  const early=fixture({auto:true});await assert.rejects(()=>early.repo.readForTransactionIndex(claim,options),/caller_transaction_required/);
  assert.equal(early.queries.length,2);
  const late=fixture({late:true});await assert.rejects(()=>late.repo.readForTransactionIndex(claim,options),/caller_transaction_required/);
  assert.equal(late.queries.length,4);assert.ok(!late.queries.some(q=>/\b(INSERT|UPDATE|DELETE)\b/.test(q.sql)));
});

test('new admission refuses caller callbacks/authority/cursor or extra arguments before any database query and is connected only to inactive read-only NEXT',async()=>{
  const hostile=()=>assert.fail('hostile DATA must not execute');
  for(const input of [{...options,readOriginal:hostile},{...options,ordinal:2},{...options,sourceAuthority:true},
    new Proxy(options,{get:hostile}),{...options,get actorUserId(){hostile();}},
    {...options,workspaceTarget:{...options.workspaceTarget,readWorkspace:hostile}}]){
    const f=fixture();await assert.rejects(()=>f.repo.readForTransactionIndex(claim,input));assert.equal(f.queries.length,0);
  }
  const f=fixture();await assert.rejects(()=>f.repo.readForTransactionIndex(claim,options,undefined),/invalid_input/);
  await assert.rejects(()=>f.repo.readForTransactionIndex({...claim,ordinal:2},options));assert.equal(f.queries.length,0);
  const capture=readFileSync(new URL('../src/services/neighborhoodAssessment/customCohortContextCapture.js',import.meta.url),'utf8');
  assert.equal((capture.match(/readingSelectedTransactionIndex\?'readForTransactionIndex'/g)||[]).length,2);
  assert.match(capture,/readOriginalFrozenCaptureJobNextSelectedTransactionIndexReferencesV2/);
  assert.doesNotMatch(capture,/selectedTransactionIndexStore\.advance\(/);
});
