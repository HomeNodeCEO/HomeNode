import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createCustomCohortSelectedSemanticV2Repository as repository}
  from '../src/services/neighborhoodAssessment/customCohortSelectedSemanticV2Repository.js';
import {NEIGHBORHOOD_NEXT_SELECTED_SEMANTIC_ORIGINAL_PACKAGE_V2_SQL as SQL}
  from '../src/services/neighborhoodAssessment/neighborhoodSelectedTransactionOriginalPackageV2.js';
import {createCustomCohortCaptureJobRepository} from '../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
  keys=['union_reference','eligibility_reference','evidence_reference','metrics_reference','statistics_reference','numeric_reference'],
  refs=Object.fromEntries(keys.map((k,i)=>[k,ref(i+1)])),
  member={account_id:'B',ordinal:1,partition_ordinal:2,entry_reference:ref(4),state:'unassigned',assigned_group_id:null,row_reference:ref(5),
    contribution_row_reference:ref(6),numeric_index_ordinal:1,numeric_population_ordinal:1,
    reported_year_built:null,reported_residential_area:'9007199254740993.000000000001',reported_site_area:'0'};
function setup({next=member,auto=false,readback=false,rows=1,lateTransaction=false,badTransaction=false}={}){
  let head=null,tx=8;const calls=[],options={client:{async query(text,values){calls.push({text,values});
    if(text.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:String(auto?++tx:tx)}]};
    if(text.includes(':head-read'))return {rowCount:1,rows:[{
      ...(text.includes('txid_current()::text AS transaction_id,')?{transaction_id:badTransaction?'0':head&&lateTransaction?'999':String(auto?++tx:tx)}:{}),
      ...(head??{command_id:null,...Object.fromEntries(keys.map(k=>[k,null])),receipt_reference:null,sequence:null})}]};
    if(text.includes(':first-completed-selected-entry'))return {rowCount:1,rows:[next===null
      ?Object.fromEntries([...Object.keys(member),'semantic_population_ordinal'].map(k=>[k,null]))
      :{semantic_population_ordinal:1,...next}]};
    if(text.includes(':next-selected-entry'))return {rowCount:1,rows:[next??Object.fromEntries(Object.keys(member).map(k=>[k,null]))]};
    if(text.includes(':row-insert'))return {rowCount:rows,rows:Array.from({length:rows},()=>({ordinal:values[15]}))};
    if(text.includes(':head-insert')){head={command_id:values[8],...Object.fromEntries(keys.map((k,i)=>[k,JSON.parse(values[i+9])])),
      receipt_reference:JSON.parse(values[15]),sequence:1};if(readback)head.numeric_reference=ref(9);return {rowCount:1,rows:[{sequence:1}]};}
    if(text.includes(':head-advance')){assert.deepEqual(JSON.parse(values[17]),head.receipt_reference);assert.equal(values[18],head.sequence);
      head={...head,receipt_reference:JSON.parse(values[15]),sequence:values[16]};return {rowCount:1,rows:[{sequence:values[16]}]};}
    assert.fail(text);}},claim:{operation_id:id(4),claim_token:id(5),attempts:5},
    scope:{organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'A'},actorUserId:id(6),command_id:id(3),...refs};
  return {calls,options,owner:repository(options)};
}

