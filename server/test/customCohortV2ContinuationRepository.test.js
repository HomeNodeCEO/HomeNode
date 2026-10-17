import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCustomCohortV2ContinuationRepository as repository } from '../src/services/neighborhoodAssessment/customCohortV2ContinuationRepository.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope={organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'A'},
  claim={operation_id:id(3),claim_token:id(4),attempts:5},options={scope,actorUserId:id(5)},
  reference={content_sha256:'a'.repeat(64),canonical_utf8_bytes:'123'};
// SQL doubles verify detached mechanics only; native issuance/source/current
// rights and failure-history preservation require the cloud PostgreSQL fixture.
function setup({auto=false,bad=false,empty=false,sequence=100001,phase='frozen_recorded_partition_refs_v2'}={}){let tx=30;const calls=[];
  return {calls,owner:repository({async query(sql,values){calls.push({sql,values});
    if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:String(auto?++tx:tx)}]};
    if(sql.includes(':yield'))return {rowCount:1,rows:[{sequence,phase,progress_reference:reference,attempts:bad?4:5}]};
    if(sql.includes(':claim'))return {rowCount:empty?0:1,rows:empty?[]:[{...scope,...claim,claim_token:id(6),actor_user_id:id(5)}]};assert.fail(sql);}})};}

