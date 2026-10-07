import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareNeighborhoodCohortBlob } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { createCohortOriginalSourceChainV1Store,COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS as KINDS }
  from '../src/services/neighborhoodAssessment/cohortOriginalSourceChainV1.js';
import { verifyCohortOriginalSourceGraphStep as verify } from '../src/services/neighborhoodAssessment/cohortOriginalSourceGraphV1.js';

const sha=text=>createHash('sha256').update(text).digest('hex');
const original={generation_id:'11111111-1111-4111-8111-111111111111'},definition={fixture:'original-only'};
const binding={organization_id:'22222222-2222-4222-8222-222222222222',
  report_file_id:'33333333-3333-4333-8333-333333333333',assignment_file_id:'7',account_id:'SUBJECT',
  operation_id:'44444444-4444-4444-8444-444444444444',generation_id:original.generation_id,
  spatial_definition_sha256:sha(canonicalAssessmentJson(definition)),source_original_sha256:sha(canonicalAssessmentJson(original))};
function page(kind,after,keys,ended=true,payload='{"price":9007199254740993}'){
  return {status:'source_closure_page',authority:'not_established',coverage:'page_only',original,
    spatial_definition:definition,spatial_definition_sha256:binding.spatial_definition_sha256,
    stock_population:{subject_included:true},source_scope:'all_dates_one_hop_seeded_only_from_original_stock_accounts',
    additional_cadastral_accounts:false,kind,after,next_cursor:keys.at(-1)??after,
    rows:keys.map(row_key=>({row_key,payload_text:payload})),end_of_layer:ended,page_utf8_bytes:1000};
}
function fixture(){
  const blobs=new Map(),pages=new Map();let reads=0;
  const repository={async put(text){const ref=prepareNeighborhoodCohortBlob(text);blobs.set(ref.content_sha256,text);return ref;},
    async get(hash){return blobs.get(hash)??null;}};
  const chain=()=>createCohortOriginalSourceChainV1Store(repository,binding);
  const readSourcePage=async input=>{reads++;assert.equal(input.rowLimit,250);return pages.get(`${input.kind}:${input.cursor}`);};
  const append=async(root,p)=>{pages.set(`${p.kind}:${p.after}`,p);
    return (await chain().append({root,original_text:JSON.stringify({binding,page:p})})).root;};
  return {blobs,pages,repository,chain,readSourcePage,append,get reads(){return reads;},
    step:(root,progress=null)=>verify({chain:chain(),readSourcePage,root,progress,checkBudget(){}})};
}
async function small(f){let root=(await f.chain().create()).root;
  for(const kind of KINDS)root=await f.append(root,page(kind,'',kind==='parcels'?['1']:[]));return root;}

test('independent steps reopen every root head and all seven fixed originals, not a source grant',async()=>{
  const f=fixture(),root=await small(f);let progress=null,result;
  for(let i=0;i<7;i++){result=await f.step(root,progress);progress=result.progress;
    assert.equal(result.advanced,true);assert.equal(result.verified_layer_count,i+1);
    assert.equal(result.authority,'not_established');assert.equal(result.coverage,'representation_only');}
  assert.equal(result.all_layers_verified,true);assert.equal(f.reads,7);
  const replay=await f.step(root,progress);assert.equal(replay.advanced,false);assert.equal(f.reads,7);
  assert.ok(Buffer.byteLength(canonicalAssessmentJson(progress))<16000);
});

test('60001 synthetic originals verify through 241 root-linked pages and constant-size progress across fresh stores',async()=>{
  const f=fixture();let root=(await f.chain().create()).root,after='',rows=0;
  for(let i=0;i<241;i++){const keys=Array.from({length:Math.min(250,60001-rows)},(_,j)=>String(rows+j+1));
    root=await f.append(root,page('parcels',after,keys,i===240,'{"id":"exact"}'));rows+=keys.length;after=keys.at(-1);}
  for(const kind of KINDS.slice(1))root=await f.append(root,page(kind,'',[]));
  let progress=null,result;
  for(let i=0;i<247;i++){result=await f.step(root,progress);progress=result.progress;
    assert.ok(Buffer.byteLength(canonicalAssessmentJson(progress))<16000);
    if(i<240)assert.equal(result.verified_layer_count,0);}
  assert.equal(result.all_layers_verified,true);assert.equal(f.reads,247);
  assert.equal(rows,60001,'synthetic graph proof only; native full-population acquisition is still separate');
});

