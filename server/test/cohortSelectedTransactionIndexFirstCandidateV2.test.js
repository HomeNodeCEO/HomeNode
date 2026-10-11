import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SELECTED_TRANSACTION_INDEX_V2_PARENT_KEYS as keys,prepareCohortSelectedTransactionIndexFirstPlanV2 as preparePlan,
  prepareCohortSelectedTransactionIndexFirstCandidateV2 as prepareCandidate}
  from '../src/services/neighborhoodAssessment/cohortSelectedTransactionIndexFirstCandidateV2.js';
import {createCustomCohortSelectedTransactionIndexFirstCandidateV2Repository as repository}
  from '../src/services/neighborhoodAssessment/customCohortSelectedTransactionIndexFirstCandidateV2Repository.js';
const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
  roots=Object.fromEntries(keys.map((k,i)=>[k,ref(i+1)])),member={account_id:'B',ordinal:1,partition_ordinal:2,
    entry_reference:ref(4),metric_row_reference:ref(5),contribution_row_reference:ref(6)},
  packages=[...['2','10','9007199254740993'].map(native_key=>({kind:'source_record',native_key})),
    ...['10','2'].map(native_key=>({kind:'legacy_sale',native_key}))],
  plan={generation_id:id(7),selected_stock_count:2,selected_entry:member,anchor_count:5,native_packages:packages},
  options={command_id:id(3),...roots,plan},empty={...plan,selected_stock_count:0,selected_entry:null,anchor_count:0,native_packages:[]},
  rows=packages.map(p=>({transaction_id:'8',generation_id:id(7),...member,anchor_count:5,...p,selected_stock_count:2}));
function setup({returned=rows,rowCount=returned.length,auto=false,ending=false}={}){
  const calls=[];let count=0;const raw={client:{async query(text,values){calls.push({text,values});
    if(text.includes(':transaction */'))return {rowCount:1,rows:[{transaction_id:'8'}]};
    assert.ok(text.includes(':native-plan */'));count++;
    return {rowCount,rows:auto||ending&&count===2?returned.map(r=>({...r,transaction_id:'9'})):returned};}},
    claim:{operation_id:id(4),claim_token:id(5),attempts:5},scope:{organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'A'},
    actorUserId:id(6),command_id:id(3),...roots};
  return {raw,calls,owner:repository(raw)};
}

test('FIRST candidate derives separate BIGINT and C-text counts only from bounded exact namespace keys; final account still requires a fresh EMPTY',()=>{
  const p=preparePlan(plan),c=prepareCandidate(options);
  assert.deepEqual(p,plan);assert.equal(c.format,'cohort_selected_transaction_index_first_candidate_v2');
  assert.deepEqual(c.before,{selected_ordinal:0,source_record_keys:0,legacy_sale_keys:0,done:false});
  assert.deepEqual(c.after,{selected_ordinal:1,source_record_keys:3,legacy_sale_keys:2,done:false});
  assert.equal(c.sequence,1);assert.equal(c.previous_reference,null);assert.equal(c.durable_index_issued,false);
  assert.equal(prepareCandidate({...options,plan:{...plan,selected_stock_count:1}}).after.done,false);
  assert.deepEqual(prepareCandidate({...options,plan:empty}).after,{selected_ordinal:0,source_record_keys:0,legacy_sale_keys:0,done:true});
  assert.equal(prepareCandidate({...options,plan:{...plan,anchor_count:0,native_packages:[]}}).after.source_record_keys,0);
  assert.ok(Object.isFrozen(c)&&Object.isFrozen(c.after)&&Object.isFrozen(c.selected_entry));
  assert.ok(Object.isFrozen(p.native_packages)&&p.native_packages.every(Object.isFrozen));
  assert.equal(c.native_packages,undefined,'reference-only compact candidate never retains a key roster');
  assert.doesNotMatch(JSON.stringify(c),/transaction_id|price|sale_date|quarter|source_payload/);
  const large={...plan,anchor_count:250,native_packages:Array.from({length:250},(_,i)=>({kind:'source_record',native_key:String(i+1)}))};
  assert.equal(prepareCandidate({...options,plan:large}).after.source_record_keys,250);
  assert.ok(Buffer.byteLength(JSON.stringify(prepareCandidate({...options,plan:large})))<4096);
});

