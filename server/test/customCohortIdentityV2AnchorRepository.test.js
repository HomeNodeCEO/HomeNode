import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createCustomCohortIdentityV2AnchorRepository as create } from '../src/services/neighborhoodAssessment/customCohortIdentityV2AnchorRepository.js';
const claim={operation_id:'11111111-1111-4111-8111-111111111111',claim_token:'22222222-2222-4222-8222-222222222222',attempts:1};
const scope={organization_id:'33333333-3333-4333-8333-333333333333',report_file_id:'44444444-4444-4444-8444-444444444444',assignment_file_id:'7',account_id:'S'};
const actorUserId='55555555-5555-4555-8555-555555555555',ref=c=>({content_sha256:c.repeat(64),canonical_utf8_bytes:'123'});
const bound={source_reference:ref('a'),root_reference:ref('b'),graph_reference:ref('c'),geographic_reference:ref('d'),stock_reference:ref('e')};
function fixture({auto=false,lost=false,corrupt=false}={}){
  let current=null,tx=0;const calls=[];
  const client={async query(sql,values){calls.push({sql,values});
    if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:auto?String(++tx):'12'}]};
    if(sql.includes(':anchor-read'))return lost?{rowCount:0,rows:[]}:{rowCount:1,rows:[current
      ??Object.fromEntries([...Object.keys(bound),'receipt_reference','sequence'].map(k=>[k,null]))]};
    if(sql.includes(':anchor-insert'))current={...Object.fromEntries(Object.keys(bound).map((k,i)=>[k,JSON.parse(values[8+i])])),
      receipt_reference:JSON.parse(values[13]),sequence:1};
    else if(sql.includes(':anchor-advance'))current={...current,receipt_reference:JSON.parse(values[8]),sequence:values[9]};
    else assert.fail('unexpected SQL');
    return {rowCount:1,rows:[{sequence:corrupt?0:current.sequence}]};
  }};
  return {repository:create({client,claim,scope,actorUserId,...bound}),calls,get current(){return current;},set current(v){current=v;}};
}
test('identity head remains separately issued, scoped, monotonic and read back within the caller transaction',async()=>{
  const f=fixture();assert.equal(await f.repository.read(),null);
  const first=await f.repository.advance(null,ref('f'));assert.deepEqual(first,{...bound,receipt_reference:ref('f'),sequence:1});
  const second=await f.repository.advance(first,ref('a'));assert.equal(second.sequence,2);
  const update=f.calls.find(c=>c.sql.includes(':anchor-advance'));
  assert.deepEqual(update.values.slice(0,8),[claim.operation_id,claim.claim_token,1,scope.organization_id,scope.report_file_id,'7','S',actorUserId]);
  assert.match(update.sql,/anchor\.receipt_reference=\$16::jsonb AND anchor\.sequence=\$17::integer/);
  for(const c of f.calls.filter(c=>!c.sql.includes(':transaction'))){
    assert.match(c.sql,/lease_expires_at>clock_timestamp\(\)/);assert.match(c.sql,/cancellation_requested_at IS NULL/);
    assert.doesNotMatch(c.sql,/SET checkpoint|SET lease_expires_at/);
  }
  const writes=f.calls.filter(c=>/:anchor-insert|:anchor-advance/.test(c.sql)).length;
  await assert.rejects(f.repository.advance(first,ref('f')),/conflict/);
  assert.equal(f.calls.filter(c=>/:anchor-insert|:anchor-advance/.test(c.sql)).length,writes);
});
test('identity head refuses autocommit, current claim loss, corrupt acknowledgement and graph/geo/source/root/stock replacements',async()=>{
  const auto=fixture({auto:true});await assert.rejects(auto.repository.advance(null,ref('f')),/caller_transaction_required/);
  assert.ok(!auto.calls.some(c=>c.sql.includes(':anchor-insert')));
  await assert.rejects(fixture({lost:true}).repository.read(),/claim_lost/);
  await assert.rejects(fixture({corrupt:true}).repository.advance(null,ref('f')),/corrupt/);
  for(const key of Object.keys(bound)){
    const f=fixture();f.current={...bound,[key]:ref('f'),receipt_reference:ref('a'),sequence:1};
    await assert.rejects(f.repository.read(),/binding_changed/);
  }
});
test('additive identity guard binds both issued DONE prerequisites and exact native next-prefix/terminal coverage',()=>{
  const name='20261114_custom_cohort_identity_v2_anchors.sql';
  const registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8');
  assert.ok(registry.indexOf(name)>registry.indexOf('20261113_custom_cohort_geographic_v2_anchors.sql'));
  const sql=readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
  for(const m of sql.matchAll(/CREATE (?:TABLE|FUNCTION|TRIGGER) (?:app\.)?([a-z0-9_]+)/g))assert.ok(Buffer.byteLength(m[1])<=63);
  for(const s of ['graph_anchor.receipt_reference<>NEW.graph_reference','geo_anchor.receipt_reference<>NEW.geographic_reference',
    "geo_receipt->'after'->>'done' IS DISTINCT FROM 'true'","receipt->'layer_counts' IS DISTINCT FROM counts",
    "before_state IS DISTINCT FROM old_receipt->'after'",'NEW.sequence<>OLD.sequence+1','LIMIT $4+1',
    'completed:=candidates_count=delta AND delta<250','original.source_record_id IS NULL AND EXISTS',
    "WHEN %L='parcels' THEN original.payload->>'sync_run_id' IS NULL",'actual_unknown',
    'missing_count>stock.account_count',"'frozen_identity_refs_v2'",'BEFORE TRUNCATE'])assert.ok(sql.includes(s),s);
  assert.doesNotMatch(sql,/ST_DWithin|DISABLE TRIGGER|DROP TABLE|UPDATE app\.report_files|jsonb_agg\(original\.payload/);
  const owner=readFileSync(new URL('../src/services/neighborhoodAssessment/customCohortContextCapture.js',import.meta.url),'utf8');
  assert.ok(owner.includes("if(identityVerifying&&issued?.after.done!==true)fail('unfinished_geographic_verification')"));
  assert.ok(owner.includes('createNeighborhoodFrozenJobSourceIdentity(client,stockOptions,graph).step(issued?.after??null)'));
});
