import { isProxy } from 'node:util/types';
import { assessmentEvidenceDigest,canonicalAssessmentJson as json } from './contract.js';
import { getNeighborhoodFrozenTypedCadImprovementV1Profile } from './neighborhoodFrozenTypedCadImprovementV1.js';

const PROFILE=getNeighborhoodFrozenTypedCadImprovementV1Profile(),TIME=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const fail=()=>{throw new TypeError('neighborhood_covered_CAD_cache_v2_cache_unavailable');};
function data(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail();
  const ds=Object.getOwnPropertyDescriptors(v);if(Reflect.ownKeys(ds).length!==keys.length
    ||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail();return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}
const count=(v,max)=>typeof v==='string'&&/^(0|[1-9][0-9]{0,9})$/.test(v)&&BigInt(v)<=BigInt(max);

/** Header DATA only, never cache completeness or a coverage capability. The
 * real owner first authenticates independent native CAD+E DONE and all parents,
 * then replays every requested original against its ENTIRE cached JSON. An
 * unrelated incomplete global scan does not invalidate that scoped job lane.
 * Legacy complete-global-cache consumers retain their original admission. */
export function prepareNeighborhoodCoveredCadCacheHeaderV2(raw,source){
  const h=data(raw,['binding_sha256','source_metadata','definition_json','progress','status','completed_at']),
    p=data(h.progress,['format','binding_sha256','kind_index','after','layer_rows','typed_rows','typed_utf8_bytes']),
    binding=assessmentEvidenceDigest({source,profile:PROFILE});
  if(h.binding_sha256!==binding||json(h.source_metadata)!==json(source)||h.definition_json!==PROFILE.definition_blob.canonical_json
    ||p.format!=='shared_frozen_typed_CAD_progress_v1'||p.binding_sha256!==binding
    ||!Number.isInteger(p.kind_index)||p.kind_index<0||p.kind_index>2
    ||typeof p.after!=='string'||!p.after.isWellFormed()||Buffer.byteLength(p.after)>256||/[\u0000-\u001f\u007f]/.test(p.after)
    ||!Number.isInteger(p.layer_rows)||p.layer_rows<0||p.layer_rows>2_000_000
    ||(p.after==='')!==(p.layer_rows===0)||!count(p.typed_rows,4_000_000)||!count(p.typed_utf8_bytes,8_000_000_000)
    ||BigInt(p.typed_utf8_bytes)<BigInt(p.typed_rows)
    ||p.typed_rows==='0'&&p.typed_utf8_bytes!=='0'
    ||h.status!==(p.kind_index===2?'complete':'building')
    ||(h.status==='complete'?!TIME.test(h.completed_at??''):h.completed_at!==null))fail();
  const kinds=['primary','secondary'],scanned=kinds.slice(0,p.kind_index).reduce((n,k)=>n+Number(source.layer_counts[k].row_count),0)+p.layer_rows;
  if(String(scanned)!==p.typed_rows||p.kind_index<2&&p.layer_rows>Number(source.layer_counts[kinds[p.kind_index]].row_count)
    ||p.kind_index===2&&(p.after!==''||p.layer_rows!==0||p.typed_rows!==source.row_count))fail();
  return Object.freeze({...h,progress:Object.freeze(p)});
}
