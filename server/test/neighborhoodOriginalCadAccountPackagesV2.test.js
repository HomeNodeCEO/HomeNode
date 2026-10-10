import assert from 'node:assert/strict';
import test from 'node:test';
import { compileNeighborhoodFrozenTypedCadImprovementV1 as compile } from '../src/services/neighborhoodAssessment/neighborhoodFrozenTypedCadImprovementV1.js';
import { reconcileNeighborhoodOriginalCadAccountPackageV2 as replay,prepareNeighborhoodOriginalCadAccountPackagePageV2 as prepare,
  NEIGHBORHOOD_ORIGINAL_CAD_ACCOUNT_PACKAGE_V2_SQL as SQL,getNeighborhoodOriginalCadAccountPackageV2Profile }
  from '../src/services/neighborhoodAssessment/neighborhoodOriginalCadAccountPackagesV2.js';

const PAGE={cursor:''},DATE='2026-10-07';
/** Synthetic originals exercise syntax/replay, never licensed source authority. */
function original(kind,id='A',changes={}){
  const payload=kind==='primary'?{account_id:'A',year_built:'2050',living_area_sqft:'9007199254740993.01',
    bedroom_count:'3',bath_count:'2.50',number_units:'1',pool:false,...changes}
    :{id,account_id:'A',sec_imp_number:'1',sec_imp_type:'UNMAPPED garage?',sec_imp_sqft:'12.50',...changes};
  const original_text=JSON.stringify(payload),typed=compile({kind,row_key:id,payload_text:original_text});
  return {kind,row_key:id,account_id:'A',original_text,payload_sha256:typed.original.payload_sha256,
    payload_utf8_bytes:String(typed.original.payload_utf8_bytes),cached_account_id:'A',original_payload_sha256:typed.original.payload_sha256,typed};
}
/** Native counts/stock envelope are DATA here; only actual owner SQL authenticates. */
function packet(rows,account_id='A'){
  rows.sort((a,b)=>Buffer.compare(Buffer.from(`${a.kind}:${a.row_key}`),Buffer.from(`${b.kind}:${b.row_key}`)));
  return {account_id,geographic_parcel_count:account_id===null?null:'2',counts:Object.fromEntries(['primary','secondary'].map(k=>[k,String(rows.filter(r=>r.kind===k).length)])),
    row_count:rows.length,invalid_count:0,packet_oversize:false,packet_json:JSON.stringify(rows)};
}
const complete=()=>packet([original('primary'),original('secondary','9007199254740993'),original('secondary','9007199254740994')]);

test('whole CAD originals replay before retained year; exact false/units and duplicate secondary numbers survive without alias inference',()=>{
  let checks=0;const p=replay(complete(),PAGE,DATE,()=>checks++),a=p.rows[0];assert.ok(checks>=8);
  assert.equal(p.next_cursor,'A');assert.equal(p.end_of_accounts,false);
  assert.equal(a.observations.reported_year_built.reason,'year_after_retained_effective_year');
  assert.equal(a.primary.typed.observations.reported_year_built.exact_value,'2050','neutral cache syntax is not rewritten');
  assert.equal(a.observations.reported_living_area.exact_value,'9007199254740993.01');
  assert.equal(a.observations.reported_baths.exact_value,'2.5');assert.equal(a.observations.reported_baths.unit,'CAD_reported_baths');
  assert.equal(a.observations.reported_pool_flag.exact_value,false);assert.equal(a.observations.reported_pool_flag.state,'observed');
  assert.deepEqual(a.secondary_originals.map(r=>r.row_key),['9007199254740993','9007199254740994']);
  assert.ok(a.secondary_originals.every(r=>r.typed.observations.reported_improvement_number.exact_value==='1'));
  assert.equal(a.secondary_type_resolution,'not_established');assert.equal(a.housing_eligibility,'not_established');
  assert.doesNotMatch(JSON.stringify(p),/original_text|cached_account_id|payload_utf8_bytes":"/);
  assert.equal(replay(complete(),PAGE,'2050-01-01',()=>{}).rows[0].observations.reported_year_built.exact_value,'2050');
});

