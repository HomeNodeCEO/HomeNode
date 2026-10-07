import { types } from 'node:util';
import { canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS as KINDS,
  COHORT_ORIGINAL_SOURCE_CHAIN_V1_LIMITS as LIMITS } from './cohortOriginalSourceChainV1.js';

const FORMAT='cohort_original_source_graph_progress_v1';
function fail(reason){throw new TypeError(`cohort_original_source_graph_v1_${reason}`);}
function data(value,keys){
  if(!value||types.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(ds);
  if(names.length!==keys.length||!keys.every(k=>names.includes(k)&&ds[k].enumerable&&Object.hasOwn(ds[k],'value')))
    fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function ref(value){const r=data(value,['content_sha256','canonical_utf8_bytes']);
  return prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);}
const same=(a,b)=>canonicalAssessmentJson(a)===canonicalAssessmentJson(b);
const integer=(n,max)=>Number.isSafeInteger(n)&&n>=0&&n<=max;
function progressOf(raw,root){
  const p=raw===null?{format:FORMAT,root,kind_index:0,position:null,page_count:0,row_count:0,original_utf8_bytes:0}
    :data(raw,['format','root','kind_index','position','page_count','row_count','original_utf8_bytes']);
  if(p.format!==FORMAT||!same(ref(p.root),root)||!integer(p.kind_index,KINDS.length)
    ||!integer(p.page_count,LIMITS.pages)||!integer(p.row_count,LIMITS.layer_rows)
    ||!integer(p.original_utf8_bytes,LIMITS.original_utf8_bytes))fail('invalid_progress');
  let position=null;
  if(p.position!==null){const v=data(p.position,['node','index','next_cursor']);
    if(!integer(v.index,LIMITS.pages)||typeof v.next_cursor!=='string'||Buffer.byteLength(v.next_cursor)>256)
      fail('invalid_progress');
    position={node:ref(v.node),index:v.index,next_cursor:v.next_cursor};
  }else if(p.page_count!==0||p.row_count!==0||p.original_utf8_bytes!==0)fail('invalid_progress');
  if(p.kind_index===KINDS.length&&position!==null)fail('invalid_progress');
  // Detach the small continuation before any asynchronous source/storage I/O.
  return JSON.parse(canonicalAssessmentJson({...p,root,position}));
}
/** Compare exact provider representation, never parse or round payload decimals.
 * Only bounded metadata uses the unchanged canonical JSON profile. A heavily
 * escaped original page may exceed that profile; each payload stays a string. */
function comparePage(stored,expected){
  const {rows:storedRows,...storedMetadata}=stored,{rows:expectedRows,...expectedMetadata}=expected;
  if(!same(storedMetadata,expectedMetadata)||!Array.isArray(expectedRows)||storedRows.length!==expectedRows.length)
    fail('original_page_changed');
  for(let index=0;index<storedRows.length;index++){
    const left=data(storedRows[index],['row_key','payload_text']),right=data(expectedRows[index],['row_key','payload_text']);
    if(left.row_key!==right.row_key||left.payload_text!==right.payload_text)fail('original_page_changed');
  }
}
/** ONE bounded independently reopened graph step. The actual capture owner must
 * load progress ONLY from its scoped fenced checkpoint and commit the next
 * progress in the same current-authorized transaction. Initial traversal starts
 * at each actual root head, follows every returned edge, and checks full layer
 * page/row/byte counts. Each page is independently reproduced from the fixed
 * original SQL closure, not accepted solely because a node/end marker exists.
 * This is representation verification DATA, NOT a source grant, typed identity
 * closure, geographic-stock verification, acquisition receipt or report coverage.
 * The separate exact stock includes unassociated geometry absent from this
 * selected-account source graph; no outside account part becomes geographic stock.
 */
export async function verifyCohortOriginalSourceGraphStep(raw){
  const {chain,readSourcePage,root:rawRoot,progress:rawProgress,checkBudget}=data(raw,
    ['chain','readSourcePage','root','progress','checkBudget']);
  if(typeof chain?.describe!=='function'||typeof chain?.read!=='function'
    ||typeof readSourcePage!=='function'||typeof checkBudget!=='function')fail('invalid_input');
  const root=ref(rawRoot),progress=progressOf(rawProgress,root);
  checkBudget();const prefix=await chain.describe(root);checkBudget();
  if(!KINDS.every(kind=>prefix.layers[kind].ended))fail('unfinished_original_graph');
  const output=(next,advanced)=>Object.freeze({status:'original_graph_progress',authority:'not_established',
    coverage:'representation_only',progress:Object.freeze(next),advanced,
    verified_layer_count:next.kind_index,all_layers_verified:next.kind_index===KINDS.length});
  if(progress.kind_index===KINDS.length)return output(progress,false);
  const kind=KINDS[progress.kind_index],layer=prefix.layers[kind];
  if(progress.position!==null&&(progress.page_count!==layer.page_count-1-progress.position.index
    ||progress.page_count<1||progress.row_count>layer.row_count||progress.original_utf8_bytes>=layer.original_utf8_bytes))
    fail('invalid_progress');
  const step=await chain.read({root,kind,position:progress.position});checkBudget();
  if(step.index!==layer.page_count-1-progress.page_count||!same(step.layer,layer))fail('graph_changed');
  // The chain has independently checked binding/hash/chunks/native key order.
  // JSON.parse sees the page wrapper only; payload_text is not reinterpreted.
  const original=JSON.parse(step.original_text).page;
  const expected=await readSourcePage({kind,cursor:original.after,rowLimit:250});checkBudget();
  comparePage(original,expected);
  const counts={page_count:progress.page_count+1,row_count:progress.row_count+original.rows.length,
    original_utf8_bytes:progress.original_utf8_bytes+Buffer.byteLength(step.original_text)};
  if(counts.page_count>layer.page_count||counts.row_count>layer.row_count
    ||counts.original_utf8_bytes>layer.original_utf8_bytes)fail('graph_count_mismatch');
  let next;
  if(step.next_position===null){
    if(!same(counts,{page_count:layer.page_count,row_count:layer.row_count,original_utf8_bytes:layer.original_utf8_bytes}))
      fail('graph_count_mismatch');
    next={format:FORMAT,root,kind_index:progress.kind_index+1,position:null,page_count:0,row_count:0,original_utf8_bytes:0};
  }else next={...progress,position:step.next_position,...counts};
  if(!same((await chain.describe(root)).layers,prefix.layers))fail('graph_changed');
  checkBudget();return output(progressOf(next,root),true);
}
