import assert from 'node:assert/strict';
import test from 'node:test';
import { describeNeighborhoodCachedMarketDataPurpose } from '../src/services/neighborhoodAssessment/cachedReadAccess.js';
import { createCustomNeighborhoodSourcePolicy, CUSTOM_NEIGHBORHOOD_SOURCE_DATASET,
  CUSTOM_NEIGHBORHOOD_SOURCE_PURPOSE, CUSTOM_NEIGHBORHOOD_SOURCE_RIGHTS_KEY } from '../src/security/customNeighborhoodSourcePolicy.js';

const ORG = '70000000-0000-4000-8000-000000000001';
const OTHER_ORG = '70000000-0000-4000-8000-000000000002';
const NOW = '2026-09-09T12:00:00.123456Z';
const AUTH = { userId: 'fixture-actor', organizations: [{ organizationId: ORG, roles: ['organization_admin'] }] };
const CONTEXT = { target: { workflow_type: 'custom_appraisal' }, scope: { organization_id: ORG }, effective_date: '2026-09-09' };
const PROFILE = { datasetRevision: 'fixture-integrated-inventory-7', providerRevisions: [
  { provider_id: 'fixture-manual-provider', revision: 'fixture-approved-terms-3' },
  { provider_id: 'fixture-legacy-provider', revision: 'fixture-approved-terms-2' },
] };
const PURPOSE = describeNeighborhoodCachedMarketDataPurpose({ effective_date: CONTEXT.effective_date,
  selection_sha256: 'a'.repeat(64), observation_period: { start_date: '2025-09-09', end_date: '2026-09-09' }, knowledge_cutoff: null });
const REQUEST = { retention: true, exposure: 'none' };
const copy = value => structuredClone(value);
function config() {
  return { policy_version: 1, organization_id: ORG, grant_id: 'fixture-owner-grant',
    dataset: { id: CUSTOM_NEIGHBORHOOD_SOURCE_DATASET, revision: PROFILE.datasetRevision,
      coverage: 'entire_integrated_source_mix_including_prior_merged_values', provider_revisions: copy(PROFILE.providerRevisions) },
    purpose_version: 1, purpose_scope: copy(CUSTOM_NEIGHBORHOOD_SOURCE_PURPOSE),
    rights_basis: { owner_id: 'fixture-source-rights-owner', basis_reference: 'fixture-only-not-a-production-grant',
      approved_by: 'fixture-owner-approver', approved_at: '2026-09-01T00:00:00.000000Z' },
    valid_from: '2026-09-02T00:00:00.000000Z', expires_at: '2026-10-01T00:00:00.000000Z', revoked_at: null,
    retention: 'immutable_originals_without_automated_deletion',
    exposures: { none: true, report_observation_summary: true, report_observation_members: true, report_observation_catalog: true } };
}
function fixture() {
  const row = { organization_id: ORG, active: true, source_rights: config(), checked_at: NOW }, calls = [];
  const client = { async query(sql, params) { calls.push({ sql, params }); return { rows: [copy(row)] }; } };
  const policy = createCustomNeighborhoodSourcePolicy(copy(PROFILE));
  return { row, calls, client, policy, check: (requested = REQUEST, context = CONTEXT, purpose = PURPOSE, auth = AUTH) => policy(client, auth, context, purpose, requested) };
}

test('owner-provisioned entire-source grant uses the supplied bounded client and real shared purpose shape', async () => {
  const f = fixture(), before = copy({ profile: PROFILE, context: CONTEXT, purpose: PURPOSE, row: f.row });
  const decision = await f.check();
  assert.equal(decision.allowed, true);
  assert.equal(Object.isFrozen(decision), true);
  assert.equal(decision.decision_id, `${ORG}:fixture-owner-grant`);
  assert.match(decision.policy_revision, /^custom-neighborhood-source-rights-v1:sha256:[a-f0-9]{64}$/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].params, [ORG, CUSTOM_NEIGHBORHOOD_SOURCE_RIGHTS_KEY, 16_384]);
  assert.match(f.calls[0].sql, /clock_timestamp\(\)/);
  assert.match(f.calls[0].sql, /CASE WHEN octet_length/);
  assert.match(f.calls[0].sql, /WHERE id = \$1::uuid/);
  assert.doesNotMatch(f.calls[0].sql, /\b(BEGIN|COMMIT|ROLLBACK|UPDATE|INSERT|DELETE|FOR UPDATE)\b/);
  assert.deepEqual({ profile: PROFILE, context: CONTEXT, purpose: PURPOSE, row: f.row }, before);
});

