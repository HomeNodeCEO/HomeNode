import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createCustomCohortSelectedStatisticsV2Repository as repository} from '../src/services/neighborhoodAssessment/customCohortSelectedStatisticsV2Repository.js';
import {NEIGHBORHOOD_FIRST_SELECTED_FREQUENCY_ORIGINAL_PACKAGE_V2_SQL as sql,
  NEIGHBORHOOD_FIRST_SELECTED_STATISTICS_ORIGINAL_PACKAGE_V2_SQL as first,
  NEIGHBORHOOD_NEXT_SELECTED_STATISTICS_ORIGINAL_PACKAGE_V2_SQL as eighth} from '../src/services/neighborhoodAssessment/neighborhoodSelectedTransactionOriginalPackageV2.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,
  ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
  member={account_id:'B',ordinal:1,partition_ordinal:2,entry_reference:ref(4),state:'unassigned',assigned_group_id:null,
    row_reference:ref(5),contribution_row_reference:ref(6)};
function setup(next=member){
  const calls=[],options={client:{async query(text,values){calls.push({text,values});
    assert.ok(text.includes(':first-frequency-entry'));return {rowCount:1,rows:[next??Object.fromEntries(Object.keys(member).map(k=>[k,null]))]};}},
    claim:{operation_id:id(4),claim_token:id(5),attempts:2},
    scope:{organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'A'},actorUserId:id(6),
    command_id:id(3),union_reference:ref(1),eligibility_reference:ref(2),evidence_reference:ref(3),metrics_reference:ref(4)};
  return {owner:repository(options),calls,options};
}

test('frequency source is additive fixed1 after DONE eighth, every aggregate/raw gate and older plans unchanged',()=>{
  assert.equal(createHash('sha256').update(first).digest('hex'),'6d2d2c9117cc625801fca8f9e825ef215fd0a7f027180ef74a6d0f6ae24e687e');
  assert.equal(createHash('sha256').update(eighth).digest('hex'),'ac0740fb66f30a6c3b8496f35e2816b5ec13a73b0d5ff76c61a1534a00695894');
  for(const s of ['neighborhood-first-selected-frequency-original-package-v2','r.ordinal=1 AND $4::text=',
    'JOIN app.neighborhood_custom_cohort_selected_statistics_v2_rows r','statistics.metrics_reference=metrics.receipt_reference',
    'statistics.eligibility_reference=fifth.receipt_reference','statistics.evidence_reference=evidence.receipt_reference',
    'app.neighborhood_selected_statistics_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)',
    "statistics_body.canonical_utf8::jsonb->'after'->>'done'='true'",
    "metrics_body.canonical_utf8::jsonb->'after'->>'done'='true'",
    "evidence_body.canonical_utf8::jsonb->'after'->>'done'='true'",
    "fifth_body.canonical_utf8::jsonb->'after'->>'done'='true'",'cad_totals AS MATERIALIZED',
    '(SELECT coalesce(sum(n),0) FROM all_totals)<=$5::integer','raw_gate AS MATERIALIZED'])assert.ok(sql.includes(s),s);
  assert.equal((sql.match(/AND NOT \(SELECT oversize FROM raw_gate\)/g)??[]).length,3);
  assert.doesNotMatch(sql,/admission_matches|r.ordinal=coalesce|r.account_id=\$|\bINSERT\b|\bUPDATE\b|FROM core\./);
});

test('native first frequency entry binds eighth/seventh/member/partition and both references, no caller ordinal',async()=>{
  const {owner,calls}=setup();assert.deepEqual(await owner.readFirstFrequencyEntry(),member);
  const text=calls[0].text;
  for(const s of ['m.ordinal=1','m.metric_row_reference AS row_reference','m.row_reference AS contribution_row_reference',
    'metric.row_reference=m.metric_row_reference','u.ordinal=metric.ordinal AND u.account_id=metric.account_id',
    'entry.entry_reference=u.entry_reference','h.metrics_reference=seventh.receipt_reference',
    "b.canonical_utf8::jsonb->'after'->>'done'='true'",'neighborhood_selected_statistics_v2_checkpoint_matches',
    'seventh.receipt_reference=$13::jsonb','job.claim_token=$2::uuid','job.actor_user_id=$8::uuid'])assert.ok(text.includes(s),s);
  assert.equal(calls[0].values.length,13);
  assert.doesNotMatch(text,/admission_matches|array_agg|jsonb_agg|ST_DWithin|\bINSERT\b|\bUPDATE\b|\bBEGIN\b|\bCOMMIT\b/);
  assert.equal(await setup(null).owner.readFirstFrequencyEntry(),null);
  for(const patch of [{ordinal:2},{row_reference:null},{contribution_row_reference:null},{partition_ordinal:0},{state:'caller'},
    {contribution_row_reference:{...ref(6),canonical_utf8_bytes:'4097'}},{account_id:' B'},{assigned_group_id:'foreign'}])
    await assert.rejects(setup({...member,...patch}).owner.readFirstFrequencyEntry());
  for(const arg of [undefined,1,{ordinal:1},()=>assert.fail('callback')])await assert.rejects(owner.readFirstFrequencyEntry(arg));
  assert.equal(calls.length,1);
  const {options}=setup();
  for(const key of ['ordinal','readOriginal','counts','contribution','selected_accounts'])assert.throws(()=>repository({...options,[key]:true}));
  assert.throws(()=>repository({...options,get metrics_reference(){assert.fail('getter');}}));
});

