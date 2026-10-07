import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { createCohortOriginalTextChunksV1Store } from './cohortOriginalTextChunksV1.js';

export const COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS=Object.freeze([
  'parcels','accounts','source_records','sales','sale_links','sync_state','sync_runs',
]);
export const COHORT_ORIGINAL_SOURCE_CHAIN_V1_LIMITS=Object.freeze({
  pages:200_000,rows:14_000_000,layer_rows:2_000_000,original_utf8_bytes:8_000_000_000,
  root_utf8_bytes:16_000,node_utf8_bytes:4_000,queries:1024,io_utf8_bytes:32_000_000,operation_ms:60_000,
});
const FORMAT='cohort_original_source_chain_v1',HASH=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const KINDS=COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS,LIMITS=COHORT_ORIGINAL_SOURCE_CHAIN_V1_LIMITS;
const digest=text=>createHash('sha256').update(text,'utf8').digest('hex');
function fail(reason){throw new TypeError(`cohort_original_source_chain_v1_${reason}`);}
/** Closed metadata only; never execute getters or caller proxies. */
function data(value,keys){
  if(!value||types.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(ds);
  if(names.length!==keys.length||!keys.every(k=>names.includes(k)&&ds[k].enumerable&&Object.hasOwn(ds[k],'value')))
    fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function ref(value){const r=data(value,['content_sha256','canonical_utf8_bytes']);
  try{return prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);}catch{fail('invalid_reference');}}
function integer(n,max){return Number.isSafeInteger(n)&&n>=0&&n<=max;}
function bindingOf(raw){
  const b=data(raw,['organization_id','report_file_id','assignment_file_id','account_id','operation_id',
    'generation_id','spatial_definition_sha256','source_original_sha256']);
  if(!['organization_id','report_file_id','operation_id','generation_id'].every(k=>typeof b[k]==='string'&&UUID.test(b[k]))
    ||typeof b.assignment_file_id!=='string'||! /^[1-9][0-9]{0,18}$/.test(b.assignment_file_id)
    ||BigInt(b.assignment_file_id)>9223372036854775807n||typeof b.account_id!=='string'
    ||!b.account_id||b.account_id.length>64||!b.account_id.isWellFormed()||b.account_id.trim()!==b.account_id
    ||/[\u0000-\u001f\u007f]/.test(b.account_id)
    ||!['spatial_definition_sha256','source_original_sha256'].every(k=>typeof b[k]==='string'&&HASH.test(b[k])))fail('invalid_binding');
  return Object.freeze(b);
}
function cursor(value,kind){
  if(typeof value!=='string'||!value.isWellFormed()||Buffer.byteLength(value)>256||value.includes('\0'))fail('invalid_cursor');
  if(value&&['parcels','source_records','sales','sale_links'].includes(kind)
    &&(!/^-?(?:0|[1-9][0-9]{0,18})$/.test(value)||BigInt(value)<-9223372036854775808n
      ||BigInt(value)>9223372036854775807n))fail('invalid_cursor');
  if(value&&kind==='sync_runs'&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))fail('invalid_cursor');
  return value;
}
function advances(a,b,kind){return a!==''&&(b===''||(['parcels','source_records','sales','sale_links'].includes(kind)
  ?BigInt(a)>BigInt(b):Buffer.compare(Buffer.from(a),Buffer.from(b))>0));}
