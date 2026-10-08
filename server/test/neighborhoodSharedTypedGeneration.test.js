import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createNeighborhoodSharedTypedGeneration, NEIGHBORHOOD_SHARED_TYPED_SQL as SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodSharedTypedGeneration.js';
import { getNeighborhoodFrozenTypedOriginalV1Profile } from '../src/services/neighborhoodAssessment/neighborhoodFrozenTypedOriginalV1.js';

const generationId='12345678-1234-4234-8234-123456789012', effectiveDate='2026-10-07';
const timestamp='2026-10-07T00:00:00.000000Z', clone=structuredClone;
const result=row=>({rowCount:1,rows:[row]});
const original=n=>({row_key:String(n),payload_text:JSON.stringify({object_id:String(n),account_id:'A',
  residential_year_built:1960,residential_area_sqft:'1000.01',parcel_area_sqft:'0',current_market_value:'9007199254740993'})});
function fixture(hook=()=>null) {
  const calls=[], typed=[];let header=null;
  const source={generation_id:generationId,format_version:1,status:'complete',source_snapshot:'1:2:',started_at:timestamp,completed_at:timestamp,
    layer_counts:Object.fromEntries(['parcels','accounts','source_records','sales','sale_links','sync_state','sync_runs'].map(k=>[k,
      {row_count:k==='parcels'?'2':'0',payload_utf8_bytes:k==='parcels'?'400':'0'}])),row_count:'2',payload_utf8_bytes:'400'};
  const tx={transaction_id:'1',source_snapshot:'1:2:',isolation:'repeatable read',read_only:'off',timezone:'UTC',backend_pid:1};
  const client={async query(call){calls.push(call);const override=await hook(call,{source,tx,header,typed});if(override)return override;
    const {text,values:v}=call;
    if(text===SQL.snapshot)return result(clone(tx));
    if(text===SQL.source)return result(clone(source));
    if(text===SQL.read||text===SQL.lock)return header?result(clone(header)):{rowCount:0,rows:[]};
    if(text.includes('shared-typed:begin')){header={binding_sha256:v[3],source_metadata:JSON.parse(v[4]),definition_json:v[5],
      progress:JSON.parse(v[6]),status:'building',completed_at:null};return {rowCount:1,rows:[]};}
    if(text===SQL.page){const rows=v[1]==='parcels'&&v[2]===''?[original(1),original(2)]:[];
      return result({page_json:JSON.stringify(rows),page_count:rows.length,candidate_count:rows.length,next_cursor:rows.at(-1)?.row_key??v[2]});}
    if(text===SQL.insert){const rows=JSON.parse(v[4]);typed.push(...rows.map(r=>({kind:v[3],...r})));
      return result({inserted_count:rows.length,typed_utf8_bytes:String(rows.reduce((n,r)=>n+Buffer.byteLength(JSON.stringify(r.typed)),0))});}
    if(text.includes('shared-typed:progress')){header.progress=JSON.parse(v[3]);header.status=v[4];header.completed_at=v[4]==='complete'?timestamp:null;
      return {rowCount:1,rows:[]};}assert.fail(text);
  }};
  return {client,calls,typed,source,tx,header:()=>header,builder:o=>createNeighborhoodSharedTypedGeneration(client,{generationId,effectiveDate,...o})};
}
async function complete(f) {let p=null,step;for(let i=0;i<7;i++){step=await f.builder().step(p);p=step.progress;}assert.equal(step.all_layers_typed,true);return step;}

