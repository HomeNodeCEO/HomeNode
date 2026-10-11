import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createCustomCohortSelectedNumericV2Repository as repository}
  from '../src/services/neighborhoodAssessment/customCohortSelectedNumericV2Repository.js';
import {NEIGHBORHOOD_FIRST_COMPLETED_NUMERIC_ORIGINAL_PACKAGE_V2_SQL as SQL,
  NEIGHBORHOOD_FIRST_SELECTED_FREQUENCY_ORIGINAL_PACKAGE_V2_SQL as oldSQL}
  from '../src/services/neighborhoodAssessment/neighborhoodSelectedTransactionOriginalPackageV2.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,
  ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
  entry={account_id:'A',ordinal:1,partition_ordinal:2,entry_reference:ref(1),state:'unassigned',assigned_group_id:null,
    row_reference:ref(2),contribution_row_reference:ref(3),numeric_index_ordinal:1,
    reported_year_built:null,reported_residential_area:'9007199254740993.000000000001',reported_site_area:'0'},
  nativeEntry=()=>({...entry,numeric_population_ordinal:1});
function setup(row=nativeEntry()){
  const calls=[],options={client:{async query(text,values){calls.push({text,values});
    assert.ok(text.includes(':first-completed-selected-entry'));
    return {rowCount:1,rows:[row??Object.fromEntries([...Object.keys(entry),'numeric_population_ordinal'].map(k=>[k,null]))]};}},
    claim:{operation_id:id(1),claim_token:id(2),attempts:5},
    scope:{organization_id:id(3),report_file_id:id(4),assignment_file_id:'7',account_id:'SUBJECT'},actorUserId:id(5),command_id:id(6),
    union_reference:ref(1),eligibility_reference:ref(2),evidence_reference:ref(3),metrics_reference:ref(4),statistics_reference:ref(5)};
  return {calls,options,owner:repository(options)};
}
const source=name=>readFileSync(new URL('../src/services/neighborhoodAssessment/'+name,import.meta.url),'utf8');

