import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SELECTED_TRANSACTION_INDEX_V2_PARENT_KEYS as keys } from '../src/services/neighborhoodAssessment/cohortSelectedTransactionIndexFirstCandidateV2.js';
import { prepareCohortSelectedTransactionIndexPlanV2 as plan,prepareCohortSelectedTransactionIndexReceiptV2 as receipt,
  buildCohortSelectedTransactionIndexReceiptV2 as build } from '../src/services/neighborhoodAssessment/cohortSelectedTransactionIndexReceiptV2.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
  roots=Object.fromEntries(keys.map((k,i)=>[k,ref(i+1)])),zero={selected_ordinal:0,source_record_keys:0,legacy_sale_keys:0,done:false},
  member={account_id:'A',ordinal:1,partition_ordinal:1,entry_reference:ref(1),metric_row_reference:ref(2),contribution_row_reference:ref(3)},
  raw={generation_id:id(1),selected_stock_count:2,before:zero,selected_entry:member,anchor_count:2,
    native_packages:[{kind:'source_record',native_key:'501',first_selected_ordinal:null}]},
  options={command_id:id(2),...roots,plan:raw,previous:null},
  expected={command_id:id(2),...roots,generation_id:id(1),selected_stock_count:2};

test('receipt counts each source globally once but keeps repeated source in the next account exact plan',()=>{
  const first=build(options);assert.deepEqual(first.after,{selected_ordinal:1,source_record_keys:1,legacy_sale_keys:0,done:false});
  const secondPlan={...raw,before:first.after,selected_entry:{...member,account_id:'B',ordinal:2,partition_ordinal:2},anchor_count:5,
    native_packages:[{kind:'source_record',native_key:'501',first_selected_ordinal:1},
      ...['503','504'].map(native_key=>({kind:'source_record',native_key,first_selected_ordinal:null})),
      ...['10','3'].map(native_key=>({kind:'legacy_sale',native_key,first_selected_ordinal:null}))]},
    second=build({...options,plan:secondPlan,previous:ref(8)});
  assert.equal(plan(secondPlan).native_packages.length,5,'already registered whole package501 is not dropped');
  assert.equal(second.source_package_count,3);assert.equal(second.new_source_record_keys,2);assert.equal(second.new_legacy_sale_keys,2);
  assert.deepEqual(second.after,{selected_ordinal:2,source_record_keys:3,legacy_sale_keys:2,done:false});
  const emptyPlan={...secondPlan,before:second.after,selected_entry:null,anchor_count:0,native_packages:[]},
    done=build({...options,plan:emptyPlan,previous:ref(9)});
  assert.equal(done.sequence,3);assert.deepEqual(done.after,{...second.after,done:true});assert.equal(done.selected_entry,null);
  assert.equal(done.new_source_record_keys,0);assert.equal(done.new_legacy_sale_keys,0);
  assert.deepEqual(receipt(done,expected),done);assert.equal(done.native_packages,undefined);
  assert.ok(Object.isFrozen(done)&&Object.isFrozen(done.before)&&Object.isFrozen(done.after));
  assert.ok(Object.isFrozen(plan(secondPlan).native_packages)&&plan(secondPlan).native_packages.every(Object.isFrozen));
  assert.doesNotMatch(JSON.stringify(done),/price|sale_date|quarter|currency|transaction_id|source_payload|durable_index_issued/);
});

test('equal source and legacy identifiers remain separate; native BIGINT and legacy C-text ordering are nonvacuous and precision-safe',()=>{
  const p={...raw,anchor_count:6,native_packages:[...['2','10','9007199254740993','9223372036854775807'].map(native_key=>({kind:'source_record',native_key,first_selected_ordinal:null})),
    ...['10','2'].map(native_key=>({kind:'legacy_sale',native_key,first_selected_ordinal:null}))]},v=build({...options,plan:p});
  assert.equal(v.after.source_record_keys,4);assert.equal(v.after.legacy_sale_keys,2);
  for(const native_packages of [[p.native_packages[1],p.native_packages[0]],[p.native_packages[5],p.native_packages[4]],
    [p.native_packages[4],p.native_packages[0]],[p.native_packages[0],p.native_packages[0]]])assert.throws(()=>plan({...p,native_packages}));
  for(const native_key of [2,9007199254740993n,'01','0','1e3','1.0','-1','9223372036854775808'])
    assert.throws(()=>plan({...raw,native_packages:[{kind:'source_record',native_key,first_selected_ordinal:null}]}));
});

