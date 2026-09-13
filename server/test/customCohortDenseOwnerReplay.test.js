import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { denseOwnerSyntheticRights, DENSE_OWNER_COUNTS, DENSE_OWNER_SOURCE_PROFILE,
  prepareDenseCad4OwnerReplay, measureDenseCad4OwnerReplay } from './helpers/customCohortDenseOwnerReplayChecks.js';
import { createCustomNeighborhoodSourcePolicy, CUSTOM_NEIGHBORHOOD_SOURCE_RIGHTS_KEY as SOURCE_KEY } from '../src/security/customNeighborhoodSourcePolicy.js';
import { authorizeCustomNeighborhoodReportObservations, CUSTOM_NEIGHBORHOOD_REPORT_OBSERVATION_RIGHTS_KEY as REPORT_KEY } from '../src/security/customNeighborhoodReportObservationPolicy.js';
import { describeNeighborhoodCachedMarketDataPurpose, describeNeighborhoodCombinedEvidenceMarketDataPurpose } from '../src/services/neighborhoodAssessment/cachedReadAccess.js';
import { assessmentEvidenceDigest as digest } from '../src/services/neighborhoodAssessment/contract.js';

const org = '11111111-1111-4111-8111-111111111111', actor = '22222222-2222-4222-8222-222222222222';
const past = '2026-09-13T00:00:00.000000Z', now = '2026-09-13T00:01:00.000000Z', future = '2026-09-13T02:00:00.000000Z';
const context = { target: { report_file_id: '33333333-3333-4333-8333-333333333333', workflow_type: 'custom_appraisal', workflow_target_id: '41' },
  scope: { organization_id: org }, effective_date: '2026-09-13' };
const auth = { userId: actor, organizations: [{ organizationId: org, roles: ['appraiser'] }] };
const request = { effective_date: context.effective_date, selection_sha256: 'a'.repeat(64),
  observation_period: { start_date: '2023-07-01', end_date: '2024-06-30' }, knowledge_cutoff: null };
const sourcePurpose = describeNeighborhoodCachedMarketDataPurpose(request);
const reportPurpose = { kind: 'custom_reported_observations_v2', context_ref: {
  context_id: '44444444-4444-4444-8444-444444444444', context_revision: '1', context_sha256: 'b'.repeat(64) },
shared_source_purpose: sourcePurpose, private_sales_import: null };
const grantClient = metadata => ({ async query(sql, values) {
  assert.ok(sql.includes('source-policy:organization') || sql.includes('report-observation-policy:organization'));
  assert.equal(values[0], org); assert.ok([SOURCE_KEY, REPORT_KEY].includes(values[1]));
  return { rows: [{ organization_id: org, active: true, checked_at: now, source_rights: metadata[values[1]] ?? null }] };
} });

test('synthetic owner fixture pins full CAD4 native counts, not live or Witness2 substitutes', () => {
  assert.deepEqual(DENSE_OWNER_COUNTS, { accounts: 38_106, parcels: 38_347, groups: 887,
    source_records: 1030, retained_records: 116_621, publication_members: 39_136 });
  assert.ok(Object.isFrozen(DENSE_OWNER_COUNTS));
  assert.ok(Object.isFrozen(DENSE_OWNER_SOURCE_PROFILE) && Object.isFrozen(DENSE_OWNER_SOURCE_PROFILE.providerRevisions[0]));
});

test('actual source policy evaluates the new synthetic rights and hashes the exact original decision', async () => {
  const metadata = denseOwnerSyntheticRights(org, past, future), before = JSON.stringify(metadata);
  const policy = createCustomNeighborhoodSourcePolicy(DENSE_OWNER_SOURCE_PROFILE);
  const expected = { allowed: true, decision_id: `${org}:synthetic-dense-owner-source`,
    policy_revision: `custom-neighborhood-source-rights-v1:sha256:${digest(metadata[SOURCE_KEY])}` };
  for (const exposure of ['none', 'report_observation_summary', 'report_observation_members', 'report_observation_catalog']) {
    assert.deepEqual(await policy(grantClient(metadata), auth, context, sourcePurpose, { retention: true, exposure }), expected);
  }
  assert.equal(JSON.stringify(metadata), before);
  assert.deepEqual(await policy(grantClient(metadata), auth, context, describeNeighborhoodCombinedEvidenceMarketDataPurpose(request),
    { retention: true, exposure: 'none' }), { allowed: false }, 'legacy synthetic rights do not authorize an expanded witness projection');
});