test('closed DATA rejects precision loss, duplicate/order/namespace errors, caller counts/cursors, sparse/proxy/accessor payloads without executing them',()=>{
  const reject=p=>assert.throws(()=>preparePlan(p));
  for(const patch of [{selected_stock_count:'2'},{selected_stock_count:2000001},{anchor_count:251},{anchor_count:4},{selected_entry:null},
    {extra:true},{native_packages:[]},{selected_entry:{...member,ordinal:2}},{selected_entry:{...member,account_id:' B'}},
    {selected_entry:{...member,contribution_row_reference:null}},{generation_id:7}])reject({...plan,...patch});
  for(const native_key of [2,9007199254740993n,'0','01','-1','1.0','1e2','9223372036854775808'])reject({...plan,native_packages:[{kind:'source_record',native_key}]});
  for(const native_packages of [[packages[0],packages[0]],[packages[1],packages[0]],[packages[4],packages[3]],
    [packages[3],packages[0]],[{kind:'sales',native_key:'2'}],[{...packages[0],extra:true}]])reject({...plan,native_packages});
  const hostile=()=>assert.fail('must not execute untrusted DATA');
  for(const p of [new Proxy(plan,{get:hostile}),{...plan,get anchor_count(){hostile();}},
    {...plan,selected_entry:{...member,entry_reference:{...ref(1),get canonical_utf8_bytes(){hostile();}}}},
    {...plan,native_packages:new Proxy(packages,{get:hostile})},{...plan,native_packages:Array(2)},
    {...plan,native_packages:Object.assign([...packages],{extra:true})},
    {...plan,native_packages:[{get kind(){hostile();},native_key:'2'}]}])reject(p);
  for(const patch of [{previous_reference:ref(1)},{sequence:2},{counts:{}},{ordinal:1},{readOriginal:hostile},
    {plan:{...plan,selected_stock_count:0}},{semantic_reference:{...ref(7),canonical_utf8_bytes:'4097'}}])assert.throws(()=>prepareCandidate({...options,...patch}));
});

