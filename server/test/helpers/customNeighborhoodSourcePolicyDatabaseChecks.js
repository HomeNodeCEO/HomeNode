import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCustomNeighborhoodSourcePolicy, CUSTOM_NEIGHBORHOOD_SOURCE_DATASET,
  CUSTOM_NEIGHBORHOOD_SOURCE_PURPOSE, CUSTOM_NEIGHBORHOOD_SOURCE_RIGHTS_KEY } from '../../src/security/customNeighborhoodSourcePolicy.js';
import { describeNeighborhoodCachedMarketDataPurpose } from '../../src/services/neighborhoodAssessment/cachedReadAccess.js';

/** The native runner must supply an IDLE checked-out client from its independently
 * verified disposable migrated test database. This helper does not connect,
 * inspect URLs/environment, commit, release or establish production authority.
 * Every organization and owner basis below is synthetic and rolled back.
 */
export async function run(client) {
  assert.equal(typeof client?.query, 'function', 'native policy check requires supplied client');
  const organization = randomUUID(), foreignOrganization = randomUUID(), checks = [];
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('statement_timeout','5000ms',true), set_config('lock_timeout','2000ms',true)");
    const times = (await client.query(`WITH clock AS (SELECT clock_timestamp() AS instant)
      SELECT to_char((instant - interval '1 minute') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS past,
        to_char((instant + interval '1 hour') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS future,
        to_char((instant - interval '1 second') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expired,
        to_char(instant AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS effective_date FROM clock`)).rows[0];
    const profile = { datasetRevision: 'synthetic-native-integrated-inventory-v1', providerRevisions: [
      { provider_id: 'synthetic-native-manual-source', revision: 'synthetic-owner-basis-v1' },
      { provider_id: 'synthetic-native-legacy-source', revision: 'synthetic-owner-basis-v2' },
    ] };
    const original = { policy_version: 1, organization_id: organization, grant_id: 'synthetic-native-only-grant',
      dataset: { id: CUSTOM_NEIGHBORHOOD_SOURCE_DATASET, revision: profile.datasetRevision,
        coverage: 'entire_integrated_source_mix_including_prior_merged_values', provider_revisions: structuredClone(profile.providerRevisions) },
      purpose_version: 1, purpose_scope: structuredClone(CUSTOM_NEIGHBORHOOD_SOURCE_PURPOSE),
      rights_basis: { owner_id: 'synthetic-native-source-owner', basis_reference: 'synthetic-native-test-only-NOT-a-real-license-or-grant',
        approved_by: 'synthetic-native-owner-approver', approved_at: times.past },
      valid_from: times.past, expires_at: times.future, revoked_at: null,
      retention: 'immutable_originals_without_automated_deletion',
      exposures: { none: true, report_observation_summary: true, report_observation_members: true, report_observation_catalog: true } };
    const sentinel = `synthetic-unrelated-metadata-${randomUUID()}`;
    const unrelated = { marker: sentinel, padding: 'synthetic-only-'.repeat(1800) };
    await client.query(`INSERT INTO app_auth.organizations(id,legal_name,display_name,metadata)
      VALUES($1,'Synthetic native source policy','Synthetic native source policy',$2::jsonb),
        ($3,'Synthetic native foreign policy','Synthetic native foreign policy','{}'::jsonb)`,
    [organization, JSON.stringify({ [CUSTOM_NEIGHBORHOOD_SOURCE_RIGHTS_KEY]: original, unrelated }), foreignOrganization]);
    const auth = { userId: randomUUID(), organizations: [{ organizationId: organization, roles: ['appraiser'] }] };
    const context = { target: { report_file_id: randomUUID(), workflow_type: 'custom_appraisal', workflow_target_id: '1' },
      scope: { organization_id: organization, appraisal_case_id: randomUUID(), subject_snapshot_id: randomUUID(), account_id: 'SYNTHETIC-POLICY-ONLY' },
      effective_date: times.effective_date };
    const purpose = describeNeighborhoodCachedMarketDataPurpose({ effective_date: times.effective_date,
      selection_sha256: 'a'.repeat(64), observation_period: { start_date: times.effective_date, end_date: times.effective_date }, knowledge_cutoff: null });
    const observed = [];
    const boundedClient = { async query(sql, params) {
      assert.match(sql, /\/\* custom-neighborhood-source-policy:organization \*\//);
      const result = await client.query(sql, params);
      for (const row of result.rows) {
        assert.deepEqual(Object.keys(row).sort(), ['active', 'checked_at', 'organization_id', 'source_rights']);
        assert.equal(JSON.stringify(row).includes(sentinel), false, 'unrelated organization metadata must not cross the policy query boundary');
      }
      observed.push(result.rows);
      return result;
    } };
    const authorize = createCustomNeighborhoodSourcePolicy(profile);
    const check = (exposure = 'none', targetContext = context, policy = authorize) =>
      policy(boundedClient, auth, targetContext, purpose, { retention: true, exposure });
    const saveConfig = async value => {
      const result = await client.query('UPDATE app_auth.organizations SET metadata=jsonb_set(metadata,ARRAY[$2::text],$3::jsonb) WHERE id=$1::uuid',
        [organization, CUSTOM_NEIGHBORHOOD_SOURCE_RIGHTS_KEY, JSON.stringify(value)]);
      assert.equal(result.rowCount, 1);
    };
    const state = async () => (await client.query('SELECT metadata,updated_at::text FROM app_auth.organizations WHERE id=$1::uuid', [organization])).rows[0];

    const before = await state(), allowed = await check();
    assert.equal(allowed.allowed, true);
    assert.match(allowed.policy_revision, /^custom-neighborhood-source-rights-v1:sha256:[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(allowed).sort(), ['allowed', 'decision_id', 'policy_revision']);
    for (const exposure of Object.keys(original.exposures)) assert.deepEqual(await check(exposure), allowed);
    assert.deepEqual(await state(), before, 'policy SELECT must not change metadata or timestamps');
    checks.push('real shared purpose and owner-config query allow all four explicitly granted exposures without writes');
    assert.equal(observed[0][0].source_rights.rights_basis.basis_reference, original.rights_basis.basis_reference);
    checks.push('real SQL projects only the rights subtree despite larger unrelated organization metadata');

    const revised = structuredClone(original);
    revised.exposures.report_observation_members = false;
    await saveConfig(revised);
    assert.notEqual((await check()).policy_revision, allowed.policy_revision);
    assert.deepEqual(await check('report_observation_members'), { allowed: false });
    checks.push('persisted rights changes invalidate the policy revision and remove the specific exposure');

    await saveConfig({ ...original, revoked_at: times.expired });
    assert.deepEqual(await check(), { allowed: false });
    checks.push('revoked owner grant denies');
    await saveConfig({ ...original, expires_at: times.expired });
    assert.deepEqual(await check(), { allowed: false });
    checks.push('expired owner grant denies using the database wall clock');

    await saveConfig({ ...original, organization_id: foreignOrganization });
    assert.deepEqual(await check(), { allowed: false });
    await saveConfig(original);
    assert.deepEqual(await check('none', { ...context, scope: { ...context.scope, organization_id: foreignOrganization } }), { allowed: false });
    checks.push('foreign grant binding and another organization without a grant deny');

    const changedDataset = createCustomNeighborhoodSourcePolicy({ ...profile, datasetRevision: 'synthetic-unapproved-new-inventory' });
    const changedProviders = createCustomNeighborhoodSourcePolicy({ ...profile, providerRevisions: [...profile.providerRevisions,
      { provider_id: 'synthetic-unapproved-future-provider', revision: 'synthetic-new-source-terms' }] });
    assert.deepEqual(await check('none', context, changedDataset), { allowed: false });
    assert.deepEqual(await check('none', context, changedProviders), { allowed: false });
    checks.push('trusted dataset or provider-mix mismatch denies without manufacturing source rights');

    await saveConfig({ ...original, oversized_synthetic_test_field: 'x'.repeat(17_000) });
    assert.deepEqual(await check(), { allowed: false });
    assert.equal(observed.at(-1)[0].source_rights, null, 'SQL must bound the rights subtree before transfer');
    checks.push('native SQL size guard rejects oversized rights metadata before transfer');
    return { status: 'passed', checks };
  } finally {
    await client.query('ROLLBACK');
  }
}