test('fixed first after ninth EMPTY joins every actual ninth/eighth/index/member parent and preserves exact values',async()=>{
  const {owner,calls}=setup(),result=await owner.readFirstCompletedSelectedEntry();
  assert.deepEqual(result,entry);assert.ok(Object.isFrozen(result));assert.equal(calls.length,1);assert.equal(calls[0].values.length,14);
  for(const text of ['m.ordinal=1','n.ordinal=m.ordinal','n.account_id=m.account_id','n.partition_ordinal=m.partition_ordinal',
    'n.entry_reference=m.entry_reference','n.metric_row_reference=m.metric_row_reference','n.contribution_row_reference=m.row_reference',
    'indexed.ordinal=m.ordinal','indexed.account_id=m.account_id','indexed.contribution_row_reference=m.row_reference',
    'metric.row_reference=m.metric_row_reference','entry.entry_reference=u.entry_reference',
    'h.statistics_reference=$14::jsonb','neighborhood_selected_numeric_v2_checkpoint_matches',
    "numeric_body.canonical_utf8::jsonb->'after'->>'done'='true'",'job.actor_user_id=$8::uuid',
    'job.lease_expires_at>clock_timestamp()','job.cancellation_requested_at IS NULL'])assert.ok(calls[0].text.includes(text),text);
  assert.doesNotMatch(calls[0].text,/coalesce\(h.sequence|array_agg|jsonb_agg|OFFSET |::float|::real|\bINSERT\b|\bUPDATE\b|\bBEGIN\b|\bCOMMIT\b/);
  assert.equal(await setup(null).owner.readFirstCompletedSelectedEntry(),null);
});

test('fixed completed member refuses missing/foreign ninth or index, noncanonical values and caller-selected input before SQL',async()=>{
  for(const patch of [{numeric_population_ordinal:null},{numeric_population_ordinal:2},{ordinal:2},
    {numeric_index_ordinal:null},{numeric_index_ordinal:2},{reported_site_area:'0.0'},{reported_site_area:0},
    {reported_site_area:'1e3'},{reported_site_area:'-1'},{reported_site_area:'0.0000000000001'},
    {contribution_row_reference:null},{row_reference:null},{account_id:' A'},{state:'caller'},{extra:true}])
    await assert.rejects(setup({...nativeEntry(),...patch}).owner.readFirstCompletedSelectedEntry());
  const {owner,calls}=setup();
  for(const args of [[undefined],[1],[{ordinal:1}],[()=>assert.fail('callback')]])
    await assert.rejects(owner.readFirstCompletedSelectedEntry(...args),/invalid_input/);
  assert.equal(calls.length,0);
  await assert.rejects(setup(new Proxy(nativeEntry(),{get(){assert.fail('proxy');}})).owner.readFirstCompletedSelectedEntry());
  await assert.rejects(setup({...nativeEntry(),get reported_site_area(){assert.fail('getter');}}).owner.readFirstCompletedSelectedEntry());
});

test('separate source SQL requires exact15 and actual ninth EMPTY but leaves old strict14 first SQL byte-identical',()=>{
  assert.equal(createHash('sha256').update(oldSQL).digest('hex'),'ebd4a370a12d9e7063a32d3c66cb972fcabf9b18fb47aa1e6df45cba815b29af');
  for(const text of ['neighborhood-first-completed-numeric-original-package-v2','r.ordinal=1 AND $4::text=',
    'neighborhood_selected_numeric_v2_checkpoint_matches','numeric_population.statistics_reference=statistics.receipt_reference',
    "numeric_body.canonical_utf8::jsonb->'after'->>'done'='true'",'raw_gate','all_totals','typed_bytes','original_bytes'])
    assert.ok(SQL.includes(text),text);
  assert.doesNotMatch(SQL,/coalesce\(numeric_population.sequence|array_agg|jsonb_agg|OFFSET\s+(?!0\b)|::float|::real/);
  assert.equal((SQL.match(/OFFSET 0/g)??[]).length,(oldSQL.match(/OFFSET 0/g)??[]).length);
  const cells=source('neighborhoodSharedStockOriginalCellsV2.js'),start=cells.indexOf('async subjectAndFirstCompletedNumericAccountPackage'),
    method=cells.slice(start,cells.indexOf('/** Fixed first after DONE eighth',start));
  assert.ok(method.includes("if(args.length!==2)fail('invalid_input')"));assert.ok(method.includes("subjectAndNextPackage({cursor:''}"));
  assert.doesNotMatch(method,/ordinal:|rowLimit:|callback|cursor:args/);
});

test('actual bounded owner reads candidates after every original row comparison, then rechecks ALL ending authority before return, without writes or whole-population claims',()=>{
  const s=source('customCohortContextCapture.js'),start=s.indexOf('original_selected_first_rank_candidates_refs_v2:'),
    stage=s.slice(start,s.indexOf('\n});',start));
  for(const text of ['verifying: true','stockVerifying: true','identityVerifying: true','readingSelectedUnionFirstAmenities: true',
    'readingSelectedUnionFirstTransactions: true','readingSelectedStatisticsSource: true','readingSelectedFrequencySource: true',
    'readingSelectedNumericSource: true','readingSelectedRankCandidates: true',"allowedPhases: ['frozen_selected_numeric_refs_v2']"])
    assert.ok(stage.includes(text),text);
  assert.doesNotMatch(stage,/progressingSelected|yieldingV2Progress/);
  const original=s.indexOf("'subjectAndFirstCompletedNumericAccountPackage'"),
    seventh=s.indexOf('if(!same(row,metricRowCandidate))',original),
    eighth=s.indexOf('if(!same(retainedContribution,statisticsContribution))',seventh),
    numeric=s.indexOf('if(firstSelectedEntry[key]!==statisticsContribution.metrics[key].contribution_exact_value)',eighth),
    ranks=s.indexOf('provisionalRankCandidates=await createCustomCohortSelectedNumericRankCandidatesV2Repository',numeric),
    rights=s.indexOf('if(!same(await boundedPolicy(authorizeMarketData',ranks),
    member=s.indexOf('if(readingSelectedRankCandidates&&!same(await numericStore.readFirstCompletedSelectedEntry()',rights),
    head=s.indexOf('if(readingSelectedRankCandidates&&!same(await numericStore.read(),numericAnchor))',member),
    result=s.indexOf("status:'current_authorized_first_selected_rank_candidate_source_reconciled'",head),
    end=s.indexOf('if(progressingSelectedNumeric){',result);
  assert.ok(original>0&&seventh>original&&eighth>seventh&&numeric>eighth&&ranks>numeric&&rights>ranks&&member>rights&&head>member&&result>head);
  const response=s.slice(s.indexOf('if(provisionalRankCandidates===null)',head),end);
  for(const text of ['complete_original_reconciled_rank_population:false','complete_indexed_metric_population:false',
    "statistics:'not_established'","publication:'not_established'",'read_only:true,lease_extended:false','budget.check();return freeze(result)'])
    assert.ok(response.includes(text),text);
  assert.doesNotMatch(response,/saveCheckpoint|\.advance\(|yieldIssued|blobs.put|quantile|COD|Number\(.*value/);
});

test('authored native seam probes require fresh EMPTY, all four independently issued graphs, current source refusal matrix and entire prior-state preservation',()=>{
  const s=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8');
  for(const text of ['actual first-original rank seam also refuses an unfinished ninth','rankSourceStep()',
    'rank seam actual original/current-ending refusal','nonvacuous rank seam fault consumed',
    'ending authority/member failures refuse AFTER the candidate read','await numericUnchanged(rankBefore)',
    "'indexed_ninth_member_missing','indexed_ninth_member_ending'",'rankSourceQueries.every(n=>n>=0&&n<=ORIGINAL_OWNER_LIMITS.sql_queries)',
    '[native-first-selected-rank-candidate-original-source-owner-v2]',
    'first_account_ONLY_not_complete_original_reconciled_rank_population:true',
    'statistics:false,medians_COD:false,calendar_quarters:false,publication:false,licensed_acquisition:false'])assert.ok(s.includes(text),text);
});

test('native seam injects actual post-original subject, claim and CAD-rights mutations at the generic authority hook',()=>{
  const s=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8'),
    start=s.indexOf("if(config.text.includes('neighborhood-frozen-job-closure:parcels')"),
    end=s.indexOf('if(config.text===NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.read&&++cadHeaderReads',start),
    hook=s.slice(start,end);
  assert.ok(start>0&&end>start);
  assert.ok(hook.includes('||config.text===NEIGHBORHOOD_FIRST_COMPLETED_NUMERIC_ORIGINAL_PACKAGE_V2_SQL'),
    'specific cell fault hooks cannot substitute for this generic current-authority hook');
  for(const text of ["if(fault==='subject')await client.query",'UPDATE app.appraisal_subject_snapshots SET subject_data=jsonb_set',
    "if(fault==='claim')await client.query",'UPDATE app.neighborhood_custom_cohort_capture_jobs SET claim_token=',
    "if(fault==='cad_license')await setCadFixtureGrant",'revoked_at:cadGrant.valid_from'])assert.ok(hook.includes(text),text);
  const probe=s.slice(s.indexOf('rank seam actual original/current-ending refusal'),s.indexOf('const rankSourceFrom=',s.indexOf('rank seam actual original/current-ending refusal')));
  assert.ok(probe.includes("assert.equal(refsFault,null,'nonvacuous rank seam fault consumed')"));
  assert.ok(probe.includes("afterOriginalAuthorityFault=['subject','cad_license'].includes(fault)"));
  assert.doesNotMatch(probe,/afterOriginalAuthorityFault=\[[^\]]*'claim'/);
  assert.ok(probe.includes("fault.endsWith('_ending')||afterOriginalAuthorityFault?1:0"));
  assert.ok(probe.includes('await numericUnchanged(rankBefore)'));
  const reader=source('neighborhoodSharedStockOriginalCellsV2.js'),stock=source('neighborhoodFrozenJobStock.js');
  assert.ok(reader.includes('if(!same(await stocks.read(),stock)'));
  assert.ok(reader.includes('await context.finish();if(cadContext)await cadContext.finish();return freeze(output)'));
  assert.ok(stock.includes('await jobs.readPreparedGeneration(claim,jobOptions)'));
});
