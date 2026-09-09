import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { createNeighborhoodCachedSourceReader } from '../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { ASSESSMENT_SCOPE } from './fixtures/neighborhoodAssessmentFixture.js';
import { createTestCachedReadAccess } from './fixtures/neighborhoodCachedReadAccessFixture.js';

// Query-boundary fakes only. The separately gated native test verifies actual
// PostgreSQL transaction/snapshot behavior; this fixture does not emulate MVCC.
const source=readFileSync(new URL('../src/services/neighborhoodAssessment/cachedSourceReader.js',import.meta.url),'utf8');
const declaration=source.slice(source.indexOf('const TABLES'),source.indexOf('const SQL'));
const catalog=[...declaration.matchAll(/\['([a-z_]+\.[a-z_]+)', '([^']+)'\]/g)]
  .flatMap(([,relation,columns]) => columns.split(' ').map(column => ({relation,column})));
const RUN='60000000-0000-4000-8000-000000000001';
const NOW='2026-09-05T12:00:00.000Z';
const SUBJECT=ASSESSMENT_SCOPE.account_id;
const request={scope:ASSESSMENT_SCOPE,account_ids:[SUBJECT],effective_date:'2024-06-30',
  observation_period:{start_date:'2023-07-01',end_date:'2024-06-30'}};
const state={isolation:'repeatable read',read_only:'on',timezone:'UTC',explicit_transaction:true,
  backend_pid:1234,snapshot:'100:100:',transaction_started_at:'2026-09-05T11:59:59.123456Z',
  statement_ms:5000,lock_ms:1000,idle_ms:10000};
const transaction={source_record_id:'10',sale_id:'20',primary_account_id:SUBJECT,
  sale_account_id:SUBJECT,source_record_hash:'b'.repeat(64)};

async function fixture({intercept,limits,accessOptions}={}) {
  const calls=[];
  let connects=0,releases=0;
  const access=createTestCachedReadAccess(request,{transactionClosure:{source_revision:'snapshot-fixture-v1',
    transactions:[transaction],links:[],legacy:[]},...accessOptions});
  const prepared=await access.prepare();
  const input={...prepared.request,auth:access.auth,selection_grant:prepared.selection_grant,market_grant:prepared.market_grant};
  const client={release() {releases++;},async query(config) {
    const tag=config.text.match(/neighborhood-cache:([\w-]+)/)?.[1] ?? config.text.toLowerCase();
    calls.push({tag,...config});
    const replacement=await intercept?.({tag,config,calls});
    if (replacement!==undefined) return replacement;
    if (tag==='caller-snapshot') return {rows:[structuredClone(state)]};
    if (['begin','settings','commit','rollback'].includes(tag)) return {rows:[]};
    if (tag==='scope') return {rows:[{case_date:request.effective_date,snapshot_date:request.effective_date,
      effective_date:request.effective_date,captured_at:NOW,captured_at_precise:'2026-09-05T12:00:00.000000Z'}]};
    if (tag==='capabilities') return {rows:catalog};
    const data={
      parcels:[{object_id:'1',account_id:SUBJECT,source_record_hash:'a'.repeat(64),sync_run_id:RUN,
        residential_year_built:2000,residential_area_sqft:'1800',parcel_area_sqft:'5000',current_market_value:'250000',
        synced_at:NOW,source_updated_at:null,stored_geometry_ewkb:'010203'}],
      accounts:[{account_id:SUBJECT,subdivision:'Synthetic subdivision'}],
      'sync-state':[{source_key:'dcad_parcels',status:'current',row_count:'1',last_run_id:RUN,last_success_at:NOW}],
      'sync-runs':[{id:RUN,source_key:'dcad_parcels',status:'complete',mode:'full',
        started_at:'2026-09-05T11:00:00.000Z',completed_at:NOW}],
      'source-ids':[{source_record_id:'10'}],
      'transaction-identities':[transaction],
      'link-identities':[], 'legacy-identities':[], 'sale-links':[], legacy:[],
      transactions:[{...transaction,record_type:'closed_sale',sale_closing_date:'2024-03-01',
        source_close_date:'2024-03-01',sale_price:'275000',source_current_price:'275000'}],
    };
    assert.ok(Object.hasOwn(data,tag),`Unexpected SQL: ${tag}`);
    return {rows:data[tag].map(payload => ({payload:structuredClone(payload),row_bytes:Buffer.byteLength(JSON.stringify(payload))}))};
  }};
  const pool={async connect() {connects++;return client;}};
  const reader=createNeighborhoodCachedSourceReader(pool,{access:access.access,limits});
  return {client,reader,input,calls,get connects(){return connects;},get releases(){return releases;}};
}
const assertOwned=db => {
  assert.equal(db.connects,0); assert.equal(db.releases,0);
  assert.ok(db.calls.every(({tag}) => !['begin','settings','commit','rollback'].includes(tag)));
};
const assertIncomplete=(result,reason) => {
  assert.equal(result.status,'incomplete'); assert.equal(result.query_complete,false);
  assert.equal(result.source_capture,null); assert.deepEqual(result.incomplete_reasons,[reason]);
};

test('caller capture reuses existing source/query evidence, with no transaction/settings ownership',async () => {
  const normal=await fixture(), owned=await fixture();
  const original=await normal.reader.capture(normal.input);
  const current=await owned.reader.captureInSnapshot(owned.client,owned.input);
  assert.equal(current.status,'captured'); assert.equal(current.query_complete,true);
  for (const key of ['source_capture','query_evidence','selection_sha256','unsupported_capabilities']) {
    assert.deepEqual(current[key],original[key],key);
  }
  assert.deepEqual(current.snapshot,{backend_pid:state.backend_pid,snapshot:state.snapshot,transaction_started_at:state.transaction_started_at});
  assert.ok(Object.isFrozen(current.snapshot));
  assert.equal(Object.hasOwn(original,'snapshot'),false);
  assert.equal(normal.connects,1); assert.equal(normal.releases,1);
  assert.deepEqual(normal.calls.filter(({tag}) => ['begin','commit'].includes(tag)).map(({tag}) => tag),['begin','commit']);
  assert.equal(owned.calls.filter(({tag}) => tag==='caller-snapshot').length,3);
  assertOwned(owned);
});

test('caller capture requires the exact issued capabilities before any SQL and consumes them once',async () => {
  for (const change of [input=>{delete input.selection_grant;},input=>{input.market_grant={};},
    input=>{input.auth={...input.auth,userId:'another-user'};},input=>{input.account_ids=[SUBJECT,'FORGED'];}]) {
    const db=await fixture(); change(db.input);
    await assert.rejects(db.reader.captureInSnapshot(db.client,db.input),/neighborhood_cached_read_access_denied/);
    assert.equal(db.calls.length,0); assertOwned(db);
  }
  const db=await fixture();
  await db.reader.captureInSnapshot(db.client,db.input);
  const count=db.calls.length;
  await assert.rejects(db.reader.captureInSnapshot(db.client,db.input),/original_matching_grants_required/);
  assert.equal(db.calls.length,count); assertOwned(db);
  await assert.rejects(fixture({accessOptions:{authorizeMarketData:async()=>({allowed:false})}}),/market_data_access_denied/);
});

test('caller capture rejects invalid clients/options without queries',async () => {
  const db=await fixture();
  for (const client of [null,undefined,{}, {query:async()=>({rows:[]})}]) {
    await assert.rejects(db.reader.captureInSnapshot(client,db.input),/caller_client/);
  }
  for (const options of [null,[],{deadline:NaN},{deadline:'later'},{signal:{}},{authorize:true}]) {
    await assert.rejects(db.reader.captureInSnapshot(db.client,db.input,options),/snapshot_options/);
  }
  assert.equal(db.calls.length,0); assertOwned(db);
});

for (const changes of [{isolation:'read committed'},{isolation:'serializable'},{read_only:'off'},
  {explicit_transaction:false},{explicit_transaction:null},{backend_pid:0},{snapshot:'invalid'},
  {transaction_started_at:'2026-02-30T12:00:00.000000Z'}]) {
  test(`caller capture refuses transaction state ${JSON.stringify(changes)}`,async () => {
    const db=await fixture({intercept:({tag})=>tag==='caller-snapshot'?{rows:[{...state,...changes}]}:undefined});
    assertIncomplete(await db.reader.captureInSnapshot(db.client,db.input),'caller_snapshot_transaction_required');
    assert.deepEqual(db.calls.map(({tag})=>tag),['caller-snapshot']); assertOwned(db);
  });
}
for (const changes of [{timezone:'America/Chicago'},{statement_ms:0},{statement_ms:5001},
  {lock_ms:0},{lock_ms:1001},{idle_ms:0},{idle_ms:10001}]) {
  test(`caller capture refuses unbounded or incompatible settings ${JSON.stringify(changes)}`,async () => {
    const db=await fixture({intercept:({tag})=>tag==='caller-snapshot'?{rows:[{...state,...changes}]}:undefined});
    assertIncomplete(await db.reader.captureInSnapshot(db.client,db.input),'caller_snapshot_settings_required');
    assert.equal(db.calls.length,1); assertOwned(db);
  });
}

for (const probe of [2,3]) for (const changes of [{backend_pid:5678},{snapshot:'101:101:'},
  {transaction_started_at:'2026-09-05T11:59:59.123457Z'}]) {
  test(`caller capture discards bytes if probe ${probe} changes ${Object.keys(changes)[0]}`,async () => {
    let probes=0;
    const db=await fixture({intercept:({tag})=>tag==='caller-snapshot' && ++probes===probe?{rows:[{...state,...changes}]}:undefined});
    assertIncomplete(await db.reader.captureInSnapshot(db.client,db.input),'caller_snapshot_changed');
    if (probe===2) assert.equal(db.calls.length,2);
    assertOwned(db);
  });
}

test('caller capture retains closure drift detection before price reads',async () => {
  const db=await fixture({intercept:({tag})=>tag==='transaction-identities'?{rows:[{
    payload:{...transaction,source_record_hash:'c'.repeat(64)},row_bytes:250}]}:undefined});
  assertIncomplete(await db.reader.captureInSnapshot(db.client,db.input),'transaction_association_drift');
  assert.ok(!db.calls.some(({tag})=>['transactions','sale-links','legacy'].includes(tag))); assertOwned(db);
});

for (const tag of ['caller-snapshot','scope','parcels','transactions']) {
  test(`caller capture leaves SQL failure at ${tag} to its owner without leaking driver details`,async () => {
    const db=await fixture({intercept:({tag:actual})=>{if(actual===tag) throw new Error('PRIVATE DRIVER URL/SQL');}});
    const result=await db.reader.captureInSnapshot(db.client,db.input);
    assertIncomplete(result,'source_query_unavailable');
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE DRIVER/); assertOwned(db);
  });
}

