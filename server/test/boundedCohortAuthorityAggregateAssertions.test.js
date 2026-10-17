import assert from 'node:assert/strict';
import test from 'node:test';
import { assertBoundedCohortAuthorityAggregates as check, assertBoundedCohortAuthorityAggregateShapes as shapes } from './helpers/boundedCohortAuthorityAggregateAssertions.js';
import { customCohortRepositoryFixture } from './fixtures/customCohortRepositoryFixture.js';
import { loadCurrentCustomCohortJobActor } from '../src/services/neighborhoodAssessment/customCohortJobActor.js';
import { NEIGHBORHOOD_STOCK_ACCOUNT_PACKAGE_V2_SQL, NEIGHBORHOOD_STOCK_SUBJECT_HOUSING_PACKAGE_V2_SQL,
  NEIGHBORHOOD_STOCK_SUBJECT_AND_NEXT_PACKAGE_V2_SQL } from '../src/services/neighborhoodAssessment/neighborhoodSharedStockOriginalCellsV2.js';

async function actualQueries() {
  const { state, repo } = customCohortRepositoryFixture();
  await repo.capture();
  const scope = { actorUserId: '11111111-1111-4111-8111-111111111111',
    organizationId: state.input.target.organization_id, assignmentFileId: state.input.target.assignment_file_id };
  let actor;
  await loadCurrentCustomCohortJobActor({ async query(text, values) {
    actor = { text, values };
    return { rowCount: 1, rows: [{ user_id: scope.actorUserId, organization_id: scope.organizationId, roles: ['appraiser'] }] };
  } }, scope.actorUserId, scope.organizationId);
  const section = state.calls.find(c => c.tag === 'sections');
  return { scope, actor, section: { text: section.sql, values: section.params } };
}

test('catalog aggregate assertion accepts actual bounded actor and three-section SQL at both ends', async () => {
  const { scope, actor, section } = await actualQueries();
  check([actor, section, { text: 'SELECT count(*) FROM app.example', values: [] }, actor, section], scope);
});

test('paired original aggregate keeps native subject choice, deduplication and one whole-packet budget', async () => {
  const { scope, actor, section } = await actualQueries();
  scope.originals = { operationId:'stock-operation', generationId:'retained-generation',
    profileSha256:'retained-profile', subjectAccountId:'ACTUAL-SUBJECT' };
  const baseline=[actor,section,actor,section], packet={text:NEIGHBORHOOD_STOCK_SUBJECT_AND_NEXT_PACKAGE_V2_SQL,
    values:['stock-operation','retained-generation','retained-profile','ACCOUNT-A',250,8_000_000,2_100_000,1_000_000,2_100_000,true]};
  check([...baseline,packet],scope);
  check([...baseline,{...packet,values:[...packet.values.slice(0,9),false]}],scope);
  for (const index of [0,1,2,4,5,6,7,8]) {
    const values=[...packet.values]; values[index]=index<3?'foreign-scope':values[index]+1;
    assert.throws(()=>check([...baseline,{...packet,values}],scope),/exact paired stock/);
  }
  for (const cursor of [[], 'ACCOUNT-A\n', 'x'.repeat(65)]) {
    const values=[...packet.values]; values[3]=cursor;
    assert.throws(()=>check([...baseline,{...packet,values}],scope),/bounded paired original account cursor/);
  }
  for (const fallback of [undefined,null,0,'true',{}]) {
    const values=[...packet.values]; values[9]=fallback;
    assert.throws(()=>check([...baseline,{...packet,values}],scope),/closed retained-subject fallback decision/);
  }
  for (const text of [packet.text.replace('AND a.account_id=job.account_id',''),
    packet.text.replace('job.operation_id=$1::uuid','true'),packet.text.replace('UNION SELECT','UNION ALL SELECT'),
    packet.text.replace('LIMIT 1','LIMIT 2'),packet.text.replace('LIMIT ($5::integer+1)','LIMIT ($5::integer+2)'),
    packet.text.replace('AND (SELECT sum(n) FROM totals)<=$5::integer',''),
    packet.text.replace('AND (NOT $10::boolean OR EXISTS(SELECT 1 FROM subject_account))',''),
    packet.text.replace('AND o.account_id=a.account_id',''),packet.text+', json_agg(account_id)']) {
    assert.throws(()=>check([...baseline,{...packet,text}],scope),/unexpected catalog aggregate/);
  }
  assert.throws(()=>check([...baseline,packet],{...scope,originals:{...scope.originals,subjectAccountId:undefined}}),
    /actual retained job subject/);
  assert.throws(()=>check([actor,section,packet],scope),/both-end current actor/);
  assert.throws(()=>check([actor,actor,section,packet],scope),/both-end current bounded subject/);
});

