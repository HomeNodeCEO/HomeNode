import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8').replace(/\r/g,''),
  fixture=read('./neighborhoodGroupIndex.integration.test.js'),
  candidate=read('../migrations/20261206_custom_cohort_selected_transaction_index_owner_v2.sql'),
  registered=read('../src/database/mobileMigrations.js'),
  start=fixture.indexOf('if(transactionIndexOwnerFixture){\n              // TENTH'),
  end=fixture.indexOf("console.info('[native-selected-transaction-index-complete-original-owner-v2]'",start),
  native=fixture.slice(start,end),attachment=candidate.slice(candidate.indexOf('-- Coherent candidate attachment.'));

test('all five candidate SQL bodies close their nested expressions before the coalesce fallback',()=>{
  // This catches the cloud42601 regression, not native compilation/execution.
  // Quoted SQL values and comments cannot add expression parentheses.
  const bodies=[...candidate.matchAll(/LANGUAGE sql STABLE AS \$\$([\s\S]*?)\$\$;/g)];
  assert.equal(bodies.length,5);
  for(const [index,match] of bodies.entries()){
    const expression=match[1].replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g,'');
    let depth=0;
    for(const character of expression){
      if(character==='(')depth++;
      if(character===')')depth--;
      assert.ok(depth>=0,`SQL body${index+1} has an unmatched closing parenthesis`);
    }
    assert.equal(depth,0,`SQL body${index+1} has an unclosed expression`);
  }
  const transition=candidate.slice(candidate.indexOf('CREATE FUNCTION app.neighborhood_transaction_index_v2_checkpoint_transition_matches'),
    candidate.indexOf('CREATE FUNCTION app.neighborhood_selected_transaction_index_v2_admission_matches'));
  assert.ok(transition.includes("prior.canonical_utf8::jsonb->'semantic_reference'=h.semantic_reference)))),false)"),
    'close prior EXISTS, retained-phase branch, phase disjunction and outer EXISTS before coalesce false');
});

test('index native candidate is still unregistered; coherent replacements keep old identity/TRUNCATE and deferred pair attachments',()=>{
  assert.ok(start>0&&end>start);assert.doesNotMatch(registered,/20261206_custom_cohort_selected_transaction_index_owner_v2/);
  assert.ok(candidate.includes('Apply ONLY as one complete transaction'));
  for(const name of ['head_issued','head_commit_issued','child_commit_issued']){
    assert.ok(candidate.includes('CREATE FUNCTION app.'+(name==='head_issued'?'guard_neighborhood_selected_transaction_index_v2_':'check_neighborhood_transaction_index_v2_')+name+'()'));
  }
  assert.equal((attachment.match(/DROP TRIGGER neighborhood_selected_transaction_index_v2_head_guard/g)||[]).length,1);
  assert.equal((attachment.match(/DROP TRIGGER neighborhood_selected_transaction_index_v2_head_commit/g)||[]).length,1);
  assert.ok(attachment.includes("'neighborhood_selected_transaction_index_v2_'||label||'_commit',target"));
  for(const [table,label] of [['selected_transaction_index_v2_rows','member'],['selected_transaction_source_v2_keys','source'],
    ['selected_transaction_legacy_v2_keys','legacy'],['selected_transaction_index_v2_edges','edge']])
    assert.ok(attachment.includes("('neighborhood_custom_cohort_"+table+"','"+label+"')"));
  assert.equal((attachment.match(/DEFERRABLE INITIALLY DEFERRED/g)||[]).length,2);
  assert.doesNotMatch(attachment,/DROP TRIGGER[^\n]*(?:_truncate|_member_guard|_source_guard|_legacy_guard|_edge_guard|continuation|selection_wait)|DISABLE TRIGGER|GRANT\s/);
  assert.ok(native.includes('all prior child identity/TRUNCATE and deferred job/continuation triggers stay attached unchanged'));
});

