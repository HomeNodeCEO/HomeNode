import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { CACHED_SALE_WITNESS_V2_FIELDS } from '../src/services/neighborhoodAssessment/cachedSaleWitnessV2.js';
import { compileNeighborhoodFrozenTypedOriginalV2 as compile } from '../src/services/neighborhoodAssessment/neighborhoodFrozenTypedOriginalV1.js';
import { projectNeighborhoodTransactionPackageV1 as project } from '../src/services/neighborhoodAssessment/neighborhoodSharedTransactionPackagesV1.js';
import { resolveNeighborhoodOriginalSourceResolutionV3 as resolve } from '../src/services/neighborhoodAssessment/neighborhoodOriginalSourceResolutionV3.js';
import { createCustomCohortContextCapture as capture } from '../src/services/neighborhoodAssessment/customCohortContextCapture.js';

const effective='2026-10-07',period={start_date:'2025-01-01',end_date:effective},copy=v=>structuredClone(v),check=()=>{};
function witness(changes={}){
  const values={MlsStatus:'closed',CloseDate:'2025-01-01',ClosePrice:'9007199254740993.01',ClosePriceCurrency:'USD',
    LivingArea:'1000.01',LivingAreaUnits:'sqft',YearBuilt:'2050',...changes};
  return {witness_version:2,root_state:'object',root_json_type:'object',fields:Object.fromEntries(CACHED_SALE_WITNESS_V2_FIELDS.map(k=>{
    if(!Object.hasOwn(values,k)||values[k]===undefined)return [k,{state:'absent',json_type:null,value_text:null,utf8_bytes:null}];
    if(values[k]===null)return [k,{state:'json_null',json_type:'null',value_text:null,utf8_bytes:null}];
    const text=String(values[k]);return [k,{state:'scalar',json_type:typeof values[k],value_text:text,utf8_bytes:Buffer.byteLength(text)}];
  }))};
}
function fixture({source={},sale={},reported={},link={},extraSale=false,legacy=false,unresolved=false}={}){
  const inputs=legacy?[['sales','10',{id:'10',source_record_id:null,account_id:'A',closing_date:'2025-01-01',sale_price:'0'}]]:[
    ['source_records','501',{id:'501',primary_account_id:'A',current_price:'999',close_date:'2025-01-01',source_raw_witness:witness(reported),...source}],
    ['sales','1',{id:'1',source_record_id:'501',account_id:'OUTSIDE',closing_date:'2025-01-01',sale_price:'9007199254740993.01',...sale}],
    ['sale_links','1',{id:'1',source_record_id:'501',account_id:'A',source_position:1,parcel_sequence:1,is_resolved:true}],
    ['sale_links','2',{id:'2',source_record_id:'501',account_id:unresolved?null:'B',source_position:1,parcel_sequence:2,is_resolved:!unresolved,...link}]];
  if(extraSale)inputs.push(['sales','2',{id:'2',source_record_id:'501',account_id:'A',closing_date:'2025-01-01',sale_price:'9007199254740993.01'}]);
  const rows=inputs.map(([kind,row_key,payload])=>{
    const typed=compile({kind,row_key,payload_text:JSON.stringify(payload)});
    return {stock_member:typed.account_id===null?null:typed.account_id!=='OUTSIDE',row:{kind,row_key,account_id:typed.account_id,
      source_record_id:typed.source_record_id,original_payload_sha256:typed.original.payload_sha256,typed}};
  }).sort((a,b)=>Buffer.compare(Buffer.from(`${a.row.kind}:${a.row.row_key}`),Buffer.from(`${b.row.kind}:${b.row.row_key}`))),
    counts=Object.fromEntries(['source_records','sales','sale_links'].map(k=>[k,String(rows.filter(r=>r.row.kind===k).length)])),
    packet=project({package_key:legacy?'10':'501',counts,row_count:rows.length,packet_oversize:false,packet_json:JSON.stringify(rows)},
      {kind:legacy?'legacy_sale':'source_record',cursor:''},{parcels:10,accounts:10,source_records:10,sales:10,sale_links:10,sync_state:1,sync_runs:1},effective,period).package,
    membership={subject_account_id:'A',subject_selected_union_member:true,associations:rows.map(({row,stock_member})=>({kind:row.kind,row_key:row.row_key,
      account_id:row.account_id,source_record_id:row.source_record_id,stock_member,selected_union_member:stock_member})),
      coverage:'whole_native_packages_for_first_registered_source_first_seen_account_only',economic_property_membership:'not_established',global_selected_native_deduplication:false};
  return {packet,membership};
}

