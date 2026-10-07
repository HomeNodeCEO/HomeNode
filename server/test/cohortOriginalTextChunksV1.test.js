import assert from 'node:assert/strict';
import test from 'node:test';
import { createCohortOriginalTextChunksV1Store,COHORT_ORIGINAL_TEXT_CHUNKS_V1_LIMITS as LIMITS }
  from '../src/services/neighborhoodAssessment/cohortOriginalTextChunksV1.js';
import { prepareNeighborhoodCohortBlob } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';

/** Recording protocol fixture; native integration separately exercises SQL storage. */
function fixture(hook=()=>{}){
  const originals=new Map(),calls=[];
  const repository={async put(text){calls.push({kind:'put',text});await hook('put',text);
    const reference=prepareNeighborhoodCohortBlob(text);originals.set(reference.content_sha256,text);return reference;},
  async get(hash,bytes){calls.push({kind:'get',hash,bytes});await hook('get',hash);
    return originals.get(hash)??null;}};
  return {originals,calls,repository,store:createCohortOriginalTextChunksV1Store(repository)};
}

test('heavy escaping retains exact decimal literals using unchanged bounded canonical blobs',async()=>{
  const f=fixture(),text='{"price":9007199254740993,"legal":"'+'\\\\'.repeat(480000)+'","unicode":"😀é"}';
  assert.ok(Buffer.byteLength(JSON.stringify({text}))>1_500_000);
  const retained=await f.store.put(text);
  assert.equal(retained.authority,'not_established');assert.equal(retained.coverage,'one_original_text');
  assert.ok(retained.chunk_count>1&&retained.chunk_count<=LIMITS.chunks);
  assert.ok(f.calls.every(call=>Buffer.byteLength(call.text)<=1_500_000));
  const reopened=await createCohortOriginalTextChunksV1Store(f.repository).get(retained.manifest);
  assert.equal(reopened.text,text);assert.match(reopened.text,/9007199254740993/);
  assert.equal(reopened.original_sha256,retained.original_sha256);
  assert.equal(reopened.original_utf8_bytes,String(Buffer.byteLength(text)));
  assert.equal(reopened.authority,'not_established');assert.equal(reopened.coverage,'one_original_text');
  assert.ok(Object.isFrozen(reopened)&&Object.isFrozen(retained.manifest));
});

test('UTF-8 chunk boundaries never replace or split astral/multibyte characters',async()=>{
  const f=fixture(),text='a'.repeat(LIMITS.chunk_utf8_bytes-1)+'😀é漢字'+'b'.repeat(20);
  const retained=await f.store.put(text),manifest=JSON.parse(f.originals.get(retained.manifest.content_sha256));
  assert.equal(manifest.chunks[0].original_utf8_bytes,String(LIMITS.chunk_utf8_bytes-1));
  assert.equal((await f.store.get(retained.manifest)).text,text);
  for(const item of manifest.chunks){const chunk=JSON.parse(f.originals.get(item.reference.content_sha256));
    assert.equal(chunk.text.isWellFormed(),true);assert.ok(Buffer.byteLength(chunk.text)<=LIMITS.chunk_utf8_bytes);}
});

test('worst-case six-byte JSON control escaping still fits each legacy blob',async()=>{
  const f=fixture(),text='\u0001'.repeat(LIMITS.chunk_utf8_bytes)+'\u0002';
  const retained=await f.store.put(text);
  assert.equal(retained.chunk_count,2);
  assert.ok(f.calls.every(call=>Buffer.byteLength(call.text)<1_500_000));
  assert.equal((await f.store.get(retained.manifest)).text,text);
});

test('full one-page text ceiling fits a finite manifest and legacy chunk references',async()=>{
  const f=fixture(),text='x'.repeat(LIMITS.original_utf8_bytes),retained=await f.store.put(text);
  assert.equal(retained.chunk_count,LIMITS.chunks);
  assert.equal((await f.store.get(retained.manifest)).text,text);
  assert.ok(f.calls.filter(x=>x.kind==='put').every(x=>Buffer.byteLength(x.text)<=1_500_000));
});

