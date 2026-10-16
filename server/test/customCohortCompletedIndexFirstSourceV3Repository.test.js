import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortCompletedIndexFirstSourceV3Repository as create } from '../src/services/neighborhoodAssessment/customCohortCompletedIndexFirstSourceV3Repository.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
  keys=['union_reference','eligibility_reference','evidence_reference','metrics_reference','statistics_reference','numeric_reference','semantic_reference'],
  expected={command_id:id(1),...Object.fromEntries(keys.map((k,i)=>[k,ref(i+1)])),generation_id:id(2),selected_stock_count:2},
  receipt={format:'cohort_selected_transaction_index_receipt_v2',...expected,sequence:3,previous:ref(8),
    before:{selected_ordinal:2,source_record_keys:3,legacy_sale_keys:2,done:false},
    after:{selected_ordinal:2,source_record_keys:3,legacy_sale_keys:2,done:true},selected_entry:null,
    association_anchor_count:0,source_package_count:0,legacy_package_count:0,new_source_record_keys:0,new_legacy_sale_keys:0},
  first={transaction_id:'101',head_reference:ref(9),head_sequence:3,receipt,expected,kind:'source_record',native_key:'501',first_selected_ordinal:1,
    selected_entry:{account_id:'A',ordinal:1,partition_ordinal:1,entry_reference:ref(1),metric_row_reference:ref(2),contribution_row_reference:ref(3)},bindings_match:true},
  claim={operation_id:id(3),claim_token:id(4),attempts:5},scope={organization_id:id(5),report_file_id:id(6),assignment_file_id:'7',account_id:'SUBJECT'},
  copy=v=>structuredClone(v),result=rows=>({rowCount:rows.length,rows});
// Small protocol simulation only; actual PostgreSQL admission is independently
// exercised after the original-reconciled graph in the native helper.
function fixture(packets=[copy(first)],options={}){
  const queries=[];let reads=0;
  const client={async query(sql,values){queries.push({sql,values});
    if(sql.includes(':transaction */'))return result([{transaction_id:'101'}]);
    const packet=packets[Math.min(reads++,packets.length-1)];return options.raw??result([packet]);
  }};
  const input={client,claim,scope,actorUserId:id(7)};return {repo:create(input),queries,input};
}

test('FIRST is one registered source and its real first-seen account after complete native index, with explicit missing source authority',async()=>{
  const {repo,queries}=fixture(),a=await repo.readFirst();assert.deepEqual(a.source,{kind:'source_record',native_key:'501',first_selected_ordinal:1});
  assert.deepEqual(a.selected_entry,first.selected_entry);assert.equal(a.index_sequence,3);assert.equal(a.registered_source_keys,3);assert.equal(a.registered_legacy_keys,2);
  assert.equal(a.read_only,true);for(const key of ['originals_reconciled','source_authority','economic_transaction'])assert.equal(a[key],false);
  assert.ok(Object.isFrozen(a)&&Object.isFrozen(a.source)&&Object.isFrozen(a.selected_entry.entry_reference));assert.ok(Buffer.byteLength(JSON.stringify(a))<=4096);
  assert.deepEqual(await repo.readFirst(),a);assert.equal(queries.length,3);
  for(const {sql,values} of queries.slice(1)){
    assert.deepEqual(values,[claim.operation_id,claim.claim_token,5,scope.organization_id,scope.report_file_id,'7','SUBJECT',id(7)]);
    assert.match(sql,/FOR UPDATE OF job NOWAIT/);assert.match(sql,/neighborhood_selected_transaction_index_v2_checkpoint_matches/);
    assert.match(sql,/ORDER BY source_record_id LIMIT 1/);assert.match(sql,/ORDER BY legacy_sale_key COLLATE "C" LIMIT 1/);
    assert.match(sql,/edge\.kind=k\.kind AND edge\.native_key=k\.native_key/);assert.match(sql,/retirement_started_at IS NULL/);
    assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE\s+app\.|DELETE|array_agg|jsonb_agg|OFFSET)\b/i);
  }
});

test('legacy-only index retains C-text native key and its actual later first-seen account',async()=>{
  const row=copy(first);row.kind='legacy_sale';row.native_key='10';row.first_selected_ordinal=2;
  row.selected_entry.account_id='B';row.selected_entry.ordinal=2;row.receipt.before.source_record_keys=0;row.receipt.after.source_record_keys=0;
  const p=await fixture([row]).repo.readFirst();assert.equal(p.source.native_key,'10');assert.equal(p.selected_entry.ordinal,2);
});

test('no registered packages is distinct from an empty selected stock and requires both global namespaces empty',async()=>{
  const row=copy(first);for(const k of ['kind','native_key','first_selected_ordinal','selected_entry'])row[k]=null;
  for(const state of [row.receipt.before,row.receipt.after]){state.source_record_keys=0;state.legacy_sale_keys=0;}
  const plan=await fixture([row]).repo.readFirst();assert.equal(plan.source,null);assert.equal(plan.selected_entry,null);assert.equal(plan.selected_stock_count,2);
  const empty=copy(row);empty.receipt.selected_stock_count=0;empty.expected.selected_stock_count=0;empty.head_sequence=1;empty.receipt.sequence=1;empty.receipt.previous=null;
  empty.receipt.before.selected_ordinal=0;empty.receipt.after.selected_ordinal=0;assert.equal((await fixture([empty]).repo.readFirst()).selected_stock_count,0);
});

test('unfinished, mismatched, missing or changed native identity refuses rather than becoming an economic source',async()=>{
  const mutations=[r=>r.bindings_match=false,r=>r.transaction_id='102',r=>r.receipt.after.done=false,r=>r.head_sequence=2,
    r=>r.receipt.generation_id=id(10),r=>r.native_key='0',r=>r.native_key='9223372036854775808',r=>r.kind='legacy_sale',
    r=>r.first_selected_ordinal=3,r=>r.selected_entry.ordinal=2,r=>r.selected_entry.account_id=' A',r=>r.selected_entry.entry_reference.canonical_utf8_bytes='1000001',
    r=>{r.kind=null;r.native_key=null;r.first_selected_ordinal=null;r.selected_entry=null;},r=>r.extra=true];
  for(const mutate of mutations){const row=copy(first);mutate(row);await assert.rejects(fixture([row]).repo.readFirst());}
  for(const raw of [result([]),result([copy(first),copy(first)]),{rowCount:1,rows:[]}])await assert.rejects(fixture([first],{raw}).repo.readFirst());
  const changed=copy(first);changed.native_key='503';const {repo}=fixture([copy(first),changed]);await repo.readFirst();await assert.rejects(repo.readFirst(),/native_plan_changed/);
});

test('closed no-cursor API refuses aliases, extra arguments and executable properties before native IO',async()=>{
  const {repo,queries,input}=fixture();await assert.rejects(repo.readFirst({native_key:'501'}),/invalid_input/);assert.equal(queries.length,0);
  assert.throws(()=>create(input,{}),/invalid_input/);assert.throws(()=>create({...input,cursor:'501'}),/invalid_input/);
  let invoked=false;const executable={...input};Object.defineProperty(executable,'scope',{enumerable:true,get(){invoked=true;throw Error('getter');}});
  assert.throws(()=>create(executable),/invalid_input/);assert.equal(invoked,false);assert.throws(()=>create(new Proxy(input,{})),/invalid_input/);
  assert.throws(()=>create({...input,scope:{...scope,assignment_file_id:'9223372036854775808'}}),/invalid_scope/);
});
