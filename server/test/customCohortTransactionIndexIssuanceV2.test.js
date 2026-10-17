import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCustomCohortCaptureJobRepository as jobs } from '../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { createCustomCohortV2ContinuationRepository as continuations } from '../src/services/neighborhoodAssessment/customCohortV2ContinuationRepository.js';
import { createCustomCohortContextCapture as captureOwner } from '../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { assessmentEvidenceDigest } from '../src/services/neighborhoodAssessment/contract.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,phase='frozen_selected_transaction_index_refs_v2',
  reference={content_sha256:'a'.repeat(64),canonical_utf8_bytes:'123'},
  claim={operation_id:id(1),claim_token:id(2),attempts:5},scope={organization_id:id(3),report_file_id:id(4),assignment_file_id:'7',account_id:'SUBJECT'},
  options={scope,actorUserId:id(5)},checkpoint=()=>({phase,evidence_refs:Array.from({length:17},()=>({...reference}))}),
  service=name=>readFileSync(new URL('../src/services/neighborhoodAssessment/'+name+'.js',import.meta.url),'utf8');
// Detached protocol and integration-structure tests ONLY, not actual native
// transaction/rollback/ordinary4->5/worker/source/licensed/speed acceptance.
function saveFixture({changed=false,missing=false}={}){
  const calls=[],repo=jobs({async query(sql,values){calls.push({sql,values});const cp=JSON.parse(values[8]);
    return {rowCount:missing?0:1,rows:missing?[]:[{checkpoint:changed?{...cp,evidence_refs:cp.evidence_refs.map((r,i)=>i===16?{...r,content_sha256:'b'.repeat(64)}:r)}:cp}]};}});
  return {calls,repo};
}
function yieldFixture({auto=false,late=false,missing=false,sequence=22000011,actualPhase=phase,attempts=5,bytes='123'}={}){
  let tx=40,reads=0;const calls=[],repo=continuations({async query(sql,values){calls.push({sql,values});
    if(sql.includes(':transaction')){reads++;return {rowCount:1,rows:[{transaction_id:String(auto||late&&reads===3?++tx:tx)}]};}
    assert.match(sql,/:yield-transaction-index/);
    return {rowCount:missing?0:1,rows:missing?[]:[{sequence,phase:actualPhase,attempts,progress_reference:{...reference,canonical_utf8_bytes:bytes}}]};}});
  return {calls,repo};
}

test('dedicated save requires exact17 actual native old-prefix/new-issued-head transition with unchanged live scope/attempt/error/lease',async()=>{
  const f=saveFixture(),cp=checkpoint(),r=await f.repo.saveTransactionIndexCheckpoint(claim,options,cp);
  assert.deepEqual(r,cp);assert.ok(Object.isFrozen(r.evidence_refs[16]));assert.equal(f.calls.length,1);
  const q=f.calls[0];assert.deepEqual(q.values.slice(0,8),[id(1),id(2),5,id(3),id(4),'7','SUBJECT',id(5)]);
  assert.deepEqual(JSON.parse(q.values[8]),cp);
  for(const text of ['transaction-index-checkpoint-save',"status='running'",'lease_expires_at>clock_timestamp()',
    'actor_user_id=$8::uuid','cancellation_requested_at IS NULL','context_sha256 IS NULL',
    'app.neighborhood_transaction_index_v2_checkpoint_transition_matches(','operation_id,organization_id,checkpoint,$9::jsonb)'])assert.ok(q.sql.includes(text),text);
  assert.doesNotMatch(q.sql,/SET\s+attempts\s*=|,\s*(attempts|claim_token|lease_expires_at|last_error_code|context_sha256|status)\s*=|BEGIN|COMMIT|DELETE/);
});

test('dedicated save refuses missing native issuance and changed retained readback; ordinary save/read/heartbeat still cannot issue17',async()=>{
  await assert.rejects(saveFixture({missing:true}).repo.saveTransactionIndexCheckpoint(claim,options,checkpoint()),/claim_lost/);
  await assert.rejects(saveFixture({changed:true}).repo.saveTransactionIndexCheckpoint(claim,options,checkpoint()),/job_corrupt/);
  const f=saveFixture();await assert.rejects(f.repo.saveCheckpoint(claim,options,checkpoint()),/invalid_checkpoint/);
  await assert.rejects(f.repo.heartbeat(claim,{checkpoint:checkpoint()}),/invalid_checkpoint/);assert.equal(f.calls.length,0);
});

