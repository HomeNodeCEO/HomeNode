import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortSecondNextSourceV3Repository as createSecond } from '../src/services/neighborhoodAssessment/customCohortCompletedIndexNextSourceV3Repository.js';
import { NEIGHBORHOOD_SECOND_NEXT_SOURCE_ORIGINAL_PACKAGE_V3_SQL as SECOND_NEXT_PACKET } from '../src/services/neighborhoodAssessment/neighborhoodNextCompletedIndexSourceOriginalPackageV3.js';
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
  claim={operation_id:id(3),claim_token:id(4),attempts:2},scope={organization_id:id(5),report_file_id:id(6),assignment_file_id:'7',account_id:'SUBJECT'},
  copy=v=>structuredClone(v);
function fixture(rows=[copy(next)],predecessor=copy(first),factory=createSecond){
  const calls=[];let reads=0;
  const client={async query(sql,values){calls.push({sql,values});
    const result=sql.includes(':transaction */')?{transaction_id:'101'}:sql.includes(':native-first */')?predecessor:rows[Math.min(reads++,rows.length-1)];
    return result===null?{rowCount:0,rows:[]}:{rowCount:1,rows:[result]};
  }},input={client,claim:{...claim},scope:{...scope},actorUserId:id(7)};
  return {repo:factory(input),calls,input};
}

test('second2 NEXT requires actual initial1/failure1/second2 parent and FIRST for both independent selectors; lost parent, changed NEXT and expired/missing result refuse',async()=>{
  const {repo,calls,input}=fixture([copy(next)],copy(first),createSecond);
  for(const attempts of [1,3,4,5])assert.throws(()=>createSecond({...input,claim:{...claim,attempts}}),/invalid_scope/);
  assert.equal(calls.length,0,'other attempts cannot enter second2 native selection');
  const result=await repo.readNextSource();assert.equal(result.source.native_key,'503');
  assert.equal(result.read_only,true);assert.equal(result.source_authority,false);assert.equal(result.originals_reconciled,false);
  for(const {sql}of calls.filter(c=>!c.sql.includes(':transaction */'))){
    assert.match(sql,/app\.neighborhood_source_resolution_v3_second_parent\(/);
    assert.match(sql,/app\.neighborhood_source_resolution_v3_second_first\(/);
    assert.doesNotMatch(sql,/app\.neighborhood_source_resolution_v3_owned_first_parent\(|neighborhood_selected_transaction_index_v2_checkpoint_matches|jsonb_set|\b(?:INSERT|DELETE|OFFSET)\b/i);
  }
  assert.match(SECOND_NEXT_PACKET,/source_record_id>first_source.native_key::bigint/);
  assert.match(SECOND_NEXT_PACKET,/legacy_sale_key COLLATE "C">first_source.native_key COLLATE "C"/);
  assert.match(SECOND_NEXT_PACKET,/app\.neighborhood_source_resolution_v3_second_parent\(/);
  assert.doesNotMatch(SECOND_NEXT_PACKET,/app\.neighborhood_source_resolution_v3_owned_first_parent\(|jsonb_set/);
  await assert.rejects(fixture([null],copy(first),createSecond).repo.readNextSource(),/no_next_registered_source/);
  const missing=fixture([copy(next)],null,createSecond);
  await assert.rejects(missing.repo.readNextSource(),/claim_or_completed_index_lost/);
  assert.equal(missing.calls.some(c=>c.sql.includes(':native-next */')),false);
  const changed=fixture([copy(next),{...copy(next),native_key:'504'}],copy(first),createSecond);
  await changed.repo.readNextSource();await assert.rejects(changed.repo.readNextSource(),/native_plan_changed/);
});

test('second NEXT refuses caller source/cursor/callback authority and requires both source policies before connection',async()=>{
  let calls=0;const hostile=()=>{calls++;assert.fail('no IO');},method='readCoveredOriginalFrozenCaptureJobSecondNextSourceReferencesV3',
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
