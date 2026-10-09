import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { assessmentEvidenceDigest } from '../src/services/neighborhoodAssessment/contract.js';
import { createNeighborhoodFrozenJobStock } from '../src/services/neighborhoodAssessment/neighborhoodFrozenJobStock.js';
import { createNeighborhoodFrozenJobStockOriginals, NEIGHBORHOOD_FROZEN_STOCK_ORIGINAL_PAGE_SQL,
  NEIGHBORHOOD_FROZEN_STOCK_ORIGINAL_TOTALS_SQL } from '../src/services/neighborhoodAssessment/neighborhoodFrozenJobStockOriginals.js';
import { neighborhoodFrozenSpatialDefinition } from '../src/services/neighborhoodAssessment/neighborhoodFrozenSpatialPages.js';
import { createNeighborhoodFrozenJobSourceIdentity } from '../src/services/neighborhoodAssessment/neighborhoodFrozenJobSourceIdentity.js';
import { createNeighborhoodFrozenJobTypedOriginals } from '../src/services/neighborhoodAssessment/neighborhoodFrozenJobTypedOriginals.js';
import { createNeighborhoodFrozenJobStockMetricPages, createNeighborhoodSharedJobStockMetricPages, getNeighborhoodFrozenStockMetricProfile,
  createNeighborhoodSharedJobStockMetricPagesV2, getNeighborhoodFrozenStockMetricV2Profile,
  NEIGHBORHOOD_SHARED_STOCK_METRIC_V2_PAGE_SQL, NEIGHBORHOOD_FROZEN_STOCK_METRIC_PAGE_SQL,
  NEIGHBORHOOD_SHARED_STOCK_METRIC_PAGE_SQL } from '../src/services/neighborhoodAssessment/neighborhoodFrozenJobStockMetricPages.js';
