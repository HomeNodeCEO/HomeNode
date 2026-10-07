import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { materializeNeighborhoodFrozenSourceGeneration,NEIGHBORHOOD_FROZEN_SOURCE_SQL,
  NEIGHBORHOOD_FROZEN_SOURCE_LIMITS } from '../src/services/neighborhoodAssessment/neighborhoodFrozenSourceGeneration.js';

const generationId='11111111-1111-4111-8111-111111111111';
const snapshot={transaction_id:'123',source_snapshot:'120:123:',isolation:'repeatable read',read_only:'off',
  timezone:'UTC',started_at:'2026-10-07T00:00:00.000001Z',backend_pid:17};
function fixture({ counts={parcels:2,accounts:1,source_records:3,sales:3,sale_links:2,sync_state:1,sync_runs:1},
  changeSnapshot,invalidKey=false,changePage,failPage=false,completeCount=1,status='building' }={}) {
  const calls=[];let snapshots=0;
  return {calls,client:{async query(config){
    calls.push(config);const sql=config.text;
    if(sql.includes('neighborhood-frozen-source:snapshot')) {
      const row={...snapshot};++snapshots;if(changeSnapshot)changeSnapshot(row,snapshots);
      return {rowCount:1,rows:[row]};
    }
    if(sql.includes('neighborhood-frozen-source:generation */'))return {rowCount:1,rows:[{generation_id:generationId,status}]};
    const countKind=/neighborhood-frozen-source:count-([a-z_]+) \*/.exec(sql)?.[1];
    if(countKind)return {rowCount:1,rows:[{row_count:String(counts[countKind]??0),invalid_key:invalidKey}]};
    if(sql.includes('neighborhood-frozen-source:header'))return {rowCount:1,rows:[]};
    if(sql.includes('neighborhood-frozen-source:complete'))return {rowCount:completeCount,rows:[]};
    const kind=Object.keys(NEIGHBORHOOD_FROZEN_SOURCE_SQL).find(key=>NEIGHBORHOOD_FROZEN_SOURCE_SQL[key]===sql);
    assert.ok(kind,'only fixed source SQL reaches this client');
    if(failPage)throw new Error('synthetic source statement failed');
    const [,cursor,limit]=config.values,prior=cursor ? Number(kind==='sync_runs' ? cursor.slice(-12) : cursor) : 0;
    const copied=Math.min(Math.max(0,(counts[kind]??0)-prior),limit);
    const next=String(prior+copied);
    const row={cursor:copied ? (kind==='sync_runs' ? `00000000-0000-0000-0000-${next.padStart(12,'0')}` : next) : cursor,
      copied,payload_utf8_bytes:String(copied*100)};
    changePage?.(row,kind,prior);return {rowCount:1,rows:[row]};
  }}};
}
const writes=calls=>calls.filter(c=>/neighborhood-frozen-source:(?:header|complete|parcels|accounts|source_records|sales|sale_links|sync_state|sync_runs) \*/.test(c.text));