test('tenth repository derives its OWN native next ordinal and reference-only row joined to complete ninth, eighth, index, seventh and union',async()=>{
  const {owner,calls}=setup();assert.equal(await owner.read(),null);assert.deepEqual(await owner.readNextSelectedEntry(),member);
  const h=await owner.advance(null,ref(7));assert.equal(h.sequence,1);assert.equal((await owner.advance(h,ref(8))).sequence,2);
  const next=calls.find(c=>c.text.includes(':next-selected-entry')),row=calls.find(c=>c.text.includes(':row-insert'));
  assert.equal(next.values.length,15);assert.equal(row.values.length,16);assert.equal(row.values[15],1);
  for(const text of ['m.ordinal=coalesce(h.sequence,0)+1','n.contribution_row_reference=m.row_reference','n.metric_row_reference=m.metric_row_reference',
    'indexed.contribution_row_reference=m.row_reference','metric.row_reference=m.metric_row_reference','entry.entry_reference=u.entry_reference',
    'numeric_parent.receipt_reference=$15::jsonb',"numeric_body.canonical_utf8::jsonb->'after'->>'done'='true'",
    'neighborhood_selected_semantic_v2_admission_matches','job.actor_user_id=$8::uuid','job.lease_expires_at>clock_timestamp()'])assert.ok(next.text.includes(text),text);
  assert.doesNotMatch(row.text,/reported_site_area|reported_year_built|reported_residential_area/);
  assert.ok(calls.every(c=>!/array_agg|jsonb_agg|ST_DWithin|FROM core\.|\bBEGIN\b|\bCOMMIT\b/.test(c.text)));
  assert.equal(await setup({next:null}).owner.readNextSelectedEntry(),null);
  assert.equal((await setup({rows:0}).owner.advance(null,ref(7))).sequence,1,'native guard, not caller flag, decides EMPTY');
});

test('closed storage rejects caller ordinal/value/summary authority, missing ninth/index, malformed decimals, hostile rows and autocommit',async()=>{
  const {owner,calls}=setup();for(const args of [[undefined],[1],[{ordinal:1}],[()=>assert.fail('callback')]]){
    await assert.rejects(owner.read(...args));await assert.rejects(owner.readNextSelectedEntry(...args));}
  assert.equal(calls.length,0);await assert.rejects(owner.advance(null,ref(7),{done:true}));
  for(const patch of [{numeric_population_ordinal:null},{numeric_population_ordinal:2},{numeric_index_ordinal:null},
    {reported_site_area:0},{reported_site_area:'0.0'},{reported_residential_area:'1e3'},{reported_residential_area:'-1'},
    {extra:true},{contribution_row_reference:null},{account_id:' B'}])await assert.rejects(setup({next:{...member,...patch}}).owner.readNextSelectedEntry());
  await assert.rejects(setup({next:new Proxy(member,{get(){assert.fail('proxy');}})}).owner.readNextSelectedEntry());
  await assert.rejects(setup({next:{...member,get ordinal(){assert.fail('getter');}}}).owner.readNextSelectedEntry());
  await assert.rejects(setup({auto:true}).owner.advance(null,ref(7)),/caller_transaction_required/);
  await assert.rejects(setup({readback:true}).owner.advance(null,ref(7)),/binding_changed/);
});

test('separate fixed first reader requires exact16 tenth DONE and every native member without writing or accepting a cursor',async()=>{
  const {owner,calls}=setup();assert.deepEqual(await owner.readFirstCompletedSelectedEntry(),member);
  assert.equal(calls.length,1);const q=calls[0];assert.equal(q.values.length,15);
  for(const text of ['m.ordinal=1','s.ordinal=m.ordinal','s.account_id=m.account_id','s.partition_ordinal=m.partition_ordinal',
    's.entry_reference=m.entry_reference','s.metric_row_reference=m.metric_row_reference','s.contribution_row_reference=m.row_reference',
    'neighborhood_selected_semantic_v2_checkpoint_matches',"semantic_body.canonical_utf8::jsonb->'after'->>'done'='true'",
    'job.actor_user_id=$8::uuid','job.lease_expires_at>clock_timestamp()'])assert.ok(q.text.includes(text),text);
  assert.doesNotMatch(q.text,/INSERT|UPDATE|DELETE|array_agg|jsonb_agg|coalesce\(h.sequence,0\)\+1/);
  assert.equal(await setup({next:null}).owner.readFirstCompletedSelectedEntry(),null);
  for(const semantic_population_ordinal of [null,0,2,'1'])await assert.rejects(
    setup({next:{...member,semantic_population_ordinal}}).owner.readFirstCompletedSelectedEntry(),/semantic_population_missing_or_corrupt/);
  const closed=setup();for(const args of [[undefined],[1],[{ordinal:1}],[()=>assert.fail('callback')]])
    await assert.rejects(closed.owner.readFirstCompletedSelectedEntry(...args),/invalid_input/);
  assert.equal(closed.calls.length,0);
});

