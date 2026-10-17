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
    signatures:(await pool.query('SELECT to_jsonb(r) AS body FROM app.custom_appraisal_signed_snapshots r WHERE assignment_file_id=$1',[scope.assignment_file_id])).rows,
    manual:(await pool.query('SELECT to_jsonb(r) AS body FROM app.custom_appraisal_sections r WHERE assignment_file_id=$1 ORDER BY section_key',[scope.assignment_file_id])).rows,
    workspace:(await pool.query('SELECT to_jsonb(r) AS body FROM app.custom_appraisal_workfile_sections r WHERE assignment_file_id=$1 ORDER BY section_key',[scope.assignment_file_id])).rows,
    blobs:(await pool.query('SELECT to_jsonb(r) AS body FROM app.neighborhood_cohort_evidence_blobs r WHERE organization_id=$1 ORDER BY content_sha256',[scope.organization_id])).rows
  });
  const before=await snapshot();
  const materialInsert=`INSERT INTO app.custom_appraisal_sections(assignment_file_id,section_key,section_value)
    VALUES($1,'report.land_details','{}') RETURNING assignment_file_id`;
  // Disposable schema-valid INSERT only, using actual workfile/user parents and
  // server-generated event identity. It is always refused or rolled back; no
  // appraiser signing choice, accepted report or signature is established.
  const signatureInsert=`INSERT INTO app.custom_appraisal_signed_snapshots
    (assignment_file_id,canonical_file_name,schema_version,snapshot,checksum_sha256,signed_by,organization_id,signed_by_user_id)
    SELECT w.assignment_file_id,w.canonical_file_name,w.schema_version,to_jsonb(w),
      encode(digest(convert_to(to_jsonb(w)::text,'UTF8'),'sha256'),'hex'),u.display_name,a.organization_id,u.id
    FROM app.custom_appraisal_workfiles w JOIN app.assignment_files a ON a.id=w.assignment_file_id
    JOIN app_auth.users u ON u.id=$2::uuid WHERE w.assignment_file_id=$1 RETURNING id`;
  assert.equal((await pool.query('SELECT app.custom_cohort_subject_shared_fences_v1_ready() AS ready')).rows[0].ready,true);
  let enter,release,held=false,heldMode=null,subjectAssignmentMode=null,subjectWorkfileMode=null;
  const entered=new Promise(resolve=>{enter=resolve;}),released=new Promise(resolve=>{release=resolve;});
  const holdingPool={async connect(){
    const raw=await pool.connect();
    return {release:raw.release.bind(raw),async query(config){
      const text=typeof config==='string'?config:config.text,result=await raw.query(config);
      if(text.includes('custom-cohort-capture:assignment */')&&/FOR (?:SHARE|UPDATE) NOWAIT/.test(text))heldMode=/FOR SHARE NOWAIT/.test(text)?'SHARE':'UPDATE';
      if(text.includes('custom-cohort-subject:assignment */'))subjectAssignmentMode=/FOR SHARE NOWAIT/.test(text)?'SHARE':'UPDATE';
      if(text.includes('custom-cohort-subject:workfile */'))subjectWorkfileMode=/FOR SHARE NOWAIT/.test(text)?'SHARE':'UPDATE';
      if(!held&&text.includes('custom-cohort-subject:sections */')){
        held=true;enter();await released;
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
    assert.equal(subjectAssignmentMode,'SHARE');assert.equal(subjectWorkfileMode,'SHARE');
    // Each full service read runs while the first reader's actual native SHARE
    // lock is still held, including its current and ending source/subject fences.
    assert.deepEqual(await reader.viewport(request,viewport),expectedViewport);
    assert.deepEqual(await reader.catalog(catalogRequest),expectedCatalog);
    const members=await reader.inspect(request,{population:{group:'all',kind:'stock'},
      page:{limit:50,after_member_id:null}});
    assert.equal(members.status,'members');
    assert.equal(members.page.total_count,expectedCatalog.catalog.coverage.stock_member_count);
    const writer=await pool.connect();
    try{
      await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='100ms'");
      await assert.rejects(writer.query('UPDATE app.assignment_files SET assigned_appraiser_user_id=NULL WHERE id=$1',
        [scope.assignment_file_id]),error=>error.code==='55P03');
    }finally{await writer.query('ROLLBACK');writer.release();}
    // A SHARE parent alone would allow an FK-backed insert. The native write
    // trigger must actually refuse this previously absent material row.
    const absent=await pool.query("SELECT 1 FROM app.custom_appraisal_sections WHERE assignment_file_id=$1 AND section_key='report.land_details'",[scope.assignment_file_id]);
    assert.equal(absent.rowCount,0);
    for(const [sql,params]of [[materialInsert,[scope.assignment_file_id]],
      [signatureInsert,[scope.assignment_file_id,request.auth.userId]]]){
      const inserter=await pool.connect();
      try{await inserter.query('BEGIN');await assert.rejects(inserter.query(sql,params),error=>error.code==='55P03');}
      finally{await inserter.query('ROLLBACK');inserter.release();}
    }
  }finally{clearTimeout(timer);release();await first;}
  const firstOutcome=await first;if(firstOutcome.error)throw firstOutcome.error;
  assert.deepEqual(firstOutcome.value,expectedViewport);
  // The identical INSERTs must really be admissible after the reader releases.
  // Roll back both complete rows rather than creating or deleting a signature.
  const control=await pool.connect();
  try{
    await control.query('BEGIN');
    assert.equal((await control.query(materialInsert,[scope.assignment_file_id])).rowCount,1);
    assert.equal((await control.query(signatureInsert,[scope.assignment_file_id,request.auth.userId])).rowCount,1);
  }finally{await control.query('ROLLBACK');control.release();}
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
    actual_absent_material_INSERT_refused_by_native_parent_write_guard:true,
    actual_signature_INSERT_refused_and_both_schema_valid_INSERT_controls_rolled_back_after_release:true,
    actual_writer_FOR_UPDATE_refuses_viewport_NOWAIT_delivery_then_rollback_allows_reopen:true,
    assignment_report_subject_private_workfile_manual_workspace_and_every_blob_unchanged:true,
    source_subject_policy_rechecks_and_runtime_limits_unchanged:true,
    production_speed:false,licensed_capacity:false,publication:false,apply:false});
  return 'native overlapping viewport/catalog/member SHARE fences retain exact reads and exclude assignment writers in both orders';
}
