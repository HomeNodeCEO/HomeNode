import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runCustomCohortInitialV2JobOnce as run } from '../src/services/neighborhoodAssessment/customCohortInitialV2JobWorker.js';
import { createCustomCohortInitialV2JobRepository as repository } from '../src/services/neighborhoodAssessment/customCohortInitialV2JobRepository.js';
import { createCustomCohortCaptureJobRepository as jobs } from '../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { assessmentEvidenceDigest } from '../src/services/neighborhoodAssessment/contract.js';

const id=n=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const claim={operation_id:id('1'),claim_token:id('2'),attempts:5},scope={organization_id:id('3'),report_file_id:id('4'),assignment_file_id:'7',account_id:'FIXTURE'};
const request={operation_id:claim.operation_id,observation_period:{start_date:'2024-01-01',end_date:'2024-12-31'},
  discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'},execution_mode:'frozen-originals-v2'};
function fixture({idle=false,cancel=false,actorError,stockError,prefixError,badStock,badPrefix,wrongRequest}={}){
  const calls=[],failures=[],row={claim,scope,actor_user_id:id('5'),authority:'not_established'};
  const args={pool:{async connect(){return{async query(){return{rowCount:0,rows:[]};},release(){}};}},
    claimRepositoryFactory:()=>({async claimDue(){return idle?[]:[row];}}),
    repositoryFactory:()=>({async heartbeat(){return{cancellation_requested:cancel};},async readRequest(){return wrongRequest??request;},
      async failClaim(c,reason){assert.deepEqual(c,claim);failures.push(reason);return{status:'failed'};}}),
    async loadActor(){if(actorError)throw actorError;return{userId:row.actor_user_id};},cohortService:{
      async prepareFrozenCaptureJobStock(input,options){calls.push({method:'stock',input,options});if(stockError)throw stockError;
        return{status:'stock_prepared',operation_id:claim.operation_id,report_update:'none',...badStock};},
      async continueFrozenCaptureJobSourcePrefixReferencesV2Page(input,options){calls.push({method:'prefix',input,options});if(prefixError)throw prefixError;
        return{status:'source_reference_prefix_retained',operation_id:claim.operation_id,context_complete:false,pin_transfer:false,report_update:'none',
          continuation:{status:'continuation_pending',phase:'frozen_source_refs_v2',attempts:5,fresh_claim_required:true,context_complete:false,pin_transfer:false},...badPrefix};},
    }};return{args,calls,failures};
}
test('initial worker invokes only actual stock then prefix, without caller routing or lease completion',async()=>{
  const f=fixture();assert.deepEqual(await run(f.args),{status:'continuation_pending',operation_id:claim.operation_id,context_complete:false,pin_transfer:false,report_update:'none'});
  assert.deepEqual(f.calls.map(c=>c.method),['stock','prefix']);assert.deepEqual(f.calls[0].input,f.calls[1].input);
  assert.deepEqual(Object.keys(f.calls[0].options),['captureJobClaim','signal']);assert.deepEqual(f.failures,[]);
});
test('idle, revoked identity, cancellation and foreign requests never start stock',async()=>{
  for(const options of [{idle:true},{actorError:Error('custom_cohort_job_actor_access_revoked')},{cancel:true},
    {wrongRequest:{...request,execution_mode:undefined}},{wrongRequest:{...request,private_sales_import:{}}}]){
    const f=fixture(options);await run(f.args);assert.equal(f.calls.length,0);
  }
});
test('failed or mismatched stock never enters prefix and never resets failure attempts',async()=>{
  for(const options of [{stockError:Error('stock refused')},{badStock:{status:'registered'}},{badStock:{report_update:'saved'}}]){
    const f=fixture(options);assert.equal((await run(f.args)).status,'failed');assert.equal(f.calls.length,1);assert.deepEqual(f.failures,['capture_failed']);
  }
});
test('uncertain prefix commit cannot overwrite its committed successor lease',async()=>{
  const f=fixture({prefixError:Object.assign(Error('lost COMMIT'),{outcome_unknown:true})});
  const prior=f.args.repositoryFactory;f.args.repositoryFactory=()=>({...prior(),async failClaim(){throw Error('custom_cohort_capture_job_claim_lost');}});
  assert.equal((await run(f.args)).status,'outcome_unknown');
});
test('native initial claims are closed, transaction bound and use only the existing failure ceiling',async()=>{
  const queries=[];const r=repository({async query(sql,values){queries.push({sql,values});
    if(sql.includes(':transaction'))return{rowCount:1,rows:[{transaction_id:'123'}]};
    if(sql.includes(':claim */'))return{rowCount:1,rows:[{...claim,...scope,actor_user_id:id('5')}]};return{rowCount:0,rows:[]};}});
  assert.equal((await r.claimDue({leaseSeconds:300}))[0].claim.attempts,5);
  const q=queries.find(q=>q.sql.includes(':claim */')).sql;
  assert.match(q,/job\.attempts<5/);assert.match(q,/attempts=job\.attempts\+1/);assert.match(q,/FOR UPDATE OF job SKIP LOCKED/);
  for(const sql of queries.filter(q=>/expire|:claim \*\//.test(q.sql)).map(q=>q.sql)){
    assert.match(sql,/job\.checkpoint IS NULL OR job\.checkpoint->>'phase' IN \('subject','frozen_stock_v1'\)/);
    assert.match(sql,/initial_v2_jobs/);assert.doesNotMatch(sql,/SET .*checkpoint|attempts=0|source_records|ST_DWithin/);
  }
  let count=0;const closed=repository({async query(){count++;assert.fail('SQL');}});
  for(const options of [{leaseSeconds:14},{leaseSeconds:901},{leaseSeconds:300,phase:'subject'},new Proxy({leaseSeconds:300},{}),{get leaseSeconds(){assert.fail('getter');}}])
    await assert.rejects(closed.claimDue(options),/invalid_/);
  assert.equal(count,0);
});
test('execution discriminator is retained in the exact request digest and excluded from generic claims and expiry',async()=>{
  const queries=[],r=jobs({async query(sql,values){queries.push({sql,values});
    if(sql.includes(':request-read */'))return{rowCount:1,rows:[{request_payload:request,request_sha256:assessmentEvidenceDigest(request)}]};
    return{rowCount:0,rows:[]};}});
  assert.deepEqual(await r.readRequest(claim,{scope,actorUserId:id('5')}),request);await r.claimDue();
  for(const q of queries.filter(q=>/:expire|:claim \*\//.test(q.sql)))assert.match(q.sql,/request_payload->>'execution_mode' IS DISTINCT FROM 'frozen-originals-v2'/);
  for(const bad of [{...request,execution_mode:'anything'},{...request,discovery:undefined},{...request,private_sales_import:{}}])
    await assert.rejects(r.enqueue({scope,actorUserId:id('5'),request:bad}),/invalid_/);
});
test('initial migration remains dormant and requires independent enrollment, native fresh claim and paired COMMIT',()=>{
  const name='20261211_custom_cohort_initial_dispatch_v2.sql',sql=readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'),
    registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8');
  assert.ok(!registry.includes(name));
  for(const m of sql.matchAll(/CREATE (?:TABLE|FUNCTION|TRIGGER) (?:app\.)?([a-z0-9_]+)/g))assert.ok(Buffer.byteLength(m[1])<=63);
  for(const text of ['job.attempts<>0','job.checkpoint IS NOT NULL','NEW.claim_transaction_id:=txid_current()',
    'DEFERRABLE INITIALLY DEFERRED','neighborhood_initial_v2_enrollment_required','NEW.attempts<>job.attempts+1','job.attempts>=5',
    'OLD.lease_expires_at<=clock_timestamp()'])assert.ok(sql.includes(text),text);
});