test('CAD primary absence retains stock denominator; NULL never becomes observed false or no amenity',()=>{
  const absent=replay(packet([original('secondary','1')]),PAGE,DATE,()=>{}).rows[0];
  assert.equal(absent.primary_original_count,'0');assert.equal(absent.primary,null);assert.equal(absent.secondary_original_count,'1');
  for(const c of Object.values(absent.observations))assert.deepEqual(c,{state:'missing',exact_value:null,unit:null,reason:'primary_original_absent'});
  for(const pool of [null,false,true,'false','']){
    const r=original('primary','A',{pool}),a=replay(packet([r]),PAGE,DATE,()=>{}).rows[0];
    assert.deepEqual(a.observations.reported_pool_flag,(({state,exact_value,unit,reason})=>({state,exact_value,unit,reason}))(r.typed.observations.reported_pool_flag));
  }
  const emptyAccount=replay(packet([]),PAGE,DATE,()=>{});assert.equal(emptyAccount.rows.length,1);assert.equal(emptyAccount.end_of_accounts,false);
  const end=replay(packet([],null),{cursor:'A'},DATE,()=>{});assert.deepEqual(end,{rows:[],next_cursor:'A',end_of_accounts:true});
});

test('matching counts and hashes cannot launder CAD originals, entire caches, native identities or original byte evidence',()=>{
  for(const mutate of [r=>r.typed.observations.reported_baths.exact_value='3',r=>r.original_text=r.original_text.replace('2050','2040'),
    r=>r.payload_sha256='a'.repeat(64),r=>r.payload_utf8_bytes='1',r=>r.original_payload_sha256='a'.repeat(64),
    r=>r.typed.original.payload_utf8_bytes=1,r=>r.cached_account_id='FOREIGN',r=>r.account_id='FOREIGN',r=>r.typed=null]){
    const raw=complete(),rows=JSON.parse(raw.packet_json);mutate(rows[0]);raw.packet_json=JSON.stringify(rows);
    assert.throws(()=>replay(raw,PAGE,DATE,()=>{}),/original_mismatch|invalid_original/);
  }
  const raw=complete(),rows=JSON.parse(raw.packet_json);rows[2]=rows[1];raw.packet_json=JSON.stringify(rows);
  assert.throws(()=>replay(raw,PAGE,DATE,()=>{}),/invalid_order/);
  assert.throws(()=>replay({...complete(),invalid_count:1},PAGE,DATE,()=>{}),/invalid_result/);
});

test('complete CAD total250, whole251 and every byte gate refuse prefixes; native primary multiplicity and malformed counts fail',()=>{
  const full=packet([original('primary'),...Array.from({length:249},(_,i)=>original('secondary',String(i+1)))]);
  assert.equal(replay(full,PAGE,DATE,()=>{}).rows[0].secondary_originals.length,249);
  assert.throws(()=>replay({...packet([]),counts:{primary:'1',secondary:'250'}},PAGE,DATE,()=>{}),/row_limit/);
  assert.throws(()=>replay({...complete(),counts:{primary:'2',secondary:'1'}},PAGE,DATE,()=>{}),/invalid_counts/);
  assert.throws(()=>replay({...complete(),counts:{primary:'1',secondary:'252'}},PAGE,DATE,()=>{}),/invalid_counts/);
  assert.throws(()=>replay({...complete(),packet_oversize:true,packet_json:'[]'},PAGE,DATE,()=>{}),/byte_limit/);
  const huge=original('primary');huge.original_text='x'.repeat(1000001);
  assert.throws(()=>replay(packet([huge]),PAGE,DATE,()=>{}),/invalid_original/);
  assert.throws(()=>replay({...complete(),geographic_parcel_count:'0'},PAGE,DATE,()=>{}),/invalid_result/);
  assert.throws(()=>replay(complete(),{cursor:'A'},DATE,()=>{}),/invalid_result/);
});

test('closed CAD DATA inputs, single fixed original indexed query and cancellation admit no caller facts or dictionary authority',()=>{
  for(const bad of [new Proxy(PAGE,{}),{...PAGE,rowLimit:250},{...PAGE,effective_date:DATE},{...PAGE,account_ids:['A']},
    {...PAGE,get cursor(){assert.fail('getter');}}])assert.throws(()=>prepare(bad),/invalid_/);
  for(const bad of [new Proxy(complete(),{}),{...complete(),extra:1},{...complete(),get counts(){assert.fail('getter');}}])
    assert.throws(()=>replay(bad,PAGE,DATE,()=>{}),/invalid_input/);
  assert.throws(()=>replay(complete(),PAGE,DATE,()=>{throw Error('cancelled');}),/cancelled/);
  assert.match(SQL,/LIMIT \(\$5::integer\+1\)/);assert.match(SQL,/\(SELECT sum\(n\) FROM totals\)<=\$5::integer/);
  assert.match(SQL,/LEFT JOIN LATERAL/);assert.match(SQL,/ORDER BY account_id LIMIT 1/);
  assert.doesNotMatch(SQL,/FROM (?:core|gis)\.|ST_DWithin|INSERT|UPDATE|DELETE|AVG\(/);
  assert.equal(getNeighborhoodOriginalCadAccountPackageV2Profile().profile_ref.id,'neighborhood-original-CAD-account-packages-v2');
});
