import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlob } from './cohortEvidenceBlobRepository.js';
import { getNeighborhoodFrozenTypedCadImprovementV1Profile } from './neighborhoodFrozenTypedCadImprovementV1.js';

const STATES=['observed','missing','invalid','conflicting','unsupported'];
/** Refuse without exposing private retained source values. */
const fail=r=>{throw new TypeError(`neighborhood_original_CAD_amenity_v2_${r}`);};
/** Inspect closed own DATA without executing a getter or proxy trap. */
function data(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(v);
  if(Reflect.ownKeys(ds).length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}
/** Inspect one own DATA property on an already owner-replayed row. */
function own(v,key){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const d=Object.getOwnPropertyDescriptor(v,key);if(!d?.enumerable||!Object.hasOwn(d,'value'))fail('invalid_input');return d.value;}
/** Freeze newly detached output only. */
function freeze(v){if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
const definition=freeze({id:'neighborhood-original-CAD-amenity-evidence-v2',revision:'1',
  syntax_profile:getNeighborhoodFrozenTypedCadImprovementV1Profile().profile_ref,limit_original_rows:250,
  prerequisites:'actual_owner_recompiles_every_complete_account_original_and_entire_neutral_cache_before_resolution',
  pool:'native_local_reported_boolean_true_false_distinct_from_NULL_missing_not_verified_presence_or_absence',
  secondary:'every_native_row_id_retained_even_duplicate_improvement_numbers_no_first_majority_deduplication_or_area_sum',
  type_dictionary:'not_established_no_whole_label_substring_numeric_quality_or_primary_pool_inference',
  area:'local_reported_sqft_only_not_verified_garage_area_spaces_GLA_or_disjoint_improvements',
  provider_fidelity:'local_original_replay_does_not_recover_unretained_provider_fields_tokens_or_field_revision',
  temporal:'current_retained_local_CAD_not_historical_stock_or_at_sale_amenities',
  authority:'not_established',coverage:'one_complete_account_not_complete_selected_union',
  limitations:['no_provider_dictionary_source_freshness_or_licensed_acquisition',
    'no_verified_amenity_completeness_eligibility_statistics_publication_or_report_update']});
const text=canonicalAssessmentJson(definition),ref=prepareNeighborhoodCohortBlob(text);
const PROFILE=freeze({profile_ref:{id:definition.id,revision:'1',content_sha256:ref.content_sha256},definition_blob:{ref,canonical_json:text}});
/** Fixed evidence interpretation, never a source or selection capability. */
export function getNeighborhoodOriginalCadAmenityEvidenceV2Profile(){return PROFILE;}

/** Detach a compiler observation without interpreting its source meaning. */
function cell(v,pool=false,unit=null){const c=data(v,['state','exact_value','unit','reason']);
  if(!STATES.includes(c.state))fail('invalid_cell');
  if(c.state==='observed'){
    const valid=pool?typeof c.exact_value==='boolean'&&c.unit==='reported_pool_flag'
      :typeof c.exact_value==='string'&&Buffer.byteLength(c.exact_value)<=32
        &&/^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(c.exact_value)&&c.unit===unit;
    if(!valid||c.reason!==null)fail('invalid_cell');
  }else if(c.exact_value!==null||c.unit!==null||typeof c.reason!=='string'||Buffer.byteLength(c.reason)>128)fail('invalid_cell');
  return c;}
/** Remove raw token detail from an observation; raw type diagnostics stay separate. */
function observation(v,unit){return cell(Object.fromEntries(['state','exact_value','unit','reason'].map(k=>[k,own(v,k)])),false,unit);}
/** Native IDs, not improvement numbers, identify distinct retained originals. */
function original(v,accountId,kind){const r=data(v,['kind','row_key','account_id','original_payload_sha256','typed']);
  if(r.kind!==kind||r.account_id!==accountId||typeof r.row_key!=='string'||!r.row_key
    ||typeof r.original_payload_sha256!=='string'||!/^[a-f0-9]{64}$/.test(r.original_payload_sha256)
    ||(kind==='primary'?r.row_key!==accountId:!(/^[1-9]\d{0,18}$/).test(r.row_key)||BigInt(r.row_key)>9223372036854775807n))fail('invalid_original');
  return r;}

/** Bounded DATA resolver called only AFTER the actual DB owner has replayed
 * every original and ENTIRE cache. This helper establishes no originality,
 * rights, traversal, provider fidelity or amenity completeness by itself. */
export function resolveNeighborhoodOriginalCadAmenityEvidenceV2(value,check){
  if(typeof check!=='function')fail('invalid_input');check();
  const a=data(value,['account_id','geographic_parcel_count','primary_original_count','secondary_original_count','primary','observations',
    'secondary_originals','secondary_type_resolution','housing_eligibility','temporal_basis','source_freshness']);
  const id=a.account_id,primaryCount=a.primary_original_count,secondaryCount=a.secondary_original_count;
  if(typeof id!=='string'||!id||Buffer.byteLength(id)>64||!['0','1'].includes(primaryCount)
    ||typeof secondaryCount!=='string'||!/^(?:0|[1-9]\d{0,2})$/.test(secondaryCount)
    ||Number(primaryCount)+Number(secondaryCount)>250)fail('invalid_account');
  const primary=a.primary,secondary=a.secondary_originals;
  if((primary===null)!==(primaryCount==='0')||isProxy(secondary)||!Array.isArray(secondary)
    ||Object.getPrototypeOf(secondary)!==Array.prototype||secondary.length!==Number(secondaryCount)
    ||Reflect.ownKeys(secondary).length!==secondary.length+1)fail('invalid_account');
  const pool=cell(own(a.observations,'reported_pool_flag'),true);
  const source=primary===null?null:original(primary,id,'primary');
  if(source===null&&(pool.state!=='missing'||pool.reason!=='primary_original_absent'))fail('invalid_account');
  const seen=new Set(),rows=[];
  for(let i=0;i<secondary.length;i++){
    check();const d=Object.getOwnPropertyDescriptor(secondary,String(i));
    if(!d?.enumerable||!Object.hasOwn(d,'value'))fail('invalid_input');
    const r=original(d.value,id,'secondary');if(seen.has(r.row_key))fail('duplicate_native_original');seen.add(r.row_key);
    const observations=own(r.typed,'observations'),marker=data(own(own(r.typed,'markers'),'sec_imp_type'),
      ['state','json_type','value_text','utf8_bytes','value_sha256']);
    if(!['json_null','scalar','oversize','non_scalar'].includes(marker.state)||!['null','string','number','boolean','object','array'].includes(marker.json_type)
      ||!Number.isSafeInteger(marker.utf8_bytes)||marker.utf8_bytes<0||marker.utf8_bytes>1000000
      ||marker.value_text!==null&&(typeof marker.value_text!=='string'||Buffer.byteLength(marker.value_text)>128)
      ||marker.value_sha256!==null&&(typeof marker.value_sha256!=='string'||!/^[a-f0-9]{64}$/.test(marker.value_sha256)))fail('invalid_marker');
    rows.push({row_key:r.row_key,original_payload_sha256:r.original_payload_sha256,
      reported_number:observation(own(observations,'reported_improvement_number'),'reported_improvement_number'),
      reported_area:observation(own(observations,'reported_improvement_area'),'reported_sqft'),
      reported_type:marker,semantic_type:'unsupported'});
  }
  const unresolved=()=>({state:'unsupported',exact_value:null,unit:null,reason:'retained_source_dictionary_not_established'});
  check();return freeze({amenity_evidence_version:2,profile:PROFILE,account_id:id,
    reported_pool:{...pool,source_original:source?{kind:'primary',row_key:source.row_key,original_payload_sha256:source.original_payload_sha256}:null,
      verified_presence_or_absence:'not_established'},
    garage_area:unresolved(),garage_spaces:unresolved(),outbuilding_area:unresolved(),
    secondary_inventory:{original_count:secondaryCount,rows},basis:definition.temporal,
    provider_fidelity:'not_established',source_freshness:'not_established',amenity_completeness:'not_established',
    authority:'not_established',selected_union:'not_established',report_update:'none'});
}
