import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NEIGHBORHOOD_FIRST_SELECTED_METRIC_ORIGINAL_PACKAGE_V2_SQL as metric,
  NEIGHBORHOOD_NEXT_SELECTED_COMBINED_ORIGINAL_PACKAGE_V2_SQL as next,
  NEIGHBORHOOD_FIRST_SELECTED_COMBINED_ORIGINAL_PACKAGE_V2_SQL as first }
  from '../src/services/neighborhoodAssessment/neighborhoodSelectedTransactionOriginalPackageV2.js';

test('metric source SQL reopens fixed first after native DONE sixth using the same aggregate original/raw byte gates',()=>{
  for(const s of ['neighborhood-first-selected-metric-original-package-v2','r.ordinal=1',
    'head.command_id=command.command_id AND fifth.command_id=command.command_id',
    'fifth.union_reference=head.receipt_reference','evidence.eligibility_reference=fifth.receipt_reference',
    'neighborhood_selected_evidence_v2_checkpoint_matches',
    "evidence_body.canonical_utf8::jsonb->'after'->>'done'='true'",
    "evidence_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=body.canonical_utf8::jsonb->'after_selected_count'",
    "fifth_body.canonical_utf8::jsonb->'after'->>'done'='true'",
    "body.canonical_utf8::jsonb->'after'->>'done'='true'",'cad_totals AS MATERIALIZED',
    'UNION ALL SELECT n FROM cad_totals','raw_sizes AS MATERIALIZED','raw_gate AS MATERIALIZED',
    '(SELECT coalesce(sum(n),0) FROM all_totals)<=$5::integer',"AND $4::text=''"])
    assert.ok(metric.includes(s),s);
  assert.doesNotMatch(metric,/evidence.operation_id IS NULL|coalesce\(evidence.sequence|r.account_id=\$|\bINSERT\b|\bUPDATE\b|FROM core\./);
  assert.equal((metric.match(/AND NOT \(SELECT oversize FROM raw_gate\)/g)??[]).length,3);
  assert.ok(metric.indexOf('raw_gate AS MATERIALIZED')<metric.indexOf('jsonb_build_object'));
  assert.doesNotMatch(metric.slice(metric.indexOf('raw_sizes AS MATERIALIZED'),metric.indexOf('raw_gate AS MATERIALIZED')).replace(/--[^\n]*/g,''),/jsonb_build_object|encoded/);
  assert.equal(createHash('sha256').update(first).digest('hex'),'079ce364f459f67e3f01576f7464d01c399db0e64b29741ed1e9b4de47b716e7');
  assert.ok(next.includes("evidence_body.canonical_utf8::jsonb->'after'->>'done'='false'"));
  assert.ok(next.includes('r.ordinal=coalesce(evidence.sequence,0)+1'));
});

test('actual owner only admits exact12 roots and reopens originals before presenting first comparison cells',()=>{
  const owner=readFileSync(new URL('../src/services/neighborhoodAssessment/customCohortContextCapture.js',import.meta.url),'utf8'),
    start=owner.indexOf('original_selected_first_metric_refs_v2: {'),end=owner.indexOf('\n});',start),stage=owner.slice(start,end);
  assert.ok(start>=0&&end>start);
  for(const s of ["allowedPhases: ['frozen_selected_evidence_refs_v2']",'verifying: true','stockVerifying: true','identityVerifying: true',
    'readingSelectedUnionFirstAmenities: true','readingSelectedUnionFirstTransactions: true','readingSelectedMetricSource: true'])assert.ok(stage.includes(s),s);
  assert.doesNotMatch(stage,/progressingSelectedEvidence: true|progressingSelectedEligibility: true|yieldingV2Progress: true/);
  for(const s of ["readingSelectedMetricSource?!evidenceIssued.after.done:evidenceIssued.after.done",
    "fail(readingSelectedMetricSource?'unfinished_selected_evidence':'selected_evidence_finished')",
    'evidenceStore.readFirstMetricEntry()',"'subjectAndFirstSelectedMetricAccountPackage'",'reported_comparison:decision',
    'complete_selected_union_metric_population:false',"statistics:'not_established'","read_only:true,lease_extended:false",
    "if((progressingSelectedEvidence||readingSelectedMetricSource)&&!same(await evidenceStore.read(),evidenceAnchor))",
    'readOriginalFrozenCaptureJobFirstSelectedMetricReferencesV2'])assert.ok(owner.includes(s),s);
  assert.equal((owner.match(/progressingSelectedEvidence\|\|readingSelectedMetricSource\?'readForEvidence'/g)??[]).length,2);
  const firstRead=owner.indexOf('firstSelectedEntry=await (readingSelectedFrequencySource?'),
    originals=owner.indexOf("'subjectAndFirstSelectedMetricAccountPackage'",firstRead),
    compare=owner.indexOf('decision=resolveNeighborhoodOriginalAccountEligibilityV2',originals),
    result=owner.indexOf("'current_authorized_first_selected_metric_originals_reopened'",compare);
  assert.ok(firstRead>0&&originals>firstRead&&compare>originals&&result>compare);
  const row=owner.indexOf('const metricRowCandidate=',compare),ending=owner.indexOf(
    'if((progressingSelectedEvidence||readingSelectedMetricSource)&&!same(await evidenceStore.read(),evidenceAnchor))',row);
  assert.ok(row>compare&&result>row&&ending>result);
  for(const s of ['prepareCohortSelectedMetricRowV2','metric_row_candidate:metricRowCandidate,metric_row_retained:false',
    'effective_date:context.effective_date,observation_period:input.observationPeriod,subject_housing:subjectHousing',
    'housing_comparison:decision.housing.state'])assert.ok(owner.includes(s),s);
});

test('authored native metric coverage is tied to real DONE graph and preserves prior rows; not licensed acceptance',()=>{
  const fixture=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8');
  for(const s of ['[native-first-selected-metric-original-reopen-owner-v2]','pendingMetricSnapshot=await evidenceSnapshot()',
    'await assert.rejects(metricRead(),/unfinished_selected_evidence/)',
    "['metric_assignment_ending',/assignment_access_denied/]","['metric_draft_ending',/private_source_read_only/]",
    'metric.reported_comparison.metrics.reported_year_built.exact_value,null',
    "metric.reported_comparison.metrics.reported_site_area.exact_value,allSelected?'8000':'0'",
    'await evidenceUnchanged(completedEvidence)','metricQueries.every(n=>n>=0&&n<=ORIGINAL_OWNER_LIMITS.sql_queries)',
    'closed_first_metric_row_candidate_bound_to_native_parents_and_retained_dates:true',
    'metric.metric_row_retained,false','row.metrics.reported_site_area.exact_value,allSelected?',
    'licensed_acquisition:false,production_speed:false,worker_activation:false'])assert.ok(fixture.includes(s),s);
});