test('decision remains stable across permitted exposures, selections, clocks and object key order', async () => {
  const f = fixture(), initial = await f.check();
  for (const exposure of Object.keys(f.row.source_rights.exposures)) assert.deepEqual(await f.check({ retention: true, exposure }), initial);
  assert.deepEqual(await f.check(REQUEST, CONTEXT, { ...PURPOSE, selection_sha256: 'b'.repeat(64) }), initial);
  f.row.checked_at = '2026-09-10T12:00:00.000000Z';
  f.row.source_rights = Object.fromEntries(Object.entries(f.row.source_rights).reverse());
  assert.deepEqual(await f.check(), initial);
});

for (const [name, change] of [
  ['basis', c => { c.rights_basis.basis_reference = 'fixture-revised-basis'; }],
  ['expiry', c => { c.expires_at = '2026-10-02T00:00:00.000000Z'; }],
  ['unrequested member exposure', c => { c.exposures.report_observation_members = false; }],
  ['approval identity', c => { c.rights_basis.approved_by = 'fixture-another-owner'; }],
]) test(`every accepted ${name} change invalidates initial/final policy equality`, async () => {
  const f = fixture(), first = await f.check();
  change(f.row.source_rights);
  const next = await f.check();
  assert.equal(next.allowed, true);
  assert.notEqual(next.policy_revision, first.policy_revision);
  assert.equal(f.calls.length, 2); // no grant cache
});

for (const [name, change] of [
  ['absent grant despite application role', r => { r.source_rights = null; }],
  ['inactive organization', r => { r.active = false; }],
  ['foreign organization row', r => { r.organization_id = OTHER_ORG; }],
  ['foreign organization grant', r => { r.source_rights.organization_id = OTHER_ORG; }],
  ['revoked grant', r => { r.source_rights.revoked_at = NOW; }],
  ['expired grant exact microsecond', r => { r.source_rights.expires_at = NOW; }],
  ['future validity', r => { r.source_rights.valid_from = '2026-09-09T12:00:00.123457Z'; }],
  ['future approval', r => { r.source_rights.rights_basis.approved_at = '2026-09-09T12:00:00.123457Z'; }],
  ['invalid clock', r => { r.checked_at = '2026-02-30T12:00:00.000000Z'; }],
  ['missing clock', r => { delete r.checked_at; }],
  ['invalid expiry', r => { r.source_rights.expires_at = '2026-09-31T00:00:00.000000Z'; }],
  ['no expiry', r => { r.source_rights.expires_at = null; }],
  ['missing owner basis', r => { r.source_rights.rights_basis.basis_reference = ''; }],
  ['unknown config field', r => { r.source_rights.license_waiver = true; }],
  ['unknown policy version', r => { r.source_rights.policy_version = 2; }],
  ['unknown purpose version', r => { r.source_rights.purpose_version = 2; }],
  ['changed dataset revision', r => { r.source_rights.dataset.revision = 'fixture-new-dataset'; }],
  ['CSV-only coverage', r => { r.source_rights.dataset.coverage = 'latest_csv_sha_only'; }],
  ['changed provider terms', r => { r.source_rights.dataset.provider_revisions[0].revision = 'fixture-other-terms'; }],
  ['new unapproved provider', r => { r.source_rights.dataset.provider_revisions.push({ provider_id: 'fixture-new-trestle', revision: '1' }); }],
  ['missing provider', r => { r.source_rights.dataset.provider_revisions.pop(); }],
  ['duplicate provider', r => { r.source_rights.dataset.provider_revisions[1] = copy(r.source_rights.dataset.provider_revisions[0]); }],
  ['partial date scope', r => { r.source_rights.purpose_scope.event_date_scope = 'observation_period_only'; }],
  ['partial associations', r => { r.source_rights.purpose_scope.association_metadata = 'selected_accounts_only'; }],
  ['missing retention', r => { r.source_rights.retention = false; }],
  ['implicit exposure', r => { delete r.source_rights.exposures.report_observation_catalog; }],
  ['truthy exposure', r => { r.source_rights.exposures.report_observation_members = 'true'; }],
  ['no internal access', r => { r.source_rights.exposures.none = false; }],
]) test(`denies ${name}`, async () => {
  const f = fixture(); change(f.row);
  assert.deepEqual(await f.check(), { allowed: false });
});

test('each external exposure requires its own explicit grant', async () => {
  const f = fixture();
  for (const exposure of ['report_observation_summary', 'report_observation_members', 'report_observation_catalog']) {
    f.row.source_rights.exposures[exposure] = false;
    assert.deepEqual(await f.check({ retention: true, exposure }), { allowed: false });
    assert.equal((await f.check()).allowed, true);
  }
});