test('save rejects projected/hostile checkpoint, claim, scope, authority callbacks and extra arguments before SQL',async()=>{
  const f=saveFixture(),hostile=()=>assert.fail('hostile DATA executed'),cp=checkpoint(),sparse=Array(17);
  const cases=[{...cp,phase:'frozen_selected_semantic_refs_v2',evidence_refs:cp.evidence_refs.slice(0,16)},
    {...cp,evidence_refs:cp.evidence_refs.slice(1)},{...cp,extra:true},{...cp,evidence_refs:sparse},new Proxy(cp,{get:hostile}),
    {...cp,get phase(){hostile();}},{...cp,evidence_refs:[...cp.evidence_refs.slice(0,16),{...reference,canonical_utf8_bytes:'4097'}]}];
  for(const value of cases)await assert.rejects(()=>f.repo.saveTransactionIndexCheckpoint(claim,options,value),/invalid_checkpoint/);
  for(const value of [{...options,readOriginal:hostile},new Proxy(options,{get:hostile}),{...options,scope:new Proxy(scope,{get:hostile})}])
    await assert.rejects(()=>f.repo.saveTransactionIndexCheckpoint(claim,value,cp));
  await assert.rejects(()=>f.repo.saveTransactionIndexCheckpoint(new Proxy(claim,{get:hostile}),options,cp));
  await assert.rejects(()=>f.repo.saveTransactionIndexCheckpoint(claim,options,cp,undefined),/invalid_input/);
  assert.equal(f.calls.length,0);
});

test('ordinary failed-claim recovery can detach exact17 metadata without quarantine or reset; it is not worker dispatch or source authority',async()=>{
  const calls=[],request={operation_id:id(1),observation_period:{start_date:'2024-01-01',end_date:'2024-12-31'}},cp=checkpoint(),
    repo=jobs({async query(sql,values){calls.push({sql,values});
      if(sql.includes('custom-cohort-job:claim'))return {rowCount:1,rows:[{...scope,...claim,actor_user_id:id(5),
        request_payload:request,request_sha256:assessmentEvidenceDigest(request),checkpoint:cp}]};
      if(sql.includes('custom-cohort-job:quarantine'))assert.fail('exact17 retained metadata is not corrupt');return {rowCount:0,rows:[]};}});
  const [row]=await repo.claimDue({limit:1});assert.equal(row.attempts,5);assert.deepEqual(row.checkpoint,cp);
  assert.ok(Object.isFrozen(row.checkpoint.evidence_refs));
  const q=calls.find(q=>q.sql.includes('custom-cohort-job:claim')).sql;
  assert.match(q,/attempts<5/);assert.match(q,/attempts=attempts\+1/);assert.match(q,/claim_token=gen_random_uuid\(\)/);
  assert.match(q,/c\.consumed_claim_token IS NULL/);assert.doesNotMatch(q,/checkpoint\s*=|attempts=0|attempts=1|context_sha256\s*=/);
  const worker=service('customCohortCaptureJobWorker');assert.ok(!worker.includes('progressOriginalFrozenCaptureJobSelectedTransactionIndexReferencesV2'));
});

test('ordinary claim still quarantines malformed exact17 retained metadata under only that exact fresh claim',async()=>{
  const request={operation_id:id(1),observation_period:{start_date:'2024-01-01',end_date:'2024-12-31'}},cp=checkpoint();
  for(const bad of [{...cp,evidence_refs:cp.evidence_refs.slice(1)},{...cp,extra:true},{...cp,evidence_refs:Array(17)}]){
    const calls=[],repo=jobs({async query(sql,values){calls.push({sql,values});
      if(sql.includes('custom-cohort-job:claim'))return {rowCount:1,rows:[{...scope,...claim,actor_user_id:id(5),
        request_payload:request,request_sha256:assessmentEvidenceDigest(request),checkpoint:bad}]};
      if(sql.includes('custom-cohort-job:quarantine'))return {rowCount:1,rows:[{operation_id:id(1)}]};return {rowCount:0,rows:[]};}});
    assert.deepEqual(await repo.claimDue(),[]);assert.deepEqual(calls.at(-1).values,[id(1),id(2),5]);
  }
});

test('dedicated single-use yield derives actual exact17 head in same native TX and preserves fifth attempt with bounded compact reference',async()=>{
  const f=yieldFixture(),r=await f.repo.yieldTransactionIndexIssued(claim,options);assert.equal(r.attempts,5);
  assert.equal(r.continuation_sequence,22000011);assert.equal(r.fresh_claim_required,true);assert.equal(r.context_complete,false);assert.equal(r.pin_transfer,false);
  const q=f.calls.find(q=>q.sql.includes(':yield-transaction-index'));
  assert.deepEqual(q.values,[id(1),id(2),5,id(3),id(4),'7','SUBJECT',id(5)]);
  for(const text of ['h.issued_transaction_id=txid_current()','app.neighborhood_selected_transaction_index_v2_checkpoint_matches(',
    "job.checkpoint->>'phase'='frozen_selected_transaction_index_refs_v2'",'job.context_sha256 IS NULL',
    'neighborhood_custom_cohort_v2_continuations.consumed_claim_token IS NOT NULL','progress_reference<>EXCLUDED.progress_reference',
    "SET status='retry',claim_token=NULL,lease_expires_at=NULL"])assert.ok(q.sql.includes(text),text);
  assert.doesNotMatch(q.sql,/\bSET\s+attempts\s*=|,\s*attempts\s*=|last_error_code\s*=|BEGIN|COMMIT|DELETE|ST_DWithin/);
});

