import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as plans from '../src/services/neighborhoodAssessment/neighborhoodSelectedTransactionOriginalPackageV2.js';
import { createCustomCohortSelectedMetricsV2Repository as repository } from '../src/services/neighborhoodAssessment/customCohortSelectedMetricsV2Repository.js';
import { NEIGHBORHOOD_FIRST_SELECTED_STATISTICS_ORIGINAL_PACKAGE_V2_SQL as sql,
  NEIGHBORHOOD_NEXT_SELECTED_METRIC_ORIGINAL_PACKAGE_V2_SQL as seventh }
  from '../src/services/neighborhoodAssessment/neighborhoodSelectedTransactionOriginalPackageV2.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,
  ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
  member={account_id:'B',ordinal:1,partition_ordinal:2,entry_reference:ref(4),state:'unassigned',assigned_group_id:null,row_reference:ref(5)};
function setup(next=member){
  const calls=[],owner=repository({client:{async query(text,values){calls.push({text,values});
    assert.ok(text.includes(':first-statistics-entry'));return {rowCount:1,rows:[next??Object.fromEntries(Object.keys(member).map(k=>[k,null]))]};}},
    claim:{operation_id:id(4),claim_token:id(5),attempts:2},
    scope:{organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'A'},actorUserId:id(6),
    command_id:id(3),union_reference:ref(1),eligibility_reference:ref(2),evidence_reference:ref(3)});
  return {owner,calls};
}
test('statistics source plan is separate fixed1 AFTER DONE seventh, same complete originals/raw gates',()=>{
  for(const s of ['neighborhood-first-selected-statistics-original-package-v2','r.ordinal=1',
    'metrics.command_id=command.command_id','metrics.eligibility_reference=fifth.receipt_reference',
    'metrics.evidence_reference=evidence.receipt_reference','neighborhood_selected_metrics_v2_checkpoint_matches',
    "metrics_body.canonical_utf8::jsonb->'after'->>'done'='true'",
    "metrics_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=body.canonical_utf8::jsonb->'after_selected_count'",
    "evidence_body.canonical_utf8::jsonb->'after'->>'done'='true'",
    "fifth_body.canonical_utf8::jsonb->'after'->>'done'='true'",'cad_totals AS MATERIALIZED',
    '(SELECT coalesce(sum(n),0) FROM all_totals)<=$5::integer','raw_gate AS MATERIALIZED'])assert.ok(sql.includes(s),s);
  assert.doesNotMatch(sql,/metrics.operation_id IS NULL|r.ordinal=coalesce|r.account_id=\$|\bINSERT\b|\bUPDATE\b|FROM core\./);
  assert.equal((sql.match(/AND NOT \(SELECT oversize FROM raw_gate\)/g)??[]).length,3);
  assert.ok(sql.indexOf('raw_gate AS MATERIALIZED')<sql.indexOf('jsonb_build_object'));
  assert.ok(seventh.includes("metrics_body.canonical_utf8::jsonb->'after'->>'done'='false'"));
  for(const [key,digest] of Object.entries({
    NEIGHBORHOOD_FIRST_SELECTED_COMBINED_ORIGINAL_PACKAGE_V2_SQL:'079ce364f459f67e3f01576f7464d01c399db0e64b29741ed1e9b4de47b716e7',
    NEIGHBORHOOD_FIRST_SELECTED_METRIC_ORIGINAL_PACKAGE_V2_SQL:'aa6e92b9f0fd52f6295b0531b4a02155928c9cc337a1f9476eb62f753a8cdddb',
    NEIGHBORHOOD_FIRST_SELECTED_TRANSACTION_ORIGINAL_PACKAGE_V2_SQL:'1f7aefc19d787df06f9e2d6246567f4434c7eff50f1387da643d50b9d0812215',
    NEIGHBORHOOD_NEXT_SELECTED_COMBINED_ORIGINAL_PACKAGE_V2_SQL:'483accdbfe2b3dee28917a49462c00af0a89f0acab9eb60966b1ab6665757015',
    NEIGHBORHOOD_NEXT_SELECTED_METRIC_ORIGINAL_PACKAGE_V2_SQL:'99c8ee055d12c660ca80f1f484a29dba1988a518ac99fe19c06c5e375ec4c336'}))
    assert.equal(createHash('sha256').update(plans[key]).digest('hex'),digest,key+' stays byte-identical; hash pins code, never source authority');
});
test('native fixed first read binds stored row to union/partition and DONE seventh, never a free cursor',async()=>{
  const {owner,calls}=setup();assert.deepEqual(await owner.readFirstStatisticsEntry(),member);
  const text=calls[0].text;
  for(const s of ['r.ordinal=1','m.ordinal=r.ordinal AND m.account_id=r.account_id',
    'm.partition_ordinal=r.partition_ordinal AND m.entry_reference=r.entry_reference',
    "metrics_body.canonical_utf8::jsonb->'after'->>'done'='true'",'neighborhood_selected_metrics_v2_checkpoint_matches',
    'h.evidence_reference=$12::jsonb','job.actor_user_id=$8::uuid','job.claim_token=$2::uuid'])assert.ok(text.includes(s),s);
  assert.doesNotMatch(text,/array_agg|jsonb_agg|ST_DWithin|\bINSERT\b|\bUPDATE\b|\bBEGIN\b|\bCOMMIT\b/);
  assert.equal(calls[0].values.length,12);assert.equal(await setup(null).owner.readFirstStatisticsEntry(),null);
  for(const patch of [{ordinal:2},{row_reference:null},{partition_ordinal:0},{state:'caller'},
    {row_reference:{...ref(5),canonical_utf8_bytes:'4097'}},{account_id:' B'},{assigned_group_id:'foreign'}])
    await assert.rejects(setup({...member,...patch}).owner.readFirstStatisticsEntry());
  for(const arg of [undefined,1,{ordinal:1},()=>assert.fail('callback')])await assert.rejects(owner.readFirstStatisticsEntry(arg));
  assert.equal(calls.length,1);
});
test('actual statistics-source owner compares every stored row field only to fresh complete originals, remains read-only',()=>{
  const owner=readFileSync(new URL('../src/services/neighborhoodAssessment/customCohortContextCapture.js',import.meta.url),'utf8'),
    start=owner.indexOf('original_selected_first_statistics_refs_v2: {'),end=owner.indexOf('\n});',start),stage=owner.slice(start,end);
  for(const s of ['verifying: true','stockVerifying: true','identityVerifying: true','readingSelectedUnionFirstAmenities: true',
    'readingSelectedUnionFirstTransactions: true','readingSelectedStatisticsSource: true',"allowedPhases: ['frozen_selected_metrics_refs_v2']"])assert.ok(stage.includes(s),s);
  assert.doesNotMatch(stage,/progressingSelectedMetrics: true|yieldingV2Progress: true/);
  const first=owner.indexOf('firstSelectedEntry=await (readingSelectedStatisticsSource?'),
    original=owner.indexOf("'subjectAndFirstSelectedStatisticsAccountPackage'",first),
    compare=owner.indexOf('decision=resolveNeighborhoodOriginalAccountEligibilityV2',original),
    row=owner.indexOf('const metricRowCandidate=',compare),reconcile=owner.indexOf('if(!same(row,metricRowCandidate))',row),
    ending=owner.indexOf("if(readingSelectedStatisticsSource&&!same(await metricsStore.read(),metricsAnchor))",reconcile),
    result=owner.indexOf('if(readingSelectedUnionSubjectHousing)return freeze(subjectHousingResult)',ending);
  assert.ok(first>0&&original>first&&compare>original&&row>compare&&reconcile>row&&ending>reconcile&&result>ending);
  for(const s of ["readingSelectedStatisticsSource?'readForStatistics'",'metricsStore.readFirstStatisticsEntry()',
    'prepareCohortSelectedMetricRowV2(row,metricRowMetadata)',"fail('selected_metric_original_mismatch')",
    "if(!metricsIssued.after.done)fail('unfinished_selected_metrics')",'retained_metric_row_reconciled:firstSelectedEntry!==null',
    "complete_selected_union_metric_population:false,statistics:'not_established'",'readOriginalFrozenCaptureJobFirstSelectedStatisticsReferencesV2'])assert.ok(owner.includes(s),s);
});
test('authored native source-reconciliation coverage uses actual DONE graph and rollback, not statistics/licensed acceptance',()=>{
  const f=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8');
  for(const s of ['[native-first-selected-statistics-original-reconcile-owner-v2]','await metricsUnchanged(finishedMetrics)',
    'stats_row_cell','stats_row_date','stats_row_member','actual_same_TX_assignment_archive_ending_refusals_and_all_prior_state_unchanged:true',
    'statisticsQueries.every(n=>n>=0&&n<=ORIGINAL_OWNER_LIMITS.sql_queries)',
    'canonical_forged_blob_not_original_authority_refused_and_rolled_back:selectedCount>0',
    'statistics:false,publication:false,licensed_acquisition:false,production_speed:false,worker_activation:false'])assert.ok(f.includes(s),s);
});
