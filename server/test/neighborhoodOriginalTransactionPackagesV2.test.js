import assert from 'node:assert/strict';
import test from 'node:test';
import { compileNeighborhoodFrozenTypedOriginalV2 } from '../src/services/neighborhoodAssessment/neighborhoodFrozenTypedOriginalV1.js';
import { CACHED_SALE_WITNESS_V2_FIELDS } from '../src/services/neighborhoodAssessment/cachedSaleWitnessV2.js';
import { reconcileNeighborhoodOriginalTransactionPackageV2 as replay,NEIGHBORHOOD_ORIGINAL_TRANSACTION_PACKAGE_V2_SQL as SQL,
  getNeighborhoodOriginalTransactionPackageV2Profile } from '../src/services/neighborhoodAssessment/neighborhoodOriginalTransactionPackagesV2.js';
import { projectNeighborhoodTransactionPackageV1 } from '../src/services/neighborhoodAssessment/neighborhoodSharedTransactionPackagesV1.js';

const SOURCE='9007199254740993',PAGE={kind:'source_record',cursor:''},EFFECTIVE='2026-10-07';
const PERIOD={start_date:'2025-01-01',end_date:EFFECTIVE};
const GRAPH={parcels:2,accounts:1,source_records:2000000,sales:2000000,sale_links:2000000,sync_state:0,sync_runs:0};
/** Fresh synthetic payloads, not licensed source or issued-owner proof. */
function original(kind,id,changes={},stock=true){
  const fields=Object.fromEntries(CACHED_SALE_WITNESS_V2_FIELDS.map(k=>[k,{state:'absent',json_type:null,value_text:null,utf8_bytes:null}]));
  const payload={id,...(kind==='source_records'?{primary_account_id:'A',year_built:2050,close_date:'2010-01-01',
    current_price:'9007199254740993.01',source_raw_witness:{witness_version:2,root_state:'object',root_json_type:'object',fields}}
    :{account_id:'A',source_record_id:SOURCE,...(kind==='sales'?{sale_price:'9007199254740993.01',closing_date:EFFECTIVE}
      :{source_position:1,parcel_sequence:Number(id),is_resolved:true})}),...changes};
  const original_text=JSON.stringify(payload),typed=compileNeighborhoodFrozenTypedOriginalV2({kind,row_key:id,payload_text:original_text});
  return {kind,row_key:id,account_id:typed.account_id,source_record_id:typed.source_record_id,original_text,
    cached_account_id:typed.account_id,cached_source_record_id:typed.source_record_id,
    original_payload_sha256:typed.original.payload_sha256,typed,stock_member:typed.account_id===null?null:stock};
}
/** SQL envelopes are DATA here; only native database owner execution authenticates them. */
function packet(rows,id=SOURCE){
  rows.sort((a,b)=>Buffer.compare(Buffer.from(`${a.kind}:${a.row_key}`),Buffer.from(`${b.kind}:${b.row_key}`)));
  return {package_key:id,counts:Object.fromEntries(['source_records','sales','sale_links'].map(k=>[k,String(rows.filter(r=>r.kind===k).length)])),
    row_count:rows.length,invalid_count:0,packet_oversize:false,packet_json:JSON.stringify(rows),scan_count:id===null?0:1,scan_cursor:id};
}
/** Complete original packet, including outside and unknown-account rows. */
const complete=()=>packet([original('source_records',SOURCE),original('sales','10'),
  original('sale_links','1',{account_id:'OUTSIDE'},false),original('sale_links','2',{account_id:null,is_resolved:false})]);

test('every original replays before unchanged native association and retained-year/period projection, with no original text delivery',()=>{
  let checks=0;const reconciled=replay(complete(),PAGE,()=>checks++);
  assert.ok(checks>=9);assert.doesNotMatch(reconciled.packet.packet_json,/original_text|cached_account_id/);
  const p=projectNeighborhoodTransactionPackageV1(reconciled.packet,PAGE,GRAPH,EFFECTIVE,PERIOD);
  assert.equal(p.next_cursor,SOURCE);assert.equal(p.end_of_kind,false);
  assert.deepEqual(p.package.counts,{source_records:'1',sales:'1',sale_links:'2'});
  const source=p.package.rows.find(e=>e.projection.kind==='source_records').projection;
  assert.equal(source.normalized.observations.normalized_current_price.exact_value,'9007199254740993.01');
  assert.equal(source.normalized.observations.normalized_current_price.unit,null);
  assert.equal(source.normalized.observations.normalized_year_built.state,'invalid');
  assert.equal(source.normalized.period_disposition.state,'outside_period');
  assert.equal(p.package.associations.outside_account_count,1);assert.equal(p.package.associations.missing_account_row_count,1);
  assert.equal(p.package.transaction_eligibility,'not_established');
});

test('matching hashes/counts cannot launder cache, original, native identity or byte-count changes',()=>{
  for(const mutate of [r=>r.typed.observations.normalized_current_price.exact_value='1',
    r=>r.original_text=r.original_text.replace('2050','2040'),r=>r.cached_account_id='OTHER',
    r=>r.cached_source_record_id='1',r=>r.typed.original.payload_utf8_bytes='1',r=>r.original_payload_sha256='a'.repeat(64),
    r=>r.typed=null]){
    const raw=complete(),rows=JSON.parse(raw.packet_json),r=rows.find(r=>r.kind==='source_records');mutate(r);
    raw.packet_json=JSON.stringify(rows);assert.throws(()=>replay(raw,PAGE,()=>{}),/original_mismatch/);
  }
  assert.throws(()=>replay({...complete(),invalid_count:1},PAGE,()=>{}),/invalid_result/);
});