test('one shared exact generation/profile/date prepares all layers once and reopens without originals or typed writes',async()=>{
  const f=fixture(),finished=await complete(f);
  assert.equal(finished.progress.typed_rows,'2');assert.equal(finished.authority,'not_established');assert.equal(finished.report_update,'none');
  assert.deepEqual(finished.profile,getNeighborhoodFrozenTypedOriginalV1Profile());
  assert.equal(f.typed[0].typed.observations.reported_residential_area.exact_value,'1000.01');
  assert.equal(f.typed[0].typed.observations.reported_market_value.exact_value,'9007199254740993');
  assert.equal(f.typed[0].typed.observations.reported_market_value.state,'unsupported');
  const from=f.calls.length,reused=await f.builder().step();
  assert.equal(reused.reused,true);assert.equal(reused.advanced,false);assert.deepEqual(reused.progress,finished.progress);
  assert.ok(!f.calls.slice(from).some(c=>/shared-typed:(?:page|rows|begin|progress|counts)/.test(c.text)));
  assert.equal(f.calls.slice(from).length,6);assert.ok(Object.isFrozen(reused.source_metadata.layer_counts.parcels));
  assert.ok(!f.calls.slice(from).some(c=>c.text.includes('FOR UPDATE')),'immutable cache reuse does not serialize on a header write lock');
  assert.ok(!f.calls.some(c=>/ST_DWithin|FROM core\.|FROM gis\.|COMMIT|capture_jobs|group_active/.test(c.text)));
  assert.ok(!f.calls.some(c=>c.text.includes('shared-typed:counts')),'one authoritative database completion scan, not two');
});
test('persisted building progress can be read after a lost acknowledgement without repeating writes',async()=>{
  const f=fixture(),first=await f.builder().step(),from=f.calls.length;
  const opened=await f.builder().step();assert.equal(opened.all_layers_typed,false);assert.equal(opened.advanced,false);
  assert.deepEqual(opened.progress,first.progress);assert.equal(f.typed.length,2);
  assert.ok(!f.calls.slice(from).some(c=>/shared-typed:(?:page|rows|begin|progress)/.test(c.text)));
  assert.equal((await f.builder().step(opened.progress)).progress.kind_index,2);
});
test('current exact source metadata, profile definition, effective date and caller progress cannot change on reuse',async()=>{
  for(const change of [f=>{f.source.source_snapshot='2:3:';},f=>{f.header().definition_json='{}';},
    f=>{f.header().progress.typed_rows='1';},f=>{f.header().status='building';},f=>{f.header().binding_sha256='e'.repeat(64);}]){
    const f=fixture();await complete(f);change(f);await assert.rejects(f.builder().step(),/checkpoint_mismatch/);}
  const f=fixture();const first=await f.builder().step();
  await assert.rejects(f.builder({effectiveDate:'2025-10-07'}).step(first.progress),/checkpoint_mismatch/);
  await assert.rejects(f.builder().step({...first.progress,kind_index:3}),/checkpoint_mismatch/);
});
test('autocommit, non-UTC, read-only or changed caller transactions refuse before any cache write',async()=>{
  for(const patch of [{isolation:'read committed'},{read_only:'on'},{timezone:'America/Chicago'},{transaction_id:'0'}]){
    const f=fixture();Object.assign(f.tx,patch);await assert.rejects(f.builder().step(),/caller_transaction_required/);
    assert.equal(f.calls.some(c=>c.text.includes('shared-typed:begin')),false);}
  let snapshots=0;const f=fixture(({text},{tx})=>text===SQL.snapshot&&++snapshots===2?result({...tx,transaction_id:'2'}):null);
  await assert.rejects(f.builder().step(),/caller_transaction_changed/);assert.equal(f.header(),null);
});
test('missing, altered or malformed source counts and ending source/transaction loss refuse for rollback',async()=>{
  for(const patch of [{status:'building'},{format_version:2},{row_count:'3'},{payload_utf8_bytes:'399'},
    {layer_counts:{parcels:{row_count:'2',payload_utf8_bytes:'400'}}}]){
    const f=fixture();Object.assign(f.source,patch);await assert.rejects(f.builder().step(),/source_unavailable|invalid_input/);assert.equal(f.header(),null);}
  let sources=0;const f=fixture(({text},{source})=>text===SQL.source&&++sources===2?result({...source,source_snapshot:'2:3:'}):null);
  await assert.rejects(f.builder().step(),/source_changed/);
  let probes=0;const tx=fixture(({text},{tx})=>text===SQL.snapshot&&++probes===3?result({...tx,transaction_id:'2'}):null);
  await assert.rejects(tx.builder().step(),/source_changed/);
});
test('bounded page decoding rejects malformed counts, order, oversized originals and skipped byte-prefix rows',async()=>{
  for(const patch of [{page_count:3},{candidate_count:251},{next_cursor:'other'},
    {page_json:'[]',page_count:0,candidate_count:1},
    {page_json:JSON.stringify([original(2),original(1)])},
    {page_json:'x'.repeat(2_100_001)},
    {page_json:JSON.stringify([{row_key:'1',payload_text:'x'.repeat(1_000_001)},original(2)])}]){
    const f=fixture(({text})=>text===SQL.page?result({page_json:JSON.stringify([original(1),original(2)]),page_count:2,candidate_count:2,next_cursor:'2',...patch}):null);
    await assert.rejects(f.builder().step(),/page_corrupt|page_unavailable|invalid_input/);
    assert.equal(f.typed.length,0);}
});
test('original exact-text acknowledgements, database completion verification and progress CAS remain independently required',async()=>{
  for(const override of [result({inserted_count:1,typed_utf8_bytes:'100'}),result({inserted_count:2,typed_utf8_bytes:'0'})]){
    const f=fixture(({text})=>text===SQL.insert?override:null);await assert.rejects(f.builder().step(),/original_mismatch/);}
  const totals=fixture(({text,values})=>{
    if(text.includes('shared-typed:progress')&&values[4]==='complete')
      throw Object.assign(new Error('neighborhood_shared_typed_population_incomplete'),{code:'55000'});
  });
  await assert.rejects(complete(totals),/population_incomplete/);
  assert.equal(totals.header().status,'building','failed database verification cannot publish completion');
  const other=Object.assign(new Error('another_database_error'),{code:'55000'});
  const untouched=fixture(({text})=>{if(text.includes('shared-typed:progress'))throw other;});
  await assert.rejects(untouched.builder().step(),error=>error===other);
  const lost=fixture(({text})=>text.includes('shared-typed:progress')?{rowCount:0,rows:[]}:null);
  await assert.rejects(lost.builder().step(),/write_lost/);
});
test('only building continuations lock and independently recheck the exact checkpoint before row writes',async()=>{
  let change=false;const f=fixture(({text},{header})=>change&&text===SQL.lock?result({...clone(header),binding_sha256:'e'.repeat(64)}):null);
  const first=await f.builder().step(),from=f.calls.length;change=true;
  await assert.rejects(f.builder().step(first.progress),/checkpoint_mismatch/);
  assert.ok(!f.calls.slice(from).some(c=>c.text===SQL.page||c.text===SQL.insert));
  assert.match(SQL.lock,/FOR UPDATE NOWAIT$/);assert.doesNotMatch(SQL.read,/FOR UPDATE/);
});
test('closed options/progress detach input, never invoke getters and serialize pending settlement with cancellation',async()=>{
  const f=fixture();let invoked=false;
  const opts={generationId,effectiveDate};Object.defineProperty(opts,'generationId',{enumerable:true,get(){invoked=true;return generationId;}});
  assert.throws(()=>createNeighborhoodSharedTypedGeneration(f.client,opts),/invalid_input/);assert.equal(invoked,false);
  assert.throws(()=>f.builder({table:'core.accounts'}),/invalid_input/);
  const first=await f.builder().step(),p={...first.progress};
  Object.defineProperty(p,'after',{enumerable:true,get(){invoked=true;return '';}});
  await assert.rejects(f.builder().step(p),/invalid_input/);assert.equal(invoked,false);
  await assert.rejects(f.builder().step(new Proxy(first.progress,{})),/invalid_input/);
  let release;const pending=new Promise(resolve=>{release=resolve;});let wait=false;
  const lane=fixture(async({text})=>{if(wait&&text===SQL.source)await pending;});const start=await lane.builder().step();
  wait=true;const input={...start.progress},builder=lane.builder(),running=builder.step(input);input.kind_index=7;
  await new Promise(resolve=>setImmediate(resolve));await assert.rejects(builder.step(),/concurrent_operation/);release();
  assert.equal((await running).progress.kind_index,2);
  const ac=new AbortController();ac.abort();const from=f.calls.length;
  await assert.rejects(f.builder({signal:ac.signal}).step(),/cancelled/);assert.equal(f.calls.length,from);
  const late=new AbortController();const lateFixture=fixture(({text})=>{if(text===SQL.insert)late.abort();});
  await assert.rejects(lateFixture.builder({signal:late.signal}).step(),/cancelled/);
});
test('shared schema is additive, immutable, indexed and retires before originals without source or route activation',()=>{
  const sql=readFileSync(new URL('../migrations/20261110_neighborhood_shared_typed_generations.sql',import.meta.url),'utf8');
  assert.match(sql,/PRIMARY KEY\(generation_id,profile_sha256,effective_date,kind,row_key\)/);
  assert.match(sql,/generation_id,kind,row_key/);assert.match(sql,/neighborhood_shared_typed_population_incomplete/);
  assert.match(sql,/typed_utf8_bytes integer GENERATED ALWAYS AS \(octet_length\(typed::text\)\) STORED/);
  assert.match(sql,/sum\(typed_utf8_bytes\)/);
  assert.equal(Object.hasOwn(SQL,'counts'),false,'completion counting belongs to the authoritative database trigger');
  assert.match(sql,/reject_pinned_neighborhood_group_mutation/);assert.match(sql,/retirement_started_at IS NULL/);
  assert.doesNotMatch(sql,/ALTER TABLE|DROP TABLE|DISABLE|ON DELETE CASCADE/);
  assert.match(SQL.insert,/original.payload::text=input.original_text/);
  assert.match(SQL.page,/row_key>\$3::text COLLATE "C" ORDER BY row_key LIMIT/);
  const worker=readFileSync(new URL('../src/services/neighborhoodAssessment/neighborhoodGroupIndex.js',import.meta.url),'utf8');
  assert.match(worker,/\[PRUNE_SHARED_TYPED,PRUNE_SHARED_TYPED_HEADERS,PRUNE_ORIGINALS,PRUNE_PARCELS,PRUNE_SALES\]/);
  assert.equal(worker.includes('createNeighborhoodSharedTypedGeneration'),false,'cleanup integration does not turn on a new sweep');
});
