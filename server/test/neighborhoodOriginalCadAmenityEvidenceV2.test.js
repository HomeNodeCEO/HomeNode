import assert from 'node:assert/strict';
import test from 'node:test';
import { compileNeighborhoodFrozenTypedCadImprovementV1 as compile } from '../src/services/neighborhoodAssessment/neighborhoodFrozenTypedCadImprovementV1.js';
import { reconcileNeighborhoodOriginalCadAccountPackageV2 as replay } from '../src/services/neighborhoodAssessment/neighborhoodOriginalCadAccountPackagesV2.js';
import { resolveNeighborhoodOriginalCadAmenityEvidenceV2 as resolve,getNeighborhoodOriginalCadAmenityEvidenceV2Profile }
  from '../src/services/neighborhoodAssessment/neighborhoodOriginalCadAmenityEvidenceV2.js';

/** Synthetic local originals test representation, not licensed acquisition. */
function row(kind,id,pool=false,type='GARAGE',area='9007199254740993.01'){
  const original_text=JSON.stringify(kind==='primary'?{account_id:'A',year_built:'2020',living_area_sqft:'2000',
    bedroom_count:'3',bath_count:'2',number_units:'1',pool}
    :{id,account_id:'A',sec_imp_number:'1',sec_imp_type:type,sec_imp_sqft:area});
  const typed=compile({kind,row_key:id,payload_text:original_text});
  return {kind,row_key:id,account_id:'A',original_text,payload_sha256:typed.original.payload_sha256,
    payload_utf8_bytes:String(typed.original.payload_utf8_bytes),cached_account_id:'A',original_payload_sha256:typed.original.payload_sha256,typed};
}
function account(originals){originals.sort((a,b)=>Buffer.compare(Buffer.from(`${a.kind}:${a.row_key}`),Buffer.from(`${b.kind}:${b.row_key}`)));
  return replay({account_id:'A',geographic_parcel_count:'1',
  counts:Object.fromEntries(['primary','secondary'].map(k=>[k,String(originals.filter(r=>r.kind===k).length)])),
  row_count:originals.length,invalid_count:0,packet_oversize:false,packet_json:JSON.stringify(originals)},
  {cursor:''},'2026-10-10',()=>{}).rows[0];}
const complete=()=>account([row('primary','A'),row('secondary','9007199254740993'),row('secondary','9007199254740994')]);

test('reported pool booleans/NULL and wrong types remain distinct, never verified presence or absence',()=>{
  for(const [pool,state,value] of [[true,'observed',true],[false,'observed',false],[null,'missing',null],['false','invalid',null],[0,'invalid',null]]){
    const a=account([row('primary','A',pool)]),before=JSON.stringify(a),out=resolve(a,()=>{});
    assert.equal(out.reported_pool.state,state);assert.equal(out.reported_pool.exact_value,value);
    assert.equal(out.reported_pool.verified_presence_or_absence,'not_established');
    assert.equal(out.provider_fidelity,'not_established');assert.equal(out.source_freshness,'not_established');
    assert.equal(out.amenity_completeness,'not_established');assert.equal(out.authority,'not_established');
    assert.equal(out.selected_union,'not_established');assert.equal(out.report_update,'none');
    assert.equal(JSON.stringify(a),before);assert.ok(Object.isFrozen(out.reported_pool));
  }
  const missing=resolve(account([]),()=>{});assert.equal(missing.reported_pool.state,'missing');
  assert.equal(missing.reported_pool.reason,'primary_original_absent');assert.equal(missing.reported_pool.source_original,null);
});

test('all native secondary IDs and duplicate numbers survive; no label, primary pool, area sum or zero from absence',()=>{
  const a=complete(),before=JSON.stringify(a);let checks=0;const out=resolve(a,()=>checks++);
  assert.ok(checks>=4);assert.equal(JSON.stringify(a),before);assert.equal(out.secondary_inventory.original_count,'2');
  assert.deepEqual(out.secondary_inventory.rows.map(r=>r.row_key),['9007199254740993','9007199254740994']);
  assert.ok(out.secondary_inventory.rows.every(r=>r.reported_number.exact_value==='1'&&r.reported_area.exact_value==='9007199254740993.01'
    &&r.reported_area.unit==='reported_sqft'&&r.reported_type.value_text==='GARAGE'&&r.semantic_type==='unsupported'));
  for(const key of ['garage_area','garage_spaces','outbuilding_area']){
    assert.equal(out[key].state,'unsupported');assert.equal(out[key].exact_value,null);assert.equal(out[key].unit,null);
    assert.equal(resolve(account([row('primary','A',true)]),()=>{})[key].state,'unsupported');
  }
  assert.equal(out.profile,getNeighborhoodOriginalCadAmenityEvidenceV2Profile());
  assert.doesNotMatch(JSON.stringify(out),/original_text|payload_utf8_bytes/);
  for(const type of [null,'POOL','GARAGE ATTACHED','NO GARAGE','',123,{garage:true},'x'.repeat(129)]){
    const out=resolve(account([row('secondary','1',false,type)]),()=>{});
    assert.equal(out.secondary_inventory.rows[0].semantic_type,'unsupported');assert.equal(out.reported_pool.state,'missing');
  }
});

test('complete 250 originals remain bounded, no native-ID deduplication; hostile input and cancellation refuse',()=>{
  const a=account([row('primary','A'),...Array.from({length:249},(_,i)=>row('secondary',String(i+1)))]);
  assert.equal(resolve(a,()=>{}).secondary_inventory.rows.length,249);
  for(const mutate of [a=>a.secondary_original_count='251',a=>a.secondary_original_count='0',a=>a.primary_original_count='0',
    a=>a.secondary_originals[1]=a.secondary_originals[0],a=>a.secondary_originals[0].account_id='B',
    a=>a.observations.reported_pool_flag.exact_value='false',a=>a.observations.reported_pool_flag.state='invented',
    a=>a.secondary_originals[0].typed.markers.sec_imp_type.value_sha256={},
    a=>a.secondary_originals[0].typed.observations.reported_improvement_area.unit='garage_spaces']){
    const bad=structuredClone(complete());mutate(bad);assert.throws(()=>resolve(bad,()=>{}),/neighborhood_original_CAD_amenity_v2_/);
  }
  for(const bad of [new Proxy(complete(),{}),{...complete(),get account_id(){assert.fail('getter');}},
    {...complete(),secondary_originals:new Proxy(complete().secondary_originals,{})},
    {...complete(),secondary_originals:[,complete().secondary_originals[1]]}])
    assert.throws(()=>resolve(bad,()=>{}),/invalid_/);
  assert.throws(()=>resolve(complete(),()=>{throw Error('cancelled');}),/cancelled/);
});
