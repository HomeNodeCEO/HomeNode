import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCustomCohortV2SelectionWaitRepository as repository } from '../src/services/neighborhoodAssessment/customCohortV2SelectionWaitRepository.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope={organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'A'},
  claim={operation_id:id(3),claim_token:id(4),attempts:5},options={scope,actorUserId:id(5)},
  reference={content_sha256:'a'.repeat(64),canonical_utf8_bytes:'123'};
// Detached SQL doubles only. Actual issued-head/ending fences/real COMMIT and
// retained failure history are independently tested in cloud PostgreSQL.
function setup({auto=false,row={status:'awaiting_selection',attempts:5,catalog_reference:reference},lost=false,endAuto=false}={}){
  let queries=0;const calls=[];return {calls,owner:repository({async query(sql,values){calls.push({sql,values});
    if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:String(auto?++queries: endAuto&&++queries===3?31:30)}]};
    if(sql.includes(':release'))return {rowCount:lost?0:1,rows:lost?[]:[row]};assert.fail(sql);}})};}

test('waiting releases only the exact scoped live lease, retaining fifth attempt and native catalog reference',async()=>{
  const {owner,calls}=setup(),result=await owner.awaitSelection(claim,options);
  assert.equal(result.status,'awaiting_selection');assert.equal(result.attempts,5);
  for(const key of ['context_complete','pin_transfer','genuine_selection_intent'])assert.equal(result[key],false);
  assert.equal(result.evidence_retained,true);assert.ok(Object.isFrozen(result.catalog_reference));
  const c=calls.find(c=>c.sql.includes(':release'));
  assert.deepEqual(c.values,[claim.operation_id,claim.claim_token,5,...Object.values(scope),id(5)]);
  for(const s of ['job.actor_user_id=$8::uuid',"job.status='running'",'job.lease_expires_at>clock_timestamp()',
    'job.cancellation_requested_at IS NULL',"job.checkpoint->'evidence_refs'->8 AS catalog_reference"])assert.ok(c.sql.includes(s));
  assert.doesNotMatch(c.sql,/attempts\s*=.*SET|SET\s+attempts|,\s*(?:attempts|run_after|last_error_code|checkpoint|context_sha256)\s*=|DELETE|INSERT|BEGIN|COMMIT|ST_DWithin/);
});
test('waiting requires the same actual caller transaction before and after DML; lost claims refuse',async()=>{
  const a=setup({auto:true});await assert.rejects(a.owner.awaitSelection(claim,options),/caller_transaction_required/);
  assert.ok(!a.calls.some(c=>c.sql.includes(':release')));
  await assert.rejects(setup({endAuto:true}).owner.awaitSelection(claim,options),/caller_transaction_required/);
  await assert.rejects(setup({lost:true}).owner.awaitSelection(claim,options),/claim_lost/);
});
test('waiting rejects free command/head/callback/schedule/checkpoint/attempt data and hostile input before SQL',async()=>{
  const {owner,calls}=setup();
  for(const key of ['checkpoint','done','catalog_reference','groupIds','readOriginal','phase','run_after','retry_count'])
    await assert.rejects(owner.awaitSelection(claim,{...options,[key]:true}),/invalid_/);
  for(const v of [new Proxy(options,{}),{...options,get actorUserId(){assert.fail('getter');}},
    {...options,scope:{...scope,account_id:'\ud800'}},{...options,scope:{...scope,assignment_file_id:'9223372036854775808'}},
    {...options,scope:{...scope,account_id:' A'}}])await assert.rejects(owner.awaitSelection(claim,v),/invalid_/);
  assert.equal(calls.length,0);
});
test('waiting refuses corrupt native results and oversize references',async()=>{
  for(const row of [{status:'retry',attempts:5,catalog_reference:reference},
    {status:'awaiting_selection',attempts:4,catalog_reference:reference},
    {status:'awaiting_selection',attempts:5,catalog_reference:{...reference,canonical_utf8_bytes:'16001'}},
    {status:'awaiting_selection',attempts:5,catalog_reference:{...reference,done:true}}])
    await assert.rejects(setup({row}).owner.awaitSelection(claim,options),/corrupt|invalid_/);
});
test('additive waiting guard admits only issued catalog DONE and leaves no free resume or retry-reset path',()=>{
  const name='20261123_custom_cohort_selection_wait_v2.sql',registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8'),
    sql=readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
  assert.ok(registry.indexOf(name)>registry.indexOf('20261122_custom_cohort_catalog_continuations_v2.sql'));
  for(const s of ["IF OLD.status='awaiting_selection'", "NEW.status<>'cancelled'",'NEW.cancellation_requested_at IS NULL',
    "OLD.status<>'running'",'OLD.lease_expires_at<=clock_timestamp()',"OLD.checkpoint->>'phase' IS DISTINCT FROM 'frozen_recorded_catalog_refs_v2'",
    "jsonb_array_length(OLD.checkpoint->'evidence_refs') IS DISTINCT FROM 9", "receipt->'after'->>'done' IS DISTINCT FROM 'true'",
    "receipt->>'sequence' IS DISTINCT FROM head.sequence::text",'BEFORE INSERT OR UPDATE OR DELETE'])assert.ok(sql.includes(s),s);
  for(let n=1;n<=8;n++)assert.ok(sql.includes(`OLD.checkpoint->'evidence_refs'->${n}`));
  assert.ok(sql.includes("OLD.status='cancelled' AND OLD.checkpoint->>'phase'='frozen_recorded_catalog_refs_v2'"));
  assert.ok(sql.includes("(to_jsonb(NEW)-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'updated_at')"));
  for(const m of sql.matchAll(/CREATE (?:FUNCTION|TRIGGER) (?:app\.)?([a-z0-9_]+)/g))assert.ok(Buffer.byteLength(m[1])<=63);
  assert.doesNotMatch(sql,/DISABLE TRIGGER|DROP TRIGGER|DROP TABLE|UPDATE app\.|DELETE FROM|ST_DWithin|attempts=0|infinity/);
});
