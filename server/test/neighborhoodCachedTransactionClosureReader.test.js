import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { CACHED_TRANSACTION_IDENTITY_SQL, CACHED_TRANSACTION_IDENTITY_ORDER,
  CACHED_TRANSACTION_SNAPSHOT_SQL, resolveNeighborhoodCachedTransactionClosure } from '../src/services/neighborhoodAssessment/cachedTransactionClosureReader.js';
import { validateCachedTransactionClosure } from '../src/services/neighborhoodAssessment/cachedTransactionClosure.js';
import { consumeNeighborhoodCachedReadAccess } from '../src/services/neighborhoodAssessment/cachedReadAccess.js';
import { createTestCachedReadAccess } from './fixtures/neighborhoodCachedReadAccessFixture.js';
import { ASSESSMENT_SCOPE } from './fixtures/neighborhoodAssessmentFixture.js';

// Query-boundary doubles, not PostgreSQL/MVCC proof. Actual source SQL is shared
// with the independent reader; native composed acquisition is a separate check.
const transaction=(id,primary,sale=null,saleAccount=null)=>({source_record_id:id,sale_id:sale,
  primary_account_id:primary,sale_account_id:saleAccount,source_record_hash:null});
const link=(id,source,sequence,account,resolved=false)=>({parcel_link_id:id,source_record_id:source,
  source_position:1,parcel_sequence:sequence,account_id:account,is_resolved:resolved});
const selected=['R-001','001','r-001'];
const request=()=>({selected_account_ids:[...selected],source_revision:'trusted-test-identity-revision-v1'});
const state={isolation:'repeatable read',read_only:'on',timezone:'UTC',explicit_transaction:true,
  backend_pid:1234,snapshot:'100:100:',transaction_started_at:'2026-09-05T11:59:59.123456Z',
  statement_ms:5000,lock_ms:1000,idle_ms:10000};
const compareId=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
const compareLink=(a,b)=>compareId(a.source_record_id,b.source_record_id)
  || a.source_position-b.source_position || a.parcel_sequence-b.parcel_sequence;
const encoded=payload=>({payload:structuredClone(payload),row_bytes:Buffer.byteLength(JSON.stringify(payload))});
function fixture({intercept,empty=false}={}) {
  const data=empty?{transactions:[],links:[],legacy:[]}:{
    transactions:[transaction('9','R-001','9007199254740993','OTHER'),transaction('10','OUTSIDE'),
      transaction('11','OUTSIDE','51','r-001'),transaction('12','UNRELATED'),transaction('13','SECONDARY'),
      transaction('9223372036854775807','001')],
    links:[link('91','9',1,null,null),link('92','9',2,'SECONDARY',false),link('93','9',3,'OTHER',true),
      link('101','10',1,'001',false),link('102','10',2,'ANOTHER',null),link('131','13',1,'RECURSIVE')],
    legacy:[{sale_id:'100',sale_account_id:'R-001'},{sale_id:'101',sale_account_id:'SECONDARY'},
      {sale_id:'9007199254740994',sale_account_id:'001'},{sale_id:'9223372036854775806',sale_account_id:'r-001'}],
  };
  const calls=[];let releases=0;
  const client={release(){releases++;},async query(config){
    const tag=config.text.match(/neighborhood-closure:([\w-]+)/)?.[1];
    assert.ok(tag,'Unexpected lifecycle or unrelated SQL');calls.push({tag,...config});
    const replacement=await intercept?.({tag,config,calls,data});
    if(replacement!==undefined)return replacement;
    if(tag==='snapshot')return {rows:[structuredClone(state)]};
    const values=config.values;let records;
    if(tag==='source-ids') {
      const seeds=new Set(data.transactions.filter(row=>values[0].includes(row.primary_account_id)
        || values[0].includes(row.sale_account_id)).map(row=>row.source_record_id));
      for(const row of data.links)if(values[0].includes(row.account_id))seeds.add(row.source_record_id);
      records=[...seeds].filter(id=>compareId(id,values[1])>0).sort(compareId).map(source_record_id=>({source_record_id}));
    } else if(tag==='transaction-identities') {
      records=data.transactions.filter(row=>values[0].includes(row.source_record_id)).toSorted((a,b)=>compareId(a.source_record_id,b.source_record_id));
    } else if(tag==='link-identities') {
      records=data.links.filter(row=>values[0].includes(row.source_record_id)
        && compareLink(row,{source_record_id:values[1],source_position:values[2],parcel_sequence:values[3]})>0).toSorted(compareLink);
    } else if(tag==='legacy-identities') {
      records=data.legacy.filter(row=>values[0].includes(row.sale_account_id)&&compareId(row.sale_id,values[1])>0).toSorted((a,b)=>compareId(a.sale_id,b.sale_id));
    } else assert.fail('Unexpected SQL role');
    return {rows:records.slice(0,values.at(-1)).map(encoded)};
  }};
  return {client,calls,data,get releases(){return releases;}};
}
const run=(db,input=request(),options={})=>resolveNeighborhoodCachedTransactionClosure(db.client,input,options);
const owned=db=>{
  assert.equal(db.releases,0);
  assert.ok(db.calls.every(call=>['snapshot','source-ids','transaction-identities','link-identities','legacy-identities'].includes(call.tag)));
};
function incomplete(result,reason) {
  assert.equal(result.status,'incomplete');assert.equal(result.query_complete,false);
  assert.equal(result.reason,reason);assert.equal(result.authority,'not_established');
  assert.equal(result.transaction_closure,null);assert.equal(result.closure_sha256,null);assert.equal(result.snapshot,null);
  assert.throws(()=>validateCachedTransactionClosure(result));
}