test('dedicated yield detects autocommit BEFORE DML and a switched ending native TX; absent native head/continuation is never success',async()=>{
  const early=yieldFixture({auto:true});await assert.rejects(early.repo.yieldTransactionIndexIssued(claim,options),/caller_transaction_required/);
  assert.ok(!early.calls.some(q=>q.sql.includes(':yield-transaction-index')));
  await assert.rejects(yieldFixture({late:true}).repo.yieldTransactionIndexIssued(claim,options),/caller_transaction_required/);
  await assert.rejects(yieldFixture({missing:true}).repo.yieldTransactionIndexIssued(claim,options),/claim_lost/);
});

test('index-only22000011 ceiling cannot widen old phases, omit exact17 or buy another failure attempt',async()=>{
  for(const delta of [{sequence:0},{sequence:22000012},{sequence:1.5},{actualPhase:'frozen_selected_semantic_refs_v2'},
    {attempts:4},{bytes:'4097'}])await assert.rejects(yieldFixture(delta).repo.yieldTransactionIndexIssued(claim,options),/corrupt/);
  const s=service('customCohortV2ContinuationRepository'),old=s.slice(s.indexOf('async yieldIssued('),s.indexOf('async yieldTransactionIndexIssued('));
  assert.ok(old.includes('?20000010:'));assert.ok(old.includes('?18000009:16000008'));assert.ok(!old.includes('22000011'));
  const phases=s.slice(s.indexOf('const PHASES'),s.indexOf('const fail'));assert.ok(!phases.includes(phase));
});

test('dedicated yield rejects caller phase/receipt/checkpoint/count/authority/token and extra arguments before SQL',async()=>{
  const f=yieldFixture(),hostile=()=>assert.fail('hostile DATA executed');
  for(const key of ['phase','progress_reference','checkpoint','done','continuation_sequence','attempts','readOriginal','claim_token'])
    await assert.rejects(()=>f.repo.yieldTransactionIndexIssued(claim,{...options,[key]:hostile}),/invalid_input/);
  for(const value of [new Proxy(options,{get:hostile}),{...options,get actorUserId(){hostile();}},
    {...options,scope:new Proxy(scope,{get:hostile})}])await assert.rejects(()=>f.repo.yieldTransactionIndexIssued(claim,value),/invalid_input/);
  await assert.rejects(()=>f.repo.yieldTransactionIndexIssued(claim,options,undefined),/invalid_input/);assert.equal(f.calls.length,0);
});

