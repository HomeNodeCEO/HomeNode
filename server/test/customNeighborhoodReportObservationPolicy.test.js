import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeCustomNeighborhoodReportObservations as authorize,
  CUSTOM_NEIGHBORHOOD_REPORT_OBSERVATION_RIGHTS_KEY as KEY,
  CUSTOM_NEIGHBORHOOD_REPORT_OBSERVATION_PURPOSE as PURPOSE } from '../src/security/customNeighborhoodReportObservationPolicy.js';
const org = '10000000-0000-4000-8000-000000000001', id = '20000000-0000-4000-8000-000000000001';
const context = { target: { workflow_type: 'custom_appraisal' }, scope: { organization_id: org } };
const auth = { userId: 'authenticated-synthetic-user' }, requested = { retention: true, exposure: 'custom_report_observations' };
const purpose = { kind: PURPOSE, context_ref: { context_id: id, context_revision: '1', context_sha256: 'a'.repeat(64) },
  shared_source_purpose: { kind: 'neighborhood_cached_market_data' }, private_sales_import: null };
const row = () => ({ organization_id: org, active: true, checked_at: '2026-09-10T12:00:00.123456Z', source_rights: {
  policy_version: 1, organization_id: org, grant_id: 'synthetic-test-only', purpose: PURPOSE,
  rights_basis: { owner_id: 'synthetic-owner', basis_reference: 'Synthetic test grant, not production authorization',
    approved_by: 'synthetic-reviewer', approved_at: '2026-09-01T00:00:00.000000Z' },
  valid_from: '2026-09-01T00:00:00.000000Z', expires_at: '2026-10-01T00:00:00.000000Z', revoked_at: null,
  retention: 'immutable_report_group_and_referenced_evidence', exposures: { custom_report_observations: true } } });
const client = value => ({ async query(sql, values) {
  assert.match(sql, /octet_length/); assert.deepEqual(values, [org, KEY]);
  assert.doesNotMatch(sql, /INSERT|DELETE|UPDATE|sales_import_rows/); return { rows: [value] };
} });

test('independent report retention/display/export decision is stable, source grants still remain separately required', async () => {
  const first = await authorize(client(row()), auth, context, purpose, requested);
  assert.equal(first.allowed, true); assert.match(first.policy_revision, /^custom-report-observation-rights-v1:sha256:[a-f0-9]{64}$/);
  assert.deepEqual(await authorize(client(row()), auth, context, purpose, requested), first);
  const value = row(); value.source_rights.rights_basis.basis_reference += ' changed';
  assert.notEqual((await authorize(client(value), auth, context, purpose, requested)).policy_revision, first.policy_revision);
  assert.equal((await authorize(client(row()), auth, context, { ...purpose,
    private_sales_import: { batch_id: id, expected_review_revision: 1 } }, requested)).allowed, true);
});

for (const [name, mutate] of [
  ['missing', r => { r.source_rights = null; }], ['inactive', r => { r.active = false; }],
  ['foreign', r => { r.source_rights.organization_id = id; }], ['unapproved', r => { r.source_rights.rights_basis.approved_by = ''; }],
  ['future approval', r => { r.source_rights.rights_basis.approved_at = '2026-09-11T00:00:00.000000Z'; }],
  ['expired', r => { r.source_rights.expires_at = r.checked_at; }], ['revoked', r => { r.source_rights.revoked_at = r.checked_at; }],
  ['not yet valid', r => { r.source_rights.valid_from = '2026-09-11T00:00:00.000000Z'; }],
  ['shared capture grant', r => { r.source_rights.purpose = 'neighborhood_cached_market_data'; }],
  ['private capture grant', r => { r.source_rights.purpose = 'assignment_private_sales_observations_v1'; }],
  ['preview only', r => { r.source_rights.exposures = { report_observation_summary: true }; }],
  ['disabled', r => { r.source_rights.exposures.custom_report_observations = false; }],
  ['extra entitlement', r => { r.source_rights.exposures.sign = true; }],
  ['wrong retention', r => { r.source_rights.retention = 'immutable_originals_without_automated_deletion'; }],
]) test(`report policy denies ${name}`, async () => {
  const value = row(); mutate(value);
  assert.deepEqual(await authorize(client(value), auth, context, purpose, requested), { allowed: false });
});

test('malformed context, extra body authority and wrong workflow are denied before database access', async () => {
  const no = { query() { assert.fail('must not query'); } };
  for (const changes of [{ kind: 'export_everything' }, { context_ref: { ...purpose.context_ref, latest: true } },
    { private_sales_import: { batch_id: id, expected_review_revision: 0 } }, { allowed: true }]) {
    assert.deepEqual(await authorize(no, auth, context, { ...purpose, ...changes }, requested), { allowed: false });
  }
  assert.deepEqual(await authorize(no, auth, { ...context, target: { workflow_type: 'uad_3_6' } }, purpose, requested), { allowed: false });
  assert.deepEqual(await authorize(no, {}, context, purpose, requested), { allowed: false });
  assert.deepEqual(await authorize(no, auth, context, purpose, { ...requested, exposure: 'raw_csv' }), { allowed: false });
});

test('policy database failures return a sanitized unavailable error, never a grant', async () => {
  await assert.rejects(authorize({ query() { throw new Error('private driver failure'); } }, auth, context, purpose, requested),
    e => e.message === 'custom_neighborhood_report_observation_policy_unavailable' && !e.cause);
});
