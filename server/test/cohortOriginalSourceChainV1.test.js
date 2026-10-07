import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareNeighborhoodCohortBlob } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { createCohortOriginalSourceChainV1Store,COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS as KINDS,
  COHORT_ORIGINAL_SOURCE_CHAIN_V1_LIMITS as LIMITS } from '../src/services/neighborhoodAssessment/cohortOriginalSourceChainV1.js';

const sha=text=>createHash('sha256').update(text).digest('hex');
const original={generation_id:'11111111-1111-4111-8111-111111111111',source_snapshot:'fixture-only'},
  definition={geometry_input:{type:'Point',coordinates:[-96.5,32.5]},discovery:{kind:'radius',radius_metres:4828.032}};
const binding=Object.freeze({organization_id:'22222222-2222-4222-8222-222222222222',
  report_file_id:'33333333-3333-4333-8333-333333333333',assignment_file_id:'7',account_id:'SUBJECT',
  operation_id:'44444444-4444-4444-8444-444444444444',generation_id:original.generation_id,
  spatial_definition_sha256:sha(canonicalAssessmentJson(definition)),source_original_sha256:sha(canonicalAssessmentJson(original))});
/** Synthetic protocol data only; native fixture separately exercises real SQL originals. */
function page(kind,after,keys,end=true,payload='{"price":9007199254740993}'){
  return JSON.stringify({binding,page:{status:'source_closure_page',authority:'not_established',coverage:'page_only',
    original,spatial_definition:definition,spatial_definition_sha256:binding.spatial_definition_sha256,
    stock_population:{subject_included:true},source_scope:'all_dates_one_hop_seeded_only_from_original_stock_accounts',
    additional_cadastral_accounts:false,kind,after,next_cursor:keys.at(-1)??after,
    rows:keys.map(row_key=>({row_key,payload_text:payload})),end_of_layer:end,page_utf8_bytes:1000}});
}
function fixture(hook=()=>{}){
  const originals=new Map(),calls=[];
  const repository={async put(text){calls.push({kind:'put',text});await hook('put',text);
    const ref=prepareNeighborhoodCohortBlob(text);originals.set(ref.content_sha256,text);return ref;},
  async get(hash,bytes){calls.push({kind:'get',hash,bytes});await hook('get',hash);return originals.get(hash)??null;}};
  return {originals,calls,repository,store:()=>createCohortOriginalSourceChainV1Store(repository,binding)};
}
async function walk(f,root,kind,onPage=()=>{}){let position=null,count=0,pages=0,bytes=0;
  do{const r=await f.store().read({root,kind,position});
    assert.equal(r.authority,'not_established');assert.equal(r.coverage,'stored_pages_only');
    const body=JSON.parse(r.original_text);count+=body.page.rows.length;bytes+=Buffer.byteLength(r.original_text);pages++;
    await onPage(r,body);position=r.next_position;
    if(position===null){assert.equal(count,r.layer.row_count);assert.equal(pages,r.layer.page_count);assert.equal(bytes,r.layer.original_utf8_bytes);}
  }while(position!==null);return {count,pages,bytes};}

test('one small root retains all seven layers and exact text across independent store instances',async()=>{
  const f=fixture();let root=(await f.store().create()).root;
  for(const kind of KINDS){const keys=kind==='sync_runs'?['55555555-5555-4555-8555-555555555555']
    :kind==='accounts'?['SUBJECT']:kind==='sync_state'?['dcad_parcels']:['1','10'];
    const text=page(kind,'',keys);root=(await f.store().append({root,original_text:text})).root;
    await walk(f,root,kind,r=>assert.equal(r.original_text,text));
  }
  assert.ok(Number(root.canonical_utf8_bytes)<LIMITS.root_utf8_bytes);
  assert.equal(JSON.parse(f.originals.get(root.content_sha256)).layers.sync_runs.ended,true);
});

test('bounded prefix description reports metadata only and does not read source chunks or infer completeness',async()=>{
  const f=fixture();let root=(await f.store().create()).root;
  const empty=await f.store().describe(root);
  assert.equal(empty.layers.parcels.page_count,0);assert.equal(empty.layers.parcels.ended,false);
  root=(await f.store().append({root,original_text:page('parcels','',['1'],false)})).root;
  const from=f.calls.length,metadata=await f.store().describe(root);
  assert.equal(metadata.layers.parcels.row_count,1);assert.equal(metadata.layers.parcels.cursor,'1');
  assert.equal(metadata.layers.accounts.head,null);assert.equal(metadata.authority,'not_established');
  assert.equal(metadata.coverage,'stored_pages_only');assert.ok(Object.isFrozen(metadata.layers));
  assert.equal(f.calls.slice(from).length,1);assert.equal(f.calls.at(-1).hash,root.content_sha256);
  await assert.rejects(createCohortOriginalSourceChainV1Store(f.repository,{...binding,operation_id:binding.report_file_id}).describe(root),/binding_changed/);
});

