import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareCohortSelectedUnionReceiptV2 as prepare } from '../src/services/neighborhoodAssessment/cohortSelectedUnionReceiptV2.js';
import { createCustomCohortSelectedUnionV2Repository as repository } from '../src/services/neighborhoodAssessment/customCohortSelectedUnionV2Repository.js';
import { getNeighborhoodOriginalRecordedGroupV2Profile } from '../src/services/neighborhoodAssessment/neighborhoodOriginalRecordedGroupV2.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
  scope={organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'A'},
  claim={operation_id:id(3),claim_token:id(5),attempts:2},
  binding={...scope,operation_id:id(3),generation_id:id(4),spatial_definition_sha256:'a'.repeat(64),source_original_sha256:'b'.repeat(64)},
  expected={binding,source_reference:ref(1),root:ref(2),graph_verification_reference:ref(3),stock_verification_reference:ref(4),
    identity_verification_reference:ref(5),stock_reference:ref(6),effective_date:'2026-10-07',stock_account_count:'2',
    traversal_reference:ref(7),profile_reference:getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref,
    partition_reference:ref(8),catalog_reference:ref(9),command_id:id(7)},
  initial={after_account:'',account_count:0,done:false},first={after_account:'A',account_count:1,done:false},last={after_account:'B',account_count:2,done:false},
  zero={assigned_accounts:0,unassigned_accounts:0,assigned_groups:0},unassigned={...zero,unassigned_accounts:1},
  final={assigned_accounts:1,unassigned_accounts:1,assigned_groups:1};
const raw=()=>({format:'cohort_selected_union_receipt_v2',...structuredClone(expected),sequence:1,previous:null,
  before:initial,after:first,entry_reference:ref(9),before_counts:zero,after_counts:unassigned,before_selected_count:0,after_selected_count:0});

