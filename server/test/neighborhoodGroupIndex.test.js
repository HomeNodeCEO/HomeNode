import assert from 'node:assert/strict';
import test from 'node:test';
import { getPreparedNeighborhoodGroupSummary,runNeighborhoodGroupIndex,runNeighborhoodGroupIndexRetirement,
  NEIGHBORHOOD_GROUP_INDEX_SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodGroupIndex.js';

function fixture({locked=true,fail=false,failSummary=false,failSalesSummary=false,
  lockError=false,unlockOutcome='succeeded',retirementCandidates=[],freshCandidates=[]}={}) {
  const calls=[];let released=false,releaseError;
  const client={
    async query(input,values) {
      const sql=typeof input==='string'?input:input.text;
      calls.push({sql,values:values??input.values,queryTimeout:typeof input==='object'?input.query_timeout:undefined});
      if (sql.includes('pg_try_advisory_lock')) {
        if (lockError) throw new Error('synthetic_lock_failure');
        return locked==='missing' ? {rows:[]} : {rows:[{locked}]};
      }
      if (sql.includes('pg_advisory_unlock')) {
        if (unlockOutcome==='rejected') throw new Error('synthetic_unlock_failure');
        return unlockOutcome==='missing' ? {rows:[]} : {rows:[{pg_advisory_unlock:unlockOutcome==='succeeded'}]};
      }
      if (sql.startsWith('SELECT generation.generation_id') && sql.includes('retirement_started_at IS NOT NULL'))
        return {rows:retirementCandidates.length?[{generation_id:retirementCandidates.shift()}]:[]};
      if (sql.startsWith('SELECT generation.generation_id') && sql.includes('retirement_started_at IS NULL'))
        return {rows:freshCandidates.length?[{generation_id:freshCandidates.shift()}]:[]};
      if (sql.startsWith('WITH old AS')) return {rows:[{removed:0}]};
      if (sql===NEIGHBORHOOD_GROUP_INDEX_SQL.parcelBatch || sql===NEIGHBORHOOD_GROUP_INDEX_SQL.saleBatch) {
        if (fail) throw new Error('synthetic_batch_error');
        return {rows:[{cursor:'-9223372036854775808',scanned:0,copied:0}]};
      }
      if (failSummary && sql===NEIGHBORHOOD_GROUP_INDEX_SQL.buildSummary) throw new Error('synthetic_summary_timeout');
      if (failSalesSummary && sql===NEIGHBORHOOD_GROUP_INDEX_SQL.buildSales)
        throw new Error('synthetic_sales_summary_timeout');
      if (sql.startsWith('UPDATE app.neighborhood_group_generations')) return {rowCount:1,rows:[]};
      return {rows:[]};
    },
    release(error){released=true;releaseError=error;},
  };
  return {pool:{async connect(){return client;}},calls,get released(){return released;},
    get releaseError(){return releaseError;}};
}

test('publishes only after parcel, sale and summary preparation in one snapshot',async()=>{
  const f=fixture();
  const result=await runNeighborhoodGroupIndex(f.pool,{logger:{info(){}}});
  assert.equal(result.status,'complete');
  const sql=f.calls.map(call=>call.sql);
  assert.ok(sql.indexOf('BEGIN ISOLATION LEVEL REPEATABLE READ')<sql.indexOf(NEIGHBORHOOD_GROUP_INDEX_SQL.parcelBatch));
  assert.ok(sql.indexOf(NEIGHBORHOOD_GROUP_INDEX_SQL.parcelBatch)<sql.indexOf(NEIGHBORHOOD_GROUP_INDEX_SQL.buildSaleAccountKeys));
  assert.ok(sql.indexOf(NEIGHBORHOOD_GROUP_INDEX_SQL.buildSaleAccountKeys)<sql.indexOf(NEIGHBORHOOD_GROUP_INDEX_SQL.saleBatch));
  assert.ok(sql.indexOf('SET LOCAL enable_nestloop=off')<sql.indexOf(NEIGHBORHOOD_GROUP_INDEX_SQL.buildSaleAccountKeys));
  assert.ok(sql.indexOf(NEIGHBORHOOD_GROUP_INDEX_SQL.buildSaleAccountKeys)<sql.indexOf('SET LOCAL enable_nestloop=on'));
  assert.ok(sql.indexOf(NEIGHBORHOOD_GROUP_INDEX_SQL.saleBatch)<sql.indexOf(NEIGHBORHOOD_GROUP_INDEX_SQL.buildSummary));
  assert.ok(sql.indexOf(NEIGHBORHOOD_GROUP_INDEX_SQL.buildSales)<sql.findIndex(value=>value.includes('INSERT INTO app.neighborhood_group_active')));
  assert.match(sql.find(value=>value.startsWith('UPDATE app.neighborhood_group_generations')),/completed_at=clock_timestamp\(\)/);
  assert.match(sql.find(value=>value.includes('INSERT INTO app.neighborhood_group_active')),/clock_timestamp\(\)/);
  const salesSummary=sql.indexOf(NEIGHBORHOOD_GROUP_INDEX_SQL.buildSales);
  assert.equal(sql[salesSummary-1],'SET LOCAL enable_nestloop=off');
  assert.equal(sql[salesSummary+1],'SET LOCAL enable_nestloop=on');
  assert.match(NEIGHBORHOOD_GROUP_INDEX_SQL.buildSales,/WITH grouped AS MATERIALIZED/);
  assert.ok(sql.findIndex(value=>value.includes('INSERT INTO app.neighborhood_group_active'))<sql.indexOf('COMMIT'));
  assert.equal(sql.includes('ROLLBACK'),false);
  assert.equal(f.released,true);
  assert.equal(f.releaseError,undefined);
  assert.equal(sql.some(value=>value.includes('neighborhood-frozen-source:')),false,
    'installed nightly CLI keeps the full original sweep disabled');
});

test('invalid frozen-source opt-in is rejected before connecting a worker',async()=>{
  for(const retainOriginalSources of ['true',1,null,{}]) {
    const f=fixture();await assert.rejects(runNeighborhoodGroupIndex(f.pool,{retainOriginalSources}),/retain_original_sources/);
    assert.deepEqual(f.calls,[]);
  }
});

test('CAD original companion requires explicit boolean opt-in and the original sweep before connection',async()=>{
  for(const options of [{retainCadImprovementOriginals:true},...['true',1,null,{}].map(value=>
    ({retainOriginalSources:true,retainCadImprovementOriginals:value}))]){
    const f=fixture();await assert.rejects(runNeighborhoodGroupIndex(f.pool,options),/retain_CAD_improvement_originals/);
    assert.deepEqual(f.calls,[]);
  }
});

test('failed generation rolls back and never replaces the active pointer',async()=>{
  const f=fixture({fail:true});
  await assert.rejects(runNeighborhoodGroupIndex(f.pool),/synthetic_batch_error/);
  const sql=f.calls.map(call=>call.sql);
  assert.ok(sql.includes('ROLLBACK'));
  assert.equal(sql.some(value=>value.includes('INSERT INTO app.neighborhood_group_active')),false);
  assert.ok(sql.some(value=>value.includes('pg_advisory_unlock')));
  assert.equal(f.released,true);
});

test('large summary has a bounded longer deadline and logs a static failure phase',async()=>{
  const f=fixture({failSummary:true}),logs=[];
  await assert.rejects(runNeighborhoodGroupIndex(f.pool,{logger:{info(){},warn:line=>logs.push(line)}}),
    /synthetic_summary_timeout/);
  const summary=f.calls.find(call=>call.sql===NEIGHBORHOOD_GROUP_INDEX_SQL.buildSummary);
  assert.equal(summary.queryTimeout,600_000);
  assert.deepEqual(logs,['[neighborhood-group-index] failed_phase=group_summary']);
  assert.ok(f.calls.some(call=>call.sql==='ROLLBACK'));
  assert.equal(f.calls.some(call=>call.sql.includes('INSERT INTO app.neighborhood_group_active')),false);
});

test('timed-out sales summary rolls back the candidate instead of publishing it',async()=>{
  const f=fixture({failSalesSummary:true}),logs=[];
  await assert.rejects(runNeighborhoodGroupIndex(f.pool,{logger:{info(){},warn:line=>logs.push(line)}}),
    /synthetic_sales_summary_timeout/);
  const summary=f.calls.find(call=>call.sql===NEIGHBORHOOD_GROUP_INDEX_SQL.buildSales);
  assert.equal(summary.queryTimeout,600_000);
  assert.deepEqual(logs,['[neighborhood-group-index] failed_phase=sales_summary']);
  assert.ok(f.calls.some(call=>call.sql==='ROLLBACK'));
  assert.equal(f.calls.some(call=>call.sql.includes('INSERT INTO app.neighborhood_group_active')),false);
});

test('overlapping worker and invalid budgets do not read source tables',async()=>{
  const f=fixture({locked:false});
  assert.deepEqual(await runNeighborhoodGroupIndex(f.pool),{status:'already_running'});
  assert.equal(f.calls.length,1);
  assert.equal(f.releaseError,undefined);
  await assert.rejects(runNeighborhoodGroupIndex(f.pool,{batchSize:5001}),/invalid_neighborhood_group_index:batch_size/);
  assert.equal(f.calls.length,1);
});

for (const unlockOutcome of ['rejected','not_owned','missing']) {
  test(`group-index worker retires its client after ${unlockOutcome} advisory unlock`,async()=>{
    const f=fixture({unlockOutcome});
    const result=await runNeighborhoodGroupIndex(f.pool,{logger:{info(){}}});
    assert.equal(result.status,'complete');
    assert.equal(f.releaseError?.message,'neighborhood_group_index_lock_state_unverified');
  });
}

for (const lockCase of [{lockError:true},{locked:'missing'}]) {
  test(`group-index worker fails closed after uncertain advisory acquisition ${JSON.stringify(lockCase)}`,async()=>{
    const f=fixture(lockCase);
    await assert.rejects(runNeighborhoodGroupIndex(f.pool,{logger:{warn(){}}}),
      /synthetic_lock_failure|neighborhood_group_index_lock_state_unverified/);
    assert.equal(f.calls.some(call=>call.sql.includes('pg_advisory_unlock')),false);
    assert.equal(f.releaseError?.message,'neighborhood_group_index_lock_state_unverified');
  });
}

test('lookup normalizes exact keys and reads only the published generation',async()=>{
  let values;
  const pool={async query(sql,parameters){assert.equal(sql,NEIGHBORHOOD_GROUP_INDEX_SQL.readSummary);values=parameters;return {rows:[{parcel_count:'2'}]};}};
  assert.deepEqual(await getPreparedNeighborhoodGroupSummary(pool,{county:' Dallas ',city:'GARLAND',subdivision:'  MONICA   PARK 4 '}),{parcel_count:'2'});
  assert.deepEqual(values,['dallas','garland','monica park 4']);
  assert.match(NEIGHBORHOOD_GROUP_INDEX_SQL.readSummary,/active\.generation_id/);
  assert.match(NEIGHBORHOOD_GROUP_INDEX_SQL.buildSummary,/GROUP BY county_key,city_key,subdivision_key/);
  assert.match(NEIGHBORHOOD_GROUP_INDEX_SQL.buildSaleAccountKeys,/count\(DISTINCT/);
  assert.match(NEIGHBORHOOD_GROUP_INDEX_SQL.buildSaleAccountKeys,/bool_and\(fact\.county_key IS NOT NULL/);
  assert.match(NEIGHBORHOOD_GROUP_INDEX_SQL.buildSaleAccountKeys,/CASE WHEN distinct_labels=1 AND complete THEN subdivision_key END/);
  assert.match(NEIGHBORHOOD_GROUP_INDEX_SQL.saleBatch,/pg_temp\.neighborhood_group_sale_account_keys/);
  assert.doesNotMatch(NEIGHBORHOOD_GROUP_INDEX_SQL.saleBatch,/LATERAL/);
});

test('nightly facts keep missing amenities unknown and aggregate only recorded areas',()=>{
  const parcel=NEIGHBORHOOD_GROUP_INDEX_SQL.parcelBatch;
  const summary=NEIGHBORHOOD_GROUP_INDEX_SQL.buildSummary;
  assert.match(parcel,/LEFT JOIN core\.primary_improvements/);
  assert.match(parcel,/JOIN core\.secondary_improvements/);
  assert.match(parcel,/primary_improvement\.bedroom_count/);
  assert.match(parcel,/primary_improvement\.bath_count/);
  assert.match(parcel,/sec_imp_sqft>0/);
  assert.match(parcel,/ATTACHED GARAGE/);
  assert.match(parcel,/OUTBUILDING/);
  assert.match(parcel,/WHEN primary_improvement\.pool IS FALSE THEN false ELSE NULL END/);
  assert.match(summary,/count\(pool\),count\(\*\) FILTER \(WHERE pool IS TRUE\)/);
  assert.match(summary,/percentile_cont\(0\.5\).*garage_area_sqft/);
  assert.match(summary,/percentile_cont\(0\.5\).*outbuilding_area_sqft/);
});

test('cleanup claims retirement in a separate transaction before deleting facts and excludes every pin',async()=>{
  const f=fixture();
  await runNeighborhoodGroupIndex(f.pool,{logger:{info(){}}});
  const sql=f.calls.map(call=>call.sql);
  const begin=sql.indexOf('BEGIN ISOLATION LEVEL READ COMMITTED');
  assert.ok(begin>sql.indexOf('COMMIT'),'publication is already committed');
  const retired=sql[begin+1],fresh=sql[begin+2];
  for(const claim of [retired,fresh]){
    assert.match(claim,/NOT EXISTS \(SELECT 1 FROM app\.neighborhood_custom_cohort_prepared_generation_pins/);
    assert.match(claim,/FOR UPDATE OF generation SKIP LOCKED/);
  }
  assert.match(retired,/retirement_started_at IS NOT NULL/);
  assert.doesNotMatch(retired,/OFFSET 1/,'an interrupted retirement must resume even if it is the only predecessor');
  assert.match(fresh,/retirement_started_at IS NULL/);
  assert.match(fresh,/OFFSET 1/,'keep the newest unretired predecessor');
  assert.equal(sql[begin+3],'COMMIT');
  assert.equal(sql.slice(begin).some(value=>value.includes('DELETE FROM')),false,'empty retirement does not delete any facts');
});

test('bounded retirement worker resumes a claimed generation and drains fresh backlog without republishing',async()=>{
  const retired='00000000-0000-4000-8000-000000000001';
  const fresh='00000000-0000-4000-8000-000000000002';
  const f=fixture({retirementCandidates:[retired],freshCandidates:[fresh]});
  assert.deepEqual(await runNeighborhoodGroupIndexRetirement(f.pool,{batchSize:2}),{status:'complete',pruned:2});
  const sql=f.calls.map(call=>call.sql);
  assert.equal(sql.filter(value=>value==='BEGIN ISOLATION LEVEL READ COMMITTED').length,3);
  assert.deepEqual(f.calls.filter(call=>call.sql.startsWith('UPDATE app.neighborhood_group_generations'))
    .map(call=>call.values),[[retired],[fresh]]);
  assert.equal(sql.some(value=>value.includes('INSERT INTO app.neighborhood_group_active')
    ||value.includes('FROM gis.dcad_parcels')||value.includes('FROM core.accounts')) ,false);
  assert.equal(sql.filter(value=>value.includes('pg_try_advisory_lock')).length,1);
  assert.equal(sql.filter(value=>value.includes('pg_advisory_unlock')).length,1);
  const terminalDeletes=f.calls.filter(call=>call.sql.startsWith('DELETE FROM app.neighborhood_group_summary')
    ||call.sql.startsWith('DELETE FROM app.neighborhood_frozen_source_generations')
    ||call.sql.startsWith('DELETE FROM app.neighborhood_group_generations'));
  assert.equal(terminalDeletes.length,6);
  assert.ok(terminalDeletes.every(call=>call.queryTimeout===120_000));
  assert.equal(f.released,true);assert.equal(f.releaseError,undefined);
});

test('retirement worker refuses overlapping publication, invalid budgets and uncertain unlock',async()=>{
  const overlapping=fixture({locked:false});
  assert.deepEqual(await runNeighborhoodGroupIndexRetirement(overlapping.pool),{status:'already_running'});
  assert.equal(overlapping.calls.length,1);
  for(const options of [{batchSize:5001},{maximumRuntimeMinutes:181}])
    await assert.rejects(runNeighborhoodGroupIndexRetirement(overlapping.pool,options),/invalid_neighborhood_group_index/);
  assert.equal(overlapping.calls.length,1);
  const uncertain=fixture({unlockOutcome:'missing'});
  assert.deepEqual(await runNeighborhoodGroupIndexRetirement(uncertain.pool),{status:'complete',pruned:0});
  assert.equal(uncertain.releaseError?.message,'neighborhood_group_index_lock_state_unverified');
});
