import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortCompletedIndexNextSourceV3Repository as create,
  createCustomCohortOwnedNextSourceV3Repository as createOwned } from '../src/services/neighborhoodAssessment/customCohortCompletedIndexNextSourceV3Repository.js';
import { NEIGHBORHOOD_OWNED_NEXT_SOURCE_ORIGINAL_PACKAGE_V3_SQL as OWNED_NEXT_PACKET } from '../src/services/neighborhoodAssessment/neighborhoodNextCompletedIndexSourceOriginalPackageV3.js';
import { createCustomCohortContextCapture as capture } from '../src/services/neighborhoodAssessment/customCohortContextCapture.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
  keys=['union_reference','eligibility_reference','evidence_reference','metrics_reference','statistics_reference','numeric_reference','semantic_reference'],
  expected={command_id:id(1),...Object.fromEntries(keys.map((k,i)=>[k,ref(i+1)])),generation_id:id(2),selected_stock_count:2},
  receipt={format:'cohort_selected_transaction_index_receipt_v2',...expected,sequence:3,previous:ref(8),
    before:{selected_ordinal:2,source_record_keys:3,legacy_sale_keys:2,done:false},
    after:{selected_ordinal:2,source_record_keys:3,legacy_sale_keys:2,done:true},selected_entry:null,
    association_anchor_count:0,source_package_count:0,legacy_package_count:0,new_source_record_keys:0,new_legacy_sale_keys:0},
  member={account_id:'B',ordinal:2,partition_ordinal:2,entry_reference:ref(1),metric_row_reference:ref(2),contribution_row_reference:ref(3)},
  first={transaction_id:'101',head_reference:ref(9),head_sequence:3,receipt,expected,kind:'source_record',native_key:'501',first_selected_ordinal:1,
    selected_entry:{...member,account_id:'A',ordinal:1},bindings_match:true},
  next={transaction_id:'101',generation_id:id(2),...member,index_reference:ref(9),index_sequence:3,
    kind:'source_record',native_key:'503',first_selected_ordinal:2},
  claim={operation_id:id(3),claim_token:id(4),attempts:5},scope={organization_id:id(5),report_file_id:id(6),assignment_file_id:'7',account_id:'SUBJECT'},
  copy=v=>structuredClone(v);
function fixture(rows=[copy(next)],predecessor=copy(first),factory=create){
  const calls=[];let reads=0;
  const client={async query(sql,values){calls.push({sql,values});
    const result=sql.includes(':transaction */')?{transaction_id:'101'}:sql.includes(':native-first */')?predecessor:rows[Math.min(reads++,rows.length-1)];
    return result===null?{rowCount:0,rows:[]}:{rowCount:1,rows:[result]};
  }},input={client,claim:{...claim},scope:{...scope},actorUserId:id(7)};
  return {repo:factory(input),calls,input};
}

