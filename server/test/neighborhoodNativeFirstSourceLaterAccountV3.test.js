import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read=name=>readFileSync(new URL(name,import.meta.url),'utf8'),fixture=read('./neighborhoodGroupIndex.integration.test.js'),
  index=read('./helpers/neighborhoodBatchSelectedTransactionIndexV3DatabaseChecks.js'),
  owner=read('./helpers/neighborhoodCompletedIndexFirstSourceV3DatabaseChecks.js');

// Fixture structure only; actual PostgreSQL/original authority is proved by
// the independent new capture in cloud CI, never by these source assertions.
test('independent35 and the additional reserved-attempt captures append after the original34 without changing their native stack',()=>{
  const variants=fixture.match(/for\(const selectionWaitFixture of \[([^\]]+)\]\)/)[1].split(',');
  assert.equal(variants.length,39);assert.equal(variants[31],"'initial-dispatch-batch-selected-transaction-index'");
  assert.equal(variants[32],"'initial-dispatch-batch-selected-recovery'");assert.equal(variants[33],"'initial-dispatch-batch-selected-progress-recovery'");
  assert.equal(variants[34],"'initial-dispatch-batch-first-source-later-account'");
  assert.deepEqual(variants.slice(35),["'initial-dispatch-batch-source-last-retry'","'initial-dispatch-batch-source-last-retry-later-account'",
    "'initial-dispatch-batch-source-expired-final'","'initial-dispatch-batch-source-expired-final-later-account'"]);
  assert.ok(fixture.includes("batchSelectedTransactionIndexFixture=['initial-dispatch-batch-first-source-later-account','initial-dispatch-batch-source-last-retry-later-account','initial-dispatch-batch-source-expired-final-later-account'].includes(selectionWaitFixture)?'later-first-source':['initial-dispatch-batch-selected-transaction-index','initial-dispatch-batch-source-last-retry','initial-dispatch-batch-source-expired-final'].includes(selectionWaitFixture)"));
  const semantic=read('./helpers/neighborhoodBatchSelectedSemanticV3DatabaseChecks.js');
  assert.ok(semantic.includes("laterFirstSource:batchSelectedTransactionIndexFixture==='later-first-source'"));
  for(const limit of ['timeout:180_000','max:2,statement_timeout:120_000'])assert.ok(fixture.includes(limit),limit);
});

test('only later-account captures change two LIVE associations before genuine capture, preserving stock/CAD and retained evidence',()=>{
  const start=fixture.indexOf("if(batchSelectedTransactionIndexFixture==='later-first-source'){"),
    end=fixture.indexOf('    const run=randomUUID(),otherRun=randomUUID();',start),
    capture=fixture.indexOf('const frozen=await runNeighborhoodGroupIndex(pool',end),slice=fixture.slice(start,end);
  assert.ok(start>0&&end>start&&capture>end);
  assert.ok(slice.includes("UPDATE core.sales_source_records SET primary_account_id='CLOSURE-OUTSIDE' WHERE id=501"));
  assert.ok(slice.includes("UPDATE core.sale_parcels SET account_id='CLOSURE-OUTSIDE' WHERE id=1"));
  assert.equal((slice.match(/await pool.query/g)||[]).length,2);
  assert.doesNotMatch(slice,/UPDATE app\.|INSERT INTO app\.|UPDATE gis\.|generation_id|canonical_utf8|checkpoint|receipt/);
});

test('actual completed-index FIRST must choose ordinal2 after real A empty; no caller ordinal or copied head',()=>{
  for(const text of ['assert.equal(edges.length,laterFirstSource?5:6)',
    "first_selected_ordinal,laterFirstSource?2:1",
    "edges.filter(r=>r.ordinal===1).length,0",
    'source.readFirst()',"r.ordinal===(laterFirstSource?2:1)",
    'assert.deepEqual(await source.readFirst(),plan)','later_first_seen_selected_ordinal_two:laterFirstSource'])assert.ok(index.includes(text),text);
  for(const text of ["result.selected_entry.account_id,laterFirstSource?'CLOSURE-B':'CLOSURE-A'",
    'result.selected_entry.ordinal,laterFirstSource?2:1',"{kind:'source_record',native_key:'503'}",
    "{kind:'source_record',native_key:'504'}","row.account_id===null",
    'native_account_count:laterFirstSource?2:3','selected_account_count:laterFirstSource?1:2'])assert.ok(owner.includes(text),text);
  assert.doesNotMatch(index,/source\.readFirst\(\{|source\.readFirst\(later/);
});

test('later-account read retains the genuine committed claim, whole originals, all ending faults, lost ACK and exact unchanged state',()=>{
  for(const text of ['await tx(pool,client=>continuations(client).claimDue',
    'assert.equal(next.claim.attempts,before.attempts)',"['completed_source_cache',/original_mismatch/]",
    "['catalog_replay_rights'","['selected_CAD_deny'",'assert.equal(originalReads(),reads+1)',
    "setFault('completed_source_ack')",'assert.deepEqual(await resolve(),resolved)',
    'assert.deepEqual(await job(),owned.job)','assert.deepEqual(await parent(),owned.parent)',
    'assert.deepEqual(await snapshot(),owned.index)','await immutable()',
    'later_first_seen_selected_ordinal_two_and_whole_B_native_key_set:laterFirstSource'])assert.ok(owner.includes(text),text);
  assert.doesNotMatch(owner,/SET attempts=|SET last_error_code=|SET lease_expires_at=|deadline:|deadline_ms|new Promise|pg_sleep/);
});
