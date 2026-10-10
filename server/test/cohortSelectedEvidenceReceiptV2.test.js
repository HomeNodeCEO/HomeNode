import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { prepareCohortSelectedEvidenceReceiptV2 as prepare }
  from '../src/services/neighborhoodAssessment/cohortSelectedEvidenceReceiptV2.js';
import { NEIGHBORHOOD_FIRST_SELECTED_TRANSACTION_ORIGINAL_PACKAGE_V2_SQL as transaction,
  NEIGHBORHOOD_FIRST_SELECTED_COMBINED_ORIGINAL_PACKAGE_V2_SQL as first,
  NEIGHBORHOOD_NEXT_SELECTED_COMBINED_ORIGINAL_PACKAGE_V2_SQL as next }
  from '../src/services/neighborhoodAssessment/neighborhoodSelectedTransactionOriginalPackageV2.js';

const id='70000000-0000-4000-8000-000000000003',
  ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
  expected={union_reference:ref(1),eligibility_reference:ref(2),command_id:id,selected_stock_count:2},
  initial={selected_ordinal:0,done:false},one={selected_ordinal:1,done:false},two={selected_ordinal:2,done:false};
const raw=()=>({format:'cohort_selected_evidence_receipt_v2',...structuredClone(expected),sequence:1,previous:null,
  before:initial,after:one,selected_entry:{account_id:'B',ordinal:1,partition_ordinal:2,entry_reference:ref(3)}});

test('sixth receipt DATA retains exact ordinal/native entry metadata, not values or source authority',()=>{
  const a=prepare(raw(),expected),b=prepare({...raw(),sequence:2,previous:ref(4),before:one,after:two,
    selected_entry:{account_id:'Z',ordinal:2,partition_ordinal:2000000,entry_reference:ref(5)}},expected),
    done=prepare({...raw(),sequence:3,previous:ref(6),before:two,after:{...two,done:true},selected_entry:null},expected);
  assert.equal(a.selected_entry.account_id,'B');assert.equal(b.selected_entry.account_id,'Z');
  assert.deepEqual(done.after,{selected_ordinal:2,done:true});assert.equal(done.selected_entry,null);
  for(const r of [a,b,done]){
    assert.ok(Object.isFrozen(r)&&Object.isFrozen(r.before)&&Object.isFrozen(r.after)&&Object.isFrozen(r.union_reference)
      &&Object.isFrozen(r.eligibility_reference));
    assert.ok(Buffer.byteLength(JSON.stringify(r))<16000);
    assert.deepEqual(Object.keys(r).sort(),Object.keys(raw()).sort());
  }
  assert.ok(Object.isFrozen(a.selected_entry)&&Object.isFrozen(a.selected_entry.entry_reference));
  const empty={...expected,selected_stock_count:0},e=prepare({...raw(),...empty,before:initial,
    after:{...initial,done:true},selected_entry:null},empty);
  assert.equal(e.sequence,1);assert.equal(e.after.selected_ordinal,0);
  const cap={...expected,selected_stock_count:2000000},last={selected_ordinal:2000000,done:false};
  const terminal=prepare({...raw(),...cap,sequence:2000001,previous:ref(7),before:last,after:{...last,done:true},selected_entry:null},cap);
  assert.equal(terminal.sequence,2000001);
});

test('fresh EMPTY shape cannot skip an ordinal, erase native entry or claim DONE from a prefix',()=>{
  const bad=[{...raw(),after:{...one,done:true},selected_entry:null},
    {...raw(),before:{...initial,done:true}}, {...raw(),before:one}, {...raw(),after:two},
    {...raw(),selected_entry:null},{...raw(),sequence:0},{...raw(),sequence:2},{...raw(),sequence:NaN},
    {...raw(),previous:ref(4)},{...raw(),selected_stock_count:1},
    {...raw(),selected_entry:{...raw().selected_entry,ordinal:2}},
    {...raw(),selected_entry:{...raw().selected_entry,partition_ordinal:0}},
    {...raw(),selected_entry:{...raw().selected_entry,partition_ordinal:2000001}},
    {...raw(),selected_entry:{...raw().selected_entry,partition_ordinal:1.1}},
    {...raw(),selected_entry:{...raw().selected_entry,entry_reference:{...ref(3),canonical_utf8_bytes:'1000001'}}},
    {...raw(),before:{...initial,done:0}},{...raw(),after:{...one,done:'false'}}];
  for(const r of bad)assert.throws(()=>prepare(r,expected));
  assert.throws(()=>prepare({...raw(),sequence:2,previous:ref(4),before:one,after:{...one,done:true},selected_entry:null},expected));
  assert.throws(()=>prepare({...raw(),sequence:2,previous:null,before:one,after:two,
    selected_entry:{...raw().selected_entry,ordinal:2}},expected));
});

