import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeCohortDiagnosticCompressedJsonV1 as encode } from '../src/services/neighborhoodAssessment/cohortDiagnosticCompressedJsonV1.js';
import { encodeCohortDiagnosticFieldTuplesV2 as v2 } from '../src/services/neighborhoodAssessment/cohortDiagnosticFieldTuplesV2.js';
import { expandCohortDiagnosticCompressedJsonV1 as expand } from './helpers/expandCohortDiagnosticCompressedJsonV1.js';

test('compressed diagnostics preserve the complete V2 JSON without mutating either source or V2',()=>{
  const raw={rows:Array.from({length:250},(_,n)=>({native_key:String(9007199254740993n+BigInt(n)),
    exact_value:`${9007199254740993n+BigInt(n)}.01`,reason:'currency and economic equivalence not established',
    markers:{null:null,missing:false,text:'😀 exact Unicode'},values:[-2,0,[-1,3],true,null]})),
    a:{first:1,second:2},b:{second:2,first:1}},before=JSON.stringify(raw),legacy=v2(raw),packed=encode(raw);
  assert.deepEqual(expand(JSON.parse(JSON.stringify(packed))),raw);
  assert.deepEqual(encode(raw),packed);assert.deepEqual(v2(raw),legacy);assert.equal(JSON.stringify(raw),before);
  assert.deepEqual(Object.keys(expand(packed).b),['second','first']);assert.ok(Object.isFrozen(packed));
  assert.ok(Buffer.byteLength(JSON.stringify(packed))<16000);
  assert.ok(Buffer.byteLength(JSON.stringify(packed))<Buffer.byteLength(JSON.stringify(legacy))*0.25);
});

test('compressor retains fixed closed input bounds and never invokes getters or proxies',()=>{
  let calls=0;const getter=Object.defineProperty({},'x',{enumerable:true,get(){calls++;throw Error('executed');}}),
    proxy=new Proxy({},{ownKeys(){calls++;throw Error('executed');}});
  for(const raw of [getter,proxy,{x:undefined},'x'.repeat(2100001),[()=>{}]])assert.throws(()=>encode(raw),/invalid_data/);
  assert.equal(calls,0);
});

test('test-only decoder enforces exact length and a fixed expansion bound, not a caller size claim',()=>{
  const packed=encode({long:'retained diagnostic '.repeat(1000)});
  for(const raw of [{...packed,uncompressed_utf8_bytes:0},{...packed,uncompressed_utf8_bytes:2100001},
    {...packed,uncompressed_utf8_bytes:packed.uncompressed_utf8_bytes-1},
    {...packed,uncompressed_utf8_bytes:packed.uncompressed_utf8_bytes+1},{...packed,data:packed.data+'!'},
    {...packed,encoding:'gzip'}])assert.throws(()=>expand(raw));
  assert.deepEqual(expand(packed),{long:'retained diagnostic '.repeat(1000)});
});
