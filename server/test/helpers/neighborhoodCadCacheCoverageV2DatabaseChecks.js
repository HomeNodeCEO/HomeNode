import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createCustomCohortContextCapture } from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { createCustomCohortCaptureJobRepository as jobs } from '../../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { createNeighborhoodCohortBlobRepository } from '../../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';
import { withCustomCohortJobTransaction as tx } from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';
import { NEIGHBORHOOD_SCOPED_CAD_ORIGINAL_ACCOUNT_V2_SQL as PAGE } from '../../src/services/neighborhoodAssessment/neighborhoodScopedCadOriginalAccountV2.js';
import { NEIGHBORHOOD_SHARED_TYPED_CAD_SQL as CAD } from '../../src/services/neighborhoodAssessment/neighborhoodSharedTypedGeneration.js';
import { CUSTOM_NEIGHBORHOOD_CAD_IMPROVEMENT_SOURCE_RIGHTS_KEY as RIGHTS } from '../../src/security/customNeighborhoodCadImprovementSourcePolicy.js';

/** Independent disposable manual job. Every original, source policy, actor,
 * native parent/head and COMMIT is real; no callback supplies source results. */
export async function runNeighborhoodCadCacheCoverageV2DatabaseChecks({pool,input:sourceInput,scope,actor,
  authorizeMarketData,authorizeCadImprovementData}){
  await tx(pool,client=>client.query(readFileSync(new URL('../../migrations/20261217_custom_cohort_cad_cache_v2_heads.sql',import.meta.url),'utf8')));
  const input={...sourceInput,operationId:randomUUID()},operation=input.operationId,calls=[];let fault=null,controller=null;
  const observed={async connect(){const raw=await pool.connect();return {release:raw.release.bind(raw),async query(config,values){
    const text=typeof config==='string'?config:config.text;calls.push(text);
    if(text==='COMMIT'&&fault==='expire_commit'){fault=null;await raw.query(
      "UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);}
    const result=await raw.query(config,values);
    if(text===PAGE&&fault==='text'){fault=null;const row=structuredClone(result.rows[0]),packet=JSON.parse(row.packet_json);
      packet[0].payload_text+=' ';row.packet_json=JSON.stringify(packet);return {...result,rows:[row]};}
    if(text===PAGE&&['cad_deny','cad_revision','role','assignment','draft','subject','cancel'].includes(fault)){
      const mode=fault;fault=null;
      if(mode==='cad_deny')await raw.query(`UPDATE app_auth.organizations SET metadata=jsonb_set(metadata,ARRAY[$2::text,'revoked_at'],
        to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))) WHERE id=$1`,[scope.organization_id,RIGHTS]);
      if(mode==='cad_revision')await raw.query(`UPDATE app_auth.organizations SET metadata=jsonb_set(metadata,
        ARRAY[$2::text,'rights_basis','basis_reference'],'"changed native CAD coverage probe"'::jsonb) WHERE id=$1`,[scope.organization_id,RIGHTS]);
      if(mode==='role')await raw.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[scope.organization_id,actor]);
      if(mode==='assignment')await raw.query('UPDATE app.assignment_files SET assigned_appraiser_user_id=NULL WHERE id=$1',[scope.assignment_file_id]);
      if(mode==='draft')await raw.query("UPDATE app.custom_appraisal_workfiles SET status='archived' WHERE assignment_file_id=$1",[scope.assignment_file_id]);
      if(mode==='subject')await raw.query(`UPDATE app.appraisal_subject_snapshots SET subject_data=jsonb_set(subject_data,
        '{custom_property_snapshot,improvement,living_area_sqft}','2000')
        WHERE id=(SELECT subject_snapshot_id FROM app.report_files WHERE id=$1)`,[scope.report_file_id]);
      if(mode==='cancel')controller.abort();
    }
    if(text===CAD.insert&&fault==='bytes'){fault=null;return {...result,rows:result.rows.map(r=>({...r,padding:'x'.repeat(32000001)}))};}
    if(text==='COMMIT'&&fault==='ack'){fault=null;throw Error('lost real CAD coverage COMMIT acknowledgement');}
    return result;
  }};}},service=createCustomCohortContextCapture({pool:observed,sourceMode:'combined-witness2-v1',authorizeMarketData,authorizeCadImprovementData});
  await tx(pool,client=>jobs(client).enqueue({scope,actorUserId:actor,request:{operation_id:operation,
    observation_period:input.observationPeriod,discovery:input.discovery}}));
  const claim=await tx(pool,async client=>{const [row]=await jobs(client).claimDue({leaseSeconds:900});assert.equal(row.operation_id,operation);
    return {operation_id:operation,claim_token:row.claim_token,attempts:row.attempts};});
  const options={captureJobClaim:claim},step=()=>service.continueOriginalFrozenCaptureJobCadCacheCoverageReferencesV2(input,
    {...options,...(controller?{signal:controller.signal}:{})});
  const drive=async(method,key)=>{let result;for(let i=0;i<30;i++){result=await service[method](input,options);if(result[key]===true)return result;}
    assert.fail(`${method} did not complete its small actual original fixture`);};
  await service.prepareFrozenCaptureJobStock(input,options);
  await drive('prepareFrozenCaptureJobSourceReferencesV2Page','all_layers_ended');
  await drive('verifyFrozenCaptureJobSourceReferencesV2Page','all_layers_verified');
  await drive('verifyFrozenCaptureJobStockOriginalReferencesV2','all_parcels_verified');
  await drive('verifyFrozenCaptureJobSourceIdentityReferencesV2','all_layers_verified');
  let from=calls.length;await assert.rejects(step(),/CAD_neutral_coverage_unavailable/);
  assert.ok(!calls.slice(from).includes(PAGE));
  await service.reconcileFrozenCaptureJobNeutralOriginalsReferencesV2(input,options);
  from=calls.length;await assert.rejects(step(),/CAD_neutral_coverage_unavailable/);assert.ok(!calls.slice(from).includes(PAGE));
  await drive('reconcileFrozenCaptureJobNeutralOriginalsReferencesV2','all_issued_source_pages_reconciled');
  const head=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_cad_cache_v2_heads WHERE operation_id=$1',[operation])).rows[0]??null,
    job=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows[0],
    blobCount=async()=>(await pool.query('SELECT count(*)::integer AS n FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1',[scope.organization_id])).rows[0].n,
    parents=async()=>({job:await job(),neutral:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_neutral_cache_v2_heads WHERE operation_id=$1',[operation])).rows,
      graph:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_graph_v2_anchors WHERE operation_id=$1',[operation])).rows,
      geography:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_geo_v2_anchors WHERE operation_id=$1',[operation])).rows,
      identity:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_identity_v2_anchors WHERE operation_id=$1',[operation])).rows,
      pins:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_prepared_generation_pins WHERE operation_id=$1',[operation])).rows});
  const before=await parents(),blobs=await blobCount();assert.equal(await head(),null);
  for(const [mode,reason] of [['cad_deny',/market_data_access_denied/],['cad_revision',/CAD_source_policy_changed/],
    ['role',/job_actor_access_revoked/],['assignment',/assignment_access_denied/],['draft',/private_source_read_only/],
    ['subject',/subject_changed/],['cancel',/cancelled/],['text',/original_mismatch/],['bytes',/owner_byte_limit/]]){
    fault=mode;controller=new AbortController();await assert.rejects(step(),reason);assert.equal(fault,null);controller=null;
    assert.equal(await head(),null);assert.equal(await blobCount(),blobs);assert.deepEqual(await parents(),before);
  }
  fault='expire_commit';await assert.rejects(step(),e=>e.code==='55000'&&/neighborhood_cad_cache_v2_binding_conflict/.test(e.message));
  assert.equal(fault,null);assert.equal(await head(),null);assert.equal(await blobCount(),blobs);assert.deepEqual(await parents(),before);
  fault='ack';await assert.rejects(step(),e=>e.outcome_unknown===true);assert.equal(fault,null);
  const first=await head();assert.equal(first.sequence,1);assert.deepEqual(await parents(),before);
  const body=JSON.parse((await pool.query('SELECT canonical_utf8 FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1 AND content_sha256=$2',
    [scope.organization_id,first.receipt_reference.content_sha256])).rows[0].canonical_utf8);
  assert.equal(body.after.after_account,'CLOSURE-A');assert.equal(body.after.original_count,3);assert.equal(body.after.done,false);
  await assert.rejects(tx(pool,async client=>{
    const forged={...body,sequence:2,previous:first.receipt_reference,before:body.after,entry:null,after:{...body.after,done:true}};
    const ref=await createNeighborhoodCohortBlobRepository(client,scope.organization_id).put(json(forged));
    await client.query('UPDATE app.neighborhood_custom_cohort_cad_cache_v2_heads SET receipt_reference=$2,sequence=2 WHERE operation_id=$1',[operation,ref]);
  }),e=>e.code==='55000');assert.deepEqual(await head(),first);
  const secondParcels=(await pool.query(`SELECT parcel_count::text AS n FROM app.neighborhood_custom_cohort_stock_accounts
    WHERE operation_id=$1 AND account_id='CLOSURE-B'`,[operation])).rows[0].n;
  await assert.rejects(tx(pool,async client=>{
    const forged={...body,sequence:2,previous:first.receipt_reference,before:body.after,
      entry:{account_id:'CLOSURE-B',geographic_parcel_count:secondParcels,primary_count:1,secondary_count:1},
      after:{after_account:'CLOSURE-B',account_count:2,original_count:5,typed_utf8_bytes:null,done:false}};
    const ref=await createNeighborhoodCohortBlobRepository(client,scope.organization_id).put(json(forged));
    await client.query('UPDATE app.neighborhood_custom_cohort_cad_cache_v2_heads SET receipt_reference=$2,sequence=2 WHERE operation_id=$1',[operation,ref]);
  }),e=>e.code==='55000'&&/neighborhood_cad_cache_v2_transition_conflict/.test(e.message));assert.deepEqual(await head(),first);
  await assert.rejects(tx(pool,client=>client.query('DELETE FROM app.neighborhood_custom_cohort_cad_cache_v2_heads WHERE operation_id=$1',[operation])),e=>e.code==='55000');
  await tx(pool,client=>jobs(client).failClaim(claim,'synthetic_CAD_retry',{retrySeconds:1}));
  await pool.query('UPDATE app.neighborhood_custom_cohort_capture_jobs SET run_after=clock_timestamp() WHERE operation_id=$1',[operation]);
  const next=await tx(pool,async client=>{const [r]=await jobs(client).claimDue({leaseSeconds:900});assert.equal(r.operation_id,operation);return r;});
  assert.equal(next.attempts,2);assert.notEqual(next.claim_token,claim.claim_token);
  await assert.rejects(step(),/claim_lost/);Object.assign(claim,{claim_token:next.claim_token,attempts:next.attempts});
  const second=await step();assert.equal(second.progress.after_account,'CLOSURE-B');assert.equal(second.progress.account_count,2);
  assert.equal(second.progress.original_count,5);assert.equal(second.progress.done,false);assert.equal((await head()).sequence,2);
  const terminal=await step();assert.equal(terminal.progress.done,true);assert.equal(terminal.progress.original_count,5);assert.equal((await head()).sequence,3);
  const complete=await head(),finalBlobs=await blobCount(),reopened=await step();assert.equal(reopened.advanced,false);
  assert.equal(reopened.progress.done,true);assert.deepEqual(await head(),complete);assert.equal(await blobCount(),finalBlobs);
  const after=await parents();assert.deepEqual(after.neutral,before.neutral);assert.deepEqual(after.graph,before.graph);
  assert.deepEqual(after.geography,before.geography);assert.deepEqual(after.identity,before.identity);assert.deepEqual(after.pins,before.pins);
  assert.deepEqual(after.job.checkpoint,before.job.checkpoint);assert.equal(after.job.attempts,2);assert.equal(after.job.last_error_code,'synthetic_CAD_retry');
  for(const r of [second,terminal,reopened]){assert.equal(r.automatic_handoff,false);assert.equal(r.context_complete,false);assert.equal(r.pin_transfer,false);}
  console.info('[native-issued-current-authorized-CAD-cache-coverage-v2]',{actual_accounts:2,actual_complete_originals:5,
    missing_and_partial_E_refused_before_originals:true,independent_native_parents_and_same_snapshot_CAD:true,
    every_original_and_ENTIRE_cache_reconciled_under_one_budget:true,all_ending_authority_refusals_atomic:true,
    actual_deferred_COMMIT_expiry_refused:true,free_DONE_NULL_bytes_and_delete_refused:true,real_lost_ACK_resumes_B_not_A:true,
    genuine_failure_fresh_claim_preserves_history:true,separate_terminal_EMPTY_and_unchanged_reopen:true,
    original_parent_checkpoint_and_pins_unchanged:true,automatic_success_handoff:false,consumer_activation:false,
    licensed_large_area:false,production_speed:false,publication:false,pin_transfer:false});
}