test('atomic owner writes blob, native bounded delta/head, exact17 checkpoint and dedicated single-use yield ONLY after ALL ending original/authority fences',()=>{
  const s=service('customCohortContextCapture'),ending=s.indexOf("!same(await jobs[recoveredOwnedFirstSource?'readRecoveredFirstSourceBirthCheckpoint':ownedCompletedIndexFirstSource?'readOwnedFirstSourceBirthCheckpoint':'readTransactionIndexCheckpoint'](claim,jobOptions),checkpoint)"),
    next=s.indexOf("!same(await selectedTransactionIndexStore[readingCompletedIndexFirstSource?'readFirstAccount':'readNext'](),selectedTransactionIndexPacket)",ending),
    start=s.indexOf('if(progressingSelectedTransactionIndex){',next),put=s.indexOf('await blobs.put(canonicalAssessmentJson(plan))',start),
    advance=s.indexOf('await selectedTransactionIndexStore.advance(receiptReference)',put),save=s.indexOf('await jobs.saveTransactionIndexCheckpoint(',advance),
    yieldAt=s.indexOf('.yieldTransactionIndexIssued(claim,jobOptions)',save),returned=s.indexOf('return freeze(result)',yieldAt),
    readOnly=s.indexOf('if(readingSelectedTransactionSource){',returned);
  assert.ok(ending>0&&next>ending&&start>next&&put>start&&advance>put&&save>advance&&yieldAt>save&&returned>yieldAt&&readOnly>returned);
  const body=s.slice(start,readOnly);for(const text of ["phase:'frozen_selected_transaction_index_refs_v2'",
    'checkpoint.evidence_refs.slice(0,16)','plan.after.done',"global_economic_transaction_deduplication:false",
    "economic_transactions:'not_established'","calendar_quarters:'not_established'","publication:'not_established'",
    "production_speed:'not_established'",'context_complete:false,pin_transfer:false',"report_update:'none'",'Buffer.byteLength(JSON.stringify(result))>16000'])assert.ok(body.includes(text),text);
  assert.equal((s.match(/selectedTransactionIndexStore\.advance\(/g)||[]).length,1);
  assert.doesNotMatch(body,/saveCheckpoint\(|\.yieldIssued\(|readFirstCompleted|readOriginal:|callback|ST_DWithin/);
});

test('progress stage adds only its fixed write mode to complete read owner and stays outside worker/routes/composition/registered migrations',()=>{
  const s=service('customCohortContextCapture'),stage=key=>{
    const start=s.indexOf(`  ${key}:`);assert.ok(start>0,key);
    const body=s.slice(start+key.length+3),end=body.search(/\n {2}[a-z][a-z0-9_]+:/);
    assert.ok(end>0,key);return body.slice(0,end);
  },read=stage('original_selected_transaction_index_source_refs_v2'),
    write=stage('original_selected_transaction_index_progress_refs_v2').replace('    progressingSelectedTransactionIndex: true,\n','');
  assert.equal(write.replace(/\r/g,''),read.replace(/\r/g,''));
  const method='progressOriginalFrozenCaptureJobSelectedTransactionIndexReferencesV2';
  for(const file of ['customCohortCaptureJobWorker','../../application/customNeighborhoodComposition','../../modules/accounts/customNeighborhoodCohortRouter'])assert.ok(!service(file).includes(method),file);
  const registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8');assert.ok(!registry.includes('20261206_custom_cohort_selected_transaction_index_owner_v2'));
});

test('progress owner refuses caller native/member/keys/ordinal/source callbacks and extra arguments before connection',async()=>{
  let calls=0;const hostile=()=>{calls++;assert.fail('must not execute');},owner=captureOwner({pool:{connect:hostile},sourceMode:'combined-witness2-v1',
    authorizeMarketData:hostile,authorizeCadImprovementData:hostile}),value={auth:{userId:id(5),organizations:[]},accountId:'SUBJECT',assignmentFileId:'7',
    operationId:id(1),observationPeriod:{start_date:'2024-01-01',end_date:'2024-12-31'},discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}},opts={captureJobClaim:claim},
    method='progressOriginalFrozenCaptureJobSelectedTransactionIndexReferencesV2';
  for(const key of ['native_plan','selected_entry','native_packages','first_selected_ordinal','previous','before','receipt_reference','ordinal','readOriginal','sourceAuthority'])
    await assert.rejects(()=>owner[method](value,{...opts,[key]:hostile}),/invalid_options/);
  await assert.rejects(()=>owner[method](value,new Proxy(opts,{get:hostile})),/invalid_options/);
  await assert.rejects(()=>owner[method](value,opts,undefined),/invalid_options/);assert.equal(calls,0);
});

test('unregistered native checkpoint transition uses actual current-TX head, full old16 parent graph or exact prior17 receipt/after and cannot save the same head twice',()=>{
  const sql=readFileSync(new URL('../migrations/20261206_custom_cohort_selected_transaction_index_owner_v2.sql',import.meta.url),'utf8'),
    start=sql.indexOf('CREATE FUNCTION app.neighborhood_transaction_index_v2_checkpoint_transition_matches'),
    q=sql.slice(start,sql.indexOf('CREATE FUNCTION app.neighborhood_selected_transaction_index_v2_admission_matches',start));
  for(const text of ['h.issued_transaction_id=txid_current()','app.neighborhood_selected_transaction_index_v2_checkpoint_matches(op,org,new_cp)',
    "(new_cp->'evidence_refs')-16=old_cp->'evidence_refs'",'h.sequence=1',"jsonb_array_length(old_cp->'evidence_refs')=17",
    "b.canonical_utf8::jsonb->'previous'=old_cp->'evidence_refs'->16","prior.canonical_utf8::jsonb->>'sequence'=(h.sequence-1)::text",
    "prior.canonical_utf8::jsonb->'after'->'done'='false'::jsonb","prior.canonical_utf8::jsonb->'after'=b.canonical_utf8::jsonb->'before'",
    'prior.canonical_utf8_bytes<=4096'])assert.ok(q.includes(text),text);
  for(const key of ['union','eligibility','evidence','metrics','statistics','numeric','semantic'])assert.ok(q.includes(`prior.canonical_utf8::jsonb->'${key}_reference'=h.${key}_reference`));
  assert.doesNotMatch(q,/count\(\*\)|array_agg|jsonb_agg|UPDATE app\.|DELETE|ALTER TABLE|CREATE TRIGGER/);
  for(const m of sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION app\.([a-z0-9_]+)/g))assert.ok(Buffer.byteLength(m[1])<=63,m[1]);
});