test('issued success continuation preserves fifth attempt, current exact claim and actual native checkpoint',async()=>{
  const {owner,calls}=setup(),result=await owner.yieldIssued(claim,options);
  assert.equal(result.attempts,5);assert.equal(result.continuation_sequence,100001);
  assert.equal(result.context_complete,false);assert.equal(result.pin_transfer,false);assert.ok(Object.isFrozen(result.progress_reference));
  const c=calls.find(c=>c.sql.includes(':yield'));assert.deepEqual(c.values,[claim.operation_id,claim.claim_token,5,...Object.values(scope),id(5)]);
  assert.match(c.sql,/job\.checkpoint->'evidence_refs'->-1/);assert.match(c.sql,/job\.actor_user_id=\$8::uuid/);
  assert.doesNotMatch(c.sql,/\bSET\s+attempts\s*=|,\s*attempts\s*=|last_error_code\s*=|DELETE|BEGIN|COMMIT|ST_DWithin/);
  assert.match(c.sql,/progress_reference<>EXCLUDED\.progress_reference/);
});
test('success continuation needs one actual caller transaction before writes and refuses free checkpoints or count resets',async()=>{
  const auto=setup({auto:true});await assert.rejects(auto.owner.yieldIssued(claim,options),/caller_transaction_required/);
  assert.ok(!auto.calls.some(c=>c.sql.includes(':yield')));
  await assert.rejects(setup({bad:true}).owner.yieldIssued(claim,options),/corrupt/);
  const {owner,calls}=setup();for(const v of [{...options,checkpoint:{}},new Proxy(options,{}),
    {...options,get actorUserId(){assert.fail('getter');}},{...options,scope:{...scope,account_id:'\ud800'}}])
    await assert.rejects(owner.yieldIssued(claim,v),/invalid_/);
  assert.equal(calls.length,0);
});
test('bounded success claim consumes native progress once with fresh token and no retry increment or source authority',async()=>{
  const {owner,calls}=setup(),rows=await owner.claimDue({limit:4,leaseSeconds:900});
  assert.equal(rows[0].claim.attempts,5);assert.notEqual(rows[0].claim.claim_token,claim.claim_token);
  assert.equal(rows[0].authority,'not_established');assert.deepEqual(rows[0].scope,scope);assert.ok(Object.isFrozen(rows[0].claim));
  const sql=calls.find(c=>c.sql.includes(':claim')).sql;assert.match(sql,/FOR UPDATE OF job SKIP LOCKED/);
  assert.match(sql,/consumed_claim_token=gen_random_uuid\(\)/);assert.match(sql,/attempts BETWEEN 1 AND 5/);
  assert.doesNotMatch(sql,/\bSET\s+attempts\s*=|,\s*attempts\s*=|last_error_code\s*=|payload|BEGIN|COMMIT/);
  assert.deepEqual(await setup({empty:true}).owner.claimDue({limit:1,leaseSeconds:15}),[]);
  const auto=setup({auto:true});await assert.rejects(auto.owner.claimDue({limit:1,leaseSeconds:120}),/caller_transaction_required/);
  assert.ok(!auto.calls.some(c=>c.sql.includes(':claim')));
});
test('continuation claim rejects hostile/unbounded options before any database work',async()=>{
  const {owner,calls}=setup();for(const o of [{limit:0,leaseSeconds:120},{limit:5,leaseSeconds:120},
    {limit:1,leaseSeconds:901},{limit:1,leaseSeconds:14},{limit:1,leaseSeconds:120,attempts:0},new Proxy({limit:1,leaseSeconds:120},{}),
    {limit:1,get leaseSeconds(){assert.fail('getter');}}])await assert.rejects(owner.claimDue(o),/invalid_/);
  assert.equal(calls.length,0);
});
test('registered native continuation guards actual heads, root checkpoint, single consume, attempts and atomic release',()=>{
  const name='20261120_custom_cohort_issued_continuations_v2.sql',registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8'),
    sql=readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'),jobs=readFileSync(new URL('../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js',import.meta.url),'utf8');
  assert.ok(registry.indexOf(name)>registry.indexOf('20261119_custom_cohort_recorded_partition_v2.sql'));
  for(const m of sql.matchAll(/CREATE (?:TABLE|FUNCTION|TRIGGER|INDEX|CONSTRAINT TRIGGER) (?:app\.)?([a-z0-9_]+)/g))assert.ok(Buffer.byteLength(m[1])<=63,m[1]);
  for(const s of ['DEFERRABLE INITIALLY DEFERRED','NEW.attempts<OLD.attempts','OLD.consumed_claim_token IS NULL',
    'NEW.progress_reference=OLD.progress_reference',"job.checkpoint->'evidence_refs'->-1 IS DISTINCT FROM actual_reference",
    'stock_traversal_v2_anchors','recorded_partition_v2_heads','BEFORE TRUNCATE','ON DELETE RESTRICT'])assert.ok(sql.includes(s),s);
  assert.match(jobs,/AND NOT EXISTS \(SELECT 1 FROM app\.neighborhood_custom_cohort_v2_continuations/);
  assert.doesNotMatch(sql,/DISABLE TRIGGER|DROP TABLE|ST_DWithin|UPDATE app\.report_files|DELETE FROM/);
});
test('catalog and union continuations admit only issued phases within the finite four-pass ceiling',async()=>{
  const phase='frozen_recorded_catalog_refs_v2',result=await setup({phase,sequence:6000003}).owner.yieldIssued(claim,options);
  assert.equal(result.phase,phase);assert.equal(result.continuation_sequence,6000003);assert.equal(result.attempts,5);
  for(const sequence of [0,8000005,1.5])await assert.rejects(setup({phase,sequence}).owner.yieldIssued(claim,options),/corrupt/);
  assert.equal((await setup({phase:'frozen_selected_union_refs_v2',sequence:8000004}).owner.yieldIssued(claim,options)).continuation_sequence,8000004);
  await assert.rejects(setup({phase:'frozen_free_done_refs_v2'}).owner.yieldIssued(claim,options),/corrupt/);
  const {owner,calls}=setup({phase});
  for(const key of ['phase','progress_reference','done','continuation_sequence','retry_count','catalog_head','readOriginal'])
    await assert.rejects(owner.yieldIssued(claim,{...options,[key]:true}),/invalid_/);
  assert.equal(calls.length,0);
});
test('additive catalog continuation keeps existing atomic guards and refuses backward phase transitions',()=>{
  const name='20261122_custom_cohort_catalog_continuations_v2.sql',registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8'),
    sql=readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
  assert.ok(registry.indexOf(name)>registry.indexOf('20261121_custom_cohort_recorded_catalog_v2.sql'));
  for(const s of ['CHECK(sequence BETWEEN 1 AND 6000003)','CREATE OR REPLACE FUNCTION app.guard_neighborhood_cohort_v2_continuation()',
    'recorded_catalog_v2_heads',"jsonb_array_length(job.checkpoint->'evidence_refs')<>9",
    "NEW.progress_reference IS DISTINCT FROM actual_reference",'OLD.consumed_claim_token IS NULL',
    'NEW.issued_attempts<OLD.issued_attempts',"OLD.phase='frozen_recorded_catalog_refs_v2' AND NEW.phase<>'frozen_recorded_catalog_refs_v2'",
    "OLD.phase='frozen_recorded_partition_refs_v2' AND NEW.phase='frozen_stock_traversal_refs_v2'"])
    assert.ok(sql.includes(s),s);
  assert.doesNotMatch(sql,/DISABLE TRIGGER|DROP TRIGGER|DROP TABLE|DELETE FROM|UPDATE app\.|ST_DWithin|SET attempts|attempts=0/);
});
