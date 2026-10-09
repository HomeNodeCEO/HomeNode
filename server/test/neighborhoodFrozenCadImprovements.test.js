import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { materializeNeighborhoodFrozenCadImprovements, getNeighborhoodFrozenCadImprovementProfile,
  NEIGHBORHOOD_FROZEN_CAD_IMPROVEMENT_SQL as SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenCadImprovements.js';

const generationId='11111111-1111-4111-8111-111111111111';
const snapshot={transaction_id:'123',source_snapshot:'120:123:',isolation:'repeatable read',read_only:'off',
  timezone:'UTC',started_at:'2026-10-07T00:00:00.000001Z',backend_pid:17};
function fixture({counts={primary:3,secondary:4},changeSnapshot,changeSource,invalidKey=false,
  changePage,failPage=false,headerCount=1,completeCount=1}={}) {
  const calls=[];let probes=0;
  return {calls,client:{async query(config){
    calls.push(config);
    if(config.text===SQL.snapshot){const r={...snapshot};changeSnapshot?.(r,++probes);return {rowCount:1,rows:[r]};}
    if(config.text===SQL.source){const r={generation_id:generationId,generation_status:'building',format_version:1,
      status:'complete',source_snapshot:snapshot.source_snapshot,started_at:snapshot.started_at};
      changeSource?.(r);return {rowCount:1,rows:[r]};}
    const countKind=Object.keys(SQL.counts).find(k=>SQL.counts[k]===config.text);
    if(countKind)return {rowCount:1,rows:[{row_count:String(counts[countKind]??0),invalid_key:invalidKey}]};
    if(config.text===SQL.begin)return {rowCount:headerCount,rows:[]};
    if(config.text===SQL.complete)return {rowCount:completeCount,rows:[]};
    const kind=Object.keys(SQL.pages).find(k=>SQL.pages[k]===config.text);assert.ok(kind,'fixed plan only');
    if(failPage)throw new Error('synthetic CAD statement failed');
    const [,cursor,limit]=config.values,prior=cursor?Number(kind==='primary'?cursor.slice(2):cursor):0;
    const copied=Math.min(Math.max(0,(counts[kind]??0)-prior),limit),next=prior+copied;
    const r={copied,cursor:copied?(kind==='primary'?`A-${String(next).padStart(4,'0')}`:String(next)):cursor,
      payload_utf8_bytes:String(copied*100)};
    changePage?.(r,kind,prior);return {rowCount:1,rows:[r]};
  }}};
}
const writes=calls=>calls.filter(c=>c.text===SQL.begin||c.text===SQL.complete||Object.values(SQL.pages).includes(c.text));

test('CAD companion has a separate immutable fixed-column content-addressed profile',()=>{
  const p=getNeighborhoodFrozenCadImprovementProfile(),d=JSON.parse(p.definition_blob.canonical_json);
  assert.equal(createHash('sha256').update(p.definition_blob.canonical_json).digest('hex'),p.profile_ref.content_sha256);
  assert.deepEqual(Object.keys(d.fields),['primary','secondary']);
  assert.deepEqual(d.fields.primary,['account_id','year_built','living_area_sqft','bedroom_count','bath_count','number_units','pool']);
  assert.equal(Object.isFrozen(p),true);assert.equal(Object.isFrozen(p.definition_blob),true);
  assert.match(d.semantics,/not_verified_GLA/);assert.ok(d.limitations.includes('no_legacy_capture_backfill'));
});
test('same-snapshot whole-source copy returns only bounded aggregate counters, not source arrays',async()=>{
  const f=fixture(),r=await materializeNeighborhoodFrozenCadImprovements(f.client,{generationId,batchSize:1});
  assert.equal(r.row_count,'7');assert.equal(r.payload_utf8_bytes,'700');assert.equal(r.authority,'not_established');
  assert.equal(r.layer_counts.primary.row_count,'3');assert.equal(r.layer_counts.secondary.row_count,'4');
  assert.equal(r.report_update,'none');assert.equal(Object.isFrozen(r.layer_counts.primary),true);
  assert.equal(f.calls.filter(c=>c.text===SQL.snapshot).length,3);
  assert.ok(f.calls.every(c=>c.query_timeout>0&&c.query_timeout<=120000));
  assert.equal(f.calls.at(-1).text,SQL.complete);assert.equal(f.calls.some(c=>/^BEGIN|^COMMIT|^ROLLBACK/.test(c.text)),false);
  assert.equal(f.calls.find(c=>c.text===SQL.begin).values[5],'{"primary":"3","secondary":"4"}');
});
test('empty source populations complete exactly, without inventing zero-valued improvements',async()=>{
  const f=fixture({counts:{}}),r=await materializeNeighborhoodFrozenCadImprovements(f.client,{generationId});
  assert.equal(r.row_count,'0');assert.deepEqual(r.layer_counts.primary,{row_count:'0',payload_utf8_bytes:'0'});
});
test('autocommit, wrong isolation/timezone, changed transaction/backend refuse before writes',async()=>{
  for(const mutate of [(r,n)=>r.transaction_id=String(123+n),(r,n)=>r.backend_pid=17+n,
    r=>r.isolation='read committed',r=>r.read_only='on',r=>r.timezone='America/Chicago',r=>r.source_snapshot='bad']) {
    const f=fixture({changeSnapshot:mutate});
    await assert.rejects(materializeNeighborhoodFrozenCadImprovements(f.client,{generationId}),/caller_snapshot/);
    assert.deepEqual(writes(f.calls),[]);
  }
});
test('published, missing, partial, wrong-format or later-snapshot originals cannot be backfilled',async()=>{
  for(const changeSource of [r=>r.generation_status='complete',r=>r.status='building',r=>r.format_version=2,
    r=>r.generation_id='22222222-2222-4222-8222-222222222222',r=>r.source_snapshot='121:124:',r=>r.started_at='2026-10-07T00:00:01.000001Z']){
    const f=fixture({changeSource});await assert.rejects(materializeNeighborhoodFrozenCadImprovements(f.client,{generationId}),/same_building_source_snapshot/);
    assert.deepEqual(writes(f.calls),[]);
  }
});
test('whole-source invalid keys and over-limit counts refuse before any header',async()=>{
  for(const o of [{invalidKey:true},{counts:{primary:2000001}},{counts:{secondary:'01'}},{counts:{primary:'-1'}}]){
    const f=fixture(o);await assert.rejects(materializeNeighborhoodFrozenCadImprovements(f.client,{generationId}),/source_population_invalid/);
    assert.deepEqual(writes(f.calls),[]);
  }
});
test('nonadvancing, oversized, negative, malformed or over-bigint pages cannot complete',async()=>{
  for(const changePage of [(r)=>r.cursor='',r=>r.copied=251,r=>r.copied=-1,r=>r.payload_utf8_bytes='32000001',
    r=>r.payload_utf8_bytes='0',r=>r.payload_utf8_bytes='1.5',(r,k)=>{if(k==='secondary')r.cursor='9223372036854775808';},
    (r,k)=>{if(k==='secondary')r.cursor='01';}]){
    const f=fixture({changePage});await assert.rejects(materializeNeighborhoodFrozenCadImprovements(f.client,{generationId,batchSize:1}),/invalid_page/);
    assert.equal(f.calls.some(c=>c.text===SQL.complete),false);
  }
});
test('premature termination and too many rows cannot relabel a prefix as complete',async()=>{
  const f=fixture({changePage:r=>Object.assign(r,{copied:0,cursor:'',payload_utf8_bytes:'0'})});
  await assert.rejects(materializeNeighborhoodFrozenCadImprovements(f.client,{generationId}),/source_population_incomplete/);
  assert.equal(f.calls.some(c=>c.text===SQL.complete),false);
});
test('statement failure, lost header/completion and ending snapshot change remain failures for owner rollback',async()=>{
  for(const [o,reason] of [[{failPage:true},/synthetic CAD statement/],[{headerCount:0},/header_lost/],
    [{completeCount:0},/completion_lost/],[{changeSnapshot:(r,n)=>{if(n===3)r.source_snapshot='121:124:';}},/caller_snapshot_changed/]]){
    const f=fixture(o);await assert.rejects(materializeNeighborhoodFrozenCadImprovements(f.client,{generationId}),reason);
    assert.equal(f.calls.some(c=>/^COMMIT|^ROLLBACK/.test(c.text)),false);
  }
});
test('hostile options cannot invoke getters/proxy traps or inject source SQL',async()=>{
  let reflected=false;
  const getter={generationId,get batchSize(){reflected=true;throw new Error('getter');}};
  const proxy=new Proxy({generationId},{ownKeys(){reflected=true;throw new Error('proxy');}});
  for(const o of [getter,proxy,{generationId,sourceSql:'SELECT secrets'},{generationId,batchSize:251},
    {generationId,maximumRuntimeMs:3600001},Object.assign(Object.create(null),{generationId})]){
    const f=fixture();await assert.rejects(materializeNeighborhoodFrozenCadImprovements(f.client,o),/invalid_input/);
    assert.deepEqual(f.calls,[]);
  }
  assert.equal(reflected,false);
});
test('initial and in-flight cancellation/budget refusal never mark the candidate complete',async()=>{
  const abort=new AbortController();abort.abort();const f=fixture();
  await assert.rejects(materializeNeighborhoodFrozenCadImprovements(f.client,{generationId,signal:abort.signal}),/cancelled/);
  assert.deepEqual(f.calls,[]);
  const running=new AbortController(),g=fixture({changePage:()=>running.abort()});
  await assert.rejects(materializeNeighborhoodFrozenCadImprovements(g.client,{generationId,signal:running.signal}),/cancelled/);
  assert.equal(g.calls.some(c=>c.text===SQL.complete),false);
  const h=fixture();await assert.rejects(materializeNeighborhoodFrozenCadImprovements(h.client,{generationId,checkBudget(){throw new Error('budget refused');}}),/budget refused/);
  assert.deepEqual(h.calls,[]);
});
test('a spent runtime budget stops before any source header or publication',async()=>{
  const f=fixture(),slow={async query(config){const r=await f.client.query(config);
    await new Promise(resolve=>setTimeout(resolve,5));return r;}};
  await assert.rejects(materializeNeighborhoodFrozenCadImprovements(slow,{generationId,maximumRuntimeMs:1}),/runtime_limit/);
  assert.deepEqual(writes(f.calls),[]);
});
test('fixed plans preserve NULLs/literals and native keys without account/amenity selection or inferred sums',()=>{
  assert.match(SQL.pages.primary,/year_built::text.*living_area_sqft::text/);
  assert.match(SQL.pages.primary,/bath_count::text/);assert.match(SQL.pages.primary,/ORDER BY p.account_id COLLATE "C"/);
  assert.match(SQL.pages.secondary,/s.id::text,s.account_id,s.sec_imp_number::text,s.sec_imp_type,s.sec_imp_sqft::text/);
  assert.match(SQL.pages.secondary,/ORDER BY s.id LIMIT \$3::integer/);
  for(const sql of Object.values(SQL.pages))assert.doesNotMatch(sql,/SELECT \*|GROUP BY|sec_imp_type IN|COALESCE\(.*pool|ST_DWithin|effective_date|closing_date/);
});
test('additive migration enforces exact-source acknowledgement, counts, immutability, pin-aware retirement',()=>{
  const name='20261116_neighborhood_frozen_cad_improvements.sql';
  const sql=readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
  const registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8');
  const predecessor='20261115_neighborhood_shared_typed_v2_generations.sql';
  assert.ok(registry.includes(predecessor));assert.ok(registry.indexOf(name)>registry.indexOf(predecessor));
  assert.match(sql,/source_counts_mismatch/);assert.match(sql,/count\(\*\)::text FROM core.primary_improvements/);
  assert.match(sql,/ON core.primary_improvements\(account_id COLLATE "C"\)/);
  assert.match(sql,/changed.payload IS DISTINCT FROM/);assert.match(sql,/s.id=CASE WHEN changed.kind='secondary'/);
  assert.match(sql,/CHECK\(payload_sha256=encode\(sha256\(convert_to\(payload::text/);
  assert.match(sql,/CHECK\(payload_utf8_bytes=octet_length\(payload::text\)\)/);
  assert.doesNotMatch(sql,/GENERATED ALWAYS AS/);assert.match(sql,/same_snapshot_required/);
  assert.match(sql,/reject_pinned_neighborhood_group_mutation/);assert.match(sql,/retirement_started_at IS NULL/);
  assert.match(sql,/pg_trigger_depth\(\)<>2/);assert.match(sql,/population_incomplete/);
  assert.doesNotMatch(sql,/DISABLE TRIGGER|DROP TABLE|ON DELETE CASCADE/);
  const worker=readFileSync(new URL('../src/services/neighborhoodAssessment/neighborhoodGroupIndex.js',import.meta.url),'utf8');
  assert.match(worker,/retainCadImprovementOriginals=false/);
  assert.match(worker,/PRUNE_CAD_ORIGINALS,PRUNE_CAD_TOTALS,PRUNE_CAD_HEADERS,PRUNE_ORIGINALS/);
});
