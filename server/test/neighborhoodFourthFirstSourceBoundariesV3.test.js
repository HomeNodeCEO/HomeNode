import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortCaptureJobRepository as jobs } from '../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { createCustomCohortContextCapture as context } from '../src/services/neighborhoodAssessment/customCohortContextCapture.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,
  claim={operation_id:id(1),claim_token:id(2),attempts:4},scope={organization_id:id(3),report_file_id:id(4),assignment_file_id:'7',account_id:'A'},
  options={scope,actorUserId:id(5)},reference={content_sha256:'a'.repeat(64),canonical_utf8_bytes:'123'},
  birth={phase:'frozen_selected_transaction_index_refs_v2',evidence_refs:Array.from({length:17},()=>reference)};
// Detached boundary checks; only the actual cloud A/B captures can establish
// native origin or authority and prove the real fourth4 original owner.
test('dedicated owned reader decodes only retained17 and rejects projected18, executable claims and caller roots',async()=>{
  const calls=[],repo=jobs({async query(sql,values){calls.push({sql,values});return {rowCount:1,rows:[{checkpoint:birth}]};}});
  assert.deepEqual(await repo.readFourthFirstSourceBirthCheckpoint(claim,options),birth);
  assert.deepEqual(calls[0].values,[claim.operation_id,claim.claim_token,4,...Object.values(scope),id(5)]);
  assert.match(calls[0].sql,/fourth_parent\(\$1::uuid,\$4::uuid,\$2::uuid,\$3::integer\)/);
  assert.match(calls[0].sql,/p.actor_user_id=\$8::uuid/);
  const before=calls.length;
  for(const value of [new Proxy(claim,{getPrototypeOf(){assert.fail('trap');}}),{...claim,get claim_token(){assert.fail('getter');}}])
    await assert.rejects(repo.readFourthFirstSourceBirthCheckpoint(value,options),/invalid_checkpoint/);
  await assert.rejects(repo.readFourthFirstSourceBirthCheckpoint(claim,{...options,checkpoint:birth}),/invalid_checkpoint/);
  assert.equal(calls.length,before);
  const projected=jobs({async query(){return {rowCount:1,rows:[{checkpoint:{phase:'frozen_selected_source_resolution_refs_v3',evidence_refs:[...birth.evidence_refs,reference]}}]};}});
  await assert.rejects(projected.readFourthFirstSourceBirthCheckpoint(claim,options),/invalid_checkpoint/);
});
test('fourth4 original owner admits only its claim and bounded signal/deadline, never source/cursor/phase adapters',async()=>{
  const service=context({pool:{connect(){assert.fail('must not connect');}},sourceMode:'combined-witness2-v1',
    authorizeMarketData(){assert.fail('policy');},authorizeCadImprovementData(){assert.fail('CAD policy');}}),
    run=(...a)=>service.readCoveredOriginalFrozenCaptureJobFourthFirstSourceReferencesV3(...a),
    input={auth:{userId:id(5),organizations:[]},operationId:id(1),assignmentFileId:'7',accountId:'A',
      observationPeriod:{start_date:'2024-01-01',end_date:'2024-12-31'},discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}};
  for(const args of [[],[input],[input,{},{}]])assert.throws(()=>run(...args),/invalid_options/);
  for(const key of ['checkpoint','phase','readOriginal','cursor','native_key','parent','sourceAuthority','attempts'])
    await assert.rejects(run(input,{captureJobClaim:claim,[key]:()=>assert.fail('adapter')}),/invalid_options/);
  await assert.rejects(run(input,{captureJobClaim:new Proxy(claim,{getPrototypeOf(){assert.fail('claim trap');}})}),/invalid_/);
});