test('whole original projections retain outside canonical sale separately from selected source/link accounts and exact same-payload prices',()=>{
  const {packet,membership}=fixture(),before=JSON.stringify({packet,membership}),r=resolve(packet,membership,check);
  assert.equal(r.membership.native_account_count,3);assert.equal(r.membership.selected_account_count,2);assert.equal(r.membership.outside_stock_account_count,1);
  assert.equal(r.membership.native_account_state,'multiple_native_accounts');assert.equal(r.unique_native_sale.membership,'outside_stock');
  assert.equal(r.unique_native_sale.recorded_price.exact_value,'9007199254740993.01');assert.equal(r.unique_native_sale.recorded_price.unit,null);
  assert.equal(r.same_payload_reported.observations.reported_close_price.exact_value,'9007199254740993.01');
  assert.equal(r.same_payload_reported.observations.reported_close_price.unit,'USD');
  assert.equal(r.same_payload_reported.observations.reported_year_built.state,'invalid');
  assert.equal(r.native_calendar_quarter,'2025-Q1');assert.equal(r.native_period_disposition.state,'in_period');
  for(const k of ['economic_transaction_eligibility','economic_transaction_equivalence','quarter_statistics','price_allocation','at_sale_GLA'])assert.equal(r[k],'not_established');
  assert.equal(r.cross_source_deduplication,false);assert.equal(r.report_update,'none');assert.equal(JSON.stringify({packet,membership}),before);
  assert.ok(Object.isFrozen(r)&&Object.isFrozen(r.same_payload_reported.observations));assert.ok(Buffer.byteLength(JSON.stringify(r))<=8192);
});

test('missing and conflicting normalized dates never borrow a raw or adjacent-row date; reported dates keep separate calendar quarters',()=>{
  let f=fixture({source:{close_date:null}}),r=resolve(f.packet,f.membership,check);
  assert.equal(r.native_closing_date.state,'incomplete');assert.equal(r.native_calendar_quarter,null);assert.equal(r.same_payload_reported.calendar_quarter,'2025-Q1');
  f=fixture({sale:{closing_date:'2025-04-01'}});r=resolve(f.packet,f.membership,check);assert.equal(r.native_closing_date.state,'conflicting');assert.equal(r.native_calendar_quarter,null);
  f=fixture({reported:{CloseDate:'2025-04-01'}});r=resolve(f.packet,f.membership,check);
  assert.equal(r.native_calendar_quarter,'2025-Q1');assert.equal(r.same_payload_reported.calendar_quarter,'2025-Q2');assert.equal(r.same_payload_reported.normalized_date_comparison,'conflicting');
  f=fixture({reported:{CloseDate:undefined,ClosePriceCurrency:undefined,LivingAreaUnits:undefined}});r=resolve(f.packet,f.membership,check);
  assert.equal(r.same_payload_reported.closing_date.state,'missing');assert.equal(r.same_payload_reported.calendar_quarter,null);
  assert.equal(r.same_payload_reported.observations.reported_close_price.state,'unsupported');assert.equal(r.same_payload_reported.observations.reported_close_price.unit,null);
  assert.equal(r.same_payload_reported.observations.reported_living_area.state,'unsupported');
});

test('multiple native sales never collapse into one dated economic transaction; unresolved links survive',()=>{
  const f=fixture({extraSale:true,unresolved:true}),r=resolve(f.packet,f.membership,check);
  assert.equal(r.native_sale_state,'multiple_native_ids_unresolved');assert.equal(r.unique_native_sale,null);
  assert.equal(r.native_closing_date.state,'unresolved');assert.equal(r.native_calendar_quarter,null);assert.equal(r.membership.unresolved_account_row_count,1);
  assert.equal(r.membership.native_account_state,'unresolved_associations');
  const flagged=fixture({link:{is_resolved:false}}),q=resolve(flagged.packet,flagged.membership,check);
  assert.equal(q.membership.unresolved_account_row_count,0);assert.equal(q.membership.unresolved_link_count,1);
  assert.equal(q.membership.native_account_state,'unresolved_associations');
});

test('source-less sale retains its own normalized date, zero price and native identity without fabricating a raw witness',()=>{
  const f=fixture({legacy:true}),r=resolve(f.packet,f.membership,check);
  assert.equal(r.native_key,'10');assert.equal(r.same_payload_reported,null);assert.equal(r.unique_native_sale.native_sale_key,'10');
  assert.equal(r.unique_native_sale.recorded_price.exact_value,'0');assert.equal(r.unique_native_sale.recorded_price.state,'unsupported');
  assert.equal(r.unique_native_sale.membership,'selected');assert.equal(r.native_calendar_quarter,'2025-Q1');
});

