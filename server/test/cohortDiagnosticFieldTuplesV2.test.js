import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeCohortDiagnosticFieldTuplesV1 as v1 } from '../src/services/neighborhoodAssessment/cohortDiagnosticFieldTuplesV1.js';
import { encodeCohortDiagnosticFieldTuplesV2 as encode } from '../src/services/neighborhoodAssessment/cohortDiagnosticFieldTuplesV2.js';
import { expandCohortDiagnosticFieldTuplesV2 as expand } from './helpers/expandCohortDiagnosticFieldTuplesV2.js';

test('V2 interns repeated strings losslessly without changing V1 or array/number/string identity',()=>{
  const repeated='same whole original diagnostic retained exactly 😀',
    raw={first:repeated,second:repeated,unique:'unique exact scalar string preserved',
      values:[-2,0,[-2,0],repeated,null,false,'9007199254740993.01','9007199254740993.01'],
      a:{first:1,second:2},b:{second:2,first:1}};
  const legacy=v1(raw),packed=encode(raw);
  assert.deepEqual(v1(raw),legacy);assert.equal(legacy.format,'cohort_diagnostic_field_tuples_v1');
  assert.deepEqual(expand(JSON.parse(JSON.stringify(packed))),raw);
  assert.deepEqual(packed.string_table,[repeated,'9007199254740993.01']);
  assert.deepEqual(encode(raw),packed);assert.ok(Object.isFrozen(packed.string_table)&&Object.isFrozen(packed.value));
  assert.deepEqual(Object.keys(expand(packed).b),['second','first']);
  assert.ok(!Object.hasOwn(raw,'format'));
});

test('repeated complete long diagnostics and distinct numeric strings stay exact within the fixed response scale',()=>{
  const raw={rows:Array.from({length:40},(_,n)=>({native_key:String(9007199254740993n+BigInt(n)),
    diagnostic:'current_retained_local_reported_inventory_not_verified_dictionary_or_historical'.repeat(4),
    evidence:{state:'unsupported',reason:'source does not establish currency or economic transaction equivalence',
      exact_value:`${9007199254740993n+BigInt(n)}.01`,unit:'unverified_local_reported_unit'}}))},packed=encode(raw);
  assert.deepEqual(expand(JSON.parse(JSON.stringify(packed))),raw);
  assert.equal(expand(packed).rows.length,40);
  assert.ok(Buffer.byteLength(JSON.stringify(packed))<Buffer.byteLength(JSON.stringify(v1(raw)))*0.5);
  assert.ok(Buffer.byteLength(JSON.stringify(packed))<=16000);
});

test('string dictionary is bounded and full overflow values remain inline rather than omitted',()=>{
  const strings=Array.from({length:4100},(_,n)=>`distinct_long_scalar_${n}`),raw=[strings,strings],packed=encode(raw);
  assert.equal(packed.string_table.length,4096);assert.deepEqual(expand(packed),raw);
});

test('V2 inherits closed JSON admission without invoking getters/proxies or widening byte/depth bounds',()=>{
  let touched=0;const getter=Object.defineProperty({},'bad',{enumerable:true,get(){touched++;throw Error('executed');}}),
    proxy=new Proxy({},{ownKeys(){touched++;throw Error('executed');}});
  for(const value of [getter,proxy,{bad:undefined},'x'.repeat(2100001),[-2,()=>{}]])assert.throws(()=>encode(value),/invalid_data/);
  assert.equal(touched,0);
});
