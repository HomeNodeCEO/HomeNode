import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compileNeighborhoodFrozenTypedCadImprovementV1 as compile,
  getNeighborhoodFrozenTypedCadImprovementV1Profile as profile }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenTypedCadImprovementV1.js';
import { getNeighborhoodFrozenCadImprovementProfile } from '../src/services/neighborhoodAssessment/neighborhoodFrozenCadImprovements.js';
import { getNeighborhoodFrozenTypedOriginalV1Profile,getNeighborhoodFrozenTypedOriginalV2Profile }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenTypedOriginalV1.js';
const primary={account_id:'A',year_built:'2050',living_area_sqft:'1000.000',bedroom_count:'3',bath_count:'2.500',number_units:'1',pool:true};
const secondary={id:'9007199254740993',account_id:'A',sec_imp_number:'1',sec_imp_type:'UNKNOWN GARAGE POOL STORAGE',sec_imp_sqft:'9007199254740993'};
const input=(payload=primary,kind='primary',row_key=kind==='primary'?payload.account_id:payload.id)=>({kind,row_key,payload_text:JSON.stringify(payload)});

test('new separate profile types exact primary literals and future year syntax without report policy',()=>{
  const i=input(),r=compile(i);assert.equal(r.temporal_basis,'date_neutral_original_syntax');
  assert.equal(r.observations.reported_year_built.exact_value,'2050');assert.equal(Object.hasOwn(r,'effective_date'),false);
  assert.equal(r.observations.reported_living_area.exact_value,'1000');assert.equal(r.observations.reported_living_area.unit,'reported_sqft');
  assert.equal(r.observations.reported_baths.exact_value,'2.5');assert.equal(r.observations.reported_pool_flag.exact_value,true);
  assert.equal(r.authority,'not_established');assert.equal(r.coverage,'one_original_only');
  assert.deepEqual(r.original.original_profile_ref,getNeighborhoodFrozenCadImprovementProfile().profile_ref);
  assert.equal(r.original.payload_sha256,createHash('sha256').update(i.payload_text).digest('hex'));
  assert.ok(Object.isFrozen(r.observations.reported_baths.raw));
  assert.equal(createHash('sha256').update(profile().definition_blob.canonical_json).digest('hex'),profile().profile_ref.content_sha256);
});
test('native secondary key and exact large area remain data, never type classification or garage sum',()=>{
  const r=compile(input(secondary,'secondary'));assert.equal(r.original.row_key,'9007199254740993');
  assert.equal(r.observations.reported_improvement_area.exact_value,'9007199254740993');
  assert.equal(r.markers.sec_imp_type.value_text,secondary.sec_imp_type);
  for(const key of ['garage_area','pool','amenities','classification','property_count','sale_price','statistics'])assert.equal(Object.hasOwn(r,key),false);
  const duplicate=compile(input({...secondary,id:'2'},'secondary'));
  assert.equal(duplicate.observations.reported_improvement_number.exact_value,r.observations.reported_improvement_number.exact_value);
  assert.notEqual(duplicate.original.row_key,r.original.row_key,'duplicate numbers never deduplicate native originals');
});
test('NULL, blanks, zero, false, invalid and oversized evidence remain distinct',()=>{
  for(const [value,state,exact] of [[null,'missing',null],['','missing',null],['0','invalid',null],['-0','invalid',null],
    ['1e3','invalid',null],['$1000','invalid',null],['1,000','invalid',null],['.5000','observed','0.5'],
    ['+000123.4500','observed','123.45'],['1'.repeat(129),'unsupported',null],[1000,'invalid',null],
    [true,'invalid',null],[{},'invalid',null],['1.1234567890123','invalid',null],['1'.repeat(31),'invalid',null]]){
    const c=compile(input({...primary,living_area_sqft:value})).observations.reported_living_area;
    assert.equal(c.state,state,JSON.stringify(value));assert.equal(c.exact_value,exact);
  }
  assert.equal(compile(input({...primary,bath_count:'0'})).observations.reported_baths.exact_value,'0');
  assert.equal(compile(input({...primary,pool:false})).observations.reported_pool_flag.exact_value,false);
  assert.equal(compile(input({...primary,pool:null})).observations.reported_pool_flag.state,'missing');
  for(const pool of ['true','false','Y','N','',0,1,{},[]])assert.equal(compile(input({...primary,pool})).observations.reported_pool_flag.state,'invalid');
});
test('strict count/year policies do not round fractional or over-int32 data',()=>{
  for(const year of ['1599','10000','1960.5','-0','2147483648',1960])assert.equal(compile(input({...primary,year_built:year})).observations.reported_year_built.state,'invalid');
  for(const field of ['bedroom_count','number_units']){
    for(const value of ['1.5','-1','2147483648',3])assert.equal(compile(input({...primary,[field]:value})).observations[field==='bedroom_count'?'reported_bedrooms':'reported_units'].state,'invalid');
    assert.equal(compile(input({...primary,[field]:'0'})).observations[field==='bedroom_count'?'reported_bedrooms':'reported_units'].exact_value,'0');
  }
});
test('wrong-type numeric diagnostics use original tokens, not rounded JSON.parse values',()=>{
  for(const field of ['bath_count','living_area_sqft','pool']){
    const i=input({...primary,[field]:'REPLACE'});i.payload_text=i.payload_text.replace('"REPLACE"','9007199254740993');
    const name=field==='bath_count'?'reported_baths':field==='pool'?'reported_pool_flag':'reported_living_area';
    const cell=compile(i).observations[name];assert.equal(cell.state,'invalid');assert.equal(cell.raw.value_text,'9007199254740993');
  }
});
test('bounded type markers are literal provenance, including unknown and oversized values',()=>{
  const r=compile(input({...secondary,sec_imp_type:'G'.repeat(2000)},'secondary'));
  assert.equal(r.markers.sec_imp_type.state,'oversize');assert.equal(r.markers.sec_imp_type.value_text,null);
  assert.equal(r.markers.sec_imp_type.utf8_bytes,2000);assert.equal(r.markers.sec_imp_type.value_sha256,createHash('sha256').update('G'.repeat(2000)).digest('hex'));
  assert.equal(compile(input({...secondary,sec_imp_type:null},'secondary')).markers.sec_imp_type.state,'json_null');
});
test('fixed original shape and exact account/native bigint identity are required',()=>{
  const absent={...primary};delete absent.pool;
  for(const i of [input(absent),input({...primary,extra:true}),input({...primary,account_id:' A'}),input({...primary,account_id:'A\n'}),
    input(primary,'primary','B'),input(secondary,'secondary','2'),input({...secondary,id:'01'},'secondary'),
    input({...secondary,id:'9223372036854775808'},'secondary'),input({...secondary,account_id:null},'secondary')])assert.throws(()=>compile(i),/mismatch/);
  for(const text of ['[]','{','{"account_id":"A","account_id":"B"}','{"account_id":"\\ud800"}'])assert.throws(()=>compile({...input(),payload_text:text}));
});
test('closed arguments refuse dates, caller mappings, proxies, accessors and oversized originals',()=>{
  let invoked=false;const getter=input();Object.defineProperty(getter,'kind',{enumerable:true,get(){invoked=true;throw Error('getter');}});
  const proxy=new Proxy(input(),{ownKeys(){invoked=true;throw Error('proxy');}});
  for(const i of [getter,proxy,{...input(),effective_date:'2020-01-01'},{...input(),mapping:{}},
    {...input(),payload_text:' '.repeat(1000001)},{...input(),kind:'accounts'},Object.assign(Object.create(null),input())])
    assert.throws(()=>compile(i),/invalid_input/);
  assert.equal(invoked,false);assert.throws(()=>compile(input(),'2020-01-01'),/invalid_input/);
});
test('legacy seven-kind V1 and neutral V2 profiles retain their exact pre-existing hashes',()=>{
  assert.equal(getNeighborhoodFrozenTypedOriginalV1Profile().profile_ref.content_sha256,
    '1912d3047cdaf95335e129a46bbde71da03797c3e0a8df3a6e12ce1d7ec0c8d6');
  assert.equal(getNeighborhoodFrozenTypedOriginalV2Profile().profile_ref.content_sha256,
    'e22fcfd0f909e2e774d43f440b79b0e9e5be9d8d94adde89b1fce047aec01301');
  const d=JSON.parse(getNeighborhoodFrozenTypedOriginalV2Profile().definition_blob.canonical_json);
  assert.ok(d.limitations.includes('missing_CAD_improvement_amenity_lineage'));
  assert.equal(d.id,'neighborhood-frozen-date-neutral-typed-original-v2');
});
