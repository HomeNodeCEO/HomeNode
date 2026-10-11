import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { emptyCohortSelectedStatisticsCountsV2 as empty,advanceCohortSelectedStatisticsCountsV2 as advance,
  prepareCohortSelectedStatisticsReceiptV2 as prepare,SELECTED_STATISTICS_V2_REASONS as REASONS }
  from '../src/services/neighborhoodAssessment/cohortSelectedStatisticsReceiptV2.js';
import { prepareCohortSelectedStatisticsContributionV2 as contribution,SELECTED_STATISTICS_CONTRIBUTION_V2_POLICY as POLICY }
  from '../src/services/neighborhoodAssessment/cohortSelectedStatisticsContributionV2.js';
import { resolveNeighborhoodOriginalAccountEligibilityV2 as resolve }
  from '../src/services/neighborhoodAssessment/neighborhoodOriginalAccountEligibilityV2.js';
import { SELECTED_REPORTED_METRIC_ROW_V2_BASIS as BASIS } from '../src/services/neighborhoodAssessment/cohortSelectedMetricRowV2.js';

const ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),clone=v=>JSON.parse(JSON.stringify(v)),
  expected={union_reference:ref(1),eligibility_reference:ref(2),evidence_reference:ref(3),metrics_reference:ref(4),
    command_id:'70000000-0000-4000-8000-000000000001',selected_stock_count:2},
  observed=(value,unit)=>({state:unit===null?'unsupported':'observed',exact_value:value,unit,source_part_count:'2',
    observed_part_count:unit===null?'0':'2',missing_part_count:'0',invalid_part_count:'0',unsupported_part_count:unit===null?'2':'0',conflict_values:[]});
