import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCustomCohortNeutralCacheV2HeadRepository as create }
  from '../src/services/neighborhoodAssessment/customCohortNeutralCacheV2HeadRepository.js';
const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,
  ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
  scope={organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'A'};
function fixture({autocommit=false,conflict=false,missingClaim=false}={}){
  let current=null,transaction=1;const calls=[],bindings=Object.fromEntries(
    ['source_reference','root_reference','graph_reference','geographic_reference','identity_reference','stock_reference'].map((k,i)=>[k,ref(i+1)]));
  const client={async query(sql,values){calls.push({sql,values});
    if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:String(autocommit?transaction++:transaction)}]};
    if(sql.includes(':anchor-read'))return missingClaim?{rowCount:0,rows:[]}:{rowCount:1,rows:[current??
      Object.fromEntries([...Object.keys(bindings),'receipt_reference','sequence'].map(k=>[k,null]))]};
    if(sql.includes(':anchor-insert')){current={...bindings,receipt_reference:JSON.parse(values[14]),sequence:1};return {rowCount:1,rows:[{sequence:1}]};}
    if(sql.includes(':anchor-advance')){
      if(conflict)return {rowCount:0,rows:[]};
      current={...bindings,receipt_reference:JSON.parse(values[8]),sequence:values[9]};return {rowCount:1,rows:[{sequence:current.sequence}]};
    }assert.fail(sql);
  }};
  return {calls,owner:create({client,claim:{operation_id:id(3),claim_token:id(4),attempts:1},scope,actorUserId:id(5),...bindings})};
}
test('independent neutral head uses live scope, caller transaction and CAS, and refuses unsupported automatic ownership',async()=>{
  const f=fixture();assert.equal(await f.owner.read(),null);
  const a=await f.owner.advance(null,ref(7)),b=await f.owner.advance(a,ref(8));
  assert.equal(a.sequence,1);assert.equal(b.sequence,2);await assert.rejects(f.owner.advance(a,ref(9)),/conflict/);
  const read=f.calls.find(c=>c.sql.includes(':anchor-read')).sql;
  assert.match(read,/job\.actor_user_id=\$8::uuid/);assert.match(read,/execution_mode' IS NULL/);
  assert.match(read,/NOT EXISTS\(SELECT 1 FROM app.neighborhood_custom_cohort_v2_continuations/);
  assert.ok(!f.calls.some(c=>/ST_DWithin|\bBEGIN\b|\bCOMMIT\b|UPDATE app\.report_files/.test(c.sql)));
  await assert.rejects(fixture({missingClaim:true}).owner.read(),/claim_lost/);
});
test('autocommit and a lost native CAS cannot acquire a neutral-cache coverage head',async()=>{
  const auto=fixture({autocommit:true});await assert.rejects(auto.owner.advance(null,ref(7)),/caller_transaction_required/);
  assert.ok(!auto.calls.some(c=>c.sql.includes(':anchor-insert')));
  const f=fixture({conflict:true}),a=await f.owner.advance(null,ref(7));await assert.rejects(f.owner.advance(a,ref(8)),/claim_lost/);
});
test('neutral native coverage remains unregistered with bounded edges, retention roots and a real commit fence',()=>{
  const name='20261212_custom_cohort_neutral_cache_v2_heads.sql',
    sql=readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
  assert.ok(!readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8').includes(name));
  for(const m of sql.matchAll(/CREATE (?:TABLE|FUNCTION|TRIGGER) (?:app\.)?([a-z0-9_]+)/g))assert.ok(Buffer.byteLength(m[1])<=63);
  assert.match(sql,/sequence BETWEEN 1 AND 200000/);assert.match(sql,/DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql,/FOREIGN KEY\(organization_id,receipt_sha256\)/);assert.match(sql,/FOREIGN KEY\(organization_id,root_sha256\)/);
  assert.match(sql,/receipt->'after' IS DISTINCT FROM expected_after/);
  assert.doesNotMatch(sql,/DISABLE TRIGGER|DROP TABLE|UPDATE app\.report_files|SET attempts/);
});
