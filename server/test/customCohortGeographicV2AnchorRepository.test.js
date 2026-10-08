import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createCustomCohortGeographicV2AnchorRepository as create } from '../src/services/neighborhoodAssessment/customCohortGeographicV2AnchorRepository.js';
const claim={operation_id:'11111111-1111-4111-8111-111111111111',claim_token:'22222222-2222-4222-8222-222222222222',attempts:1};
const scope={organization_id:'33333333-3333-4333-8333-333333333333',report_file_id:'44444444-4444-4444-8444-444444444444',assignment_file_id:'7',account_id:'S'};
const actorUserId='55555555-5555-4555-8555-555555555555',ref=c=>({content_sha256:c.repeat(64),canonical_utf8_bytes:'123'});
const bound={source_reference:ref('a'),root_reference:ref('b'),graph_reference:ref('c'),stock_reference:ref('d')};
function fixture({auto=false,lost=false,corrupt=false}={}){
  let current=null,tx=0;const calls=[];
  const client={async query(sql,values){calls.push({sql,values});
    if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:auto?String(++tx):'12'}]};
    if(sql.includes(':anchor-read'))return lost?{rowCount:0,rows:[]}:{rowCount:1,rows:[current
      ??Object.fromEntries([...Object.keys(bound),'receipt_reference','sequence'].map(k=>[k,null]))]};
    if(sql.includes(':anchor-insert'))current={...Object.fromEntries(Object.keys(bound).map((k,i)=>[k,JSON.parse(values[8+i])])),
      receipt_reference:JSON.parse(values[12]),sequence:1};
    else if(sql.includes(':anchor-advance'))current={...current,receipt_reference:JSON.parse(values[8]),sequence:values[9]};
    else assert.fail('unexpected SQL');
    return {rowCount:1,rows:[{sequence:corrupt?0:current.sequence}]};
  }};
  return {repository:create({client,claim,scope,actorUserId,...bound}),calls,get current(){return current;},set current(v){current=v;}};
}
test('geographic issuance is scoped, monotonic, independently read back and shares the caller transaction',async()=>{
  const f=fixture();assert.equal(await f.repository.read(),null);
  const first=await f.repository.advance(null,ref('e'));assert.deepEqual(first,{...bound,receipt_reference:ref('e'),sequence:1});
  const second=await f.repository.advance(first,ref('f'));assert.equal(second.sequence,2);
  const update=f.calls.find(c=>c.sql.includes(':anchor-advance'));
  assert.deepEqual(update.values.slice(0,8),[claim.operation_id,claim.claim_token,1,scope.organization_id,scope.report_file_id,'7','S',actorUserId]);
  assert.match(update.sql,/anchor\.receipt_reference=\$15::jsonb AND anchor\.sequence=\$16::integer/);
  for(const c of f.calls.filter(c=>!c.sql.includes(':transaction'))){
    assert.match(c.sql,/lease_expires_at>clock_timestamp\(\)/);assert.match(c.sql,/cancellation_requested_at IS NULL/);
    assert.doesNotMatch(c.sql,/SET checkpoint|SET lease_expires_at/);
  }
  const writes=f.calls.filter(c=>/:anchor-insert|:anchor-advance/.test(c.sql)).length;
  await assert.rejects(f.repository.advance(first,ref('e')),/conflict/);
  assert.equal(f.calls.filter(c=>/:anchor-insert|:anchor-advance/.test(c.sql)).length,writes);
});
test('autocommit, current claim loss, corrupt acknowledgement and each source/root/graph/stock substitution refuse',async()=>{
  const auto=fixture({auto:true});await assert.rejects(auto.repository.advance(null,ref('e')),/caller_transaction_required/);
  assert.ok(!auto.calls.some(c=>c.sql.includes(':anchor-insert')));
  await assert.rejects(fixture({lost:true}).repository.read(),/claim_lost/);
  await assert.rejects(fixture({corrupt:true}).repository.advance(null,ref('e')),/corrupt/);
  for(const key of Object.keys(bound)){
    const f=fixture();f.current={...bound,[key]:ref('f'),receipt_reference:ref('e'),sequence:1};
    await assert.rejects(f.repository.read(),/binding_changed/);
  }
});
test('additive guard binds the actual completed issued graph and exact next stock prefix, including the full-tail terminal rule',()=>{
  const name='20261113_custom_cohort_geographic_v2_anchors.sql';
  const registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8');
  assert.ok(registry.indexOf(name)>registry.indexOf('20261112_custom_cohort_source_graph_v2_anchors.sql'));
  const sql=readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
  for(const m of sql.matchAll(/CREATE (?:TABLE|FUNCTION|TRIGGER) (?:app\.)?([a-z0-9_]+)/g))assert.ok(Buffer.byteLength(m[1])<=63);
  for(const s of ['graph_anchor.receipt_reference<>NEW.graph_reference',"before_state IS DISTINCT FROM old_receipt->'after'",
    'NEW.sequence<>OLD.sequence+1','ORDER BY object_id LIMIT delta','actual_nulls<>null_delta',
    'completed:=NOT remaining AND delta<250',"delta=0 AND NOT completed","'frozen_geo_verify_refs_v2'",'BEFORE TRUNCATE'])assert.ok(sql.includes(s),s);
  assert.doesNotMatch(sql,/ST_MemSize|ST_DWithin|SELECT[^;]*\bpayload\b|DISABLE TRIGGER|DROP TABLE|UPDATE app\.report_files/);
});
