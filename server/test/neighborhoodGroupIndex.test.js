import assert from 'node:assert/strict';
import test from 'node:test';
import { getPreparedNeighborhoodGroupSummary,runNeighborhoodGroupIndex,NEIGHBORHOOD_GROUP_INDEX_SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodGroupIndex.js';

function fixture({locked=true,fail=false}={}) {
  const calls=[];let released=false;
  const client={
    async query(input,values) {
      const sql=typeof input==='string'?input:input.text;
      calls.push({sql,values:values??input.values});
      if (sql.includes('pg_try_advisory_lock')) return {rows:[{locked}]};
      if (sql===NEIGHBORHOOD_GROUP_INDEX_SQL.parcelBatch || sql===NEIGHBORHOOD_GROUP_INDEX_SQL.saleBatch) {
        if (fail) throw new Error('synthetic_batch_error');
        return {rows:[{cursor:'-9223372036854775808',scanned:0,copied:0}]};
      }
      if (sql.startsWith('UPDATE app.neighborhood_group_generations')) return {rowCount:1,rows:[]};
      return {rows:[]};
    },
    release(){released=true;},
  };
  return {pool:{async connect(){return client;}},calls,get released(){return released;}};
}

test('publishes only after parcel, sale and summary preparation in one snapshot',async()=>{
  const f=fixture();
  const result=await runNeighborhoodGroupIndex(f.pool,{logger:{info(){}}});
  assert.equal(result.status,'complete');
  const sql=f.calls.map(call=>call.sql);
  assert.ok(sql.indexOf('BEGIN ISOLATION LEVEL REPEATABLE READ')<sql.indexOf(NEIGHBORHOOD_GROUP_INDEX_SQL.parcelBatch));
  assert.ok(sql.indexOf(NEIGHBORHOOD_GROUP_INDEX_SQL.parcelBatch)<sql.indexOf(NEIGHBORHOOD_GROUP_INDEX_SQL.saleBatch));
  assert.ok(sql.indexOf(NEIGHBORHOOD_GROUP_INDEX_SQL.saleBatch)<sql.indexOf(NEIGHBORHOOD_GROUP_INDEX_SQL.buildSummary));
  assert.ok(sql.indexOf(NEIGHBORHOOD_GROUP_INDEX_SQL.buildSales)<sql.findIndex(value=>value.includes('INSERT INTO app.neighborhood_group_active')));
  assert.ok(sql.findIndex(value=>value.includes('INSERT INTO app.neighborhood_group_active'))<sql.indexOf('COMMIT'));
  assert.equal(sql.includes('ROLLBACK'),false);
  assert.equal(f.released,true);
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

test('overlapping worker and invalid budgets do not read source tables',async()=>{
  const f=fixture({locked:false});
  assert.deepEqual(await runNeighborhoodGroupIndex(f.pool),{status:'already_running'});
  assert.equal(f.calls.length,1);
  await assert.rejects(runNeighborhoodGroupIndex(f.pool,{batchSize:5001}),/invalid_neighborhood_group_index:batch_size/);
  assert.equal(f.calls.length,1);
});

test('lookup normalizes exact keys and reads only the published generation',async()=>{
  let values;
  const pool={async query(sql,parameters){assert.equal(sql,NEIGHBORHOOD_GROUP_INDEX_SQL.readSummary);values=parameters;return {rows:[{parcel_count:'2'}]};}};
  assert.deepEqual(await getPreparedNeighborhoodGroupSummary(pool,{county:' Dallas ',city:'GARLAND',subdivision:'  MONICA   PARK 4 '}),{parcel_count:'2'});
  assert.deepEqual(values,['dallas','garland','monica park 4']);
  assert.match(NEIGHBORHOOD_GROUP_INDEX_SQL.readSummary,/active\.generation_id/);
  assert.match(NEIGHBORHOOD_GROUP_INDEX_SQL.buildSummary,/GROUP BY county_key,city_key,subdivision_key/);
  assert.match(NEIGHBORHOOD_GROUP_INDEX_SQL.saleBatch,/count\(DISTINCT/);
});
