import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCustomCohortContextCapture as create } from '../src/services/neighborhoodAssessment/customCohortContextCapture.js';
const source=name=>readFileSync(new URL('../src/services/neighborhoodAssessment/'+name+'.js',import.meta.url),'utf8'),
  capture=source('customCohortContextCapture'),method='readOriginalFrozenCaptureJobNextSelectedTransactionIndexReferencesV2';

// These are integration-structure and hostile-input tests, NOT a native
// execution of the complete owner or proof of licensed/source/speed acceptance.
test('inactive NEXT owner retains the complete original graph stack and uses dedicated actual16/17 native intent at BOTH ends',()=>{
  const start=capture.indexOf('original_selected_transaction_index_source_refs_v2:'),end=capture.indexOf('original_selected_transaction_index_progress_refs_v2:',start),
    stage=capture.slice(start,end);
  for(const text of ['referencesV2: true','verifying: true','stockVerifying: true','identityVerifying: true',
    'catalogingRecordedGroups: true','readingRecordedCatalog: true','replayingSelectedUnion: true',
    'readingSelectedUnionSubjectHousing: true','readingSelectedUnionFirstEligibility: true',
    'readingSelectedUnionFirstAmenities: true','readingSelectedUnionFirstTransactions: true',
    'readingSelectedMetricSource: true','readingSelectedStatisticsSource: true','readingSelectedFrequencySource: true',
    'readingSelectedNumericSource: true','progressingSelectedSemantic: true','readingSelectedTransactionSource: true',
    'readingSelectedTransactionIndex: true',"['frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2']"])
    assert.ok(stage.includes(text),text);
  assert.equal((capture.match(/readingSelectedTransactionIndex\?'readForTransactionIndex'/g)||[]).length,2);
  assert.match(capture,/readingSelectedTransactionIndex\?'readTransactionIndexCheckpoint':'readCheckpoint'/);
  assert.match(capture,/readingSelectedTransactionIndex\?!\[13,14\]\.includes\(issuedCheckpointReceipts.length\):!\[12,13\]\.includes\(issuedCheckpointReceipts.length\)/);
});