test('exact complete 250, whole 251 and all byte gates never become prefix acceptance',()=>{
  const rows=[original('source_records',SOURCE),...Array.from({length:249},(_,i)=>original('sales',String(i+1)))];
  const p=replay(packet(rows),PAGE,()=>{});assert.equal(p.packet.row_count,250);
  assert.equal(projectNeighborhoodTransactionPackageV1(p.packet,PAGE,GRAPH,EFFECTIVE,PERIOD).package.rows.length,250);
  const over={...packet([],SOURCE),counts:{source_records:'1',sales:'250',sale_links:'0'}};
  assert.throws(()=>replay(over,PAGE,()=>{}),/row_limit/);
  assert.throws(()=>replay({...complete(),packet_oversize:true,packet_json:'[]'},PAGE,()=>{}),/byte_limit/);
  const big=original('sales','1'),raw=packet([big]);big.original_text='x'.repeat(1000001);raw.packet_json=JSON.stringify([big]);
  assert.throws(()=>replay(raw,PAGE,()=>{}),/invalid_original/);
  assert.throws(()=>replay({...complete(),counts:{source_records:'1',sales:'252',sale_links:'2'}},PAGE,()=>{}),/invalid_counts/);
});

test('sparse original legacy scan advances at cap without false end, while chosen package never skips later prefix members',()=>{
  const page={kind:'legacy_sale',cursor:''},sparse={...packet([],null),scan_count:250,scan_cursor:'900'};
  const a=replay(sparse,page,()=>{});assert.equal(a.next_scan_cursor,'900');assert.equal(a.empty_scan_terminal,false);
  assert.equal(replay({...sparse,scan_count:249},page,()=>{}).empty_scan_terminal,true);
  const b=replay({...packet([original('sales','3',{source_record_id:null})],'3'),scan_count:250,scan_cursor:'900'},page,()=>{});
  assert.equal(projectNeighborhoodTransactionPackageV1(b.packet,page,GRAPH,EFFECTIVE,PERIOD).next_cursor,'3');
  assert.throws(()=>replay({...sparse,scan_count:251},page,()=>{}),/invalid_result/);
  assert.throws(()=>replay({...sparse,scan_cursor:'2'},{...page,cursor:'3'},()=>{}),/invalid_order/);
  assert.throws(()=>replay({...complete(),scan_cursor:'1'},PAGE,()=>{}),/invalid_result/);
});

test('closed hostile DATA and cancellation are refused; fixed original SQL bounds precede payload and stock filters',()=>{
  const raw=complete();for(const bad of [new Proxy(raw,{}),{...raw,extra:1},{...raw,get counts(){assert.fail('getter');}}])
    assert.throws(()=>replay(bad,PAGE,()=>{}),/invalid_input/);
  assert.throws(()=>replay(raw,PAGE,()=>{throw Error('cancelled');}),/cancelled/);
  assert.match(SQL.source_record,/LIMIT \(\$5::integer\+1\)/);assert.match(SQL.source_record,/LEFT JOIN LATERAL/);
  assert.match(SQL.legacy_sale,/scan_keys AS MATERIALIZED[\s\S]*ORDER BY o.row_key LIMIT \$5::integer[\s\S]*chosen AS MATERIALIZED/);
  for(const text of Object.values(SQL))assert.doesNotMatch(text,/FROM (?:core|gis)\.|ST_DWithin|INSERT|UPDATE|DELETE|AVG\(/);
  assert.equal(getNeighborhoodOriginalTransactionPackageV2Profile().profile_ref.id,'neighborhood-original-transaction-packages-v2');
});

test('fixed original SQL byte admission precedes encoding and retains exact whole-package refusal',()=>{
  for(const text of Object.values(SQL)){
    const sizes=text.indexOf('raw_sizes AS MATERIALIZED'),gate=text.indexOf('raw_gate AS MATERIALIZED'),members=text.indexOf('members AS MATERIALIZED');
    assert.ok(sizes>0&&gate>sizes&&members>gate);
    assert.doesNotMatch(text.slice(sizes,gate),/jsonb_build_object| AS encoded|array_agg|string_agg/);
    assert.match(text.slice(sizes,gate),/octet_length\(o\.payload::text\)/);
    assert.match(text.slice(sizes,gate),/SELECT sum\(n\) FROM totals/);
    assert.match(text.slice(gate,members),/sum\(original_bytes::bigint\+coalesce\(typed_bytes,0\)\+1\)/);
    assert.match(text.slice(members),/AND NOT \(SELECT oversize FROM raw_gate\) OFFSET 0/);
    assert.match(text,/\(SELECT oversize FROM raw_gate\) OR coalesce\(max\(bytes\),0\)>\$7/);
    assert.match(text,/CASE WHEN NOT \(SELECT oversize FROM raw_gate\)[\s\S]*sum\(bytes\+1\)[\s\S]*ELSE '\[\]' END AS packet_json/);
  }
  assert.throws(()=>replay({...complete(),packet_oversize:true,row_count:0,invalid_count:0,packet_json:'[]'},PAGE,()=>{}),/byte_limit/);
});