test('actual independent report policy hashes its separate explicit synthetic permission', async () => {
  const metadata = denseOwnerSyntheticRights(org, past, future);
  assert.deepEqual(await authorizeCustomNeighborhoodReportObservations(grantClient(metadata), auth, context, reportPurpose,
    { retention: true, exposure: 'custom_report_observations' }), { allowed: true,
    decision_id: `${org}:synthetic-dense-owner-report`,
    policy_revision: `custom-report-observation-rights-v1:sha256:${digest(metadata[REPORT_KEY])}` });
  delete metadata[REPORT_KEY];
  assert.deepEqual(await authorizeCustomNeighborhoodReportObservations(grantClient(metadata), auth, context, reportPurpose,
    { retention: true, exposure: 'custom_report_observations' }), { allowed: false });
});

test('missing, revoked, expired, foreign, or changed real rights cannot silently retain the original decision', async () => {
  const policy = createCustomNeighborhoodSourcePolicy(DENSE_OWNER_SOURCE_PROFILE);
  for (const change of [
    data => { delete data[SOURCE_KEY]; }, data => { data[SOURCE_KEY].revoked_at = past; },
    data => { data[SOURCE_KEY].expires_at = now; }, data => { data[SOURCE_KEY].organization_id = actor; },
    data => { data[SOURCE_KEY].dataset.revision = 'unapproved'; },
  ]) {
    const data = denseOwnerSyntheticRights(org, past, future); change(data);
    assert.deepEqual(await policy(grantClient(data), auth, context, sourcePurpose, { retention: true, exposure: 'none' }), { allowed: false });
  }
  const first = denseOwnerSyntheticRights(org, past, future), changed = structuredClone(first);
  changed[SOURCE_KEY].exposures.report_observation_members = false;
  const before = await policy(grantClient(first), auth, context, sourcePurpose, { retention: true, exposure: 'none' });
  const after = await policy(grantClient(changed), auth, context, sourcePurpose, { retention: true, exposure: 'none' });
  assert.equal(after.allowed, true); assert.notEqual(after.policy_revision, before.policy_revision);
  changed[SOURCE_KEY].dataset.provider_revisions[0].revision = 'modified';
  assert.notDeepEqual(changed[SOURCE_KEY].dataset.provider_revisions, DENSE_OWNER_SOURCE_PROFILE.providerRevisions);
  assert.deepEqual(denseOwnerSyntheticRights(org, past, future), first);
});

test('native fixture guard rejects non-test mode or arbitrary database names before connecting', async () => {
  const previous = process.env.NODE_ENV; let calls = 0;
  const pool = { connect() { calls++; assert.fail('must not connect'); } };
  try {
    process.env.NODE_ENV = 'production';
    await assert.rejects(prepareDenseCad4OwnerReplay({ pool, databaseName: 'dense_memory_'+'a'.repeat(32)+'_test' }));
    process.env.NODE_ENV = 'test';
    for (const databaseName of ['postgres', 'app_test', 'dense_memory_a_test', 'dense_memory_'+'a'.repeat(32)+'_test?x']) {
      await assert.rejects(prepareDenseCad4OwnerReplay({ pool, databaseName }));
      await assert.rejects(measureDenseCad4OwnerReplay({ pool, databaseName, fixture: {} }));
    }
    assert.equal(calls, 0);
  } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});

test('new setup refuses an existing source namespace before any DDL/seed, and releases the guard connection', async () => {
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'test';
  const name = 'dense_memory_'+'a'.repeat(32)+'_test'; let released = 0, queries = 0;
  try {
    const pool = { async connect() { return { connection: { stream: { remoteAddress: '127.0.0.1' } }, release() { released++; },
      async query(sql) { queries++; assert.ok(sql.startsWith('SELECT'));
        return { rows: sql.includes('to_regnamespace') ? [{ gis: 'gis' }] : [{ database_name: name, server_address: '127.0.0.1' }] }; } }; },
    query() { assert.fail('must not seed/DDL'); } };
    await assert.rejects(prepareDenseCad4OwnerReplay({ pool, databaseName: name }), /new empty source namespace/);
    assert.equal(queries, 2); assert.equal(released, 1);
  } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});

test('structural fixture boundary keeps real owner/policies and publication, with no Apply or deadline override', async () => {
  const source = await readFile(new URL('./helpers/customCohortDenseOwnerReplayChecks.js', import.meta.url), 'utf8');
  assert.match(source, /service\.capture\(/); assert.match(source, /service\.catalog\(/);
  assert.match(source, /service\.prepareReportedObservations\(request\)/);
  assert.match(source, /workspace_version: 5/); assert.match(source, /sourceMode: 'cad4'/);
  assert.match(source, /createCustomNeighborhoodSourcePolicy\(DENSE_OWNER_SOURCE_PROFILE\)/);
  assert.match(source, /timing\.wrapPolicy\('authorizeReportedObservations', authorizeCustomNeighborhoodReportObservations\)/);
  assert.doesNotMatch(source, /\.applyReportedObservations\(|allowed:\s*true|deadline:\s*|duration_ms:\s*/);
  assert.match(source, /publication_sql_entered:/); assert.match(source, /successful_publication: !!ready/);
});
