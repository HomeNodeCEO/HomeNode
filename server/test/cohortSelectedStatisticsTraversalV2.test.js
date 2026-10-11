import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createCustomCohortSelectedStatisticsV2Repository as repository} from '../src/services/neighborhoodAssessment/customCohortSelectedStatisticsV2Repository.js';
import {NEIGHBORHOOD_NEXT_SELECTED_STATISTICS_ORIGINAL_PACKAGE_V2_SQL as sql,
  NEIGHBORHOOD_FIRST_SELECTED_STATISTICS_ORIGINAL_PACKAGE_V2_SQL as first} from '../src/services/neighborhoodAssessment/neighborhoodSelectedTransactionOriginalPackageV2.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,
  ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
  member={account_id:'B',ordinal:1,partition_ordinal:2,entry_reference:ref(4),state:'unassigned',assigned_group_id:null,row_reference:ref(5)};
function setup({auto=false,next=member,corrupt=false,readback=false}={}){
  let head=null,tx=8;const calls=[],empty={command_id:null,union_reference:null,eligibility_reference:null,
    evidence_reference:null,metrics_reference:null,receipt_reference:null,sequence:null};
  const options={client:{async query(text,values){calls.push({text,values});
    if(text.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:String(auto?++tx:tx)}]};
    if(text.includes(':head-read'))return {rowCount:1,rows:[head??empty]};
    if(text.includes(':next-selected-entry'))return {rowCount:1,rows:[next??Object.fromEntries(Object.keys(member).map(k=>[k,null]))]};
    if(text.includes(':row-insert'))return {rowCount:1,rows:[{ordinal:values[14],row_reference:JSON.parse(values[13])}]};
    if(text.includes(':head-insert')){head={command_id:values[8],union_reference:JSON.parse(values[9]),eligibility_reference:JSON.parse(values[10]),
      evidence_reference:JSON.parse(values[11]),metrics_reference:JSON.parse(values[12]),receipt_reference:JSON.parse(values[13]),sequence:1};
      if(readback)head.metrics_reference=ref(9);return {rowCount:1,rows:[{sequence:corrupt?2:1}]};}
    if(text.includes(':head-advance')){head={...head,receipt_reference:JSON.parse(values[8]),sequence:values[9]};return {rowCount:1,rows:[{sequence:values[9]}]};}
    assert.fail(text);}},claim:{operation_id:id(4),claim_token:id(5),attempts:2},
    scope:{organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'A'},actorUserId:id(6),
    command_id:id(3),union_reference:ref(1),eligibility_reference:ref(2),evidence_reference:ref(3),metrics_reference:ref(4)};
  return {calls,options,owner:repository(options)};
}
test('eighth storage derives native seventh member and eighth next ordinal, CAS and EMPTY without source authority',async()=>{
  const {owner,calls}=setup();assert.equal(await owner.read(),null);assert.deepEqual(await owner.readNextSelectedEntry(),member);
  const h=await owner.advance(null,ref(6),ref(5));assert.equal(h.sequence,1);assert.deepEqual(h.metrics_reference,ref(4));
  assert.equal((await owner.advance(h,ref(7),null)).sequence,2);
  const next=calls.find(c=>c.text.includes(':next-selected-entry')).text,row=calls.find(c=>c.text.includes(':row-insert'));
  for(const s of ['m.ordinal=coalesce(h.sequence,0)+1','seventh.receipt_reference=$13::jsonb',
    'neighborhood_selected_statistics_v2_admission_matches','u.ordinal=m.ordinal AND u.account_id=m.account_id',
    'entry.entry_reference=u.entry_reference',"seventh_body.canonical_utf8::jsonb->'after'->>'done'='true'",
    'job.claim_token=$2::uuid','job.actor_user_id=$8::uuid'])assert.ok(next.includes(s),s);
  assert.equal(row.values.length,15);assert.equal(row.values[14],1);
  assert.match(row.text,/m.entry_reference,m.row_reference,\$14::jsonb/);
  assert.equal(calls.filter(c=>c.text.includes(':row-insert')).length,1);
  assert.equal(await setup({next:null}).owner.readNextSelectedEntry(),null);
  assert.ok(!calls.some(c=>/array_agg|jsonb_agg|ST_DWithin|FROM core\.|\bBEGIN\b|\bCOMMIT\b/.test(c.text)));
});
test('eighth storage refuses free cursors, callback authority, wrong parent/readback, stale CAS and autocommit',async()=>{
  const {owner,calls,options}=setup();
  for(const v of [undefined,1,{ordinal:1},()=>assert.fail('callback')]){
    await assert.rejects(owner.read(v));await assert.rejects(owner.readNextSelectedEntry(v));}
  for(const a of [[],[null],[null,ref(6)],[null,ref(6),ref(5),true]])await assert.rejects(owner.advance(...a));
  assert.equal(calls.length,0);
  for(const key of ['ordinal','cursor','decision','counts','readOriginal','selected_accounts'])assert.throws(()=>repository({...options,[key]:true}));
  assert.throws(()=>repository({...options,get metrics_reference(){assert.fail('getter');}}));
  await assert.rejects(setup({auto:true}).owner.advance(null,ref(6),ref(5)),/caller_transaction_required/);
  await assert.rejects(setup({corrupt:true}).owner.advance(null,ref(6),ref(5)),/corrupt/);
  await assert.rejects(setup({readback:true}).owner.advance(null,ref(6),ref(5)),/binding_changed/);
  for(const patch of [{row_reference:null},{ordinal:0},{partition_ordinal:0},{state:'caller'}])
    await assert.rejects(setup({next:{...member,...patch}}).owner.readNextSelectedEntry());
  const h=await owner.advance(null,ref(6),null);await assert.rejects(owner.advance(null,ref(7),null),/conflict/);
  assert.equal(h.sequence,1);
});
test('eighth SQL is additive native next ordinal with unchanged fixed-first plan and all aggregate/raw gates',()=>{
  assert.equal(createHash('sha256').update(first).digest('hex'),'6d2d2c9117cc625801fca8f9e825ef215fd0a7f027180ef74a6d0f6ae24e687e');
  for(const s of ['neighborhood-next-selected-statistics-original-package-v2','r.ordinal=coalesce(statistics.sequence,0)+1',
    'statistics.operation_id=job.operation_id AND statistics.organization_id=job.organization_id',
    'neighborhood_selected_statistics_v2_admission_matches',"metrics_body.canonical_utf8::jsonb->'after'->>'done'='true'",
    "evidence_body.canonical_utf8::jsonb->'after'->>'done'='true'","fifth_body.canonical_utf8::jsonb->'after'->>'done'='true'",
    '(SELECT coalesce(sum(n),0) FROM all_totals)<=$5::integer','cad_totals AS MATERIALIZED','raw_gate AS MATERIALIZED'])assert.ok(sql.includes(s),s);
  assert.equal((sql.match(/AND NOT \(SELECT oversize FROM raw_gate\)/g)??[]).length,3);
  assert.doesNotMatch(sql,/r.ordinal=1 AND|r.account_id=\$|\bINSERT\b|\bUPDATE\b|FROM core\./);
});
test('native eighth guards retain strict old grammar, exact14 parents, immutable contribution/counters and atomic continuation',()=>{
  const name='20261129_custom_cohort_selected_statistics_v2.sql',
    m=readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'),
    registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8');
  assert.ok(registry.indexOf(name)>registry.indexOf('20261128_custom_cohort_selected_metrics_v2.sql'));
  for(const s of ["jsonb_array_length(cp->'evidence_refs')=14","(cp->'evidence_refs')-13","cp->'evidence_refs'->13=h.receipt_reference",
    'neighborhood_selected_statistics_v2_admission_matches','jsonb_object_keys(cell))<>8',"body->'before_counts' IS DISTINCT FROM before_counts",
    "body->'after_counts' IS DISTINCT FROM after_counts",'u.row_reference=NEW.metric_row_reference','NEW.ordinal<>coalesce(h.sequence,0)+1',
    'DEFERRABLE INITIALLY DEFERRED','neighborhood_selected_statistics_v2_orphan_row','neighborhood_selected_statistics_v2_orphan_progress',
    "h.metrics_reference=OLD.progress_reference","OLD.consumed_claim_token IS NULL",'NEW.issued_attempts<OLD.issued_attempts',
    "OLD.phase='frozen_selected_statistics_refs_v2' AND NEW.phase<>'frozen_selected_statistics_refs_v2'",
    "OLD.phase='frozen_selected_evidence_refs_v2' AND NEW.phase NOT IN ('frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2')",
    "NEW.phase='frozen_selected_metrics_refs_v2' AND OLD.phase NOT IN ('frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2')",
    'CHECK(sequence BETWEEN 1 AND 16000008)',"jsonb_object_keys(body))<>16","jsonb_object_keys(row_body))<>17"])assert.ok(m.includes(s),s);
  assert.equal((m.match(/END \$\$;/g)??[]).length,7);
  assert.doesNotMatch(m,/->'[^']+'-ARRAY|NEW.phase<>'[^']+','|DISABLE TRIGGER|DROP TRIGGER|DROP TABLE|UPDATE app\.report|ST_DWithin/);
});
test('actual bounded original owner reconciles every native row, all ending authority, then writes eighth atomically',()=>{
  const s=readFileSync(new URL('../src/services/neighborhoodAssessment/customCohortContextCapture.js',import.meta.url),'utf8'),
    fresh=s.indexOf('if(!same(row,metricRowCandidate))'),policy=s.indexOf('statisticsContribution=prepareCohortSelectedStatisticsContributionV2',fresh),
    ending=s.indexOf("if((progressingSelectedStatistics||readingSelectedFrequencySource)&&!same(await statisticsStore.read(),statisticsAnchor))",policy),
    count=s.indexOf('advanceCohortSelectedStatisticsCountsV2(statisticsCounts',ending),row=s.indexOf('const rowReference=statisticsCandidate===null?',count),
    head=s.indexOf('statisticsStore.advance(',row),cp=s.indexOf("phase:'frozen_selected_statistics_refs_v2'",head),
    yieldAt=s.indexOf('yieldIssued(claim,jobOptions)',cp);
  assert.ok(fresh>0&&policy>fresh&&ending>policy&&count>ending&&row>count&&head>row&&cp>head&&yieldAt>cp);
  assert.ok(s.includes("'readForStatisticsContributions'"));assert.ok(s.includes("'subjectAndNextSelectedStatisticsAccountPackage'"));
  assert.ok(s.includes('afterCounts[k].eligible_count!==metricsIssued.after_counts[k]||afterCounts[k].eligible_count!==eligibilityIssued.after_counts[k]'));
  const intent=readFileSync(new URL('../src/services/neighborhoodAssessment/customCohortV2SelectionIntentRepository.js',import.meta.url),'utf8'),
    additive=intent.slice(intent.indexOf('async readForStatisticsContributions('));
  assert.ok(additive.includes("roots.length!==(cp.phase==='frozen_selected_metrics_refs_v2'?13:14)"));
  assert.ok(additive.includes('neighborhood_selected_statistics_v2_admission_matches'));
  assert.ok(intent.slice(intent.indexOf('async readForStatistics('),intent.indexOf('async readForStatisticsContributions(')).includes('roots.length!==13'));
});
test('authored native eighth coverage retains real rollback/COMMIT and five-attempt ceiling, never licensed/full statistics',()=>{
  const s=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8');
  for(const v of ['[native-selected-statistics-contribution-traversal-owner-v2]','stats_orphan_commit','stats_row_rollback',
    'synthetic_contribution_reclaim','every_native_seventh_row_field_reconciled_before_fresh_policy_and_ending_fences:true',
    'await contributionRefusals(pendingContributions)','assert.equal(replacement.attempts,5)',
    'maximum_whole_owner_sql_queries:Math.max(...contributionQueries)','genuine_site_zero_not_null:allSelected',
    'frequency_ledger:false,exact_distributions:false,statistics:false,publication:false,licensed_acquisition:false,production_speed:false,worker_activation:false'])
    assert.ok(s.includes(v),v);
});