test('closed bindings refuse payload/value/decision/count authority and hostile descriptors without evaluation',()=>{
  const bad=[{...raw(),union_reference:ref(8)},{...raw(),eligibility_reference:ref(9)},{...raw(),command_id:'70000000-0000-4000-8000-000000000004'},
    {...raw(),command_id:42}, {...raw(),original_count:5},{...raw(),evidence_reconciled:true},
    {...raw(),selected_entry:{...raw().selected_entry,typed:{exact_value:'12'}}},
    {...raw(),selected_entry:{...raw().selected_entry,account_id:' A'}},
    {...raw(),selected_entry:{...raw().selected_entry,account_id:'\ud800'}},
    {...raw(),selected_entry:{...raw().selected_entry,account_id:'A\u0000'}},
    {...raw(),selected_entry:{...raw().selected_entry,account_id:'A'.repeat(65)}},
    {...raw(),union_reference:{...ref(1),canonical_utf8_bytes:'16001'}},
    {...raw(),eligibility_reference:{...ref(2),canonical_utf8_bytes:'16001'}},
    {...raw(),[Symbol('authority')]:true},Object.assign(Object.create(null),raw()),
    new Proxy(raw(),{getPrototypeOf(){assert.fail('proxy trap');}}),
    {...raw(),get after(){assert.fail('getter');}},
    {...raw(),selected_entry:{...raw().selected_entry,get entry_reference(){assert.fail('nested getter');}}},
    {...raw(),eligibility_reference:new Proxy(ref(2),{ownKeys(){assert.fail('reference proxy');}})}];
  for(const r of bad)assert.throws(()=>prepare(r,expected));
  for(const key of ['readOriginal','sourceGrant','ordinal','cursor','account_id','profile','counts','decision'])
    assert.throws(()=>prepare(raw(),{...expected,[key]:true}));
  assert.throws(()=>prepare(raw(),{...expected,get command_id(){assert.fail('expected getter');}}));
  for(const count of [-1,2.5,2000001,'2',NaN,Infinity])assert.throws(()=>prepare(raw(),{...expected,selected_stock_count:count}));
  const input=raw(),value=prepare(input,expected);
  input.union_reference.content_sha256='f'.repeat(64);input.eligibility_reference.canonical_utf8_bytes='999';
  input.selected_entry.account_id='altered';input.selected_entry.entry_reference.content_sha256='e'.repeat(64);
  assert.deepEqual(value.union_reference,ref(1));assert.deepEqual(value.eligibility_reference,ref(2));
  assert.equal(value.selected_entry.account_id,'B');assert.deepEqual(value.selected_entry.entry_reference,ref(3));
});

test('sixth candidate plan derives one next ordinal from native head and requires BOTH DONE parents without changing old SQL',()=>{
  const hash=s=>createHash('sha256').update(s).digest('hex');
  assert.equal(hash(transaction),'1f7aefc19d787df06f9e2d6246567f4434c7eff50f1387da643d50b9d0812215');
  assert.equal(hash(first),'079ce364f459f67e3f01576f7464d01c399db0e64b29741ed1e9b4de47b716e7');
  for(const s of ['neighborhood-next-selected-combined-evidence-original-package-v2',
    'neighborhood_custom_cohort_selected_evidence_v2_heads evidence','r.ordinal=coalesce(evidence.sequence,0)+1',
    'fifth.union_reference=head.receipt_reference','evidence.eligibility_reference=fifth.receipt_reference',
    'head.command_id=command.command_id AND fifth.command_id=command.command_id',
    "body.canonical_utf8::jsonb->'after'->>'done'='true'",
    "fifth_body.canonical_utf8::jsonb->'after'->>'done'='true'",
    "evidence_body.canonical_utf8::jsonb->'after'->>'done'='false'",
    'neighborhood_selected_eligibility_v2_checkpoint_matches','neighborhood_selected_evidence_v2_checkpoint_matches',
    "job.status='running'",'job.lease_expires_at>clock_timestamp()','job.cancellation_requested_at IS NULL',
    'job.context_sha256 IS NULL',"AND $4::text=''",'cad_totals AS MATERIALIZED','UNION ALL SELECT n FROM cad_totals',
    'AND NOT (SELECT oversize FROM raw_gate)','raw_sizes AS MATERIALIZED','raw_gate AS MATERIALIZED'])assert.ok(next.includes(s),s);
  assert.doesNotMatch(next,/r\.ordinal=1\b|r\.account_id=\$|ORDER BY a\.account_id|\bUPDATE\b|\bINSERT\b|ST_DWithin|FROM core\./);
  const rawSizes=next.slice(next.indexOf('raw_sizes AS MATERIALIZED'),next.indexOf('raw_gate AS MATERIALIZED')).replace(/--[^\n]*/g,'');
  assert.doesNotMatch(rawSizes,/jsonb_build_object|encoded/);
  assert.equal((next.match(/AND NOT \(SELECT oversize FROM raw_gate\)/g)??[]).length,3);
  assert.ok(next.indexOf('raw_gate AS MATERIALIZED')<next.indexOf('jsonb_build_object'));
  assert.equal((next.match(/LIMIT \(\$5::integer\+1\)/g)??[]).length,4);
  assert.deepEqual([...new Set([...next.matchAll(/\$(\d+)/g)].map(m=>Number(m[1])))].sort((a,b)=>a-b),
    [1,2,3,4,5,6,7,8,9,10,11]);
});

