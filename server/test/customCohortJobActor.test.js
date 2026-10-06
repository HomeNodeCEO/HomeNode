import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCurrentCustomCohortJobActor }
  from '../src/services/neighborhoodAssessment/customCohortJobActor.js';
import { hasApplicationPermission } from '../src/security/applicationAccess.js';
import { decideAssignmentAccess } from '../src/security/assignmentAccess.js';

const actor = '11111111-1111-4111-8111-111111111111';
const organization = '22222222-2222-4222-8222-222222222222';

test('a resumed actor uses current database roles, not a saved claim', async () => {
  const query = async (sql, values) => {
    assert.match(sql, /memberships\.status='active'/);
    assert.match(sql, /organizations\.active=true/);
    assert.match(sql, /users\.active=true/);
    assert.deepEqual(values, [actor, organization]);
    return { rowCount: 1, rows: [{ user_id: actor, organization_id: organization,
      roles: ['appraiser'] }] };
  };
  const auth = await loadCurrentCustomCohortJobActor({ query }, actor, organization);
  assert.equal(hasApplicationPermission(auth, 'custom_appraisal', 'write', organization), true);
  assert.equal(decideAssignmentAccess(auth, { organization_id: organization,
    assigned_appraiser_user_id: actor }, 'write'), true);
  assert.equal(decideAssignmentAccess(auth, { organization_id: organization,
    assigned_appraiser_user_id: 'another-user' }, 'write'), false);
  assert.equal(hasApplicationPermission(auth, 'custom_appraisal', 'write',
    '33333333-3333-4333-8333-333333333333'), false);
});

test('revoked membership, inactive user, or missing current role refuses resume', async () => {
  for (const result of [
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [{ user_id: actor, organization_id: organization, roles: [] }] },
    { rowCount: 1, rows: [{ user_id: actor, organization_id: organization,
      roles: ['appraiser', 'bad role'] }] },
  ]) {
    await assert.rejects(loadCurrentCustomCohortJobActor({ query: async () => result },
      actor, organization), /access_revoked/);
  }
});

test('invalid identifiers do not reach the database', async () => {
  let called = false;
  await assert.rejects(loadCurrentCustomCohortJobActor({ query: async () => { called = true; } },
    'not-a-uuid', organization), /invalid_input/);
  assert.equal(called, false);
});
