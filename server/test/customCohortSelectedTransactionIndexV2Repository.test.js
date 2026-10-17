import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SELECTED_TRANSACTION_INDEX_V2_PARENT_KEYS as REFS } from '../src/services/neighborhoodAssessment/cohortSelectedTransactionIndexFirstCandidateV2.js';
import { createCustomCohortSelectedTransactionIndexV2Repository as create } from '../src/services/neighborhoodAssessment/customCohortSelectedTransactionIndexV2Repository.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,
  ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
  roots=Object.fromEntries(REFS.map((k,i)=>[k,ref(i+1)])),receipt=ref(9),
  zero={selected_ordinal:0,source_record_keys:0,legacy_sale_keys:0,done:false},
  member={account_id:'A',ordinal:1,partition_ordinal:1,entry_reference:ref(1),metric_row_reference:ref(2),contribution_row_reference:ref(3)},
  nullMember=Object.fromEntries(Object.keys(member).map(k=>[k,null])),
  originalMember={account_id:'A',ordinal:1,partition_ordinal:1,entry_reference:ref(1),state:'unassigned',assigned_group_id:null,
    row_reference:ref(2),contribution_row_reference:ref(3),numeric_index_ordinal:1,reported_year_built:'2001',
    reported_residential_area:'1500.25',reported_site_area:null,numeric_population_ordinal:1,semantic_population_ordinal:1},
  first={transaction_id:'100',generation_id:id(1),...member,anchor_count:2,kind:'source_record',native_key:'501',
    first_selected_ordinal:null,registry_matches:true,selected_stock_count:2,before:zero,head_receipt_reference:null,head_sequence:null,
    original_member:originalMember},
  scope={organization_id:id(2),report_file_id:id(3),assignment_file_id:'7',account_id:'SUBJECT'},
  claim={operation_id:id(4),claim_token:id(5),attempts:4};
const copy=v=>structuredClone(v),result=rows=>({rowCount:rows.length,rows});

// Small native-protocol simulation ONLY. No PostgreSQL, licensed originals,
// source authorization or production-speed acceptance is implied by this fake.
function fixture(rows=[copy(first)],changes={}){
  const queries=[];let reads=0;const packets=changes.packets??[rows];
  const client={async query(sql,values=[]){
    const tag=sql.match(/custom-cohort-selected-transaction-index-v2:([^ ]+) /)?.[1];
    assert.ok(tag,sql);queries.push({tag,sql,values});
    if(tag==='transaction')return result([{transaction_id:changes.started??'100'}]);
    if(tag==='native-plan'){const r=packets[Math.min(reads++,packets.length-1)];return changes.rawResult??result(r);}
    const p=packets.at(-1),header=p[0],packages=p.filter(r=>r.kind!==null),
      count=tag==='member-insert'?(header.account_id===null?0:1):tag==='edge-insert'?packages.length
        :tag==='source_record-insert'?packages.filter(r=>r.kind==='source_record'&&r.first_selected_ordinal===null).length
        :tag==='legacy_sale-insert'?packages.filter(r=>r.kind==='legacy_sale'&&r.first_selected_ordinal===null).length:null;
    if(count!==null)return {rowCount:changes.badDelta===tag?count+1:count,rows:[]};
    const sequence=header.before.selected_ordinal+1;
    if(tag==='head-insert'||tag==='head-advance')return result([{sequence}]);
    if(tag==='head-readback')return result([{transaction_id:changes.ending??'100',receipt_reference:changes.endingReceipt??receipt,
      sequence:changes.endingSequence??sequence,generation_id:changes.endingGeneration??header.generation_id,
      binding_matches:changes.endingBinding??true}]);
    assert.fail(tag);
  }};
  const options={client,claim,scope,actorUserId:id(6),command_id:id(7),...roots};
  return {repo:create(options),queries,options};
}
const mutations=q=>q.filter(v=>/-insert$|head-advance$/.test(v.tag));
function secondRows(){
  const header={...first,account_id:'B',ordinal:2,partition_ordinal:2,anchor_count:5,
    original_member:{...originalMember,account_id:'B',ordinal:2,partition_ordinal:2,numeric_index_ordinal:2,
      numeric_population_ordinal:2,semantic_population_ordinal:2},
    before:{selected_ordinal:1,source_record_keys:1,legacy_sale_keys:0,done:false},head_sequence:1,head_receipt_reference:ref(8)};
  return [...['501','503','504'].map(native_key=>({...copy(header),kind:'source_record',native_key,first_selected_ordinal:native_key==='501'?1:null})),
    ...['10','3'].map(native_key=>({...copy(header),kind:'legacy_sale',native_key,first_selected_ordinal:null}))];
}

