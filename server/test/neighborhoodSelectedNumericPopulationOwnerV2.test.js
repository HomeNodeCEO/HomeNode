import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {NEIGHBORHOOD_FIRST_SELECTED_FREQUENCY_ORIGINAL_PACKAGE_V2_SQL as fixed,
  NEIGHBORHOOD_NEXT_SELECTED_NUMERIC_ORIGINAL_PACKAGE_V2_SQL as next} from '../src/services/neighborhoodAssessment/neighborhoodSelectedTransactionOriginalPackageV2.js';
import {createCustomCohortCaptureJobRepository} from '../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';

const source=name=>readFileSync(new URL('../src/services/neighborhoodAssessment/'+name,import.meta.url),'utf8');

test('ninth fixed source plan uses native next cursor and strict admission; existing first plan remains byte-identical',()=>{
  assert.equal(createHash('sha256').update(fixed).digest('hex'),'ebd4a370a12d9e7063a32d3c66cb972fcabf9b18fb47aa1e6df45cba815b29af');
  for(const text of ['neighborhood-next-selected-numeric-original-package-v2','numeric_population.operation_id=job.operation_id',
    'r.ordinal=coalesce(numeric_population.sequence,0)+1','app.neighborhood_selected_numeric_v2_admission_matches',
    'statistics.metrics_reference=metrics.receipt_reference',"statistics_body.canonical_utf8::jsonb->'after'->>'done'='true'",
    'raw_gate','all_totals','typed_bytes','original_bytes'])assert.ok(next.includes(text),text);
  // OFFSET 0 is the inherited PostgreSQL optimization fence before raw-size
  // admission/encoding, never population pagination. Keep it byte-identical.
  assert.doesNotMatch(next,/r.ordinal=1 AND|array_agg|jsonb_agg|OFFSET\s+(?!0\b)|::float|::real/);
  assert.equal((next.match(/OFFSET 0/g)??[]).length,(fixed.match(/OFFSET 0/g)??[]).length);
  const cells=source('neighborhoodSharedStockOriginalCellsV2.js'),method=cells.slice(cells.indexOf('async subjectAndNextSelectedNumericAccountPackage'),cells.indexOf('/** Fixed first after DONE eighth'));
  assert.ok(method.includes("if(args.length!==2)fail('invalid_input')"));
  assert.ok(method.includes("subjectAndNextPackage({cursor:''}"));assert.doesNotMatch(method,/ordinal:|rowLimit:|callback|cursor:args/);
});