test('60001 synthetic stock rows span 241 original pages, one checkpoint ref and constant-size layer heads',async()=>{
  const f=fixture();let root=(await f.store().create()).root;
  root=(await f.store().append({root,original_text:page('parcels','',[])})).root;
  let previous='',store=f.store(),count=0;
  for(let i=0;i<241;i++){
    if(i%24===0)store=f.store();const amount=Math.min(250,60001-count);
    const keys=Array.from({length:amount},(_,j)=>'A'+String(count+j).padStart(7,'0'));
    root=(await store.append({root,original_text:page('accounts',previous,keys,i===240)})).root;
    previous=keys.at(-1);count+=amount;assert.ok(Number(root.canonical_utf8_bytes)<16000);
  }
  assert.deepEqual(await walk(f,root,'accounts').then(({count,pages})=>({count,pages})),{count:60001,pages:241});
  assert.ok(f.calls.filter(c=>c.kind==='put').every(c=>Buffer.byteLength(c.text)<1_500_000));
  assert.equal(Object.keys(JSON.parse(f.originals.get(root.content_sha256)).layers).length,7);
});

test('large heavily escaped original page remains byte exact behind a small immutable chain root',async()=>{
  const f=fixture(),text=page('parcels','',['1'],true,'{"legal":"'+'\\\\'.repeat(480000)+'"}');
  assert.ok(Buffer.byteLength(text)>1_500_000);let root=(await f.store().create()).root;
  root=(await f.store().append({root,original_text:text})).root;
  await walk(f,root,'parcels',r=>assert.equal(r.original_text,text));
  assert.ok(Number(root.canonical_utf8_bytes)<16000);
});

test('lost final acknowledgment can replay exact old prefix without accepting a different next page',async()=>{
  const f=fixture(),initial=(await f.store().create()).root,text=page('parcels','',['1'],false);
  const once=(await f.store().append({root:initial,original_text:text})).root;
  const replay=(await f.store().append({root:initial,original_text:text})).root;assert.deepEqual(once,replay);
  await assert.rejects(f.store().append({root:once,original_text:text}),/page_order/);
  const next=(await f.store().append({root:once,original_text:page('parcels','1',['2'])})).root;
  assert.equal((await walk(f,next,'parcels')).count,2);
});

test('wrong layer, gaps, duplicate/native-key order and malformed scope reject without new storage',async()=>{
  const f=fixture(),root=(await f.store().create()).root,before=f.calls.filter(c=>c.kind==='put').length;
  for(const text of [page('accounts','',['A']),page('parcels','1',['2']),page('parcels','',['10','2']),
    page('parcels','',['1','1']),page('parcels','',[],false)])
    await assert.rejects(f.store().append({root,original_text:text}),/page_order|invalid_original/);
  const changed=JSON.parse(page('parcels','',['1']));changed.binding.report_file_id=binding.organization_id;
  await assert.rejects(f.store().append({root,original_text:JSON.stringify(changed)}),/binding_changed/);
  changed.binding=binding;changed.page.original.source_snapshot='changed';
  await assert.rejects(f.store().append({root,original_text:JSON.stringify(changed)}),/invalid_original/);
  assert.equal(f.calls.filter(c=>c.kind==='put').length,before);
});

test('late missing node or source chunk cannot be reported as a completed smaller layer',async()=>{
  for(const target of ['node','chunk']){
    const f=fixture();let root=(await f.store().create()).root;
    root=(await f.store().append({root,original_text:page('parcels','',['1'],false)})).root;
    root=(await f.store().append({root,original_text:page('parcels','1',['2'])})).root;
    const first=await f.store().read({root,kind:'parcels',position:null}),previous=first.next_position;
    const node=JSON.parse(f.originals.get(previous.node.content_sha256));
    const manifest=JSON.parse(f.originals.get(node.original.content_sha256));
    f.originals.delete(target==='node'?previous.node.content_sha256:manifest.chunks[0].reference.content_sha256);
    await assert.rejects(f.store().read({root,kind:'parcels',position:previous}),/missing_original/);
    assert.equal(first.layer.row_count,2,'head still declares the complete stored count, never a shortened success');
  }
});

