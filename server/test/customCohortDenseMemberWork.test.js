import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCustomCohortIndexedObservationPreview as indexed,
  customCohortObservationMembers as members, CUSTOM_COHORT_OBSERVATION_PREVIEW_LIMITS as L }
  from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { legacyIndexedMemberWorkOracle as legacy } from './fixtures/customCohortLegacyMemberWorkFixture.js';
import { denseMemberWorkFixture } from './fixtures/customCohortDenseMemberWorkFixture.js';
import { canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';

test('dense first-open full union of 39700 stock and 2500 sales preserves exact output below unchanged 500k work',async t=>{
  const args=await denseMemberWorkFixture();
  assert.equal(L.member_work,500000);
  assert.throws(()=>legacy(args),/custom_cohort_observation_preview_member_work_limit/,
    'the frozen 907b724 indexed kernel must reproduce the original refusal');
  // Only the test-only frozen oracle gets a larger allowance to finish the
  // original calculations. Production receives no override and keeps 500000.
  const expected=legacy(args,2000000),actual=indexed(args);
  assert.equal(expected.work.member_work,521400);
  assert.equal(actual.work.member_work,288200);
  assert.ok(actual.work.member_work<L.member_work);
  const {work:oldWork,...oldOutput}=expected,{work:newWork,...newOutput}=actual;
  assert.deepEqual(newOutput,oldOutput,'all observations/statistics/provenance/indices and support gaps remain exact');
  assert.equal(newWork.source_records,oldWork.source_records);
  assert.equal(newWork.measurement_values,oldWork.measurement_values);
  assert.equal(newWork.output_utf8_bytes_bound,oldWork.output_utf8_bytes_bound);
  assert.equal(newWork.source_records,121600);
  assert.equal(actual.member_tables.stock.length,39700);
  assert.equal(actual.member_tables.transactions.length,2500);
  assert.equal(actual.member_tables.source_reported.length,2500);
  assert.deepEqual(actual.selected.account_ids,args.retained_inputs.spatial.account_ids);
  assert.equal(actual.pockets.length,1);
  for(const population of [actual.all,actual.selected,actual.pockets[0].result]) {
    assert.equal(population.stock.member_count,39700);
    assert.equal(population.transactions.member_count,2500);
    assert.equal(population.source_reported.member_count,2500);
    assert.deepEqual(members(actual,population,'stock').map(row=>row.account_id),args.retained_inputs.spatial.account_ids);
    assert.strictEqual(members(actual,population,'stock')[0],actual.member_tables.stock[0]);
    assert.deepEqual(population.stock.metrics,expected.all.stock.metrics);
  }
  assert.equal(actual.source_snapshots.length,expected.source_snapshots.length);
  assert.ok(newWork.output_utf8_bytes_bound<=64000000);
  const outputBytes=Buffer.byteLength(JSON.stringify(actual));
  assert.ok(outputBytes<=newWork.output_utf8_bytes_bound);
  const capture=args.retained_inputs.acquisition.capture_result.source_capture;
  const envelopes=new Set();
  let inputBytes=0,captureBytes=0,recordCount=0;
  for(const {payload} of capture.sources) {
    captureBytes+=Buffer.byteLength(canonicalAssessmentJson(payload));
    recordCount+=payload.records.length;
    for(const record of payload.records) inputBytes+=Buffer.byteLength(canonicalAssessmentJson(record));
    if(!envelopes.has(payload.metadata.id)) {
      envelopes.add(payload.metadata.id);
      inputBytes+=Buffer.byteLength(canonicalAssessmentJson({...payload,
        partition:{index:999,count:1000,record_count:200000},records:[]}));
    }
  }
  assert.equal(recordCount,121600);
  assert.ok(inputBytes<=144000000);
  assert.ok(captureBytes<=160000000);
  t.diagnostic(JSON.stringify({source_records:recordCount,source_chunks:capture.sources.length,
    capture_input_bytes:inputBytes,capture_output_bytes:captureBytes,preview_output_bytes:outputBytes,
    preview_output_bytes_bound:newWork.output_utf8_bytes_bound,measurement_values:newWork.measurement_values,
    legacy_member_work:oldWork.member_work,indexed_member_work:newWork.member_work}));
});

test('overlapping source-heavy pockets still reject at the unchanged finite work budget',async()=>{
  const args=await denseMemberWorkFixture({accountCount:2,saleCount:2000,
    pockets:accounts=>Array.from({length:128},(_,i)=>({id:`p-${i}`,label:'Repeated complete population',account_ids:accounts}))});
  assert.throws(()=>legacy(args),/work_limit/);
  assert.throws(()=>indexed(args),/custom_cohort_observation_preview_member_work_limit/);
  assert.equal(L.member_work,500000);
});

test('nonmatching association scans are budgeted even when no sales enter selected pockets',async()=>{
  const args=await denseMemberWorkFixture({accountCount:2,saleCount:2000,saleAccount:'OUTSIDE-ROSTER',
    pockets:accounts=>Array.from({length:128},(_,i)=>({id:`nonmatch-${i}`,label:'No associated sale',account_ids:[accounts[0]]}))});
  const old=legacy(args);
  assert.equal(old.selected.transactions.member_count,0);
  assert.equal(old.selected.source_reported.member_count,0);
  assert.equal(old.all.transactions.member_count,2000);
  assert.ok(old.work.member_work<500000,'legacy only charged matching members, hiding this repeated scan cost');
  assert.throws(()=>indexed(args),/custom_cohort_observation_preview_member_work_limit/);
});

test('stock-only repeated whole-table candidate scans remain finitely bounded',async()=>{
  const args=await denseMemberWorkFixture({accountCount:4000,saleCount:0,
    pockets:accounts=>Array.from({length:128},(_,i)=>({id:`stock-${i}`,label:'One selected account',account_ids:[accounts[0]]}))});
  const old=legacy(args);
  assert.equal(old.selected.stock.member_count,1);
  assert.equal(old.all.stock.member_count,4000);
  assert.ok(old.work.member_work<500000);
  assert.throws(()=>indexed(args),/custom_cohort_observation_preview_member_work_limit/,
    '130 full scans of 4000 stock rows must not be counted as only the selected members');
});