test('native repository binds exact claim/scope/actor/command/seven parents, unissued empty storage and own same transaction on both reads',async()=>{
  const {owner,calls}=setup();assert.deepEqual(await owner.readFirstCandidate(),plan);assert.deepEqual(await owner.readFirstCandidate(),plan);
  assert.equal(calls.length,3);assert.equal(calls.filter(c=>c.text.includes(':transaction */')).length,1);
  const q=calls[1];assert.equal(q.values.length,16);assert.deepEqual(q.values.slice(0,9),[id(4),id(5),5,id(1),id(2),'7','A',id(6),id(3)]);
  assert.deepEqual(q.values.slice(9).map(JSON.parse),keys.map(k=>roots[k]));
  for(const text of ['app.neighborhood_selected_transaction_index_v2_next_keys(c.operation_id,c.organization_id)',
    'job.actor_user_id=$8::uuid','job.lease_expires_at>clock_timestamp()','job.claim_token=$2::uuid','job.attempts=$3::integer',
    's.receipt_reference=$16::jsonb','s.numeric_reference=$15::jsonb','s.statistics_reference=$14::jsonb',
    's.metrics_reference=$13::jsonb','s.evidence_reference=$12::jsonb','s.eligibility_reference=$11::jsonb','s.union_reference=$10::jsonb',
    'neighborhood_selected_semantic_v2_checkpoint_matches','existing.operation_id=job.operation_id LIMIT 1',
    "k.native_key END COLLATE \"C\" LIMIT 251"])assert.ok(q.text.includes(text),text);
  assert.equal([...q.text.matchAll(/AND NOT EXISTS\(SELECT 1 FROM app\.neighborhood_custom_cohort_selected_transaction/g)].length,5);
  assert.ok(calls.every(c=>!/INSERT|UPDATE|DELETE|BEGIN|COMMIT|array_agg|jsonb_agg|COUNT\(|OFFSET/.test(c.text)));
  await assert.rejects(setup({auto:true}).owner.readFirstCandidate(),/caller_transaction_required/);
  const late=setup({ending:true});await late.owner.readFirstCandidate();await assert.rejects(late.owner.readFirstCandidate(),/caller_transaction_required/);
  const emptyRow={transaction_id:'8',generation_id:id(7),...Object.fromEntries(Object.keys(member).map(k=>[k,null])),anchor_count:0,kind:null,native_key:null,selected_stock_count:0};
  assert.deepEqual(await setup({returned:[emptyRow]}).owner.readFirstCandidate(),empty);
});

test('native repository rejects wrong arity, foreign plan headers, overflow and nested hostile native DATA before exposing a plan',async()=>{
  const closed=setup();for(const args of [[undefined],[1],[{ordinal:1}],[()=>assert.fail('callback')]])await assert.rejects(closed.owner.readFirstCandidate(...args),/invalid_input/);
  assert.equal(closed.calls.length,0);
  for(const returned of [[],[...rows,{...rows[0],selected_stock_count:3}],rows.map(r=>({...r,ordinal:2})),
    rows.map(r=>({...r,extra:true})),rows.map(r=>({...r,anchor_count:251})),[rows[1],rows[0]],
    [new Proxy(rows[0],{get(){assert.fail('proxy');}})],[{...rows[0],get kind(){assert.fail('getter');}}],
    [{...rows[0],entry_reference:{...ref(1),get canonical_utf8_bytes(){assert.fail('nested getter');}}}],Array(1)])
    await assert.rejects(setup({returned}).owner.readFirstCandidate());
  await assert.rejects(setup({rowCount:251}).owner.readFirstCandidate(),/native_plan_missing_or_corrupt/);
  for(const patch of [{ordinal:1},{native_packages:packages},{sourceAuthority:true},{counts:{}},{scope:{...closed.raw.scope,assignment_file_id:7}}])
    assert.throws(()=>repository({...closed.raw,...patch}));
});

test('candidate is constructed inside the complete-original owner only AFTER both native plans, old independent keys and ALL ending fences; old exact16/DTO remains separate',()=>{
  const s=readFileSync(new URL('../src/services/neighborhoodAssessment/customCohortContextCapture.js',import.meta.url),'utf8'),
    first=s.indexOf('selectedTransactionCandidatePlan=await selectedTransactionCandidateStore.readFirstCandidate()'),
    original=s.indexOf("'subjectAndFirstCompletedSemanticAccountPackage'",first),
    seventh=s.indexOf('if(!same(row,metricRowCandidate))',original),eighth=s.indexOf('if(!same(retainedContribution,statisticsContribution))',seventh),
    ending=s.indexOf('const ending=await createCustomCohortV2SelectionIntentRepository(client)',eighth),
    oldKeys=s.indexOf('await semanticStore.readFirstCompletedTransactionNativeKeys(),selectedTransactionNativeKeys',ending),
    finalPlan=s.indexOf('await selectedTransactionCandidateStore.readFirstCandidate(),selectedTransactionCandidatePlan',oldKeys),
    candidate=s.indexOf('native_index_candidate:prepareCohortSelectedTransactionIndexFirstCandidateV2(',finalPlan),
    returned=s.indexOf('return freeze(result)',candidate),writes=s.indexOf('await blobs.put(canonicalAssessmentJson(afterSummary))',returned);
  assert.ok(first>0&&original>first&&seventh>original&&eighth>seventh&&ending>eighth&&oldKeys>ending&&finalPlan>oldKeys&&candidate>finalPlan&&returned>candidate&&writes>returned);
  for(const text of ['selectedTransactionCandidatePlan.selected_stock_count!==unionCounts.selected_count',
    '!same(selectedTransactionCandidatePlan.selected_entry,expectedEntry)','selectedTransactionCandidatePlan.anchor_count!==selectedTransactionNativeKeys.anchor_count',
    '!same(selectedTransactionCandidatePlan.native_packages,selectedTransactionNativeKeys.native_packages)',
    'prepareOriginalFrozenCaptureJobFirstSelectedTransactionIndexCandidateReferencesV2',"allowedPhases: ['frozen_selected_semantic_refs_v2']",
    "status:'current_authorized_first_selected_transaction_source_originals_reconciled'",'native_index_candidate_retained:false'])assert.ok(s.includes(text),text);
  assert.doesNotMatch(s.slice(candidate,returned),/await blobs.put|yieldIssued|\.advance\(|phase17/);
});

test('cloud first-candidate probes preserve old complete graphs, real native rollback and rights while keeping every deadline/budget unchanged',()=>{
  const s=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8'),
    block=s.slice(s.indexOf('// New READ-ONLY first transaction-source seam.'));
  assert.ok(block.indexOf('if(!positiveIndexedSourceFixture)')<block.indexOf("const candidateMethod="));
  for(const text of ['transaction_index_candidate_provisional','transaction_index_candidate_replaced','transaction_index_candidate_ending',
    'assert.equal(inserted.rowCount,1)',"['metric_assignment_ending',/assignment_access_denied/]",'await candidateUnchanged()',
    'candidateValue.native_index_candidate','assert.equal(native_index_candidate_retained,false)',
    '[native-first-selected-transaction-index-candidate-original-owner-v2]',
    'actual_current_authorized_complete_original_owner:true','durable_index_issued:false,phase17:false',
    'candidateQueries.every(n=>n>=0&&n<=ORIGINAL_OWNER_LIMITS.sql_queries)'])assert.ok(s.includes(text),text);
  assert.ok(s.includes('skip:!process.env.DATABASE_URL,timeout:180_000'));
});
