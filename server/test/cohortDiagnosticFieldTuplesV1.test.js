import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeCohortDiagnosticFieldTuplesV1 as encode } from '../src/services/neighborhoodAssessment/cohortDiagnosticFieldTuplesV1.js';
import { expandCohortDiagnosticFieldTuplesV1 as expand } from './helpers/expandCohortDiagnosticFieldTuplesV1.js';

test('field tuples round-trip every JSON observation, identity and ordered object/array shape',()=>{
  const raw={rows:[{kind:'primary',row_key:'9007199254740993',observations:{pool:{state:'observed',exact_value:false,unit:'boolean',reason:null},
    area:{state:'observed',exact_value:'9007199254740993.01',unit:'reported_sqft',reason:null}}},
    {kind:'secondary',row_key:'same-key',observations:{pool:{state:'missing',exact_value:null,unit:null,reason:'source_null'},
      area:{state:'conflicting',exact_value:null,unit:null,reason:'distinct_values'}}}],
    empty:[],nested:[[0,1,null,false,'-1'],{different_order:1,order:2},{order:2,different_order:1}],unicode:'é😀',authority:'not_established'};
  const packed=encode(raw),serialized=JSON.parse(JSON.stringify(packed));
  assert.deepEqual(expand(serialized),raw);assert.ok(Object.isFrozen(packed)&&Object.isFrozen(packed.field_tables)&&Object.isFrozen(packed.value));
  assert.equal(packed.field_tables.filter(keys=>JSON.stringify(keys)===JSON.stringify(['state','exact_value','unit','reason'])).length,1);
  assert.deepEqual(encode(raw),packed,'fixed traversal and shape numbering are deterministic');
  assert.ok(!Object.hasOwn(raw,'format'),'encoding never mutates original-reconciled diagnostics');
});

test('repeated complete diagnostic keys compact without truncating distinct rows or exact values',()=>{
  const rows=Array.from({length:250},(_,n)=>({kind:'sales',row_key:String(9007199254740993n+BigInt(n)),account_id:'DATA-only',
    observations:Object.fromEntries(['recorded_sale_price','reported_area','reported_year_built'].map(k=>[k,
      {state:'observed',exact_value:`${9007199254740993n+BigInt(n)}.01`,unit:'unverified_local_unit',reason:null}]))}));
  const raw={rows},packed=encode(raw);assert.deepEqual(expand(JSON.parse(JSON.stringify(packed))),raw);
  assert.ok(Buffer.byteLength(JSON.stringify(packed))<Buffer.byteLength(JSON.stringify(raw))*0.65);
  assert.equal(expand(packed).rows.length,250);assert.equal(expand(packed).rows[249].row_key,'9007199254741242');
});

test('presentation refuses executable, non-JSON, sparse, cyclic and over-budget DATA',()=>{
  let touched=0;const getter=Object.defineProperty({},'bad',{enumerable:true,get(){touched++;throw Error('executed');}}),
    proxy=new Proxy({},{ownKeys(){touched++;throw Error('executed');}}),cycle={};cycle.self=cycle;
  const hidden=Object.defineProperty({},'bad',{value:1}),symbol={[Symbol('bad')]:1},sparse=[];sparse.length=1;
  const extra=[];extra.bad=1;
  for(const value of [getter,proxy,cycle,hidden,symbol,sparse,extra,new Date(),new Map(),Object.create(null),undefined,1n,NaN,Infinity,
    {bad:undefined},{bad:()=>{}},'\ud800','x'.repeat(2100001),Array(100001).fill(null)])assert.throws(()=>encode(value),/invalid_data/);
  let deep=null;for(let i=0;i<50;i++)deep={child:deep};assert.throws(()=>encode(deep),/invalid_data/);assert.equal(touched,0);
});
