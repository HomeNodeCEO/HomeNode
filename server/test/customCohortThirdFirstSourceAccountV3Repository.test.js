import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortThirdFirstSourceAccountV3Repository as create } from '../src/services/neighborhoodAssessment/customCohortThirdFirstSourceAccountV3Repository.js';
const owned=create;
import { createCustomCohortContextCapture as context } from '../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { NEIGHBORHOOD_THIRD_FIRST_SOURCE_ORIGINAL_PACKAGE_V3_SQL as SQL } from '../src/services/neighborhoodAssessment/neighborhoodSelectedTransactionOriginalPackageV2.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
  keys=['union_reference','eligibility_reference','evidence_reference','metrics_reference','statistics_reference','numeric_reference','semantic_reference'],
  expected={command_id:id(1),...Object.fromEntries(keys.map((k,i)=>[k,ref(i+1)])),generation_id:id(2),selected_stock_count:2},
  receipt={format:'cohort_selected_transaction_index_receipt_v2',...expected,sequence:3,previous:ref(8),
    before:{selected_ordinal:2,source_record_keys:3,legacy_sale_keys:2,done:false},
    after:{selected_ordinal:2,source_record_keys:3,legacy_sale_keys:2,done:true},selected_entry:null,
    association_anchor_count:0,source_package_count:0,legacy_package_count:0,new_source_record_keys:0,new_legacy_sale_keys:0},
  selected={account_id:'B',ordinal:2,partition_ordinal:2,entry_reference:ref(1),metric_row_reference:ref(2),contribution_row_reference:ref(3)},
  first={transaction_id:'101',head_reference:ref(9),head_sequence:3,receipt,expected,kind:'source_record',native_key:'501',first_selected_ordinal:2,
    selected_entry:selected,bindings_match:true},
  member={account_id:'B',ordinal:2,partition_ordinal:2,entry_reference:ref(1),state:'assigned',assigned_group_id:'recorded-cad:'+'a'.repeat(64),
    row_reference:ref(2),contribution_row_reference:ref(3),numeric_index_ordinal:2,reported_year_built:'1960',
    reported_residential_area:'1000.01',reported_site_area:null,numeric_population_ordinal:2,semantic_population_ordinal:2},
  account={transaction_id:'101',index_reference:ref(9),index_sequence:3,anchor_count:4,
    native_packages:[{kind:'source_record',native_key:'501',first_selected_ordinal:2},{kind:'source_record',native_key:'503',first_selected_ordinal:2},
      {kind:'legacy_sale',native_key:'10',first_selected_ordinal:2},{kind:'legacy_sale',native_key:'3',first_selected_ordinal:2}],original_member:member},
  copy=v=>structuredClone(v),result=rows=>({rowCount:rows.length,rows});

// These small protocol simulations check parsing and hostile inputs only. The
// independent graph32 proves actual PostgreSQL/original/current authority.
function fixture(rows=[copy(account)],native=copy(first),onQuery){
  const queries=[];let reads=0;
  const client={async query(sql,values){queries.push({sql,values});onQuery?.(sql,values);
    if(sql.includes(':transaction */'))return result([{transaction_id:'101'}]);
    if(sql.includes(':native-first */'))return result([native]);
    if(sql.includes(':native-account */'))return result([rows[Math.min(reads++,rows.length-1)]]);
    assert.fail('unexpected SQL');
  }},input={client,claim:{operation_id:id(3),claim_token:id(4),attempts:3},
    scope:{organization_id:id(5),report_file_id:id(6),assignment_file_id:'7',account_id:'SUBJECT'},actorUserId:id(7)};
  return {input,queries,repo:create(input)};
}

