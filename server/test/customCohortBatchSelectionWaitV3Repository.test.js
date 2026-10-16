import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCustomCohortBatchSelectionWaitV3Repository as repository } from '../src/services/neighborhoodAssessment/customCohortBatchSelectionWaitV3Repository.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,
  scope={organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'A'},
  claim={operation_id:id(3),claim_token:id(4),attempts:5},options={scope,actorUserId:id(5)},
  reference={content_sha256:'a'.repeat(64),canonical_utf8_bytes:'123'},
  stored={status:'awaiting_selection',attempts:5,claim_token:null,lease_expires_at:null,catalog_reference:reference};
function fixture({retained=stored,moveTx=false}={}){
  const calls=[];let queries=0;
  const owner=repository({async query(sql,values){calls.push({sql,values});
    if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:String(moveTx?++queries:30)}]};
    if(sql.includes(':release'))return {rowCount:1,rows:[{status:'awaiting_selection',attempts:5,catalog_reference:reference}]};
    if(sql.includes(':retained'))return {rowCount:retained?1:0,rows:retained?[retained]:[]};assert.fail(sql);
  }});return {owner,calls};
}

test('batch wait reads back the actual scoped lease-neutral row in the SAME caller transaction',async()=>{
  const {owner,calls}=fixture(),r=await owner.awaitSelection(claim,options);
  assert.equal(r.status,'awaiting_selection');assert.equal(r.attempts,5);assert.equal(r.lease_released,true);
  assert.equal(r.context_complete,false);assert.equal(r.pin_transfer,false);assert.equal(r.genuine_selection_intent,false);
  const release=calls.find(c=>c.sql.includes(':release')),read=calls.find(c=>c.sql.includes(':retained'));
  assert.ok(calls.indexOf(read)>calls.indexOf(release));
  assert.deepEqual(read.values,[claim.operation_id,...Object.values(scope),id(5)]);
  assert.match(read.sql,/job.actor_user_id=\$6::uuid/);assert.match(release.sql,/lease_expires_at>clock_timestamp\(\)/);
  assert.doesNotMatch(release.sql.slice(0,release.sql.indexOf('WHERE')),/(?:attempts|run_after|last_error_code|checkpoint|context_sha256)\s*=|DELETE|INSERT|BEGIN|COMMIT/);
});

test('a swallowed/orphaned release or changed native retained ownership refuses despite a successful DML RETURNING',async()=>{
  for(const retained of [null,{...stored,status:'running'}, {...stored,claim_token:claim.claim_token},
    {...stored,lease_expires_at:new Date()}, {...stored,attempts:4},
    {...stored,catalog_reference:{...reference,content_sha256:'b'.repeat(64)}}])
    await assert.rejects(fixture({retained}).owner.awaitSelection(claim,options),/claim_lost|retention_conflict/);
  const f=fixture({moveTx:true});await assert.rejects(f.owner.awaitSelection(claim,options),/caller_transaction_required/);
  assert.ok(!f.calls.some(c=>c.sql.includes(':release')));
});

test('batch wait rejects caller status, cursor, choices, callbacks and hostile scope before SQL',async()=>{
  const f=fixture();for(const key of ['done','status','catalog_reference','cursor','included_group_ids','readOriginal','checkpoint','run_after'])
    await assert.rejects(f.owner.awaitSelection(claim,{...options,[key]:true}),/invalid_/);
  for(const bad of [new Proxy(options,{}),{...options,get actorUserId(){assert.fail('getter');}},
    {...options,scope:{...scope,assignment_file_id:'9223372036854775808'}}])await assert.rejects(f.owner.awaitSelection(claim,bad),/invalid_/);
  assert.equal(f.calls.length,0);
});

test('development guard preserves the entire latest intent and downstream native-guard prefix before adding V3 terminal release',()=>{
  const source=readFileSync(new URL('../migrations/20261206_custom_cohort_selected_transaction_index_owner_v2.sql',import.meta.url),'utf8').replaceAll('\r\n','\n'),
    start=source.indexOf('CREATE OR REPLACE FUNCTION app.guard_neighborhood_cohort_v2_selection_wait()'),
    old=source.slice(start,source.indexOf('$$;',start)+3),
    candidate=readFileSync(new URL('./fixtures/neighborhoodBatchSelectionWaitV3Guard.sql',import.meta.url),'utf8').replaceAll('\r\n','\n'),
    mark="  IF receipt->>'format' IS DISTINCT FROM 'cohort_recorded_catalog_receipt_v2'",prefix=old.slice(0,old.indexOf(mark));
  assert.ok(prefix.length>7000);assert.ok(candidate.includes(prefix));
  for(const text of ['cohort_recorded_catalog_batch_receipt_v3','cohort_recorded_group_partition_batch_receipt_v3','cohort_stock_traversal_batch_receipt_v3',
    "receipt->'accounts' IS DISTINCT FROM '[]'::jsonb", "receipt->'entries' IS DISTINCT FROM '[]'::jsonb", "receipt->'original_count' IS DISTINCT FROM '0'::jsonb",
    "receipt->>'sequence' IS DISTINCT FROM head.sequence::text OR receipt->'after'->>'done' IS DISTINCT FROM 'true'"])
    assert.ok(candidate.includes(text),text);
  assert.doesNotMatch(candidate,/DISABLE TRIGGER|DROP TRIGGER|DROP TABLE|DELETE FROM|UPDATE app\.|attempts=0|infinity/);
});
