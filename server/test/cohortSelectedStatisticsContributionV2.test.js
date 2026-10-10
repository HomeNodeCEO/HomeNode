import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareCohortSelectedStatisticsContributionV2 as prepare,SELECTED_STATISTICS_CONTRIBUTION_V2_POLICY as POLICY,
  SELECTED_STATISTICS_REPORTED_VALUE_STATES as STATES,SELECTED_STATISTICS_CONTRIBUTION_V2_MAX_BYTES as MAX }
  from '../src/services/neighborhoodAssessment/cohortSelectedStatisticsContributionV2.js';
import { resolveNeighborhoodOriginalAccountEligibilityV2 as resolve }
  from '../src/services/neighborhoodAssessment/neighborhoodOriginalAccountEligibilityV2.js';
import { SELECTED_REPORTED_METRIC_ROW_V2_BASIS as BASIS } from '../src/services/neighborhoodAssessment/cohortSelectedMetricRowV2.js';

const ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
  metric=(value,unit)=>({state:unit===null?'unsupported':'observed',exact_value:value,unit,
    source_part_count:'2',observed_part_count:unit===null?'0':'2',missing_part_count:'0',invalid_part_count:'0',
    unsupported_part_count:unit===null?'2':'0',conflict_values:[]});
function source(){return {subject:{state:'observed',category:'townhouse'},
  housing:{state:'observed',category:'townhouse',county_state:'observed',source_part_count:'2',
    part_states:{observed:'2',missing:'0',unknown:'0',partial:'0',conflicting:'0'}},
  original_counts:{parcels:2,accounts:1},observations:{reported_year_built:metric('1960','year'),
    reported_residential_area:metric('9007199254740993.01','reported_sqft'),reported_site_area:metric('0','reported_sqft'),
    reported_market_value:metric('9007199254740993',null)}};}