test('actual FIRST may belong to ordinal2; its entire bounded account key set retains every prior native field without inventing a cursor',async()=>{
  const {repo,queries}=fixture(),a=await repo.readFirstAccount();assert.equal(a.selected_entry.account_id,'B');assert.equal(a.selected_entry.ordinal,2);
  assert.deepEqual(a.plan.selected_entry,selected);assert.deepEqual(a.plan.native_packages,account.native_packages);
  assert.equal(a.selected_entry.reported_site_area,null);assert.equal(a.selected_entry.reported_residential_area,'1000.01');
  assert.deepEqual(a.previous,ref(9));assert.equal(Object.hasOwn(a.plan,'before'),false);assert.equal(a.source_plan.originals_reconciled,false);
  assert.ok(Object.isFrozen(a.plan.native_packages)&&Object.isFrozen(a.selected_entry));assert.deepEqual(await repo.readFirstAccount(),a);
  const sql=queries.find(q=>q.sql.includes(':native-account */')).sql;
  for(const text of ['neighborhood_source_resolution_v3_third_parent','neighborhood_source_resolution_v3_third_first','LIMIT 251','gate.anchor_count<=250','edge.account_id=s.account_id AND edge.ordinal=s.ordinal',
    'entry.ordinal=u.partition_ordinal','semantic.contribution_row_reference=m.row_reference','n.contribution_row_reference=m.row_reference'])assert.ok(sql.includes(text),text);
  assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE\s+app\.|DELETE|OFFSET)\b/i);
});

test('account plan refuses partial memberships, lossy numeric cells, corrupt anchors and changed native key sets',async()=>{
  const changes=[r=>r.original_member.numeric_population_ordinal++,r=>r.original_member.semantic_population_ordinal++,
    r=>r.original_member.row_reference=ref(4),r=>r.original_member.reported_residential_area='1000.010',
    r=>r.original_member.reported_year_built=1960,r=>r.original_member.assigned_group_id=null,
    r=>r.index_reference=ref(8),r=>r.index_sequence=2,r=>r.anchor_count=251,r=>r.anchor_count=3,
    r=>r.native_packages.shift(),r=>r.native_packages.push(copy(r.native_packages[0])),
    r=>r.native_packages.reverse(),r=>r.native_packages[0].first_selected_ordinal=null,
    r=>r.native_packages[0].first_selected_ordinal=3,r=>r.native_packages[0].native_key='9223372036854775808'];
  for(const change of changes){const r=copy(account);change(r);await assert.rejects(fixture([r]).repo.readFirstAccount(),/corrupt|invalid_reference/);}
  const r=copy(account);r.transaction_id='102';await assert.rejects(fixture([r]).repo.readFirstAccount(),/caller_transaction_required/);
});