test('exact heavily escaped payload and unsafe integer text bypass no legacy JSON/blob size bound',async()=>{
  const f=fixture();let root=(await f.chain().create()).root;
  const text='{"legal":"'+'\\\\'.repeat(480000)+'","price":9007199254740993}';
  root=await f.append(root,page('parcels','',['1'],true,text));
  for(const kind of KINDS.slice(1))root=await f.append(root,page(kind,'',[]));
  const result=await f.step(root);assert.equal(result.verified_layer_count,1);
  assert.ok([...f.blobs.values()].every(value=>Buffer.byteLength(value)<1500000));
  f.pages.set('parcels:',page('parcels','',['1'],true,text.replace('9007199254740993','9007199254740992')));
  await assert.rejects(f.step(root),/original_page_changed/);
});

test('an exact full page requires its separately retained empty terminal page to verify coverage',async()=>{
  const f=fixture();let root=(await f.chain().create()).root;
  root=await f.append(root,page('parcels','',Array.from({length:250},(_,i)=>String(i+1)),false));
  root=await f.append(root,page('parcels','250',[]));
  for(const kind of KINDS.slice(1))root=await f.append(root,page(kind,'',[]));
  const first=await f.step(root);assert.equal(first.verified_layer_count,0);
  assert.equal(first.progress.page_count,1);assert.equal(first.progress.row_count,0);
  assert.equal((await f.step(root,first.progress)).verified_layer_count,1);assert.equal(f.reads,2);
});

test('missing or different provider rows, end markers and metadata cannot verify a valid content hash',async()=>{
  for(const change of ['row','key','end','metadata']){
    const f=fixture(),root=await small(f),expected=structuredClone(f.pages.get('parcels:'));
    if(change==='row')expected.rows=[];
    if(change==='key')expected.rows[0].row_key='2';
    if(change==='end')expected.end_of_layer=false;
    if(change==='metadata')expected.stock_population.extra=true;
    f.pages.set('parcels:',expected);await assert.rejects(f.step(root),/original_page_changed/);
  }
});

test('unfinished acquisition refuses before any provider validation query',async()=>{
  const f=fixture();let root=(await f.chain().create()).root;
  root=await f.append(root,page('parcels','',['1']));
  await assert.rejects(f.step(root),/unfinished_original_graph/);assert.equal(f.reads,0);
});

test('skipped continuation, another root and forged layer totals cannot become a smaller completed graph',async()=>{
  const f=fixture();let root=(await f.chain().create()).root;
  root=await f.append(root,page('parcels','',['1'],false));
  root=await f.append(root,page('parcels','1',['2'],false));
  root=await f.append(root,page('parcels','2',['3']));
  for(const kind of KINDS.slice(1))root=await f.append(root,page(kind,'',[]));
  const first=await f.step(root),progress=structuredClone(first.progress);progress.position.index=0;
  await assert.rejects(f.step(root,progress),/invalid_progress/);
  await assert.rejects(f.step({...root,content_sha256:'f'.repeat(64)},first.progress),/invalid_progress/);
  const header=JSON.parse(f.blobs.get(root.content_sha256));header.layers.parcels.row_count=4;
  const forged=await f.repository.put(canonicalAssessmentJson(header));let p=null;
  p=(await f.step(forged,p)).progress;p=(await f.step(forged,p)).progress;
  await assert.rejects(f.step(forged,p),/graph_count_mismatch/);
});

test('a missing tail cannot be ignored after the head was independently verified',async()=>{
  const f=fixture();let root=(await f.chain().create()).root;
  root=await f.append(root,page('parcels','',['1'],false));root=await f.append(root,page('parcels','1',['2']));
  for(const kind of KINDS.slice(1))root=await f.append(root,page(kind,'',[]));
  const first=await f.step(root);f.blobs.delete(first.progress.position.node.content_sha256);
  await assert.rejects(f.step(root,first.progress),/missing_original/);
});

test('malformed progress executes no getters and caller mutation cannot change its root edge during I/O',async()=>{
  const f=fixture(),root=await small(f);
  await assert.rejects(f.step(root,{get format(){throw Error('getter');}}),/invalid_input/);
  let multi=(await f.chain().create()).root;
  multi=await f.append(multi,page('parcels','',['1'],false));multi=await f.append(multi,page('parcels','1',['2']));
  for(const kind of KINDS.slice(1))multi=await f.append(multi,page(kind,'',[]));
  const progress=structuredClone((await f.step(multi)).progress);
  let release,started;const waiting=new Promise(r=>{release=r;}),ready=new Promise(r=>{started=r;});
  const actual=f.chain(),chain={...actual,async describe(ref){started();await waiting;return actual.describe(ref);}};
  const pending=verify({chain,root:multi,progress,readSourcePage:f.readSourcePage,checkBudget(){}});await ready;
  progress.position.index=999;progress.position.node.content_sha256='f'.repeat(64);release();
  assert.equal((await pending).verified_layer_count,1);
  await assert.rejects(verify({chain:f.chain(),root,progress:null,readSourcePage:f.readSourcePage,
    checkBudget(){throw Error('cancelled');}}),/cancelled/);
});