function fixture(partial=false){
  const source={subject:{state:'observed',category:'townhouse'},housing:{state:partial?'conflicting':'observed',category:partial?null:'townhouse',
    county_state:'observed',source_part_count:'2',part_states:{observed:'2',missing:'0',unknown:'0',partial:'0',conflicting:'0'}},
    original_counts:{parcels:2,accounts:1},observations:{reported_year_built:observed('1960','year'),
      reported_residential_area:observed('9007199254740993.01','reported_sqft'),reported_site_area:observed('0','reported_sqft'),
      reported_market_value:observed('9007199254740993',null)}};
  if(partial){source.observations.reported_year_built.observed_part_count='1';source.observations.reported_year_built.missing_part_count='1';}
  const decision=resolve(source),metadata={command_id:expected.command_id,union_reference:ref(1),eligibility_reference:ref(2),evidence_reference:ref(3),
    selected_entry:{account_id:partial?'B':'A',ordinal:partial?2:1,partition_ordinal:partial?2:1,entry_reference:ref(5)},
    effective_date:'2026-10-10',observation_period:{start_date:'2024-10-11',end_date:'2026-10-10'},subject_housing:source.subject,housing_comparison:decision.housing.state},
    row={format:'cohort_selected_reported_metric_row_v2',...metadata,metrics:Object.fromEntries(Object.entries(decision.metrics).map(([k,v])=>[k,
      Object.fromEntries(['recorded_comparison_eligible','complete_observed_parts','exact_value','unit'].map(f=>[f,v[f]]))])),basis:BASIS};
  return contribution(source,row,{metric_metadata:metadata,metrics_reference:ref(4),metric_row_reference:ref(6)});
}
function receipt(ordinal=0,done=false){
  let before=empty();for(let i=0;i<ordinal;i++)before=advance(before,i,fixture(i===1).metrics);
  const row=done?null:fixture(ordinal===1),after=advance(before,ordinal,row?.metrics??null);
  return {format:'cohort_selected_statistics_receipt_v2',policy:POLICY,...expected,sequence:ordinal+1,previous:ordinal?ref(7):null,
    before:{selected_ordinal:ordinal,done:false},after:{selected_ordinal:ordinal+Number(!done),done},selected_entry:row?.selected_entry??null,
    row_reference:done?null:ref(8),before_counts:before,after_counts:after};
}
test('exclusive per-account states, eligibility and overlapping reasons stay separate from source parts',()=>{
  const zero=empty(),before=json(zero),a=fixture(),b=fixture(true),one=advance(zero,0,a.metrics),two=advance(one,1,b.metrics);
  assert.equal(json(zero),before);assert.ok(Object.isFrozen(two.reported_year_built.exclusion_reason_counts));
  const year=two.reported_year_built;assert.equal(year.value_states.observed,2);assert.equal(year.complete_observed_count,1);
  assert.equal(year.eligible_count,1);assert.equal(year.excluded_count,1);assert.equal(year.exclusion_reason_counts.missing_parts,1);
  assert.equal(year.exclusion_reason_counts.account_housing_conflicting,1);assert.equal(year.source_part_counts.observed,3);
  assert.equal(year.source_part_counts.missing,1);assert.equal(two.reported_site_area.complete_observed_count,2);
  assert.equal(two.reported_site_area.eligible_count,1);assert.equal(two.reported_market_value.value_states.unsupported,2);
  assert.equal(two.reported_market_value.exclusion_reason_counts.currency_not_established,2);
  assert.deepEqual(advance(two,2,null),two);assert.equal(REASONS.length,17);
});
test('closed contiguous eighth receipts bind four parents and fresh terminal EMPTY without declaring statistics',()=>{
  for(const raw of [receipt(),receipt(1),receipt(2,true)]){
    assert.deepEqual(prepare(raw,expected),raw);assert.ok(Buffer.byteLength(json(raw))<=16000);
    assert.ok(Object.isFrozen(prepare(raw,expected).after_counts.reported_site_area));
  }
  const e={...expected,selected_stock_count:0},r={...receipt(0,true),...e};assert.deepEqual(prepare(r,e),r);
  for(const mutation of [r=>r.after.selected_ordinal=2,r=>r.policy='caller',r=>r.metrics_reference=ref(9),r=>r.before.done=true,
    r=>r.row_reference=null,r=>r.selected_entry.ordinal=2,r=>r.after_counts.reported_site_area.eligible_count=0,
    r=>r.after_counts.reported_year_built.value_states.missing=1,r=>r.after_counts.reported_year_built.exclusion_reason_counts.account_housing_unknown=1]){
    const raw=clone(receipt());mutation(raw);assert.throws(()=>prepare(raw,expected));
  }
  assert.throws(()=>prepare(receipt(1,true),expected));assert.throws(()=>prepare(receipt(),expected,()=>{}));
});
test('malformed counts, parts, states, reasons and floating values refuse with no source callback or mutation',()=>{
  for(const mutation of [m=>m.reported_year_built.reported_value_state='caller',m=>m.reported_year_built.source_part_count=251,
    m=>m.reported_site_area.part_counts.missing=1,m=>m.reported_year_built.complete_observed_parts=false,
    m=>m.reported_year_built.recorded_comparison_eligible=false,m=>m.reported_site_area.contribution_exact_value=0,
    m=>m.reported_market_value.exclusion_reasons.push('currency_not_established'),m=>m.reported_market_value.exclusion_reasons.push('caller'),
    m=>m.reported_residential_area.contribution_exact_value='0',m=>m.reported_year_built.contribution_exact_value='1599']){
    const m=clone(fixture().metrics);mutation(m);assert.throws(()=>advance(empty(),0,m));
  }
  const bad=clone(empty());bad.reported_site_area.value_states.observed=1;assert.throws(()=>advance(bad,0,null));
  assert.throws(()=>advance(empty(),0,()=>assert.fail('source callback')));assert.throws(()=>empty(1));
});
test('hostile descriptors and proxies are rejected before traps and getters execute',()=>{
  let calls=0;const proxy=new Proxy({}, {ownKeys(){calls++;throw Error('trap');},getPrototypeOf(){calls++;throw Error('trap');}});
  assert.throws(()=>advance(proxy,0,null));assert.throws(()=>advance(empty(),0,proxy));assert.throws(()=>prepare(proxy,expected));
  const m=clone(fixture().metrics);Object.defineProperty(m.reported_site_area,'part_counts',{enumerable:true,get(){calls++;throw Error('getter');}});
  assert.throws(()=>advance(empty(),0,m));const r=receipt();Object.defineProperty(r,'after_counts',{enumerable:true,get(){calls++;throw Error('getter');}});
  assert.throws(()=>prepare(r,expected));assert.equal(calls,0);
});
