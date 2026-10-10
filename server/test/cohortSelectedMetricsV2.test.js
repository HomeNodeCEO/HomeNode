import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { prepareCohortSelectedMetricsReceiptV2 as prepare } from '../src/services/neighborhoodAssessment/cohortSelectedMetricsReceiptV2.js';
import { createCustomCohortSelectedMetricsV2Repository as repository } from '../src/services/neighborhoodAssessment/customCohortSelectedMetricsV2Repository.js';
import { NEIGHBORHOOD_NEXT_SELECTED_METRIC_ORIGINAL_PACKAGE_V2_SQL as sql,
  NEIGHBORHOOD_FIRST_SELECTED_COMBINED_ORIGINAL_PACKAGE_V2_SQL as oldFirst,
  NEIGHBORHOOD_FIRST_SELECTED_METRIC_ORIGINAL_PACKAGE_V2_SQL as oldMetric,
  NEIGHBORHOOD_NEXT_SELECTED_COMBINED_ORIGINAL_PACKAGE_V2_SQL as oldSixth } from '../src/services/neighborhoodAssessment/neighborhoodSelectedTransactionOriginalPackageV2.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,
 ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
 counts=n=>({reported_year_built:0,reported_residential_area:0,reported_site_area:n}),
 expected={command_id:id(3),union_reference:ref(1),eligibility_reference:ref(2),evidence_reference:ref(3),selected_stock_count:1},
 member={account_id:'B',ordinal:1,partition_ordinal:2,entry_reference:ref(4),state:'unassigned',assigned_group_id:null},
 raw=()=>({format:'cohort_selected_metrics_receipt_v2',...structuredClone(expected),sequence:1,previous:null,
   before:{selected_ordinal:0,done:false},after:{selected_ordinal:1,done:false},
   selected_entry:Object.fromEntries(['account_id','ordinal','partition_ordinal','entry_reference'].map(k=>[k,member[k]])),
   row_reference:ref(5),before_counts:counts(0),after_counts:counts(1)});

test('seventh closed receipt binds row/native parents and exact eligibility deltas without source authority',()=>{
 const input=raw(),r=prepare(input,expected);input.after_counts.reported_site_area=0;
 assert.deepEqual(r.after_counts,counts(1));assert.ok(Object.isFrozen(r)&&Object.isFrozen(r.after_counts)&&Object.isFrozen(r.selected_entry));
 const done=prepare({...raw(),sequence:2,previous:ref(6),before:{selected_ordinal:1,done:false},after:{selected_ordinal:1,done:true},
   selected_entry:null,row_reference:null,before_counts:counts(1)},expected);
 assert.equal(done.row_reference,null);assert.deepEqual(done.after_counts,done.before_counts);
 const e={...expected,selected_stock_count:0};assert.equal(prepare({...raw(),...e,after:{selected_ordinal:0,done:true},
   selected_entry:null,row_reference:null,after_counts:counts(0)},e).after.done,true);
 assert.ok(Buffer.byteLength(JSON.stringify(r))<16000);
});

test('seventh DATA refuses prefix EMPTY, count laundering, row erasure, parent substitution and hostile grammar',()=>{
 for(const args of [[],[raw()],[raw(),expected,true]])assert.throws(()=>prepare(...args));
 for(const patch of [{row_reference:null},{row_reference:{...ref(5),canonical_utf8_bytes:'4097'}},
   {evidence_reference:ref(8)},{selected_stock_count:2},{after_counts:counts(2)},{before_counts:counts(1)},
   {before_counts:{...counts(0),market:0}},{after:{selected_ordinal:0,done:true},selected_entry:null,row_reference:null},
   {after:{selected_ordinal:1,done:true},selected_entry:null,row_reference:null},{metrics:[]},{readOriginal:()=>assert.fail('callback')},
   {selected_entry:{...raw().selected_entry,ordinal:2}}])assert.throws(()=>prepare({...raw(),...patch},expected));
 for(const value of [new Proxy(raw(),{getPrototypeOf(){assert.fail('proxy');}}),{...raw(),get after(){assert.fail('getter');}},
   {...raw(),[Symbol('authority')]:true},Object.assign(Object.create(null),raw())])assert.throws(()=>prepare(value,expected));
});