test('actual frequency boundary freshly replays originals and compares EVERY retained contribution field before ending fences',()=>{
  const s=readFileSync(new URL('../src/services/neighborhoodAssessment/customCohortContextCapture.js',import.meta.url),'utf8'),
    start=s.indexOf('original_selected_first_frequency_refs_v2: {'),stage=s.slice(start,s.indexOf('\n});',start));
  for(const v of ['verifying: true','stockVerifying: true','identityVerifying: true','readingSelectedUnionFirstAmenities: true',
    'readingSelectedUnionFirstTransactions: true','readingSelectedStatisticsSource: true','readingSelectedFrequencySource: true',
    "allowedPhases: ['frozen_selected_statistics_refs_v2']"])assert.ok(stage.includes(v),v);
  assert.doesNotMatch(stage,/progressingSelectedStatistics: true|progressingSelectedMetrics: true|yieldingV2Progress: true/);
  const firstAt=s.indexOf('firstSelectedEntry=await (progressingSelectedNumeric?numericStore.readNextSelectedEntry():readingSelectedFrequencySource?'),
    originals=s.indexOf("'subjectAndFirstSelectedFrequencyAccountPackage'",firstAt),
    comparison=s.indexOf('if(!same(row,metricRowCandidate))',originals),
    fresh=s.indexOf('statisticsContribution=prepareCohortSelectedStatisticsContributionV2',comparison),
    stored=s.indexOf('const retainedText=await blobs.get(firstSelectedEntry.contribution_row_reference',fresh),
    every=s.indexOf('if(!same(retainedContribution,statisticsContribution))',stored),
    ending=s.indexOf("if(!same(await boundedPolicy(authorizeMarketData",every),
    nativeEnding=s.indexOf('if((progressingSelectedStatistics||readingSelectedFrequencySource)&&!same(await statisticsStore.read(),statisticsAnchor))',ending),
    result=s.indexOf("status:'current_authorized_first_selected_frequency_originals_reconciled'",nativeEnding);
  assert.ok(firstAt>0&&originals>firstAt&&comparison>originals&&fresh>comparison&&stored>fresh&&every>stored&&ending>every&&nativeEnding>ending&&result>nativeEnding);
  for(const v of ["readingSelectedFrequencySource?'readForFrequencies'",'statisticsStore.readFirstFrequencyEntry()',
    "fail('selected_contribution_original_mismatch')",'retained_contribution_reconciled:firstSelectedEntry!==null',
    'frequency_ledger:false,exact_distributions:false,complete_selected_union_metric_population:false',
    'readOriginalFrozenCaptureJobFirstSelectedFrequencyReferencesV2'])assert.ok(s.includes(v),v);
  const nextWrite=s.indexOf('if(progressingSelectedStatistics){',result);
  assert.ok(nextWrite>result,'the read-only result precedes the contribution write branch');
  const returned=s.slice(nativeEnding,nextWrite+36);
  assert.ok(returned.includes('statistics_contribution_candidate,metric_row_candidate,reported_comparison,...presentation'));
  assert.ok(returned.indexOf("status:'current_authorized_first_selected_frequency_originals_reconciled'")<returned.indexOf('if(progressingSelectedStatistics){'));
});

test('authored native boundary covers real source/authority rollback and canonical state/part/reason forgeries, never full statistics',()=>{
  const s=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8');
  for(const v of ['[native-first-selected-frequency-original-reconcile-owner-v2]','await contributionUnchanged(finishedContributions)',
    'freq_row_state','freq_row_parts','freq_row_reasons','freq_row_date','freq_row_member','freq_row_parent','freq_head_ending',
    'EVERY_seventh_metric_and_eighth_contribution_field_reconciled_to_THIS_fresh_original_replay:true',
    'current_and_actual_same_TX_ending_assignment_archive_source_rights_refusals_roll_back:true',
    'frequencyQueries.every(n=>n>=0&&n<=ORIGINAL_OWNER_LIMITS.sql_queries)',
    'frequency_ledger:false,exact_distributions:false,statistics:false,publication:false,licensed_acquisition:false,production_speed:false,worker_activation:false'])
    assert.ok(s.includes(v),v);
});
