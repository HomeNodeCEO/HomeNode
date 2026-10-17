import assert from 'node:assert/strict';
import { createCustomCohortContextCapture } from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';

// Disposable migrated native database only. Hold an actual completed assignment
// fence open; no callback replaces SQL, source observations or authorization.
export async function runCustomCohortReadFenceConcurrencyDatabaseChecks({pool,authorizeMarketData,
  request,catalogRequest,scope,expectedViewport,expectedCatalog}){
  const viewport={west:-96.701,south:32.799,east:-96.698,north:32.802};
  const snapshot=async()=>({
    assignment:(await pool.query('SELECT to_jsonb(r) AS body FROM app.assignment_files r WHERE id=$1',[scope.assignment_file_id])).rows,
    report:(await pool.query('SELECT to_jsonb(r) AS body FROM app.report_files r WHERE id=$1',[scope.report_file_id])).rows,
    subject:(await pool.query(`SELECT to_jsonb(s) AS body FROM app.appraisal_subject_snapshots s
      JOIN app.report_files r ON r.subject_snapshot_id=s.id WHERE r.id=$1`,[scope.report_file_id])).rows,
    workfile:(await pool.query('SELECT to_jsonb(r) AS body FROM app.custom_appraisal_workfiles r WHERE assignment_file_id=$1',[scope.assignment_file_id])).rows,
    manual:(await pool.query('SELECT to_jsonb(r) AS body FROM app.custom_appraisal_sections r WHERE assignment_file_id=$1 ORDER BY section_key',[scope.assignment_file_id])).rows,
    workspace:(await pool.query('SELECT to_jsonb(r) AS body FROM app.custom_appraisal_workfile_sections r WHERE assignment_file_id=$1 ORDER BY section_key',[scope.assignment_file_id])).rows,
    blobs:(await pool.query('SELECT to_jsonb(r) AS body FROM app.neighborhood_cohort_evidence_blobs r WHERE organization_id=$1 ORDER BY content_sha256',[scope.organization_id])).rows
  });
  const before=await snapshot();
  let enter,release,held=false,heldMode=null;
  const entered=new Promise(resolve=>{enter=resolve;}),released=new Promise(resolve=>{release=resolve;});
  const holdingPool={async connect(){
    const raw=await pool.connect();
    return {release:raw.release.bind(raw),async query(config){
      const text=typeof config==='string'?config:config.text,result=await raw.query(config);
      if(!held&&text.includes('custom-cohort-capture:assignment */')&&/FOR (?:SHARE|UPDATE) NOWAIT/.test(text)){
        held=true;heldMode=/FOR SHARE NOWAIT/.test(text)?'SHARE':'UPDATE';enter();await released;
      }
      return result;
    }};
  }};
  const owner=createCustomCohortContextCapture({pool:holdingPool,authorizeMarketData}),
    reader=createCustomCohortContextCapture({pool,authorizeMarketData});
  const first=owner.viewport(request,viewport).then(value=>({value}),error=>({error}));
  let timer;
  try{
    await Promise.race([entered,first.then(outcome=>{throw outcome.error??Error('reader settled before its actual fence');}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('native read fence did not arrive within 5 seconds')),5000);})]);
    clearTimeout(timer);
    assert.equal(heldMode,'SHARE');
    // Each full service read runs while the first reader's actual native SHARE
    // lock is still held, including its current and ending source/subject fences.
    assert.deepEqual(await reader.viewport(request,viewport),expectedViewport);
    assert.deepEqual(await reader.catalog(catalogRequest),expectedCatalog);
    const members=await reader.inspect(request,{population:{group:'all',kind:'stock'},
      page:{limit:100,after_member_id:null}});
    assert.equal(members.status,'members');
    assert.equal(members.page.total_count,expectedCatalog.catalog.coverage.stock_member_count);
    const writer=await pool.connect();
    try{
      await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='100ms'");
      await assert.rejects(writer.query('UPDATE app.assignment_files SET assigned_appraiser_user_id=NULL WHERE id=$1',
        [scope.assignment_file_id]),error=>error.code==='55P03');
    }finally{await writer.query('ROLLBACK');writer.release();}
  }finally{clearTimeout(timer);release();await first;}
  const firstOutcome=await first;if(firstOutcome.error)throw firstOutcome.error;
  assert.deepEqual(firstOutcome.value,expectedViewport);
  // The reverse order must still refuse a read at its NOWAIT delivery fence
  // when a genuine assignment writer owns the row. No waiting or retry is added.
  const writer=await pool.connect();
  try{
    await writer.query('BEGIN');
    const locked=await writer.query('SELECT id FROM app.assignment_files WHERE id=$1 FOR UPDATE NOWAIT',[scope.assignment_file_id]);
    assert.equal(locked.rowCount,1);
    await assert.rejects(reader.viewport(request,viewport),error=>error.code==='55P03');
  }finally{await writer.query('ROLLBACK');writer.release();}
  assert.deepEqual(await reader.viewport(request,viewport),expectedViewport);
  assert.deepEqual(await snapshot(),before);
  console.info('[native-custom-read-share-fence-concurrency]',{
    actual_first_viewport_SHARE_fence_held_until_explicit_release:true,
    overlapping_complete_viewport_prepared_catalog_and_member_reads_preserve_exact_results:true,
    actual_assignment_UPDATE_refused_while_reader_holds_SHARE:true,
    actual_writer_FOR_UPDATE_refuses_viewport_NOWAIT_delivery_then_rollback_allows_reopen:true,
    assignment_report_subject_private_workfile_manual_workspace_and_every_blob_unchanged:true,
    source_subject_policy_rechecks_and_runtime_limits_unchanged:true,
    production_speed:false,licensed_capacity:false,publication:false,apply:false});
  return 'native overlapping viewport/catalog/member SHARE fences retain exact reads and exclude assignment writers in both orders';
}