test('invalid or broader caller purpose is denied before any database access', async () => {
  const mutations = [p => { p.source_classes.push('private.overlays'); }, p => { p.private_assignment_overlays = true; },
    p => { p.additional_cadastral_accounts = true; }, p => { p.kind = 'bulk_export'; },
    p => { p.knowledge_cutoff = '2026-09-01T00:00:00.000Z'; }, p => { p.selection_sha256 = 'arbitrary'; },
    p => { p.observation_period.end_date = '2026-09-10'; }, p => { p.observation_period.start_date = '2026-02-30'; },
    p => { p.observation_period.start_date = '2026-09-10'; }, p => { p.extra = true; }];
  for (const mutate of mutations) {
    const f = fixture(), purpose = copy(PURPOSE); mutate(purpose);
    assert.deepEqual(await f.check(REQUEST, CONTEXT, purpose), { allowed: false });
    assert.equal(f.calls.length, 0);
  }
});

test('missing actor, wrong workflow, malformed organization and non-contract exposure are not grants', async () => {
  const f = fixture();
  assert.deepEqual(await f.check(REQUEST, CONTEXT, PURPOSE, {}), { allowed: false });
  assert.deepEqual(await f.check(REQUEST, { ...CONTEXT, target: { workflow_type: 'uad_3_6' } }), { allowed: false });
  assert.deepEqual(await f.check(REQUEST, { ...CONTEXT, scope: { organization_id: 'bad' } }), { allowed: false });
  for (const request of [{ retention: false, exposure: 'none' }, { retention: true, exposure: 'export_all' }, REQUEST.exposure]) {
    assert.deepEqual(await f.check(request), { allowed: false });
  }
  assert.equal(f.calls.length, 0);
});

test('trusted provider profile is mandatory, copied, order-insensitive and separate from organization metadata', async () => {
  for (const invalid of [undefined, {}, { ...PROFILE, datasetRevision: '' }, { ...PROFILE, providerRevisions: [] },
    { ...PROFILE, providerRevisions: [...PROFILE.providerRevisions, PROFILE.providerRevisions[0]] }]) {
    assert.throws(() => createCustomNeighborhoodSourcePolicy(invalid), /profile_required/);
  }
  const f = fixture(), profile = copy(PROFILE), policy = createCustomNeighborhoodSourcePolicy(profile);
  profile.providerRevisions[0].revision = 'caller-mutated';
  f.row.source_rights.dataset.provider_revisions.reverse();
  assert.equal((await policy(f.client, AUTH, CONTEXT, PURPOSE, REQUEST)).allowed, true);
  const newerProfile = createCustomNeighborhoodSourcePolicy({ ...PROFILE, datasetRevision: 'fixture-new-inventory' });
  assert.deepEqual(await newerProfile(f.client, AUTH, CONTEXT, PURPOSE, REQUEST), { allowed: false });
});

test('source rights metadata and driver errors cannot leak through denial results', async () => {
  const f = fixture();
  assert.deepEqual(await f.policy({ query: async () => ({ rows: [] }) }, AUTH, CONTEXT, PURPOSE, REQUEST), { allowed: false });
  assert.deepEqual(await f.policy({ query: async () => ({ rows: [f.row, f.row] }) }, AUTH, CONTEXT, PURPOSE, REQUEST), { allowed: false });
  await assert.rejects(f.policy({ query: async () => { throw new Error('postgres://secret-user:secret-password@host/db'); } },
    AUTH, CONTEXT, PURPOSE, REQUEST), error => error.message === 'custom_neighborhood_source_policy_unavailable'
      && error.code === 'CUSTOM_NEIGHBORHOOD_SOURCE_POLICY_UNAVAILABLE' && error.cause === undefined);
});

test('bounded metadata rejects oversized valid-shape policy and unknown deeply nested content', async () => {
  const f = fixture(), profile = copy(PROFILE);
  profile.providerRevisions = Array.from({ length: 32 }, (_, index) => ({ provider_id: `${index}`.padEnd(200, 'x'), revision: 'r'.repeat(200) }));
  f.row.source_rights.dataset.provider_revisions = copy(profile.providerRevisions);
  f.row.source_rights.rights_basis.basis_reference = 'b'.repeat(1000);
  f.row.source_rights.rights_basis.owner_id = 'o'.repeat(200);
  f.row.source_rights.rights_basis.approved_by = 'a'.repeat(200);
  const policy = createCustomNeighborhoodSourcePolicy(profile);
  // The mock bypasses SQL's 16KiB guard; JavaScript independently bounds output.
  assert.ok(Buffer.byteLength(JSON.stringify(f.row.source_rights)) > 16_384);
  assert.deepEqual(await policy(f.client, AUTH, CONTEXT, PURPOSE, REQUEST), { allowed: false });
  f.row.source_rights = config();
  f.row.source_rights.extra = { deeper: { attacker: 'not walked or serialized' } };
  assert.deepEqual(await f.check(), { allowed: false });
});
