import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createCustomCohortSelectedStatisticsV2Repository as repository} from '../src/services/neighborhoodAssessment/customCohortSelectedStatisticsV2Repository.js';
import {NEIGHBORHOOD_FIRST_SELECTED_FREQUENCY_ORIGINAL_PACKAGE_V2_SQL as originalSql} from '../src/services/neighborhoodAssessment/neighborhoodSelectedTransactionOriginalPackageV2.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,
  ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
  member={account_id:'B',ordinal:1,partition_ordinal:2,entry_reference:ref(4),state:'unassigned',assigned_group_id:null,
    row_reference:ref(5),contribution_row_reference:ref(6),numeric_index_ordinal:1,
    reported_year_built:null,reported_residential_area:null,reported_site_area:'0'};
function setup(next=member){
  const calls=[],options={client:{async query(text,values){calls.push({text,values});
    assert.ok(text.includes(':first-indexed-frequency-entry'));
    return {rowCount:1,rows:[next??Object.fromEntries(Object.keys(member).map(k=>[k,null]))]};}},
    claim:{operation_id:id(4),claim_token:id(5),attempts:2},
    scope:{organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'A'},actorUserId:id(6),
    command_id:id(3),union_reference:ref(1),eligibility_reference:ref(2),evidence_reference:ref(3),metrics_reference:ref(4)};
  return {owner:repository(options),calls,options};
}

