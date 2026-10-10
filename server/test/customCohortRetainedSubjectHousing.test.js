import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCustomCohortRetainedSubjectHousing as resolve }
  from '../src/services/neighborhoodAssessment/customCohortRetainedSubjectHousing.js';
import { NEIGHBORHOOD_STOCK_ACCOUNT_PACKAGE_V2_SQL as stockSQL,
  NEIGHBORHOOD_STOCK_SUBJECT_HOUSING_PACKAGE_V2_SQL as subjectSQL }
  from '../src/services/neighborhoodAssessment/neighborhoodSharedStockOriginalCellsV2.js';

const target={account_id:'SUBJECT-Z',assignment_file_id:'7',report_file_id:'report'},
  cell=value=>({state:value===undefined?'absent':value===null?'json_null':'present',value:value??null}),
  node=(type,style,attachment)=>({state:'present',value:{housing_type:cell(type),structural_style:cell(style),attachment_type:cell(attachment)}}),
  absent={state:'absent'},nullNode={state:'json_null'},
  material=(saved=absent,publicNode=absent)=>({material_input_version:1,workflow_type:'custom_appraisal',
    profile_id:'custom-neighborhood-physical-stock-inputs-v1',profile_revision:'1',...target,
    assignment_sections:{property_characteristics:{storage_state:'object',projection:{housing_profile:saved}}},
    retained_public:{housing_profile:publicNode}});

test('retained precedence uses saved then retained-public; ONLY absence requests original CAD',()=>{
  assert.equal(resolve(material(),target),null);
  assert.equal(resolve(material(node()),target),null);
  assert.deepEqual(resolve(material(absent,node('Townhouse')),target),{state:'observed',category:'townhouse',origin:'retained_subject_public'});
  assert.deepEqual(resolve(material(node('Duplex'),node('Townhouse')),target),{state:'observed',category:'duplex',origin:'saved_subject'});
  for(const saved of [nullNode,node(null),node(''),node('  ')])assert.deepEqual(resolve(material(saved,node('Townhouse')),target),
    {state:'missing',category:null,origin:'saved_subject'});
  for(const saved of [node('OTHER'),node('unknown'),node('not mapped','Townhouse'),node(undefined,undefined,'DETACHED')])
    assert.deepEqual(resolve(material(saved,node('Townhouse')),target),{state:'unknown',category:null,origin:'saved_subject'});
});
test('generic single family requires detached; categories, conflicts and alternatives remain distinct',()=>{
  for(const [type,style,attachment,state,category] of [
    ['Single Family',undefined,'DETACHED','observed','detached_single_family'],
    ['Single Family',undefined,'ATTACHED','unknown',null],
    ['Single Family',undefined,undefined,'unknown',null],
    ['Townhouse',undefined,'DETACHED','conflicting',null],
    ['Detached Single Family','Duplex',undefined,'conflicting',null],
    ['Townhouse','CONDO/TOWNHOME',undefined,'unknown',null],
    ['Mobile Home',undefined,undefined,'observed','mobile_home'],
    ['Manufactured Home',undefined,undefined,'observed','manufactured_home'],
    [undefined,'Condominium',undefined,'observed','condominium'],
    ['Townhouse','unmapped supplementary',undefined,'observed','townhouse'],
  ])assert.deepEqual(resolve(material(node(type,style,attachment)),target),{state,category,origin:'saved_subject'});
});
test('material scope, state, byte and own-DATA guards never execute untrusted input',()=>{
  for(const key of ['account_id','report_file_id','assignment_file_id','workflow_type','profile_id','profile_revision','material_input_version']){
    const m=material();m[key]='different';assert.throws(()=>resolve(m,target),/invalid_material/);
  }
  for(const bad of ['x'.repeat(8193),'\ud800'])assert.throws(()=>resolve(material(node(bad)),target),/invalid_material/);
  let calls=0;const m=material();Object.defineProperty(m,'retained_public',{enumerable:true,get(){calls++;throw Error('getter');}});
  assert.throws(()=>resolve(m,target),/invalid_material/);
  const trap=()=>{calls++;throw Error('Proxy trap');},revoked=Proxy.revocable(material(),{});revoked.revoke();
  for(const value of [new Proxy(material(),{getPrototypeOf:trap,get:trap}),new Proxy(material(),{}),revoked.proxy])
    assert.throws(()=>resolve(value,target),/invalid_material/);
  assert.equal(calls,0);
  const original=material(node('townhouse'));let checks=0;resolve(original,target,{check(){checks++;}});
  assert.ok(checks>=2);assert.equal(original.assignment_sections.property_characteristics.projection.housing_profile.value.housing_type.value,'townhouse');
});
test('subject SQL keeps the complete bounded packet, but chooses exact native job subject',()=>{
  assert.match(subjectSQL,/job\.account_id FROM app\.neighborhood_custom_cohort_capture_jobs job/);
  assert.match(subjectSQL,/job\.operation_id=\$1::uuid AND job\.account_id=\$4::text/);
  assert.doesNotMatch(subjectSQL,/account_id>\$4/);
  assert.equal(subjectSQL.slice(subjectSQL.indexOf('), totals AS MATERIALIZED')),
    stockSQL.slice(stockSQL.indexOf('), totals AS MATERIALIZED')));
  assert.match(subjectSQL,/LIMIT \(\$5::integer\+1\)/);
});
