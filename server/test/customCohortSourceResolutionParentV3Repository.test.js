import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortSourceResolutionParentV3Repository as create } from '../src/services/neighborhoodAssessment/customCohortSourceResolutionParentV3Repository.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
  claim={operation_id:id(1),claim_token:id(2),attempts:5},scope={organization_id:id(3),report_file_id:id(4),assignment_file_id:'7',account_id:'SUBJECT'},
  row={operation_id:claim.operation_id,...scope,actor_user_id:id(5),request_sha256:'a'.repeat(64),command_id:id(6),generation_id:id(7),
    index_reference:ref(8),index_sequence:3,parent_checkpoint:{phase:'frozen_selected_transaction_index_refs_v2',evidence_refs:Array.from({length:17},()=>ref(8))},
    issued_claim_token:claim.claim_token,issued_attempts:claim.attempts,issued_transaction_id:'101'},copy=v=>structuredClone(v),
  first={operation_id:claim.operation_id,organization_id:scope.organization_id,generation_id:id(7),command_id:id(6),
    index_reference:ref(8),index_sequence:3,kind:'source_record',native_key:'501',first_selected_ordinal:2,
    selected_account_id:'SELECTED-B',partition_ordinal:2,entry_reference:ref(5),metric_row_reference:ref(6),
    contribution_row_reference:ref(7),issued_transaction_id:'101'};