import { NEIGHBORHOOD_SHARED_TYPED_SQL, NEIGHBORHOOD_SHARED_TYPED_V2_SQL } from '../src/services/neighborhoodAssessment/neighborhoodSharedTypedGeneration.js';
import { getNeighborhoodFrozenTypedOriginalV1Profile, getNeighborhoodFrozenTypedOriginalV2Profile } from '../src/services/neighborhoodAssessment/neighborhoodFrozenTypedOriginalV1.js';
import { NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL, NEIGHBORHOOD_FROZEN_JOB_IDENTITY_COVERAGE_SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenSourceClosurePages.js';

const id='70000000-0000-4000-8000-000000000001',date='2026-10-07T00:00:00.000000Z';
const claim={operation_id:id,claim_token:'70000000-0000-4000-8000-000000000002',attempts:1};
const scope={organization_id:'70000000-0000-4000-8000-000000000003',report_file_id:'70000000-0000-4000-8000-000000000004',assignment_file_id:'1',account_id:'STOCK-A'};
const options={claim,scope,actorUserId:'70000000-0000-4000-8000-000000000005',
  geometryInput:{geometry_version:1,type:'Point',crs:'EPSG:4326',axis_order:'longitude_latitude',coordinate_encoding:'decimal_string_v1',
    coordinates:['-96.7','32.9'],source_sha256:'a'.repeat(64)},discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'},
  subjectIntent:{content_sha256:'b'.repeat(64),canonical_utf8_bytes:'100'},checkBudget(){}};

function metricMember(accountId='STOCK-A') {
  const cell=(state,exact_value,unit)=>({state,exact_value,unit,observed_part_count:state==='observed'?'1':'0',
    missing_part_count:state==='missing'?'1':'0',invalid_part_count:'0',unsupported_part_count:state==='unsupported'?'1':'0',conflict_values:[]});
  return {account_id:accountId,geographic_parcel_count:'1',source_part_count:'1',observations:{
    reported_year_built:cell('observed','1960','year'),reported_residential_area:cell('observed','1000.01','reported_sqft'),
    reported_site_area:cell('observed','0','reported_sqft'),reported_market_value:cell('unsupported','9007199254740993',null)}};
}
async function metricFixture(hook=()=>{}) {
  let typedHeader;const rows=[metricMember()];
  const graph={root:{content_sha256:'c'.repeat(64),canonical_utf8_bytes:'100'},layer_counts:{parcels:60001,accounts:60000,
    source_records:0,sales:0,sale_links:0,sync_state:0,sync_runs:0}};
  const f=fixture(async call=>{
    const supplied=await hook({...call,typedHeader,rows});if(supplied)return supplied;
    if(call.text.includes('stock-metrics:header'))return result(structuredClone(typedHeader));
    if(call.text.includes('stock-metrics:page'))return result({page_json:JSON.stringify(rows),page_count:rows.length,
      candidate_count:rows.length,invalid_count:0,oversized_count:0,next_cursor:rows.at(-1)?.account_id??null});
    return null;
  },true);
  const profile=getNeighborhoodFrozenTypedOriginalV1Profile().profile_ref;
  const binding_sha256=assessmentEvidenceDigest({stock:await f.store.read(),graph,effective_date:'2026-10-07',profile_ref:profile});
  typedHeader={binding_sha256,profile_sha256:profile.content_sha256,effective_date:'2026-10-07',expected_counts:graph.layer_counts,status:'complete',
    progress:{format:'frozen_job_typed_original_progress_v1',binding_sha256,kind_index:7,after:'',layer_rows:0}};
  return {...f,rows,graph,metrics:()=>createNeighborhoodFrozenJobStockMetricPages(f.client,options,graph,'2026-10-07')};
}

async function sharedMetricFixture(hook=()=>{},neutral=false) {
  let sharedHeader;
  const rows=[metricMember()],graph={root:{content_sha256:'c'.repeat(64),canonical_utf8_bytes:'100'},
    layer_counts:{parcels:60001,accounts:0,source_records:0,sales:0,sale_links:0,sync_state:0,sync_runs:0}};
  const f=fixture(async call=>{
    const supplied=await hook({...call,sharedHeader,rows});if(supplied)return supplied;
    if(call.text===(neutral?NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read:NEIGHBORHOOD_SHARED_TYPED_SQL.read))return result(structuredClone(sharedHeader));
    if(call.text===(neutral?NEIGHBORHOOD_SHARED_STOCK_METRIC_V2_PAGE_SQL:NEIGHBORHOOD_SHARED_STOCK_METRIC_PAGE_SQL))return result({page_json:JSON.stringify(rows),page_count:rows.length,
      candidate_count:rows.length,invalid_count:0,oversized_count:0,next_cursor:rows.at(-1)?.account_id??null});
  },true);
  const stock=await f.store.read(),original=stock.original,profile=neutral?getNeighborhoodFrozenTypedOriginalV2Profile():getNeighborhoodFrozenTypedOriginalV1Profile();
  const source={generation_id:original.generation_id,format_version:original.source_format_version,status:'complete',
    source_snapshot:original.source_snapshot,started_at:original.source_transaction_started_at,completed_at:original.completed_at,
    layer_counts:original.layer_counts,row_count:original.row_count,payload_utf8_bytes:original.payload_utf8_bytes};
  const binding=assessmentEvidenceDigest({source,profile,...(neutral?{}:{effective_date:'2026-10-07'})});
  sharedHeader={binding_sha256:binding,source_metadata:source,definition_json:profile.definition_blob.canonical_json,
    progress:{format:neutral?'shared_frozen_typed_progress_v2':'shared_frozen_typed_progress_v1',binding_sha256:binding,kind_index:7,after:'',layer_rows:0,
      typed_rows:source.row_count,typed_utf8_bytes:'12000400'},status:'complete',completed_at:date};
  return {...f,rows,graph,sharedHeader,metrics:(effective='2026-10-07')=>(neutral?createNeighborhoodSharedJobStockMetricPagesV2:createNeighborhoodSharedJobStockMetricPages)(f.client,options,graph,effective)};
}

test('explicit V2 shared projection reuses one neutral cache across retained dates without changing V1 profiles',async()=>{
  const f=await sharedMetricFixture(()=>null,true),from=f.calls.length;
  const a=await f.metrics().page({cursor:'',rowLimit:1}),b=await f.metrics('2020-01-01').page({cursor:'',rowLimit:250});
  assert.deepEqual(a.shared_typed_generation_reference,b.shared_typed_generation_reference);
  assert.equal(a.shared_typed_generation_reference.shared_typed_reference_version,2);
  assert.equal(Object.hasOwn(a.shared_typed_generation_reference,'effective_date'),false);
  assert.equal(a.effective_date,'2026-10-07');assert.equal(b.effective_date,'2020-01-01');
  assert.deepEqual(a.profile,getNeighborhoodFrozenStockMetricV2Profile());
  assert.deepEqual(a.typed_original_profile_ref,getNeighborhoodFrozenTypedOriginalV2Profile().profile_ref);
  assert.notEqual(a.profile.profile_ref.content_sha256,getNeighborhoodFrozenStockMetricProfile().profile_ref.content_sha256);
  assert.equal(a.source_acquisition,'not_established');assert.equal(a.coverage,'one_account_page_only');
  assert.ok(f.calls.slice(from).filter(c=>c.text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read).every(c=>c.values.length===2));
  assert.deepEqual(f.calls.filter(c=>c.text===NEIGHBORHOOD_SHARED_STOCK_METRIC_V2_PAGE_SQL).map(c=>c.values[4]),['2026-10-07','2020-01-01']);
  assert.ok(!f.calls.slice(from).some(c=>/INSERT|UPDATE|DELETE|ST_DWithin|job-typed:|job-closure:|shared-typed-v2:page/.test(c.text)));
  await assert.rejects(createNeighborhoodSharedJobStockMetricPages(f.client,options,f.graph,'2026-10-07')
    .page({cursor:'',rowLimit:1}),/unexpected|invalid_result/,'no V2 cache is cast into the legacy reader');
});

test('V2 metric headers require the exact neutral profile/source/complete progress and ending immutability',async()=>{
  for(const mutate of [h=>h.status='building',h=>h.definition_json=getNeighborhoodFrozenTypedOriginalV1Profile().definition_blob.canonical_json,
    h=>h.progress.format='shared_frozen_typed_progress_v1',h=>h.progress.kind_index=6,
    h=>h.binding_sha256='e'.repeat(64),h=>h.source_metadata.source_snapshot='2:3:',h=>h.progress.typed_rows='60001']){
    const f=await sharedMetricFixture(({text,sharedHeader})=>{if(text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read){
      const h=structuredClone(sharedHeader);mutate(h);return result(h);}},true);
    await assert.rejects(f.metrics().page({cursor:'',rowLimit:1}),/unfinished_or_changed_typing/);
    assert.ok(!f.calls.some(c=>c.text===NEIGHBORHOOD_SHARED_STOCK_METRIC_V2_PAGE_SQL));
  }
  let headers=0;const f=await sharedMetricFixture(({text,sharedHeader})=>text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read&&++headers===2
    ?result({...sharedHeader,status:'building'}):null,true);
  await assert.rejects(f.metrics().page({cursor:'',rowLimit:1}),/unfinished_or_changed_typing/);
});

test('V2 date projection is before account grouping, not future-year conflicts or malformed-cell laundering',()=>{
  const sql=NEIGHBORHOOD_SHARED_STOCK_METRIC_V2_PAGE_SQL;
  assert.match(sql,/FROM app\.neighborhood_frozen_typed_v2_rows/);assert.doesNotMatch(sql,/effective_date=|ST_DWithin|INSERT|UPDATE|DELETE/);
  assert.match(sql,/literal<='9999'/);assert.match(sql,/valid_shape AND valid_numeric AND state='observed' AND key='reported_year_built'/);
  assert.match(sql,/literal>left\(\$5::text,4\) THEN 'invalid'/);assert.match(sql,/literal>left\(\$5::text,4\) THEN NULL/);
  assert.ok(sql.indexOf('projected AS')<sql.indexOf('grouped AS'));assert.match(sql,/FROM projected GROUP BY key/);
  assert.match(sql,/WHERE NOT valid_shape OR state='observed' AND NOT valid_numeric/);
  assert.match(sql,/CASE WHEN valid_numeric THEN literal::numeric END/);
  const d=JSON.parse(getNeighborhoodFrozenStockMetricV2Profile().definition_blob.canonical_json);
  assert.deepEqual(d.typed_original_profile,getNeighborhoodFrozenTypedOriginalV2Profile());
  assert.match(d.temporal_projection,/before_account_resolution/);
});

test('V2 decoded projections retain invalid part counts and reject unprojected future values or caller date policies',async()=>{
  const f=await sharedMetricFixture(()=>null,true),year=f.rows[0].observations.reported_year_built;
  Object.assign(year,{state:'invalid',exact_value:null,unit:null,observed_part_count:'0',invalid_part_count:'1'});
  const r=await f.metrics('1900-01-01').page({cursor:'',rowLimit:1});
  assert.equal(r.rows[0].observations.reported_year_built.invalid_part_count,'1');assert.equal(r.rows[0].observations.reported_year_built.exact_value,null);
  assert.equal(r.report_update,'none');
  Object.assign(year,{state:'observed',exact_value:'2030',unit:'year',observed_part_count:'1',invalid_part_count:'0'});
  await assert.rejects(f.metrics().page({cursor:'',rowLimit:1}),/invalid_result/);
  for(const v of [{...options,effectiveDate:'2030-01-01'},{...options,profile:getNeighborhoodFrozenTypedOriginalV2Profile()},new Proxy(options,{})])
    assert.throws(()=>createNeighborhoodSharedJobStockMetricPagesV2(f.client,v,f.graph,'2026-10-07'),/invalid_input/);
});

test('shared stock metrics reuse exact immutable prepared data without per-job typing or cache-miss preparation',async()=>{
  const f=await sharedMetricFixture(),from=f.calls.length,r=await f.metrics().page({cursor:'',rowLimit:250});
  assert.equal(r.rows[0].observations.reported_market_value.exact_value,'9007199254740993');
  assert.equal(r.profile.definition_blob.canonical_json,getNeighborhoodFrozenStockMetricProfile().definition_blob.canonical_json);
  assert.equal(r.shared_typed_generation_reference.generation_id,id);
  assert.equal(r.shared_typed_generation_reference.effective_date,'2026-10-07');
  assert.equal(r.shared_typed_generation_reference.profile_ref.content_sha256,getNeighborhoodFrozenTypedOriginalV1Profile().profile_ref.content_sha256);
  assert.equal(r.shared_typed_generation_reference.binding_sha256,f.sharedHeader.binding_sha256);
  assert.equal(r.source_acquisition,'not_established');assert.equal(r.report_update,'none');
  assert.ok(Object.isFrozen(r.shared_typed_generation_reference));
  assert.equal(f.calls.slice(from).filter(c=>c.text===NEIGHBORHOOD_SHARED_TYPED_SQL.read).length,2);
  assert.ok(!f.calls.slice(from).some(c=>/INSERT|UPDATE|DELETE|ST_DWithin|job-closure:|job-typed:|shared-typed:page/.test(c.text)));
  const missing=await sharedMetricFixture(({text})=>text===NEIGHBORHOOD_SHARED_TYPED_SQL.read?{rowCount:0,rows:[]}:null);
  const start=missing.calls.length;await assert.rejects(missing.metrics().page({cursor:'',rowLimit:1}),/invalid_result/);
  assert.ok(!missing.calls.slice(start).some(c=>/INSERT|UPDATE|shared-stock-metrics:page/.test(c.text)));
});

test('shared headers cannot substitute a different source snapshot/profile/date, partial cache, or inflated scope',async()=>{
  for(const mutate of [h=>h.status='building',h=>h.binding_sha256='e'.repeat(64),h=>h.definition_json+=' ',
    h=>h.source_metadata.generation_id='70000000-0000-4000-8000-000000000006',h=>h.source_metadata.source_snapshot='2:3:',
    h=>h.progress.binding_sha256='f'.repeat(64),h=>h.progress.kind_index=6,h=>h.progress.after='1',h=>h.progress.layer_rows=1,
    h=>h.progress.typed_rows='60001',h=>h.progress.typed_utf8_bytes='8000000001',h=>h.progress.typed_utf8_bytes='1',
    h=>h.completed_at=null,h=>h.source_metadata.format_version=2,h=>h.source_metadata.started_at='2026-10-06T00:00:00.000000Z']) {
    const f=await sharedMetricFixture(({text,sharedHeader})=>{if(text===NEIGHBORHOOD_SHARED_TYPED_SQL.read){
      const h=structuredClone(sharedHeader);mutate(h);return result(h);}});
    await assert.rejects(f.metrics().page({cursor:'',rowLimit:1}),/unfinished_or_changed_typing/);
    assert.ok(!f.calls.some(c=>c.text===NEIGHBORHOOD_SHARED_STOCK_METRIC_PAGE_SQL));
  }
  const f=await sharedMetricFixture();f.graph.layer_counts.accounts=1;
  await assert.rejects(f.metrics().page({cursor:'',rowLimit:1}),/unfinished_or_changed_typing/);
  const changedDate=createNeighborhoodSharedJobStockMetricPages(f.client,options,{...f.graph,layer_counts:{...f.graph.layer_counts,accounts:0}},'2026-10-06');
  await assert.rejects(changedDate.page({cursor:'',rowLimit:1}),/unfinished_or_changed_typing/);
  let headers=0;
  const ending=await sharedMetricFixture(({text,sharedHeader})=>text===NEIGHBORHOOD_SHARED_TYPED_SQL.read&&++headers===2?
    result({...sharedHeader,binding_sha256:'e'.repeat(64)}):null);
  await assert.rejects(ending.metrics().page({cursor:'',rowLimit:1}),/unfinished_or_changed_typing/);
});

test('shared metric SQL is a fixed exact-date/account-index projection with identical numerical resolution',()=>{
  assert.match(NEIGHBORHOOD_SHARED_STOCK_METRIC_PAGE_SQL,/FROM app\.neighborhood_frozen_typed_rows/);
  // The parameter is used by the common year-bound text check as well. The
  // first SQL reference must keep it text, not infer DATE and break left().
  assert.match(NEIGHBORHOOD_SHARED_STOCK_METRIC_PAGE_SQL,/generation_id=\$2::uuid AND profile_sha256=\$8 AND effective_date=\$5::text::date/);
  assert.match(NEIGHBORHOOD_SHARED_STOCK_METRIC_PAGE_SQL,/kind='parcels' AND account_id=a.account_id/);
  assert.doesNotMatch(NEIGHBORHOOD_SHARED_STOCK_METRIC_PAGE_SQL,/FROM app\.neighborhood_custom_cohort_typed_original_rows|ST_DWithin|INSERT|UPDATE/);
  for(const fragment of ['CASE WHEN valid_numeric THEN literal::numeric END',"WHEN low<>high THEN 'conflicting'",'cumulative+1<=$6 AND bytes<=$7']) {
    assert.ok(NEIGHBORHOOD_SHARED_STOCK_METRIC_PAGE_SQL.includes(fragment));
    assert.ok(NEIGHBORHOOD_FROZEN_STOCK_METRIC_PAGE_SQL.includes(fragment));
  }
});

test('bounded stock metric pages preserve exact cells and original profile/provenance without rescanning geometry or acquiring',async()=>{
  const f=await metricFixture();const from=f.calls.length;
  const r=await f.metrics().page({cursor:'',rowLimit:250});
  assert.equal(r.rows[0].observations.reported_market_value.exact_value,'9007199254740993');
  assert.equal(r.rows[0].observations.reported_market_value.state,'unsupported');
  assert.equal(r.rows[0].observations.reported_site_area.exact_value,'0');
  assert.equal(r.rows[0].observations.reported_residential_area.unit,'reported_sqft');
  assert.equal(r.population.unassociated_parcel_count,'1');assert.equal(r.source_part_population_count,'60001');
  assert.equal(r.authority,'not_established');assert.equal(r.coverage,'one_account_page_only');
  assert.equal(r.source_acquisition,'not_established');assert.equal(r.report_update,'none');
  assert.equal(r.end_of_population,true);assert.equal(r.next_cursor,'STOCK-A');
  assert.equal(r.profile.definition_blob.canonical_json,getNeighborhoodFrozenStockMetricProfile().definition_blob.canonical_json);
  assert.ok(Object.isFrozen(r.rows[0].observations.reported_market_value));
  assert.ok(!f.calls.slice(from).some(call=>/ST_DWithin|frozen-spatial:counts|job-stock:begin|INSERT|UPDATE|job-closure:/.test(call.text)));
  assert.equal(f.calls.slice(from).filter(call=>call.text.includes('stock-metrics:header')).length,2);
});

test('stock metric pages never advance incomplete typing and repeat ending original/pin/profile fences',async()=>{
  for(const change of [row=>row.status='building',row=>row.profile_sha256='d'.repeat(64),row=>row.effective_date='2025-10-07',
    row=>row.expected_counts.parcels--,row=>row.progress.kind_index=6]) {
    const f=await metricFixture(({text,typedHeader})=>{if(text.includes('stock-metrics:header')){const row=structuredClone(typedHeader);change(row);return result(row);}});
    await assert.rejects(f.metrics().page({cursor:'',rowLimit:250}),/unfinished_or_changed_typing/);
    assert.ok(!f.calls.some(call=>call.text.includes('stock-metrics:page')));
  }
  let reads=0;
  const ending=await metricFixture(({text,typedHeader})=>{if(text.includes('stock-metrics:header')&&++reads===2)
    return result({...typedHeader,status:'building'});});
  await assert.rejects(ending.metrics().page({cursor:'',rowLimit:250}),/unfinished_or_changed_typing/);
  let fenced=false;
  const lost=await metricFixture(({text})=>text.includes('generation-fence')&&fenced?{rowCount:0,rows:[]}:null);
  fenced=true;await assert.rejects(lost.metrics().page({cursor:'',rowLimit:250}),/claim_lost/);
});

test('metric transport refuses corrupt counts/order/units and malformed or oversized SQL payloads',async()=>{
  for(const patch of [{invalid_count:1},{oversized_count:1},{page_count:2},{candidate_count:0},{next_cursor:'wrong'},
    {page_json:'['},{page_json:' '.repeat(2100001)},{page_json:'[]',page_count:0,next_cursor:null}]) {
    const f=await metricFixture(({text,rows})=>text.includes('stock-metrics:page')?result({page_json:JSON.stringify(rows),
      page_count:1,candidate_count:1,invalid_count:0,oversized_count:0,next_cursor:'STOCK-A',...patch}):null);
    await assert.rejects(f.metrics().page({cursor:'',rowLimit:250}),/invalid_result|byte_limit/);
  }
  for(const mutate of [row=>row.observations.reported_site_area.unit='acre',
    row=>row.observations.reported_site_area.exact_value=0,row=>row.source_part_count='2',
    row=>row.observations.reported_market_value.state='observed',row=>row.extra=true,
    row=>row.observations.reported_residential_area.exact_value='1000.0100',
    row=>row.observations.reported_residential_area.exact_value='0',row=>row.observations.reported_year_built.exact_value='2050',
    row=>{row.observations.reported_site_area.observed_part_count='0';row.observations.reported_site_area.missing_part_count='1';}]) {
    const f=await metricFixture();mutate(f.rows[0]);await assert.rejects(f.metrics().page({cursor:'',rowLimit:250}),/invalid_result|invalid_input/);
  }
  const duplicate=await metricFixture();duplicate.rows.push(metricMember());
  await assert.rejects(duplicate.metrics().page({cursor:'',rowLimit:250}),/invalid_result/);
  for(const witnesses of [['2','2'],['10','2']]) {
    const f=await metricFixture();f.rows[0].source_part_count='2';
    for(const cell of Object.values(f.rows[0].observations))cell[cell.state==='observed'?'observed_part_count':'unsupported_part_count']='2';
    Object.assign(f.rows[0].observations.reported_site_area,{state:'conflicting',unit:null,exact_value:null,conflict_values:witnesses});
    await assert.rejects(f.metrics().page({cursor:'',rowLimit:250}),/invalid_result/);
  }
});

test('full pages require a later terminal read; account order follows UTF8 C collation and empty pages retain cursor',async()=>{
  const f=await metricFixture();const reader=f.metrics();
  const first=await reader.page({cursor:'',rowLimit:1});assert.equal(first.end_of_population,false);
  f.rows.splice(0);const last=await reader.page({cursor:first.next_cursor,rowLimit:1});
  assert.equal(last.end_of_population,true);assert.equal(last.next_cursor,'STOCK-A');assert.deepEqual(last.rows,[]);
  f.rows.push(metricMember('\uE000'),metricMember('\u{10000}'));
  assert.equal((await f.metrics().page({cursor:'',rowLimit:250})).rows.length,2,'C order is UTF8 bytes, not JS UTF16 string order');
});

test('metric arguments reject proxies/getters/arbitrary cells and detach before pending SQL; cancellation preserves settlement lane',async()=>{
  const f=await metricFixture();const reader=f.metrics();
  for(const page of [{cursor:'',rowLimit:251},{cursor:' A',rowLimit:1},{cursor:'',rowLimit:1,observations:[]},
    new Proxy({cursor:'',rowLimit:1},{}),{get cursor(){assert.fail('getter');},rowLimit:1}])
    await assert.rejects(reader.page(page),/invalid_input|invalid_page|invalid_account/);
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const waiting=await metricFixture(async({text})=>{if(text.includes('stock-metrics:page'))await pending;});
  const lane=waiting.metrics(),page={cursor:'',rowLimit:1},first=lane.page(page);page.cursor='FOREIGN';
  await new Promise(resolve=>setImmediate(resolve));await assert.rejects(lane.page({cursor:'',rowLimit:1}),/concurrent_operation/);
  release();assert.equal((await first).cursor,'');
  const before=f.calls.length;
  await assert.rejects(createNeighborhoodFrozenJobStockMetricPages(f.client,{...options,checkBudget(){throw Error('cancelled');}},f.graph,'2026-10-07')
    .page({cursor:'',rowLimit:1}),/cancelled/);assert.equal(f.calls.length,before);
});

test('fixed metric SQL uses stock and typed account indexes, exact numeric guarded casts and encoded admission, not mean medians or part sums',()=>{
  const sql=NEIGHBORHOOD_FROZEN_STOCK_METRIC_PAGE_SQL;
  assert.match(sql,/FROM app\.neighborhood_custom_cohort_stock_accounts/);
  assert.match(sql,/kind='parcels' AND account_id=a\.account_id/);
  assert.match(sql,/CASE WHEN valid_numeric THEN literal::numeric END/);
  assert.match(sql,/WHEN low<>high THEN 'conflicting'/);assert.match(sql,/octet_length\(encoded\)/);
  assert.doesNotMatch(sql,/ST_DWithin|FROM (?:core|gis)\.|AVG\(|sum\(.*literal|INSERT|UPDATE|DELETE/);
  const definition=JSON.parse(getNeighborhoodFrozenStockMetricProfile().definition_blob.canonical_json);
  assert.deepEqual(definition.typed_original_profile,getNeighborhoodFrozenTypedOriginalV1Profile());
});
const result=row=>({rowCount:1,rows:[row]});
function fixture(hook=()=>{},initial=false) {
  const calls=[];let stored=initial;
  const pin={generation_id:id,status:'complete',retirement_started_at:null,source_observed_at:date,completed_at:date,parcel_count:'60002',sale_count:'0',group_count:'1'};
  const header={generation_id:id,format_version:1,status:'complete',source_snapshot:'1:2:',started_at:date,completed_at:date,
    row_count:'60002',payload_utf8_bytes:'6000200',layer_counts:Object.fromEntries(
      ['parcels','accounts','source_records','sales','sale_links','sync_state','sync_runs'].map(kind=>[kind,
        {row_count:kind==='parcels'?'60002':'0',payload_utf8_bytes:kind==='parcels'?'6000200':'0'}]))};
  const original={generation_id:id,source_format_version:1,source_snapshot:'1:2:',source_transaction_started_at:date,completed_at:date,
    row_count:header.row_count,payload_utf8_bytes:header.payload_utf8_bytes,layer_counts:header.layer_counts};
  const definition=neighborhoodFrozenSpatialDefinition(claim,id,options.geometryInput,options.discovery);
  const stock={status:'complete',definition,definition_sha256:assessmentEvidenceDigest(definition),source_original_sha256:assessmentEvidenceDigest(original),
    subject_intent_sha256:options.subjectIntent.content_sha256,subject_intent_utf8_bytes:'100',
    parcel_count:'60001',account_count:'60000',unassociated_parcel_count:'1',unlocatable_global_parcels:'1'};
  const client={async query(config,values){const text=typeof config==='string'?config:config.text;
    const parameters=typeof config==='string'?values:config.values;calls.push({text,values:parameters});
    const supplied=await hook({text,values:parameters,calls,stock,header});if(supplied)return supplied;
    if(text.includes('generation-transaction'))return result({transaction_id:'123'});
    if(text.includes('generation-fence'))return result({operation_id:id});
    if(text.includes('generation-read'))return result(pin);
    if(text.includes('frozen-spatial:header'))return result(header);
    if(text.includes('job-stock:read'))return stored?result(stock):{rowCount:0,rows:[]};
    if(text.includes('frozen-spatial:validity'))return result({unlocatable_global_parcels:'1',invalid_geometries:'0'});
    if(text.includes('frozen-spatial:counts'))return result({parcel_count:'60001',account_count:'60000',unassociated_parcel_count:'1',subject_included:true});
    if(text.includes('frozen-spatial:parcels')){const page_json=JSON.stringify([{object_id:'1',account_id:'STOCK-A',geometry_sha256:'c'.repeat(64),source_record_hash:null}]);
      return result({page_json,page_count:1,candidate_count:1,next_cursor:'1',page_utf8_bytes:Buffer.byteLength(page_json)});}
    if(text.includes('job-stock:complete')){stored=true;return result({operation_id:id});}
    if(text.includes('job-stock:begin')||text.includes('job-stock:parcels')||text.includes('job-stock:accounts'))return {rowCount:60001,rows:[]};
    throw Error(`unexpected ${text.slice(0,80)}`);
  }};
  return {calls,client,store:createNeighborhoodFrozenJobStock(client,options)};
}
test('exact >50k stock is materialized wholly in SQL, then freshly reopened without spatial recomputation',async()=>{
  const f=fixture(),first=await f.store.prepare();
  assert.equal(first.population.parcel_count,'60001');assert.equal(first.population.unassociated_parcel_count,'1');
  assert.equal(first.population.unlocatable_global_parcels,'1');assert.equal(first.authority,'not_established');
  assert.equal(first.coverage,'exact_original_stock_only');assert.ok(!Object.hasOwn(first,'account_ids'));
  assert.equal(f.calls.filter(call=>call.text.includes('job-stock:parcels')).length,1);
  const from=f.calls.length;
  assert.deepEqual(await createNeighborhoodFrozenJobStock(f.client,options).prepare(),first);
  assert.deepEqual(await createNeighborhoodFrozenJobStock(f.client,options).read(),first);
  assert.ok(!f.calls.slice(from).some(call=>/ST_DWithin|frozen-spatial:counts|job-stock:begin/.test(call.text)));
  assert.ok(f.calls.slice(from).some(call=>call.text.includes('generation-fence')));
  assert.ok(f.calls.every(call=>!['COMMIT','BEGIN','ROLLBACK'].includes(call.text)),'owner alone commits or rolls back');
});
test('missing retained stock never rebuilds on read; changed original/definition/intent/counts refuse',async()=>{
  const missing=fixture();await assert.rejects(missing.store.read(),/unavailable/);
  assert.ok(!missing.calls.some(call=>call.text.includes('ST_DWithin')||call.text.includes('job-stock:begin')));
  for(const change of [row=>row.definition_sha256='d'.repeat(64),row=>row.source_original_sha256='d'.repeat(64),
    row=>row.subject_intent_utf8_bytes='101',row=>row.subject_intent_sha256='d'.repeat(64),row=>row.parcel_count='10',
    row=>row.status='building']) {
    const f=fixture(({text,stock})=>{if(text.includes('job-stock:read')){const row=structuredClone(stock);change(row);return result(row);}},true);
    await assert.rejects(f.store.read(),/conflict/);
  }
});
test('lost/cancelled claim or failed complete ACK returns no stock for owner rollback',async()=>{
  for(const hook of [({text})=>text.includes('generation-fence')?{rowCount:0,rows:[]}:null,
    ({text})=>text.includes('job-stock:complete')?{rowCount:0,rows:[]}:null]) {
    const f=fixture(hook);await assert.rejects(f.store.prepare(),/claim_lost|unavailable/);
  }
  let fences=0;
  const ending=fixture(({text})=>text.includes('generation-fence')&&++fences===4?{rowCount:0,rows:[]}:null,true);
  await assert.rejects(ending.store.read(),/claim_lost/);
});
test('one serial stock lane holds until unsettled SQL resolves and cancelled owner budget refuses work',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const f=fixture(async({text})=>{if(text.includes('job-stock:read'))await pending;},true);
  const first=f.store.read();await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(f.store.read(),/concurrent_operation/);release();await first;
  const cancelled=fixture();const store=createNeighborhoodFrozenJobStock(cancelled.client,{...options,checkBudget(){throw Error('cancelled');}});
  await assert.rejects(store.prepare(),/cancelled/);assert.equal(cancelled.calls.length,0);
});
test('stock arguments detach before awaits; proxies/accessors/coercion and arbitrary rosters refuse',async()=>{
  const f=fixture(()=>{},true);
  for(const bad of [new Proxy(options,{}),{...options,account_ids:['untrusted']},
    {...options,subjectIntent:{...options.subjectIntent,get content_sha256(){throw Error('getter');}}},
    {...options,subjectIntent:{...options.subjectIntent,content_sha256:{toString(){throw Error('coercion');}}}}])
    assert.throws(()=>createNeighborhoodFrozenJobStock(f.client,bad),/invalid_input/);
  const mutable=structuredClone({...options,checkBudget:undefined});mutable.checkBudget=()=>{};
  const store=createNeighborhoodFrozenJobStock(f.client,mutable);mutable.geometryInput.coordinates[0]='-97';mutable.scope.report_file_id=id;
  assert.equal((await store.read()).definition_sha256,assessmentEvidenceDigest(neighborhoodFrozenSpatialDefinition(claim,id,options.geometryInput,options.discovery)));
});
test('additive stock migration has exact indexes, original FKs and immutable publication without changing limits/routes',()=>{
  const name='20261107_custom_cohort_frozen_job_stock.sql';
  const registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8');
  assert.ok(registry.indexOf(name)>registry.indexOf('20261106_neighborhood_frozen_spatial_index.sql'));
  const sql=readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
  assert.match(sql,/REFERENCES app.neighborhood_frozen_source_rows\(generation_id,kind,row_key\)/);
  assert.match(sql,/PRIMARY KEY\(operation_id,object_id\)/);assert.match(sql,/PRIMARY KEY\(operation_id,account_id\)/);
  assert.match(sql,/CREATE INDEX neighborhood_cohort_stock_parcels_original_idx\s+ON app.neighborhood_custom_cohort_stock_parcels\(generation_id,kind,row_key\)/);
  assert.match(sql,/REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT/);
  for(const match of sql.matchAll(/CREATE (?:INDEX|TRIGGER|FUNCTION) ([a-z_.]+)/g))assert.ok(Buffer.byteLength(match[1].replace(/^app\./,''))<=63);
  for(const relation of ['neighborhood_custom_cohort_stock_parcels','neighborhood_custom_cohort_stock_accounts'])
    for(const suffix of ['_insert_guard','_immutable'])assert.ok(Buffer.byteLength(relation+suffix)<=63);
  assert.doesNotMatch(sql,/DISABLE TRIGGER|DROP TABLE|DELETE FROM|UPDATE core\.|UPDATE gis\./);
});

function originalsFixture(hook=()=>{},population={parcel_count:'60001',account_count:'60000',unassociated_parcel_count:'1'}) {
  const f=fixture(async call=>{
    Object.assign(call.stock,population);
    const supplied=await hook(call);if(supplied)return supplied;
    if(call.text.includes('stock-originals:page')) {
      const after=call.values[2]===''?-1:Number(call.values[2]),size=Number(population.parcel_count);
      const count=Math.min(250,size-after-1),last=count===0?null:String(after+count);
      return result({page_count:count,candidate_count:count,unassociated_count:count&&after+count===size-1?Number(population.unassociated_parcel_count):0,
        invalid_count:0,last_object_id:last});
    }
    if(call.text.includes('stock-originals:totals'))return result({...population,invalid_accounts:'0'});
    return null;
  },true);
  return {...f,originals:()=>createNeighborhoodFrozenJobStockOriginals(f.client,options)};
}

test('all 60001 geographic originals use fresh bounded steps, include key zero and reconcile exact end counts',async()=>{
  const f=originalsFixture();let progress=null,done=false,steps=0;
  while(!done){const step=await f.originals().step(progress);progress=step.progress;done=step.all_parcels_verified;
    assert.equal(step.authority,'not_established');assert.equal(step.coverage,'geographic_originals_only');
    assert.ok(Buffer.byteLength(JSON.stringify(progress))<400);assert.equal(step.advanced,true);assert.ok(++steps<=242);}
  assert.equal(steps,241);assert.equal(progress.after_object_id,'60000');assert.equal(progress.verified_parcels,60001);
  assert.equal(progress.verified_unassociated,1);
  const pages=f.calls.filter(call=>call.text.includes('stock-originals:page'));
  assert.equal(pages[0].values[2],'','no synthetic cursor zero silently loses legitimate object_id zero');
  assert.equal(f.calls.filter(call=>call.text.includes('stock-originals:totals')).length,1);
  assert.ok(!f.calls.some(call=>/ST_DWithin|job-stock:begin|job-stock:parcels/.test(call.text)));
  const from=f.calls.length;assert.equal((await f.originals().step(progress)).advanced,false);
  assert.ok(!f.calls.slice(from).some(call=>call.text.includes('stock-originals:')));
});

test('a full 250-row original page requires the separate exact terminal query',async()=>{
  const f=originalsFixture(()=>{},{parcel_count:'250',account_count:'249',unassociated_parcel_count:'1'});
  const first=await f.originals().step(null);assert.equal(first.all_parcels_verified,false);
  const end=await f.originals().step(first.progress);assert.equal(end.all_parcels_verified,true);
  assert.equal(end.progress.verified_parcels,250);assert.equal(end.progress.after_object_id,'249');
});

test('a byte-limited geographic prefix cannot claim end just because it has fewer than 250 rows',async()=>{
  const f=originalsFixture(({text,values})=>text.includes('stock-originals:page')&&values[2]===''?
    result({page_count:125,candidate_count:250,unassociated_count:0,invalid_count:0,last_object_id:'124'}):null,
    {parcel_count:'250',account_count:'249',unassociated_parcel_count:'1'});
  const first=await f.originals().step(null);assert.equal(first.all_parcels_verified,false);
  const next=await f.originals().step(first.progress);assert.equal(next.all_parcels_verified,true);
  assert.equal(next.progress.verified_parcels,250);
});

test('missing/changed original representation and counts refuse rather than publish partial geographic proof',async()=>{
  const fields=[row=>row.invalid_count=1,row=>row.page_count=251,row=>row.last_object_id='-1',
    row=>row.last_object_id=null,row=>row.unassociated_count=251];
  for(const change of fields){const f=originalsFixture(({text})=>{
    if(text.includes('stock-originals:page')){const row={page_count:250,candidate_count:250,unassociated_count:0,invalid_count:0,last_object_id:'249'};change(row);return result(row);}});
    await assert.rejects(f.originals().step(null),/original_mismatch|invalid_progress/);}
  for(const change of [row=>row.parcel_count='4',row=>row.account_count='1',row=>row.unassociated_parcel_count='0',row=>row.invalid_accounts='1']){
    const f=originalsFixture(({text})=>{if(text.includes('stock-originals:totals')){
      const row={parcel_count:'3',account_count:'2',unassociated_parcel_count:'1',invalid_accounts:'0'};change(row);return result(row);}},
    {parcel_count:'3',account_count:'2',unassociated_parcel_count:'1'});
    await assert.rejects(f.originals().step(null),/stock_count_mismatch/);
  }
  const omitted=originalsFixture(({text})=>text.includes('stock-originals:page')?
    result({page_count:0,candidate_count:0,unassociated_count:0,invalid_count:0,last_object_id:null}):null);
  await assert.rejects(omitted.originals().step(null),/stock_count_mismatch/);
});

test('geographic checkpoint cannot change stock, counts, continuation or scalar identity',async()=>{
  const f=originalsFixture(),first=await f.originals().step(null),saved=first.progress;
  for(const change of [p=>p.stock_sha256='e'.repeat(64),p=>p.verified_parcels=60002,
    p=>p.verified_unassociated=2,p=>p.done=true]){
    const p={...saved};change(p);await assert.rejects(f.originals().step(p),/stock_changed/);
  }
  for(const bad of [new Proxy(saved,{}),{...saved,grant:true},{...saved,after_object_id:9223372036854775807},
    {...saved,get verified_parcels(){throw Error('getter');}}, {...saved,after_object_id:'9223372036854775808'}])
    await assert.rejects(f.originals().step(bad),/invalid_input|invalid_progress/);
  const repeated=originalsFixture(({text})=>text.includes('stock-originals:page')?
    result({page_count:1,candidate_count:1,unassociated_count:0,invalid_count:0,last_object_id:'249'}):null);
  await assert.rejects(repeated.originals().step(saved),/invalid_progress/);
});

test('geographic verification detaches continuation and refuses overlap, lost claim or cancelled budget',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});let waiting=false;
  const f=originalsFixture(async({text})=>{if(waiting&&text.includes('job-stock:read'))await pending;});
  const first=await f.originals().step(null),mutable={...first.progress};waiting=true;
  const reader=f.originals(),running=reader.step(mutable);mutable.after_object_id='900';mutable.verified_parcels=1;
  await new Promise(resolve=>setImmediate(resolve));await assert.rejects(reader.step(null),/concurrent_operation/);
  release();const second=await running;assert.equal(second.progress.after_object_id,'499');assert.equal(second.progress.verified_parcels,500);
  const lost=originalsFixture(({text})=>text.includes('generation-fence')?{rowCount:0,rows:[]}:null);
  await assert.rejects(lost.originals().step(null),/claim_lost/);
  const cancelled=createNeighborhoodFrozenJobStockOriginals(f.client,{...options,checkBudget(){throw Error('cancelled');}});
  const from=f.calls.length;await assert.rejects(cancelled.step(null),/cancelled/);assert.equal(f.calls.length,from);
});