test('shared identity SQL retains every discovery arm and excludes date, resolution and multi-field fact filters',()=>{
  assert.deepEqual(Object.keys(CACHED_TRANSACTION_IDENTITY_SQL),['source_ids','transaction_identities','link_identities','legacy_identities']);
  const sql=Object.values(CACHED_TRANSACTION_IDENTITY_SQL).join('\n');
  assert.equal((CACHED_TRANSACTION_IDENTITY_SQL.source_ids.match(/UNION/g)||[]).length,2);
  for(const fragment of ['core.sales_source_records WHERE primary_account_id=ANY($1::text[])',
    'core.sale_parcels WHERE account_id=ANY($1::text[])','core.sales WHERE account_id=ANY($1::text[])'])assert.ok(sql.includes(fragment));
  assert.doesNotMatch(sql,/close_date|closing_date|record_type|price|area|year_built|remarks|raw_payload|county|TRIM|UPPER|LOWER|is_resolved\s*=/i);
  assert.match(CACHED_TRANSACTION_IDENTITY_SQL.link_identities,/WHERE source_record_id=ANY\(\$1::bigint\[\]\)/);
  assert.match(CACHED_TRANSACTION_IDENTITY_SQL.legacy_identities,/source_record_id IS NULL/);
  const reader=readFileSync(new URL('../src/services/neighborhoodAssessment/cachedSourceReader.js',import.meta.url),'utf8');
  for(const text of ['...CACHED_TRANSACTION_IDENTITY_SQL','...CACHED_TRANSACTION_IDENTITY_ORDER','CACHED_TRANSACTION_SNAPSHOT_SQL as SNAPSHOT_SQL'])assert.ok(reader.includes(text));
  assert.equal(Object.keys(CACHED_TRANSACTION_IDENTITY_ORDER).length,4);
  assert.match(CACHED_TRANSACTION_SNAPSHOT_SQL,/transaction_timestamp\(\) < statement_timestamp\(\)/);
});