test('additive sixth native guard binds exact12 roots/BOTH DONE parents/native next ordinal and atomic continuation',()=>{
  const name='20261127_custom_cohort_selected_evidence_v2.sql',
    sql=readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'),
    registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8'),
    owner=readFileSync(new URL('../src/services/neighborhoodAssessment/customCohortContextCapture.js',import.meta.url),'utf8');
  assert.ok(registry.indexOf(name)>registry.indexOf('20261126_custom_cohort_selected_recorded_eligibility_v2.sql'));
  for(const m of sql.matchAll(/CREATE (?:TABLE|FUNCTION|TRIGGER|INDEX|CONSTRAINT TRIGGER) (?:app\.)?([a-z0-9_]+)/g))
    assert.ok(Buffer.byteLength(m[1])<=63,m[1]);
  for(const s of ["jsonb_array_length(cp->'evidence_refs')=12","cp->'evidence_refs'->11=h.receipt_reference",
    "(cp->'evidence_refs')-11","fifth_body->'after'->>'done' IS DISTINCT FROM 'true'",
    "union_body->'after'->>'done' IS DISTINCT FROM 'true'",'ordinal=NEW.sequence',
    "NEW.eligibility_reference IS DISTINCT FROM fifth.receipt_reference","(SELECT count(*) FROM jsonb_object_keys(body))<>10",
    'NEW.sequence<>OLD.sequence+1',"prior->'after'->>'done' IS DISTINCT FROM 'false'",
    'neighborhood_selected_evidence_v2_complete_union_conflict','member.partition_ordinal','p.entry_reference=member.entry_reference',
    'DEFERRABLE INITIALLY DEFERRED','neighborhood_selected_evidence_v2_orphan_progress',
    "c.phase<>'frozen_selected_evidence_refs_v2'","job.status<>'retry'",'c.consumed_claim_token IS NOT NULL',
    'job.claim_token IS NOT NULL','job.lease_expires_at IS NOT NULL','BEFORE TRUNCATE',
    'CHECK(sequence BETWEEN 1 AND 12000006)',"h.eligibility_reference=OLD.progress_reference",
    "NEW.status IN ('succeeded','awaiting_selection')",'NEW.attempts<OLD.attempts',
    "OLD.phase='frozen_selected_evidence_refs_v2' AND NEW.phase<>'frozen_selected_evidence_refs_v2'"])assert.ok(sql.includes(s),s);
  // No skipping fifth or backing out of sixth: these precise prior rules stay.
  assert.ok(sql.includes("OLD.checkpoint->>'phase'='frozen_selected_union_refs_v2' AND NEW.checkpoint->>'phase' NOT IN ('frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2')"));
  assert.ok(sql.includes("OLD.phase='frozen_selected_union_refs_v2' AND NEW.phase NOT IN ('frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2')"));
  assert.ok(sql.includes("NEW.phase='frozen_selected_eligibility_refs_v2' AND OLD.phase NOT IN ('frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2')"));
  for(const s of ["progressingSelectedEvidence?'readForEvidence'","'subjectAndNextSelectedCombinedAccountPackage'",
    'prepareCohortSelectedEvidenceReceiptV2','evidenceStore.advance','checkpoint.evidence_refs.slice(0,11)',
    'progressOriginalFrozenCaptureJobSelectedEvidenceReferencesV2'])assert.ok(owner.includes(s),s);
  assert.doesNotMatch(sql,/DISABLE TRIGGER|DROP TABLE|DROP TRIGGER|DELETE FROM|UPDATE app\.report|SET attempts=0|ST_DWithin/);
});