test('coalesced native transaction identities retain pre-DML autocommit refusal and post-DML same-transaction readback in five queries',async()=>{
  const success=setup();assert.equal((await success.owner.advance(null,ref(7))).sequence,1);
  assert.equal(success.calls.length,5);assert.equal(success.calls.filter(c=>c.text.includes(':transaction')).length,1);
  assert.equal(success.calls.filter(c=>c.text.includes(':head-read')&&c.text.includes('txid_current()::text AS transaction_id,')).length,2);
  assert.ok(!Object.hasOwn(await success.owner.read(),'transaction_id'),'public head shape remains exact, never exposes internal tx identity');
  for(const options of [{auto:true},{badTransaction:true}]){
    const denied=setup(options);await assert.rejects(denied.owner.advance(null,ref(7)),/caller_transaction_required/);
    assert.equal(denied.calls.length,2);assert.ok(!denied.calls.some(c=>/:row-insert|:head-insert|:head-advance/.test(c.text)),
      'transaction mismatch is refused BEFORE any reference DML');
  }
  const late=setup({lateTransaction:true});await assert.rejects(late.owner.advance(null,ref(7)),/corrupt/);
  assert.equal(late.calls.length,5);assert.ok(late.calls.some(c=>c.text.includes(':row-insert')));
  assert.ok(late.calls.some(c=>c.text.includes(':head-insert')),'post-write transaction/readback mismatch must not return success');
});

test('tenth checkpoint is exact16 before SQL and does not broaden strict15 ninth grammar',async()=>{
  const claim={operation_id:id(4),claim_token:id(5),attempts:5},options={scope:{organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'A'},actorUserId:id(6)};
  for(const phase of ['frozen_selected_semantic_refs_v2','frozen_selected_numeric_refs_v2'])for(const n of [0,14,15,16,17]){
    const checkpoint={phase,evidence_refs:Array(n).fill(ref(1))},owner=createCustomCohortCaptureJobRepository({async query(){return {rowCount:1,rows:[{checkpoint}]};}});
    if(n===(phase==='frozen_selected_semantic_refs_v2'?16:15))assert.deepEqual(await owner.readCheckpoint(claim,options),checkpoint);
    else await assert.rejects(owner.readCheckpoint(claim,options),/invalid_checkpoint/);
  }
});

test('separate tenth source query opens COMPLETE original package with cursor derived only from native tenth head and exact15/16 admission',()=>{
  for(const text of ['neighborhood-next-selected-semantic-original-package-v2','r.ordinal=coalesce(semantic.sequence,0)+1',
    'neighborhood_selected_semantic_v2_admission_matches','app.neighborhood_custom_cohort_selected_semantic_v2_heads semantic',
    'all_totals','raw_gate','typed_bytes','original_bytes'])assert.ok(SQL.includes(text),text);
  assert.doesNotMatch(SQL,/array_agg|jsonb_agg|OFFSET\s+(?!0\b)|::float|::real/);
});

