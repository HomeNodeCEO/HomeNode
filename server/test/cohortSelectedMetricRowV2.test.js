import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareCohortSelectedMetricRowV2 as prepare, SELECTED_REPORTED_METRIC_ROW_V2_BASIS as BASIS,
  SELECTED_REPORTED_METRIC_ROW_V2_MAX_BYTES as MAX_BYTES }
  from '../src/services/neighborhoodAssessment/cohortSelectedMetricRowV2.js';

// Synthetic closed DATA tests only: these establish no native membership,
// original reconciliation, current authorization, retained dates or population.
const ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'});
const metadata=()=>({command_id:'70000000-0000-4000-8000-000000000001',union_reference:ref(1),
  eligibility_reference:ref(2),evidence_reference:ref(3),selected_entry:{account_id:'B',ordinal:1,
    partition_ordinal:2,entry_reference:ref(4)},effective_date:'2026-10-10',
  observation_period:{start_date:'2025-10-01',end_date:'2026-09-30'},
  subject_housing:{state:'observed',category:'townhouse'},housing_comparison:'matching'});
const cell=(value,unit,eligible=true)=>({recorded_comparison_eligible:eligible,
  complete_observed_parts:value!==null,exact_value:value,unit});
const missing=()=>cell(null,null,false);
const raw=()=>({format:'cohort_selected_reported_metric_row_v2',...metadata(),metrics:{
  reported_year_built:cell('2000','year'),reported_residential_area:cell('1234.125','reported_sqft'),
  reported_site_area:cell('0','reported_sqft'),reported_market_value:missing()},basis:BASIS});
const reject=r=>assert.throws(()=>prepare(r,metadata()),/cohort_selected_metric_row_v2_invalid_row/);

test('bounded closed row detaches exact decimal cells and metadata without claiming original or population authority',()=>{
  const input=raw(),expected=metadata(),row=prepare(input,expected);
  assert.deepEqual(row,input);assert.ok(Buffer.byteLength(json(row))<=MAX_BYTES);
  for(const part of [row,row.metrics,...Object.values(row.metrics),row.selected_entry,row.selected_entry.entry_reference,
    row.union_reference,row.eligibility_reference,row.evidence_reference,row.subject_housing,row.observation_period])
    assert.equal(Object.isFrozen(part),true);
  input.metrics.reported_site_area.exact_value='99';input.selected_entry.entry_reference.content_sha256='f'.repeat(64);
  expected.subject_housing.category='duplex';assert.equal(row.metrics.reported_site_area.exact_value,'0');
  assert.deepEqual(row.selected_entry.entry_reference,ref(4));assert.equal(row.subject_housing.category,'townhouse');
  assert.equal(Object.isFrozen(input),false);assert.equal(Object.isFrozen(expected),false);
  assert.equal(row.authority,undefined);assert.equal(row.complete_selected_union_metric_population,undefined);
});

test('all native-parent, selected-entry and retained date/housing bindings must equal expected metadata',()=>{
  for(const key of ['union_reference','eligibility_reference','evidence_reference'])reject({...raw(),[key]:ref(7)});
  reject({...raw(),command_id:'70000000-0000-4000-8000-000000000002'});
  for(const [key,value] of [['account_id','A'],['ordinal',2],['partition_ordinal',1],['entry_reference',ref(8)]])
    reject({...raw(),selected_entry:{...metadata().selected_entry,[key]:value}});
  reject({...raw(),effective_date:'2026-10-09'});
  reject({...raw(),observation_period:{...metadata().observation_period,end_date:'2026-09-29'}});
  reject({...raw(),subject_housing:{state:'observed',category:'duplex'}});
  reject({...raw(),housing_comparison:'different'});
});

test('plain own DATA grammar rejects hostile descriptors and proxies before executing application code',()=>{
  const getter=()=>assert.fail('must not evaluate getter'),proxy=v=>new Proxy(v,{getPrototypeOf:getter,get:getter,ownKeys:getter});
  reject(proxy(raw()));reject({...raw(),get metrics(){return getter();}});
  reject({...raw(),metrics:proxy(raw().metrics)});
  reject({...raw(),metrics:{...raw().metrics,reported_site_area:{...missing(),get exact_value(){return getter();}}}});
  reject({...raw(),selected_entry:{...metadata().selected_entry,get account_id(){return getter();}}});
  reject({...raw(),subject_housing:proxy(metadata().subject_housing)});
  reject({...raw(),observation_period:{get start_date(){return getter();},end_date:'2026-09-30'}});
  reject({...raw(),evidence_reference:{get content_sha256(){return getter();},canonical_utf8_bytes:'123'}});
  for(const expected of [proxy(metadata()),{...metadata(),get effective_date(){return getter();}},
    {...metadata(),union_reference:proxy(ref(1))}])assert.throws(()=>prepare(raw(),expected),/invalid_row/);
});