function setup({auto=false,next=member,corrupt=false,readback=false}={}){
 let head=null,tx=8;const calls=[],empty={command_id:null,union_reference:null,eligibility_reference:null,evidence_reference:null,receipt_reference:null,sequence:null};
 const options={client:{async query(text,values){calls.push({text,values});
   if(text.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:String(auto?++tx:tx)}]};
   if(text.includes(':head-read'))return {rowCount:1,rows:[head??empty]};
   if(text.includes(':next-selected-entry'))return {rowCount:1,rows:[next??Object.fromEntries(Object.keys(member).map(k=>[k,null]))]};
   if(text.includes(':row-insert'))return {rowCount:1,rows:[{ordinal:values[13],row_reference:JSON.parse(values[12])}]};
   if(text.includes(':head-insert')){head={command_id:values[8],union_reference:JSON.parse(values[9]),eligibility_reference:JSON.parse(values[10]),
     evidence_reference:JSON.parse(values[11]),receipt_reference:JSON.parse(values[12]),sequence:1};
     if(readback)head.evidence_reference=ref(9);return {rowCount:1,rows:[{sequence:corrupt?2:1}]};}
   if(text.includes(':head-advance')){head={...head,receipt_reference:JSON.parse(values[8]),sequence:values[9]};return {rowCount:1,rows:[{sequence:values[9]}]};}
   assert.fail(text);}},claim:{operation_id:id(4),claim_token:id(5),attempts:2},
   scope:{organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'A'},actorUserId:id(6),
   command_id:id(3),union_reference:ref(1),eligibility_reference:ref(2),evidence_reference:ref(3)};
 return {calls,options,owner:repository(options)};
}

test('seventh storage writes literal native member/row/head CAS in one caller TX; not a membership or source adapter',async()=>{
 const {owner,calls}=setup();assert.equal(await owner.read(),null);assert.deepEqual(await owner.readNextSelectedEntry(),member);
 const head=await owner.advance(null,ref(6),ref(5));assert.equal(head.sequence,1);assert.deepEqual(head.evidence_reference,ref(3));
 assert.equal((await owner.advance(head,ref(7),null)).sequence,2);
 const next=calls.find(c=>c.text.includes(':next-selected-entry')).text;
 for(const s of ['r.ordinal=coalesce(h.sequence,0)+1','h.evidence_reference=$12::jsonb',
   'neighborhood_selected_evidence_v2_checkpoint_matches','neighborhood_selected_metrics_v2_checkpoint_matches',
   "sixth_body.canonical_utf8::jsonb->'after'->>'done'='true'","fifth_body.canonical_utf8::jsonb->'after'->>'done'='true'",
   'job.actor_user_id=$8::uuid','job.claim_token=$2::uuid','entry.entry_reference=r.entry_reference'])assert.ok(next.includes(s),s);
 const row=calls.find(c=>c.text.includes(':row-insert'));assert.equal(row.values.length,14);assert.equal(row.values[13],1);
 assert.match(row.text,/SELECT job.operation_id,job.organization_id,r.ordinal,r.account_id,r.partition_ordinal,r.entry_reference/);
 assert.equal(calls.filter(c=>c.text.includes(':row-insert')).length,1,'EMPTY never inserts a value row');
 assert.ok(!calls.some(c=>/array_agg|jsonb_agg|ST_DWithin|FROM core\.|\bBEGIN\b|\bCOMMIT\b/.test(c.text)));
 assert.equal(await setup({next:null}).owner.readNextSelectedEntry(),null);
});

test('seventh storage refuses callbacks/free cursors, wrong arity, stale CAS/readback and autocommit',async()=>{
 const {owner,calls,options}=setup();
 for(const v of [undefined,1,{ordinal:1},()=>assert.fail('callback')]){
   await assert.rejects(owner.read(v));await assert.rejects(owner.readNextSelectedEntry(v));}
 for(const args of [[],[null],[null,ref(6)],[null,ref(6),ref(5),true]])await assert.rejects(owner.advance(...args));
 assert.equal(calls.length,0);
 for(const key of ['readOriginal','account_id','ordinal','cursor','decision','selected_accounts'])assert.throws(()=>repository({...options,[key]:true}));
 assert.throws(()=>repository({...options,get evidence_reference(){assert.fail('getter');}}));
 await assert.rejects(setup({auto:true}).owner.advance(null,ref(6),ref(5)),/caller_transaction_required/);
 await assert.rejects(setup({corrupt:true}).owner.advance(null,ref(6),ref(5)),/corrupt/);
 await assert.rejects(setup({readback:true}).owner.advance(null,ref(6),ref(5)),/binding_changed/);
});