function fixture(original=source()){
  const decision=resolve(original),metadata={command_id:'70000000-0000-4000-8000-000000000001',
    union_reference:ref(1),eligibility_reference:ref(2),evidence_reference:ref(3),
    selected_entry:{account_id:'A',ordinal:1,partition_ordinal:2,entry_reference:ref(4)},
    effective_date:'2026-10-10',observation_period:{start_date:'2024-10-11',end_date:'2026-10-10'},
    subject_housing:{...original.subject},housing_comparison:decision.housing.state},
    row={format:'cohort_selected_reported_metric_row_v2',...metadata,basis:BASIS,
      metrics:Object.fromEntries(Object.entries(decision.metrics).map(([k,c])=>[k,Object.fromEntries(
        ['recorded_comparison_eligible','complete_observed_parts','exact_value','unit'].map(f=>[f,c[f]]))]))},
    binding={metric_metadata:metadata,metrics_reference:ref(5),metric_row_reference:ref(6)};
  return {original,row,binding,run(){return prepare(original,row,binding);}};
}
test('one fresh account contributes exact supported numbers only; zero site is observed and currency never contributes',()=>{
  const f=fixture(),before=structuredClone(f.original),r=f.run();
  assert.equal(r.policy,POLICY);assert.equal(r.format,'cohort_selected_statistics_contribution_v2');
  assert.equal(r.count_basis,'one_native_selected_account_per_metric_not_parts_or_overlapping_reasons');
  assert.deepEqual(r.metric_row_reference,ref(6));assert.deepEqual(r.metrics_reference,ref(5));
  assert.deepEqual(r.selected_entry,f.row.selected_entry);assert.deepEqual(r.observation_period,f.row.observation_period);
  assert.deepEqual(r.metrics.reported_residential_area,{reported_value_state:'observed',complete_observed_parts:true,
    recorded_comparison_eligible:true,contribution_exact_value:'9007199254740993.01',contribution_unit:'reported_sqft',
    exclusion_reasons:[],source_part_count:2,part_counts:{observed:2,missing:0,invalid:0,unsupported:0}});
  assert.equal(r.metrics.reported_year_built.contribution_exact_value,'1960');
  assert.equal(r.metrics.reported_site_area.contribution_exact_value,'0');
  assert.deepEqual(r.metrics.reported_market_value,{reported_value_state:'unsupported',complete_observed_parts:false,
    recorded_comparison_eligible:false,contribution_exact_value:null,contribution_unit:null,
    exclusion_reasons:['recorded_value_unsupported','unsupported_parts','currency_not_established'],
    source_part_count:2,part_counts:{observed:0,missing:0,invalid:0,unsupported:2}});
  assert.equal(r.statistics,'not_established');assert.equal(r.publication,'not_established');
  assert.ok(Buffer.byteLength(json(r))<=MAX);assert.ok(Object.isFrozen(r.metrics.reported_market_value.exclusion_reasons));
  assert.ok(Object.isFrozen(r.metrics.reported_site_area.part_counts));assert.deepEqual(f.original,before);
});
test('all five exclusive original value states survive lossy retained nulls; incomplete observed is not eligible observed',()=>{
  const seen=[];
  for(const state of STATES){
    const original=source(),c=original.observations.reported_residential_area;
    if(state!=='observed')Object.assign(c,{state,exact_value:null,unit:null,observed_part_count:state==='conflicting'?'2':'0',
      missing_part_count:state==='missing'?'2':'0',invalid_part_count:state==='invalid'?'2':'0',
      unsupported_part_count:state==='unsupported'?'2':'0',conflict_values:state==='conflicting'?['9007199254740993.01','9007199254740993.02']:[]});
    const f=fixture(original),cell=f.run().metrics.reported_residential_area;seen.push(cell.reported_value_state);
    assert.equal(cell.recorded_comparison_eligible,state==='observed');
    assert.equal(cell.contribution_exact_value,state==='observed'?'9007199254740993.01':null);
    if(state!=='observed')assert.equal(f.row.metrics.reported_residential_area.exact_value,null,'null never determines original state');
  }
  assert.deepEqual(seen,['observed','missing','invalid','conflicting','unsupported']);
  for(const state of ['missing','invalid','unsupported']){
    const original=source(),c=original.observations.reported_residential_area;c.observed_part_count='1';c[`${state}_part_count`]='1';
    const f=fixture(original),cell=f.run().metrics.reported_residential_area;
    assert.equal(cell.reported_value_state,'observed');assert.equal(cell.complete_observed_parts,false);
    assert.equal(cell.recorded_comparison_eligible,false);assert.equal(cell.contribution_exact_value,null);
    assert.deepEqual(cell.exclusion_reasons,[`${state}_parts`]);assert.equal(cell.part_counts[state],1);
  }
});
test('housing exclusions remain separate from complete reported values and account-state denominators',()=>{
  for(const state of ['different','unresolved']){
    const original=source();if(state==='different')original.subject.category='detached_single_family';
    else original.subject={state:'missing',category:null};
    const r=fixture(original).run(),cell=r.metrics.reported_residential_area;
    assert.equal(r.housing_comparison,state);assert.equal(cell.reported_value_state,'observed');
    assert.equal(cell.complete_observed_parts,true);assert.equal(cell.recorded_comparison_eligible,false);
    assert.equal(cell.contribution_exact_value,null);assert.equal(cell.contribution_unit,null);
    assert.deepEqual(cell.exclusion_reasons,[state==='different'?'different_recorded_housing_category':'subject_housing_missing']);
  }
});
test('closed original/row/bindings reject mismatches, extra callbacks and hostile DATA without invoking getters',()=>{
  for(const mutate of [f=>f.row.metrics.reported_site_area.exact_value='1',f=>f.row.housing_comparison='different',
    f=>f.binding.metric_metadata.effective_date='2025-10-10',f=>f.original.subject.category='mobile_home',
    f=>f.original.observations.reported_site_area.source_part_count='1',
    f=>f.binding.metrics_reference.canonical_utf8_bytes='16001',f=>f.binding.metric_row_reference.canonical_utf8_bytes='4097',
    f=>f.binding.policy=POLICY,f=>f.original.reader=()=>assert.fail('callback'),
    f=>f.original.observations.reported_site_area.state='eligible',f=>f.row.metrics.reported_market_value.unit='USD']){
    const f=fixture();mutate(f);assert.throws(()=>f.run(),/original_mismatch/);
  }
  let calls=0;const trap=()=>{calls++;throw Error('trap');};
  for(const mutate of [f=>Object.defineProperty(f.original.observations.reported_site_area,'state',{enumerable:true,get:trap}),
    f=>f.original=new Proxy(f.original,{get:trap,getPrototypeOf:trap}),
    f=>Object.defineProperty(f.binding,'metric_row_reference',{enumerable:true,get:trap}),
    f=>f.row=new Proxy(f.row,{get:trap,getPrototypeOf:trap})]){
    const f=fixture();mutate(f);assert.throws(()=>prepare(f.original,f.row,f.binding),/original_mismatch/);
  }
  const f=fixture();assert.throws(()=>prepare(f.original,f.row,f.binding,trap),/original_mismatch/);assert.equal(calls,0);
});
test('actual owner derives contribution only AFTER native row matches fresh originals and BEFORE all ending fences',()=>{
  const text=readFileSync(new URL('../src/services/neighborhoodAssessment/customCohortContextCapture.js',import.meta.url),'utf8'),
    reconcile=text.indexOf('if(!same(row,metricRowCandidate))'),contribution=text.indexOf('statisticsContribution=prepareCohortSelectedStatisticsContributionV2(',reconcile),
    ending=text.indexOf('if(readingSelectedStatisticsSource&&!same(await metricsStore.read(),metricsAnchor))',contribution),
    returned=text.indexOf('if(readingSelectedUnionSubjectHousing)return freeze(subjectHousingResult)',ending);
  assert.ok(reconcile>0&&contribution>reconcile&&ending>contribution&&returned>ending);
  assert.ok(text.includes('observations:packet.observations},row,{metric_metadata:metricRowMetadata'));
  assert.ok(text.includes('statistics_contribution_candidate:statisticsContribution,statistics_contribution_retained:false'));
  const fixtureText=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8');
  for(const s of ['[native-first-selected-statistics-contribution-policy-v2]','one_state_per_selected_account_never_parts_or_overlapping_reasons:selectedCount>0',
    'incomplete_observed_distinct_from_invalid_conflicting_and_unsupported:selectedCount>0','contribution_not_retained:true'])assert.ok(fixtureText.includes(s),s);
});
