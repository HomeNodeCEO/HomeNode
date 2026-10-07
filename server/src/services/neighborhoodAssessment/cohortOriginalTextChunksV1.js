import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';

export const COHORT_ORIGINAL_TEXT_CHUNKS_V1_LIMITS = Object.freeze({
  // Even six-byte JSON control escapes fit the unchanged 1.5-MB blob envelope.
  original_utf8_bytes:4_000_000,chunk_utf8_bytes:240_000,chunks:17,
  queries:96,io_utf8_bytes:32_000_000,operation_ms:60_000,
});
const FORMAT='cohort_original_text_chunks_v1';
const HASH=/^[a-f0-9]{64}$/;
const digest=text=>createHash('sha256').update(text,'utf8').digest('hex');
function fail(reason){throw new TypeError(`cohort_original_text_chunks_v1_${reason}`);}
/** Admit only own data fields; a reference never executes a caller getter. */
function data(value,keys){
  if(!value||types.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_input');
  const descriptors=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(descriptors);
  if(names.length!==keys.length||!keys.every(key=>names.includes(key)
    &&descriptors[key].enumerable&&Object.hasOwn(descriptors[key],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(key=>[key,descriptors[key].value]));
}
/** Detach a bounded legacy blob reference without relaxing its 1.5-MB limit. */
function reference(value){
  const item=data(value,['content_sha256','canonical_utf8_bytes']);
  try{return prepareNeighborhoodCohortBlobReference(item.content_sha256,item.canonical_utf8_bytes);}
  catch{fail('invalid_reference');}
}
function count(value,maximum){
  return typeof value==='string'&&/^[1-9][0-9]{0,6}$/.test(value)&&Number(value)<=maximum;
}
/** Check exact canonical wrapper bytes; the wrapped original is never parsed. */
function decode(text,expected){
  if(typeof text!=='string'||!text.isWellFormed()||String(Buffer.byteLength(text))!==expected.canonical_utf8_bytes
    ||digest(text)!==expected.content_sha256)fail('storage_conflict');
  let value;try{value=JSON.parse(text);
    if(canonicalAssessmentJson(value)!==text)fail('storage_conflict');
  }catch{fail('storage_conflict');}return value;
}
/** Validate the complete ordered chunk list, not just its supplied digest. */
function manifestOf(value){
  const item=data(value,['format','original_sha256','original_utf8_bytes','chunks']);
  const limits=COHORT_ORIGINAL_TEXT_CHUNKS_V1_LIMITS;
  if(item.format!==FORMAT||typeof item.original_sha256!=='string'||!HASH.test(item.original_sha256)
    ||!count(item.original_utf8_bytes,limits.original_utf8_bytes)||types.isProxy(item.chunks)
    ||!Array.isArray(item.chunks)||Object.getPrototypeOf(item.chunks)!==Array.prototype
    ||item.chunks.length<1||item.chunks.length>limits.chunks
    ||Reflect.ownKeys(item.chunks).length!==item.chunks.length+1)fail('invalid_manifest');
  let bytes=0;
  const chunks=[];
  for(let i=0;i<item.chunks.length;i++){
    const descriptor=Object.getOwnPropertyDescriptor(item.chunks,String(i));
    if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))fail('invalid_manifest');
    const chunk=data(descriptor.value,['index','original_utf8_bytes','reference']);
    if(chunk.index!==i||!count(chunk.original_utf8_bytes,limits.chunk_utf8_bytes))fail('invalid_manifest');
    bytes+=Number(chunk.original_utf8_bytes);
    chunks.push(Object.freeze({...chunk,reference:reference(chunk.reference)}));
  }
  if(String(bytes)!==item.original_utf8_bytes)fail('invalid_manifest');
  return Object.freeze({...item,chunks:Object.freeze(chunks)});
}

/** Representation-only retention for one bounded original text/page.
 * Bind the existing organization-scoped immutable blob repository inside the
 * caller's transaction. This codec neither authorizes source data nor proves a
 * page, complete capture, report scope, historical coverage or acquisition.
 * The current-authorized owner must wrap the exact scope/generation/definition
 * into the retained original, recheck those rights and the live claim at both
 * ends, and bind all complete layers before publishing or releasing a pin.
 * Every wrapper remains below the UNCHANGED legacy blob/scanner limits. Raw
 * text (including decimal literals and Unicode) is never parsed or rewritten.
 * A failure requires caller rollback and settled cleanup; no mount or commit.
 */
export function createCohortOriginalTextChunksV1Store(repository,options={}){
  if(typeof repository?.put!=='function'||typeof repository?.get!=='function')fail('repository_required');
  if(!options||types.isProxy(options)||Object.getPrototypeOf(options)!==Object.prototype)fail('invalid_input');
  const keys=Reflect.ownKeys(options);
  if(keys.some(key=>!['signal','checkBudget'].includes(key)))fail('invalid_input');
  const admitted=data(options,keys),signal=admitted.signal,checkBudget=admitted.checkBudget??(()=>{});
  if((signal!==undefined&&!(signal instanceof AbortSignal))||typeof checkBudget!=='function')fail('invalid_input');
  const limits=COHORT_ORIGINAL_TEXT_CHUNKS_V1_LIMITS,deadline=performance.now()+limits.operation_ms;
  let busy=false,queries=0,ioBytes=0;
  const check=()=>{if(signal?.aborted)fail('cancelled');checkBudget();if(signal?.aborted)fail('cancelled');
    if(performance.now()>=deadline)fail('deadline');};
  const charge=bytes=>{check();if(++queries>limits.queries||(ioBytes+=bytes)>limits.io_utf8_bytes)fail('operation_limit');};
  const put=async text=>{
    const expected=prepareNeighborhoodCohortBlobReference(digest(text),String(Buffer.byteLength(text)));
    charge(Number(expected.canonical_utf8_bytes));
    const actual=reference(await repository.put(text));check();
    if(actual.content_sha256!==expected.content_sha256||actual.canonical_utf8_bytes!==expected.canonical_utf8_bytes)fail('storage_conflict');
    return actual;
  };
  const get=async expected=>{charge(Number(expected.canonical_utf8_bytes));
    const text=await repository.get(expected.content_sha256,expected.canonical_utf8_bytes);check();
    if(text===null)fail('missing_original');return decode(text,expected);};
  return Object.freeze({
    /** Retain sequential UTF-8-safe chunks and their content-addressed manifest. */
    async put(originalText){
      if(typeof originalText!=='string'||!originalText.isWellFormed()||originalText.includes('\0'))fail('invalid_text');
      const bytes=Buffer.byteLength(originalText);
      if(bytes<1||bytes>limits.original_utf8_bytes)fail('invalid_text');
      check();if(busy)fail('concurrent_operation');busy=true;
      try{
        const original=Buffer.from(originalText,'utf8'),chunks=[];
        for(let start=0;start<original.length;){
          let end=Math.min(start+limits.chunk_utf8_bytes,original.length);
          // The next chunk must start at a UTF-8 code point, never a continuation.
          while(end<original.length&&(original[end]&0xc0)===0x80)end--;
          if(end<=start||chunks.length>=limits.chunks)fail('operation_limit');
          const text=original.subarray(start,end).toString('utf8'),index=chunks.length;
          const ref=await put(canonicalAssessmentJson({format:FORMAT,index,text}));
          chunks.push(Object.freeze({index,original_utf8_bytes:String(end-start),reference:ref}));start=end;
        }
        const manifest=manifestOf({format:FORMAT,original_sha256:digest(originalText),
          original_utf8_bytes:String(bytes),chunks});
        const ref=await put(canonicalAssessmentJson(manifest));check();
        return Object.freeze({status:'retained_text',authority:'not_established',coverage:'one_original_text',
          manifest:ref,original_sha256:manifest.original_sha256,original_utf8_bytes:manifest.original_utf8_bytes,
          chunk_count:manifest.chunks.length});
      }finally{busy=false;}
    },
    /** Independently reopen every child before delivering the exact one-page text. */
    async get(rawManifest){
      const expected=reference(rawManifest);check();if(busy)fail('concurrent_operation');busy=true;
      try{
        const manifest=manifestOf(await get(expected)),pieces=[];let bytes=0;
        for(const item of manifest.chunks){
          const chunk=data(await get(item.reference),['format','index','text']);
          if(chunk.format!==FORMAT||chunk.index!==item.index||typeof chunk.text!=='string'||!chunk.text.isWellFormed()
            ||chunk.text.includes('\0')||String(Buffer.byteLength(chunk.text))!==item.original_utf8_bytes)fail('storage_conflict');
          bytes+=Number(item.original_utf8_bytes);if(bytes>limits.original_utf8_bytes)fail('operation_limit');pieces.push(chunk.text);
        }
        const text=pieces.join('');
        if(String(Buffer.byteLength(text))!==manifest.original_utf8_bytes||digest(text)!==manifest.original_sha256)fail('storage_conflict');
        check();return Object.freeze({status:'original_text',authority:'not_established',coverage:'one_original_text',
          text,original_sha256:manifest.original_sha256,original_utf8_bytes:manifest.original_utf8_bytes});
      }finally{busy=false;}
    },
  });
}
