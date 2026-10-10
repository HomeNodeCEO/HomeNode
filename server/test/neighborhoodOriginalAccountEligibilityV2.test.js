import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNeighborhoodOriginalAccountEligibilityV2 as resolve }
  from '../src/services/neighborhoodAssessment/neighborhoodOriginalAccountEligibilityV2.js';

const metric=(value,unit)=>({state:unit===null?'unsupported':'observed',exact_value:value,unit,
  source_part_count:'2',observed_part_count:unit===null?'0':'2',missing_part_count:'0',invalid_part_count:'0',
  unsupported_part_count:unit===null?'2':'0',conflict_values:[]});
function fixture(){return {subject:{state:'observed',category:'townhouse'},
  housing:{state:'observed',category:'townhouse',county_state:'observed',source_part_count:'2',
    part_states:{observed:'2',missing:'0',unknown:'0',partial:'0',conflicting:'0'}},
  original_counts:{parcels:2,accounts:1},observations:{reported_year_built:metric('1960','year'),
    reported_residential_area:metric('9007199254740993.01','reported_sqft'),reported_site_area:metric('0','reported_sqft'),
    reported_market_value:metric('9007199254740993',null)}};}

test('recorded comparison requires exact known housing and all equal observed parts; currency stays unsupported',()=>{
  const input=fixture(),before=structuredClone(input),r=resolve(input);
  assert.equal(r.housing.matches_subject,true);assert.equal(r.housing.state,'matching');
  for(const name of ['reported_year_built','reported_residential_area','reported_site_area']){
    assert.equal(r.metrics[name].recorded_comparison_eligible,true);assert.equal(r.metrics[name].complete_observed_parts,true);
  }
  assert.equal(r.metrics.reported_residential_area.exact_value,'9007199254740993.01','exact distinct value is not summed');
  assert.equal(r.metrics.reported_site_area.exact_value,'0','recorded zero site area is not a missing value');
  assert.equal(r.metrics.reported_market_value.recorded_comparison_eligible,false);
  assert.equal(r.metrics.reported_market_value.exact_value,null);
  assert.deepEqual(r.metrics.reported_market_value.reasons,['recorded_value_unsupported','unsupported_parts','currency_not_established']);
  assert.equal(r.authority,'not_established');assert.equal(r.issued_eligibility_progress,false);
  assert.equal(r.complete_selected_union_eligibility,false);assert.equal(r.economic_unit,'not_established');
  assert.equal(r.statistics,'not_established');assert.equal(r.publication,'not_established');assert.equal(r.report_update,'none');
  assert.deepEqual(input,before);assert.ok(Object.isFrozen(r.metrics.reported_year_built.part_counts));
});
test('observed aggregate with missing, invalid or unsupported parts cannot become a complete metric',()=>{
  for(const state of ['missing','invalid','unsupported']){
    const input=fixture(),c=input.observations.reported_year_built;
    c.observed_part_count='1';c[`${state}_part_count`]='1';
    const r=resolve(input).metrics.reported_year_built;
    assert.equal(r.recorded_comparison_eligible,false);assert.equal(r.complete_observed_parts,false);
    assert.equal(r.exact_value,null);assert.equal(r.unit,null);assert.deepEqual(r.reasons,[`${state}_parts`]);
    assert.equal(r.part_counts[state],1);assert.equal(r.part_counts.observed,1);
  }
  const input=fixture(),c=input.observations.reported_residential_area;
  Object.assign(c,{state:'conflicting',exact_value:null,unit:null,conflict_values:['9007199254740993.01','9007199254740993.02']});
  assert.deepEqual(resolve(input).metrics.reported_residential_area.reasons,['recorded_value_conflicting']);
  const oversize=fixture(),o=oversize.observations.reported_year_built;
  Object.assign(o,{state:'unsupported',exact_value:null,unit:null,observed_part_count:'0',unsupported_part_count:'2'});
  assert.deepEqual(resolve(oversize).metrics.reported_year_built.reasons,['recorded_value_unsupported','unsupported_parts']);
});
test('every unresolved subject/account reason survives; known different categories are never merged',()=>{
  for(const state of ['missing','unknown','partial','conflicting']){
    const input=fixture();input.subject={state,category:null};
    const r=resolve(input);assert.equal(r.housing.matches_subject,false);
    assert.deepEqual(r.housing.reasons,[`subject_housing_${state}`]);
    assert.ok(Object.values(r.metrics).every(c=>!c.recorded_comparison_eligible));
    input.housing.state=state;input.housing.category=null;input.housing.part_states.observed='0';input.housing.part_states[state]='2';
    assert.deepEqual(resolve(input).housing.reasons,[`subject_housing_${state}`,`account_housing_${state}`]);
  }
  const different=fixture();different.subject.category='manufactured_home';different.housing.category='mobile_home';
  assert.deepEqual(resolve(different).housing,{matches_subject:false,state:'different',reasons:['different_recorded_housing_category']});
});
test('closed bounded denominators and own DATA reject malformed inputs without invoking getters or proxies',()=>{
  for(const mutate of [i=>i.original_counts.parcels=251,i=>i.original_counts.accounts=2,
    i=>i.housing.source_part_count='1',i=>i.housing.part_states.missing='1',i=>i.housing.county_state='unknown',
    i=>i.original_counts.accounts=0,i=>i.subject.category='unknown',i=>i.subject.extra=true,
    i=>i.observations.reported_year_built.source_part_count='1',i=>i.observations.reported_year_built.observed_part_count='3',
    i=>i.observations.reported_year_built.exact_value='1e3',i=>i.observations.reported_year_built.exact_value='1960.0',
    i=>i.observations.reported_residential_area.exact_value='0',i=>i.observations.reported_market_value.unit='USD',
    i=>i.reader=()=>assert.fail('no caller source reader')]){
    const input=fixture();mutate(input);assert.throws(()=>resolve(input),/invalid_input/);
  }
  let calls=0;const trap=()=>{calls++;throw Error('trap');};
  const input=fixture();Object.defineProperty(input.observations.reported_year_built,'exact_value',{enumerable:true,get:trap});
  assert.throws(()=>resolve(input),/invalid_input/);
  for(const value of [new Proxy(fixture(),{get:trap,getPrototypeOf:trap}),new Proxy(fixture(),{})])
    assert.throws(()=>resolve(value),/invalid_input/);
  const conflict=fixture();Object.assign(conflict.observations.reported_year_built,{state:'conflicting',exact_value:null,unit:null});
  const a=['1960','1961'];Object.defineProperty(a,'0',{get:trap,enumerable:true});
  conflict.observations.reported_year_built.conflict_values=a;assert.throws(()=>resolve(conflict),/invalid_input/);
  assert.equal(calls,0);
  assert.throws(()=>resolve(fixture(),trap),/invalid_input/);assert.equal(calls,0);
});
