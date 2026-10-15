import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const fixture=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8');

test('shared transaction graph is a ninth independently captured fixture; eight historical graphs and tight positive/recovery limits remain',()=>{
  const variants=fixture.match(/for\(const selectionWaitFixture of \[([^\]]+)\]\)/)[1];
  assert.equal(variants,"false,true,'intent','union','union-empty','union-all','union-all-site-positive','union-all-semantic-recovery','union-all-shared-transaction','union-all-transaction-index-owner','union-worker','early-continuations'");
  assert.ok(fixture.includes("positiveIndexedSourceFixture=selectionWaitFixture==='union-all-site-positive'||semanticRecoveryFixture"));
  assert.ok(fixture.includes('if(!positiveIndexedSourceFixture){'));
  for(const limit of ['skip:!process.env.DATABASE_URL,timeout:180_000','max:2,statement_timeout:120_000',
    'candidateQueries.every(n=>n>=0&&n<=ORIGINAL_OWNER_LIMITS.sql_queries)'])assert.ok(fixture.includes(limit),limit);
});

test('shared501 and legacy10 are real live source changes before capture, never copied roots or changed retained originals',()=>{
  const start=fixture.indexOf('if(sharedTransactionFixture){'),end=fixture.indexOf('const run=randomUUID()',start),
    capture=fixture.indexOf('const frozen=await runNeighborhoodGroupIndex(pool',end),seed=fixture.slice(start,end);
  assert.ok(start>0&&end>start&&capture>end);
  assert.ok(seed.includes("UPDATE core.sale_parcels SET account_id='CLOSURE-B' WHERE id=2"));
  assert.ok(seed.includes("VALUES(10,NULL,'CLOSURE-B','2012-01-01',200000)"));
  assert.doesNotMatch(seed,/UPDATE app\.|INSERT INTO app\.|receipt|checkpoint|canonical_utf8|generation_id/);
  assert.ok(fixture.includes("sales:sharedTransactionFixture?['1','10','3','4']:['1','3','4']"));
  assert.ok(fixture.includes("sharedTransactionFixture?['10','3']:['3']"));
});

test('original closure BIGINT order remains separate from typed/legacy C-text order; extra genuine sale is included in all old typed-row checks',()=>{
  assert.ok(fixture.includes("sales:sharedTransactionFixture?['1','10','3','4']:['1','3','4']"));
  assert.ok(fixture.includes("expectedClosure={...expected,sales:sharedTransactionFixture?['1','3','4','10']:expected.sales}"));
  assert.equal([...fixture.matchAll(/Object\.entries\(expectedClosure\)/g)].length,4,
    'capture, initial-chain reopen, reference-chain reopen and final original-chain reopen all preserve native order');
  assert.ok(fixture.includes('expectedTypedOriginalCount=sharedTransactionFixture?18:17'));
  assert.equal([...fixture.matchAll(/assert\.equal\(await typedRows\(\),expectedTypedOriginalCount\)/g)].length,3);
  assert.ok(fixture.includes("assert.deepEqual(packages.filter(p=>p.kind==='legacy_sale').map(p=>p.native_key),sharedTransactionFixture?['10','3']:['3'])"));
  const page=fixture.slice(fixture.indexOf('for(const [kind,keys] of Object.entries(expectedClosure))await'),
    fixture.indexOf('await assert.rejects(withCustomCohortJobTransaction(pool,client=>createCohortOriginalSourceChainV1Store('));
  assert.doesNotMatch(page,/rows\.sort\(|reopenedKeys\.sort\(|new Set\(/,'do not hide native order with set/sorting parity');
  const closure=readFileSync(new URL('../src/services/neighborhoodAssessment/neighborhoodFrozenSourceClosurePages.js',import.meta.url),'utf8'),
    typed=readFileSync(new URL('../src/services/neighborhoodAssessment/neighborhoodSharedJobTransactionPagesV2.js',import.meta.url),'utf8');
  assert.match(closure,/sales:'bigint'/);assert.ok(closure.includes('`original.row_key::${type}`'));
  assert.ok(typed.includes('ORDER BY t.row_key LIMIT $6::integer'));
});

test('native fixture requires both complete original owner packets, committed sixth EMPTY, actual selected-union joins and FIRST candidate without claiming a durable index',()=>{
  const observer=fixture.indexOf('sharedTransactionFixture&&config.text===NEIGHBORHOOD_NEXT_SELECTED_COMBINED_ORIGINAL_PACKAGE_V2_SQL'),
    completed=fixture.indexOf("JSON.parse(completedEvidence.heads[0].canonical_utf8).after.done,true",observer),
    semantic=fixture.indexOf("console.info('[native-selected-semantic-original-owner-v2]'",completed),
    native=fixture.indexOf('const nativeRows=(await pool.query',semantic),
    marker=fixture.indexOf('[native-independently-captured-shared-selected-transaction-graph-v2]',native);
  assert.ok(observer>0&&completed>observer&&semantic>completed&&native>semantic&&marker>native);
  for(const text of ["rows.filter(r=>r.source_record_id==='501').length,4",'sharedSelectedEvidencePackets.size<=2',
    "assert.deepEqual(sources,['501','503','504']);assert.deepEqual(legacy,['10','3'])",
    'u.operation_id=$1::uuid AND u.organization_id=$2::uuid AND u.account_id=o.account_id',
    'WHERE o.generation_id=$3::uuid',"['sale_links','2','CLOSURE-B','501',2]",
    "r.account_id==='CLOSURE-B'&&r.stock_member===true&&r.selected_union_member===true",
    'durable_index_issued:false,phase17:false,global_deduplication:false,economic_transactions:false'])assert.ok(fixture.includes(text),text);
  const observation=fixture.slice(observer,fixture.indexOf("if(refsFault==='transaction_selected_flag'",observer));
  assert.doesNotMatch(observation,/return \{.*result|\.advance\(|yieldIssued|saveCheckpoint/);
  assert.ok(observation.includes('page_count===result.rows[0].original_count'));
});