test('large bounded registry counters admit 500m namespaced keys without mistaking a 2m stock bound for a key bound',()=>{
  const before={selected_ordinal:1999999,source_record_keys:499999750,legacy_sale_keys:0,done:false},
    last={...raw,selected_stock_count:2000000,before,selected_entry:{...member,ordinal:2000000},anchor_count:250,
      native_packages:Array.from({length:250},(_,i)=>({kind:'source_record',native_key:String(i+1),first_selected_ordinal:null}))},
    nonempty=build({...options,plan:last,previous:ref(8)});
  assert.equal(nonempty.sequence,2000000);assert.equal(nonempty.after.source_record_keys,500000000);assert.equal(nonempty.after.done,false);
  const done=build({...options,plan:{...last,before:nonempty.after,selected_entry:null,anchor_count:0,native_packages:[]},previous:ref(9)});
  assert.equal(done.sequence,2000001);assert.equal(done.after.source_record_keys,500000000);assert.equal(done.after.done,true);
  assert.ok(Buffer.byteLength(JSON.stringify(nonempty))<4096,'even maximum per-account set is reference-only in the receipt');
  for(const patch of [{source_record_keys:500000001},{source_record_keys:499999751},{legacy_sale_keys:1},
    {source_record_keys:NaN},{source_record_keys:Infinity},{source_record_keys:'499999750'},{legacy_sale_keys:-0}])
    assert.throws(()=>plan({...last,before:{...before,...patch}}));
});

test('fresh EMPTY is explicit and cannot be inferred from a final nonempty member, a missing member, or an exhausted prefix counter',()=>{
  assert.equal(build({...options,plan:{...raw,selected_stock_count:1}}).after.done,false);
  assert.throws(()=>plan({...raw,selected_entry:null}));assert.throws(()=>plan({...raw,before:{...zero,selected_ordinal:2}}));
  const empty={...raw,selected_stock_count:0,selected_entry:null,anchor_count:0,native_packages:[]},v=build({...options,plan:empty});
  assert.deepEqual(v.after,{...zero,done:true});assert.equal(v.sequence,1);
  for(const patch of [{anchor_count:1},{native_packages:raw.native_packages},{before:{...zero,done:true}}])assert.throws(()=>plan({...empty,...patch}));
  const r=build(options);for(const after of [{...r.after,done:true},{...r.after,selected_ordinal:0},{...r.after,source_record_keys:2}])
    assert.throws(()=>receipt({...r,after},expected));
});

test('first-seen registry ordinals are bounded prior ordinals, not caller-chosen current/future values or count surrogates',()=>{
  for(const first_selected_ordinal of [0,1,2,'1',-1,NaN,Infinity])assert.throws(()=>plan({...raw,
    native_packages:[{...raw.native_packages[0],first_selected_ordinal}]}));
  const before={selected_ordinal:1,source_record_keys:1,legacy_sale_keys:0,done:false},next={...raw,before,selected_entry:{...member,ordinal:2},
    native_packages:[{...raw.native_packages[0],first_selected_ordinal:1}]};
  assert.equal(build({...options,plan:next,previous:ref(8)}).new_source_record_keys,0);
  assert.throws(()=>plan({...next,before:{...before,source_record_keys:0}}));
  assert.throws(()=>plan({...next,native_packages:[{...next.native_packages[0],kind:'legacy_sale'}]}));
  assert.throws(()=>build({...options,plan:next,previous:null}));assert.throws(()=>build({...options,previous:ref(8)}));
});