test('caller capture preserves identity errors and bounded records without cleanup of owner work',async () => {
  const invalid=await fixture({intercept:({tag})=>tag==='scope'?{rows:[]}:undefined});
  await assert.rejects(invalid.reader.captureInSnapshot(invalid.client,invalid.input),/scope_mismatch/); assertOwned(invalid);
  const limited=await fixture({limits:{records:1}});
  assertIncomplete(await limited.reader.captureInSnapshot(limited.client,limited.input),'record_limit'); assertOwned(limited);
});

test('caller deadline/cancellation can stop before SQL or after a bounded in-flight query',async () => {
  for (const cancellation of [true,false]) {
    const db=await fixture(), controller=new AbortController(); controller.abort();
    const options=cancellation?{signal:controller.signal}:{deadline:performance.now()-1};
    assertIncomplete(await db.reader.captureInSnapshot(db.client,db.input,options),cancellation?'capture_cancelled':'duration_limit');
    assert.equal(db.calls.length,0); assertOwned(db);
  }
  const controller=new AbortController(); let completed=false;
  const db=await fixture({intercept:async({tag})=>{if(tag==='parcels') {
    controller.abort(); await Promise.resolve(); completed=true;
  }}});
  assertIncomplete(await db.reader.captureInSnapshot(db.client,db.input,{signal:controller.signal}),'capture_cancelled');
  assert.equal(completed,true); assert.equal(db.calls.at(-1).tag,'parcels'); assertOwned(db);
  const limited=await fixture({intercept:async({tag})=>{if(tag==='parcels') await new Promise(resolve=>setTimeout(resolve,30));}});
  assertIncomplete(await limited.reader.captureInSnapshot(limited.client,limited.input,{deadline:performance.now()+15}),'duration_limit');
  assert.ok(limited.calls.every(call=>call.query_timeout>0 && call.query_timeout<=15)); assertOwned(limited);
});