test('complete one-hop closure preserves null/unresolved package links, exact bigint IDs and original stock',async()=>{
  const db=fixture(),result=await run(db,request(),{limits:{page_size:1}});
  assert.equal(result.status,'captured',result.reason);assert.equal(result.query_complete,true);assert.equal(result.authority,'not_established');
  assert.deepEqual(result.snapshot,Object.fromEntries(['backend_pid','snapshot','transaction_started_at'].map(key=>[key,state[key]])));
  const closure=result.transaction_closure;
  assert.deepEqual(Object.keys(closure).sort(),['legacy','links','selected_account_ids','source_revision','transactions']);
  assert.deepEqual(closure.selected_account_ids,['001','R-001','r-001']);
  assert.deepEqual(closure.transactions.map(row=>row.source_record_id),['9','10','11','9223372036854775807']);
  assert.deepEqual(closure.links.map(row=>row.parcel_link_id),['91','92','93','101','102']);
  assert.deepEqual(closure.links.map(row=>row.is_resolved),[null,false,true,false,null]);
  assert.deepEqual(closure.legacy.map(row=>row.sale_id),['100','9007199254740994','9223372036854775806']);
  assert.equal(closure.transactions[0].sale_id,'9007199254740993');assert.equal(closure.transactions.at(-1).sale_id,null);
  const validated=validateCachedTransactionClosure(closure);
  assert.equal(result.closure_sha256,validated.closure_sha256);
  assert.ok(validated.closure_account_ids.includes('SECONDARY'));assert.ok(!validated.closure_account_ids.includes('RECURSIVE'));
  assert.equal(result.counts.identity_records,12);assert.equal(result.counts.source_records,4);
  assert.equal(result.counts.accounts,validated.closure_account_ids.length);
  assert.equal(db.calls.filter(call=>call.tag==='snapshot').length,3);
  for(const call of db.calls.filter(call=>['source-ids','legacy-identities'].includes(call.tag)))assert.deepEqual(call.values[0],['001','R-001','r-001']);
  assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(closure.transactions[0]));
  assert.equal(Object.hasOwn(result,'committed'),false);owned(db);
});

test('input surrounding-space alias normalizes without changing case, prefixes, punctuation or leading zeroes',async()=>{
  const db=fixture(),input=request();input.selected_account_ids=[' R-001 ','001','r-001'];
  const result=await run(db,input);assert.equal(result.status,'captured');
  assert.deepEqual(result.transaction_closure.selected_account_ids,['001','R-001','r-001']);
  for(const call of db.calls.filter(call=>call.tag==='source-ids'))assert.deepEqual(call.values[0],['001','R-001','r-001']);
  assert.deepEqual(input.selected_account_ids,[' R-001 ','001','r-001']);owned(db);
});

test('present empty source relations yield an empty closure, not fabricated historical/market facts',async()=>{
  const db=fixture({empty:true}),result=await run(db);assert.equal(result.status,'captured');
  assert.equal(result.counts.identity_records,0);
  assert.deepEqual(result.transaction_closure,{...request(),selected_account_ids:['001','R-001','r-001'],transactions:[],links:[],legacy:[]});owned(db);
});

test('real access preparation accepts the explicitly unwrapped five fields, never the wrapper or derived manifest',async()=>{
  const db=fixture(),trusted={scope:{...ASSESSMENT_SCOPE,account_id:'R-001'},account_ids:selected,
    effective_date:'2024-06-30',observation_period:{start_date:'2023-07-01',end_date:'2024-06-30'}};
  let captured;
  const access=createTestCachedReadAccess(trusted,{resolveTransactionClosure:async()=>{
    captured=await run(db);assert.equal(captured.status,'captured');return captured.transaction_closure;
  }});
  const prepared=await access.prepare();
  assert.deepEqual(prepared.request.transaction_closure,validateCachedTransactionClosure(captured.transaction_closure));
  assert.throws(()=>validateCachedTransactionClosure(captured));
  assert.throws(()=>validateCachedTransactionClosure(prepared.request.transaction_closure));
  assert.deepEqual(consumeNeighborhoodCachedReadAccess(access.access,access.auth,prepared.request,{
    selection_grant:prepared.selection_grant,market_grant:prepared.market_grant}),prepared.request);owned(db);
});