test('frozen sweep copies all seven fixed layers in one source snapshot with only aggregate results',async()=>{
  const f=fixture(),result=await materializeNeighborhoodFrozenSourceGeneration(f.client,{generationId,batchSize:1});
  assert.equal(result.status,'materialized');assert.equal(result.authority,'not_established');
  assert.equal(result.row_count,'13');assert.equal(result.payload_utf8_bytes,'1300');
  assert.equal(result.layer_counts.parcels.row_count,'2');assert.equal(result.layer_counts.source_records.row_count,'3');
  assert.equal(Object.isFrozen(result.layer_counts),true);
  assert.ok(f.calls.every(c=>c.query_timeout>0&&c.query_timeout<=120000));
  assert.equal(f.calls.filter(c=>c.text.includes(':snapshot */')).length,3);
  assert.equal(f.calls.some(c=>/^BEGIN|^COMMIT|^ROLLBACK/.test(c.text)),false);
  assert.equal(f.calls.at(-1).text.includes(':complete */'),true);
});
test('autocommit, changed backend, wrong isolation or non-UTC snapshot refuse before any write',async()=>{
  for(const mutate of [(row,n)=>row.transaction_id=String(123+n),(row,n)=>row.backend_pid=17+n,
    row=>row.isolation='read committed',row=>row.read_only='on',row=>row.timezone='America/Chicago']) {
    const f=fixture({changeSnapshot:mutate});
    await assert.rejects(materializeNeighborhoodFrozenSourceGeneration(f.client,{generationId}),/caller_snapshot/);
    assert.deepEqual(writes(f.calls),[]);
  }
});
test('published generations cannot be repopulated or mistaken for a building source snapshot',async()=>{
  const f=fixture({status:'complete'});
  await assert.rejects(materializeNeighborhoodFrozenSourceGeneration(f.client,{generationId}),/building_generation_required/);
  assert.deepEqual(writes(f.calls),[]);
});
test('independent whole-source counts detect excluded invalid keys before any source header',async()=>{
  for(const options of [{invalidKey:true},{counts:{parcels:NEIGHBORHOOD_FROZEN_SOURCE_LIMITS.rows_per_layer+1}}]) {
    const f=fixture(options);await assert.rejects(materializeNeighborhoodFrozenSourceGeneration(f.client,{generationId}),/source_population_invalid/);
    assert.deepEqual(writes(f.calls),[]);
  }
});
test('premature empty pages and wrong cursor/byte counters refuse completion for caller rollback',async()=>{
  for(const mutate of [row=>Object.assign(row,{copied:0,cursor:'',payload_utf8_bytes:'0'}),
    row=>row.cursor='',row=>row.payload_utf8_bytes='32000001',row=>row.copied=999,
    row=>row.payload_utf8_bytes='0']) {
    const f=fixture({changePage:mutate});
    await assert.rejects(materializeNeighborhoodFrozenSourceGeneration(f.client,{generationId,batchSize:1}),/invalid_page|source_population_incomplete/);
    assert.equal(f.calls.some(c=>c.text.includes(':complete */')),false);
  }
});
test('SQL failure, lost source snapshot and lost completion remain failures, never completed receipts',async()=>{
  for(const [options,reason] of [[{failPage:true},/synthetic source statement failed/],
    [{changeSnapshot:(row,n)=>{if(n===3)row.source_snapshot='121:124:';}},/caller_snapshot_changed/],
    [{completeCount:0},/completion_lost/]]) {
    const f=fixture(options);await assert.rejects(materializeNeighborhoodFrozenSourceGeneration(f.client,{generationId}),reason);
    assert.equal(f.calls.some(c=>/^COMMIT|^ROLLBACK/.test(c.text)),false);
  }
});
test('cancelled and invalid writer options cannot open SQL or select source fields',async()=>{
  const abort=new AbortController();abort.abort();
  for(const options of [{generationId:'injected'},{generationId,batchSize:251},{generationId,batchSize:0},
    {generationId,maximumRuntimeMs:3600001},{generationId,signal:abort.signal}]) {
    const f=fixture();await assert.rejects(materializeNeighborhoodFrozenSourceGeneration(f.client,options),/invalid_input|cancelled/);
    assert.deepEqual(f.calls,[]);
  }
});
test('fixed source plans retain all-date unresolved and package rows without arbitrary private MLS fields',()=>{
  const plans=NEIGHBORHOOD_FROZEN_SOURCE_SQL;
  assert.deepEqual(Object.keys(plans),['parcels','accounts','source_records','sales','sale_links','sync_state','sync_runs']);
  for(const sql of Object.values(plans)) {
    assert.match(sql,/LIMIT \$3::integer/);assert.match(sql,/NULLIF\(\$2,''\)/);
    assert.doesNotMatch(sql,/to_jsonb\((?:src|parcel|sale|link|account)\)|SELECT \*|account_id IS NOT NULL|closing_date[<>]|is_resolved=true/);
  }
  assert.match(plans.source_records,/source_raw_witness/);assert.match(plans.source_records,/witness_version/);
  assert.doesNotMatch(plans.source_records,/raw_payload AS|to_jsonb\(src/);
  assert.match(plans.parcels,/ST_AsEWKB\(parcel\.geom\)/);assert.match(plans.parcels,/class_code/);
});
test('source snapshot migration registers fixed indexes, pinned guards and post-publication immutability',()=>{
  const name='20261105_neighborhood_frozen_original_sources.sql';
  const registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8');
  assert.ok(registry.indexOf(name)>registry.indexOf('20261104_custom_cohort_prepared_generation_pins.sql'));
  const sql=readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
  assert.match(sql,/USING gist\(geom\)/);assert.match(sql,/source_record_id,row_key COLLATE "C"/);
  assert.match(sql,/reject_pinned_neighborhood_group_mutation/);assert.match(sql,/retirement_started_at IS NULL/);
  assert.match(sql,/generation.status<>'building'/);assert.doesNotMatch(sql,/FOR EACH ROW|DISABLE TRIGGER|DROP TABLE/);
  // INSERT transition tables have only new_rows. PostgreSQL resolves relation
  // references before boolean short-circuiting, so UPDATE needs its own branch.
  assert.match(sql,/IF TG_OP='UPDATE' THEN\s+IF EXISTS \(SELECT 1 FROM old_rows/);
  assert.doesNotMatch(sql,/TG_OP='UPDATE'\s+AND\s+EXISTS/);
});