test('owned18 account seam keeps every original first-seen member field and account key with no caller cursor',async()=>{
  const {input,queries}=fixture(),packet=await owned(input).readFirstAccount();
  assert.deepEqual(packet.plan.native_packages,account.native_packages);assert.equal(packet.selected_entry.account_id,'B');
  assert.equal(packet.selected_entry.ordinal,2);assert.equal(packet.selected_entry.reported_residential_area,'1000.01');
  const sql=queries.find(q=>q.sql.includes(':native-account */')).sql;
  assert.match(sql,/neighborhood_source_resolution_v3_third_parent/);assert.match(sql,/neighborhood_source_resolution_v3_third_first\(/);
  assert.match(sql,/LIMIT 251/);assert.match(sql,/gate.anchor_count<=250/);
  assert.throws(()=>owned({...input,cursor:'501'}),/invalid_input/);
});

test('repeat AFTER ending fences refuses even a still-valid changed prior member',async()=>{
  const r=copy(account);r.original_member.reported_year_built='1961';const {repo}=fixture([copy(account),r]);
  await repo.readFirstAccount();await assert.rejects(repo.readFirstAccount(),/native_account_changed/);
});

test('native getters, holes and proxies cannot run executable DATA or become an incomplete key set',async()=>{
  let invoked=false;const hostile=()=>{invoked=true;assert.fail('getter executed');};
  const examples=[new Proxy(copy(account.native_packages),{}),Array(2)];
  const accessor=copy(account.native_packages);Object.defineProperty(accessor,'0',{enumerable:true,get:hostile});examples.push(accessor);
  for(const value of examples){const r=copy(account);r.native_packages=value;await assert.rejects(fixture([r]).repo.readFirstAccount());}
  const r=copy(account);Object.defineProperty(r.original_member,'reported_year_built',{enumerable:true,get:hostile});
  await assert.rejects(fixture([r]).repo.readFirstAccount());assert.equal(invoked,false);
});

test('nonempty-FIRST owner refuses no registered source without fabricating empty economic progress',async()=>{
  const native=copy(first);for(const k of ['kind','native_key','first_selected_ordinal','selected_entry'])native[k]=null;
  for(const state of [native.receipt.before,native.receipt.after]){state.source_record_keys=0;state.legacy_sale_keys=0;}
  const {repo,queries}=fixture([account],native);await assert.rejects(repo.readFirstAccount(),/no_registered_source/);
  assert.ok(!queries.some(q=>q.sql.includes(':native-account */')));
});

test('closed native API snapshots validated claim/scope and refuses extra executable inputs before IO',async()=>{
  const {repo,input,queries}=fixture();await assert.rejects(repo.readFirstAccount({native_key:'501'}),/invalid_input/);assert.equal(queries.length,0);
  assert.throws(()=>create(input,{}),/invalid_input/);assert.throws(()=>create({...input,ordinal:2}),/invalid_input/);
  let invoked=false;const hostile=()=>{invoked=true;assert.fail('getter executed');};
  assert.throws(()=>create({...input,scope:new Proxy(input.scope,{get:hostile})}),/invalid_input/);
  assert.throws(()=>create({...input,claim:{...input.claim,get attempts(){return hostile();}}}),/invalid_input/);assert.equal(invoked,false);
  input.claim.claim_token=id(8);input.scope.account_id='MUTATED';await repo.readFirstAccount();
  const values=queries.find(q=>q.sql.includes(':native-account */')).values;assert.equal(values[2],id(4));assert.equal(values[7],'SUBJECT');
});

test('third original query retains whole-package pre-payload caps and its independent native recovered ownership',()=>{
 for(const text of ['neighborhood-third-first-source-original-package-v3',
  'neighborhood_source_resolution_v3_third_parent','neighborhood_source_resolution_v3_third_first',
  'index_next.account_id=r.account_id AND index_next.ordinal=r.ordinal','AND EXISTS(SELECT 1 FROM transaction_index_context)',
  'raw_sizes AS MATERIALIZED','raw_gate AS MATERIALIZED','NOT (SELECT oversize FROM raw_gate) OFFSET 0',
  'o.source_record_id=p.package_key::bigint','o.source_record_id IS NULL AND o.row_key=p.package_key',
  'AS subject_selected_union_member'])assert.ok(SQL.includes(text),text);
 assert.doesNotMatch(SQL,/neighborhood_source_resolution_v3_owned_first|neighborhood_selected_transaction_index_v2_next_keys|\$12|closing_date\s*[<>=]|\b(?:INSERT|UPDATE|DELETE|array_agg|jsonb_agg)\b/);
});

test('actual owner API refuses caller source selection and extra arguments before connection or authorization',async()=>{
  let calls=0;const hostile=()=>{calls++;assert.fail('must not run');},service=context({pool:{connect:hostile},
    sourceMode:'combined-witness2-v1',authorizeMarketData:hostile,authorizeCadImprovementData:hostile}),
    method='readCoveredOriginalFrozenCaptureJobThirdFirstSourceReferencesV3',
    input={auth:{userId:id(1),organizations:[]},accountId:'SUBJECT',assignmentFileId:'7',operationId:id(2),
      observationPeriod:{start_date:'2024-01-01',end_date:'2024-12-31'},discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}},
    options={captureJobClaim:{operation_id:id(2),claim_token:id(3),attempts:3}};
  assert.throws(()=>service[method](input,options,undefined),/invalid_options/);
  for(const key of ['ordinal','cursor','generation_id','native_key','native_packages','selected_entry','previous','before','readOriginal','sourceAuthority'])
    await assert.rejects(service[method](input,{...options,[key]:hostile}),/invalid_options/);
  await assert.rejects(service[method](input,new Proxy(options,{get:hostile})),/invalid_options/);assert.equal(calls,0);
});
