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
import { compileNeighborhoodFrozenTypedOriginalV2,getNeighborhoodFrozenTypedOriginalV1Profile, getNeighborhoodFrozenTypedOriginalV2Profile } from '../src/services/neighborhoodAssessment/neighborhoodFrozenTypedOriginalV1.js';
import { createNeighborhoodFrozenJobSourceSeeds,NEIGHBORHOOD_FROZEN_JOB_SEED_SQL } from '../src/services/neighborhoodAssessment/neighborhoodFrozenJobSourceSeeds.js';
import { CACHED_SALE_WITNESS_V2_FIELDS } from '../src/services/neighborhoodAssessment/cachedSaleWitnessV2.js';
import { prepareNeighborhoodTypedTransactionV2 } from '../src/services/neighborhoodAssessment/neighborhoodFrozenTypedTransactionV2.js';
import { createNeighborhoodSharedJobTransactionPagesV2,prepareNeighborhoodSharedTransactionPageV2,
  getNeighborhoodSharedTransactionPageV2Profile,NEIGHBORHOOD_SHARED_JOB_TRANSACTION_V2_PAGE_SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodSharedJobTransactionPagesV2.js';
import { createNeighborhoodSharedTransactionPackagesV1, NEIGHBORHOOD_TRANSACTION_PACKAGE_V1_SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodSharedTransactionPackagesV1.js';
import { NEIGHBORHOOD_ORIGINAL_TRANSACTION_PACKAGE_V2_SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodOriginalTransactionPackagesV2.js';
import { createNeighborhoodSharedStockOriginalCellsV2, prepareNeighborhoodStockOriginalCellPageV2,
  prepareNeighborhoodStockAccountPackagePageV2, NEIGHBORHOOD_STOCK_ACCOUNT_PACKAGE_V2_SQL, NEIGHBORHOOD_STOCK_SUBJECT_HOUSING_PACKAGE_V2_SQL,
  NEIGHBORHOOD_STOCK_SUBJECT_AND_NEXT_PACKAGE_V2_SQL,NEIGHBORHOOD_STOCK_SUBJECT_AND_FIRST_SELECTED_PACKAGE_V2_SQL,
  getNeighborhoodStockAccountPackageV2Profile,
  NEIGHBORHOOD_STOCK_ORIGINAL_CELLS_V2_PAGE_SQL, getNeighborhoodStockOriginalCellsV2Profile }
  from '../src/services/neighborhoodAssessment/neighborhoodSharedStockOriginalCellsV2.js';
import { getNeighborhoodOriginalAccountHousingV2Profile,resolveNeighborhoodOriginalAccountHousingV2 }
  from '../src/services/neighborhoodAssessment/neighborhoodOriginalAccountHousingV2.js';
import { resolveNeighborhoodOriginalAccountEligibilityV2 } from '../src/services/neighborhoodAssessment/neighborhoodOriginalAccountEligibilityV2.js';
import { getCustomCohortRecordedHousingInterpretation }
  from '../src/services/neighborhoodAssessment/customCohortRecordedHousingProfiles.js';
import { NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL, NEIGHBORHOOD_FROZEN_JOB_IDENTITY_COVERAGE_SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenSourceClosurePages.js';
import { createNeighborhoodSharedJobCadImprovementPages,prepareNeighborhoodSharedJobCadPage,NEIGHBORHOOD_SHARED_JOB_CAD_PAGE_SQL,
  createNeighborhoodSharedJobCadAccountPages,prepareNeighborhoodSharedJobCadAccountPage,getNeighborhoodSharedJobCadAccountProfile,
  NEIGHBORHOOD_SHARED_JOB_CAD_ACCOUNT_PAGE_SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodSharedJobCadImprovementPages.js';
import { NEIGHBORHOOD_SHARED_TYPED_CAD_SQL } from '../src/services/neighborhoodAssessment/neighborhoodSharedTypedGeneration.js';
import { compileNeighborhoodFrozenTypedCadImprovementV1,getNeighborhoodFrozenTypedCadImprovementV1Profile }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenTypedCadImprovementV1.js';
import { getNeighborhoodFrozenCadImprovementProfile } from '../src/services/neighborhoodAssessment/neighborhoodFrozenCadImprovements.js';
import { NEIGHBORHOOD_ORIGINAL_CAD_ACCOUNT_PACKAGE_V2_SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodOriginalCadAccountPackagesV2.js';

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

const transactionOriginalTexts=new Map();
function transactionRow(kind='source_records',row_key='10',overrides={}){
  const fields=Object.fromEntries(CACHED_SALE_WITNESS_V2_FIELDS.map(k=>[k,{state:'absent',json_type:null,value_text:null,utf8_bytes:null}]));
  for(const [k,text] of Object.entries({MlsStatus:'closed',CloseDate:'2027-01-01',ClosePrice:'9007199254740993.01',
    ClosePriceCurrency:'USD',LivingArea:'1000.001',LivingAreaUnits:'sqft',YearBuilt:'2050'}))
    fields[k]={state:'scalar',json_type:'string',value_text:text,utf8_bytes:Buffer.byteLength(text)};
  const payload={id:row_key,...(kind==='source_records'?{primary_account_id:'OUTSIDE',source_raw_witness:{witness_version:2,
    root_state:'object',root_json_type:'object',fields},current_price:'9007199254740993',year_built:2050,close_date:'2027-01-01'}
    :{account_id:kind==='sale_links'?'OUTSIDE':'STOCK-A',source_record_id:kind==='sales'?null:'10',
      ...(kind==='sales'?{sale_price:'0.01',closing_date:'2027-01-01'}:{source_position:1,parcel_sequence:1,is_resolved:false})}),...overrides};
  const typed=compileNeighborhoodFrozenTypedOriginalV2({kind,row_key,payload_text:JSON.stringify(payload)});
  transactionOriginalTexts.set(typed.original.payload_sha256,JSON.stringify(payload));
  return {kind,row_key,account_id:typed.account_id,source_record_id:typed.source_record_id,
    original_payload_sha256:typed.original.payload_sha256,typed};
}
async function transactionFixture(hook=()=>{},counts={source_records:4,sales:1,sale_links:1}){
  let source,sharedHeader,seedHeader;
  const rows={source_records:['10','2','3','4'].slice(0,counts.source_records??0).map(k=>transactionRow('source_records',k)),
    sales:counts.sales?[transactionRow('sales')]:[],sale_links:counts.sale_links?[transactionRow('sale_links')]:[]};
  const f=fixture(async call=>{
    const supplied=await hook({...call,source,sharedHeader,seedHeader,rows});if(supplied)return supplied;
    const {text,values}=call;
    if(text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.source)return result(structuredClone(source));
    if(text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read)return result(structuredClone(sharedHeader));
    if(text===NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.read)return seedHeader?result(structuredClone(seedHeader)):{rowCount:0,rows:[]};
    if(text===NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.begin){seedHeader={generation_id:values[1],binding_sha256:values[2],
      definition_sha256:values[3],definition_json:values[4],status:'building',seed_count:'0',completed_at:null};return result({operation_id:id});}
    if(text===NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.rows)return result({inserted_count:'1'});
    if(text===NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.complete){Object.assign(seedHeader,{status:'complete',seed_count:values[2],completed_at:date});return result({seed_count:values[2]});}
    if([...Object.values(NEIGHBORHOOD_TRANSACTION_PACKAGE_V1_SQL),...Object.values(NEIGHBORHOOD_ORIGINAL_TRANSACTION_PACKAGE_V2_SQL)].includes(text)){
      const original=Object.values(NEIGHBORHOOD_ORIGINAL_TRANSACTION_PACKAGE_V2_SQL).includes(text);
      const legacy=text===(original?NEIGHBORHOOD_ORIGINAL_TRANSACTION_PACKAGE_V2_SQL:NEIGHBORHOOD_TRANSACTION_PACKAGE_V1_SQL).legacy_sale;
      const chosen=legacy?rows.sales.filter(r=>r.source_record_id===null&&r.account_id==='STOCK-A'
        &&Buffer.compare(Buffer.from(r.row_key),Buffer.from(values[3]))>0)[0]?.row_key
        :(!values[3]||BigInt(values[3])<10n?'10':null);
      const selected=chosen?Object.values(rows).flat().filter(r=>legacy?r.kind==='sales'&&r.row_key===chosen&&r.source_record_id===null
        :r.source_record_id===chosen):[];
      selected.sort((a,b)=>Buffer.compare(Buffer.from(`${a.kind}:${a.row_key}`),Buffer.from(`${b.kind}:${b.row_key}`)));
      return result({package_key:chosen??null,counts:Object.fromEntries(['source_records','sales','sale_links'].map(k=>[k,
        String(selected.filter(r=>r.kind===k).length)])),row_count:selected.length,packet_oversize:false,
      packet_json:JSON.stringify(selected.map(row=>original?{...row,original_text:transactionOriginalTexts.get(row.original_payload_sha256),
        cached_account_id:row.account_id,cached_source_record_id:row.source_record_id,
        stock_member:row.account_id===null?null:row.account_id==='STOCK-A'}:{row,stock_member:row.account_id===null?null:row.account_id==='STOCK-A'})),
      ...(original?{invalid_count:0,scan_count:chosen?1:0,scan_cursor:chosen??null}:{})});
    }
    if(text===NEIGHBORHOOD_SHARED_JOB_TRANSACTION_V2_PAGE_SQL){
      const selected=rows[values[3]].filter(r=>Buffer.compare(Buffer.from(r.row_key),Buffer.from(values[4]))>0).slice(0,values[5]);
      return result({page_json:JSON.stringify(selected),page_count:selected.length,candidate_count:selected.length,
        oversized_count:0,next_cursor:selected.at(-1)?.row_key??null});
    }
  },true,counts);
  const stock=await f.store.read(),o=stock.original,profile=getNeighborhoodFrozenTypedOriginalV2Profile();
  source={generation_id:id,format_version:1,status:'complete',source_snapshot:o.source_snapshot,started_at:o.source_transaction_started_at,
    completed_at:o.completed_at,layer_counts:o.layer_counts,row_count:o.row_count,payload_utf8_bytes:o.payload_utf8_bytes};
  const binding=assessmentEvidenceDigest({source,profile});
  sharedHeader={binding_sha256:binding,source_metadata:source,definition_json:profile.definition_blob.canonical_json,status:'complete',completed_at:date,
    progress:{format:'shared_frozen_typed_progress_v2',binding_sha256:binding,kind_index:7,after:'',layer_rows:0,typed_rows:source.row_count,typed_utf8_bytes:'12002000'}};
  await createNeighborhoodFrozenJobSourceSeeds(f.client,options).prepare();
  const graph={root:{content_sha256:'c'.repeat(64),canonical_utf8_bytes:'100'},
    layer_counts:{parcels:60001,accounts:0,source_records:counts.source_records??0,sales:counts.sales??0,sale_links:counts.sale_links??0,sync_state:0,sync_runs:0}};
  return {...f,rows,source,sharedHeader,seedHeader,graph,pages:()=>createNeighborhoodSharedJobTransactionPagesV2(f.client,options,graph),
    packages:()=>createNeighborhoodSharedTransactionPackagesV1(f.client,options,graph,'2026-10-07',{start_date:'2025-01-01',end_date:'2026-10-07'})};
}

test('whole native package DATA reader reopens all current fences, projects retained dates and requires a fresh empty probe without writes',async()=>{
  const f=await transactionFixture();f.rows.sale_links=[transactionRow('sale_links','1',{account_id:'STOCK-A'})];
  const from=f.calls.length,reader=f.packages(),first=await reader.page({kind:'source_record',cursor:''});
  assert.deepEqual(first.package.counts,{source_records:'1',sales:'0',sale_links:'1'});
  assert.equal(first.end_of_kind,false);assert.equal(first.package.associations.unresolved_link_count,1);
  assert.equal(first.package.rows.find(e=>e.projection.kind==='source_records').projection.normalized.observations.normalized_year_built.state,'invalid');
  assert.equal(first.package.associations.outside_account_count,1);assert.equal(first.transaction_eligibility,'not_established');
  assert.equal((await f.packages().page({kind:'source_record',cursor:'10'})).end_of_kind,true);
  assert.equal((await f.packages().page({kind:'legacy_sale',cursor:''})).package.rows[0].projection.source_record_id,null);
  await assert.rejects(reader.page({kind:'source_record',cursor:''}),/single_use/);
  const calls=f.calls.slice(from);assert.ok(calls.length<=128*3);assert.ok(calls.every(c=>c.query_timeout===5000));
  assert.equal(calls.filter(c=>c.text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read).length,6);
  assert.equal(calls.filter(c=>c.text===NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.read).length,12);
  assert.ok(!calls.some(c=>/INSERT|UPDATE|DELETE|ST_DWithin|FROM core\.|payload::text|shared-typed-v2:(?:page|rows|lock)/.test(c.text)));
});

test('whole native package reader refuses missing or changed cache/seed/source/claim and cancellation before delivery',async()=>{
  for(const change of [h=>h.status='building',h=>h.progress.kind_index=6,h=>h.binding_sha256='e'.repeat(64)]){
    const f=await transactionFixture(({text,sharedHeader})=>{if(text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read){
      const h=structuredClone(sharedHeader);change(h);return result(h);}});
    await assert.rejects(f.packages().page({kind:'source_record',cursor:''}),/cache_unavailable/);
    assert.ok(!f.calls.some(c=>Object.values(NEIGHBORHOOD_TRANSACTION_PACKAGE_V1_SQL).includes(c.text)));
  }
  let reads=0;const ending=await transactionFixture(({text,sharedHeader})=>text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read&&++reads===2
    ?result({...sharedHeader,status:'building'}):null);
  ending.rows.sale_links=[transactionRow('sale_links','1',{account_id:'STOCK-A'})];
  await assert.rejects(ending.packages().page({kind:'source_record',cursor:''}),/cache_unavailable/);
  const seeds=await transactionFixture();seeds.seedHeader.status='building';
  await assert.rejects(seeds.packages().page({kind:'source_record',cursor:''}),/unfinished_or_changed_index/);
  let loseClaim=false;const lost=await transactionFixture(({text})=>loseClaim&&text.includes('generation-fence')?{rowCount:0,rows:[]}:null);
  loseClaim=true;
  await assert.rejects(lost.packages().page({kind:'source_record',cursor:''}),/claim_lost/);
  const f=await transactionFixture(),from=f.calls.length;
  const cancelled=createNeighborhoodSharedTransactionPackagesV1(f.client,{...options,checkBudget(){throw Error('cancelled');}},f.graph,
    '2026-10-07',{start_date:'2025-01-01',end_date:'2026-10-07'});
  await assert.rejects(cancelled.page({kind:'source_record',cursor:''}),/cancelled/);assert.equal(f.calls.length,from);
});

test('original transaction consumer shares the real stock/seed/cache budget, replay and ending fences, not a caller callback',async()=>{
  const f=await transactionFixture();f.rows.sale_links=[transactionRow('sale_links','1',{account_id:'STOCK-A'})];
  const start=f.calls.length,reader=f.packages(),first=await reader.originalPage({kind:'source_record',cursor:''});
  assert.equal(first.status,'original_reconciled_native_transaction_package_page');
  assert.equal(first.original_reconciliation,'every_package_original_recompiled_before_retained_projection');
  assert.equal(first.package.rows.find(e=>e.projection.kind==='source_records').projection.normalized.observations.normalized_year_built.state,'invalid');
  assert.doesNotMatch(JSON.stringify(first.package),/original_text|cached_account_id/);
  await assert.rejects(reader.page({kind:'source_record',cursor:''}),/single_use/);
  const end=await f.packages().originalPage({kind:'source_record',cursor:'10'});assert.equal(end.end_of_kind,true);
  const calls=f.calls.slice(start);assert.ok(calls.length<=256);assert.ok(calls.every(c=>c.query_timeout===5000));
  assert.ok(!calls.some(c=>/INSERT|UPDATE|DELETE|ST_DWithin|FROM core\.|shared-typed-v2:(?:rows|lock)/.test(c.text)));
  let headers=0;const changed=await transactionFixture(({text,sharedHeader})=>text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read&&++headers===2
    ?result({...sharedHeader,status:'building'}):null);
  changed.rows.sale_links=[transactionRow('sale_links','1',{account_id:'STOCK-A'})];
  await assert.rejects(changed.packages().originalPage({kind:'source_record',cursor:''}),/cache_unavailable/);
  const forge=await transactionFixture(({text,rows})=>text===NEIGHBORHOOD_ORIGINAL_TRANSACTION_PACKAGE_V2_SQL.source_record?(()=>{
    const r=rows.source_records[0],typed=structuredClone(r.typed);typed.observations.normalized_current_price.exact_value='1';
    return result({package_key:'10',counts:{source_records:'1',sales:'0',sale_links:'0'},row_count:1,invalid_count:0,
      packet_oversize:false,scan_count:1,scan_cursor:'10',packet_json:JSON.stringify([{...r,typed,
        original_text:transactionOriginalTexts.get(r.original_payload_sha256),cached_account_id:r.account_id,
        cached_source_record_id:r.source_record_id,stock_member:false}])});})():null);
  await assert.rejects(forge.packages().originalPage({kind:'source_record',cursor:''}),/original_mismatch/);
  const sparse=await transactionFixture(({text})=>text===NEIGHBORHOOD_ORIGINAL_TRANSACTION_PACKAGE_V2_SQL.legacy_sale
    ?result({package_key:null,counts:{source_records:'0',sales:'0',sale_links:'0'},row_count:0,invalid_count:0,
      packet_oversize:false,packet_json:'[]',scan_count:250,scan_cursor:'999'}):null);
  const empty=await sparse.packages().originalPage({kind:'legacy_sale',cursor:''});
  assert.equal(empty.package,null);assert.equal(empty.next_cursor,'999');assert.equal(empty.end_of_kind,false);
});

test('neutral transaction cells reconcile exact bounded raw diagnostics without currency or normalized fallback',()=>{
  const row=transactionRow(),r=prepareNeighborhoodTypedTransactionV2(row);
  assert.equal(r.typed.same_payload_reported_sale.observations.reported_close_price.exact_value,'9007199254740993.01');
  assert.equal(r.typed.same_payload_reported_sale.observations.reported_close_price.unit,'USD');
  assert.equal(r.typed.observations.normalized_current_price.state,'unsupported');
  assert.equal(r.typed.observations.normalized_current_price.exact_value,'9007199254740993');
  assert.equal(r.typed.observations.normalized_year_built.exact_value,'2050','neutral syntax does not claim report eligibility');
  assert.equal(r.account_id,'OUTSIDE');assert.equal(r.typed.authority,'not_established');assert.ok(Object.isFrozen(r.typed));
  assert.equal(prepareNeighborhoodTypedTransactionV2(transactionRow('sales')).source_record_id,null);
  assert.equal(prepareNeighborhoodTypedTransactionV2(transactionRow('sale_links')).typed.markers.is_resolved.value_text,'false');
  for(const change of [r=>r.original_payload_sha256='e'.repeat(64),r=>r.typed.account_id='WRONG',
    r=>r.typed.observations.normalized_year_built.exact_value='2000',r=>r.typed.observations.normalized_current_price.unit='USD',
    r=>r.typed.same_payload_reported_sale.observations.reported_close_price.exact_value='1',
    r=>r.typed.same_payload_reported_sale.record_type.state='nonclosed',r=>r.typed.dates.close_date.exact_value='2020-01-01',
    r=>r.typed.markers.record_type.value_sha256='e'.repeat(64),r=>r.typed.effective_date='2020-01-01']){
    const bad=structuredClone(row);change(bad);assert.throws(()=>prepareNeighborhoodTypedTransactionV2(bad),/invalid_/);
  }
  const hostile=structuredClone(row);Object.defineProperty(hostile.typed.same_payload_reported_sale.observations,'reported_close_price',
    {enumerable:true,get(){assert.fail('nested getter must not execute');}});
  assert.throws(()=>prepareNeighborhoodTypedTransactionV2(hostile),/invalid_data/);
  assert.throws(()=>prepareNeighborhoodTypedTransactionV2(new Proxy(row,{})),/invalid_data/);
  assert.throws(()=>prepareNeighborhoodTypedTransactionV2(transactionRow('sale_links','10',{source_record_id:null})),/invalid_identity/);
});

test('shared transaction pages are one-hop all-date neutral DATA including outside links and source-less stock sales',async()=>{
  const f=await transactionFixture(),from=f.calls.length;
  for(const kind of ['source_records','sales','sale_links']){
    const p=await f.pages().page({kind,cursor:'',rowLimit:250});
    assert.equal(p.kind,kind);assert.equal(p.end_of_kind,true);assert.equal(p.coverage,'one_kind_page_only');
    assert.equal(p.transaction_eligibility,'not_established');assert.equal(p.source_acquisition,'not_established');assert.equal(p.report_update,'none');
    assert.deepEqual(p.typed_profile,getNeighborhoodFrozenTypedOriginalV2Profile());assert.deepEqual(p.page_profile,getNeighborhoodSharedTransactionPageV2Profile());
    if(kind==='source_records'){assert.equal(p.rows[0].row_key,'10');assert.equal(p.rows[1].row_key,'2');
      assert.equal(p.rows[0].typed.same_payload_reported_sale.close_date.exact_value,'2027-01-01');}
    if(kind==='sale_links')assert.equal(p.rows[0].account_id,'OUTSIDE');
    if(kind==='sales')assert.equal(p.rows[0].source_record_id,null);
  }
  const calls=f.calls.slice(from);assert.ok(!calls.some(c=>/INSERT|UPDATE|DELETE|ST_DWithin|FROM core\.|payload::text|shared-typed-v2:(?:page|rows|lock)/.test(c.text)));
  assert.equal(calls.filter(c=>c.text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read).length,6);
  assert.equal(calls.filter(c=>c.text===NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.read).length,12);
  assert.ok(calls.every(c=>c.query_timeout===5000));assert.ok(calls.length<=128*3);
  const sql=NEIGHBORHOOD_SHARED_JOB_TRANSACTION_V2_PAGE_SQL;
  assert.match(sql,/s\.operation_id=\$1::uuid AND s\.generation_id=\$2::uuid AND s\.source_record_id=t\.source_record_id/);
  assert.match(sql,/t\.kind='sales' AND t\.source_record_id IS NULL/);
  assert.doesNotMatch(sql,/effective_date|closing_date|ST_DWithin|JOIN app\.neighborhood_frozen_source_rows|array_agg|sum\(.*price/i);
});

test('transaction kind keysets preserve full/short/empty boundaries and count every nested fence query',async()=>{
  const f=await transactionFixture(),p=await f.pages().page({kind:'source_records',cursor:'',rowLimit:4});
  assert.equal(p.end_of_kind,false);assert.equal(p.next_cursor,'4');
  const reader=f.pages(),end=await reader.page({kind:'source_records',cursor:p.next_cursor,rowLimit:4});
  assert.deepEqual(end.rows,[]);assert.equal(end.next_cursor,'4');assert.equal(end.end_of_kind,true);
  await assert.rejects(reader.page({kind:'source_records',cursor:'',rowLimit:1}),/single_use/);
  const large=await transactionFixture(()=>null,{source_records:250});
  large.rows.source_records=Array.from({length:250},(_,i)=>transactionRow('source_records',String(i+1))).sort((a,b)=>Buffer.compare(Buffer.from(a.row_key),Buffer.from(b.row_key)));
  const from=large.calls.length,full=await large.pages().page({kind:'source_records',cursor:'',rowLimit:250});
  assert.equal(full.rows.length,250);assert.equal(full.end_of_kind,false);assert.ok(large.calls.length-from<=128);
  assert.equal((await large.pages().page({kind:'source_records',cursor:full.next_cursor,rowLimit:250})).end_of_kind,true);
});

test('transaction pages refuse unfinished caches/seeds, forged cells/order and all ending metadata changes',async()=>{
  for(const mutation of [h=>h.status='building',h=>h.progress.kind_index=6,h=>h.progress.format='shared_frozen_typed_progress_v1',
    h=>h.source_metadata.source_snapshot='2:3:',h=>h.binding_sha256='e'.repeat(64)]){
    const f=await transactionFixture(({text,sharedHeader})=>{if(text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read){const h=structuredClone(sharedHeader);mutation(h);return result(h);}});
    await assert.rejects(f.pages().page({kind:'source_records',cursor:'',rowLimit:1}),/cache_unavailable/);
    assert.ok(!f.calls.some(c=>c.text===NEIGHBORHOOD_SHARED_JOB_TRANSACTION_V2_PAGE_SQL));
  }
  for(const mutation of [f=>f.seedHeader.status='building',f=>{f.rows.source_records[0]=structuredClone(f.rows.source_records[0]);
    f.rows.source_records[0].typed.observations.normalized_year_built.exact_value='1';},
    f=>f.rows.source_records.reverse(),f=>f.graph.layer_counts.source_records=0]){
    const f=await transactionFixture();mutation(f);await assert.rejects(f.pages().page({kind:'source_records',cursor:'',rowLimit:250}),/unfinished|invalid_|source_mismatch/);
  }
  let headers=0;const f=await transactionFixture(({text,sharedHeader})=>text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read&&++headers===2
    ?result({...sharedHeader,status:'building'}):null);
  await assert.rejects(f.pages().page({kind:'source_records',cursor:'',rowLimit:1}),/cache_unavailable/);
  for(const bad of [{kind:'parcels',cursor:'',rowLimit:1},{kind:'source_records',cursor:'0',rowLimit:1},
    {kind:'source_records',cursor:'9223372036854775808',rowLimit:1},{kind:'sales',cursor:'',rowLimit:251},
    {kind:'sales',cursor:'',rowLimit:1,date:'2020-01-01'},new Proxy({kind:'sales',cursor:'',rowLimit:1},{}),
    {kind:'sales',get cursor(){assert.fail('getter');},rowLimit:1}])assert.throws(()=>prepareNeighborhoodSharedTransactionPageV2(bad),/invalid_/);
  for(const o of [{...options,effectiveDate:'2020-01-01'},{...options,sourceGrant:{allowed:true}},new Proxy(options,{})])
    assert.throws(()=>createNeighborhoodSharedJobTransactionPagesV2(f.client,o,f.graph),/invalid_input/);
});

test('transaction byte-prefix admission cannot hide oversized rows or turn a partial page into an end receipt',async()=>{
  const partial=await transactionFixture(({text,rows})=>text===NEIGHBORHOOD_SHARED_JOB_TRANSACTION_V2_PAGE_SQL
    ?result({page_json:JSON.stringify(rows.source_records.slice(0,1)),page_count:1,candidate_count:4,oversized_count:0,next_cursor:'10'}):null);
  const p=await partial.pages().page({kind:'source_records',cursor:'',rowLimit:4});assert.equal(p.rows.length,1);assert.equal(p.end_of_kind,false);
  for(const response of [{page_json:'[]',page_count:0,candidate_count:1,oversized_count:0,next_cursor:null},
    {page_json:'[]',page_count:0,candidate_count:1,oversized_count:1,next_cursor:null}]){
    const f=await transactionFixture(({text})=>text===NEIGHBORHOOD_SHARED_JOB_TRANSACTION_V2_PAGE_SQL?result(response):null);
    await assert.rejects(f.pages().page({kind:'source_records',cursor:'',rowLimit:1}),/invalid_result/);
  }
  const f=await transactionFixture(),from=f.calls.length;
  const reader=createNeighborhoodSharedJobTransactionPagesV2(f.client,{...options,checkBudget(){throw Error('synthetic cancellation');}},f.graph);
  await assert.rejects(reader.page({kind:'source_records',cursor:'',rowLimit:1}),/synthetic cancellation/);
  assert.equal(f.calls.length,from,'cancelled budget refuses before any nested SQL');
  assert.match(NEIGHBORHOOD_SHARED_JOB_TRANSACTION_V2_PAGE_SQL,/bytes<=\$8::integer AND cumulative\+1<=\$7::integer/);
});

function fixture(hook=()=>{},initial=false,transactionCounts=null) {
  const calls=[];let stored=initial;
  const pin={generation_id:id,status:'complete',retirement_started_at:null,source_observed_at:date,completed_at:date,parcel_count:'60002',sale_count:'0',group_count:'1'};
  const header={generation_id:id,format_version:1,status:'complete',source_snapshot:'1:2:',started_at:date,completed_at:date,
    row_count:String(60002+(transactionCounts?Object.values(transactionCounts).reduce((n,v)=>n+v,0):0)),
    payload_utf8_bytes:String(6000200+(transactionCounts?Object.values(transactionCounts).reduce((n,v)=>n+v*100,0):0)),layer_counts:Object.fromEntries(
      ['parcels','accounts','source_records','sales','sale_links','sync_state','sync_runs'].map(kind=>[kind,
        {row_count:kind==='parcels'?'60002':String(transactionCounts?.[kind]??0),
          payload_utf8_bytes:kind==='parcels'?'6000200':String((transactionCounts?.[kind]??0)*100)}]))};
  const original={generation_id:id,source_format_version:1,source_snapshot:'1:2:',source_transaction_started_at:date,completed_at:date,
    row_count:header.row_count,payload_utf8_bytes:header.payload_utf8_bytes,layer_counts:header.layer_counts};
  const definition=neighborhoodFrozenSpatialDefinition(claim,id,options.geometryInput,options.discovery);
  const stock={status:'complete',definition,definition_sha256:assessmentEvidenceDigest(definition),source_original_sha256:assessmentEvidenceDigest(original),
    subject_intent_sha256:options.subjectIntent.content_sha256,subject_intent_utf8_bytes:'100',
    parcel_count:'60001',account_count:'60000',unassociated_parcel_count:'1',unlocatable_global_parcels:'1'};
  const client={async query(config,values){const text=typeof config==='string'?config:config.text;
    const parameters=typeof config==='string'?values:config.values;calls.push({text,values:parameters,query_timeout:config.query_timeout});
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

async function sharedCadFixture(hook=()=>{}){
  const profile=getNeighborhoodFrozenTypedCadImprovementV1Profile(),original=getNeighborhoodFrozenCadImprovementProfile();let source,header;
  const primaryText=JSON.stringify({account_id:'STOCK-A',year_built:'2050',living_area_sqft:'9007199254740993',bedroom_count:'3',bath_count:'2.00',number_units:'1',pool:null});
  const typed=compileNeighborhoodFrozenTypedCadImprovementV1({kind:'primary',row_key:'STOCK-A',payload_text:primaryText});
  const originalTexts=new Map([[typed.original.payload_sha256,primaryText]]);
  const rows=[{kind:'primary',account_id:typed.account_id,row_key:typed.original.row_key,original_payload_sha256:typed.original.payload_sha256,typed}];
  const f=fixture(async call=>{const supplied=await hook({...call,source,header,rows,originalTexts});if(supplied)return supplied;
    if(call.text===NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.source)return result(structuredClone(source));
    if(call.text===NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.read)return result(structuredClone(header));
    if(call.text===NEIGHBORHOOD_ORIGINAL_CAD_ACCOUNT_PACKAGE_V2_SQL){
      const account_id=['STOCK-A','STOCK-B'].find(a=>a>call.values[3])??null;
      const originals=rows.filter(r=>r.account_id===account_id).map(r=>({...r,original_text:originalTexts.get(r.original_payload_sha256),
        payload_sha256:r.original_payload_sha256,payload_utf8_bytes:String(r.typed.original.payload_utf8_bytes),cached_account_id:r.account_id}));
      return result({account_id,geographic_parcel_count:account_id===null?null:'1',counts:Object.fromEntries(['primary','secondary'].map(k=>[k,String(originals.filter(r=>r.kind===k).length)])),
        row_count:originals.length,invalid_count:0,packet_oversize:false,packet_json:JSON.stringify(originals)});
    }
    if(call.text===NEIGHBORHOOD_SHARED_JOB_CAD_PAGE_SQL){const selected=rows.filter(r=>r.kind===call.values[3]&&(r.account_id>call.values[4]||r.account_id===call.values[4]&&r.row_key>call.values[5])).slice(0,call.values[6]);
      return result({page_json:JSON.stringify(selected),page_count:selected.length,candidate_count:selected.length,oversized_count:0,next_account:selected.at(-1)?.account_id??null,next_key:selected.at(-1)?.row_key??null});}
    if(call.text===NEIGHBORHOOD_SHARED_JOB_CAD_ACCOUNT_PAGE_SQL){
      const selected=['STOCK-A','STOCK-B'].filter(a=>a>call.values[3]).slice(0,call.values[4]).map(a=>({account_id:a,
        geographic_parcel_count:'1',primary:rows.find(r=>r.kind==='primary'&&r.account_id===a)??null,secondary_original_count:a==='STOCK-A'?'2':'0'}));
      return result({page_json:JSON.stringify(selected),page_count:selected.length,candidate_count:selected.length,oversized_count:0,next_account:selected.at(-1)?.account_id??null});}
  },true);
  const stock=await f.store.read();source={generation_id:id,format_version:1,status:'complete',source_snapshot:stock.original.source_snapshot,
    started_at:stock.original.source_transaction_started_at,completed_at:date,source_profile_sha256:original.profile_ref.content_sha256,
    source_definition_json:original.definition_blob.canonical_json,layer_counts:{primary:{row_count:'3',payload_utf8_bytes:'300'},secondary:{row_count:'4',payload_utf8_bytes:'400'}},
    row_count:'7',payload_utf8_bytes:'700'};
  const binding=assessmentEvidenceDigest({source,profile});header={binding_sha256:binding,source_metadata:source,definition_json:profile.definition_blob.canonical_json,
    progress:{format:'shared_frozen_typed_CAD_progress_v1',binding_sha256:binding,kind_index:2,after:'',layer_rows:0,typed_rows:'7',typed_utf8_bytes:'20000'},status:'complete',completed_at:date};
  const graph={root:{content_sha256:'c'.repeat(64),canonical_utf8_bytes:'100'},layer_counts:{parcels:60001,accounts:0,source_records:0,sales:0,sale_links:0,sync_state:0,sync_runs:0}};
  return {...f,source,header,rows,originalTexts,graph,cad:()=>createNeighborhoodSharedJobCadImprovementPages(f.client,options,graph)};
}
const firstCadPage={kind:'primary',cursor:{account_id:'',row_key:''},rowLimit:250};

test('original CAD account reader uses complete original replay, retains absent accounts, and requires a fresh terminal probe',async()=>{
  const f=await sharedCadFixture(),reader=()=>createNeighborhoodSharedJobCadAccountPages(f.client,options,f.graph,'2026-10-07'),from=f.calls.length;
  const a=await reader().originalAccountPackage({cursor:''});assert.equal(a.rows[0].account_id,'STOCK-A');assert.equal(a.end_of_accounts,false);
  assert.equal(a.rows[0].observations.reported_living_area.exact_value,'9007199254740993');
  assert.equal(a.rows[0].observations.reported_year_built.state,'invalid');
  assert.equal(a.original_reconciliation,'every_original_and_entire_cache_before_projection');
  assert.equal(a.source_acquisition,'not_established');assert.equal(a.report_update,'none');
  const b=await reader().originalAccountPackage({cursor:a.next_cursor});assert.equal(b.end_of_accounts,false);
  assert.equal(b.rows[0].primary_original_count,'0');assert.equal(b.rows[0].observations.reported_pool_flag.reason,'primary_original_absent');
  const end=await reader().originalAccountPackage({cursor:b.next_cursor});assert.equal(end.end_of_accounts,true);assert.deepEqual(end.rows,[]);
  assert.ok(f.calls.slice(from).filter(c=>c.text===NEIGHBORHOOD_ORIGINAL_CAD_ACCOUNT_PACKAGE_V2_SQL).every(c=>c.query_timeout===5000&&c.values[4]===250));
  assert.ok(!f.calls.slice(from).some(c=>/INSERT|UPDATE|DELETE|FROM core\.|ST_DWithin/.test(c.text)));
  assert.doesNotMatch(JSON.stringify(a.rows),/original_text|cached_account_id/);
});

test('original CAD amenity evidence resolves only after complete replay and includes missing-primary accounts and fresh empty probe',async()=>{
  const f=await sharedCadFixture(),reader=()=>createNeighborhoodSharedJobCadAccountPages(f.client,options,f.graph,'2026-10-07');
  const a=await reader().originalAmenityEvidence({cursor:''});
  assert.equal(a.status,'original_reconciled_CAD_amenity_evidence');assert.equal(a.amenity_evidence.reported_pool.state,'missing');
  assert.equal(a.amenity_evidence.reported_pool.reason,'raw_value_missing');
  assert.equal(a.amenity_evidence.reported_pool.source_original.row_key,'STOCK-A');
  assert.equal(a.amenity_evidence.garage_area.state,'unsupported');
  assert.equal(a.amenity_evidence.provider_fidelity,'not_established');
  const b=await reader().originalAmenityEvidence({cursor:a.next_cursor});
  assert.equal(b.amenity_evidence.reported_pool.source_original,null);
  assert.equal(b.amenity_evidence.reported_pool.reason,'primary_original_absent');
  const end=await reader().originalAmenityEvidence({cursor:b.next_cursor});
  assert.equal(end.end_of_accounts,true);assert.equal(end.amenity_evidence,null);
  assert.ok(Buffer.byteLength(JSON.stringify(a))<=2100000);
  assert.doesNotMatch(JSON.stringify(a.amenity_evidence),/original_text|cached_account_id/);
});

test('original CAD/amenity and old typed methods share single-use lifetime budgets and both ending source/cache/claim checks',async()=>{
  for(const first of ['page','originalAccountPackage','originalAmenityEvidence']){
    const f=await sharedCadFixture(),reader=createNeighborhoodSharedJobCadAccountPages(f.client,options,f.graph,'2026-10-07');
    await reader[first](first==='page'?{cursor:'',rowLimit:250}:{cursor:''});
    for(const second of ['page','originalAccountPackage','originalAmenityEvidence'])await assert.rejects(reader[second](second==='page'?{cursor:'',rowLimit:250}:{cursor:''}),/single_use/);
  }
  for(const method of ['originalAccountPackage','originalAmenityEvidence']){
  let reads=0;const changed=await sharedCadFixture(({text,header})=>text===NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.read&&++reads===2?result({...header,status:'building'}):null);
  await assert.rejects(createNeighborhoodSharedJobCadAccountPages(changed.client,options,changed.graph,'2026-10-07')[method]({cursor:''}),/cache_unavailable/);
  const cancelled=await sharedCadFixture(),from=cancelled.calls.length;
  await assert.rejects(createNeighborhoodSharedJobCadAccountPages(cancelled.client,{...options,checkBudget(){throw Error('cancelled');}},cancelled.graph,'2026-10-07')[method]({cursor:''}),/cancelled/);
  assert.equal(cancelled.calls.length,from);
  assert.equal(createNeighborhoodSharedJobCadImprovementPages(cancelled.client,options,cancelled.graph).originalAccountPackage,undefined);
  assert.equal(createNeighborhoodSharedJobCadImprovementPages(cancelled.client,options,cancelled.graph).originalAmenityEvidence,undefined);
  }
});

test('original CAD owner DATA cannot launder changed cells or payload with unchanged hashes/counts',async()=>{
  for(const method of ['originalAccountPackage','originalAmenityEvidence']){
  for(const mutate of [rows=>rows[0].typed.observations.reported_baths.exact_value='3',
    (rows,texts)=>texts.set(rows[0].original_payload_sha256,texts.get(rows[0].original_payload_sha256).replace('2050','2040'))]){
    const f=await sharedCadFixture();f.rows[0]=structuredClone(f.rows[0]);mutate(f.rows,f.originalTexts);
    await assert.rejects(createNeighborhoodSharedJobCadAccountPages(f.client,options,f.graph,'2026-10-07')[method]({cursor:''}),/original_mismatch/);
  }
  }
});

test('current CAD account projection retains absent-primary denominators, exact values, secondary identities and effective-year policy',async()=>{
  const f=await sharedCadFixture(),start=f.calls.length;
  const reader=date=>createNeighborhoodSharedJobCadAccountPages(f.client,options,f.graph,date);
  const page=await reader('2026-10-07').page({cursor:'',rowLimit:250});
  assert.equal(page.coverage,'one_account_page_only');assert.equal(page.rows.length,2);assert.equal(page.end_of_accounts,true);
  const [a,b]=page.rows;assert.equal(a.observations.reported_year_built.state,'invalid');
  assert.equal(a.observations.reported_year_built.reason,'year_after_retained_effective_year');
  assert.equal(a.observations.reported_living_area.exact_value,'9007199254740993');
  assert.equal(a.observations.reported_baths.exact_value,'2');assert.equal(a.secondary_original_count,'2');
  assert.equal(a.secondary_type_resolution,'not_established');assert.equal(a.housing_eligibility,'not_established');
  assert.equal(a.observations.reported_pool_flag.state,'missing');assert.equal(a.primary_original_count,'1');
  assert.equal(b.primary_original_count,'0');assert.equal(b.primary_original,null);assert.equal(b.secondary_original_count,'0');
  for(const cell of Object.values(b.observations)){assert.equal(cell.state,'missing');assert.equal(cell.exact_value,null);assert.equal(cell.reason,'primary_original_absent');}
  assert.equal((await reader('2050-01-01').page({cursor:'',rowLimit:250})).rows[0].observations.reported_year_built.exact_value,'2050');
  const full=await reader('2026-10-07').page({cursor:'STOCK-A',rowLimit:1});assert.equal(full.end_of_accounts,false);
  const end=await reader('2026-10-07').page({cursor:full.next_cursor,rowLimit:1});assert.equal(end.end_of_accounts,true);assert.equal(end.rows.length,0);
  assert.ok(f.calls.slice(start).filter(c=>c.text===NEIGHBORHOOD_SHARED_JOB_CAD_ACCOUNT_PAGE_SQL).every(c=>c.query_timeout===5000));
  assert.ok(!f.calls.slice(start).some(c=>/INSERT|UPDATE|DELETE|ST_DWithin|FROM core\.|FROM gis\./.test(c.text)));
  assert.equal(page.report_update,'none');assert.equal(page.source_acquisition,'not_established');
  assert.ok(Object.isFrozen(getNeighborhoodSharedJobCadAccountProfile().definition_blob));
});

test('current CAD account projection preserves native false, invalid literals and NULL without bathroom/type inference',async()=>{
  for(const pool of [null,false,true,'false','']){
    const f=await sharedCadFixture(),typed=compileNeighborhoodFrozenTypedCadImprovementV1({kind:'primary',row_key:'STOCK-A',
      payload_text:JSON.stringify({account_id:'STOCK-A',year_built:'1999',living_area_sqft:'1000.001',bedroom_count:'3',bath_count:'2.5',number_units:'1',pool})});
    f.rows[0]={kind:'primary',account_id:'STOCK-A',row_key:'STOCK-A',original_payload_sha256:typed.original.payload_sha256,typed};
    const page=await createNeighborhoodSharedJobCadAccountPages(f.client,options,f.graph,'2026-10-07').page({cursor:'',rowLimit:250});
    const cells=page.rows[0].observations;assert.equal(cells.reported_baths.exact_value,'2.5');assert.equal(cells.reported_baths.unit,'CAD_reported_baths');
    assert.deepEqual(cells.reported_pool_flag,(({state,exact_value,unit,reason})=>({state,exact_value,unit,reason}))(typed.observations.reported_pool_flag));
    assert.equal(page.rows[0].temporal_basis,'current_retained_CAD_not_historical_or_at_sale');
  }
});

test('current CAD account projection refuses hostile inputs, incorrect identities/counts/cursors and ending cache changes',async()=>{
  const good={cursor:'',rowLimit:250};let invoked=false;
  for(const bad of [new Proxy(good,{}),{...good,kind:'primary'},{...good,effective_date:'2000-01-01'},
    {...good,account_ids:['foreign']},{...good,rowLimit:251},{...good,cursor:{toString(){invoked=true;return '';}}},
    {...good,get cursor(){invoked=true;return '';}}])assert.throws(()=>prepareNeighborhoodSharedJobCadAccountPage(bad),/invalid_/);
  assert.equal(invoked,false);
  for(const patch of [{secondary_original_count:'5'},{geographic_parcel_count:'0'},{account_id:'foreign'},{extra:true}]){
    const f=await sharedCadFixture(({text,rows})=>text===NEIGHBORHOOD_SHARED_JOB_CAD_ACCOUNT_PAGE_SQL?result({page_json:JSON.stringify([
      {account_id:'STOCK-A',geographic_parcel_count:'1',primary:rows[0],secondary_original_count:'2',...patch}]),
      page_count:1,candidate_count:1,oversized_count:0,next_account:patch.account_id??'STOCK-A'}):null);
    await assert.rejects(createNeighborhoodSharedJobCadAccountPages(f.client,options,f.graph,'2026-10-07').page(good),/invalid_/);
  }
  const f=await sharedCadFixture(),reader=createNeighborhoodSharedJobCadAccountPages(f.client,options,f.graph,'2026-10-07');
  await reader.page(good);await assert.rejects(reader.page(good),/single_use/);
  assert.throws(()=>createNeighborhoodSharedJobCadAccountPages(f.client,options,f.graph,'2026-02-30'),/date/);
  let read=0;const changed=await sharedCadFixture(({text,header})=>text===NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.read&&++read===2
    ?result({...header,status:'building'}):null);
  await assert.rejects(createNeighborhoodSharedJobCadAccountPages(changed.client,options,changed.graph,'2026-10-07').page(good),/cache_unavailable/);
  assert.match(NEIGHBORHOOD_SHARED_JOB_CAD_ACCOUNT_PAGE_SQL,/LEFT JOIN app.neighborhood_frozen_typed_cad_rows/);
  assert.doesNotMatch(NEIGHBORHOOD_SHARED_JOB_CAD_ACCOUNT_PAGE_SQL,/jsonb_agg|ST_DWithin|FROM core\.|FROM gis\.|INSERT|UPDATE|DELETE/);
});
test('shared CAD pages retain exact neutral cells, a full-tail empty probe and missing-not-no-amenity without writes',async()=>{
  const f=await sharedCadFixture(),start=f.calls.length,reader=f.cad(),page=await reader.page({...firstCadPage,rowLimit:1});
  assert.equal(page.end_of_kind,false);assert.equal(page.coverage,'one_kind_page_only');assert.equal(page.authority,'not_established');
  assert.equal(page.rows[0].typed.observations.reported_living_area.exact_value,'9007199254740993');
  assert.equal(page.rows[0].typed.observations.reported_year_built.exact_value,'2050','syntax reader does not borrow a report date');
  assert.equal(page.rows[0].typed.observations.reported_pool_flag.state,'missing');assert.equal(page.absent_rows,'not_zero_or_no_amenity');
  assert.equal(page.source_acquisition,'not_established');await assert.rejects(reader.page(firstCadPage),/single_use/);
  const end=await f.cad().page({...firstCadPage,cursor:page.next_cursor,rowLimit:1});assert.equal(end.end_of_kind,true);assert.equal(end.rows.length,0);
  assert.ok(!f.calls.slice(start).some(c=>/INSERT|UPDATE|DELETE|ST_DWithin|FROM core\.|:page \*\/ WITH candidates/.test(c.text)&&c.text!==NEIGHBORHOOD_SHARED_JOB_CAD_PAGE_SQL));
  assert.ok(f.calls.slice(start).filter(c=>c.text===NEIGHBORHOOD_SHARED_JOB_CAD_PAGE_SQL).every(c=>c.values[3]==='primary'));
});
test('CAD page admission is closed and both metadata ends require exact source/profile/complete cache',async()=>{
  for(const bad of [{...firstCadPage,effectiveDate:'2000-01-01'},{...firstCadPage,kind:'parcels'},
    {...firstCadPage,cursor:{account_id:'STOCK-A',row_key:''}},{...firstCadPage,rowLimit:251},new Proxy(firstCadPage,{})])
    assert.throws(()=>prepareNeighborhoodSharedJobCadPage(bad),/invalid_/);
  for(const mutate of [h=>{h.status='building';},h=>{h.progress.kind_index=1;},h=>{h.progress.typed_rows='6';},h=>{h.definition_json='wrong';},h=>{h.binding_sha256='d'.repeat(64);}] ){
    const f=await sharedCadFixture(({text,header})=>{if(text===NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.read){const h=structuredClone(header);mutate(h);return result(h);}});
    await assert.rejects(f.cad().page(firstCadPage),/cache_unavailable/);assert.ok(!f.calls.some(c=>c.text===NEIGHBORHOOD_SHARED_JOB_CAD_PAGE_SQL));
  }
  let read=0;const f=await sharedCadFixture(({text,header})=>text===NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.read&&++read===2?result({...header,completed_at:'2026-10-08T00:00:00.000000Z'}):null);
  await assert.rejects(f.cad().page(firstCadPage),/source_changed/);
});
test('CAD DATA decoder refuses malformed flags/numerics/profile/hash/account/cells and lost claims instead of dropping rows',async()=>{
  for(const mutate of [r=>{r.typed.observations.reported_baths.exact_value=2;},r=>{r.typed.observations.reported_pool_flag.exact_value=false;},
    r=>{r.typed.original.payload_sha256='d'.repeat(64);},r=>{r.typed.account_id='foreign';},r=>{r.typed.interpretation_profile_ref.content_sha256='d'.repeat(64);},
    r=>{r.typed.observations.reported_units.exact_value='1.1';},r=>{r.typed.observations.reported_year_built.exact_value='1000';},r=>{r.typed.observations.reported_baths.exact_value='3';},
    r=>{r.typed.observations.reported_bedrooms.raw.value_sha256='d'.repeat(64);},r=>{r.typed.observations.extra={};}] ){
    const f=await sharedCadFixture(({text,rows})=>{if(text===NEIGHBORHOOD_SHARED_JOB_CAD_PAGE_SQL){const row=structuredClone(rows[0]);mutate(row);
      return result({page_json:JSON.stringify([row]),page_count:1,candidate_count:1,oversized_count:0,next_account:'STOCK-A',next_key:'STOCK-A'});}});
    await assert.rejects(f.cad().page(firstCadPage),/invalid_typed_row|invalid_data/);
  }
  const f=await sharedCadFixture(),reader=createNeighborhoodSharedJobCadImprovementPages(f.client,{...options,checkBudget(){throw Error('cancelled');}},f.graph),start=f.calls.length;
  await assert.rejects(reader.page(firstCadPage),/cancelled/);assert.equal(f.calls.length,start);
  let reading=false;const lost=await sharedCadFixture(({text})=>reading&&text.includes('generation-fence')?{rowCount:0,rows:[]}:null);reading=true;
  await assert.rejects(lost.cad().page(firstCadPage),/claim_lost/);
});
test('CAD fixed page SQL uses exact pinned stock and kind/account/key cache index, never dense geometry/current-core fallback',()=>{
  const sql=NEIGHBORHOOD_SHARED_JOB_CAD_PAGE_SQL;assert.match(sql,/stock.operation_id=\$1::uuid/);assert.match(sql,/typed.generation_id=\$2::uuid/);
  assert.match(sql,/typed.profile_sha256=\$3 AND typed.kind=\$4/);assert.match(sql,/LIMIT \$7::integer/);assert.match(sql,/COLLATE "C"/);
  assert.doesNotMatch(sql,/ST_DWithin|FROM core\.|FROM gis\.|INSERT|UPDATE|DELETE|payload::text/);
});
test('CAD page result bounds, cursor order and ending source changes refuse without a missing-row success',async()=>{
  for(const patch of [{page_count:2},{candidate_count:251},{oversized_count:1},{next_key:'foreign'},
    {page_json:'[]',page_count:0,candidate_count:1},{page_json:'['},{page_json:' '.repeat(2100001)}]){
    const f=await sharedCadFixture(({text,rows})=>text===NEIGHBORHOOD_SHARED_JOB_CAD_PAGE_SQL
      ?result({page_json:JSON.stringify(rows),page_count:1,candidate_count:1,oversized_count:0,next_account:'STOCK-A',next_key:'STOCK-A',...patch}):null);
    await assert.rejects(f.cad().page(firstCadPage),/invalid_result|byte_limit/);
  }
  const duplicate=await sharedCadFixture(({text,rows})=>text===NEIGHBORHOOD_SHARED_JOB_CAD_PAGE_SQL
    ?result({page_json:JSON.stringify([rows[0],rows[0]]),page_count:2,candidate_count:2,oversized_count:0,next_account:'STOCK-A',next_key:'STOCK-A'}):null);
  await assert.rejects(duplicate.cad().page(firstCadPage),/invalid_order/);
  let reads=0;const changed=await sharedCadFixture(({text,source})=>text===NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.source&&++reads===2
    ?result({...source,source_snapshot:'1:9:'}):null);
  await assert.rejects(changed.cad().page(firstCadPage),/source_changed/);
  const f=await sharedCadFixture(),start=f.calls.length;await f.cad().page(firstCadPage);
  assert.ok(f.calls.slice(start).every(c=>c.query_timeout===5000));assert.ok(f.calls.length-start<=48);
});
test('CAD decoder mirrors the installed profile for blank booleans and malformed/unsupported retained literals',async()=>{
  for(const pool of ['',false,true,null,{},'x'.repeat(129)]){
    const f=await sharedCadFixture(),typed=compileNeighborhoodFrozenTypedCadImprovementV1({kind:'primary',row_key:'STOCK-A',
      payload_text:JSON.stringify({account_id:'STOCK-A',year_built:'2050',living_area_sqft:'3',bedroom_count:'',bath_count:'-1',number_units:'1.1',pool})});
    f.rows[0]={kind:'primary',account_id:'STOCK-A',row_key:'STOCK-A',original_payload_sha256:typed.original.payload_sha256,typed};
    assert.deepEqual((await f.cad().page(firstCadPage)).rows[0].typed,typed);
    if(pool==='')assert.equal(typed.observations.reported_pool_flag.state,'invalid','blank text is not missing native boolean');
  }
  for(const mutate of [r=>{r.typed.observations.reported_baths.raw.state='non_scalar';},
    r=>{r.typed.observations.reported_pool_flag.raw.state='scalar';},r=>{r.typed.observations.reported_baths.raw.utf8_bytes=129;}]){
    const f=await sharedCadFixture(({text,rows})=>{if(text!==NEIGHBORHOOD_SHARED_JOB_CAD_PAGE_SQL)return null;
      const row=structuredClone(rows[0]);mutate(row);return result({page_json:JSON.stringify([row]),page_count:1,candidate_count:1,oversized_count:0,next_account:'STOCK-A',next_key:'STOCK-A'});});
    await assert.rejects(f.cad().page(firstCadPage),/invalid_typed_row/);
  }
});
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

/** Compile synthetic ORIGINAL payloads with the actual fixed neutral compiler. */
function stockOriginalCell(kind='parcels',key='1',changes={}){
  const original_text=JSON.stringify({...(kind==='parcels'?{object_id:key,account_id:'STOCK-A',residential_year_built:2050,
    residential_area_sqft:'9007199254740993.01',parcel_area_sqft:'0',current_market_value:null,subdivision_name:'Literal only'}
    :{account_id:key,county:'Dallas',subdivision:'Literal only'}),...changes});
  const typed=compileNeighborhoodFrozenTypedOriginalV2({kind,row_key:key,payload_text:original_text});
  return {kind,row_key:key,account_id:typed.account_id,source_record_id:null,original_text,
    cached_account_id:typed.account_id,cached_source_record_id:null,original_payload_sha256:typed.original.payload_sha256,typed};
}
/** DATA-only SQL double. It issues no graph, stock, rights or selected-union receipt. */
async function stockOriginalCellFixture(hook=()=>{}){
  let source,sharedHeader;const rows={parcels:[stockOriginalCell(),stockOriginalCell('parcels','2',{residential_year_built:1960})],
    accounts:[stockOriginalCell('accounts','STOCK-A')]};
  const f=fixture(async call=>{
    const supplied=await hook({...call,source,sharedHeader,rows});if(supplied)return supplied;
    if(call.text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.source)return result(source);
    if(call.text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read)return result(structuredClone(sharedHeader));
    if([NEIGHBORHOOD_STOCK_SUBJECT_AND_NEXT_PACKAGE_V2_SQL,NEIGHBORHOOD_STOCK_SUBJECT_AND_FIRST_SELECTED_PACKAGE_V2_SQL].includes(call.text)){
      const originals=Object.values(rows).flat(),ids=[...new Set(originals.map(r=>r.account_id))].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))),
        next=call.text===NEIGHBORHOOD_STOCK_SUBJECT_AND_FIRST_SELECTED_PACKAGE_V2_SQL?ids.at(-1)??null
          :ids.find(id=>Buffer.compare(Buffer.from(id),Buffer.from(call.values[3]))>0)??null,
        subject=call.values[9]&&ids.includes(options.scope.account_id)?options.scope.account_id:null,
        packet=originals.filter(r=>r.account_id===next||r.account_id===subject).sort((a,b)=>
          Buffer.compare(Buffer.from(`${a.account_id}\u0000${a.kind}\u0000${a.row_key}`),Buffer.from(`${b.account_id}\u0000${b.kind}\u0000${b.row_key}`))),
        n=(id,kind)=>id===null?0:packet.filter(r=>r.account_id===id&&r.kind===kind).length;
      return result({account_id:next,geographic_parcel_count:next?'1':null,subject_account_id:subject,subject_geographic_parcel_count:subject?'1':null,
        next_parcels:n(next,'parcels'),next_accounts:n(next,'accounts'),subject_parcels:n(subject,'parcels'),subject_accounts:n(subject,'accounts'),
        original_count:packet.length,page_count:packet.length,invalid_count:0,packet_oversize:false,page_json:JSON.stringify(packet)});
    }
    if([NEIGHBORHOOD_STOCK_ACCOUNT_PACKAGE_V2_SQL,NEIGHBORHOOD_STOCK_SUBJECT_HOUSING_PACKAGE_V2_SQL].includes(call.text)){
      const chosen=call.text===NEIGHBORHOOD_STOCK_SUBJECT_HOUSING_PACKAGE_V2_SQL
        ?call.values[3]==='STOCK-A'?'STOCK-A':null:Buffer.compare(Buffer.from('STOCK-A'),Buffer.from(call.values[3]))>0?'STOCK-A':null;
      const packet=chosen?Object.values(rows).flat().filter(r=>r.account_id===chosen).sort((a,b)=>
        Buffer.compare(Buffer.from(`${a.kind}\u0000${a.row_key}`),Buffer.from(`${b.kind}\u0000${b.row_key}`))):[];
      return result({account_id:chosen,geographic_parcel_count:chosen?'1':null,
        original_counts:{parcels:packet.filter(r=>r.kind==='parcels').length,accounts:packet.filter(r=>r.kind==='accounts').length},
        page_count:packet.length,invalid_count:0,packet_oversize:false,page_json:JSON.stringify(packet)});
    }
    if(call.text===NEIGHBORHOOD_STOCK_ORIGINAL_CELLS_V2_PAGE_SQL){
      const candidates=rows[call.values[3]].filter(r=>Buffer.compare(Buffer.from(r.row_key),Buffer.from(call.values[4]))>0).slice(0,call.values[5]);
      return result({page_json:JSON.stringify(candidates),page_count:candidates.length,candidate_count:candidates.length,
        scan_count:candidates.length,scan_cursor:candidates.at(-1)?.row_key??null,
        invalid_count:0,oversized_count:0,next_cursor:candidates.at(-1)?.row_key??null});
    }
  },true,{accounts:1});
  const stock=await f.store.read(),o=stock.original,profile=getNeighborhoodFrozenTypedOriginalV2Profile();
  source={generation_id:o.generation_id,format_version:o.source_format_version,status:'complete',source_snapshot:o.source_snapshot,
    started_at:o.source_transaction_started_at,completed_at:o.completed_at,layer_counts:o.layer_counts,row_count:o.row_count,payload_utf8_bytes:o.payload_utf8_bytes};
  const binding=assessmentEvidenceDigest({source,profile});
  sharedHeader={binding_sha256:binding,source_metadata:source,definition_json:profile.definition_blob.canonical_json,
    progress:{format:'shared_frozen_typed_progress_v2',binding_sha256:binding,kind_index:7,after:'',layer_rows:0,
      typed_rows:source.row_count,typed_utf8_bytes:'12000400'},status:'complete',completed_at:date};
  const graph={root:{content_sha256:'c'.repeat(64),canonical_utf8_bytes:'100'},layer_counts:{parcels:60001,accounts:1,
    source_records:0,sales:0,sale_links:0,sync_state:0,sync_runs:0}};
  return {...f,source,sharedHeader,rows,graph,pages:(effective='2026-10-07')=>
    createNeighborhoodSharedStockOriginalCellsV2(f.client,options,graph,effective)};
}

test('stock original cells replay complete originals before retained-year projection without rounding, fallback or raw delivery',async()=>{
  const f=await stockOriginalCellFixture(),from=f.calls.length;
  const p=await f.pages().page({kind:'parcels',cursor:'',rowLimit:250});
  assert.equal(p.status,'reconciled_stock_original_cells_page');assert.equal(p.coverage,'one_kind_page_only');
  assert.equal(p.original_reconciliation,'every_delivered_original_recompiled');assert.equal(p.selected_union,'not_established');
  assert.equal(p.source_acquisition,'not_established');assert.equal(p.report_update,'none');
  assert.deepEqual(p.page_profile,getNeighborhoodStockOriginalCellsV2Profile());
  assert.equal(p.rows[0].typed.observations.reported_year_built.exact_value,'2050');
  assert.deepEqual({...p.rows[0].retained_observations.reported_year_built,raw:null},
    {state:'invalid',exact_value:null,unit:null,reason:'year_after_retained_effective_year',raw:null});
  assert.equal(p.rows[0].retained_observations.reported_residential_area.exact_value,'9007199254740993.01');
  assert.equal(p.rows[0].retained_observations.reported_site_area.exact_value,'0');
  assert.equal(p.rows[0].retained_observations.reported_market_value.state,'missing');
  assert.equal(p.rows[1].retained_observations.reported_year_built.exact_value,'1960');
  assert.ok(p.rows.every(r=>!Object.hasOwn(r,'original_text')&&!Object.hasOwn(r,'payload_text')&&Object.isFrozen(r.typed)));
  const later=await f.pages('2050-01-01').page({kind:'parcels',cursor:'',rowLimit:250});
  assert.equal(later.rows[0].retained_observations.reported_year_built.exact_value,'2050');
  assert.deepEqual(later.typed_profile,p.typed_profile);assert.deepEqual(later.rows[0].typed,p.rows[0].typed);
  const account=await f.pages().page({kind:'accounts',cursor:'',rowLimit:250});
  assert.deepEqual(account.rows[0].retained_observations,{});assert.equal(account.rows[0].typed.markers.county.value_text,'Dallas');
  assert.ok(f.calls.slice(from).every(c=>c.query_timeout===5000));
  assert.ok(!f.calls.slice(from).some(c=>/INSERT|UPDATE|DELETE|ST_DWithin|FROM core\.|shared-typed-v2:(?:begin|rows|page)/.test(c.text)));
});

test('stock original reconciliation cannot be replaced by a matching hash, count or plausible cached observation',async()=>{
  for(const mutate of [r=>r.typed.observations.reported_residential_area.exact_value='1',
    r=>r.typed.markers.subdivision_name.value_text='Changed',r=>r.typed.original.payload_utf8_bytes++,
    r=>r.original_text=r.original_text.replace('2050','2040'),r=>r.original_payload_sha256='e'.repeat(64),
    r=>r.cached_account_id='OUTSIDE',r=>r.account_id='OUTSIDE',r=>r.typed=null,r=>r.cached_source_record_id='1',
    r=>r.typed.effective_date='2020-01-01']){
    const f=await stockOriginalCellFixture();f.rows.parcels[0]=structuredClone(f.rows.parcels[0]);mutate(f.rows.parcels[0]);
    await assert.rejects(f.pages().page({kind:'parcels',cursor:'',rowLimit:250}),/original_mismatch/);
  }
  const sql=NEIGHBORHOOD_STOCK_ORIGINAL_CELLS_V2_PAGE_SQL;
  assert.match(sql,/WITH scan_keys AS MATERIALIZED[\s\S]+ORDER BY o\.row_key LIMIT \$6::integer\s+\), candidates AS MATERIALIZED/);
  assert.match(sql,/CROSS JOIN LATERAL \(SELECT o[\s\S]+FROM app\.neighborhood_frozen_source_rows o[\s\S]+LEFT JOIN LATERAL/);
  assert.match(sql,/FROM app\.neighborhood_frozen_typed_v2_rows t[\s\S]+t\.row_key=k\.row_key OFFSET 0/);
  assert.match(sql,/a\.operation_id=\$1::uuid AND a\.account_id=k\.account_id/);
  assert.match(sql,/t\.row_key IS NULL/);assert.match(sql,/output_cumulative\+1<=\$10::integer/);
  assert.doesNotMatch(sql,/ST_DWithin|array_agg|FROM core\.|effective_date|INSERT|UPDATE|DELETE/);
});

test('stock original page keysets retain partial/full/empty semantics and single-use aggregate fences',async()=>{
  const f=await stockOriginalCellFixture(),reader=f.pages(),from=f.calls.length;
  const a=await reader.page({kind:'parcels',cursor:'',rowLimit:2});assert.equal(a.end_of_kind,false);assert.equal(a.next_cursor,'2');
  await assert.rejects(reader.page({kind:'parcels',cursor:'',rowLimit:1}),/single_use/);
  const end=await f.pages().page({kind:'parcels',cursor:'2',rowLimit:2});assert.deepEqual(end.rows,[]);
  assert.equal(end.end_of_kind,true);assert.equal(end.next_cursor,'2');assert.ok(f.calls.length-from<=128*2);
  const partial=await stockOriginalCellFixture(({text,rows})=>text===NEIGHBORHOOD_STOCK_ORIGINAL_CELLS_V2_PAGE_SQL?
    result({page_json:JSON.stringify(rows.parcels.slice(0,1)),page_count:1,candidate_count:2,scan_count:2,scan_cursor:'2',invalid_count:0,oversized_count:0,next_cursor:'1'}):null);
  assert.equal((await partial.pages().page({kind:'parcels',cursor:'',rowLimit:250})).end_of_kind,false);
  const sparse=await stockOriginalCellFixture(({text})=>text===NEIGHBORHOOD_STOCK_ORIGINAL_CELLS_V2_PAGE_SQL?
    result({page_json:'[]',page_count:0,candidate_count:0,scan_count:2,scan_cursor:'4',invalid_count:0,oversized_count:0,next_cursor:'4'}):null);
  const scanned=await sparse.pages().page({kind:'parcels',cursor:'2',rowLimit:2});
  assert.deepEqual(scanned.rows,[]);assert.equal(scanned.end_of_kind,false);assert.equal(scanned.next_cursor,'4');
  assert.equal(scanned.scanned_original_count,2);assert.equal(scanned.scoped_candidate_count,0);
  for(const change of [{invalid_count:1},{oversized_count:1},{candidate_count:251},{page_count:0,candidate_count:1},
    {scan_count:251},{scan_count:0},{scan_cursor:'0'},
    {next_cursor:'2'},{page_json:'not JSON'}]){
    const bad=await stockOriginalCellFixture(({text,rows})=>text===NEIGHBORHOOD_STOCK_ORIGINAL_CELLS_V2_PAGE_SQL?
      result({page_json:JSON.stringify(rows.parcels.slice(0,1)),page_count:1,candidate_count:1,scan_count:1,scan_cursor:'1',invalid_count:0,oversized_count:0,next_cursor:'1',...change}):null);
    await assert.rejects(bad.pages().page({kind:'parcels',cursor:'',rowLimit:250}),/invalid_result/);
  }
  const cancelled=createNeighborhoodSharedStockOriginalCellsV2(f.client,{...options,checkBudget(){throw Error('synthetic cancelled');}},f.graph,'2026-10-07');
  const before=f.calls.length;await assert.rejects(cancelled.page({kind:'parcels',cursor:'',rowLimit:1}),/synthetic cancelled/);assert.equal(f.calls.length,before);
});

test('stock originals refuse unavailable or changed headers and every caller fact/profile/callback extension',async()=>{
  assert.equal(prepareNeighborhoodStockOriginalCellPageV2({kind:'accounts',cursor:'é'.repeat(64),rowLimit:1}).cursor,'é'.repeat(64),
    'preserve the existing native 64-character account identity contract, not a narrower ASCII byte limit');
  for(const mutate of [h=>h.status='building',h=>h.progress.kind_index=6,h=>h.definition_json='{}',h=>h.binding_sha256='e'.repeat(64),
    h=>h.progress.typed_rows='1',h=>h.source_metadata.source_snapshot='2:3:']){
    const f=await stockOriginalCellFixture(({text,sharedHeader})=>{if(text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read){
      const h=structuredClone(sharedHeader);mutate(h);return result(h);}});
    await assert.rejects(f.pages().page({kind:'parcels',cursor:'',rowLimit:1}),/cache_unavailable/);
    assert.ok(!f.calls.some(c=>c.text===NEIGHBORHOOD_STOCK_ORIGINAL_CELLS_V2_PAGE_SQL));
  }
  let headers=0;const ending=await stockOriginalCellFixture(({text,sharedHeader})=>text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read&&++headers===2?
    result({...sharedHeader,status:'building'}):null);
  await assert.rejects(ending.pages().page({kind:'parcels',cursor:'',rowLimit:1}),/cache_unavailable/);
  for(const page of [undefined,{kind:'sales',cursor:'',rowLimit:1},{kind:'parcels',cursor:'-1',rowLimit:1},
    {kind:'parcels',cursor:'9223372036854775808',rowLimit:1},{kind:'accounts',cursor:' A',rowLimit:1},
    {kind:'accounts',cursor:'',rowLimit:251},{kind:'accounts',cursor:'',rowLimit:1,complete:true},
    new Proxy({kind:'accounts',cursor:'',rowLimit:1},{}),{kind:'accounts',get cursor(){assert.fail('getter');},rowLimit:1}])
    assert.throws(()=>prepareNeighborhoodStockOriginalCellPageV2(page),/invalid_/);
  for(const o of [{...options,readOriginal:()=>{}},{...options,selectedAccounts:[]},{...options,sourceGrant:{allowed:true}},new Proxy(options,{})])
    assert.throws(()=>createNeighborhoodSharedStockOriginalCellsV2(ending.client,o,ending.graph,'2026-10-07'),/invalid_input/);
});

test('subject housing packet chooses the native subject, replays every original and shares one single-use budget',async()=>{
  const f=await stockOriginalCellFixture(),from=f.calls.length;
  f.rows.parcels[0]=stockOriginalCell('parcels','1',{class_code:'A11'});
  f.rows.parcels[1]=stockOriginalCell('parcels','2',{class_code:'A12'});
  const reader=f.pages(),packet=await reader.subjectHousingAccountPackage();
  assert.equal(packet.status,'reconciled_exact_subject_original_housing');assert.equal(packet.account_id,options.scope.account_id);
  assert.deepEqual(packet.original_counts,{parcels:2,accounts:1});assert.equal(packet.recorded_housing.state,'conflicting');
  assert.equal(packet.recorded_housing.category,null);assert.equal(packet.geographic_parcel_count,'1');
  assert.equal(packet.original_reconciliation,'every_package_original_recompiled');
  const calls=f.calls.slice(from),reads=calls.filter(c=>c.text===NEIGHBORHOOD_STOCK_SUBJECT_HOUSING_PACKAGE_V2_SQL);
  assert.equal(reads.length,1);assert.equal(reads[0].values[3],options.scope.account_id);
  assert.ok(!calls.some(c=>c.text===NEIGHBORHOOD_STOCK_ACCOUNT_PACKAGE_V2_SQL));
  await assert.rejects(reader.accountPackage({cursor:''}),/single_use/);
  await assert.rejects(reader.subjectHousingAccountPackage(),/single_use/);
  assert.throws(()=>f.pages().subjectHousingAccountPackage({cursor:''}),/invalid_input/);
});
test('subject fallback refuses absent stock, wrong account, incomplete cache and whole-packet overflow, never fabricates missing housing',async()=>{
  const valid={account_id:'STOCK-A',geographic_parcel_count:'1',original_counts:{parcels:2,accounts:1},page_count:3,invalid_count:0,packet_oversize:false};
  for(const [changes,reason] of [[{account_id:null,geographic_parcel_count:null,original_counts:{parcels:0,accounts:0},page_count:0,page_json:'[]'},/subject_not_in_issued_stock/],
    [{account_id:'OTHER'},/invalid_result/],[{invalid_count:1},/invalid_result/],[{packet_oversize:true},/account_package_byte_limit/],
    [{original_counts:{parcels:251,accounts:0},page_count:0,page_json:'[]'},/account_package_row_limit/]]){
    const f=await stockOriginalCellFixture(({text,rows})=>text===NEIGHBORHOOD_STOCK_SUBJECT_HOUSING_PACKAGE_V2_SQL
      ?result({...valid,page_json:JSON.stringify([...rows.accounts,...rows.parcels]),...changes}):null);
    await assert.rejects(f.pages().subjectHousingAccountPackage(),reason);
  }
  for(const mutate of [r=>r.typed=null,r=>r.typed.observations.reported_site_area.exact_value='2',r=>r.original_text=r.original_text.replace('2050','2040')]){
    const f=await stockOriginalCellFixture();f.rows.parcels[0]=structuredClone(f.rows.parcels[0]);mutate(f.rows.parcels[0]);
    await assert.rejects(f.pages().subjectHousingAccountPackage(),/original_mismatch/);
  }
  let headers=0;const f=await stockOriginalCellFixture(({text,sharedHeader})=>text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read&&++headers===2
    ?result({...sharedHeader,status:'building'}):null);
  await assert.rejects(f.pages().subjectHousingAccountPackage(),/cache_unavailable/);
});

test('paired subject and next originals deduplicate the same account under one lifetime and aggregate packet',async()=>{
  const f=await stockOriginalCellFixture(),reader=f.pages(),from=f.calls.length,
    p=await reader.subjectAndRecordedGroupHousingAccountPackage({cursor:''},{includeSubject:true});
  assert.equal(p.account_id,'STOCK-A');assert.equal(p.subject_equals_next,true);assert.equal(p.subject,null);
  assert.equal(p.distinct_original_count,3);assert.equal(p.next.rows.length,3);
  assert.deepEqual(p.next.original_counts,{parcels:2,accounts:1});
  assert.equal(p.next.observations.reported_year_built.invalid_part_count,'1');
  assert.equal(p.next.observations.reported_year_built.observed_part_count,'1');
  assert.equal(p.eligibility,'not_established','observed with an invalid part is not promoted to eligibility');
  assert.ok(Buffer.byteLength(JSON.stringify(p))<=2100000);
  assert.ok(Object.isFrozen(p.next.recorded_group));assert.ok(Object.isFrozen(p.next.recorded_housing));
  const calls=f.calls.slice(from),packets=calls.filter(c=>c.text===NEIGHBORHOOD_STOCK_SUBJECT_AND_NEXT_PACKAGE_V2_SQL);
  assert.equal(packets.length,1);assert.equal(packets[0].values[9],true);assert.equal(packets[0].values[4],250);
  assert.ok(!calls.some(c=>[NEIGHBORHOOD_STOCK_ACCOUNT_PACKAGE_V2_SQL,NEIGHBORHOOD_STOCK_SUBJECT_HOUSING_PACKAGE_V2_SQL].includes(c.text)));
  for(const run of [()=>reader.subjectHousingAccountPackage(),()=>reader.accountPackage({cursor:''}),
    ()=>reader.subjectAndRecordedGroupHousingAccountPackage({cursor:''},{includeSubject:true})])await assert.rejects(run(),/single_use/);
});

test('fixed first-selected original reader shares the aggregate packet, deduplicates subject and accepts no cursor/ordinal',async()=>{
  const f=await stockOriginalCellFixture(),same=await f.pages().subjectAndFirstSelectedRecordedGroupHousingAccountPackage({includeSubject:true});
  assert.equal(same.subject_equals_next,true);assert.equal(same.distinct_original_count,3);assert.equal(same.subject,null);
  f.rows.parcels.push(stockOriginalCell('parcels','3',{account_id:'STOCK-B',residential_year_built:1960}));
  const reader=f.pages(),from=f.calls.length,p=await reader.subjectAndFirstSelectedRecordedGroupHousingAccountPackage({includeSubject:true});
  assert.equal(p.status,'reconciled_subject_and_first_selected_stock_original_package');
  assert.equal(p.account_id,'STOCK-B');assert.equal(p.subject.account_id,'STOCK-A');assert.equal(p.distinct_original_count,4);
  assert.equal(p.next.recorded_housing.state,'unknown','subject county cannot fill the selected account');
  const queries=f.calls.slice(from),packets=queries.filter(c=>c.text===NEIGHBORHOOD_STOCK_SUBJECT_AND_FIRST_SELECTED_PACKAGE_V2_SQL);
  assert.equal(packets.length,1);assert.equal(packets[0].values[3],'');assert.equal(packets[0].values[4],250);
  assert.ok(!queries.some(c=>c.text===NEIGHBORHOOD_STOCK_SUBJECT_AND_NEXT_PACKAGE_V2_SQL));
  await assert.rejects(reader.subjectAndFirstSelectedRecordedGroupHousingAccountPackage({includeSubject:true}),/single_use/);
  for(const bad of [{includeSubject:true,cursor:''},{includeSubject:true,ordinal:1},{includeSubject:true,account_id:'STOCK-A'},
    new Proxy({includeSubject:true},{}),{get includeSubject(){assert.fail('getter');}}]){
    const before=f.calls.length;await assert.rejects(f.pages().subjectAndFirstSelectedRecordedGroupHousingAccountPackage(bad),/invalid_input/);
    assert.equal(f.calls.length,before);
  }
  assert.throws(()=>f.pages().subjectAndFirstSelectedRecordedGroupHousingAccountPackage({includeSubject:true},()=>{}),/invalid_input/);
  const sql=NEIGHBORHOOD_STOCK_SUBJECT_AND_FIRST_SELECTED_PACKAGE_V2_SQL;
  for(const expected of ['r.ordinal=1',"AND $4::text=''",'neighborhood_selected_union_v2_checkpoint_matches',
    "body.canonical_utf8::jsonb->'after'->>'done'='true'",'SELECT * FROM next_account UNION SELECT * FROM subject_account',
    'LIMIT ($5::integer+1)','(SELECT sum(n) FROM totals)<=$5::integer'])assert.ok(sql.includes(expected));
  assert.doesNotMatch(sql,/FROM core\.|array_agg|jsonb_agg|ST_DWithin|INSERT|UPDATE|DELETE/);
});

test('paired originals reconcile two different accounts, omit blocked fallback and keep a fresh empty next probe',async()=>{
  const f=await stockOriginalCellFixture();
  f.rows.parcels[0]=stockOriginalCell('parcels','1',{class_code:'A11'});
  f.rows.parcels[1]=stockOriginalCell('parcels','2',{class_code:'A12'});
  f.rows.parcels.push(stockOriginalCell('parcels','3',{account_id:'STOCK-B',class_code:'A11',residential_year_built:1960}));
  const p=await f.pages().subjectAndRecordedGroupHousingAccountPackage({cursor:'STOCK-A'},{includeSubject:true});
  assert.equal(p.account_id,'STOCK-B');assert.equal(p.subject_equals_next,false);assert.equal(p.distinct_original_count,4);
  assert.equal(p.next.rows.length,1);assert.equal(p.next.account_original_state,'absent');
  assert.equal(p.subject.account_id,'STOCK-A');assert.equal(p.subject.rows.length,3);
  assert.equal(p.subject.recorded_housing.state,'conflicting');assert.equal(p.subject.recorded_housing.category,null);
  assert.equal(p.next.recorded_housing.state,'unknown','subject county/housing cannot fill the other account');
  assert.ok([...p.next.rows,...p.subject.rows].every(r=>!Object.hasOwn(r,'original_text')));
  const blocked=await f.pages().subjectAndRecordedGroupHousingAccountPackage({cursor:'STOCK-A'},{includeSubject:false});
  assert.equal(blocked.subject,null);assert.equal(blocked.subject_included,false);assert.equal(blocked.distinct_original_count,1);
  const terminal=await f.pages().subjectAndRecordedGroupHousingAccountPackage({cursor:'STOCK-B'},{includeSubject:true});
  assert.equal(terminal.end_of_accounts,true);assert.equal(terminal.next,null);assert.equal(terminal.next_cursor,'STOCK-B');
  assert.equal(terminal.subject.account_id,'STOCK-A');assert.equal(terminal.distinct_original_count,3);
  const empty=await f.pages().subjectAndRecordedGroupHousingAccountPackage({cursor:'STOCK-B'},{includeSubject:false});
  assert.equal(empty.next,null);assert.equal(empty.subject,null);assert.equal(empty.distinct_original_count,0);
});

test('paired original guards refuse aggregate overflow, absent/wrong subject, forged metadata/cache and changed ending source',async()=>{
  const valid={account_id:'STOCK-A',geographic_parcel_count:'1',subject_account_id:'STOCK-A',subject_geographic_parcel_count:'1',
    next_parcels:2,next_accounts:1,subject_parcels:2,subject_accounts:1,original_count:3,page_count:3,invalid_count:0,packet_oversize:false};
  for(const [changes,reason] of [[{subject_account_id:null},/subject_not_in_issued_stock/],
    [{subject_account_id:'WRONG'},/invalid_result/],[{subject_parcels:1},/invalid_result/],
    [{original_count:6},/invalid_result/],[{invalid_count:1},/invalid_result/],
    [{packet_oversize:true},/account_package_byte_limit/],
    [{account_id:'STOCK-B',next_parcels:125,next_accounts:1,subject_parcels:124,subject_accounts:1,original_count:251,page_count:0,page_json:'[]'},/account_package_row_limit/],
    [{next_parcels:251,next_accounts:0,subject_parcels:251,subject_accounts:0,original_count:251,page_count:0,page_json:'[]'},/account_package_row_limit/]]){
    for(const sql of [NEIGHBORHOOD_STOCK_SUBJECT_AND_NEXT_PACKAGE_V2_SQL,NEIGHBORHOOD_STOCK_SUBJECT_AND_FIRST_SELECTED_PACKAGE_V2_SQL]){
      const f=await stockOriginalCellFixture(({text,rows})=>text===sql
        ?result({...valid,page_json:JSON.stringify([...rows.accounts,...rows.parcels]),...changes}):null),reader=f.pages();
      await assert.rejects(sql===NEIGHBORHOOD_STOCK_SUBJECT_AND_NEXT_PACKAGE_V2_SQL
        ?reader.subjectAndRecordedGroupHousingAccountPackage({cursor:''},{includeSubject:true})
        :reader.subjectAndFirstSelectedRecordedGroupHousingAccountPackage({includeSubject:true}),reason);
    }
  }
  for(const mutate of [r=>r.typed=null,r=>r.typed.observations.reported_site_area.exact_value='2',
    r=>r.original_text=r.original_text.replace('2050','2040')]){
    const f=await stockOriginalCellFixture();f.rows.parcels[0]=structuredClone(f.rows.parcels[0]);mutate(f.rows.parcels[0]);
    await assert.rejects(f.pages().subjectAndRecordedGroupHousingAccountPackage({cursor:''},{includeSubject:true}),/original_mismatch/);
  }
  let reads=0;const f=await stockOriginalCellFixture(({text,sharedHeader})=>text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read&&++reads===2
    ?result({...sharedHeader,status:'building'}):null);
  await assert.rejects(f.pages().subjectAndRecordedGroupHousingAccountPackage({cursor:''},{includeSubject:true}),/cache_unavailable/);
  for(const bad of [{includeSubject:'true'},{includeSubject:true,accountId:'CALLER'},new Proxy({includeSubject:true},{}),
    {get includeSubject(){assert.fail('getter');}}]){
    const from=f.calls.length;await assert.rejects(f.pages().subjectAndRecordedGroupHousingAccountPackage({cursor:''},bad),/invalid_input/);
    assert.equal(f.calls.length,from);
  }
  assert.throws(()=>f.pages().subjectAndRecordedGroupHousingAccountPackage({cursor:''},{includeSubject:true},()=>{}),/invalid_input/);
  assert.match(NEIGHBORHOOD_STOCK_SUBJECT_AND_NEXT_PACKAGE_V2_SQL,/SELECT \* FROM next_account UNION SELECT \* FROM subject_account/);
  assert.match(NEIGHBORHOOD_STOCK_SUBJECT_AND_NEXT_PACKAGE_V2_SQL,/LIMIT \(\$5::integer\+1\)/);
  assert.match(NEIGHBORHOOD_STOCK_SUBJECT_AND_NEXT_PACKAGE_V2_SQL,/\(SELECT sum\(n\) FROM totals\)<=\$5::integer/);
  assert.doesNotMatch(NEIGHBORHOOD_STOCK_SUBJECT_AND_NEXT_PACKAGE_V2_SQL,/FROM core\.|array_agg|jsonb_agg|ST_DWithin|INSERT|UPDATE|DELETE/);
});

test('whole stock account resolves all original parts after retained-year replay without sums or currency inference',async()=>{
  const f=await stockOriginalCellFixture();
  f.rows.parcels[0]=stockOriginalCell('parcels','1',{current_market_value:'9007199254740993'});
  f.rows.parcels[1]=stockOriginalCell('parcels','2',{residential_year_built:1960,current_market_value:'9007199254740993'});
  const packet=await f.pages().accountPackage({cursor:''});
  assert.deepEqual(packet.package_profile,getNeighborhoodStockAccountPackageV2Profile());
  assert.equal(packet.status,'reconciled_stock_account_original_package');
  assert.equal(packet.coverage,'one_complete_account_package_only');assert.equal(packet.account_id,'STOCK-A');
  assert.deepEqual(packet.original_counts,{parcels:2,accounts:1});assert.equal(packet.account_original_state,'present');
  assert.deepEqual(packet.rows.map(r=>r.kind),['accounts','parcels','parcels']);
  assert.ok(packet.rows.every(r=>!Object.hasOwn(r,'original_text')&&Object.isFrozen(r.typed)));
  const o=packet.observations;
  assert.equal(o.reported_year_built.state,'observed');assert.equal(o.reported_year_built.exact_value,'1960');
  assert.equal(o.reported_year_built.invalid_part_count,'1');assert.equal(o.reported_year_built.observed_part_count,'1');
  assert.equal(o.reported_residential_area.exact_value,'9007199254740993.01','replicated parts are not added');
  assert.equal(o.reported_site_area.exact_value,'0');assert.equal(o.reported_site_area.unit,'reported_sqft');
  assert.equal(o.reported_market_value.state,'unsupported');assert.equal(o.reported_market_value.unit,null);
  assert.equal(o.reported_market_value.exact_value,'9007199254740993');assert.equal(o.reported_market_value.unsupported_part_count,'2');
  assert.equal(packet.end_of_accounts,false);assert.equal(packet.next_cursor,'STOCK-A');
  for(const field of ['authority','selected_union','source_acquisition'])assert.equal(packet[field],'not_established');
  assert.equal(packet.report_update,'none');
  const future=await f.pages('2050-01-01').accountPackage({cursor:''});
  assert.equal(future.observations.reported_year_built.state,'conflicting');
  assert.deepEqual(future.observations.reported_year_built.conflict_values,['1960','2050']);
  assert.deepEqual(future.rows[1].typed,packet.rows[1].typed,'date-neutral cache is unchanged');
});

test('recorded eligibility consumes original-recompiled housing and every retained-date metric denominator',async()=>{
  const f=await stockOriginalCellFixture();
  for(let i=0;i<2;i++)f.rows.parcels[i]=stockOriginalCell('parcels',String(i+1),
    {class_code:'A12',residential_year_built:i===0?2050:1960,current_market_value:'12345'});
  f.rows.accounts=[stockOriginalCell('accounts','STOCK-A',{county:'DALLAS'})];
  const p=await f.pages().recordedGroupAndHousingAccountPackage({cursor:''}),h=p.recorded_housing,
    r=resolveNeighborhoodOriginalAccountEligibilityV2({subject:{state:'observed',category:'townhouse'},
      housing:{state:h.state,category:h.category,county_state:h.county_state,source_part_count:h.source_part_count,part_states:h.part_states},
      original_counts:p.original_counts,observations:p.observations});
  assert.equal(h.state,'observed');assert.equal(r.housing.matches_subject,true);
  assert.equal(p.observations.reported_year_built.state,'observed');
  assert.equal(r.metrics.reported_year_built.recorded_comparison_eligible,false,'one future outside-part value is invalid before resolution');
  assert.deepEqual(r.metrics.reported_year_built.reasons,['invalid_parts']);
  assert.equal(r.metrics.reported_residential_area.recorded_comparison_eligible,true);
  assert.equal(r.metrics.reported_market_value.recorded_comparison_eligible,false);
  assert.ok(p.rows.every(row=>!Object.hasOwn(row,'original_text')));
  assert.equal(r.complete_selected_union_eligibility,false,'compiler replay DATA is not native selected population authority');
});

test('whole stock account retains exact conflicts and missing/invalid/unsupported part denominators, without fabricating account originals',async()=>{
  const f=await stockOriginalCellFixture();f.rows.accounts=[];
  f.rows.parcels[0]=stockOriginalCell('parcels','1',{residential_year_built:null,residential_area_sqft:'0',parcel_area_sqft:null,current_market_value:'9007199254740993.01'});
  f.rows.parcels[1]=stockOriginalCell('parcels','2',{residential_year_built:'bad',residential_area_sqft:null,parcel_area_sqft:'bad',current_market_value:'9007199254740993.02'});
  const p=await f.pages().accountPackage({cursor:''}),o=p.observations;
  assert.equal(p.account_original_state,'absent');assert.equal(p.original_counts.accounts,0);
  assert.equal(o.reported_year_built.state,'invalid');assert.equal(o.reported_year_built.missing_part_count,'1');
  assert.equal(o.reported_year_built.invalid_part_count,'1');assert.equal(o.reported_year_built.source_part_count,'2');
  assert.equal(o.reported_residential_area.state,'invalid');assert.equal(o.reported_site_area.state,'invalid');
  assert.equal(o.reported_market_value.state,'conflicting');assert.equal(o.reported_market_value.exact_value,null);
  assert.deepEqual(o.reported_market_value.conflict_values,['9007199254740993.01','9007199254740993.02']);
  f.rows.parcels=f.rows.parcels.map((r,i)=>stockOriginalCell('parcels',String(i+1),{residential_year_built:null,
    residential_area_sqft:null,parcel_area_sqft:null,current_market_value:null}));
  const missing=await f.pages().accountPackage({cursor:''});
  for(const c of Object.values(missing.observations)){assert.equal(c.state,'missing');assert.equal(c.missing_part_count,'2');}
});

test('account package refuses incomplete, oversized, reordered and forged originals even with matching claimed counts',async()=>{
  for(const mutate of [r=>r.typed.observations.reported_site_area.exact_value='2',r=>r.original_text=r.original_text.replace('2050','2040'),
    r=>r.original_payload_sha256='e'.repeat(64),r=>r.typed=null,r=>r.cached_account_id='OUTSIDE']){
    const f=await stockOriginalCellFixture();f.rows.parcels[0]=structuredClone(f.rows.parcels[0]);mutate(f.rows.parcels[0]);
    await assert.rejects(f.pages().accountPackage({cursor:''}),/original_mismatch/);
  }
  const valid={account_id:'STOCK-A',geographic_parcel_count:'1',original_counts:{parcels:2,accounts:1},
    page_count:3,invalid_count:0,packet_oversize:false};
  for(const changes of [{page_count:2},{invalid_count:1},{original_counts:{parcels:1,accounts:1}},
    {geographic_parcel_count:'3'},{account_id:null},{packet_oversize:true},{page_json:'not JSON'},
    {original_counts:{parcels:251,accounts:0},page_count:0,page_json:'[]'}]){
    const f=await stockOriginalCellFixture(({text,rows})=>text===NEIGHBORHOOD_STOCK_ACCOUNT_PACKAGE_V2_SQL?
      result({...valid,page_json:JSON.stringify([...rows.accounts,...rows.parcels]),...changes}):null);
    await assert.rejects(f.pages().accountPackage({cursor:''}),/invalid_result|account_package_(?:byte|row)_limit/);
  }
  const reordered=await stockOriginalCellFixture(({text,rows})=>text===NEIGHBORHOOD_STOCK_ACCOUNT_PACKAGE_V2_SQL?
    result({...valid,page_json:JSON.stringify([...rows.parcels,...rows.accounts])}):null);
  await assert.rejects(reordered.pages().accountPackage({cursor:''}),/invalid_original/);
  assert.match(NEIGHBORHOOD_STOCK_ACCOUNT_PACKAGE_V2_SQL,/LIMIT \(\$5::integer\+1\)/);
  assert.match(NEIGHBORHOOD_STOCK_ACCOUNT_PACKAGE_V2_SQL,/LEFT JOIN LATERAL/);
  assert.doesNotMatch(NEIGHBORHOOD_STOCK_ACCOUNT_PACKAGE_V2_SQL,/FROM core\.|array_agg|ST_DWithin|INSERT|UPDATE|DELETE/);
});

test('account packages require fresh empty terminal probes and share single-use and ending-header fences with original pages',async()=>{
  const f=await stockOriginalCellFixture(),reader=f.pages();
  await reader.accountPackage({cursor:''});
  await assert.rejects(reader.accountPackage({cursor:'STOCK-A'}),/single_use/);
  await assert.rejects(reader.page({kind:'parcels',cursor:'',rowLimit:1}),/single_use/);
  const empty=await f.pages().accountPackage({cursor:'STOCK-A'});
  assert.equal(empty.account_id,null);assert.equal(empty.end_of_accounts,true);assert.equal(empty.next_cursor,'STOCK-A');
  assert.deepEqual(empty.rows,[]);assert.equal(empty.observations,null);assert.equal(empty.account_original_state,'not_applicable');
  const pageReader=f.pages();await pageReader.page({kind:'parcels',cursor:'',rowLimit:1});
  await assert.rejects(pageReader.accountPackage({cursor:''}),/single_use/);
  let headers=0;const ending=await stockOriginalCellFixture(({text,sharedHeader})=>text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read&&++headers===2?
    result({...sharedHeader,status:'building'}):null);
  await assert.rejects(ending.pages().accountPackage({cursor:''}),/cache_unavailable/);
  for(const page of [undefined,{cursor:' A'},{cursor:'',complete:true},{cursor:'',account_id:'STOCK-A'},
    {cursor:'',rowLimit:250},new Proxy({cursor:''},{}),{get cursor(){assert.fail('getter');}}])
    assert.throws(()=>prepareNeighborhoodStockAccountPackagePageV2(page),/invalid_/);
  assert.deepEqual(prepareNeighborhoodStockAccountPackagePageV2({cursor:'é'.repeat(64)}),{cursor:'é'.repeat(64)});
});

test('bounded original account housing uses the exact pinned whole-label dictionary and every outside parcel',async()=>{
  const f=await stockOriginalCellFixture();f.rows.accounts=[stockOriginalCell('accounts','STOCK-A',{county:' Dallas County '})];
  f.rows.parcels=f.rows.parcels.map((r,i)=>stockOriginalCell('parcels',String(i+1),{class_code:'A12',class_description:null,
    use_description:null,structure_type:null,built_up:true}));
  const p=await f.pages().housingAccountPackage({cursor:''}),h=p.recorded_housing;
  assert.equal(p.status,'reconciled_stock_account_recorded_housing');assert.equal(h.state,'observed');assert.equal(h.category,'townhouse');
  assert.equal(h.county_state,'observed');assert.equal(h.source_part_count,'2');assert.equal(h.part_states.observed,'2');
  assert.equal(p.geographic_parcel_count,'1');assert.deepEqual(h.parts.map(r=>r.row_key),['1','2'],'outside part is not filtered out');
  assert.deepEqual(h.profile,getNeighborhoodOriginalAccountHousingV2Profile());
  assert.deepEqual(h.retained_housing_interpretation,getCustomCohortRecordedHousingInterpretation(5,2).profile_ref);
  assert.equal(h.authority,'not_established');assert.equal(h.selected_union,'not_established');assert.equal(h.report_update,'none');
  assert.equal(p.original_reconciliation,'every_package_original_recompiled');assert.equal(p.end_of_accounts,false);
  assert.equal(p.rows[1].typed.observations.reported_year_built.exact_value,'2050');
  assert.equal(p.rows[1].retained_observations.reported_year_built.state,'invalid');
  const later=await f.pages('2050-01-01').housingAccountPackage({cursor:''});
  assert.deepEqual(later.recorded_housing,h,'housing is current recorded evidence, not a historical year-built eligibility filter');
  assert.deepEqual(later.rows[1].typed,p.rows[1].typed,'neutral original/cache bytes stay unchanged');
  const legacy=await f.pages().accountPackage({cursor:''});assert.ok(!Object.hasOwn(legacy,'recorded_housing'));
  assert.equal(legacy.status,'reconciled_stock_account_original_package');
});

test('original account housing preserves all five states, county and unknown literal reasons without majority or one-unit inference',async()=>{
  const f=await stockOriginalCellFixture();
  const set=(a,b)=>{f.rows.parcels=[stockOriginalCell('parcels','1',a),stockOriginalCell('parcels','2',b)];};
  const read=async()=> (await f.pages().housingAccountPackage({cursor:''})).recorded_housing;
  set({class_code:'A11'},{class_description:'SFR - TOWNHOUSES'});
  assert.equal((await read()).state,'conflicting');assert.equal((await read()).category,null);
  set({class_code:'A11'},{});let h=await read();assert.equal(h.state,'partial');assert.equal(h.category,null);
  assert.deepEqual(h.part_states,{observed:'1',missing:'1',unknown:'0',partial:'0',conflicting:'0'});
  set({},{});assert.equal((await read()).state,'missing');
  set({class_code:'101',structure_type:'1'},{class_description:'Single Family',use_description:'one unit'});
  assert.equal((await read()).state,'unknown');
  set({class_code:'A11',structure_type:'CONDO / TOWNHOME'},{class_code:'A11',use_description:'CONDO/TOWNHOME'});
  assert.equal((await read()).state,'unknown','explicit alternatives do not borrow known detached meaning');
  for(const value of [101,{},true,'Townhouse '.repeat(20),'TOWNHOUSE\n']){
    set({class_code:'A11',structure_type:value},{class_code:'A11',structure_type:value});
    assert.equal((await read()).state,'unknown','unavailable/wrong-type diagnostics cannot borrow a supplementary known code');
  }
  set({class_code:'A11'},{class_code:'A11'});
  for(const county of [null,'Tarrant','DALLAS-ish',123,'Dallas '.repeat(30)]){
    f.rows.accounts=[stockOriginalCell('accounts','STOCK-A',{county})];h=await read();
    assert.equal(h.state,'unknown');assert.equal(h.category,null);assert.notEqual(h.county_state,'observed');
  }
  f.rows.accounts=[];h=await read();assert.equal(h.state,'unknown');assert.equal(h.account_original_state,'absent');
  assert.equal(h.source_part_count,'2');
  for(const [code,category] of [['A20','mobile_home'],['B11','apartment'],['B12','duplex'],['A13','condominium']]){
    f.rows.accounts=[stockOriginalCell('accounts','STOCK-A')];set({class_code:code},{class_code:code});assert.equal((await read()).category,category);
  }
  set({class_description:'MANUFACTURED HOME'},{structure_type:'MOBILE HOME'});assert.equal((await read()).state,'conflicting');
});

test('housing cannot bypass complete original replay, whole bounds, ending fences or reset the single-use budget',async()=>{
  for(const change of [r=>r.typed.markers.class_code.value_text='A12',r=>r.original_text=r.original_text.replace('2050','1900'),
    r=>r.original_payload_sha256='e'.repeat(64),r=>r.typed=null]){
    const f=await stockOriginalCellFixture();f.rows.parcels[0]=structuredClone(f.rows.parcels[0]);change(f.rows.parcels[0]);
    await assert.rejects(f.pages().housingAccountPackage({cursor:''}),/original_mismatch/);
  }
  for(const change of [{packet_oversize:true},{invalid_count:1},{original_counts:{parcels:251,accounts:0},page_count:0,page_json:'[]'}]){
    const f=await stockOriginalCellFixture(({text,rows})=>text===NEIGHBORHOOD_STOCK_ACCOUNT_PACKAGE_V2_SQL?
      result({account_id:'STOCK-A',geographic_parcel_count:'1',original_counts:{parcels:2,accounts:1},page_count:3,invalid_count:0,
        packet_oversize:false,page_json:JSON.stringify([...rows.accounts,...rows.parcels]),...change}):null);
    await assert.rejects(f.pages().housingAccountPackage({cursor:''}),/invalid_result|account_package_(?:byte|row)_limit/);
  }
  let headers=0;const ending=await stockOriginalCellFixture(({text,sharedHeader})=>text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read&&++headers===2?
    result({...sharedHeader,status:'building'}):null);
  await assert.rejects(ending.pages().housingAccountPackage({cursor:''}),/cache_unavailable/);
  const f=await stockOriginalCellFixture(),reader=f.pages();await reader.housingAccountPackage({cursor:''});
  await assert.rejects(reader.accountPackage({cursor:''}),/single_use/);await assert.rejects(reader.housingAccountPackage({cursor:''}),/single_use/);
  await assert.rejects(reader.page({kind:'accounts',cursor:'',rowLimit:1}),/single_use/);
  const old=f.pages();await old.accountPackage({cursor:''});await assert.rejects(old.housingAccountPackage({cursor:''}),/single_use/);
  const end=await f.pages().housingAccountPackage({cursor:'STOCK-A'});
  assert.equal(end.recorded_housing,null);assert.equal(end.end_of_accounts,true);assert.equal(end.next_cursor,'STOCK-A');
  assert.deepEqual(end.rows,[]);
  for(const value of [new Proxy([],{}),[,],{rows:[]},[{get kind(){assert.fail('getter');}}]])
    assert.throws(()=>resolveNeighborhoodOriginalAccountHousingV2(value,()=>{}),/invalid_input/);
});

test('original recorded-group reader resolves512-byte labels only after whole original/ENTIRE cache replay without changing legacy bytes',async()=>{
  const f=await stockOriginalCellFixture(),long='Synthetic '+ 'x'.repeat(502);
  f.rows.accounts=[stockOriginalCell('accounts','STOCK-A',{subdivision:long})];
  f.rows.parcels=f.rows.parcels.map((r,i)=>stockOriginalCell('parcels',String(i+1),{subdivision_name:long}));
  const p=await f.pages().recordedGroupAccountPackage({cursor:''});
  assert.equal(p.status,'reconciled_stock_account_recorded_group');assert.equal(p.recorded_group.state,'assigned');
  assert.equal(p.recorded_group.candidate_groups[0].normalized_label,long.toLowerCase());
  assert.equal(p.recorded_group.parcel_source_row_count,'2');assert.equal(p.geographic_parcel_count,'1');
  assert.equal(p.rows[0].typed.markers.subdivision.state,'oversize');assert.equal(p.rows[0].typed.markers.subdivision.value_text,null);
  assert.equal(p.rows[0].original_recorded_labels.subdivision.raw,long,'hash/128byte marker is not substituted for the512byte original');
  const legacy=await f.pages().accountPackage({cursor:''});
  assert.equal(Object.hasOwn(legacy,'recorded_group'),false);assert.ok(legacy.rows.every(r=>!Object.hasOwn(r,'original_recorded_labels')));
  assert.deepEqual(p.rows.map(({original_recorded_labels,...r})=>r),legacy.rows);
  assert.equal(p.selected_union,'not_established');assert.equal(p.report_update,'none');
  f.rows.parcels[1]=stockOriginalCell('parcels','2',{subdivision_name:'Other outside name'});
  assert.equal((await f.pages().recordedGroupAccountPackage({cursor:''})).recorded_group.state,'unassigned');
  f.rows.parcels[1]=stockOriginalCell('parcels','2',{subdivision_name:'x'.repeat(513)});
  await assert.rejects(f.pages().recordedGroupAccountPackage({cursor:''}),/recorded_label_text_limit/);
});

test('recorded-group reader cannot bypass unchanged-hash/count original/cache forgeries, whole bounds, empty probes or the single-use budget',async()=>{
  for(const change of [r=>r.typed.markers.subdivision_name.value_text='forged',r=>r.original_text=r.original_text.replace('Literal only','Forged value'),
    r=>r.original_payload_sha256='e'.repeat(64),r=>r.typed=null]){
    const f=await stockOriginalCellFixture();f.rows.parcels[0]=structuredClone(f.rows.parcels[0]);change(f.rows.parcels[0]);
    await assert.rejects(f.pages().recordedGroupAccountPackage({cursor:''}),/original_mismatch/);
  }
  for(const change of [{packet_oversize:true},{invalid_count:1},{original_counts:{parcels:251,accounts:0},page_count:0,page_json:'[]'}]){
    const f=await stockOriginalCellFixture(({text,rows})=>text===NEIGHBORHOOD_STOCK_ACCOUNT_PACKAGE_V2_SQL?
      result({account_id:'STOCK-A',geographic_parcel_count:'1',original_counts:{parcels:2,accounts:1},page_count:3,invalid_count:0,
        packet_oversize:false,page_json:JSON.stringify([...rows.accounts,...rows.parcels]),...change}):null);
    await assert.rejects(f.pages().recordedGroupAccountPackage({cursor:''}),/invalid_result|account_package_(?:byte|row)_limit/);
  }
  let headers=0;const ending=await stockOriginalCellFixture(({text,sharedHeader})=>text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read&&++headers===2?
    result({...sharedHeader,status:'building'}):null);
  await assert.rejects(ending.pages().recordedGroupAccountPackage({cursor:''}),/cache_unavailable/);
  const f=await stockOriginalCellFixture(),reader=f.pages();await reader.recordedGroupAccountPackage({cursor:''});
  for(const method of ['accountPackage','housingAccountPackage','recordedGroupAccountPackage'])await assert.rejects(reader[method]({cursor:''}),/single_use/);
  const old=f.pages();await old.accountPackage({cursor:''});await assert.rejects(old.recordedGroupAccountPackage({cursor:''}),/single_use/);
  const end=await f.pages().recordedGroupAccountPackage({cursor:'STOCK-A'});
  assert.equal(end.recorded_group,null);assert.equal(end.end_of_accounts,true);assert.equal(end.next_cursor,'STOCK-A');assert.deepEqual(end.rows,[]);
});

test('combined account facts derive full labels, housing and retained-date metrics from ONE original packet without changing existing consumers',async()=>{
  const f=await stockOriginalCellFixture(),long='Synthetic '+ 'x'.repeat(502);
  f.rows.accounts=[stockOriginalCell('accounts','STOCK-A',{subdivision:long})];
  f.rows.parcels=[stockOriginalCell('parcels','1',{subdivision_name:long,class_code:'A11'}),
    stockOriginalCell('parcels','2',{subdivision_name:long,class_code:'A12',residential_year_built:1960})];
  const from=f.calls.length,p=await f.pages().recordedGroupAndHousingAccountPackage({cursor:''});
  assert.equal(p.status,'reconciled_stock_account_recorded_group_and_housing');
  assert.equal(f.calls.slice(from).filter(c=>c.text===NEIGHBORHOOD_STOCK_ACCOUNT_PACKAGE_V2_SQL).length,1);
  assert.equal(p.recorded_group.state,'assigned');assert.equal(p.recorded_group.candidate_groups[0].normalized_label,long.toLowerCase());
  assert.equal(p.rows[0].original_recorded_labels.subdivision.raw,long);
  assert.equal(p.recorded_housing.state,'conflicting');assert.equal(p.recorded_housing.category,null);
  assert.deepEqual(p.recorded_housing.parts,[{row_key:'1',state:'observed',category:'detached_single_family'},
    {row_key:'2',state:'observed',category:'townhouse'}],'outside-geometry housing contradiction remains explicit');
  assert.equal(p.geographic_parcel_count,'1');assert.equal(p.recorded_housing.source_part_count,'2');
  assert.equal(p.rows[1].retained_observations.reported_year_built.state,'invalid');
  assert.equal(p.observations.reported_year_built.exact_value,'1960');
  assert.equal(p.observations.reported_residential_area.exact_value,'9007199254740993.01');
  assert.equal(p.observations.reported_residential_area.unit,'reported_sqft');
  const group=await f.pages().recordedGroupAccountPackage({cursor:''}),housing=await f.pages().housingAccountPackage({cursor:''}),
    legacy=await f.pages().accountPackage({cursor:''});
  assert.deepEqual(p.rows,group.rows);assert.deepEqual(p.recorded_group,group.recorded_group);
  assert.deepEqual(p.recorded_housing,housing.recorded_housing);assert.deepEqual(p.observations,legacy.observations);
  assert.deepEqual(p.rows.map(({original_recorded_labels,...row})=>row),legacy.rows);
  assert.ok(!Object.hasOwn(group,'recorded_housing'));assert.ok(!Object.hasOwn(housing,'recorded_group'));
  assert.ok(!Object.hasOwn(legacy,'recorded_group'));assert.ok(!Object.hasOwn(legacy,'recorded_housing'));
  assert.ok(Object.isFrozen(p.recorded_housing.parts));assert.ok(Object.isFrozen(p.recorded_group));
  assert.ok(p.rows.every(r=>!Object.hasOwn(r,'original_text')));assert.ok(Buffer.byteLength(JSON.stringify(p))<=2100000);
  assert.equal(p.coverage,'one_complete_account_package_only');assert.equal(p.authority,'not_established');
  assert.equal(p.selected_union,'not_established');assert.equal(p.report_update,'none');
  const future=await f.pages('2050-01-01').recordedGroupAndHousingAccountPackage({cursor:''});
  assert.deepEqual(future.recorded_housing,p.recorded_housing);assert.deepEqual(future.recorded_group,p.recorded_group);
  assert.deepEqual(future.rows.map(r=>r.typed),p.rows.map(r=>r.typed));
  assert.equal(future.observations.reported_year_built.state,'conflicting');
});

test('combined facts refuse original/cache forgeries in either interpretation and preserve missing-county and outside-label reasons',async()=>{
  for(const change of [r=>r.typed.markers.class_code.value_text='A12',r=>r.typed.markers.subdivision_name.value_text='forged',
    r=>r.original_text=r.original_text.replace('2050','1900'),r=>r.original_payload_sha256='e'.repeat(64),r=>r.typed=null]){
    const f=await stockOriginalCellFixture();f.rows.parcels[0]=structuredClone(f.rows.parcels[0]);change(f.rows.parcels[0]);
    await assert.rejects(f.pages().recordedGroupAndHousingAccountPackage({cursor:''}),/original_mismatch/);
  }
  const f=await stockOriginalCellFixture();f.rows.accounts=[];
  let p=await f.pages().recordedGroupAndHousingAccountPackage({cursor:''});
  assert.equal(p.recorded_housing.state,'unknown');assert.equal(p.recorded_housing.account_original_state,'absent');
  assert.equal(p.recorded_group.state,'unassigned');assert.equal(p.account_original_state,'absent');
  f.rows.accounts=[stockOriginalCell('accounts','STOCK-A')];
  f.rows.parcels[1]=stockOriginalCell('parcels','2',{subdivision_name:'Outside contradictory group',structure_type:'CONDO / TOWNHOME'});
  p=await f.pages().recordedGroupAndHousingAccountPackage({cursor:''});
  assert.equal(p.recorded_group.state,'unassigned');assert.equal(p.recorded_group.candidate_groups.length,2);
  assert.equal(p.recorded_housing.state,'unknown');assert.equal(p.recorded_housing.category,null);
  f.rows.parcels[1]=stockOriginalCell('parcels','2',{subdivision_name:'x'.repeat(513)});
  await assert.rejects(f.pages().recordedGroupAndHousingAccountPackage({cursor:''}),/recorded_label_text_limit/);
});

test('combined facts keep the whole packet bounds, ending fences, fresh empty probe and single-use lifetime across ALL consumers',async()=>{
  for(const change of [{packet_oversize:true},{invalid_count:1},{original_counts:{parcels:251,accounts:0},page_count:0,page_json:'[]'}]){
    const f=await stockOriginalCellFixture(({text,rows})=>text===NEIGHBORHOOD_STOCK_ACCOUNT_PACKAGE_V2_SQL?
      result({account_id:'STOCK-A',geographic_parcel_count:'1',original_counts:{parcels:2,accounts:1},page_count:3,invalid_count:0,
        packet_oversize:false,page_json:JSON.stringify([...rows.accounts,...rows.parcels]),...change}):null);
    await assert.rejects(f.pages().recordedGroupAndHousingAccountPackage({cursor:''}),/invalid_result|account_package_(?:byte|row)_limit/);
  }
  let headers=0;const ending=await stockOriginalCellFixture(({text,sharedHeader})=>text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read&&++headers===2?
    result({...sharedHeader,status:'building'}):null);
  await assert.rejects(ending.pages().recordedGroupAndHousingAccountPackage({cursor:''}),/cache_unavailable/);
  const f=await stockOriginalCellFixture(),methods=['accountPackage','housingAccountPackage','recordedGroupAccountPackage','recordedGroupAndHousingAccountPackage'];
  for(const first of methods){const reader=f.pages();await reader[first]({cursor:''});
    for(const next of methods)await assert.rejects(reader[next]({cursor:''}),/single_use/);
    await assert.rejects(reader.page({kind:'parcels',cursor:'',rowLimit:1}),/single_use/);}
  const empty=await f.pages().recordedGroupAndHousingAccountPackage({cursor:'STOCK-A'});
  assert.equal(empty.end_of_accounts,true);assert.equal(empty.next_cursor,'STOCK-A');assert.deepEqual(empty.rows,[]);
  assert.equal(empty.recorded_group,null);assert.equal(empty.recorded_housing,null);assert.equal(empty.observations,null);
});