test('union transition DATA preserves the entire stock denominator and explicit-empty selection through fresh terminal probe',()=>{
  for(const n of [0,1]){
    const a=prepare(raw(),expected),b=prepare({...raw(),sequence:2,previous:ref(9),before:first,after:last,
      before_counts:unassigned,after_counts:final,after_selected_count:n},expected),
      done=prepare({...raw(),sequence:3,previous:ref(9),before:last,after:{...last,done:true},entry_reference:null,
        before_counts:final,after_counts:final,before_selected_count:n,after_selected_count:n},expected);
    assert.equal(a.after_selected_count,0);assert.equal(b.after_selected_count,n);assert.equal(done.after.done,true);
    assert.ok(Object.isFrozen(done)&&Object.isFrozen(done.after_counts));assert.equal(done.after.account_count,2);
  }
});
test('union DATA rejects free DONE, count jumps, selection outside stock, command/root changes and hostile input',()=>{
  for(const r of [{...raw(),after_selected_count:2},{...raw(),before_selected_count:1},{...raw(),after_selected_count:-1},
    {...raw(),command_id:id(8)},{...raw(),catalog_reference:ref(8)},{...raw(),account_ids:['A']},
    {...raw(),after:{...last,done:true},entry_reference:null},new Proxy(raw(),{getPrototypeOf(){assert.fail('proxy');}}),
    {...raw(),get after_selected_count(){assert.fail('getter');}}])assert.throws(()=>prepare(r,expected));
  const r=raw(),p=prepare(r,expected);r.catalog_reference.content_sha256='f'.repeat(64);assert.deepEqual(p.catalog_reference,ref(9));
});
// SQL doubles test closed mechanics only; cloud PostgreSQL must execute guards,
// actual original/current authority fences, DML rollback and real COMMIT loss.
function setup({auto=false,selected=true,bad=false}={}){
  const calls=[];let current=null,tx=12,counts={...zero,selected_count:0};
  const client={async query(sql,v){calls.push({sql,v});
    if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:String(auto?++tx:tx)}]};
    if(sql.includes(':head-read'))return {rowCount:1,rows:[current??{command_id:null,receipt_reference:null,sequence:null}]};
    if(sql.includes(':counts'))return {rowCount:1,rows:[bad?{...counts,selected_count:4}:{...counts}]};
    if(sql.includes(':group-contribute')){counts.unassigned_accounts++;return {rowCount:1,rows:[{last_ordinal:v[9]}]};}
    if(sql.includes(':member-insert')){if(selected)counts.selected_count++;return {rowCount:selected?1:0,rows:selected?[{ordinal:counts.selected_count}]:[]};}
    if(sql.includes(':head-insert')){current={command_id:v[8],receipt_reference:JSON.parse(v[9]),sequence:1};return {rowCount:1,rows:[{sequence:1}]};}
    if(sql.includes(':head-advance')){current={...current,receipt_reference:JSON.parse(v[8]),sequence:v[9]};return {rowCount:1,rows:[{sequence:v[9]}]};}
    assert.fail(sql);}};
  return {client,calls,owner:repository({client,claim,scope,actorUserId:id(6),command_id:id(7)})};
}
const entry={account_id:'A',partition_ordinal:1,entry_reference:ref(9),group_id:'discovery:unassigned'};
test('native union storage retains only distinct identity/ordinals/reference and reads choices ONLY from immutable command',async()=>{
  for(const selected of [false,true]){
    const {owner,calls}=setup({selected});assert.equal(await owner.read(),null);
    assert.deepEqual(await owner.contribute(null,entry),{...unassigned,selected_count:selected?1:0});
    const a=await owner.advance(null,ref(9));assert.equal(a.sequence,1);assert.equal((await owner.advance(a,ref(8))).sequence,2);
    const member=calls.find(c=>c.sql.includes(':member-insert'));
    assert.ok(member.sql.includes('command.included_group_ids ? $12'));assert.equal(member.v[9],1);assert.equal(member.v[11],entry.group_id);
    assert.ok(member.sql.includes('entry.entry_reference=$11::jsonb'));
    for(const c of calls.filter(c=>c.sql.includes('job.operation_id')))for(const fence of ['job.claim_token=$2::uuid',
      'job.attempts=$3::integer','job.actor_user_id=$8::uuid',"job.status='running'",'job.context_sha256 IS NULL'])assert.ok(c.sql.includes(fence));
    assert.ok(!calls.some(c=>/array_agg|jsonb_agg|ST_DWithin|original_text|typed_value|\bBEGIN\b|\bCOMMIT\b/.test(c.sql)));
  }
});
test('native union storage refuses transaction changes, ordinal jumps, free eligibility/rosters and hostile inputs before DML',async()=>{
  const a=setup({auto:true});await assert.rejects(a.owner.contribute(null,entry),/caller_transaction_required/);
  await assert.rejects(a.owner.advance(null,ref(9)),/caller_transaction_required/);
  assert.ok(!a.calls.some(c=>/:group-contribute|:member-insert|:head-insert/.test(c.sql)));
  const {owner,calls,client}=setup();for(const e of [{...entry,partition_ordinal:2},{...entry,selected:true},
    {...entry,housing_category:'detached_single_family'},{...entry,account_id:'\ud800'},
    new Proxy(entry,{getPrototypeOf(){assert.fail('proxy');}}),{...entry,get group_id(){assert.fail('getter');}}])
    await assert.rejects(owner.contribute(null,e));assert.equal(calls.length,0);
  assert.throws(()=>repository({client,claim,scope,actorUserId:id(6),command_id:id(7),readOriginal:()=>{}}));
  await assert.rejects(setup({bad:true}).owner.counts(),/corrupt/);
});
test('registered fourth-pass guards preserve nine roots, exact first human bridge and later consumed-token rules',()=>{
  const name='20261125_custom_cohort_selected_union_replay_v2.sql',sql=readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'),
    registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8');
  assert.ok(registry.indexOf(name)>registry.indexOf('20261124_custom_cohort_selection_intent_v2.sql'));
  for(const s of ["((cp->'evidence_refs')-9)=c.checkpoint->'evidence_refs'",'PRIMARY KEY(operation_id,account_id)',
    'UNIQUE(operation_id,ordinal)','UNIQUE(operation_id,partition_ordinal)','DEFERRABLE INITIALLY DEFERRED','orphan_progress',
    'FULL JOIN app.neighborhood_custom_cohort_selected_union_v2_groups','g.member_count IS DISTINCT FROM r.member_count',
    'g.last_ordinal IS DISTINCT FROM r.last_ordinal','CHECK(sequence BETWEEN 1 AND 8000004)',
    'command.resume_claim_token=NEW.issued_claim_token','actual_sequence=1','AND NOT first_union_bridge',
    "NEW.phase='frozen_selected_union_refs_v2' AND OLD.phase NOT IN ('frozen_recorded_catalog_refs_v2','frozen_selected_union_refs_v2')",
    "command.checkpoint->'evidence_refs'->8=OLD.progress_reference",
    "OLD.phase='frozen_selected_union_refs_v2' AND NEW.phase<>'frozen_selected_union_refs_v2'",'BEFORE TRUNCATE'])assert.ok(sql.includes(s),s);
  for(const m of sql.matchAll(/CREATE (?:TABLE|FUNCTION|TRIGGER|INDEX|CONSTRAINT TRIGGER) (?:app\.)?([a-z0-9_]+)/g))assert.ok(Buffer.byteLength(m[1])<=63,m[1]);
  assert.doesNotMatch(sql,/DISABLE TRIGGER|DROP TABLE|DROP TRIGGER|UPDATE app\.report_files|ST_DWithin|array_agg|jsonb_agg/);
  assert.doesNotMatch(sql,/cp->'evidence_refs'-9/); // subtraction binds before -> in PostgreSQL
});
