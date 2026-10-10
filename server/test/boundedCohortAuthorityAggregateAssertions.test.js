import assert from 'node:assert/strict';
import test from 'node:test';
import { assertBoundedCohortAuthorityAggregates as check } from './helpers/boundedCohortAuthorityAggregateAssertions.js';
import { customCohortRepositoryFixture } from './fixtures/customCohortRepositoryFixture.js';
import { loadCurrentCustomCohortJobActor } from '../src/services/neighborhoodAssessment/customCohortJobActor.js';

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
