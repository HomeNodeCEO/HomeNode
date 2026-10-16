import assert from 'node:assert/strict';
import { runNeighborhoodBatchSelectedTransactionIndexV3DatabaseChecks } from './neighborhoodBatchSelectedTransactionIndexV3DatabaseChecks.js';
import { runNeighborhoodNativeClaimPair as pair } from './neighborhoodNativeClaimPair.js';
import { withCustomCohortJobTransaction as tx } from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';
import { createCustomCohortCaptureJobRepository as jobs } from '../../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { createCustomCohortV2ContinuationRepository as continuations } from '../../src/services/neighborhoodAssessment/customCohortV2ContinuationRepository.js';
import { createCustomCohortBatchSelectedSemanticV3WorkerRepository as claims } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedSemanticV3WorkerRepository.js';
import { runCustomCohortBatchSelectedSemanticV3JobOnce as run } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedSemanticV3JobWorker.js';
import { runCustomCohortBatchSelectedNumericV3JobOnce as numeric } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedNumericV3JobWorker.js';

/** Thirty-first independent graph. Every selected account is reopened after
 * numeric DONE; bounded provisional ranks alone are never source authority. */
export async function runNeighborhoodBatchSelectedSemanticV3DatabaseChecks({pool,input,scope,actor,service,job,parent,blobs,
  catalogHead,groups,assertParents,setFault,readFault,originalReads,command,batchSelectedTransactionIndexFixture=false}){
  const operation=input.operationId,method='progressCoveredOriginalFrozenCaptureJobBatchSelectedSemanticReferencesV3',
    head=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_semantic_v2_heads WHERE operation_id=$1',[operation])).rows[0],
    rows=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_semantic_v2_rows WHERE operation_id=$1 ORDER BY ordinal',[operation])).rows,
    parents=async()=>{
      const result={};
      for(const table of ['selected_numeric_v2_heads','selected_numeric_v2_rows','selected_numeric_index_v2_rows',
        'selected_statistics_v2_heads','selected_statistics_v2_rows','selected_metrics_v2_heads','selected_metrics_v2_rows',
        'selected_union_v2_heads','selected_eligibility_v2_heads','selected_evidence_v2_heads','selected_initial_dispatch_v2'])
        result[table]=(await pool.query(`SELECT * FROM app.neighborhood_custom_cohort_${table} WHERE operation_id=$1 ORDER BY to_jsonb(neighborhood_custom_cohort_${table})::text COLLATE "C"`,[operation])).rows;
      return result;
    },before={parents:await parents(),catalog:await catalogHead(),groups:await groups(),blobs:await blobs()},
    immutable=async()=>{assert.deepEqual(await parents(),before.parents);assert.deepEqual(await catalogHead(),before.catalog);assert.deepEqual(await groups(),before.groups);
      assert.deepEqual((await pool.query('SELECT * FROM app.neighborhood_custom_cohort_v2_selection_intents WHERE operation_id=$1',[operation])).rows,[command]);await assertParents();},
    body=async reference=>JSON.parse((await pool.query('SELECT canonical_utf8 FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1 AND content_sha256=$2 AND canonical_utf8_bytes=$3',
      [scope.organization_id,reference.content_sha256,reference.canonical_utf8_bytes])).rows[0].canonical_utf8),
    args={pool,cohortService:service,leaseSeconds:900};
  assert.equal(await head(),undefined);assert.deepEqual(await rows(),[]);
  assert.equal((await body(before.parents.selected_numeric_v2_heads[0].receipt_reference)).after.done,true);
  const contributionReceipt=await body(before.parents.selected_statistics_v2_heads[0].receipt_reference),
    index=before.parents.selected_numeric_index_v2_rows.slice().sort((a,b)=>a.ordinal-b.ordinal);
  assert.deepEqual(index.map(r=>r.ordinal),[1,2]);
  let calls=0,ownerError,owned,ownedParent,firstClaim;
  const unchanged=async()=>{
    const current=await job();assert.equal(current.claim_token,owned.claim_token);
    assert.ok(current.lease_expires_at.getTime()>=owned.lease_expires_at.getTime());assert.ok(current.lease_expires_at.getTime()<=Date.now()+901000);
    assert.deepEqual({...current,lease_expires_at:owned.lease_expires_at,updated_at:owned.updated_at},owned);
    assert.deepEqual(await parent(),ownedParent);assert.deepEqual(await blobs(),before.blobs);assert.equal(await head(),undefined);assert.deepEqual(await rows(),[]);await immutable();
  };
  const firstArgs={...args,cohortService:{async [method](value,options){
    try{
      calls++;firstClaim=options.captureJobClaim;assert.equal(firstClaim.attempts,5);owned=await job();ownedParent=await parent();
      await assert.rejects(service.progressCoveredOriginalFrozenCaptureJobSelectedSemanticReferencesV2(value,options),/invalid_receipt/);await unchanged();
      for(const [fault,reason] of [['semantic_cache',/original_mismatch/],
        ['semantic_orphan',e=>e.outcome_unknown===true&&e.code==='55000'&&e.message==='neighborhood_selected_semantic_v2_orphan_progress']]){
        const count=originalReads();setFault(fault);await assert.rejects(service[method](value,options),reason);assert.equal(readFault(),null);
        assert.equal(originalReads(),count+1);await unchanged();
      }
      setFault('semantic_ack');return await service[method](value,options);
    }catch(error){ownerError=error;throw error;}
  }}};
  const first=await pair(run,firstArgs,method);if(ownerError&&!ownerError.outcome_unknown)throw ownerError;
  assert.deepEqual(first.map(r=>r.status).sort(),['idle','outcome_unknown']);assert.equal(calls,1);assert.equal(readFault(),null);
  assert.equal((await head()).sequence,1);let receipt=await body((await head()).receipt_reference),nativeRows=await rows();
  assert.equal(receipt.format,'cohort_selected_semantic_receipt_v2');assert.equal(Object.keys(receipt).length,17);
  assert.equal(nativeRows.length,1);assert.equal(nativeRows[0].account_id,'CLOSURE-A');assert.equal(receipt.after.done,false);await immutable();
  const firstJob=await job(),firstParent=await parent(),firstBlobs=await blobs(),firstHead=await head();
  await assert.rejects(service[method](input,{captureJobClaim:firstClaim}),/claim_lost/);
  assert.deepEqual(await job(),firstJob);assert.deepEqual(await parent(),firstParent);assert.deepEqual(await blobs(),firstBlobs);assert.deepEqual(await head(),firstHead);assert.deepEqual(await rows(),nativeRows);
  let exact;
  for(const sequence of [2,3]){
    let count=0,result,nextError,nextClaim;
    const stepArgs={...args,cohortService:{async [method](value,options){
      try{count++;nextClaim=options.captureJobClaim;assert.equal(nextClaim.attempts,5);assert.notEqual(nextClaim.claim_token,firstClaim.claim_token);
        const reads=originalReads();result=await service[method](value,options);assert.equal(originalReads(),reads+1);return result;
      }catch(error){nextError=error;throw error;}
    }}};
    const steps=await pair(run,stepArgs,method);if(nextError)throw nextError;
    assert.deepEqual(steps.map(r=>r.status).sort(),['continuation_pending','idle']);assert.equal(count,1);firstClaim=nextClaim;
    assert.equal(result.catalog_receipt_format,'cohort_recorded_catalog_batch_receipt_v3');assert.equal(result.covered_neutral_originals,true);assert.equal(result.covered_CAD_originals,true);
    assert.equal(result.complete_original_reconciled_selected_union,sequence===3);assert.equal(result.read_only,false);
    assert.equal(result.context_complete,false);assert.equal(result.pin_transfer,false);assert.equal(result.report_update,'none');
    for(const key of ['calendar_quarters','economic_transactions','publication','source_acquisition','production_speed'])assert.equal(result[key],'not_established');
    if(sequence===3){assert.ok(result.exact_statistics);exact=result.exact_statistics;}else assert.equal(result.exact_statistics,null);
    assert.ok(Buffer.byteLength(JSON.stringify(result))<=16000);assert.equal((await head()).sequence,sequence);
    receipt=await body((await head()).receipt_reference);assert.equal(receipt.after.done,sequence===3);assert.equal(receipt.after.selected_ordinal,2);
    nativeRows=await rows();assert.deepEqual(nativeRows.map(r=>r.ordinal),[1,2]);
    for(let i=0;i<2;i++){
      const member=before.parents.selected_numeric_v2_rows.find(r=>r.ordinal===i+1);
      assert.equal(nativeRows[i].account_id,member.account_id);assert.deepEqual(nativeRows[i].entry_reference,member.entry_reference);
      assert.deepEqual(nativeRows[i].metric_row_reference,member.metric_row_reference);assert.deepEqual(nativeRows[i].contribution_row_reference,member.contribution_row_reference);
    }
    if(sequence===3){assert.equal(receipt.selected_entry,null);assert.equal(receipt.contribution_row_reference,null);
      const summary=await body(receipt.after_summary_reference);assert.deepEqual(summary.counts,contributionReceipt.after_counts);
    }
    assert.equal((await job()).attempts,5);assert.equal((await job()).last_error_code,'access_revoked');assert.equal((await job()).checkpoint.evidence_refs.length,16);await immutable();
  }
  // Independent exact arithmetic over this disposable two-account expected
  // DATA, AFTER every actual semantic owner replayed its complete originals.
  const scaled=text=>{const [whole,fraction='']=String(text).split('.');return BigInt(whole+fraction.padEnd(14,'0'));},
    finite=n=>{const s=n.toString().padStart(15,'0'),fraction=s.slice(-14).replace(/0+$/,'');return s.slice(0,-14)+(fraction?'.'+fraction:'');},
    ratio=(n,d)=>{let a=n,b=d;while(b){const r=a%b;a=b;b=r;}return {numerator:(n/a).toString(),denominator:(d/a).toString()};};
  for(const key of ['reported_year_built','reported_residential_area','reported_site_area']){
    const values=index.map(r=>r[key]).filter(v=>v!==null).map(scaled).sort((a,b)=>a<b?-1:a>b?1:0),n=values.length,actual=exact[key];
    assert.equal(n,key==='reported_site_area'?2:1);assert.equal(actual.selected_count,2);assert.equal(actual.observed_count,n);
    const median=n===1?values[0]:(values[0]+values[1])/2n;
    assert.equal(actual.median,finite(median));assert.equal(actual.q1,finite(n===1?values[0]:(3n*values[0]+values[1])/4n));
    assert.equal(actual.q3,finite(n===1?values[0]:(values[0]+3n*values[1])/4n));
    assert.deepEqual(actual.mean,ratio(values.reduce((s,v)=>s+v,0n),BigInt(n)*10n**14n));
    assert.deepEqual(actual.cod_percent,median===0n?null:ratio(100n*values.reduce((s,v)=>s+(v>median?v-median:median-v),0n),BigInt(n)*median));
    assert.equal(actual.cod_reason,median===0n?'zero_median':null);
  }
  assert.equal(exact.reported_year_built.median,'1960');assert.equal(exact.reported_residential_area.median,'1000.01');
  assert.equal(exact.reported_site_area.median,'4000');assert.deepEqual(exact.reported_site_area.cod_percent,{numerator:'100',denominator:'1'});
  const terminal={job:await job(),parent:await parent(),blobs:await blobs(),head:await head(),rows:await rows()};
  for(const worker of [run,numeric])assert.deepEqual(await worker(args),{status:'idle'});
  const rollback=Error('rollback expired cancelled transaction-owner token');
  await assert.rejects(tx(pool,async client=>{
    const [next]=await continuations(client).claimDue({limit:1,leaseSeconds:900});assert.equal(next.claim.operation_id,operation);
    await client.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);
    await jobs(client).cancel(scope,operation);const saved=(await client.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows;
    assert.deepEqual(await claims(client).claimDue({leaseSeconds:900}),[]);
    assert.deepEqual((await client.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows,saved);throw rollback;
  }),e=>e===rollback);
  assert.deepEqual(await job(),terminal.job);assert.deepEqual(await parent(),terminal.parent);assert.deepEqual(await blobs(),terminal.blobs);assert.deepEqual(await head(),terminal.head);assert.deepEqual(await rows(),terminal.rows);await immutable();
  if(batchSelectedTransactionIndexFixture){
    await runNeighborhoodBatchSelectedTransactionIndexV3DatabaseChecks({pool,input,scope,actor,service,job,parent,blobs,
      catalogHead,groups,assertParents,setFault,readFault,originalReads,command});return;
  }
  console.info('[native-batch-selected-semantic-v3]',{independent_actual_V3_numeric_worker_fresh_EMPTY:true,
    every_selected_complete_original_ENTIRE_cache_metric_contribution_index_and_numeric_member_reconciled_again:true,
    cache_refusal_real_orphan_COMMIT_rollback_lost_first_ACK_concurrent_A_B_fresh_EMPTY_native_claims5:true,
    positive_exact_golden_quartiles_medians_means_and_CODs_after_complete_original_pass:true,
    all_reported_state_part_reason_eligible_counts_reconcile_to_original_contributions:true,
    DONE_all_claim_recovery_expiry_cancelled_next_owner_excluded_native_parents_history_pins_preserved:true,
    ordinary_worker_recovery_below5:'not_exercised_requires_new_reserved_failure_graph',
    new_stage_all_ending_authority_faults:'not_separately_injected_prior_independent_stages_cover_shared_fences',
    economic_equivalence:false,calendar_quarters:false,publication:false,
    production_activation:false,licensed_large_area:false,production_speed:false,pin_transfer:false});
}