test('native tenth schema independently verifies exact ranks ONCE, original-linked counts/sums/deviations, EMPTY and atomic exact16 continuation',()=>{
  const schema=readFileSync(new URL('../migrations/20261203_custom_cohort_selected_semantic_v2.sql',import.meta.url),'utf8');
  for(const text of ['jsonb_array_length(cp->\'evidence_refs\')=16','neighborhood_selected_numeric_v2_checkpoint_matches',
    "b.canonical_utf8::jsonb->'after'->>'done'='true'",'NEW.ordinal<>coalesce(h.sequence,0)+1','n.contribution_row_reference=m.row_reference',
    'expected_ranks:=app.neighborhood_selected_semantic_v2_initial_ranks','expected_ranks:=previous_summary->\'ranks\'',
    'app.neighborhood_selected_statistics_v2_next_counts(before_counts,contribution->\'metrics\')','old_sum:=old_sum+value*100000000000000',
    'old_deviation:=old_deviation+abs(value*100000000000000-median)','before_counts IS DISTINCT FROM parent->\'after_counts\'',
    'DEFERRABLE INITIALLY DEFERRED','neighborhood_selected_semantic_v2_orphan_progress','neighborhood_selected_semantic_v2_orphan_row',
    "job.claim_token IS NOT NULL OR job.lease_expires_at IS NOT NULL",'BEFORE TRUNCATE'])assert.ok(schema.includes(text),text);
  assert.doesNotMatch(schema,/CREATE OR REPLACE|ALTER FUNCTION|DISABLE TRIGGER|\bGRANT\b|SET session_replication_role|::float|::real/);
  const rows=schema.slice(schema.indexOf('CREATE TABLE app.neighborhood_custom_cohort_selected_semantic_v2_rows'),
    schema.indexOf('CREATE TABLE app.neighborhood_custom_cohort_selected_semantic_v2_heads'));
  assert.doesNotMatch(rows,/payload|reported_site_area|reported_residential_area|sum_scaled14|original_text/);
  const owner=readFileSync(new URL('../migrations/20261204_custom_cohort_selected_semantic_owner_v2.sql',import.meta.url),'utf8');
  for(const text of ['frozen_selected_semantic_refs_v2','neighborhood_selected_semantic_v2_checkpoint_matches','20000010',
    "OLD.checkpoint->>'phase'='frozen_selected_numeric_refs_v2'",'job.attempts<>NEW.issued_attempts',
    "OLD.phase='frozen_selected_statistics_refs_v2' AND NEW.phase NOT IN ('frozen_selected_statistics_refs_v2','frozen_selected_numeric_refs_v2')",
    "NEW.phase='frozen_selected_numeric_refs_v2' AND OLD.phase NOT IN ('frozen_selected_statistics_refs_v2','frozen_selected_numeric_refs_v2')",
    "NEW.phase='frozen_selected_semantic_refs_v2' AND OLD.phase NOT IN ('frozen_selected_numeric_refs_v2','frozen_selected_semantic_refs_v2')",
    'h.numeric_reference=OLD.progress_reference'])assert.ok(owner.includes(text),text);
});