test('receipt closes parent/generation/command/count bindings and derives coherent bounded new-key deltas, never accepting retained payloads',()=>{
  const r=build(options);
  for(const patch of [{sequence:2},{previous:ref(8)},{command_id:id(3)},{generation_id:id(3)},{selected_stock_count:1},
    {semantic_reference:ref(8)},{association_anchor_count:251},{source_package_count:3},{new_source_record_keys:0},
    {new_source_record_keys:2},{legacy_package_count:1},{new_legacy_sale_keys:1},{format:'cohort_selected_transaction_index_first_candidate_v2'},
    {native_packages:raw.native_packages},{complete_original:true},{licensed:true},{callback:()=>assert.fail('callback')}])
    assert.throws(()=>receipt({...r,...patch},expected));
  for(const patch of [{ordinal:1},{before:zero},{sourceAuthority:true},{plan:{...raw,extra:true}},{previous:undefined}])assert.throws(()=>build({...options,...patch}));
  for(const patch of [{numeric_reference:{...ref(6),canonical_utf8_bytes:'4097'}},{union_reference:{...ref(1),canonical_utf8_bytes:'16001'}},
    {extra:true}])assert.throws(()=>receipt(r,{...expected,...patch}));
  assert.throws(()=>plan({...raw,selected_entry:{...member,entry_reference:{...ref(1),canonical_utf8_bytes:'1000001'}}}));
});

test('proxy/accessor/sparse/symbol/toJSON inputs fail closed without executing hostile DATA, and every public operation has exact arity',()=>{
  const hostile=()=>assert.fail('hostile DATA must not execute');
  const a=[...raw.native_packages];Object.defineProperty(a,'0',{enumerable:true,get:hostile});
  for(const p of [new Proxy(raw,{get:hostile}),{...raw,get before(){hostile();}},{...raw,before:{...zero,get done(){hostile();}}},
    {...raw,selected_entry:new Proxy(member,{get:hostile})},{...raw,selected_entry:{...member,entry_reference:{...ref(1),get content_sha256(){hostile();}}}},
    {...raw,native_packages:new Proxy(raw.native_packages,{get:hostile})},{...raw,native_packages:Array(1)},
    {...raw,native_packages:a},{...raw,native_packages:[{...raw.native_packages[0],get kind(){hostile();}}]},
    {...raw,native_packages:Object.assign([...raw.native_packages],{toJSON:hostile})},{...raw,[Symbol('x')]:1}])assert.throws(()=>plan(p));
  const r=build(options);assert.throws(()=>receipt({...r,before:{...zero,toJSON:hostile}},expected));
  assert.throws(()=>build(new Proxy(options,{get:hostile})));assert.throws(()=>receipt(r,new Proxy(expected,{get:hostile})));
  for(const f of [plan,build]){assert.throws(()=>f());assert.throws(()=>f(undefined));assert.throws(()=>f(f===plan?raw:options,undefined));}
  assert.throws(()=>receipt(r));assert.throws(()=>receipt(r,expected,undefined));
});

test('owner WIP codec is not imported by an active or existing original owner and does not remove the unintegrated native COMMIT guard',()=>{
  const capture=readFileSync(new URL('../src/services/neighborhoodAssessment/customCohortContextCapture.js',import.meta.url),'utf8'),
    sql=readFileSync(new URL('../migrations/20261205_custom_cohort_selected_transaction_index_v2.sql',import.meta.url),'utf8'),
    codec=readFileSync(new URL('../src/services/neighborhoodAssessment/cohortSelectedTransactionIndexReceiptV2.js',import.meta.url),'utf8');
  assert.doesNotMatch(capture,/cohortSelectedTransactionIndexReceiptV2/);
  assert.match(sql,/RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_owner_unintegrated'/);
  assert.doesNotMatch(codec,/\.query\(|\.put\(|yieldIssued\(|saveCheckpoint\(|\.advance\(/);
  assert.match(codec,/DATA validation is not an issued index/);
});