test('input is copied before first await and cancellation uses the original signal',async()=>{
  const input=request(),controller=new AbortController(),options={signal:controller.signal};let changed=false;
  const db=fixture({intercept:({tag})=>{if(tag==='snapshot'&&!changed){
    changed=true;input.selected_account_ids[0]='MUTATED';input.source_revision='MUTATED';options.signal=new AbortController().signal;
  }}});
  const result=await run(db,input,options);assert.equal(result.status,'captured');assert.doesNotMatch(JSON.stringify(result),/MUTATED/);owned(db);
  const cancelled=fixture({intercept:({tag})=>{if(tag==='source-ids'){options.signal=new AbortController().signal;controller.abort();}}});
  options.signal=controller.signal;incomplete(await run(cancelled,request(),options),'capture_cancelled');owned(cancelled);
});

test('invalid clients, shapes, identities and caps reject before any SQL',async()=>{
  const db=fixture();
  for(const client of [null,{}, {query:async()=>({rows:[]})}])await assert.rejects(resolveNeighborhoodCachedTransactionClosure(client,request()),/caller_client/);
  for(const input of [null,[],{...request(),authority:true},{...request(),selected_account_ids:[]},
    {...request(),selected_account_ids:['R-001',' R-001 ']},{...request(),selected_account_ids:[1]},
    {...request(),selected_account_ids:['R-001\n']},{...request(),source_revision:''}])await assert.rejects(run(db,input));
  for(const options of [null,[],{unknown:true},{deadline:'soon'},{deadline:NaN},{signal:{}},{limits:null},
    {limits:{page_size:0}},{limits:{queries:10001}},{limits:{accounts:50001}},{limits:{bytes:8000001}},{limits:{unknown:1}}])await assert.rejects(run(db,request(),options));
  const accessor=request();Object.defineProperty(accessor,'source_revision',{get(){assert.fail('getter executed');}});
  await assert.rejects(run(db,accessor));assert.equal(db.calls.length,0);owned(db);
});

for(const changes of [{isolation:'read committed'},{read_only:'off'},{explicit_transaction:false},{backend_pid:0},
  {snapshot:'invalid'},{transaction_started_at:'2026-02-30T01:00:00.000000Z'}])test('refuses caller transaction '+JSON.stringify(changes),async()=>{
  const db=fixture({intercept:({tag})=>tag==='snapshot'?{rows:[{...state,...changes}]}:undefined});
  incomplete(await run(db),'caller_snapshot_transaction_required');assert.equal(db.calls.length,1);owned(db);
});
for(const changes of [{timezone:'America/Chicago'},{statement_ms:0},{statement_ms:5001},{lock_ms:0},{lock_ms:1001},{idle_ms:0},{idle_ms:10001}])test('refuses unsafe settings '+JSON.stringify(changes),async()=>{
  const db=fixture({intercept:({tag})=>tag==='snapshot'?{rows:[{...state,...changes}]}:undefined});
  incomplete(await run(db),'caller_snapshot_settings_required');assert.equal(db.calls.length,1);owned(db);
});
for(const probe of [2,3])for(const changes of [{backend_pid:5678},{snapshot:'101:101:'},{transaction_started_at:'2026-09-05T11:59:59.123457Z'}])test('probe '+probe+' drift '+Object.keys(changes)[0],async()=>{
  let probes=0;const db=fixture({intercept:({tag})=>tag==='snapshot'&&++probes===probe?{rows:[{...state,...changes}]}:undefined});
  incomplete(await run(db),'caller_snapshot_changed');if(probe===2)assert.equal(db.calls.length,2);owned(db);
});
for(const tag of ['snapshot','source-ids','transaction-identities','link-identities','legacy-identities'])test('SQL failure at '+tag+' leaks no partial closure or driver details',async()=>{
  const db=fixture({intercept:({tag:actual})=>{if(tag===actual)throw Object.assign(new Error('PRIVATE CONNECTION/SQL'),{code:'42P01'});}});
  const result=await run(db);incomplete(result,'source_query_unavailable');assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);owned(db);
});

