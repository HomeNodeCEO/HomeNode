import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {NEIGHBORHOOD_FIRST_COMPLETED_SEMANTIC_ORIGINAL_PACKAGE_V2_SQL as SQL,
  NEIGHBORHOOD_FIRST_COMPLETED_NUMERIC_ORIGINAL_PACKAGE_V2_SQL as PREVIOUS}
  from '../src/services/neighborhoodAssessment/neighborhoodSelectedTransactionOriginalPackageV2.js';
const source=name=>readFileSync(new URL(`../src/services/neighborhoodAssessment/${name}.js`,import.meta.url),'utf8');

test('separate fixed first transaction-source SQL requires actual tenth DONE and native selected membership distinct from stock',()=>{
  for(const text of ['neighborhood-first-completed-semantic-original-package-v2','r.ordinal=1',
    'neighborhood_selected_semantic_v2_checkpoint_matches','semantic.command_id=command.command_id',
    'semantic.numeric_reference=numeric_population.receipt_reference',"semantic_body.canonical_utf8::jsonb->'after'->>'done'='true'",
    "'selected_union_member',CASE WHEN o.account_id IS NULL THEN NULL ELSE EXISTS(",
    'selected.operation_id=$1::uuid AND selected.account_id=o.account_id','AS subject_selected_union_member',
    "'stock_member',CASE WHEN o.account_id IS NULL",'all_totals','raw_gate','typed_bytes','original_bytes'])assert.ok(SQL.includes(text),text);
  assert.doesNotMatch(SQL,/array_agg|jsonb_agg|INSERT|UPDATE|DELETE|::float|::real|coalesce\(semantic.sequence,0\)\+1/);
  assert.doesNotMatch(PREVIOUS,/selected_union_member|semantic_body/,'old reader remains byte-shape strict');
});

test('actual adapter separates only native flags, still reconciles entire original packages before returning bounded membership',()=>{
  const s=source('neighborhoodSharedStockOriginalCellsV2'),start=s.indexOf('let transactions=null,selectedTransactionMembership=null'),
    separate=s.indexOf('const {selected_union_member,...original}=row;return original;',start),
    reconcile=s.indexOf('reconcileNeighborhoodOriginalTransactionPackageV2(',separate),
    output=s.indexOf('selected_transaction_membership:selectedTransactionMembership',reconcile),
    finish=s.indexOf('await context.finish()',output),returned=s.indexOf('return freeze(output)',finish);
  assert.ok(start>0&&separate>start&&reconcile>separate&&output>reconcile&&finish>output&&returned>finish);
  for(const text of ['row.selected_union_member&&!row.stock_member','row.account_id===result.account_id&&!row.selected_union_member',
    'associations.length!==result.transaction_original_count','economic_property_membership:\'not_established\'',
    'global_selected_native_deduplication:false','subjectAndFirstCompletedSemanticAccountPackage'])assert.ok(s.includes(text),text);
});

test('actual owner uses separate admission, native first member, complete original reconciliation and ending fences before a read-only early return',()=>{
  const s=source('customCohortContextCapture'),original=s.indexOf("'subjectAndFirstCompletedSemanticAccountPackage'"),
    seventh=s.indexOf('if(!same(row,metricRowCandidate))',original),eighth=s.indexOf('if(!same(retainedContribution,statisticsContribution))',seventh),
    index=s.indexOf('if(firstSelectedEntry[key]!==statisticsContribution.metrics[key].contribution_exact_value)',eighth),
    ending=s.indexOf('const ending=await createCustomCohortV2SelectionIntentRepository(client)',index),
    member=s.indexOf('await semanticStore.readFirstCompletedSelectedEntry()',ending),
    head=s.indexOf('!same(await semanticStore.read(),semanticAnchor)',member),
    result=s.indexOf("status:'current_authorized_first_selected_transaction_source_originals_reconciled'",head),
    returned=s.indexOf('return freeze(result)',result),writes=s.indexOf('await blobs.put(canonicalAssessmentJson(afterSummary))',returned);
  assert.ok(original>0&&seventh>original&&eighth>seventh&&index>eighth&&ending>index&&member>ending&&head>member&&result>head&&returned>result&&writes>returned);
  const body=s.slice(result,returned);
  for(const text of ["coverage:'fixed_first_selected_account_only_after_actual_tenth_fresh_EMPTY'",'global_selected_native_deduplication:false',
    "economic_transactions:'not_established'","calendar_quarters:'not_established'",'context_complete:false,pin_transfer:false',
    "report_update:'none',read_only:true,lease_extended:false",'Buffer.byteLength(JSON.stringify(result))>16000'])assert.ok(body.includes(text),text);
  assert.doesNotMatch(body,/await blobs.put|yieldIssued|\.advance\(|callback|selected_accounts/);
  const intent=source('customCohortV2SelectionIntentRepository'),a=intent.indexOf('async readForTransactionSource'),
    b=intent.indexOf('async readForSemanticStatistics',a),admission=intent.slice(a,b);
  for(const text of ['.readForSemanticStatistics(rawClaim,raw)','neighborhood_selected_semantic_v2_checkpoint_matches',
    "b.canonical_utf8::jsonb->'after'->>'done'='true'",'job.actor_user_id=$8::uuid','job.lease_expires_at>clock_timestamp()',
    "if(await tx()!==started)fail('caller_transaction_required')"])assert.ok(admission.includes(text),text);
  assert.doesNotMatch(admission,/INSERT|UPDATE|DELETE|callback/);
});

test('cloud probes exercise actual first source boundary in three independently captured graphs without changing the five tenth graphs or timeouts',()=>{
  const s=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8');
  for(const text of ['[native-first-selected-transaction-source-original-owner-v2]','if(!positiveIndexedSourceFixture)',
    "refsFault==='transaction_selected_flag'","['source_records','sales','sale_links'].includes(r.kind)&&r.account_id===result.rows[0].account_id",
    'row.selected_union_member=false',"['metric_assignment_ending',/assignment_access_denied/]",
    "['metric_draft_ending',/private_source_read_only/]",'await semanticUnchanged(before)',
    'value.membership.subject_selected_union_member,allSelected','value.transaction_original_count,value.membership.associations.length',
    "assert.equal(value.global_selected_native_deduplication,false)"])assert.ok(s.includes(text),text);
});