function layerOf(raw,kind){
  const l=data(raw,['head','page_count','row_count','original_utf8_bytes','cursor','ended']);
  if(!integer(l.page_count,LIMITS.pages)||!integer(l.row_count,LIMITS.layer_rows)
    ||!integer(l.original_utf8_bytes,LIMITS.original_utf8_bytes)||typeof l.ended!=='boolean')fail('invalid_root');
  cursor(l.cursor,kind);
  if(l.page_count===0){if(l.head!==null||l.row_count!==0||l.original_utf8_bytes!==0||l.cursor!==''||l.ended)fail('invalid_root');}
  else if(l.head===null||l.original_utf8_bytes<1||l.row_count===0&&(!l.ended||l.cursor!==''||l.page_count!==1))fail('invalid_root');
  return Object.freeze({...l,head:l.head===null?null:ref(l.head)});
}
function rootOf(raw,bindingJson){
  const r=data(raw,['format','binding','layers']);
  if(r.format!==FORMAT||canonicalAssessmentJson(bindingOf(r.binding))!==bindingJson)fail('binding_changed');
  const ls=data(r.layers,KINDS),layers={};let pages=0,rows=0,bytes=0,unfinished=false;
  for(const kind of KINDS){const l=layerOf(ls[kind],kind);
    if(unfinished&&l.page_count!==0)fail('invalid_root');unfinished||=!l.ended;
    pages+=l.page_count;rows+=l.row_count;bytes+=l.original_utf8_bytes;layers[kind]=l;}
  if(pages>LIMITS.pages||rows>LIMITS.rows||bytes>LIMITS.original_utf8_bytes)fail('graph_limit');
  return Object.freeze({format:FORMAT,binding:bindingOf(r.binding),layers:Object.freeze(layers)});
}
/** Validate only the stored page protocol; provider/query completeness and
 * current rights must still be established independently by the capture owner.
 * Payload text stays opaque, including exact decimals and original geometry.
 */
function pageOf(text,bindingJson,binding){
  if(typeof text!=='string'||!text.isWellFormed()||Buffer.byteLength(text)>4_000_000)fail('invalid_original');
  let raw;try{raw=JSON.parse(text);}catch{fail('invalid_original');}
  const body=data(raw,['binding','page']);
  if(canonicalAssessmentJson(bindingOf(body.binding))!==bindingJson)fail('binding_changed');
  const p=data(body.page,['status','authority','coverage','original','spatial_definition','spatial_definition_sha256',
    'stock_population','source_scope','additional_cadastral_accounts','kind','after','next_cursor','rows','end_of_layer','page_utf8_bytes']);
  if(p.status!=='source_closure_page'||p.authority!=='not_established'||p.coverage!=='page_only'
    ||!KINDS.includes(p.kind)||p.additional_cadastral_accounts!==false
    ||p.source_scope!=='all_dates_one_hop_seeded_only_from_original_stock_accounts'
    ||p.original?.generation_id!==binding.generation_id
    ||digest(canonicalAssessmentJson(p.original))!==binding.source_original_sha256
    ||p.spatial_definition_sha256!==binding.spatial_definition_sha256
    ||digest(canonicalAssessmentJson(p.spatial_definition))!==binding.spatial_definition_sha256
    ||p.stock_population?.subject_included!==true||typeof p.end_of_layer!=='boolean'
    ||!integer(p.page_utf8_bytes,2_100_000)||p.page_utf8_bytes<2||!Array.isArray(p.rows)||p.rows.length>250)fail('invalid_original');
  let last=cursor(p.after,p.kind);
  for(const rawRow of p.rows){const row=data(rawRow,['row_key','payload_text']);
    cursor(row.row_key,p.kind);
    if(!advances(row.row_key,last,p.kind)||typeof row.payload_text!=='string'||Buffer.byteLength(row.payload_text)>1_000_000)
      fail('invalid_original');
    last=row.row_key;
  }
  if(cursor(p.next_cursor,p.kind)!==last||p.rows.length===0&&!p.end_of_layer)fail('invalid_original');
  return {page:p,row_count:p.rows.length,original_utf8_bytes:Buffer.byteLength(text),original_sha256:digest(text)};
}

/** Internal resumable ORIGINAL REPRESENTATION, not a source grant/acquisition
 * receipt. Seven small layer heads reference immutable reverse-ordered nodes;
 * the job checkpoint needs one root reference, never all page references.
 * Append only acknowledges the exact supplied next page. Root/node/end markers
 * and continuation positions are data, not proof that a provider layer or the
 * source identity closure is complete. The new authorized owner must acquire
 * real fenced pages, traverse from each root head without skipping any edge,
 * verify all original identities/counts/current rights, and stage/commit the
 * root and scoped live-claim checkpoint together. No transaction, pin release,
 * cleanup, source policy, route, old receipt or report mutation is owned here.
 */