test('subject original aggregate requires the actual job subject and every unchanged whole-packet cap', async () => {
  const { scope, actor, section } = await actualQueries();
  scope.originals = { operationId:'stock-operation', generationId:'retained-generation', profileSha256:'retained-profile', subjectAccountId:'ACTUAL-SUBJECT' };
  const baseline=[actor,section,actor,section], packet={text:NEIGHBORHOOD_STOCK_SUBJECT_HOUSING_PACKAGE_V2_SQL,
    values:['stock-operation','retained-generation','retained-profile','ACTUAL-SUBJECT',250,8_000_000,2_100_000,1_000_000,2_100_000]};
  check([...baseline,packet],scope);
  for (let index=0;index<packet.values.length;index++) {
    const values=[...packet.values];values[index]=index<4?'foreign-scope':values[index]+1;
    assert.throws(()=>check([...baseline,{...packet,values}],scope),/exact subject stock/);
  }
  for (const text of [packet.text.replace('AND job.account_id=$4::text',''),packet.text.replace('job.operation_id=$1::uuid','true'),
    packet.text.replace('LIMIT 1','LIMIT 2'),packet.text.replace('AND o.account_id=a.account_id',''),packet.text+', jsonb_agg(account_id)']) {
    assert.throws(()=>check([...baseline,{...packet,text}],scope),/unexpected catalog aggregate/);
  }
  assert.throws(()=>check([...baseline,packet],{...scope,originals:{...scope.originals,subjectAccountId:undefined}}),/actual retained job subject/);
  assert.throws(()=>check([actor,section,packet],scope),/both-end current actor/);
});

test('early-refusal shape checks retain exact aggregate bounds without claiming ending authority', async () => {
  const { scope, actor, section } = await actualQueries();
  shapes([actor, section], scope);
  assert.throws(() => check([actor, section], scope), /both-end current actor/);
  assert.throws(() => shapes([actor, { ...section, values: [scope.assignmentFileId, section.values[1], 1_500_001] }], scope), /three fixed material/);
  assert.throws(() => shapes([actor, { text: 'SELECT jsonb_agg(account_id) FROM app.accounts', values: [] }], scope), /unexpected catalog aggregate/);
});

test('catalog aggregate assertion refuses tag spoofing, extra aggregates, widened scope/cap and missing end reads', async () => {
  const { scope, actor, section } = await actualQueries();
  const baseline = [actor, section, actor, section];
  for (const bad of [
    { ...actor, text: actor.text.replace('roles.role_code ORDER BY roles.role_code', 'account_id ORDER BY account_id') },
    { ...section, text: section.text + ', jsonb_agg(account_id)' },
    { ...section, text: section.text.replace('AND section_key=ANY($2::text[])', '') },
    { ...section, values: [scope.assignmentFileId, [...section.values[1], 'report.all'], 1_500_000] },
    { ...section, values: [scope.assignmentFileId, section.values[1], 1_500_001] },
    { ...section, values: ['999999', section.values[1], 1_500_000] },
    { ...actor, values: [scope.actorUserId, 'foreign-organization'] },
    { text: '/* custom-cohort-subject:sections */ SELECT jsonb_agg(account_id) FROM app.accounts', values: [] },
    { text: 'SELECT ST_DWithin(geometry, geometry, 100)', values: [] },
    { text: '/* job-typed:rows */ SELECT account_id FROM app.accounts', values: [] },
  ]) assert.throws(() => check([...baseline, bad], scope), /unexpected catalog aggregate|exact current actor|three fixed material|spatial\/job-typed/);
  assert.throws(() => check([actor, section, section], scope), /both-end current actor/);
  assert.throws(() => check([actor, section, actor], scope), /both-end current bounded subject/);
});

for (const expression of ['array_agg(account_id)', 'jsonb_agg(account_id)', 'json_agg(account_id)',
  'jsonb_object_agg(account_id, payload)', 'json_object_agg(account_id, payload)',
  "string_agg(account_id, ',')", 'xmlagg(payload)', 'ARRAY(SELECT account_id FROM app.accounts)']) {
  test(`catalog aggregate assertion refuses population construction with ${expression}`, async () => {
    const { scope, actor, section } = await actualQueries();
    const text = `/* custom-cohort-subject:sections */ SELECT ${expression} FROM app.accounts`;
    assert.throws(() => check([actor, section, actor, section, { text, values: [] }], scope), /unexpected catalog aggregate/);
  });
}

test('catalog aggregate assertion admits only the unchanged single-account original packet and exact bounded parameters', async () => {
  const { scope, actor, section } = await actualQueries();
  scope.originals = { operationId: 'stock-operation', generationId: 'retained-generation', profileSha256: 'retained-profile' };
  const baseline = [actor, section, actor, section], packet = { text: NEIGHBORHOOD_STOCK_ACCOUNT_PACKAGE_V2_SQL,
    values: ['stock-operation', 'retained-generation', 'retained-profile', 'ACCOUNT-A', 250, 8_000_000, 2_100_000, 1_000_000, 2_100_000] };
  check([...baseline, packet], scope);
  check([...baseline, { text: 'SELECT count(*), sum(member_count) FROM app.example', values: [] }], scope);
  for (const index of [0, 1, 2, 4, 5, 6, 7, 8]) {
    const values = [...packet.values]; values[index] = index < 3 ? 'foreign-scope' : values[index] + 1;
    assert.throws(() => check([...baseline, { ...packet, values }], scope), /exact original stock/);
  }
  for (const cursor of [[], 'ACCOUNT-A\n', 'x'.repeat(65)]) {
    const values = [...packet.values]; values[3] = cursor;
    assert.throws(() => check([...baseline, { ...packet, values }], scope), /bounded original account cursor/);
  }
  for (const text of [packet.text.replace('LIMIT 1', 'LIMIT 2'), packet.text.replace('AND o.account_id=a.account_id', ''),
    packet.text + ', json_agg(account_id)']) {
    assert.throws(() => check([...baseline, { ...packet, text }], scope), /unexpected catalog aggregate/);
  }
  assert.throws(() => check([...baseline, packet], { ...scope, originals: undefined }), /exact retained stock scope/);
});
