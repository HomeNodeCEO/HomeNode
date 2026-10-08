import { types } from 'node:util';
import { canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { COHORT_ORIGINAL_SOURCE_REFERENCES_V2_KINDS as KINDS } from './cohortOriginalSourceReferencesV2.js';
import { prepareNeighborhoodFrozenSourceIdentityProgress } from './neighborhoodFrozenJobSourceIdentity.js';

const FORMAT='cohort_source_identity_receipt_v2',MAX=2_000_000;
const REFS=['source_reference','root','graph_verification_reference','stock_verification_reference','stock_reference'];
const EXPECTED=['binding',...REFS,'layer_counts','stock_account_count'];
const KEYS=['format',...EXPECTED,'sequence','previous','before','after'];
const same=(a,b)=>canonicalAssessmentJson(a)===canonicalAssessmentJson(b);
function fail(){throw new TypeError('cohort_source_identity_receipt_v2_invalid_receipt');}
function data(value,keys){
  if(!value||types.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail();
  const ds=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(ds);
  if(names.length!==keys.length||!keys.every(k=>names.includes(k)&&ds[k].enumerable&&Object.hasOwn(ds[k],'value')))fail();
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function ref(raw){const r=data(raw,['content_sha256','canonical_utf8_bytes']);
  const result=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(result.canonical_utf8_bytes)>16000)fail();return result;}
function advances(after,before,kind){
  return after!==''&&(before===''||(['parcels','source_records','sales','sale_links'].includes(kind)
    ?BigInt(after)>BigInt(before):Buffer.compare(Buffer.from(after),Buffer.from(before))>0));
}

/** Closed identity transition DATA, not issuance or original/source-rights
 * proof. The actual V2 owner must require independently issued completed graph
 * AND geographic heads and load progress only from its own independent last
 * issued identity head. Native original identities/one-hop associations stay
 * in the unchanged bounded SQL primitive; this module never reads originals. */
export function prepareCohortSourceIdentityReceiptV2(raw,expected){
  const r=data(raw,KEYS),e=data(expected,EXPECTED);
  const binding=data(r.binding,['organization_id','report_file_id','assignment_file_id','account_id','operation_id',
    'generation_id','spatial_definition_sha256','source_original_sha256']);
  const counts=data(r.layer_counts,KINDS);
  if(r.format!==FORMAT||!same(binding,e.binding)||!same(counts,e.layer_counts)
    ||!KINDS.every(k=>Number.isSafeInteger(counts[k])&&counts[k]>=0&&counts[k]<=MAX)
    ||typeof r.stock_account_count!=='string'||!/^[1-9][0-9]{0,6}$/.test(r.stock_account_count)
    ||Number(r.stock_account_count)>MAX||r.stock_account_count!==e.stock_account_count
    ||!Number.isInteger(r.sequence)||r.sequence<1||r.sequence>200000)fail();
  const refs=Object.fromEntries(REFS.map(k=>[k,ref(r[k])]));
  if(!REFS.every(k=>same(refs[k],e[k])))fail();
  const previous=r.previous===null?null:ref(r.previous);
  const before=prepareNeighborhoodFrozenSourceIdentityProgress(r.before),after=prepareNeighborhoodFrozenSourceIdentityProgress(r.after);
  if(!before||!after||before.kind_index>=KINDS.length||before.binding_sha256!==after.binding_sha256
    ||(r.sequence===1)!==(previous===null)||before.unknown_parcel_origins>counts.parcels
    ||after.unknown_parcel_origins>counts.parcels
    ||before.layer_rows>counts[KINDS[before.kind_index]]
    ||after.kind_index<KINDS.length&&after.layer_rows>counts[KINDS[after.kind_index]]
    ||after.missing_account_count!==null&&after.missing_account_count>Number(r.stock_account_count))fail();
  if(r.sequence===1&&(before.kind_index!==0||before.after!==''||before.layer_rows!==0
    ||before.unknown_parcel_origins!==0||before.missing_account_count!==null))fail();
  const advanced=after.kind_index===before.kind_index+1,kind=KINDS[before.kind_index];
  const delta=advanced?counts[kind]-before.layer_rows:after.layer_rows-before.layer_rows;
  const unknownDelta=after.unknown_parcel_origins-before.unknown_parcel_origins;
  if(!(advanced||after.kind_index===before.kind_index)||delta<0||delta>250||unknownDelta<0||unknownDelta>delta
    ||kind!=='parcels'&&unknownDelta!==0
    ||advanced&&(delta===250||after.after!==''||after.layer_rows!==0)
    ||!advanced&&(delta===0||!advances(after.after,before.after,kind)))fail();
  // A full 250-row tail stays on its layer, then advances with an empty query.
  // Short nonterminal pages can be valid under the unchanged 8-MB admission.
  return Object.freeze({...r,...refs,binding:Object.freeze(binding),layer_counts:Object.freeze(counts),previous,before,after});
}