function fixture({transactions=['101'],native=copy(row),inserted=copy(row),firstNative=copy(first),firstInserted=copy(first),raw}={}){
  let reads=0;const queries=[],client={async query(sql,values){queries.push({sql,values});
    if(sql.includes(':transaction */'))return {rowCount:1,rows:[{transaction_id:transactions[Math.min(reads++,transactions.length-1)]}]};
    return raw??{rowCount:1,rows:[sql.includes(':first-insert */')?firstInserted:sql.includes(':first-native */')?firstNative:
      sql.includes(':insert */')?inserted:native]};}},input={client,claim,scope,actorUserId:id(5)};
  return {repo:create(input),input,queries};
}
// Protocol checks only. The independent A/B PostgreSQL captures exercise the
// actual scope/claim predicates, native guard, rollback and real COMMIT refusal.
test('actual native parent is scoped and frozen; INSERT derives it again without caller row or conflict adoption',async()=>{
  const {repo,queries}=fixture(),p=await repo.insertActual17Parent();assert.deepEqual(p,row);
  assert.ok(Object.isFrozen(p)&&Object.isFrozen(p.parent_checkpoint.evidence_refs)&&Object.isFrozen(p.index_reference));
  const expected=[id(1),id(3),id(4),'7','SUBJECT',id(5),id(2),5];
  for(const q of queries.filter(q=>!q.sql.includes(':transaction */'))){assert.deepEqual(q.values,expected);
    assert.match(q.sql,/p\.issued_claim_token=\$7::uuid AND p\.issued_attempts=\$8::integer/);assert.doesNotMatch(q.sql,/ON CONFLICT|jsonb_populate_record|VALUES\s*\(/i);}
  assert.equal(queries.filter(q=>q.sql.includes(':insert */')).length,1);
});
test('autocommit or changing transaction refuses before any INSERT',async()=>{
  for(const transactions of [['101','102'],['101','101','102']]){
    const {repo,queries}=fixture({transactions});await assert.rejects(repo.insertActual17Parent(),/caller_transaction_required/);
    assert.ok(!queries.some(q=>q.sql.includes(':insert */')));
  }
});
test('wrong actual scope, claim, attempt, checkpoint, reference or executable native result refuses before INSERT',async()=>{
  for(const mutate of [r=>r.report_file_id=id(10),r=>r.assignment_file_id='8',r=>r.account_id='OTHER',r=>r.actor_user_id=id(10),
    r=>r.issued_claim_token=id(10),r=>r.issued_attempts=4,r=>r.issued_transaction_id='102',r=>r.generation_id='bad',
    r=>r.index_reference=ref(9),r=>r.parent_checkpoint.phase='frozen_selected_source_resolution_refs_v3',
    r=>r.parent_checkpoint.evidence_refs.push(ref(9)),r=>r.parent_checkpoint.evidence_refs.pop(),r=>r.extra=true]){
    const native=copy(row);mutate(native);const {repo,queries}=fixture({native});await assert.rejects(repo.insertActual17Parent());
    assert.ok(!queries.some(q=>q.sql.includes(':insert */')));
  }
  let touched=false;const native=copy(row);Object.defineProperty(native,'parent_checkpoint',{enumerable:true,get(){touched=true;throw Error('getter');}});
  await assert.rejects(fixture({native}).repo.insertActual17Parent());assert.equal(touched,false);
});
test('missing native binding does not INSERT; changed result or lost transaction after INSERT requires owner rollback',async()=>{
  for(const raw of [{rowCount:0,rows:[]},{rowCount:2,rows:[copy(row),copy(row)]}]){
    const {repo,queries}=fixture({raw});await assert.rejects(repo.insertActual17Parent(),/claim_or_actual17_parent_lost/);
    assert.ok(!queries.some(q=>q.sql.includes(':insert */')));
  }
  const changed=copy(row);changed.request_sha256='b'.repeat(64);
  await assert.rejects(fixture({inserted:changed}).repo.insertActual17Parent(),/native_parent_changed/);
  await assert.rejects(fixture({transactions:['101','101','101','102']}).repo.insertActual17Parent(),/caller_transaction_required/);
});
test('closed zero-argument API rejects caller checkpoint/cursor and hostile descriptors before SQL',async()=>{
  const {repo,queries,input}=fixture();await assert.rejects(repo.insertActual17Parent({checkpoint:row.parent_checkpoint}),/invalid_input/);assert.equal(queries.length,0);
  assert.throws(()=>create(input,{}));assert.throws(()=>create({...input,cursor:'501'}));assert.throws(()=>create(new Proxy(input,{})));
  let touched=false;const hostile={...input};Object.defineProperty(hostile,'claim',{enumerable:true,get(){touched=true;throw Error('getter');}});
  assert.throws(()=>create(hostile));assert.equal(touched,false);
  assert.throws(()=>create({...input,scope:{...scope,account_id:' SUBJECT'}}));
});

test('native FIRST insert derives source and selected member twice under full scope without caller plan or conflict adoption',async()=>{
  const {repo,queries}=fixture(),binding=await repo.insertActualFirstSourceBinding();assert.deepEqual(binding,first);
  assert.ok(Object.isFrozen(binding)&&Object.isFrozen(binding.entry_reference));
  const writes=queries.filter(q=>q.sql.includes(':first-insert */'));assert.equal(writes.length,1);
  assert.deepEqual(writes[0].values,[id(1),id(3),id(4),'7','SUBJECT',id(5),id(2),5]);
  assert.match(writes[0].sql,/native_first\(\$1::uuid,\$2::uuid\)/);
  assert.match(writes[0].sql,/p\.issued_claim_token=\$7::uuid AND p\.issued_attempts=\$8::integer/);
  assert.doesNotMatch(writes[0].sql,/ON CONFLICT|jsonb_populate_record|VALUES\s*\(/i);
  await assert.rejects(repo.insertActualFirstSourceBinding({source:'501'}),/invalid_input/);
  assert.equal(queries.filter(q=>q.sql.includes(':first-insert */')).length,1);
});

test('FIRST wrong binding, malformed selected identity, executable result or transaction change cannot INSERT',async()=>{
  for(const mutate of [r=>r.operation_id=id(9),r=>r.organization_id=id(9),r=>r.issued_transaction_id='102',
    r=>r.first_selected_ordinal=0,r=>r.first_selected_ordinal=3,r=>r.partition_ordinal=2000001,
    r=>r.selected_account_id=' SELECTED-B',r=>r.native_key='0',r=>r.native_key='9223372036854775808',
    r=>r.index_reference.extra=true,r=>r.kind='caller_source',r=>r.extra=true]){
    const firstNative=copy(first);mutate(firstNative);const {repo,queries}=fixture({firstNative});
    await assert.rejects(repo.insertActualFirstSourceBinding());assert.ok(!queries.some(q=>q.sql.includes(':first-insert */')));
  }
  const firstNative=copy(first);let touched=false;
  Object.defineProperty(firstNative,'entry_reference',{enumerable:true,get(){touched=true;throw Error('getter');}});
  await assert.rejects(fixture({firstNative}).repo.insertActualFirstSourceBinding());assert.equal(touched,false);
  for(const transactions of [['101','102'],['101','101','102']]){
    const {repo,queries}=fixture({transactions});await assert.rejects(repo.insertActualFirstSourceBinding(),/caller_transaction_required/);
    assert.ok(!queries.some(q=>q.sql.includes(':first-insert */')));
  }
});

test('FIRST missing actual parent/native key does not INSERT; changed result or ending transaction requires rollback',async()=>{
  const {repo,queries}=fixture({raw:{rowCount:0,rows:[]}});
  await assert.rejects(repo.insertActualFirstSourceBinding(),/claim_or_actual17_parent_lost/);
  assert.ok(!queries.some(q=>q.sql.includes(':first-insert */')));
  const firstInserted=copy(first);firstInserted.native_key='502';
  await assert.rejects(fixture({firstInserted}).repo.insertActualFirstSourceBinding(),/native_first_changed/);
  await assert.rejects(fixture({transactions:['101','101','101','102']}).repo.insertActualFirstSourceBinding(),/caller_transaction_required/);
});
