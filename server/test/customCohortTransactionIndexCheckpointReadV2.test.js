import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCustomCohortCaptureJobRepository as create } from '../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,ref={content_sha256:'a'.repeat(64),canonical_utf8_bytes:'123'},
  claim={operation_id:id(1),claim_token:id(2),attempts:4},options={scope:{organization_id:id(3),report_file_id:id(4),
    assignment_file_id:'7',account_id:'SUBJECT'},actorUserId:id(5)},
  checkpoint=(count=17)=>({phase:count===16?'frozen_selected_semantic_refs_v2':'frozen_selected_transaction_index_refs_v2',
    evidence_refs:Array.from({length:count},()=>({...ref}))});
function fixture(value=checkpoint()){
  const queries=[],repo=create({async query(sql,values){queries.push({sql,values});return {rowCount:1,rows:[{checkpoint:value}]};}});
  return {repo,queries};
}

test('separate inactive checkpoint read accepts only exact16/17 and preserves exact live scope/claim/actor/context-null fences without writes',async()=>{
  for(const count of [16,17]){
    const f=fixture(checkpoint(count)),r=await f.repo.readTransactionIndexCheckpoint(claim,options);
    assert.deepEqual(r,checkpoint(count));assert.ok(Object.isFrozen(r)&&Object.isFrozen(r.evidence_refs)&&Object.isFrozen(r.evidence_refs[0]));
    assert.deepEqual(f.queries[0].values,[claim.operation_id,claim.claim_token,4,id(3),id(4),'7','SUBJECT',id(5)]);
    for(const text of ['transaction-index-checkpoint-read',"status='running'",'lease_expires_at>clock_timestamp()',
      'actor_user_id=$8::uuid','cancellation_requested_at IS NULL','context_sha256 IS NULL'])assert.ok(f.queries[0].sql.includes(text),text);
    assert.doesNotMatch(f.queries[0].sql,/INSERT|UPDATE|DELETE|SET lease_expires_at|SET attempts/);
  }
});

test('new read cannot widen ordinary checkpoint reads, save or worker grammar to phase17',async()=>{
  const f=fixture();
  await assert.rejects(()=>f.repo.readCheckpoint(claim,options),/invalid_checkpoint/);
  const before=f.queries.length;await assert.rejects(()=>f.repo.saveCheckpoint(claim,options,checkpoint()),/invalid_checkpoint/);
  assert.equal(f.queries.length,before,'ordinary save rejects phase17 before SQL');
  const source=readFileSync(new URL('../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js',import.meta.url),'utf8'),
    phases=source.slice(source.indexOf('const PHASES'),source.indexOf('const STATUSES'));
  assert.doesNotMatch(phases,/frozen_selected_transaction_index_refs_v2/);
});

test('missing, projected, overlong, accessor, proxy, sparse and executable checkpoint DATA cannot become native NEXT authority',async()=>{
  const hostile=()=>assert.fail('hostile DATA must not execute'),cp=checkpoint(),accessor=[...cp.evidence_refs];
  Object.defineProperty(accessor,'0',{enumerable:true,get:hostile});
  const revoked=Proxy.revocable(cp,{get:hostile});revoked.revoke();
  const cases=[null,{...cp,phase:'frozen_selected_numeric_refs_v2'},{...cp,evidence_refs:cp.evidence_refs.slice(1)},
    {...checkpoint(16),evidence_refs:cp.evidence_refs},{...cp,extra:true},{...cp,phase:{toString:hostile}},
    new Proxy(cp,{get:hostile}),revoked.proxy,{...cp,get phase(){hostile();}},
    {...cp,evidence_refs:new Proxy(cp.evidence_refs,{get:hostile})},{...cp,evidence_refs:Array(17)},
    {...cp,evidence_refs:accessor},{...cp,evidence_refs:Object.assign([...cp.evidence_refs],{toJSON:hostile})},
    {...cp,evidence_refs:[{...ref,toJSON:hostile},...cp.evidence_refs.slice(1)]},
    {...cp,evidence_refs:[new Proxy(ref,{get:hostile}),...cp.evidence_refs.slice(1)]},
    {...cp,evidence_refs:[...cp.evidence_refs.slice(0,16),{...ref,canonical_utf8_bytes:'4097'}]}];
  for(const value of cases){const f=fixture(value);await assert.rejects(()=>f.repo.readTransactionIndexCheckpoint(claim,options),/invalid_checkpoint/);
    assert.equal(f.queries.length,1);}
});

test('new read admits no caller cursor/checkpoint/receipt/callback or extra arguments before database access',async()=>{
  const f=fixture(),hostile=()=>assert.fail('hostile DATA must not execute');
  for(const value of [{...options,ordinal:2},{...options,checkpoint:checkpoint()},{...options,readOriginal:hostile},
    new Proxy(options,{get:hostile}),{...options,get actorUserId(){hostile();}},
    {...options,scope:new Proxy(options.scope,{get:hostile})}])await assert.rejects(()=>f.repo.readTransactionIndexCheckpoint(claim,value));
  await assert.rejects(()=>f.repo.readTransactionIndexCheckpoint(new Proxy(claim,{get:hostile}),options));
  await assert.rejects(()=>f.repo.readTransactionIndexCheckpoint(claim,options,undefined),/invalid_input/);
  assert.equal(f.queries.length,0);
});
