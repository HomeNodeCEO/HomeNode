import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeCustomNeighborhoodPrivateSales as authorize, customNeighborhoodPrivateSalesPurpose as purposeOf,
  CUSTOM_NEIGHBORHOOD_PRIVATE_SALES_RIGHTS_KEY as KEY, CUSTOM_NEIGHBORHOOD_PRIVATE_SALES_PURPOSE as PURPOSE }
  from '../src/security/customNeighborhoodPrivateSalesPolicy.js';
const org = '10000000-0000-4000-8000-000000000001';
const batch = '20000000-0000-4000-8000-000000000001';
const context = { target: { workflow_type: 'custom_appraisal' }, scope: { organization_id: org } };
const auth = { userId: 'authenticated-user' };
const purpose = purposeOf({ batch_id: batch, expected_review_revision: 2 });
const requested = { retention: true, exposure: 'report_observation_summary' };
function row() { return { organization_id: org, active: true, checked_at: '2026-09-10T12:00:00.000000Z', source_rights: {
  policy_version: 1, organization_id: org, grant_id: 'synthetic-test-only', purpose: PURPOSE,
  rights_basis: { owner_id: 'synthetic', basis_reference: 'test fixture, not a real source grant', approved_by: 'synthetic-owner', approved_at: '2026-09-01T00:00:00.000000Z' },
  valid_from: '2026-09-01T00:00:00.000000Z', expires_at: '2026-10-01T00:00:00.000000Z', revoked_at: null,
  retention: 'immutable_originals_without_automated_deletion', exposures: { none: true,
    report_observation_summary: true, report_observation_members: true, report_observation_catalog: true } } }; }
const client = value => ({ async query(sql, values) {
  assert.match(sql, /octet_length/); assert.deepEqual(values, [org, KEY]);
  assert.doesNotMatch(sql, /assignment_sales_import_rows|UPDATE|INSERT|DELETE/); return { rows: [value] };
} });

test('private purpose accepts only exact explicit reviewed batch, never a latest selector or zero revision', () => {
  assert.deepEqual(purpose, { kind: PURPOSE, batch_id: batch, expected_review_revision: 2 });
  for (const value of [null, {}, { batch_id: batch, expected_review_revision: 0 },
    { batch_id: batch, expected_review_revision: '2' }, { batch_id: batch, expected_review_revision: 2147483648 },
    { batch_id: batch, expected_review_revision: 2, latest: true }]) assert.throws(() => purposeOf(value));
});
test('distinct private grant is stable across permitted exposures but changes on exact policy revision', async () => {
  const first = await authorize(client(row()), auth, context, purpose, requested);
  assert.equal(first.allowed, true); assert.match(first.policy_revision, /^custom-private-sales-rights-v1:sha256:[a-f0-9]{64}$/);
  for (const exposure of ['none', 'report_observation_members', 'report_observation_catalog']) {
    assert.deepEqual(await authorize(client(row()), auth, context, purpose, { retention: true, exposure }), first);
  }
  const changed = row(); changed.source_rights.rights_basis.basis_reference += ' revision';
  assert.notEqual((await authorize(client(changed), auth, context, purpose, requested)).policy_revision, first.policy_revision);
});
for (const [label, mutate] of [
  ['missing installed grant', r => { r.source_rights = null; }],
  ['shared grant is not a private grant', r => { r.source_rights.purpose = 'neighborhood_cached_market_data'; }],
  ['inactive organization', r => { r.active = false; }],
  ['foreign organization', r => { r.source_rights.organization_id = batch; }],
  ['expired at exact bound', r => { r.source_rights.expires_at = r.checked_at; }],
  ['not yet valid', r => { r.source_rights.valid_from = '2026-09-11T00:00:00.000000Z'; }],
  ['revoked', r => { r.source_rights.revoked_at = r.checked_at; }],
  ['unapproved basis', r => { r.source_rights.rights_basis.approved_by = ''; }],
  ['future approval', r => { r.source_rights.rights_basis.approved_at = '2026-09-11T00:00:00.000000Z'; }],
  ['summary not allowed', r => { r.source_rights.exposures.report_observation_summary = false; }],
  ['retention not allowed', r => { r.source_rights.exposures.none = false; }],
  ['extra entitlement', r => { r.source_rights.exposures.export = true; }],
  ['missing exposure', r => { delete r.source_rights.exposures.report_observation_members; }],
  ['review declaration is not installed rights', r => { r.source_rights = { source_use_confirmed: true }; }],
]) test(`private source policy denies ${label}`, async () => {
  const value = row(); mutate(value); assert.deepEqual(await authorize(client(value), auth, context, purpose, requested), { allowed: false });
});
test('malformed purpose/auth/exposure is denied before organization query, without leaking driver errors', async () => {
  const no = { query() { assert.fail('must not query'); } };
  assert.deepEqual(await authorize(no, {}, context, purpose, requested), { allowed: false });
  assert.deepEqual(await authorize(no, auth, context, { ...purpose, source_use_confirmed: true }, requested), { allowed: false });
  assert.deepEqual(await authorize(no, auth, context, purpose, { retention: true, exposure: 'raw_csv' }), { allowed: false });
  await assert.rejects(authorize({ query() { throw new Error('secret driver payload'); } }, auth, context, purpose, requested),
    e => e.message === 'custom_neighborhood_private_sales_policy_unavailable' && !e.cause);
});