test('missing and duplicate canonical source/sale identities fail without dropping or preferring one',async()=>{
  for(const duplicate of [false,true]){
    const db=fixture({intercept:({tag,data})=>{if(tag==='transaction-identities'){
      if(duplicate)data.transactions.push(transaction('9','R-001','9007199254740995','OTHER'));
      else data.transactions=data.transactions.filter(row=>row.source_record_id!=='10');
    }}});
    incomplete(await run(db),duplicate?'duplicate_source_identity':'source_identity_missing');owned(db);
  }
});

test('account union, identity, byte and query caps yield no partial result',async()=>{
  for(const [limits,reason]of [[{accounts:3},'account_limit'],[{identity_records:3},'identity_limit'],[{bytes:1300},'byte_limit'],[{queries:2},'query_limit']]){
    const db=fixture();incomplete(await run(db,request(),{limits}),reason);owned(db);
  }
  const db=fixture({intercept:({tag})=>tag==='source-ids'?{rows:[{payload:null,row_bytes:2049}]}:undefined});
  incomplete(await run(db),'row_bytes_limit');owned(db);
});

test('invalid source/link/legacy pages and closure contradictions remain fail-closed',async()=>{
  const cases=[
    ['source-ids',{rows:[encoded({source_record_id:'9'}),encoded({source_record_id:'9'})]},'nonadvancing_source_cursor'],
    ['source-ids',{rows:[encoded({source_record_id:'9223372036854775808'})]},'invalid_source_identity'],
    ['source-ids',{rows:Array.from({length:252},()=>encoded({source_record_id:'9'}))},'database_page_invalid'],
    ['source-ids',{rows:null},'database_result_invalid'],
    ['link-identities',{rows:[encoded(link('1','9',1,'X')),encoded(link('2','9',1,'Y'))]},'nonadvancing_link_cursor'],
    ['link-identities',{rows:[encoded(link('1','12',1,'X'))]},'unrequested_source_identity'],
    ['link-identities',{rows:[encoded(link('1','9',0,'X'))]},'invalid_link_position'],
    ['legacy-identities',{rows:[encoded({sale_id:'100',sale_account_id:'R-001'}),encoded({sale_id:'100',sale_account_id:'001'})]},'nonadvancing_legacy_cursor'],
    ['legacy-identities',{rows:[encoded({sale_id:'100',sale_account_id:'SECONDARY'})]},'identity_closure_invalid'],
    ['legacy-identities',{rows:[encoded({sale_id:'100',sale_account_id:123})]},'invalid_account_identity'],
  ];
  for(const [tag,replacement,reason]of cases){
    const db=fixture({intercept:({tag:actual})=>actual===tag?replacement:undefined});incomplete(await run(db),reason);owned(db);
  }
});

test('shared monotonic deadline/cancellation stop before SQL or after a bounded in-flight query',async()=>{
  const controller=new AbortController();controller.abort();
  for(const [options,reason]of [[{signal:controller.signal},'capture_cancelled'],[{deadline:performance.now()-1},'duration_limit']]){
    const db=fixture();incomplete(await run(db,request(),options),reason);assert.equal(db.calls.length,0);owned(db);
  }
  const db=fixture({intercept:async({tag})=>{if(tag==='source-ids')await new Promise(resolve=>setTimeout(resolve,30));}});
  incomplete(await run(db,request(),{deadline:performance.now()+15}),'duration_limit');
  assert.ok(db.calls.every(call=>call.query_timeout>0&&call.query_timeout<=15));owned(db);
});