test('new fixed SQL derives native metric sequence, keeps all DONE parents and old SQL byte-identical',()=>{
 for(const s of ['neighborhood-next-selected-metric-original-package-v2','r.ordinal=coalesce(metrics.sequence,0)+1',
   'metrics.evidence_reference=evidence.receipt_reference','neighborhood_selected_metrics_v2_checkpoint_matches',
   "metrics_body.canonical_utf8::jsonb->'after'->>'done'='false'","evidence_body.canonical_utf8::jsonb->'after'->>'done'='true'",
   '(SELECT coalesce(sum(n),0) FROM all_totals)<=$5::integer','cad_totals AS MATERIALIZED','raw_gate AS MATERIALIZED'])
   assert.ok(sql.includes(s),s);
 assert.doesNotMatch(sql,/r.ordinal=coalesce\(evidence.sequence|r.account_id=\$|\bINSERT\b|\bUPDATE\b|FROM core\./);
 assert.equal((sql.match(/AND NOT \(SELECT oversize FROM raw_gate\)/g)??[]).length,3);
 assert.ok(sql.indexOf('raw_gate AS MATERIALIZED')<sql.indexOf('jsonb_build_object'));
 assert.equal(createHash('sha256').update(oldFirst).digest('hex'),'079ce364f459f67e3f01576f7464d01c399db0e64b29741ed1e9b4de47b716e7');
 assert.ok(oldMetric.includes('r.ordinal=1'));assert.ok(oldSixth.includes('r.ordinal=coalesce(evidence.sequence,0)+1'));
});

test('additive native guards close exact13 roots, immutable row grammar, terminal reconciliation and atomic continuation',()=>{
 const name='20261128_custom_cohort_selected_metrics_v2.sql',migration=readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'),
   registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8');
 assert.ok(registry.indexOf(name)>registry.indexOf('20261127_custom_cohort_selected_evidence_v2.sql'));
 assert.ok(migration.includes("'^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$'"));
 assert.ok(migration.includes("'^[1-9][0-9]{3}$'"));
 assert.equal((migration.match(/END \$\$;/g)??[]).length,6,'six complete PL/pgSQL functions; no replacement suffix injected into regex');
 for(const s of ["jsonb_array_length(cp->'evidence_refs')=13","(cp->'evidence_refs')-12",
   'app.neighborhood_selected_evidence_v2_checkpoint_matches','DEFERRABLE INITIALLY DEFERRED','neighborhood_selected_metrics_v2_orphan_row',
   "body->'after_counts' IS DISTINCT FROM fifth_body->'after_counts'","row_body->'effective_date' IS DISTINCT FROM intent_body->'effective_date'",
   "row_body->'observation_period' IS DISTINCT FROM job.request_payload->'observation_period'",
   "row_body->'subject_housing' IS DISTINCT FROM fifth_body->'subject_housing'",
   "key='reported_market_value'","key='reported_residential_area' AND cell->>'exact_value'='0'",
   "TG_OP<>'INSERT'","NEW.ordinal<>coalesce(h.sequence,0)+1",'CHECK(sequence BETWEEN 1 AND 14000007)',
   "h.evidence_reference=OLD.progress_reference","OLD.phase='frozen_selected_metrics_refs_v2' AND NEW.phase<>'frozen_selected_metrics_refs_v2'",
   'NEW.issued_attempts<OLD.issued_attempts','OLD.consumed_claim_token IS NULL'])assert.ok(migration.includes(s),s);
 assert.doesNotMatch(migration,/DISABLE TRIGGER|DROP TRIGGER|DROP TABLE|TRUNCATE app\.|UPDATE app\.report|ST_DWithin/);
 const owner=readFileSync(new URL('../src/services/neighborhoodAssessment/customCohortContextCapture.js',import.meta.url),'utf8'),
   ending=owner.indexOf("if(progressingSelectedMetrics&&!same(await metricsStore.read(),metricsAnchor))"),
   rowWrite=owner.indexOf('const rowReference=metricsRowCandidate===null?',ending),head=owner.indexOf('metricsStore.advance(',rowWrite),
   checkpoint=owner.indexOf("phase:'frozen_selected_metrics_refs_v2'",head),yieldAt=owner.indexOf('yieldIssued(claim,jobOptions)',checkpoint);
 assert.ok(ending>0&&rowWrite>ending&&head>rowWrite&&checkpoint>head&&yieldAt>checkpoint);
 assert.ok(owner.includes("progressingSelectedMetrics?'readForMetrics'"));assert.ok(owner.includes("'subjectAndNextSelectedMetricAccountPackage'"));
});

test('authored native seventh coverage is real issued graph/COMMIT/whole-state evidence, never licensed/live acceptance',()=>{
 const f=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8');
 for(const s of ['[native-selected-reported-metric-traversal-owner-v2]','metrics_orphan_commit','metrics_row_rollback',
   'actual_row_head_checkpoint_yield_rollback_and_orphan_REAL_COMMIT_refused:true','synthetic_metrics_reclaim',
   'await authorityRefusal(pendingMetrics)','selectedCount+1','await metricsUnchanged(finishedMetrics)',
   'maximum_whole_owner_sql_queries:Math.max(...metricsQueries)','statistics:false,publication:false,licensed_acquisition:false,production_speed:false,worker_activation:false'])
   assert.ok(f.includes(s),s);
});