test('actual tenth owner compares all originals and members, rechecks ending authority, then writes bounded summaries and reference rows in same transaction',()=>{
  const s=readFileSync(new URL('../src/services/neighborhoodAssessment/customCohortContextCapture.js',import.meta.url),'utf8'),
    original=s.indexOf("'subjectAndNextSelectedSemanticAccountPackage'"),seventh=s.indexOf('if(!same(row,metricRowCandidate))',original),
    eighth=s.indexOf('if(!same(retainedContribution,statisticsContribution))',seventh),
    index=s.indexOf('if(firstSelectedEntry[key]!==statisticsContribution.metrics[key].contribution_exact_value)',eighth),
    ranks=s.indexOf('provisionalRankCandidates=await createCustomCohortSelectedNumericRankCandidatesV2Repository',index),
    rights=s.indexOf('if(!same(await boundedPolicy(authorizeMarketData',ranks),ending=s.indexOf('if(progressingSelectedSemantic&&(!same(await numericStore.read()',rights),
    summary=s.indexOf('const afterSummary=advanceCohortSelectedSemanticSummaryV2',ending),put=s.indexOf('await blobs.put',summary),
    advance=s.indexOf('await semanticStore.advance',put),checkpoint=s.indexOf("phase:'frozen_selected_semantic_refs_v2'",advance),yielding=s.indexOf('.yieldIssued(claim,jobOptions)',checkpoint);
  assert.ok(original>0&&seventh>original&&eighth>seventh&&index>eighth&&ranks>index&&rights>ranks&&ending>rights&&summary>ending&&put>summary&&advance>put&&checkpoint>advance&&yielding>checkpoint);
  assert.ok(s.includes('progressingSelectedSemantic&&semanticAnchor===null'));
  const body=s.slice(summary,s.indexOf('if(readingSelectedRankCandidates)',summary));
  for(const text of ['firstSelectedEntry===null','finalizeCohortSelectedSemanticSummaryV2','statisticsCounts','evidence_refs:[...checkpoint.evidence_refs.slice(0,15),receiptReference]',
    "calendar_quarters:'not_established'","publication:'not_established'",'context_complete:false,pin_transfer:false'])assert.ok(body.includes(text),text);
  assert.doesNotMatch(body,/selected_accounts|callback|\.map\(.*original|prepareGeneration|publishContext|Number\(.*value/);
});

test('tenth owner freshly batches ONLY fixed issued receipts after current source rights, never original pages or native head authority',()=>{
  const s=readFileSync(new URL('../src/services/neighborhoodAssessment/customCohortContextCapture.js',import.meta.url),'utf8'),
    start=s.indexOf('const issuedCheckpointReceipts=progressingSelectedSemantic?checkpoint.evidence_refs.slice(3):null'),
    end=s.indexOf('const binding={...scope',start),body=s.slice(start,end),
    cad=s.lastIndexOf('const cadDecision=readingCadSource?await boundedPolicy',start),
    market=s.lastIndexOf('const decision=await boundedPolicy(authorizeMarketData',cad);
  assert.ok(market>0&&cad>market&&start>cad&&end>start,'both current policies precede bounded progress receipt reads');
  for(const text of ['[12,13].includes(issuedCheckpointReceipts.length)','Number(ref.canonical_utf8_bytes)>16000',
    'offset+=NEIGHBORHOOD_COHORT_BLOB_READ_BATCH_LIMITS.records','await blobs.getPreparedBatch(issuedCheckpointReceipts.slice(offset,',
    "if(body===null)fail('checkpoint_conflict')",'Object.freeze(issuedCheckpointReceipts);Object.freeze(issuedCheckpointTexts)',
    'if(issuedCheckpointReceipts===null)return blobs.get(ref.content_sha256,ref.canonical_utf8_bytes)',
    'findIndex(expected=>same(expected,ref))',"if(index<0)fail('checkpoint_conflict')"])assert.ok(body.includes(text),text);
  assert.equal((s.match(/await readIssuedCheckpointReceipt\(/g)??[]).length,13);
  for(const anchor of ['graphAnchor','geographicAnchor','identityAnchor','traversalAnchor','partitionAnchor','catalogAnchor','unionAnchor',
    'eligibilityAnchor','evidenceAnchor','metricsAnchor','statisticsAnchor','numericAnchor','semanticAnchor']){
    const read=s.indexOf(`await readIssuedCheckpointReceipt(${anchor}.receipt_reference)`);
    assert.ok(read>start&&s.lastIndexOf(`${anchor}=await`,read)>start,`${anchor} still independently reopened`);
    assert.ok(s.slice(Math.max(start,read-700),read).includes("fail('checkpoint_conflict')"),`${anchor} checked before its body is used`);
  }
  assert.doesNotMatch(body,/blobs\.get\s*=|readOriginal|source_original|selected_accounts|\.put\(|new Map|callback/);
  assert.ok(s.includes('{put:text=>blobs.put(text),get:(hash,size)=>blobs.get(hash,size)},binding,'),
    'whole original source graph still uses fresh ordinary original reads');
  assert.ok(s.includes('const summaryText=await blobs.get(semanticIssued.after_summary_reference.content_sha256'));
  const blob=readFileSync(new URL('../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js',import.meta.url),'utf8');
  assert.ok(blob.includes('NEIGHBORHOOD_COHORT_BLOB_READ_BATCH_LIMITS = Object.freeze({ records: 8, bytes: 2_000_000 })'));
});

test('cloud tenth probes are nonvacuous actual-owner and native grammar tests across all five retained graphs, not synthetic acquisition acceptance',()=>{
  const fixture=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8'),
    start=fixture.indexOf('// Tenth ACTUAL complete-original semantic owner.'),
    end=fixture.indexOf('[native-selected-semantic-original-owner-v2]',start),probe=fixture.slice(start,end),
    hook=fixture.slice(fixture.indexOf("if(config.text.includes('neighborhood-frozen-job-closure:parcels')"),
      fixture.indexOf('if(config.text===NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.read'));
  assert.ok(start>0&&end>start);
  assert.ok(hook.includes('config.text===NEIGHBORHOOD_NEXT_SELECTED_SEMANTIC_ORIGINAL_PACKAGE_V2_SQL'));
  assert.ok(hook.includes("!fault?.startsWith('semantic_')"));
  for(const text of ['semanticStep()','semanticUnchanged(semanticInitial)','semantic_orphan_commit','e=>e.outcome_unknown===true',
    "'subject',/subject_changed/","'claim',/claim_lost/","'cad_license',/market_data_access_denied/",'assert.equal(refsFault,null)',
    'for(let ordinal=1;ordinal<=selectedCount+1;ordinal++)','state.job.checkpoint.evidence_refs.length,16',
    'summary.counts,JSON.parse(finishedContributions.heads[0].canonical_utf8).after_counts',
    "['rank','sum','deviation','observed','reason']",'actual native semantic forgery',
    ".failClaim(liveClaim,'synthetic_semantic_terminal_reclaim'",'for(const expectedAttempt of [4,5])',
    'liveClaim.attempts,3','stale.attempts,expectedAttempt-1','pending.job.attempts,stale.attempts',
    "pending.job.status,'retry'",'pending.job.claim_token,null','pending.job.lease_expires_at,null',
    'pending.job.checkpoint,semanticFinished.job.checkpoint','replacement.attempts,expectedAttempt',
    'replacement.claim_token,stale.claim_token','recovered.job.attempts,expectedAttempt','liveClaim.attempts,5',
    'semanticQueries.every(n=>n>=0&&n<=ORIGINAL_OWNER_LIMITS.sql_queries)'])assert.ok(probe.includes(text),text);
  for(const text of ['semanticAutocommitCalls.push(text)','return pool.query(text,values)',
    'semanticAutocommitCalls.length,2','semanticUnchanged(semanticInitial)',
    'txid_current()::text AS transaction_id,','Math.max(...semanticQueries)<=241',
    'custom-cohort-selected-semantic-v2:transaction',
    'custom-cohort-selected-semantic-v2:head-read'])assert.ok(probe.includes(text),text);
  for(const text of ['semantic_receipt_batch_missing','semantic_receipt_batch_duplicate','semantic_receipt_batch_bytes',
    "for(const source of ['market','cad'])",'real CURRENT source denial precedes even the fixed receipt batch',
    'refsQueryParameters[from+i]','receiptReferences=before.job.checkpoint.evidence_refs.slice(3)',
    'receiptBatches.length,2','[8,receiptReferences.length-8]',
    'receiptReferences.map(ref=>ref.content_sha256)','receiptReferences.map(ref=>Number(ref.canonical_utf8_bytes))',
    'params[0]===organization','params[1].length<=8','bytes<=16000','0)<=2000000',
    'each successful step STILL freshly opens the actual whole original packet independently'])assert.ok(probe.includes(text),text);
  for(const text of ['semanticRecoveryFixture&&ordinal===1','retained.semantic_rows.length,1',
    'selected_ordinal:1,done:false','retained.job.attempts,4',".failClaim(liveClaim,'synthetic_semantic_prefix_reclaim'",
    "pending.job.status,'retry'",'pending.job.claim_token,null','pending.job.lease_expires_at,null',
    'pending.job.checkpoint,retained.job.checkpoint','replacement.attempts,5',
    'replacement.claim_token,staleSemanticClaim.claim_token','recovered.job.checkpoint,retained.job.checkpoint',
    'captureJobClaim:staleSemanticClaim','semanticUnchanged(recovered)',
    'deniedFrom=refsCalls.length','NEIGHBORHOOD_NEXT_SELECTED_SEMANTIC_ORIGINAL_PACKAGE_V2_SQL',
    'semanticFinished.semantic_rows[0],semanticRecoveredPrefix.semantic_rows[0]',
    "semanticFinished.semantic_rows.map(row=>row.account_id),['CLOSURE-A','CLOSURE-B']",
    "semanticFinished.job.last_error_code,'synthetic_semantic_prefix_reclaim'"
  ])assert.ok(probe.includes(text),text);
  assert.ok(fixture.includes("'union-all-semantic-recovery'"),'additional independently captured graph, not a rewrite of an old graph');
  assert.ok(fixture.includes('positiveIndexedSourceFixture&&!semanticRecoveryFixture&&ordinal===1'));
  assert.ok(fixture.includes('actual_ninth_ordinary_failure_and_fifth_claim_resume:positiveIndexedSourceFixture&&!semanticRecoveryFixture'));
  assert.doesNotMatch(probe,/SET attempts|attempts=0|attempts:6|DISABLE TRIGGER|session_replication_role/);
});