test('calendar placement preserves inclusive period ends and exact quarter changes without changing eligibility',()=>{
  for(const [day,q] of [['2024-12-31','2024-Q4'],['2025-01-01','2025-Q1'],['2025-03-31','2025-Q1'],['2025-04-01','2025-Q2'],['2025-06-30','2025-Q2'],['2025-07-01','2025-Q3'],['2025-09-30','2025-Q3'],['2025-10-01','2025-Q4'],['2026-10-07','2026-Q4'],['2026-10-08','2026-Q4']]){
    const f=fixture({source:{close_date:day},sale:{closing_date:day},reported:{CloseDate:day}}),r=resolve(f.packet,f.membership,check);
    assert.equal(r.native_calendar_quarter,q);assert.equal(r.same_payload_reported.calendar_quarter,q);
    assert.equal(r.native_period_disposition.state,day>=period.start_date&&day<=period.end_date?'in_period':'outside_period');
    assert.equal(r.economic_transaction_eligibility,'not_established');
  }
});

test('partial native membership, duplicate rows, conflicting selected flags and altered date projections refuse the whole resolution',()=>{
  for(const change of [f=>f.membership.associations.pop(),f=>f.membership.associations.push(copy(f.membership.associations[0])),
    f=>f.membership.associations.find(a=>a.account_id==='A').stock_member=false,
    f=>f.packet.rows[0].projection.account_id='FORGED',f=>f.packet.counts.sales='2',f=>f.packet.associations.unresolved_link_count++,
    f=>f.packet.rows.find(e=>e.projection.kind==='sales').projection.normalized.period_disposition.exact_date='2025-04-01']){
    const f=copy(fixture());change(f);assert.throws(()=>resolve(f.packet,f.membership,check));
  }
});

test('getters, proxies, sparse arrays, caller callbacks and over-limit inputs never become source authority',()=>{
  const f=fixture();let invoked=false;const hostile=()=>{invoked=true;assert.fail('getter ran');},p={...f.packet};
  Object.defineProperty(p,'rows',{enumerable:true,get:hostile});assert.throws(()=>resolve(p,f.membership,check));
  assert.throws(()=>resolve(new Proxy(f.packet,{get:hostile}),f.membership,check));assert.equal(invoked,false);
  assert.throws(()=>resolve({...f.packet,rows:Array(2)},f.membership,check));assert.throws(()=>resolve({...f.packet,rows:Array(251).fill(null)},f.membership,check));
  assert.throws(()=>resolve(f.packet,f.membership,check,{}));assert.throws(()=>resolve(f.packet,f.membership,null));
  assert.throws(()=>resolve(f.packet,f.membership,()=>{throw Error('owner budget');}),/owner budget/);
});

test('actual closed owner exposes compact resolution only after complete original replay and both ending native/authority fences',async()=>{
  const text=readFileSync(new URL('../src/services/neighborhoodAssessment/customCohortContextCapture.js',import.meta.url),'utf8'),
    derive=text.indexOf('selectedTransactionSourceResolution=resolveNeighborhoodOriginalSourceResolutionV3('),
    ending=text.indexOf('const ending=await createCustomCohortV2SelectionIntentRepository(client)',derive),
    repeat=text.indexOf("selectedTransactionIndexStore[readingCompletedIndexFirstSource?'readFirstAccount':'readNext']()",ending),
    output=text.indexOf('selected_source_resolution:selectedTransactionSourceResolution',repeat);
  assert.ok(derive>0&&ending>derive&&repeat>ending&&output>repeat);
  let calls=0;const hostile=()=>{calls++;assert.fail('no IO');},service=capture({pool:{connect:hostile},sourceMode:'combined-witness2-v1',authorizeMarketData:hostile,authorizeCadImprovementData:hostile}),
    method='readCoveredOriginalFrozenCaptureJobCompletedIndexFirstSourceResolutionReferencesV3',id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,
    input={auth:{userId:id(1),organizations:[]},accountId:'SUBJECT',assignmentFileId:'7',operationId:id(2),observationPeriod:period,
      discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}},options={captureJobClaim:{operation_id:id(2),claim_token:id(3),attempts:5}};
  assert.throws(()=>service[method](input,options,undefined),/invalid_options/);
  for(const key of ['source','native_key','packet','membership','resolve','ordinal','cursor','sourceAuthority'])
    await assert.rejects(service[method](input,{...options,[key]:hostile}),/invalid_options/);
  assert.equal(calls,0);
});