test('owned18 NEXT requires actual native owned birth/preclaim/current claim for both independent selectors, without17 projection or progress',async()=>{
  const {repo,calls}=fixture([copy(next)],copy(first),createOwned);
  const result=await repo.readNextSource();assert.equal(result.source.native_key,'503');
  assert.equal(result.read_only,true);assert.equal(result.source_authority,false);assert.equal(result.originals_reconciled,false);
  for(const {sql}of calls.filter(c=>!c.sql.includes(':transaction */'))){
    assert.match(sql,/app\.neighborhood_source_resolution_v3_owned_first_parent\(/);
    assert.match(sql,/app\.neighborhood_source_resolution_v3_owned_first\(/);
    assert.doesNotMatch(sql,/neighborhood_selected_transaction_index_v2_checkpoint_matches|jsonb_set|\b(?:INSERT|DELETE|OFFSET)\b/i);
  }
  assert.match(OWNED_NEXT_PACKET,/source_record_id>first_source.native_key::bigint/);
  assert.match(OWNED_NEXT_PACKET,/legacy_sale_key COLLATE "C">first_source.native_key COLLATE "C"/);
  assert.match(OWNED_NEXT_PACKET,/app\.neighborhood_source_resolution_v3_owned_first_parent\(/);
  assert.doesNotMatch(OWNED_NEXT_PACKET,/neighborhood_selected_transaction_index_v2_checkpoint_matches|jsonb_set/);
  await assert.rejects(fixture([null],copy(first),createOwned).repo.readNextSource(),/no_next_registered_source/);
  const missingBirth=fixture([copy(next)],null,createOwned);
  await assert.rejects(missingBirth.repo.readNextSource(),/claim_or_completed_index_lost/);
  assert.equal(missingBirth.calls.some(c=>c.sql.includes(':native-next */')),false);
  const changed=fixture([copy(next),{...copy(next),native_key:'504'}],copy(first),createOwned);
  await changed.repo.readNextSource();await assert.rejects(changed.repo.readNextSource(),/native_plan_changed/);
});

test('NEXT follows actual native FIRST with one exact later first-seen member, retaining both namespaces without issuing progress',async()=>{
  const {repo,calls}=fixture(),plan=await repo.readNextSource();
  assert.deepEqual(plan.predecessor,{kind:'source_record',native_key:'501',first_selected_ordinal:1});
  assert.deepEqual(plan.source,{kind:'source_record',native_key:'503',first_selected_ordinal:2});
  assert.deepEqual(plan.selected_entry,member);assert.equal(plan.format,'cohort_completed_index_next_source_plan_v3');
  assert.equal(plan.read_only,true);assert.equal(plan.source_authority,false);assert.equal(plan.originals_reconciled,false);
  assert.deepEqual(await repo.readNextSource(),plan);assert.equal(calls.length,5);
  for(const query of calls.filter(c=>c.sql.includes(':native-next */'))){
    assert.deepEqual(query.values,[claim.operation_id,id(2),claim.claim_token,5,scope.organization_id,scope.report_file_id,'7','SUBJECT',id(7)]);
    assert.match(query.sql,/source_record_id>first_source.native_key::bigint/);
    assert.match(query.sql,/legacy_sale_key COLLATE "C">first_source.native_key COLLATE "C"/);
    assert.match(query.sql,/edge.kind=k.kind AND edge.native_key=k.native_key/);
    assert.doesNotMatch(query.sql,/\b(?:INSERT|UPDATE\s+app\.|DELETE|OFFSET|array_agg|jsonb_agg)\b/i);
  }
});

test('source-to-legacy and legacy-only NEXT preserve C text order rather than numeric or assumed source-less membership',async()=>{
  const legacy={...copy(next),kind:'legacy_sale',native_key:'10'};
  assert.equal((await fixture([legacy]).repo.readNextSource()).source.native_key,'10');
  const previous=copy(first);previous.kind='legacy_sale';previous.native_key='10';
  previous.receipt.before.source_record_keys=0;previous.receipt.after.source_record_keys=0;
  assert.equal((await fixture([{...legacy,native_key:'3'}],previous).repo.readNextSource()).source.native_key,'3');
  await assert.rejects(fixture([{...legacy,native_key:'2'}],{...previous,native_key:'3'}).repo.readNextSource(),/native_plan_corrupt/);
});

test('missing NEXT refuses without fabricating EMPTY, and malformed, changed or cross-transaction native results refuse',async()=>{
  await assert.rejects(fixture([null]).repo.readNextSource(),/no_next_registered_source/);
  for(const change of [{native_key:'501'},{native_key:'0'},{kind:'free'},{first_selected_ordinal:1},
    {ordinal:3},{account_id:' B'},{generation_id:id(8)},{index_reference:ref(8)},{index_sequence:2},
    {entry_reference:{...ref(1),canonical_utf8_bytes:'1000001'}},{extra:true}])
    await assert.rejects(fixture([{...copy(next),...change}]).repo.readNextSource());
  const changed=fixture([copy(next),{...copy(next),native_key:'504'}]);await changed.repo.readNextSource();
  await assert.rejects(changed.repo.readNextSource(),/native_plan_changed/);
  const crossed=fixture([copy(next),{...copy(next),transaction_id:'102'}]);await crossed.repo.readNextSource();
  await assert.rejects(crossed.repo.readNextSource(),/caller_transaction_required/);
});

test('closed NEXT API snapshots scope and refuses caller keys, cursors, callbacks, getters and Proxy adapters before IO',async()=>{
  const {repo,calls,input}=fixture();await assert.rejects(repo.readNextSource({native_key:'503'}),/invalid_input/);
  assert.equal(calls.length,0);assert.throws(()=>create(input,undefined),/invalid_input/);
  for(const key of ['source','native_key','cursor','ordinal','plan','sourceAuthority'])
    assert.throws(()=>create({...input,[key]:()=>assert.fail('callback')}),/invalid_input/);
  assert.throws(()=>create(new Proxy(input,{})),/invalid_input/);
  assert.throws(()=>create({...input,get scope(){assert.fail('getter');}}),/invalid_input/);
  input.claim.claim_token=id(99);input.scope.account_id='CHANGED';await repo.readNextSource();
  assert.equal(calls.find(c=>c.sql.includes(':native-next */')).values[2],claim.claim_token);
  assert.equal(calls.find(c=>c.sql.includes(':native-next */')).values[7],'SUBJECT');
});

for(const method of ['readCoveredOriginalFrozenCaptureJobCompletedIndexNextSourceResolutionReferencesV3',
  'readCoveredOriginalFrozenCaptureJobOwnedNextSourceReferencesV3'])test(`${method} admits only input, exact claim and budget, requiring both source policies before connection`,async()=>{
  let calls=0;const hostile=()=>{calls++;assert.fail('no IO');},
    input={auth:{userId:id(7),organizations:[]},accountId:'SUBJECT',assignmentFileId:'7',operationId:claim.operation_id,
      observationPeriod:{start_date:'2025-01-01',end_date:'2026-10-07'},discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}},
    service=capture({pool:{connect:hostile},sourceMode:'combined-witness2-v1',authorizeMarketData:hostile,authorizeCadImprovementData:hostile});
  assert.throws(()=>service[method](input,{captureJobClaim:claim},undefined),/invalid_options/);
  for(const key of ['source','native_key','cursor','ordinal','packet','membership','resolve','sourceAuthority'])
    await assert.rejects(service[method](input,{captureJobClaim:claim,[key]:hostile}),/invalid_options/);
  const revoked=Proxy.revocable(claim,{});revoked.revoke();
  for(const value of [new Proxy(claim,{}),revoked.proxy])
    await assert.rejects(service[method](input,{captureJobClaim:value}),/invalid_options/);
  await assert.rejects(capture({pool:{connect:hostile},sourceMode:'combined-witness2-v1',authorizeMarketData:hostile})[method](input,{captureJobClaim:claim}),/CAD_source_policy_required/);
  assert.equal(calls,0);
});
