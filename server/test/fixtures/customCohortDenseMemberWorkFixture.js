import assert from 'node:assert/strict';
import { buildFrozenCadSourceCaptures, DENSE_CAD_SOURCE_CAPTURE_LIMITS }
  from '../../src/services/neighborhoodAssessment/cachedSourceCaptures.js';
import { mapCombinedEvidenceParcelRow, mapCombinedEvidenceAccountRow, mapCombinedEvidenceSaleRow,
  mapCombinedEvidenceSaleLinkRow } from '../../src/services/neighborhoodAssessment/cachedRowMappingsV5.js';
import { CACHED_SALE_WITNESS_V2_FIELDS } from '../../src/services/neighborhoodAssessment/cachedSaleWitnessV2.js';
import { DENSE_CAD_CACHE_READER_LIMITS } from '../../src/services/neighborhoodAssessment/denseCadCapturePolicy.js';
import { contextFixture } from './customCohortContextFixture.js';

const NOW='2026-09-19T12:00:00.000Z';
const freeze=value=>{
  if(value && typeof value==='object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};
const witness=freeze({witness_version:2,root_state:'object',root_json_type:'object',
  fields:Object.fromEntries(CACHED_SALE_WITNESS_V2_FIELDS.map(key=>[key,
    {state:'absent',json_type:null,value_text:null,utf8_bytes:null}]))});

// Pure synthetic observations through the actual mapping 5 and dense chunk
// builder. No reader/retention/auth receipt, source eligibility or DB is claimed.
export async function denseMemberWorkFixture({accountCount=39700,saleCount=2500,
  saleAccount, pockets, links=[]}={}) {
  assert.ok(Number.isSafeInteger(accountCount) && accountCount>0 && accountCount<=50000);
  assert.ok(Number.isSafeInteger(saleCount) && saleCount>=0 && saleCount<=5000);
  assert.equal(DENSE_CAD_SOURCE_CAPTURE_LIMITS.input_records,200000);
  assert.equal(DENSE_CAD_SOURCE_CAPTURE_LIMITS.input_bytes,144000000);
  assert.equal(DENSE_CAD_SOURCE_CAPTURE_LIMITS.output_bytes,160000000);
  const accounts=Array.from({length:accountCount},(_,i)=>String(10000000000000000n+BigInt(i)));
  const target={...contextFixture().target,account_id:accounts[0],assignment_file_id:'17'};
  const scope=Object.fromEntries(['organization_id','appraisal_case_id','subject_snapshot_id','account_id']
    .map(key=>[key,target[key]]));
  const wrap=(raw,mapper,prefix)=>{const mapped=mapper(raw);return freeze({record_id:`${prefix}:${mapped.record_id}`,data:mapped});};
  const groups={
    selection:accounts.map(account_id=>freeze({record_id:`selected:${account_id}`,data:{account_id}})),
    parcels:accounts.map((account_id,i)=>wrap({object_id:String(9007199254740993n+BigInt(i)),account_id,
      residential_year_built:1990+i%30,residential_area_sqft:String(1200+i%100),parcel_area_sqft:String(6000+i%200),
      current_market_value:String(250000+i%1000),class_code:'A1',class_description:'Single family',
      use_description:'Residential',structure_type:null,built_up:true},mapCombinedEvidenceParcelRow,'parcel')),
    accounts:accounts.map(account_id=>wrap({account_id,county:'Dallas',subdivision:'Synthetic dense plat'},mapCombinedEvidenceAccountRow,'account')),
    transactions:Array.from({length:saleCount},(_,i)=>{
      const account_id=saleAccount===undefined?accounts[i%accounts.length]:saleAccount;
      return wrap({source_record_id:String(i+1),sale_id:String(i+1),primary_account_id:account_id,sale_account_id:account_id,
        record_type:'closed_sale',sale_closing_date:'2024-03-01',source_close_date:'2024-03-01',
        sale_price:String(300000+i),source_current_price:String(310000+i),source_living_area:String(1600+i%50),
        source_lot_size_area:'0.2',source_year_built:2000,source_days_on_market:i%30,
        source_mls_status:'Closed',source_row_number:i+1,source_raw_witness:witness},mapCombinedEvidenceSaleRow,'sale');
    }),
    sale_links:links.map(row=>wrap(row,mapCombinedEvidenceSaleLinkRow,'link')),
    gis_sync:[],
  };
  const input=freeze({scope,captures:Object.entries(groups).map(([role,records])=>({
    upstream:{id:`local-cache:${role}`,key:role,state:records.length?'populated':'present_empty',complete:true,
      revision:'synthetic-dense-member-work-v1',content_sha256:'a'.repeat(64),captured_at:NOW,
      visibility:'assignment_private',scope,row_count:records.length},
    metadata:{id:`local-cache-${role}`,provider:'Synthetic dense member fixture',revision:'synthetic-dense-member-work-v1',
      valid_from:null,valid_to:null,observed_at:NOW,historical_availability:'unknown'},
    projection:{id:`cache-${role}`,revision:'synthetic-dense-member-work-v1',definition:{role,mapping_version:5},
      complete:true,input_row_count:records.length,output_record_count:records.length},records,
  }))});
  const capture=await buildFrozenCadSourceCaptures(input);
  assert.equal(capture.status,'ready');
  const chosen=pockets===undefined?[{id:'all-catalog-groups',label:'All initial catalog groups',account_ids:accounts}]
    : typeof pockets==='function'?pockets(accounts):pockets;
  return {context_ref:{context_id:contextFixture().context_id,context_revision:'1',context_sha256:'e'.repeat(64)},
    retained_inputs:{subject:{target,effective_date:'2024-06-30'},
      study:{observation_period:{start_date:'2023-07-01',end_date:'2024-06-30'}},
      spatial:{query_complete:true,account_ids:accounts,
        parcels:accounts.map((account_id,i)=>({object_id:String(9007199254740993n+BigInt(i)),account_id}))},
      acquisition:{compact_metadata_json:JSON.stringify({reader_version:'local-capture-v3',mapping_version:5,
        limits:DENSE_CAD_CACHE_READER_LIMITS}),captured_query_request:{scope,account_ids:accounts},
        capture_result:{query_complete:true,captured_at:NOW,source_capture:capture}}},
    selection:{revision:1,pockets:chosen}};
}