test('fixed geographic verification plans preserve NULL originals and normalize Polygon EWKB without spatial recomputation',()=>{
  assert.match(NEIGHBORHOOD_FROZEN_STOCK_ORIGINAL_PAGE_SQL,/LEFT JOIN app\.neighborhood_frozen_source_rows/);
  assert.match(NEIGHBORHOOD_FROZEN_STOCK_ORIGINAL_PAGE_SQL,/ORDER BY stock\.object_id LIMIT 250/);
  assert.match(NEIGHBORHOOD_FROZEN_STOCK_ORIGINAL_PAGE_SQL,/ST_AsEWKB\(ST_Multi\(ST_GeomFromEWKB/);
  assert.match(NEIGHBORHOOD_FROZEN_STOCK_ORIGINAL_PAGE_SQL,/payload \? 'account_id'/);
  assert.match(NEIGHBORHOOD_FROZEN_STOCK_ORIGINAL_TOTALS_SQL,/FULL JOIN recorded USING\(account_id\)/);
  assert.doesNotMatch(NEIGHBORHOOD_FROZEN_STOCK_ORIGINAL_PAGE_SQL+NEIGHBORHOOD_FROZEN_STOCK_ORIGINAL_TOTALS_SQL,
    /ST_DWithin|FROM gis\.|FROM core\.|jsonb_agg|INSERT|UPDATE|DELETE/);
});

const identityGraph={root:{content_sha256:'d'.repeat(64),canonical_utf8_bytes:'100'},
  layer_counts:{parcels:60001,accounts:60000,source_records:1,sales:2,sale_links:2,sync_state:1,sync_runs:1}};
function identityFixture(hook=()=>{},graph=identityGraph){
  const f=fixture(async call=>{
    const supplied=await hook(call);if(supplied)return supplied;
    if(call.text.includes('job-identity:coverage'))return result({missing_account_count:0});
    const kind=Object.keys(NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL).find(k=>call.text===NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL[k]);
    if(kind){const total=graph.layer_counts[kind],previous=call.values[2];
      const seen=previous?(kind==='accounts'?Number(previous.slice(1)):Number(previous)):0;
      const count=Math.min(250,total-seen),last=seen+count;
      return result({page_count:count,candidate_count:count,invalid_count:0,
        unknown_origin_count:kind==='parcels'?count:0,
        last_row_key:count?kind==='accounts'?`A${String(last).padStart(6,'0')}`:kind==='sync_state'?'dcad_parcels'
          :kind==='sync_runs'?id:String(last):null});}
  },true);
  return {...f,identity:()=>createNeighborhoodFrozenJobSourceIdentity(f.client,options,graph)};
}

test('identity DATA validation traverses >50k exact rows using fresh bounded aggregate steps, never dense identifiers',async()=>{
  const f=identityFixture();let progress=null,done=false,steps=0;
  while(!done){const step=await f.identity().step(progress);progress=step.progress;done=step.all_layers_verified;
    assert.equal(step.authority,'not_established');assert.equal(step.coverage,'identity_and_one_hop_associations_only');
    assert.ok(Buffer.byteLength(JSON.stringify(progress))<450);assert.ok(++steps<500);}
  assert.equal(steps,487);assert.equal(progress.unknown_parcel_origins,60001);assert.equal(progress.missing_account_count,0);
  const from=f.calls.length;assert.equal((await f.identity().step(progress)).advanced,false);
  assert.ok(!f.calls.slice(from).some(c=>c.text.includes('job-identity:')));
  assert.ok(!f.calls.some(c=>/ST_DWithin|job-stock:begin|frozen-spatial:counts/.test(c.text)));
});

test('identity steps preserve byte-limited prefixes, explicit absent-account coverage, and strict independent layer counts',async()=>{
  const small={...identityGraph,layer_counts:{parcels:2,accounts:0,source_records:0,sales:0,sale_links:0,sync_state:0,sync_runs:0}};
  let first=true;const f=identityFixture(({text})=>{
    if(text===NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL.parcels&&first){first=false;return result({page_count:1,candidate_count:2,
      invalid_count:0,unknown_origin_count:1,last_row_key:'1'});}
    if(text.includes('job-identity:coverage'))return result({missing_account_count:7});
  },small);
  let p=(await f.identity().step(null)).progress;assert.equal(p.kind_index,0);assert.equal(p.layer_rows,1);
  p=(await f.identity().step(p)).progress;assert.equal(p.kind_index,1);assert.equal(p.layer_rows,0);
  for(let i=0;i<6;i++)p=(await f.identity().step(p)).progress;
  assert.equal(p.kind_index,7);assert.equal(p.missing_account_count,7);assert.equal(p.unknown_parcel_origins,2);
  const wrong=identityFixture(({text})=>text===NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL.parcels
    ?result({page_count:1,candidate_count:1,invalid_count:0,unknown_origin_count:0,last_row_key:'1'}):null,small);
  await assert.rejects(wrong.identity().step(null),/layer_count_mismatch/);
});

test('identity malformed/foreign continuations and aggregate mismatches refuse without pretending typed acquisition',async()=>{
  const f=identityFixture(),first=await f.identity().step(null);
  for(const patch of [{binding_sha256:'e'.repeat(64)},{layer_rows:60002},{after:'-1'},{kind_index:8},
    {missing_account_count:0},{unknown_parcel_origins:60002},{extra:true}])
    await assert.rejects(f.identity().step({...first.progress,...patch}),/invalid_input|invalid_progress|binding_changed/);
  for(const patch of [{invalid_count:1},{candidate_count:0},{page_count:251},{last_row_key:null},
    {unknown_origin_count:251},{page_count:0,last_row_key:null,candidate_count:1}]){
    const bad=identityFixture(({text})=>text===NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL.parcels
      ?result({page_count:250,candidate_count:250,invalid_count:0,unknown_origin_count:0,last_row_key:'250',...patch}):null);
    await assert.rejects(bad.identity().step(null),/identity_mismatch/);
  }
  let invoked=false;const getter={...first.progress};Object.defineProperty(getter,'after',{enumerable:true,get(){invoked=true;return '250';}});
  await assert.rejects(f.identity().step(getter),/invalid_input/);assert.equal(invoked,false);
  await assert.rejects(f.identity().step(new Proxy(first.progress,{})),/invalid_input/);
  const cancelled=createNeighborhoodFrozenJobSourceIdentity(f.client,{...options,checkBudget(){throw Error('cancelled');}},identityGraph);
  const from=f.calls.length;await assert.rejects(cancelled.step(null),/cancelled/);assert.equal(f.calls.length,from);
  const lost=identityFixture(({text})=>text.includes('generation-fence')?{rowCount:0,rows:[]}:null);
  await assert.rejects(lost.identity().step(null),/claim_lost/);
});

test('fixed identity scope uses original stock and one-hop seeds, preserves NULL associations and refuses duplicate package positions',()=>{
  for(const sql of Object.values(NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL)){
    assert.match(sql,/neighborhood_custom_cohort_stock_accounts WHERE operation_id=\$2::uuid/);
    assert.match(sql,/LIMIT 250/);assert.match(sql,/prefix_bytes<=8000000/);
    assert.doesNotMatch(sql,/FROM core\.|FROM gis\.|ST_DWithin|jsonb_agg|INSERT|UPDATE|DELETE|sale_price.*::(?:float|double)/);
  }
  assert.match(NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL.sale_links,/other\.source_record_id=original\.source_record_id/);
  assert.match(NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL.sales,/IS NOT DISTINCT FROM original\.source_record_id::text/);
  assert.match(NEIGHBORHOOD_FROZEN_JOB_IDENTITY_COVERAGE_SQL,/NOT EXISTS/);
});

test('additive original link identity index keeps duplicate-position probes bounded within large packages',()=>{
  const name='20261108_neighborhood_frozen_link_identity_index.sql';
  const migration=readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
  const registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8');
  assert.ok(registry.includes(name));assert.ok(registry.indexOf(name)>registry.indexOf('20261107_custom_cohort_frozen_job_stock.sql'));
  assert.match(migration,/CREATE INDEX IF NOT EXISTS neighborhood_frozen_link_identity_idx/);
  assert.match(migration,/generation_id, source_record_id, \(payload->>'source_position'\), \(payload->>'parcel_sequence'\), row_key/);
  assert.match(migration,/WHERE kind='sale_links'/);
  assert.doesNotMatch(migration,/DROP|DELETE|UPDATE|TRUNCATE|DISABLE|CONCURRENTLY/);
});

const typedGraph={root:identityGraph.root,layer_counts:{parcels:2,accounts:0,source_records:0,sales:0,sale_links:0,sync_state:0,sync_runs:0}};
function typedFixture(hook=()=>{}) {
  let header=null;const counts={};
  const f=fixture(async call=>{
    const supplied=await hook(call,()=>header);if(supplied)return supplied;
    const {text,values}=call;
    if(text.includes('job-typed:read'))return header?result(structuredClone(header)):{rowCount:0,rows:[]};
    if(text.includes('job-typed:begin')){header={binding_sha256:values[2],profile_sha256:values[3],effective_date:values[4],
      expected_counts:JSON.parse(values[5]),progress:JSON.parse(values[6]),status:'building'};return result({});}
    if(text.includes('job-closure:')){
      const kind=Object.keys(typedGraph.layer_counts).find(k=>text.includes(`job-closure:${k}`));
      const rows=kind==='parcels'&&values[2]===''?[1,2].map(n=>({row_key:String(n),payload_text:JSON.stringify({object_id:String(n),
        account_id:'STOCK-A',residential_year_built:1960,residential_area_sqft:'1000.000',parcel_area_sqft:'8000',current_market_value:'9007199254740993'})})):[];
      const page_json=JSON.stringify(rows);
      return result({page_json,page_count:rows.length,candidate_count:rows.length,next_cursor:rows.at(-1)?.row_key??values[2],page_utf8_bytes:Buffer.byteLength(page_json)});
    }
    if(text.includes('job-typed:rows')){const rows=JSON.parse(values[3]);counts[values[2]]=(counts[values[2]]??0)+rows.length;return result({inserted_count:rows.length});}
    if(text.includes('job-typed:counts')){const rows=Object.entries(counts).map(([kind,n])=>({kind,row_count:String(n)}));return {rowCount:rows.length,rows};}
    if(text.includes('job-typed:progress')){header.progress=JSON.parse(values[2]);header.status=values[3];return result({});}
  },true);
  return {...f,typed:(date='2026-08-31')=>createNeighborhoodFrozenJobTypedOriginals(f.client,options,typedGraph,date),header:()=>header};
}
test('typed indexed pages retain individual exact originals and independently reconcile all seven layer counts',async()=>{
  const f=typedFixture();let p=null,done=false,steps=0;
  while(!done){const step=await f.typed().step(p);p=step.progress;done=step.all_layers_typed;assert.ok(++steps<=7);
    assert.equal(step.authority,'not_established');assert.equal(step.coverage,'individual_original_interpretations_only');}
  assert.equal(steps,7);assert.equal(f.header().status,'complete');assert.ok(Buffer.byteLength(JSON.stringify(p))<400);
  const inserted=JSON.parse(f.calls.find(c=>c.text.includes('job-typed:rows')).values[3]);
  assert.equal(inserted[0].typed.observations.reported_market_value.exact_value,'9007199254740993');
  const from=f.calls.length;assert.equal((await f.typed().step(p)).advanced,false);
  assert.ok(!f.calls.slice(from).some(c=>/job-closure:|job-typed:rows|job-typed:progress/.test(c.text)));
  assert.ok(!f.calls.some(c=>/ST_DWithin|FROM core\.|FROM gis\.|job-stock:begin|^COMMIT$/.test(c.text)));
});
test('typed checkpoints bind original graph/profile/effective date and immutable database progress',async()=>{
  const f=typedFixture(),first=await f.typed().step(null);
  for(const patch of [{binding_sha256:'e'.repeat(64)},{kind_index:8},{after:'1',layer_rows:0},{extra:true}])
    await assert.rejects(f.typed().step({...first.progress,...patch}),/invalid_input|invalid_progress|binding_changed/);
  await assert.rejects(f.typed('2025-08-31').step(first.progress),/binding_changed/);
  await assert.rejects(f.typed().step(null),/checkpoint_mismatch/);
  f.header().profile_sha256='e'.repeat(64);await assert.rejects(f.typed().step(first.progress),/checkpoint_mismatch/);
});
test('typed row acknowledgement, independent total and progress-CAS failures refuse for owner rollback',async()=>{
  const missing=typedFixture(({text})=>text.includes('job-typed:rows')?result({inserted_count:1}):null);
  await assert.rejects(missing.typed().step(null),/original_mismatch/);
  const lost=typedFixture(({text})=>text.includes('job-typed:progress')?{rowCount:0,rows:[]}:null);
  await assert.rejects(lost.typed().step(null),/write_lost/);
  const counts=typedFixture(({text})=>text.includes('job-typed:counts')?{rowCount:0,rows:[]}:null);
  let p=null;for(let i=0;i<6;i++)p=(await counts.typed().step(p)).progress;
  await assert.rejects(counts.typed().step(p),/population_incomplete/);
});
test('typed continuation detaches primitives and refuses getters, proxies, cancelled/lost claim and overlap',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});let waiting=false;
  const f=typedFixture(async({text})=>{if(waiting&&text.includes('job-stock:read'))await pending;});
  const first=await f.typed().step(null),mutable={...first.progress};let invoked=false;
  const getter={...mutable};Object.defineProperty(getter,'after',{enumerable:true,get(){invoked=true;return '';}});
  await assert.rejects(f.typed().step(getter),/invalid_input/);assert.equal(invoked,false);
  await assert.rejects(f.typed().step(new Proxy(mutable,{})),/invalid_input/);
  waiting=true;const lane=f.typed(),running=lane.step(mutable);mutable.kind_index=7;
  await new Promise(resolve=>setImmediate(resolve));await assert.rejects(lane.step(null),/concurrent_operation/);release();
  assert.equal((await running).progress.kind_index,2);
  const cancelled=createNeighborhoodFrozenJobTypedOriginals(f.client,{...options,checkBudget(){throw Error('cancelled');}},typedGraph,'2026-08-31');
  const from=f.calls.length;await assert.rejects(cancelled.step(null),/cancelled/);assert.equal(f.calls.length,from);
  const lost=typedFixture(({text})=>text.includes('generation-fence')?{rowCount:0,rows:[]}:null);
  await assert.rejects(lost.typed().step(null),/claim_lost/);
});