test('forged root counts/node binding/page bytes refuse on independent reopening',async()=>{
  for(const target of ['root','node','text']){
    const f=fixture();let root=(await f.store().create()).root;
    root=(await f.store().append({root,original_text:page('parcels','',['1'])})).root;
    const header=JSON.parse(f.originals.get(root.content_sha256)),head=header.layers.parcels.head;
    if(target==='root'){header.layers.parcels.page_count=2;root=await f.repository.put(canonicalAssessmentJson(header));}
    else if(target==='node'){const node=JSON.parse(f.originals.get(head.content_sha256));node.binding_sha256='f'.repeat(64);
      header.layers.parcels.head=await f.repository.put(canonicalAssessmentJson(node));root=await f.repository.put(canonicalAssessmentJson(header));}
    else f.originals.set(head.content_sha256,'{}');
    await assert.rejects(f.store().read({root,kind:'parcels',position:null}),/node_corrupt|storage_conflict/);
  }
});

test('new binding and cross-scope references never become authority; malformed inputs execute no getters',async()=>{
  const f=fixture(),root=(await f.store().create()).root;
  const other=createCohortOriginalSourceChainV1Store(f.repository,{...binding,operation_id:binding.organization_id});
  await assert.rejects(other.read({root,kind:'parcels',position:null}),/binding_changed/);
  assert.throws(()=>createCohortOriginalSourceChainV1Store(f.repository,new Proxy(binding,{get(){throw Error('getter');}})),/invalid_input/);
  await assert.rejects(f.store().append({root,get original_text(){throw Error('getter');}}),/invalid_input/);
  assert.throws(()=>createCohortOriginalSourceChainV1Store(f.repository,binding,{override:true}),/invalid_input/);
  await assert.rejects(f.store().read({root,kind:'sales',position:null}),/empty_layer/);
});

test('cancellation, wrong storage ACK and pending settlement never deliver a root',async()=>{
  const controller=new AbortController(),f=fixture(kind=>{if(kind==='put')controller.abort();});
  await assert.rejects(createCohortOriginalSourceChainV1Store(f.repository,binding,{signal:controller.signal}).create(),/cancelled/);
  assert.equal(f.calls.length,1);
  const wrong=fixture();await assert.rejects(createCohortOriginalSourceChainV1Store({...wrong.repository,
    async put(text){const r=await wrong.repository.put(text);return {...r,content_sha256:'f'.repeat(64)};}},binding).create(),/storage_conflict/);
  let release,start;const waiting=new Promise(r=>{release=r;}),ready=new Promise(r=>{start=r;});
  const blocked=fixture(async kind=>{if(kind==='put'){start();await waiting;}}),store=blocked.store();
  const first=store.create();await ready;await assert.rejects(store.create(),/concurrent_operation/);release();await first;
});

test('caller mutation cannot change a continuation position while root I/O is pending',async()=>{
  const f=fixture();let root=(await f.store().create()).root;
  root=(await f.store().append({root,original_text:page('parcels','',['1'],false)})).root;
  root=(await f.store().append({root,original_text:page('parcels','1',['2'])})).root;
  const first=await f.store().read({root,kind:'parcels',position:null});
  const position={...first.next_position,node:{...first.next_position.node}};
  let release,start;const waiting=new Promise(r=>{release=r;}),ready=new Promise(r=>{start=r;});
  const store=createCohortOriginalSourceChainV1Store({...f.repository,async get(hash,size){start();await waiting;return f.repository.get(hash,size);}},binding);
  const pending=store.read({root,kind:'parcels',position});await ready;
  position.node.content_sha256='f'.repeat(64);position.index=999;position.next_cursor='999';release();
  assert.equal((await pending).index,0);
});

test('finite shared I/O budget does not reset on a new method call',async()=>{
  const f=fixture();let root=(await f.store().create()).root;
  root=(await f.store().append({root,original_text:page('parcels','',['1'],true,'{"x":"'+'x'.repeat(900000)+'"}') } )).root;
  const store=f.store();let failed=false;
  for(let i=0;i<50&&!failed;i++)try{await store.read({root,kind:'parcels',position:null});}
  catch(error){assert.match(error.message,/operation_limit/);failed=true;}
  assert.equal(failed,true);
});