test('candidate adds only exact17 phase/global ceiling and keeps each old finite ceiling in the real continuation guard',()=>{
  const phases=attachment.match(/CHECK\(phase IN \(([^)]+)\)\)/)[1];
  assert.equal(phases,"'frozen_stock_traversal_refs_v2','frozen_recorded_partition_refs_v2','frozen_recorded_catalog_refs_v2','frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2','frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2','frozen_selected_statistics_refs_v2','frozen_selected_numeric_refs_v2','frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2'");
  assert.ok(attachment.includes('CHECK(sequence BETWEEN 1 AND 22000011)'));
  for(const [phase,limit] of [['transaction_index',22000011],['semantic',20000010],['numeric',18000009]])
    assert.ok(candidate.includes("NEW.phase='frozen_selected_"+phase+"_refs_v2' AND NEW.sequence>"+limit));
  assert.ok(candidate.includes('AND NEW.sequence>16000008'));
});

test('tenth fixture independently captures sources, reserves only its own last failure claim, and does not add index calls to tight old graphs',()=>{
  const variants=fixture.match(/for\(const selectionWaitFixture of \[([^\]]+)\]\)/)[1];
  assert.equal(variants,"false,true,'intent','union','union-empty','union-all','union-all-site-positive','union-all-semantic-recovery','union-all-shared-transaction','union-all-transaction-index-owner','union-worker','early-continuations','early-worker','prefix-native','prefix-worker','initial-dispatch','initial-dispatch-transaction-index','initial-dispatch-stock-batch','initial-dispatch-partition-batch','initial-dispatch-catalog-batch','initial-dispatch-catalog-batch-replay','initial-dispatch-batch-selection-wait','initial-dispatch-batch-selection-intent','initial-dispatch-batch-selected-union','initial-dispatch-batch-selected-workers','initial-dispatch-batch-recorded-eligibility','initial-dispatch-batch-selected-evidence','initial-dispatch-batch-selected-metrics','initial-dispatch-batch-selected-statistics'");
  assert.ok(fixture.includes("transactionIndexOwnerFixture=selectionWaitFixture==='union-all-transaction-index-owner'"));
  assert.ok(fixture.includes("sharedTransactionFixture=selectionWaitFixture==='union-all-shared-transaction'||transactionIndexOwnerFixture||coveredTransactionIndexFixture"));
  assert.ok(fixture.includes("positiveIndexedSourceFixture=selectionWaitFixture==='union-all-site-positive'||semanticRecoveryFixture"));
  assert.ok(fixture.includes('if(allSelected&&!positiveIndexedSourceFixture&&!transactionIndexOwnerFixture)'));
  const timeoutLiteral="skip:!process.env.DATABASE_URL,timeout:selectionWaitFixture==='union-all-transaction-index-owner'?240_000:180_000";
  assert.equal(fixture.split(timeoutLiteral).length-1,1);
  assert.ok(fixture.indexOf(timeoutLiteral)>fixture.indexOf('for(const selectionWaitFixture of'));
  for(const text of [timeoutLiteral,
    'max:2,statement_timeout:120_000',
    'indexQueries.every(n=>n>=0&&n<=ORIGINAL_OWNER_LIMITS.sql_queries)'])assert.ok(fixture.includes(text),text);
  const seed=fixture.indexOf("UPDATE core.sale_parcels SET account_id='CLOSURE-B' WHERE id=2");
  assert.ok(seed>0&&fixture.indexOf('const frozen=await runNeighborhoodGroupIndex(pool',seed)>seed);
  assert.ok(fixture.indexOf('const semanticFinished=await semanticSnapshot()')<start);
  assert.ok(native.includes("assert.equal(exact16.phase,'frozen_selected_semantic_refs_v2')"));
  assert.ok(native.includes('await withCustomCohortJobTransaction(pool,client=>client.query(readFileSync('));
  assert.doesNotMatch(native,/SET CONSTRAINTS|DISABLE TRIGGER|SET attempts|attempts=|UPDATE app\.neighborhood_custom_cohort_capture_jobs|INSERT INTO app\.neighborhood_frozen_source_rows/);
});