test('incomplete values remain null, genuine site zero survives and currency never becomes supported',()=>{
  const input=raw();input.metrics.reported_year_built=missing();input.metrics.reported_residential_area=missing();
  const row=prepare(input,metadata());assert.equal(row.metrics.reported_year_built.exact_value,null);
  assert.equal(row.metrics.reported_residential_area.exact_value,null);assert.equal(row.metrics.reported_site_area.exact_value,'0');
  for(const key of ['reported_year_built','reported_residential_area','reported_site_area','reported_market_value']){
    reject({...raw(),metrics:{...raw().metrics,[key]:{...missing(),exact_value:'0'}}});
    reject({...raw(),metrics:{...raw().metrics,[key]:{...missing(),unit:'reported_sqft'}}});
  }
  reject({...raw(),metrics:{...raw().metrics,reported_residential_area:cell('0','reported_sqft')}});
  reject({...raw(),metrics:{...raw().metrics,reported_market_value:cell('1',null)}});
  reject({...raw(),metrics:{...raw().metrics,reported_market_value:cell('1','USD')}});
});

test('exact positive decimals are not rounded; noncanonical, unbounded and future-year values fail closed',()=>{
  const value='123456789012345678.123456789123',input=raw();
  input.metrics.reported_site_area=cell(value,'reported_sqft');assert.equal(prepare(input,metadata()).metrics.reported_site_area.exact_value,value);
  for(const value of [0,1n,NaN,Infinity,'-1','+1','01','1.0','1.','1e3','.1','0.0000000000001',
    '1234567890123456789012345678901','1234567890123456789.123456789123'])
    reject({...raw(),metrics:{...raw().metrics,reported_site_area:cell(value,'reported_sqft')}});
  for(const value of ['0','1599','2027','2000.1'])reject({...raw(),metrics:{...raw().metrics,reported_year_built:cell(value,'year')}});
  reject({...raw(),metrics:{...raw().metrics,reported_site_area:cell('1','sqft')}});
});

test('known different or unresolved housing retains complete cells but cannot mark them comparison-eligible',()=>{
  for(const housing_comparison of ['different','unresolved']){
    const expected={...metadata(),housing_comparison},input={...raw(),...expected};
    for(const c of Object.values(input.metrics))c.recorded_comparison_eligible=false;
    const row=prepare(input,expected);assert.equal(row.metrics.reported_site_area.exact_value,'0');
    assert.equal(row.metrics.reported_site_area.complete_observed_parts,true);
    assert.equal(row.metrics.reported_site_area.recorded_comparison_eligible,false);
    assert.throws(()=>prepare({...input,metrics:{...input.metrics,reported_site_area:cell('0','reported_sqft')}},expected),/invalid_row/);
  }
  for(const state of ['missing','unknown','partial','conflicting']){
    const expected={...metadata(),subject_housing:{state,category:null},housing_comparison:'unresolved'},input={...raw(),...expected};
    for(const c of Object.values(input.metrics))c.recorded_comparison_eligible=false;
    assert.equal(prepare(input,expected).subject_housing.state,state);
    assert.throws(()=>prepare({...input,housing_comparison:'matching'},{...expected,housing_comparison:'matching'}),/invalid_row/);
  }
  reject({...raw(),metrics:{...raw().metrics,reported_site_area:cell('0','reported_sqft',false)}});
  reject({...raw(),metrics:{...raw().metrics,reported_year_built:{...missing(),recorded_comparison_eligible:true}}});
});

test('closed row rejects free progress, callbacks, payload copies, extra/missing/symbol/nonenumerable keys and wrong arity',()=>{
  for(const [key,value] of [['done',true],['statistics',{}],['account_ids',['A','B']],['readOriginal',()=>{}],['payload',{}]])
    reject({...raw(),[key]:value});
  reject({...raw(),metrics:{...raw().metrics,median:'1'}});reject({...raw(),selected_entry:{...metadata().selected_entry,state:'unassigned'}});
  reject({...raw(),format:'other'});reject({...raw(),basis:'verified'});reject({...raw(),[Symbol('hidden')]:1});
  const hidden=raw();Object.defineProperty(hidden,'hidden',{value:1});reject(hidden);
  const removed=raw();delete removed.metrics.reported_market_value;reject(removed);
  const inherited=Object.create(raw());reject(inherited);
  for(const input of [null,[],new Date(),()=>{},'row'])reject(input);
  assert.throws(()=>prepare(raw()),/invalid_row/);assert.throws(()=>prepare(raw(),metadata(),{}),/invalid_row/);
});

test('primitive calendar dates, UUID, exact ref sizes and ordinal limits refuse coercion or invalid representations',()=>{
  const variants=[{command_id:'bad'},{effective_date:'2026-02-30'},
    {observation_period:{start_date:'2026-10-10',end_date:'2026-01-01'}},
    {effective_date:{toString(){assert.fail('coercion');}}},{subject_housing:{state:'observed',category:'single_family'}},
    {housing_comparison:'verified'},...['',' B','B\ud800','B\u0000','B'.repeat(65)].map(account_id=>({selected_entry:{...metadata().selected_entry,account_id}})),
    ...[0,-1,2000001,1.5,'1'].map(ordinal=>({selected_entry:{...metadata().selected_entry,ordinal}})),
    ...['0','0123',123,'16001'].map(canonical_utf8_bytes=>({union_reference:{...ref(1),canonical_utf8_bytes}})),
    {selected_entry:{...metadata().selected_entry,entry_reference:{...ref(4),canonical_utf8_bytes:'1000001'}}}];
  for(const variant of variants){const expected={...metadata(),...variant};assert.throws(()=>prepare({...raw(),...expected},expected),/invalid_row/);}
});