test('invalid text, proxy/accessor references and unknown options fail before storage',async()=>{
  const f=fixture();
  for(const text of ['',null,{},'\0','\ud800','x'.repeat(LIMITS.original_utf8_bytes+1)])
    await assert.rejects(f.store.put(text),/invalid_text/);
  await assert.rejects(f.store.get({content_sha256:'a'.repeat(64),get canonical_utf8_bytes(){throw Error('getter');}}),/invalid_input/);
  await assert.rejects(f.store.get(new Proxy({},{get(){throw Error('proxy');}})),/invalid_input/);
  assert.throws(()=>createCohortOriginalTextChunksV1Store(f.repository,{get checkBudget(){throw Error('getter');}}),/invalid_input/);
  assert.throws(()=>createCohortOriginalTextChunksV1Store(f.repository,{limit:9999999}),/invalid_input/);
  assert.equal(f.calls.length,0);
});

test('missing or altered late children never return partial original text',async()=>{
  for(const corrupt of ['missing','changed']){
    const f=fixture(),retained=await f.store.put('a'.repeat(700000));
    const manifest=JSON.parse(f.originals.get(retained.manifest.content_sha256)),last=manifest.chunks.at(-1).reference;
    if(corrupt==='missing')f.originals.delete(last.content_sha256);
    else f.originals.set(last.content_sha256,'{}');
    await assert.rejects(createCohortOriginalTextChunksV1Store(f.repository).get(retained.manifest),/missing_original|storage_conflict/);
    assert.ok(f.calls.filter(x=>x.kind==='get').some(x=>x.hash===last.content_sha256));
  }
});

test('forged manifest counts, order or original hash refuse after independent child reads',async()=>{
  for(const alter of [
    value=>({...value,original_utf8_bytes:'1'}),
    value=>({...value,chunks:value.chunks.toReversed()}),
    value=>({...value,original_sha256:'a'.repeat(64)}),
    value=>({...value,chunks:[...value.chunks,{...value.chunks[0],index:value.chunks.length}]}),
  ]){
    const f=fixture(),retained=await f.store.put('a'.repeat(600000));
    const original=JSON.parse(f.originals.get(retained.manifest.content_sha256));
    const forged=await f.repository.put(canonicalAssessmentJson(alter(original)));
    await assert.rejects(f.store.get(forged),/invalid_manifest|storage_conflict/);
  }
});

test('wrong storage acknowledgment or read failure remains a failure, not a receipt',async()=>{
  const f=fixture();
  const wrong=createCohortOriginalTextChunksV1Store({...f.repository,
    async put(text){const ref=await f.repository.put(text);return {...ref,content_sha256:'a'.repeat(64)};}});
  await assert.rejects(wrong.put('abc'),/storage_conflict/);
  const failed=fixture(kind=>{if(kind==='get')throw Error('synthetic read ACK lost');});
  const retained=await failed.store.put('abc');await assert.rejects(failed.store.get(retained.manifest),/ACK lost/);
});

test('cancellation and serial settlement hold while repository work is pending',async()=>{
  let release,start;const waiting=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{start=resolve;});
  const f=fixture(async kind=>{if(kind==='put'){start();await waiting;}});
  const first=f.store.put('abc');await ready;
  await assert.rejects(f.store.put('xyz'),/concurrent_operation/);release();await first;
  const controller=new AbortController(),cancelled=fixture(kind=>{if(kind==='put')controller.abort();});
  await assert.rejects(createCohortOriginalTextChunksV1Store(cancelled.repository,{signal:controller.signal}).put('abc'),/cancelled/);
  assert.equal(cancelled.calls.length,1,'ending cancellation prevents a manifest/delivered receipt');
  const never=fixture(),aborted=new AbortController();aborted.abort();
  await assert.rejects(createCohortOriginalTextChunksV1Store(never.repository,{signal:aborted.signal}).put('abc'),/cancelled/);
  assert.equal(never.calls.length,0);
});

test('finite query and encoded-I/O budgets span repeated operations',async()=>{
  const f=fixture(),retained=await f.store.put('abc');
  for(let i=0;i<(LIMITS.queries-2)/2;i++)await f.store.get(retained.manifest);
  const before=f.calls.length;
  await assert.rejects(f.store.get(retained.manifest),/operation_limit/);assert.equal(f.calls.length,before);
  const large=fixture();let refusal=false;
  for(let i=0;i<10&&!refusal;i++)try{await large.store.put('\\'.repeat(3_000_000));}
  catch(error){assert.match(error.message,/operation_limit/);refusal=true;}
  assert.equal(refusal,true);
});