test('native NEXT and the retained compact prefix precede the whole original packet, not a semantic FIRST/caller cursor projection',()=>{
  const next=capture.indexOf("selectedTransactionIndexPacket=await selectedTransactionIndexStore[readingCompletedIndexFirstSource?'readFirstAccount':'readNext']()"),
    decoded=capture.indexOf('retained=prepareCohortSelectedTransactionIndexReceiptV2(retained,expected)',next),
    before=capture.indexOf('eligibilityBefore={selected_ordinal:nativePlan.before.selected_ordinal,done:false}',decoded),
    selected=capture.indexOf('firstSelectedEntry=selectedTransactionIndexPacket.selected_entry',before),
    original=capture.indexOf("readingSelectedTransactionIndex?'subjectAndNextSelectedTransactionIndexAccountPackage'",selected);
  assert.ok(next>0&&decoded>next&&before>decoded&&selected>before&&original>selected);
  const block=capture.slice(next,selected);
  for(const text of ['nativePlan.generation_id!==stock.generation_id','nativePlan.selected_stock_count!==unionCounts.selected_count',
    'selectedTransactionIndexPacket.previous!==null','selectedTransactionIndexPacket.previous,checkpoint.evidence_refs[16]',
    'retained.after.done','retained.sequence!==nativePlan.before.selected_ordinal','!same(retained.after,nativePlan.before)'])assert.ok(block.includes(text),text);
  assert.doesNotMatch(block,/readFirstCompleted|\.slice\(0,16\)|checkpoint\s*:\s*\{|selected_accounts|callback/);
});

test('every retained field, complete native package set and full ending checkpoint/member/first-seen plan are compared before the unretained read-only result',()=>{
  const original=capture.indexOf("readingSelectedTransactionIndex?'subjectAndNextSelectedTransactionIndexAccountPackage'"),
    seventh=capture.indexOf('if(!same(row,metricRowCandidate))',original),
    eighth=capture.indexOf('if(!same(retainedContribution,statisticsContribution))',seventh),
    numeric=capture.indexOf('if(firstSelectedEntry[key]!==statisticsContribution.metrics[key].contribution_exact_value)',eighth),
    keys=capture.indexOf('ordered(selectedTransactionNativeKeys.native_packages)',numeric),
    ending=capture.indexOf('const ending=await createCustomCohortV2SelectionIntentRepository(client)',keys),
    heads=capture.indexOf('!same(await semanticStore.read(),semanticAnchor)',ending),
    checkpoint=capture.indexOf("!same(await jobs[recoveredOwnedFirstSource?'readRecoveredFirstSourceBirthCheckpoint':ownedCompletedIndexFirstSource?'readOwnedFirstSourceBirthCheckpoint':'readTransactionIndexCheckpoint'](claim,jobOptions),checkpoint)",heads),
    plan=capture.indexOf("!same(await selectedTransactionIndexStore[readingCompletedIndexFirstSource?'readFirstAccount':'readNext'](),selectedTransactionIndexPacket)",checkpoint),
    result=capture.indexOf("status:'current_authorized_native_next_selected_transaction_index_originals_reconciled'",plan),
    returned=capture.indexOf('return freeze(result)',result),writes=capture.indexOf('await blobs.put(canonicalAssessmentJson(afterSummary))',returned);
  assert.ok(original>0&&seventh>original&&eighth>seventh&&numeric>eighth&&keys>numeric&&ending>keys&&heads>ending
    &&checkpoint>heads&&plan>checkpoint&&result>plan&&returned>result&&writes>returned);
  const body=capture.slice(result,returned);
  for(const text of ["coverage:'native_next_selected_account_only_after_actual_tenth_fresh_EMPTY'",
    'native_index_candidate:buildCohortSelectedTransactionIndexReceiptV2','plan:selectedTransactionIndexPacket.plan',
    'previous:selectedTransactionIndexPacket.previous','native_index_candidate_retained:false,transaction_index_issued:false',
    'Buffer.byteLength(JSON.stringify(result))>16000'])assert.ok(body.includes(text),text);
  assert.doesNotMatch(body,/await blobs.put|yieldIssued|saveCheckpoint|\.advance\(/);
});

test('NEXT connection does not call installed strict-FIRST readers at either end or change installed guards, ordinary job/worker grammar or activation',()=>{
  assert.match(capture,/else if\(readingSelectedTransactionSource\)firstSelectedEntry=await semanticStore.readFirstCompletedSelectedEntry/);
  assert.match(capture,/else selectedTransactionNativeKeys=await semanticStore.readFirstCompletedTransactionNativeKeys/);
  assert.match(capture,/readingSelectedTransactionSource&&!readingSelectedTransactionIndex\)\{if\(!same\(await semanticStore.readFirstCompletedSelectedEntry/);
  assert.match(capture,/readingSelectedTransactionSource&&!readingSelectedTransactionIndex&&!same\(await semanticStore.readFirstCompletedTransactionNativeKeys/);
  const writes=capture.indexOf('if(progressingSelectedTransactionIndex){'),readOnly=capture.indexOf('if(readingSelectedTransactionSource){',writes);
  assert.equal((capture.match(/selectedTransactionIndexStore\.advance\(/g)||[]).length,1);
  assert.ok(capture.indexOf('selectedTransactionIndexStore.advance(',writes)<readOnly);
  assert.doesNotMatch(capture.slice(readOnly,capture.indexOf('if(progressingSelectedSemantic){',readOnly)),/selectedTransactionIndexStore\.advance\(/);
  for(const file of ['customCohortCaptureJobWorker','../../application/customNeighborhoodComposition','../../modules/accounts/customNeighborhoodCohortRouter'])
    assert.ok(!source(file).includes(method),file);
  const migration=readFileSync(new URL('../migrations/20261205_custom_cohort_selected_transaction_index_v2.sql',import.meta.url),'utf8'),
    registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8');
  assert.match(migration,/RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_owner_unintegrated'/);
  assert.doesNotMatch(registry,/20261206_custom_cohort_selected_transaction_index_owner_v2/);
});

test('new owner admits no caller native plan/member/keys/first-seen/receipt/ordinal/callback or extra arguments before checkout',async()=>{
  let connections=0,policies=0;
  const hostile=()=>assert.fail('hostile DATA must not execute'),service=create({pool:{connect(){connections++;assert.fail('must not connect');}},
    sourceMode:'combined-witness2-v1',authorizeMarketData(){policies++;assert.fail('must not authorize');},authorizeCadImprovementData:hostile}),
    id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,base={auth:{userId:id(1),organizations:[]},accountId:'SUBJECT',
      assignmentFileId:'7',operationId:id(2),observationPeriod:{start_date:'2024-01-01',end_date:'2024-12-31'},
      discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}},
    options={captureJobClaim:{operation_id:id(2),claim_token:id(3),attempts:4}};
  for(const key of ['native_plan','selected_entry','native_packages','first_selected_ordinal','previous','before','receipt_reference','ordinal','readOriginal','sourceAuthority'])
    await assert.rejects(()=>service[method](base,{...options,[key]:hostile}),/invalid_options/);
  for(const value of [new Proxy(options,{get:hostile}),{...options,get captureJobClaim(){hostile();}}])
    await assert.rejects(()=>service[method](base,value),/invalid_options/);
  await assert.rejects(()=>service[method](base,options,undefined),/invalid_options/);
  assert.equal(connections,0);assert.equal(policies,0);
});