test('bounded first account derives every write from native NEXT and rechecks the observed plan before any DML',async()=>{
  const {repo,queries}=fixture(),packet=await repo.readNext();
  assert.equal(packet.previous,null);assert.deepEqual(packet.plan.native_packages,[{kind:'source_record',native_key:'501',first_selected_ordinal:null}]);
  assert.ok(Object.isFrozen(packet)&&Object.isFrozen(packet.plan.native_packages));
  const {semantic_population_ordinal,...entry}=originalMember;
  assert.deepEqual(packet.selected_entry,entry);assert.ok(Object.isFrozen(packet.selected_entry)&&Object.isFrozen(packet.selected_entry.row_reference));
  assert.deepEqual(await repo.advance(receipt),{receipt_reference:receipt,sequence:1,generation_id:id(1)});
  assert.deepEqual(queries.map(q=>q.tag),['transaction','native-plan','native-plan','member-insert','source_record-insert',
    'legacy_sale-insert','edge-insert','head-insert','head-readback']);
  for(const q of queries.filter(q=>q.tag!=='transaction')){
    assert.deepEqual(q.values.slice(0,9),[claim.operation_id,claim.claim_token,4,scope.organization_id,scope.report_file_id,'7','SUBJECT',id(6),id(7)]);
    assert.deepEqual(q.values.slice(9,16).map(v=>JSON.parse(v)),REFS.map(k=>roots[k]));
  }
  for(const q of mutations(queries)){
    assert.match(q.sql,/bound_context AS MATERIALIZED/);assert.match(q.sql,/FOR UPDATE OF job NOWAIT/);
    assert.match(q.sql,/neighborhood_selected_transaction_index_v2_admission_matches/);
    assert.doesNotMatch(q.sql,/VALUES\s*\(|jsonb_to_recordset|unnest\(|array_agg|jsonb_agg/);
  }
  assert.match(queries.find(q=>q.tag==='head-insert').sql,/1,txid_current\(\)/);
  await assert.rejects(()=>repo.readNext(),/already_advanced/);await assert.rejects(()=>repo.advance(receipt),/already_advanced/);
});

test('next account keeps the shared source in the full plan and all edges while only new keys are inserted; old first-seen ordinals are never overwritten',async()=>{
  const {repo,queries}=fixture(secondRows()),packet=await repo.readNext();
  assert.deepEqual(packet.plan.native_packages.map(p=>[p.kind,p.native_key,p.first_selected_ordinal]),[
    ['source_record','501',1],['source_record','503',null],['source_record','504',null],['legacy_sale','10',null],['legacy_sale','3',null]]);
  const issued=await repo.advance(receipt);assert.equal(issued.sequence,2);
  assert.match(queries.find(q=>q.tag==='source_record-insert').sql,/ON CONFLICT\(operation_id,source_record_id\) DO NOTHING/);
  assert.match(queries.find(q=>q.tag==='legacy_sale-insert').sql,/ON CONFLICT\(operation_id,legacy_sale_key\) DO NOTHING/);
  assert.doesNotMatch(queries.find(q=>q.tag==='edge-insert').sql,/ON CONFLICT|NOT EXISTS[^\n]*source_v2_keys/);
  const update=queries.find(q=>q.tag==='head-advance');
  assert.deepEqual(JSON.parse(update.values[17]),ref(8));assert.equal(update.values[18],1);
  assert.match(update.sql,/sequence=h.sequence\+1,issued_transaction_id=txid_current\(\)/);
  assert.match(update.sql,/h.receipt_reference=\$18::jsonb AND h.sequence=\$19::integer/);
  assert.doesNotMatch(update.sql,/SET\s+(?:attempts|context_sha256|status)\s*=/);
});

test('a separate fresh EMPTY retains the native issued prefix, including a maximum 500m-key prefix, and inserts no member/keys/edges',async()=>{
  for(const count of [0,2,2000000]){
    const before=count===0?zero:{selected_ordinal:count,source_record_keys:count*250,legacy_sale_keys:0,done:false},
      row={...copy(first),...nullMember,selected_stock_count:count,before,anchor_count:0,kind:null,native_key:null,first_selected_ordinal:null,
        original_member:null,
        head_sequence:count===0?null:count,head_receipt_reference:count===0?null:ref(8)},
      {repo,queries}=fixture([row]),packet=await repo.readNext();
    assert.equal(packet.plan.selected_entry,null);assert.equal(packet.selected_entry,null);assert.deepEqual(packet.plan.native_packages,[]);
    assert.equal((await repo.advance(receipt)).sequence,count+1);
    assert.equal(queries.filter(q=>q.tag==='native-plan').length,2);
    assert.equal(mutations(queries).length,5,'four zero-child statements plus one issued head, no hidden terminal population scan');
    assert.ok(!queries.some(q=>/count\(\*\)[^\n]*selected_transaction/.test(q.sql)));
  }
});

test('autocommit/different native transaction and a changed ending plan are refused before the first DML',async()=>{
  const badTx=fixture([{...copy(first),transaction_id:'101'}]);
  await assert.rejects(()=>badTx.repo.readNext(),/caller_transaction_required/);assert.equal(mutations(badTx.queries).length,0);
  for(const patch of [{generation_id:id(8)},{anchor_count:3},{native_key:'502'},
    {entry_reference:ref(4)},{metric_row_reference:ref(4)},{contribution_row_reference:ref(4)}]){
    const ending={...copy(first),...patch};
    for(const [key,fullKey] of [['entry_reference','entry_reference'],['metric_row_reference','row_reference'],['contribution_row_reference','contribution_row_reference']])
      if(patch[key])ending.original_member[fullKey]=patch[key];
    const f=fixture(undefined,{packets:[[copy(first)],[ending]]});
    await f.repo.readNext();await assert.rejects(()=>f.repo.advance(receipt),/native_plan_changed/);assert.equal(mutations(f.queries).length,0);
  }
  const newTx=fixture(undefined,{packets:[[copy(first)],[{...copy(first),transaction_id:'101'}]]});
  await newTx.repo.readNext();await assert.rejects(()=>newTx.repo.advance(receipt),/caller_transaction_required/);assert.equal(mutations(newTx.queries).length,0);
});

test('native registry namespaces, numeric versus C-text ordering, generation/first-seen bindings and bounded header agreement are independently closed',async()=>{
  const s=secondRows(),cases=[
    [{...copy(first),registry_matches:false}],[{...copy(first),first_selected_ordinal:1}],
    [{...copy(first),head_sequence:1}],[{...copy(first),head_receipt_reference:ref(8)}],
    [{...copy(first),anchor_count:251}],[{...copy(first),native_key:'9223372036854775808'}],
    [{...copy(first),...nullMember}],s.map((r,i)=>i===1?{...r,head_receipt_reference:ref(9)}:r),
    s.map((r,i)=>i===1?{...r,first_selected_ordinal:2}:r),[s[1],s[0],...s.slice(2)],
    [...s.slice(0,3),s[4],s[3]],[s[3],...s.slice(0,3),s[4]],
    [{...copy(first),kind:null,native_key:null,first_selected_ordinal:null}],
    [{...copy(first),before:{...zero,source_record_keys:1}}]
  ];
  for(const rows of cases){const f=fixture(rows);await assert.rejects(()=>f.repo.readNext());assert.equal(mutations(f.queries).length,0);}
  const numeric=[...['2','10','9007199254740993','9223372036854775807'].map(native_key=>({...copy(first),anchor_count:6,native_key})),
    ...['10','2'].map(native_key=>({...copy(first),anchor_count:6,kind:'legacy_sale',native_key}))];
  assert.equal((await fixture(numeric).repo.readNext()).plan.native_packages.length,6);
  const q=fixture(s);await q.repo.readNext();const native=q.queries.find(v=>v.tag==='native-plan').sql;
  assert.match(native,/sr.operation_id=c.operation_id/);assert.match(native,/ls.operation_id=c.operation_id/);
  assert.match(native,/sr.organization_id=c.organization_id AND sr.generation_id=k.generation_id/);
  assert.match(native,/ls.organization_id=c.organization_id AND ls.generation_id=k.generation_id/);
  assert.doesNotMatch(native,/WHERE[^\n]*first_selected_ordinal|NOT EXISTS[^\n]*source_v2_keys/,'a shared package is never omitted');
});

test('overflow, sparse, proxy, accessor, extra-field and nested hostile rows fail without executing DATA or issuing DML',async()=>{
  const hostile=()=>assert.fail('hostile DATA must not execute'),a=[copy(first)];Object.defineProperty(a,'0',{enumerable:true,get:hostile});
  const cases=[{rowCount:251,rows:Array(251)},{rowCount:1,rows:Array(1)},{rowCount:1,rows:new Proxy([copy(first)],{get:hostile})},
    {rowCount:1,rows:a},result([new Proxy(first,{get:hostile})]),result([{...copy(first),extra:true}]),
    result([{...copy(first),before:{...zero,get done(){hostile();}}}]),
    result([{...copy(first),entry_reference:{...ref(1),toJSON:hostile}}]),
    result([{...copy(first),head_receipt_reference:{...ref(8),get content_sha256(){hostile();}}}])];
  for(const rawResult of cases){const f=fixture(undefined,{rawResult});await assert.rejects(()=>f.repo.readNext());assert.equal(mutations(f.queries).length,0);}
});

test('native NEXT exposes the closed retained member needed by the whole original owner, never a first-member projection or extra population query',async()=>{
  const f=fixture(secondRows()),packet=await f.repo.readNext();
  assert.equal(packet.selected_entry.account_id,'B');assert.equal(packet.selected_entry.ordinal,2);
  assert.equal(packet.selected_entry.numeric_population_ordinal,2);assert.equal(packet.selected_entry.numeric_index_ordinal,2);
  assert.equal(packet.selected_entry.reported_residential_area,'1500.25');assert.equal(packet.selected_entry.reported_site_area,null);
  const q=f.queries.find(v=>v.tag==='native-plan').sql;
  for(const text of ['m.ordinal=k.ordinal AND m.account_id=k.account_id AND m.partition_ordinal=k.partition_ordinal',
    'm.entry_reference=k.entry_reference AND m.metric_row_reference=k.metric_row_reference AND m.row_reference=k.contribution_row_reference',
    'n.metric_row_reference=m.metric_row_reference AND n.contribution_row_reference=m.row_reference',
    'semantic.metric_row_reference=m.metric_row_reference AND semantic.contribution_row_reference=m.row_reference',
    'indexed.contribution_row_reference=m.row_reference','entry.ordinal=u.partition_ordinal AND entry.entry_reference=u.entry_reference',
    "'semantic_population_ordinal',semantic.ordinal"])assert.ok(q.includes(text),text);
  assert.deepEqual(f.queries.map(v=>v.tag),['transaction','native-plan']);
  assert.doesNotMatch(q,/m\.ordinal=1|OFFSET\s|array_agg|jsonb_agg|::float|::real/);
});

test('every retained original-member identity, group state, exact numeric value and population binding is validated before any DML',async()=>{
  const hostile=()=>assert.fail('hostile DATA must not execute'),cases=[null,{},new Proxy(originalMember,{get:hostile}),
    {...originalMember,extra:true},{...originalMember,get reported_year_built(){hostile();}},
    ...[{account_id:'B'},{ordinal:2},{partition_ordinal:2},{entry_reference:ref(4)},{row_reference:ref(4)},
      {contribution_row_reference:ref(4)},{state:'unknown'},{assigned_group_id:'recorded-cad:'+ 'a'.repeat(64)},
      {state:'assigned',assigned_group_id:null},{numeric_population_ordinal:null},{numeric_index_ordinal:2},
      {semantic_population_ordinal:null},{reported_year_built:'01'},{reported_residential_area:'1.0'},
      {reported_site_area:1},{reported_site_area:'1.1234567890123'},
      {entry_reference:{...ref(1),toJSON:hostile}},{row_reference:new Proxy(ref(2),{get:hostile})}]
      .map(patch=>({...copy(originalMember),...patch}))];
  for(const original_member of cases){const f=fixture([{...copy(first),original_member}]);
    await assert.rejects(()=>f.repo.readNext());assert.equal(mutations(f.queries).length,0);}
  const rows=secondRows();rows[1].original_member.reported_residential_area='1501.25';
  await assert.rejects(()=>fixture(rows).repo.readNext(),/native_plan_missing_or_corrupt/);
  const empty={...copy(first),...nullMember,selected_stock_count:0,anchor_count:0,kind:null,native_key:null,original_member:copy(originalMember)};
  await assert.rejects(()=>fixture([empty]).repo.readNext(),/native_member_missing_or_corrupt/);
});

test('ending retained member value/state changes are part of the observed native plan and are refused before the first DML',async()=>{
  for(const patch of [{reported_year_built:null},{reported_residential_area:'1501.25'},{reported_site_area:'0'},
    {state:'assigned',assigned_group_id:'recorded-cad:'+ 'a'.repeat(64)}]){
    const ending={...copy(first),original_member:{...copy(originalMember),...patch}},
      f=fixture(undefined,{packets:[[copy(first)],[ending]]});
    await f.repo.readNext();await assert.rejects(()=>f.repo.advance(receipt),/native_plan_changed/);
    assert.equal(mutations(f.queries).length,0);
  }
});

test('post-head native transaction, receipt, generation, sequence and all parent binding readbacks must agree; bounded DML counts do not replace guards',async()=>{
  for(const changes of [{ending:'101'},{endingReceipt:ref(8)},{endingGeneration:id(8)},{endingSequence:2},{endingBinding:false},
    ...['member-insert','source_record-insert','legacy_sale-insert','edge-insert'].map(badDelta=>({badDelta}))]){
    const f=fixture(undefined,changes);await f.repo.readNext();await assert.rejects(()=>f.repo.advance(receipt));
  }
  const f=fixture();await f.repo.readNext();await f.repo.advance(receipt);
  const q=f.queries.find(v=>v.tag==='head-readback').sql;
  for(const k of REFS)assert.ok(q.includes(`h.${k}=c.${k}`));
  assert.match(q,/h.issued_transaction_id=txid_current\(\)/);
  assert.doesNotMatch(q,/neighborhood_selected_transaction_index_v2_admission_matches/,
    'post-head/pre-checkpoint readback cannot accidentally require the old checkpoint to bind the new head');
});

test('constructor and public operations accept no caller cursor/plan/count/callback/transaction or additional arguments',async()=>{
  const f=fixture(),hostile=()=>assert.fail('hostile DATA must not execute');
  for(const patch of [{ordinal:1},{plan:first},{counts:zero},{callback:hostile},{transaction_id:'100'},
    {claim:{...claim,attempts:0}},{scope:{...scope,assignment_file_id:'8.0'}},{semantic_reference:{...ref(7),canonical_utf8_bytes:'4097'}}])
    assert.throws(()=>create({...f.options,...patch}));
  assert.throws(()=>create(new Proxy(f.options,{get:hostile})));assert.throws(()=>create(f.options,undefined));assert.throws(()=>create());
  await assert.rejects(()=>f.repo.readNext(undefined),/invalid_input/);
  await assert.rejects(()=>f.repo.advance(receipt),/native_plan_required/);
  await f.repo.readNext();
  for(const input of [{...receipt,plan:first},{...receipt,sequence:1},new Proxy(receipt,{get:hostile}),{...receipt,toJSON:hostile}])
    await assert.rejects(()=>f.repo.advance(input));
  await assert.rejects(()=>f.repo.advance(receipt,undefined),/invalid_input/);assert.equal(mutations(f.queries).length,0);
});

test('storage is called only by the inactive original-owner write branch; installed native guards remain unchanged',()=>{
  const path='../src/services/neighborhoodAssessment/',source=readFileSync(new URL(path+'customCohortSelectedTransactionIndexV2Repository.js',import.meta.url),'utf8'),
    capture=readFileSync(new URL(path+'customCohortContextCapture.js',import.meta.url),'utf8'),
    sql=readFileSync(new URL('../migrations/20261205_custom_cohort_selected_transaction_index_v2.sql',import.meta.url),'utf8'),
    migrations=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8');
  assert.match(capture,/:createCustomCohortSelectedTransactionIndexV2Repository/);
  assert.match(capture,/selectedTransactionIndexPacket=await selectedTransactionIndexStore\[readingCompletedIndexNextSource\?'readNextAccount':readingCompletedIndexFirstSource\?'readFirstAccount':'readNext'\]\(\)/);
  const atomic=capture.indexOf('if(progressingSelectedTransactionIndex){'),readOnly=capture.indexOf('if(readingSelectedTransactionSource){',atomic);
  assert.equal((capture.match(/selectedTransactionIndexStore\.advance\(/g)||[]).length,1);
  assert.ok(capture.indexOf('selectedTransactionIndexStore.advance(',atomic)<readOnly);
  assert.doesNotMatch(capture.slice(readOnly,capture.indexOf('if(progressingSelectedSemantic){',readOnly)),/selectedTransactionIndexStore\.advance\(/);
  assert.match(sql,/RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_owner_unintegrated'/);
  assert.doesNotMatch(migrations,/20261206_custom_cohort_selected_transaction_index_owner_v2/);
  assert.match(source,/UNREGISTERED owner WIP/);
  assert.doesNotMatch(source,/saveCheckpoint\(|yieldIssued\(|core\.sales|core\.source_records|SET attempts|SET context_sha256/);
  assert.match(source,/ub.canonical_utf8_bytes::text=u.receipt_reference->>'canonical_utf8_bytes'/);
  assert.doesNotMatch(source,/ub\.receipt_reference/,'blob aliases never stand in for their native head references');
});