test('ninth actual owner reopens originals and every field, then ALL ending fences, then atomic reference-only writes',()=>{
  const s=source('customCohortContextCapture.js'),stage=s.slice(s.indexOf('original_selected_numeric_progress_refs_v2:'),s.indexOf('original_selected_first_indexed_refs_v2:'));
  for(const text of ['verifying: true','stockVerifying: true','identityVerifying: true','readingSelectedUnionFirstAmenities: true',
    'readingSelectedUnionFirstTransactions: true','readingSelectedStatisticsSource: true','readingSelectedFrequencySource: true',
    'readingSelectedNumericSource: true','progressingSelectedNumeric: true',"'frozen_selected_statistics_refs_v2','frozen_selected_numeric_refs_v2'"])assert.ok(stage.includes(text),text);
  const packageAt=s.indexOf("'subjectAndNextSelectedNumericAccountPackage'"),seventh=s.indexOf('if(!same(row,metricRowCandidate))',packageAt),
    eighth=s.indexOf('if(!same(retainedContribution,statisticsContribution))',seventh),
    numeric=s.indexOf('if(firstSelectedEntry[key]!==statisticsContribution.metrics[key].contribution_exact_value)',eighth),
    rights=s.indexOf('if(!same(await boundedPolicy(authorizeMarketData',numeric),
    ending=s.indexOf('if(progressingSelectedNumeric&&!same(await numericStore.readNextSelectedEntry(),firstSelectedEntry))',rights),
    head=s.indexOf('if(progressingSelectedNumeric&&!same(await numericStore.read(),numericAnchor))',ending),
    write=s.indexOf('numericAnchor=await numericStore.advance(numericAnchor,receiptReference)',head),
    cp=s.indexOf("phase:'frozen_selected_numeric_refs_v2'",write),yieldAt=s.indexOf('.yieldIssued(claim,jobOptions)',cp);
  assert.ok(packageAt>0&&seventh>packageAt&&eighth>seventh&&numeric>eighth&&rights>numeric&&ending>rights&&head>ending&&write>head&&cp>write&&yieldAt>cp);
  const writes=s.slice(head,s.indexOf('if(readingSelectedFrequencySource){',head));
  assert.ok(writes.includes('checkpoint.evidence_refs.slice(0,14)'));
  assert.ok(writes.includes('must_reopen_complete_originals_entire_caches_and_current_authority_again'));
  assert.doesNotMatch(writes,/blobs.put\(canonicalAssessmentJson\(statisticsCandidate|numeric_values|typed_value|original_text|counts:/);
});

test('ninth job grammar is exact15 even before SQL and keeps inherited attempt ceiling',async()=>{
  const id='70000000-0000-4000-8000-000000000001',claim={operation_id:id,claim_token:id,attempts:5},
    options={scope:{organization_id:id,report_file_id:id,assignment_file_id:'7',account_id:'A'},actorUserId:id},
    ref={content_sha256:'a'.repeat(64),canonical_utf8_bytes:'123'};
  for(const n of [0,14,15,16]){
    const checkpoint={phase:'frozen_selected_numeric_refs_v2',evidence_refs:Array(n).fill(ref)},
      owner=createCustomCohortCaptureJobRepository({async query(){return {rowCount:1,rows:[{checkpoint}]};}});
    if(n===15)assert.deepEqual(await owner.readCheckpoint(claim,options),checkpoint);
    else await assert.rejects(owner.readCheckpoint(claim,options),/invalid_checkpoint/);
  }
});

test('additive ninth migration permits ONLY eighth-to-ninth and ninth-to-ninth with exact native parent bridge',()=>{
  const name='20261202_custom_cohort_selected_numeric_owner_v2.sql',sql=readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'),
    registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8');
  assert.ok(registry.indexOf(name)>registry.indexOf('20261201_custom_cohort_selected_numeric_v2.sql'));
  for(const text of ['CHECK(sequence BETWEEN 1 AND 18000009)','neighborhood_selected_numeric_v2_checkpoint_matches',
    "NEW.phase='frozen_selected_numeric_refs_v2' AND OLD.phase NOT IN ('frozen_selected_statistics_refs_v2','frozen_selected_numeric_refs_v2')",
    'h.statistics_reference=OLD.progress_reference','actual_sequence<>1','OLD.consumed_claim_token IS NULL',
    'NEW.issued_attempts<OLD.issued_attempts','NEW.attempts<OLD.attempts',"NEW.status IN ('succeeded','awaiting_selection')",
    "OLD.phase='frozen_selected_metrics_refs_v2' AND NEW.phase NOT IN ('frozen_selected_metrics_refs_v2','frozen_selected_statistics_refs_v2')"])assert.ok(sql.includes(text),text);
  assert.doesNotMatch(sql,/CREATE OR REPLACE FUNCTION app.neighborhood_selected_|GRANT |SECURITY DEFINER|DISABLE TRIGGER|UPDATE app\./i);
  assert.ok(sql.includes('COMMENT ON TABLE app.neighborhood_custom_cohort_selected_numeric_v2_rows IS'));
  assert.ok(sql.includes('integrated by the additive ninth original-owner migration'));
  assert.ok(sql.includes('Every later semantic statistics consumer must reopen those originals and current authority AGAIN'));
});

test('authored cloud fixture traverses ALL four actual graphs with every old source failure, native rollback, fresh EMPTY and lost COMMIT ACK',()=>{
  const s=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8'),
    start=s.indexOf('// Ninth actual original-owner population pass.'),block=s.slice(start,s.indexOf('[native-selected-numeric-population-owner-v2]',start)+1900);
  assert.ok(start>0);
  for(const text of ['numeric_head_ending','numeric_orphan_commit','numeric_row_rollback','numeric_checkpoint_rollback','numeric_yield_rollback',
    'indexed_value_ending','stats_row_cell','freq_row_state','freq_row_parts','freq_row_reasons','metric_assignment_ending','metric_draft_ending',
    'e=>e.outcome_unknown===true','for(let ordinal=1;ordinal<=selectedCount+1;ordinal++)','native_reference_rows:',
    'state.job.checkpoint.evidence_refs.length,15','state.blobs,before.blobs+1','numericQueries.every(n=>n>=0&&n<=ORIGINAL_OWNER_LIMITS.sql_queries)',
    'licensed_acquisition:false','production_speed:false','worker_activation:false'])assert.ok(block.includes(text),text);
});

test('ninth recovery uses a real fifth ordinary claim without removing seventh/eighth coverage or resetting attempts',()=>{
  const s=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8');
  assert.ok(s.includes('if(allSelected&&!positiveIndexedSourceFixture&&!transactionIndexOwnerFixture){'));
  assert.ok(s.includes("transactionIndexOwnerFixture=selectionWaitFixture==='union-all-transaction-index-owner'"),
    'ONLY the new independent graph reserves its fifth claim; all nine old seventh/eighth/ninth recovery paths are unchanged');
  assert.ok(s.includes(".failClaim(liveClaim,'synthetic_metrics_reclaim',{retrySeconds:1})"));
  assert.ok(s.includes(".failClaim(liveClaim,'synthetic_contribution_reclaim',{retrySeconds:1})"));
  const start=s.indexOf('if(positiveIndexedSourceFixture&&!semanticRecoveryFixture&&ordinal===1){'),block=s.slice(start,s.indexOf('previousNumeric=head.receipt_reference;',start));
  assert.ok(start>0);
  for(const text of [".failClaim(liveClaim,'synthetic_numeric_reclaim',{retrySeconds:1})",'assert.equal(retained.job.attempts,4)',
    'assert.equal(replacement.attempts,5)','assert.notEqual(replacement.claim_token,staleNumericClaim.claim_token)',
    'reclaimed.job.last_error_code','reclaimed.job.checkpoint,retained.job.checkpoint','reclaimed.numeric_heads,retained.numeric_heads',
    'reclaimed.numeric_population_rows,retained.numeric_population_rows','reclaimed.continuation,retained.continuation',
    'reclaimed.blobs,retained.blobs','captureJobClaim:staleNumericClaim','await numericUnchanged(reclaimed);await numericRefusals(reclaimed)'])assert.ok(block.includes(text),text);
  assert.doesNotMatch(block,/UPDATE app\.|SET attempts|attempts=0|attempts=1|attempts:6/);
});