export function createCohortOriginalSourceChainV1Store(repository,rawBinding,options={}){
  if(typeof repository?.put!=='function'||typeof repository?.get!=='function')fail('repository_required');
  const binding=bindingOf(rawBinding),bindingJson=canonicalAssessmentJson(binding),bindingSha=digest(bindingJson);
  if(!options||types.isProxy(options)||Object.getPrototypeOf(options)!==Object.prototype)fail('invalid_input');
  const keys=Reflect.ownKeys(options);if(keys.some(k=>!['signal','checkBudget'].includes(k)))fail('invalid_input');
  const opts=data(options,keys),signal=opts.signal,checkBudget=opts.checkBudget??(()=>{});
  if(signal!==undefined&&!(signal instanceof AbortSignal)||typeof checkBudget!=='function')fail('invalid_input');
  let busy=false,queries=0,bytes=0;const deadline=performance.now()+LIMITS.operation_ms;
  const check=()=>{if(signal?.aborted)fail('cancelled');checkBudget();if(signal?.aborted)fail('cancelled');
    if(performance.now()>=deadline)fail('deadline');};
  const charge=n=>{check();if(++queries>LIMITS.queries||(bytes+=n)>LIMITS.io_utf8_bytes)fail('operation_limit');};
  const bounded={async put(text){charge(Buffer.byteLength(text));const value=await repository.put(text);check();return value;},
    async get(hash,size){charge(Number(size));const value=await repository.get(hash,size);check();return value;}};
  const put=async(value,maximum)=>{const text=canonicalAssessmentJson(value);
    if(Buffer.byteLength(text)>maximum)fail('metadata_limit');const expected=prepareNeighborhoodCohortBlobReference(digest(text),String(Buffer.byteLength(text)));
    const actual=ref(await bounded.put(text));if(canonicalAssessmentJson(actual)!==canonicalAssessmentJson(expected))fail('storage_conflict');return actual;};
  const get=async(raw,maximum)=>{const expected=ref(raw);if(Number(expected.canonical_utf8_bytes)>maximum)fail('metadata_limit');
    const text=await bounded.get(expected.content_sha256,expected.canonical_utf8_bytes);
    if(text===null)fail('missing_original');
    if(typeof text!=='string'||Buffer.byteLength(text)!==Number(expected.canonical_utf8_bytes)||digest(text)!==expected.content_sha256)fail('storage_conflict');
    let value;try{value=JSON.parse(text);if(canonicalAssessmentJson(value)!==text)fail('storage_conflict');}catch{fail('storage_conflict');}return value;};
  const exclusive=async work=>{check();if(busy)fail('concurrent_operation');busy=true;try{return await work();}finally{busy=false;}};
  const output=(root,more={})=>Object.freeze({status:'source_prefix_data',authority:'not_established',coverage:'stored_pages_only',root,...more});
  return Object.freeze({
    /** Create an empty seven-layer original root, not a completed study. */
    create:()=>exclusive(async()=>{const layers=Object.fromEntries(KINDS.map(k=>[k,{head:null,page_count:0,row_count:0,
      original_utf8_bytes:0,cursor:'',ended:false}]));return output(await put(rootOf({format:FORMAT,binding,layers},bindingJson),LIMITS.root_utf8_bytes));}),
    /** Retain one exact next page and a small new immutable prefix root. */
    append:input=>exclusive(async()=>{
      const admitted=data(input,['root','original_text']),expected=ref(admitted.root),original=pageOf(admitted.original_text,bindingJson,binding);
      const root=rootOf(await get(expected,LIMITS.root_utf8_bytes),bindingJson),kind=original.page.kind;
      if(KINDS.find(k=>!root.layers[k].ended)!==kind||root.layers[kind].cursor!==original.page.after)fail('page_order');
      const old=root.layers[kind],layer={...old,page_count:old.page_count+1,row_count:old.row_count+original.row_count,
        original_utf8_bytes:old.original_utf8_bytes+original.original_utf8_bytes,cursor:original.page.next_cursor,ended:original.page.end_of_layer};
      // Check aggregate bounds BEFORE creating any new page/chunk originals.
      rootOf({...root,layers:{...root.layers,[kind]:{...layer,head:expected}}},bindingJson);
      const codec=createCohortOriginalTextChunksV1Store(bounded,{signal,checkBudget:check});
      const retained=await codec.put(admitted.original_text),reopened=await codec.get(retained.manifest);
      if(reopened.text!==admitted.original_text)fail('storage_conflict');
      const head=await put({format:FORMAT,binding_sha256:bindingSha,kind,index:old.page_count,previous:old.head,
        original:retained.manifest,after:original.page.after,next_cursor:original.page.next_cursor,
        row_count:original.row_count,end_of_layer:original.page.end_of_layer,original_utf8_bytes:original.original_utf8_bytes,
        original_sha256:original.original_sha256},LIMITS.node_utf8_bytes);
      return output(await put(rootOf({...root,layers:{...root.layers,[kind]:{...layer,head}}},bindingJson),LIMITS.root_utf8_bytes));
    }),
    /** Reopen one node/original. Start at position=null and follow EVERY returned
     * position to null; a caller-supplied position alone proves no root reachability.
     * Bounded steps permit new clients/transactions between worker checkpoints.
     */
    read:input=>exclusive(async()=>{
      const admitted=data(input,['root','kind','position']),rootRef=ref(admitted.root),kind=admitted.kind;
      if(!KINDS.includes(kind))fail('invalid_kind');
      const supplied=admitted.position===null?null:data(admitted.position,['node','index','next_cursor']);
      const detached=supplied===null?null:{node:ref(supplied.node),index:supplied.index,next_cursor:supplied.next_cursor};
      const root=rootOf(await get(rootRef,LIMITS.root_utf8_bytes),bindingJson),layer=root.layers[kind];
      if(layer.head===null)fail('empty_layer');
      const position=detached===null?{node:layer.head,index:layer.page_count-1,next_cursor:layer.cursor}:detached;
      if(!integer(position.index,layer.page_count-1))fail('invalid_position');cursor(position.next_cursor,kind);
      if(position.index===layer.page_count-1&&(canonicalAssessmentJson(ref(position.node))!==canonicalAssessmentJson(layer.head)
        ||position.next_cursor!==layer.cursor))fail('invalid_position');
      const node=data(await get(position.node,LIMITS.node_utf8_bytes),['format','binding_sha256','kind','index','previous',
        'original','after','next_cursor','row_count','end_of_layer','original_utf8_bytes','original_sha256']);
      if(node.format!==FORMAT||node.binding_sha256!==bindingSha||node.kind!==kind||node.index!==position.index
        ||node.next_cursor!==position.next_cursor||typeof node.end_of_layer!=='boolean'
        ||node.end_of_layer!==(node.index===layer.page_count-1&&layer.ended)
        ||node.index===0&&(node.previous!==null||node.after!=='')||node.index>0&&node.previous===null)fail('node_corrupt');
      const text=(await createCohortOriginalTextChunksV1Store(bounded,{signal,checkBudget:check}).get(node.original)).text;
      const original=pageOf(text,bindingJson,binding);
      if(original.page.kind!==kind||original.page.after!==node.after||original.page.next_cursor!==node.next_cursor
        ||original.row_count!==node.row_count||original.original_utf8_bytes!==node.original_utf8_bytes
        ||original.original_sha256!==node.original_sha256||original.page.end_of_layer!==node.end_of_layer)fail('node_corrupt');
      const next=node.previous===null?null:Object.freeze({node:ref(node.previous),index:node.index-1,next_cursor:node.after});
      check();return output(rootRef,{kind,layer,index:node.index,original_text:text,next_position:next});
    }),
  });
}