test('native fixture exercises actual A then B shared full originals, exact first-seen registries/per-account edges and separate fresh EMPTY',()=>{
  const observer=fixture.slice(fixture.indexOf('if(transactionIndexOwnerFixture&&config.text===NEIGHBORHOOD_NEXT_SELECTED_TRANSACTION_INDEX_ORIGINAL_PACKAGE_V2_SQL)'),
    fixture.indexOf('if(transactionIndexOwnerFixture)for(const [fault,tag]'));
  for(const text of ['assert.equal(p.page_count,p.original_count)',"typeof r.original_text==='string'&&typeof r.typed==='object'",
    "rows.filter(r=>r.source_record_id==='501').length,4","r.account_id==='CLOSURE-OUTSIDE'","!rows.some(r=>r.source_record_id==='502')",
    "map(r=>r.row_key),['10','3']"])assert.ok(observer.includes(text),text);
  for(const text of ['for(const ordinal of [1,2,3])',"[['501',1],['503',2],['504',2]]","[['10',2],['3',2]]",
    "[1,'CLOSURE-A','source_record','501',null]","[2,'CLOSURE-B','source_record','501',null]",
    "body.new_source_record_keys,ordinal===1?1:ordinal===2?2:0",'state.job.checkpoint.evidence_refs.slice(0,16),exact16.evidence_refs',
    'state.job.checkpoint.evidence_refs.length,17','state.job.checkpoint.evidence_refs[16],h.receipt_reference',
    'state.continuation.progress_reference,h.receipt_reference','body.previous,ordinal===1?null:issuedIndexReferences.at(-1)',
    "'statistics','numeric'",'h.semantic_reference,semanticFinished.semantic_heads[0].receipt_reference','indexDone'])
    assert.ok(native.includes(text),text);
});

test('native fixture retains exact orphan/row/head/checkpoint/yield rollback and lost real COMMIT ACK plus nonempty ordinary4->5 recovery proofs',()=>{
  assert.ok(native.includes("['transaction_index_orphan_commit',/orphan_child|orphan_progress|continuation.*conflict/]"),
    'the first deferred child guard may refuse an orphaned real COMMIT before the head or job guard');
  for(const text of ['transaction_index_assignment_ending','transaction_index_member_rollback','transaction_index_head_rollback',
    'transaction_index_checkpoint_rollback','transaction_index_yield_rollback','transaction_index_orphan_commit',
    'orphan_child','actual incomplete index edges rollback','COMMIT acknowledgment lost',"'native_key::bigint,ordinal+1',/first_seen/",
    "'502,ordinal',/native_key/",'assert.equal(stale.attempts,4)','assert.equal(replacement.attempts,5)',
    '.failClaim(liveClaim,\'synthetic_transaction_index_prefix_reclaim\'',
    'recovered.job.checkpoint,retained.job.checkpoint','recovered.continuation,retained.continuation','recovered.tables,retained.tables',
    'liveClaim.attempts,oldClaim.attempts','liveClaim.claim_token,oldClaim.claim_token'])assert.ok(native.includes(text),text);
  assert.ok(fixture.includes("if(orphanUnionYield)await client.query('SAVEPOINT synthetic_union_yield')"));
  assert.ok(fixture.includes("if(orphanUnionYield){await client.query('ROLLBACK TO SAVEPOINT synthetic_union_yield')"));
  assert.ok(candidate.includes("IF NOT FOUND THEN RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_orphan_child'"));
});

test('new native fixture never claims licensed acquisition, economic resolution, calendar quarters, publication or worker activation',()=>{
  const log=fixture.slice(end,fixture.indexOf('\n            }',end));
  for(const text of ['economic_transactions:false','calendar_quarters:false','publication:false','licensed_acquisition:false',
    'production_speed:false','worker_activation:false','old_nine_fixture_proofs_and_deadlines_preserved:true'])assert.ok(log.includes(text),text);
  assert.ok(native.includes("result.calendar_quarters,'not_established'"));
  assert.ok(native.includes("result.publication,'not_established'"));
  assert.ok(native.includes('result.context_complete,false'));assert.ok(native.includes('result.pin_transfer,false'));
});