test('separate native indexed fixed-first read requires actual eighth/member/reference and current exact14 claim, not a numeric roster',async()=>{
  const {owner,calls}=setup();assert.deepEqual(await owner.readFirstIndexedFrequencyEntry(),member);
  const text=calls[0].text;
  for(const s of ['m.ordinal=1','indexed.ordinal AS numeric_index_ordinal','indexed.reported_site_area::text',
    'indexed.operation_id=m.operation_id','indexed.organization_id=m.organization_id','indexed.ordinal=m.ordinal',
    'indexed.account_id=m.account_id','indexed.contribution_row_reference=m.row_reference',
    'metric.row_reference=m.metric_row_reference','entry.entry_reference=u.entry_reference',
    'h.metrics_reference=seventh.receipt_reference',"b.canonical_utf8::jsonb->'after'->>'done'='true'",
    'neighborhood_selected_statistics_v2_checkpoint_matches','job.claim_token=$2::uuid','job.actor_user_id=$8::uuid'])
    assert.ok(text.includes(s),s);
  assert.equal(calls[0].values.length,13);
  assert.doesNotMatch(text,/array_agg|jsonb_agg|OFFSET|::float|::real|round\(|\bINSERT\b|\bUPDATE\b|\bBEGIN\b|\bCOMMIT\b/);
  assert.equal(await setup(null).owner.readFirstIndexedFrequencyEntry(),null);
  assert.equal(createHash('sha256').update(originalSql).digest('hex'),'ebd4a370a12d9e7063a32d3c66cb972fcabf9b18fb47aa1e6df45cba815b29af');
});

test('native indexed read preserves exact numeric strings/null/zero and rejects missing child, malformed values and caller authority',async()=>{
  for(const patch of [{reported_site_area:null},{reported_year_built:'1600',reported_residential_area:'9007199254740993'},
    {reported_site_area:'0.000000000001'},{reported_site_area:'999999999999999999.999999999999'},
    {reported_site_area:'999999999999999999999999999999'}]){
    assert.deepEqual(await setup({...member,...patch}).owner.readFirstIndexedFrequencyEntry(),{...member,...patch});
  }
  for(const patch of [{numeric_index_ordinal:null},{numeric_index_ordinal:2},{ordinal:2},{row_reference:null},
    {contribution_row_reference:null},{partition_ordinal:0},{account_id:' B'},{state:'caller'},
    {reported_site_area:0},{reported_site_area:'1.0'},{reported_site_area:'0.0'},{reported_site_area:'01'},
    {reported_site_area:'-1'},{reported_site_area:'1e3'},{reported_site_area:'1x1'},{reported_site_area:'Infinity'},
    {reported_site_area:'0.0000000000001'},{reported_site_area:'1000000000000000000000000000000'},
    {reported_site_area:undefined},{extra:true}])await assert.rejects(setup({...member,...patch}).owner.readFirstIndexedFrequencyEntry());
  const {owner,calls,options}=setup();
  for(const arg of [undefined,1,{ordinal:1},()=>assert.fail('callback')])await assert.rejects(owner.readFirstIndexedFrequencyEntry(arg));
  assert.equal(calls.length,0);
  for(const key of ['ordinal','values','numericIndex','counts','readOriginal'])assert.throws(()=>repository({...options,[key]:true}));
  await assert.rejects(setup(new Proxy(member,{get(){assert.fail('proxy getter');}})).owner.readFirstIndexedFrequencyEntry());
  await assert.rejects(setup({...member,get reported_site_area(){assert.fail('getter');}}).owner.readFirstIndexedFrequencyEntry());
});

test('actual indexed owner reopens complete originals and every seventh/eighth field BEFORE exact index equality and ALL ending fences',()=>{
  const s=readFileSync(new URL('../src/services/neighborhoodAssessment/customCohortContextCapture.js',import.meta.url),'utf8'),
    start=s.indexOf('original_selected_first_indexed_refs_v2: {'),stage=s.slice(start,s.indexOf('\n});',start));
  for(const v of ['verifying: true','stockVerifying: true','identityVerifying: true',
    'readingSelectedUnionFirstAmenities: true','readingSelectedUnionFirstTransactions: true',
    'readingSelectedStatisticsSource: true','readingSelectedFrequencySource: true','readingSelectedNumericSource: true',
    "allowedPhases: ['frozen_selected_statistics_refs_v2']"])assert.ok(stage.includes(v),v);
  assert.doesNotMatch(stage,/progressingSelected|yieldingV2Progress/);
  const original=s.indexOf("'subjectAndFirstSelectedFrequencyAccountPackage'"),
    seventh=s.indexOf('if(!same(row,metricRowCandidate))',original),
    fresh=s.indexOf('statisticsContribution=prepareCohortSelectedStatisticsContributionV2',seventh),
    eighth=s.indexOf('if(!same(retainedContribution,statisticsContribution))',fresh),
    numeric=s.indexOf('if(firstSelectedEntry[key]!==statisticsContribution.metrics[key].contribution_exact_value)',eighth),
    ending=s.indexOf('if(!same(await boundedPolicy(authorizeMarketData',numeric),
    nativeEnding=s.indexOf('if(readingSelectedUnionFirstEligibility&&!same(await (readingSelectedFrequencySource?',ending),
    headEnding=s.indexOf('if((progressingSelectedStatistics||readingSelectedFrequencySource)&&!same(await statisticsStore.read(),statisticsAnchor))',nativeEnding),
    result=s.indexOf("result.status='current_authorized_first_selected_numeric_originals_reconciled'",headEnding);
  assert.ok(original>0&&seventh>original&&fresh>seventh&&eighth>fresh&&numeric>eighth&&ending>numeric&&nativeEnding>ending&&headEnding>nativeEnding&&result>headEnding);
  assert.equal((s.match(/readingSelectedNumericSource\?statisticsStore.readFirstIndexedFrequencyEntry\(\)/g)??[]).length,2);
  for(const v of ["fail('selected_numeric_original_mismatch')",'retained_numeric_index_reconciled=firstSelectedEntry!==null',
    'result.complete_indexed_metric_population=false','readOriginalFrozenCaptureJobFirstSelectedNumericReferencesV2',
    "frozenCaptureJobSourceStage(value, options, 'original_selected_first_indexed_refs_v2')"])assert.ok(s.includes(v),v);
  const response=s.slice(result,s.indexOf("if(progressingSelectedStatistics){",result));
  assert.ok(response.includes('result.selected_entry=firstSelectedEntry===null?null:Object.fromEntries'));
  assert.doesNotMatch(response,/reported_year_built|reported_residential_area|reported_site_area|saveCheckpoint|advance\(|yieldProgress/);
});

test('authored indexed cloud fixture uses independent issued graph, full prior-state rollback, fresh source faults and ending index changes',()=>{
  const s=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8'),
    frequencyAt=s.indexOf('frequencyAuthority=await readEvidenceAuthority()'),
    indexedAt=s.indexOf('// Separate indexed-source boundary:');
  assert.ok(frequencyAt>0&&indexedAt>frequencyAt,'indexed tests follow initialized frequency authority and presentation');
  for(const v of ['[native-first-selected-numeric-original-reconcile-owner-v2]','indexed_native_child_missing','indexed_value_wrong',
    'indexed_value_zero','indexed_value_ending','stats_row_cell','freq_row_state','freq_row_parts','freq_row_reasons',
    'metric_assignment_ending','metric_draft_ending','contributionUnchanged(finishedContributions)',
    'indexedQueries.every(n=>n>=0&&n<=ORIGINAL_OWNER_LIMITS.sql_queries)',
    'EVERY_seventh_eighth_field_and_native_indexed_value_null_compared_to_THIS_fresh_original:true',
    'complete_indexed_population:false,frequency_ledger:false,rank_queries:false,medians_COD:false,calendar_quarters:false',
    'publication:false,licensed_acquisition:false,production_speed:false,worker_activation:false'])assert.ok(s.includes(v),v);
  for(const v of ['nonvacuous indexed transport probe ${fault}: ${key}',
    'indexed authority probe ${fault}','indexed original/member probe ${fault}'])assert.ok(s.includes(v),v);
});

test('positive first-index source fixture is a fourth independently captured graph, never a rewrite of the three exclusion/EMPTY graphs',()=>{
  const s=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8'),
    fixtureAt=s.indexOf("for(const selectionWaitFixture of [false,true,'intent','union','union-empty','union-all','union-all-site-positive'])"),
    positiveAt=s.indexOf("const positiveIndexedSourceFixture=selectionWaitFixture==='union-all-site-positive'",fixtureAt),
    wholePartAt=s.indexOf('if(positiveIndexedSourceFixture)await pool.query("UPDATE gis.dcad_parcels SET class_code=\'A11\' WHERE object_id=4")',positiveAt),
    freezeAt=s.indexOf('const frozen=await runNeighborhoodGroupIndex(',positiveAt);
  assert.ok(fixtureAt>0&&positiveAt>fixtureAt&&wholePartAt>positiveAt&&freezeAt>wholePartAt,
    'only pristine disposable source data changes, before its own original/cache/generation issuance');
  const fixture=s.slice(positiveAt,freezeAt);
  assert.ok(fixture.includes("WHEN 4 THEN 'A12'"),'the three older independent graphs retain their actual outside-part housing contradiction');
  assert.ok(fixture.includes('parcel_area_sqft=8000'));
  assert.doesNotMatch(fixture,/neighborhood_cohort_evidence_blobs|neighborhood_custom_cohort_selected|checkpoint|claim_token|DISABLE TRIGGER|CASCADE/);
  for(const v of ["positiveIndexedSourceFixture?'observed':'conflicting'",
    "positiveIndexedSourceFixture?'detached_single_family':'townhouse'",
    "const allSelected=selectionWaitFixture==='union-all'||positiveIndexedSourceFixture",
    "reported_site_area:Number(positiveIndexedSourceFixture)",
    "reported_site_area:positiveIndexedSourceFixture?2:1",
    "account==='CLOSURE-A'?positiveIndexedSourceFixture:observedHousingFixture",
    "positiveIndexedSourceFixture?'8000':null"])assert.ok(s.includes(v),v);
});

test('positive first-index native success is coupled to genuine original contribution and separately refuses eligible value to NULL or zero',()=>{
  const s=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8');
  for(const v of ["'indexed_value_null'","fault==='indexed_value_null'?null:fault==='indexed_value_zero'?'0':'1'",
    "...(positiveIndexedSourceFixture?[['indexed_value_null',/selected_numeric_original_mismatch/]]:[])",
    "assert.equal(contribution.metrics.reported_site_area.recorded_comparison_eligible,true)",
    "assert.equal(contribution.metrics.reported_site_area.contribution_exact_value,'8000')",
    "assert.equal(finishedContributions.numeric_index[0].reported_site_area,'8000')",
    "assert.equal(finishedContributions.numeric_index[1].reported_site_area,'0')",
    "assert.equal(doneContribution.contribution_counts.reported_site_area.eligible_count,2)",
    'independently_issued_matching_first_positive_site_and_later_eligible_zero:positiveIndexedSourceFixture',
    'eligible_positive_to_NULL_and_zero_forgeries_refused:positiveIndexedSourceFixture'])assert.ok(s.includes(v),v);
  // The positive graph executes the SAME actual owner, source/rights failures,
  // snapshot comparisons, exact original plans and immutable budget assertions.
  const indexed=s.slice(s.indexOf('// Separate indexed-source boundary:'),s.indexOf("assert.deepEqual(await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).cancel",s.indexOf('// Separate indexed-source boundary:')));
  for(const v of ['indexedQueries.push(refsCalls.length-from-3)','await indexedStep()',
    'await contributionUnchanged(finishedContributions)',"['metric_assignment_ending',/assignment_access_denied/]",
    "['metric_draft_ending',/private_source_read_only/]",'NEIGHBORHOOD_FIRST_SELECTED_FREQUENCY_ORIGINAL_PACKAGE_V2_SQL',
    'indexedQueries.every(n=>n>=0&&n<=ORIGINAL_OWNER_LIMITS.sql_queries)',
    'complete_indexed_population:false,frequency_ledger:false,rank_queries:false,medians_COD:false,calendar_quarters:false',
    'publication:false,licensed_acquisition:false,production_speed:false,worker_activation:false'])assert.ok(indexed.includes(v),v);
});