test('native sixth fault injection stays armed until actual source-ending, DML or real COMMIT boundaries',()=>{
  const fixture=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8'),
    block=fixture.slice(fixture.indexOf("if(config.text.includes('neighborhood-frozen-job-closure:parcels')"),
      fixture.indexOf('if(config.text===NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.read'));
  assert.ok(block.includes('config.text===NEIGHBORHOOD_NEXT_SELECTED_COMBINED_ORIGINAL_PACKAGE_V2_SQL'));
  assert.ok(block.includes("!fault?.startsWith('evidence_')"));
  for(const tag of ['evidence_insert_rollback','evidence_advance_rollback','evidence_checkpoint_rollback','evidence_yield_rollback',
    'evidence_orphan_commit','evidence_head_ending'])assert.ok(fixture.includes(tag),tag);
  assert.ok(fixture.includes("'evidence_orphan_commit'].includes(refsFault)"));
});

test('native intent truncate proof includes every command FK child without bypassing triggers or weakening refusal',()=>{
  const fixture=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8'),
    statement=fixture.match(/'TRUNCATE app\.neighborhood_custom_cohort_v2_selection_intents, ([^']+)'/);
  assert.ok(statement,'multi-table proof must reach the native immutable triggers');
  const children=statement[1].split(', ');
  for(const [migration,table] of [
    ['20261125_custom_cohort_selected_union_replay_v2.sql','app.neighborhood_custom_cohort_selected_union_v2_heads'],
    ['20261126_custom_cohort_selected_recorded_eligibility_v2.sql','app.neighborhood_custom_cohort_selected_eligibility_v2_heads'],
    ['20261127_custom_cohort_selected_evidence_v2.sql','app.neighborhood_custom_cohort_selected_evidence_v2_heads']]){
    const sql=readFileSync(new URL('../migrations/'+migration,import.meta.url),'utf8');
    assert.ok(sql.includes('REFERENCES app.neighborhood_custom_cohort_v2_selection_intents(command_id) ON DELETE RESTRICT ON UPDATE RESTRICT'));
    assert.ok(children.includes(table),table);
  }
  assert.equal(children.length,3);
  assert.doesNotMatch(statement[0],/CASCADE|DISABLE|DROP/);
  assert.ok(fixture.includes("'TRUNCATE app.neighborhood_custom_cohort_v2_selection_intents')),\n          /cannot truncate a table referenced in a foreign key constraint/"));
  assert.ok(fixture.includes('/selection_intent_immutable|custom_cohort_context_immutable/'));
});

test('sixth authority regression mutates actual same-transaction assignment and draft after one combined query and pins rollback',()=>{
  const fixture=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8'),
    start=fixture.indexOf('// Mutate actual native authority only AFTER'),
    end=fixture.indexOf("if(refsFault==='union_delta_count'",start),block=fixture.slice(start,end),
    query=fixture.lastIndexOf('const result=await client.query(config);',start);
  assert.ok(start>=0&&end>start&&query>=0&&start-query<100,'injection follows the real query');
  for(const s of ['config.text===NEIGHBORHOOD_NEXT_SELECTED_COMBINED_ORIGINAL_PACKAGE_V2_SQL',
    "['evidence_assignment_ending','evidence_draft_ending'].includes(refsFault)",
    'await client.query(', 'UPDATE app.assignment_files SET assigned_appraiser_user_id=NULL',
    "UPDATE app.custom_appraisal_workfiles SET status='archived'",'refsFault=null'])assert.ok(block.includes(s),s);
  assert.doesNotMatch(block,/await pool\.query|return \{.*rows/);
  for(const s of ['await assertEvidenceAuthorityRefusal(evidenceInitial)','await assertEvidenceAuthorityRefusal(pending)',
    "['evidence_assignment_ending',/assignment_access_denied/]","['evidence_draft_ending',/private_source_read_only/]",
    'assert.deepEqual(await readEvidenceAuthority(),authority','await evidenceUnchanged(snapshot)',
    'native reassignment/archive and all retained progress roll back together'])assert.ok(fixture.includes(s),s);
});
