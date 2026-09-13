import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalAssessmentJson as canonical } from '../src/services/neighborhoodAssessment/contract.js';
import { describeNeighborhoodCachedMarketDataPurpose, describeNeighborhoodSaleWitnessMarketDataPurpose,
  describeNeighborhoodCombinedEvidenceMarketDataPurpose } from '../src/services/neighborhoodAssessment/cachedReadAccess.js';
import { CACHED_SALE_WITNESS_V2_FIELDS } from '../src/services/neighborhoodAssessment/cachedSaleWitnessV2.js';
import { createCustomNeighborhoodSourcePolicy as createLegacy, CUSTOM_NEIGHBORHOOD_SOURCE_DATASET as DATASET,
  CUSTOM_NEIGHBORHOOD_SOURCE_PURPOSE as LEGACY_SCOPE, CUSTOM_NEIGHBORHOOD_SOURCE_RIGHTS_KEY as LEGACY_KEY } from '../src/security/customNeighborhoodSourcePolicy.js';
import { createCustomNeighborhoodWitness2SourcePolicy as create, CUSTOM_NEIGHBORHOOD_WITNESS2_SOURCE_RIGHTS_KEY as KEY,
  CUSTOM_NEIGHBORHOOD_WITNESS2_SOURCE_PURPOSE as SCOPE } from '../src/security/customNeighborhoodWitness2SourcePolicy.js';

const ORG = '70000000-0000-4000-8000-000000000001', OTHER = '70000000-0000-4000-8000-000000000002';
const NOW = '2026-09-09T12:00:00.123456Z';
const AUTH = { userId: 'fixture-actor', organizations: [{ organizationId: ORG, roles: ['organization_admin'] }] };
const CONTEXT = { target: { workflow_type: 'custom_appraisal' }, scope: { organization_id: ORG }, effective_date: '2026-09-09' };
const PROFILE = { datasetRevision: 'fixture-integrated-inventory-7', providerRevisions: [
  { provider_id: 'fixture-manual-provider', revision: 'fixture-approved-terms-3' },
  { provider_id: 'fixture-legacy-provider', revision: 'fixture-approved-terms-2' },
] };
const purposeInput = { effective_date: CONTEXT.effective_date, selection_sha256: 'a'.repeat(64),
  observation_period: { start_date: '2025-09-09', end_date: '2026-09-09' }, knowledge_cutoff: null };
const PURPOSE = describeNeighborhoodCombinedEvidenceMarketDataPurpose(purposeInput);
const LEGACY_PURPOSE = describeNeighborhoodCachedMarketDataPurpose(purposeInput);
const REQUEST = { retention: true, exposure: 'none' };
const copy = value => structuredClone(value), sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
function config(scope = SCOPE) {
  return { policy_version: 1, organization_id: ORG, grant_id: 'fixture-owner-grant',
    dataset: { id: DATASET, revision: PROFILE.datasetRevision,
      coverage: 'entire_integrated_source_mix_including_prior_merged_values', provider_revisions: copy(PROFILE.providerRevisions) },
    purpose_version: 1, purpose_scope: copy(scope),
    rights_basis: { owner_id: 'fixture-source-rights-owner', basis_reference: 'fixture-only-not-a-production-grant',
      approved_by: 'fixture-owner-approver', approved_at: '2026-09-01T00:00:00.000000Z' },
    valid_from: '2026-09-02T00:00:00.000000Z', expires_at: '2026-10-01T00:00:00.000000Z', revoked_at: null,
    retention: 'immutable_originals_without_automated_deletion',
    exposures: { none: true, report_observation_summary: true, report_observation_members: true, report_observation_catalog: true } };
}
function fixture() {
  const metadata = { [KEY]: config(), [LEGACY_KEY]: config(LEGACY_SCOPE) }, calls = [];
  const state = { organization_id: ORG, active: true, checked_at: NOW };
  const client = { async query(sql, params) { calls.push({ sql, params });
    return { rows: [{ ...state, source_rights: metadata[params[1]] ?? null }] }; } };
  const policy = create(copy(PROFILE)), legacy = createLegacy(copy(PROFILE));
  return { metadata, state, calls, client, policy, legacy,
    check: (request = REQUEST, context = CONTEXT, purpose = PURPOSE, auth = AUTH) => policy(client, auth, context, purpose, request),
    old: (request = REQUEST, purpose = LEGACY_PURPOSE) => legacy(client, AUTH, CONTEXT, purpose, request) };
}

test('parallel fixed scope exactly matches the installed combined descriptor and cannot be caller-selected', () => {
  assert.equal(KEY, 'custom_neighborhood_witness2_source_rights_v1'); assert.notEqual(KEY, LEGACY_KEY);
  assert.deepEqual(PURPOSE, { ...SCOPE, selection_sha256: purposeInput.selection_sha256,
    observation_period: purposeInput.observation_period, knowledge_cutoff: null });
  assert.deepEqual(SCOPE.source_projection, { id: 'cached-combined-evidence-v1', mapping_version: 5, witness_version: 2,
    fields: CACHED_SALE_WITNESS_V2_FIELDS });
  for (const value of [SCOPE, SCOPE.source_projection, SCOPE.source_projection.fields, SCOPE.source_classes, SCOPE.source_classification]) assert.ok(Object.isFrozen(value));
  assert.equal(Object.hasOwn(LEGACY_SCOPE, 'source_projection'), false);
  for (const extra of [{ namespace: LEGACY_KEY }, { purpose: LEGACY_SCOPE }, { mappingVersion: 4 }, { policyVersion: 2 }]) {
    assert.throws(() => create({ ...PROFILE, ...extra }), { message: 'custom_neighborhood_witness2_source_policy_profile_required' });
  }
});

test('valid independently provisioned grant authorizes all four exposures through one bounded namespace read each', async () => {
  const f = fixture(), before = copy(f.metadata), decision = await f.check();
  assert.equal(decision.allowed, true); assert.ok(Object.isFrozen(decision));
  assert.deepEqual(decision, { allowed: true, decision_id: `${ORG}:fixture-owner-grant`,
    policy_revision: 'custom-neighborhood-witness2-source-rights-v1:sha256:bce2f7b467a5d64d63c063b286d3283a707fdc98f5cd1c618492a51dd329f6fb' });
  for (const exposure of Object.keys(f.metadata[KEY].exposures)) assert.deepEqual(await f.check({ retention: true, exposure }), decision);
  assert.equal(f.calls.length, 5); assert.deepEqual(f.metadata, before);
  for (const call of f.calls) {
    assert.deepEqual(call.params, [ORG, KEY, 16_384]);
    assert.match(call.sql, /clock_timestamp\(\) AT TIME ZONE 'UTC'/);
    assert.match(call.sql, /CASE WHEN octet_length\(\(metadata -> \$2::text\)::text\) <= \$3::integer/);
    assert.match(call.sql, /WHERE id = \$1::uuid/);
    assert.doesNotMatch(call.sql, /\b(BEGIN|COMMIT|ROLLBACK|UPDATE|INSERT|DELETE|FOR UPDATE|now\(\))\b/i);
  }
  assert.equal(sha(canonical(f.metadata[KEY])), 'bce2f7b467a5d64d63c063b286d3283a707fdc98f5cd1c618492a51dd329f6fb');
  assert.equal(sha(f.calls[0].sql), 'a2f2d46358b07f7ca3bb216c4b1103eb6119fdab1e39a5c8d486b43a0a8b4951');
});

test('legacy config, decision, SQL arguments and errors remain exact independent goldens', async () => {
  const f = fixture(), old = await f.old(), oldCall = f.calls[0];
  assert.deepEqual(oldCall.params, [ORG, 'custom_neighborhood_source_rights', 16_384]);
  assert.deepEqual(old, { allowed: true, decision_id: `${ORG}:fixture-owner-grant`,
    policy_revision: 'custom-neighborhood-source-rights-v1:sha256:d139966f17ab3c7c56408d9d362d8a045f7a95f938d4a5132ff40645c93365e9' });
  assert.equal(sha(canonical(f.metadata[LEGACY_KEY])), 'd139966f17ab3c7c56408d9d362d8a045f7a95f938d4a5132ff40645c93365e9');
  assert.equal(sha(oldCall.sql), '9101a79a13f6d34d16c8e8259a5221c1b30760e7faf46ea27ced749d29d80c73');
  await f.check(); assert.deepEqual(await f.old(), old); assert.deepEqual(f.calls.at(-1), oldCall);
  await assert.rejects(f.legacy({ query: async () => { throw new Error('postgres://secret'); } }, AUTH, CONTEXT, LEGACY_PURPOSE, REQUEST),
    error => error.message === 'custom_neighborhood_source_policy_unavailable' && error.code === 'CUSTOM_NEIGHBORHOOD_SOURCE_POLICY_UNAVAILABLE' && error.cause === undefined);
  assert.throws(() => createLegacy({}), { message: 'custom_neighborhood_source_policy_profile_required' });
});

test('old and witness2 purposes cross-deny before SQL; no namespace is an implicit upgrade', async () => {
  const f = fixture();
  for (const exposure of Object.keys(f.metadata[KEY].exposures)) {
    assert.deepEqual(await f.check({ retention: true, exposure }, CONTEXT, LEGACY_PURPOSE), { allowed: false });
    assert.deepEqual(await f.check({ retention: true, exposure }, CONTEXT, describeNeighborhoodSaleWitnessMarketDataPurpose(purposeInput)), { allowed: false });
    assert.deepEqual(await f.old({ retention: true, exposure }, PURPOSE), { allowed: false });
  }
  assert.equal(f.calls.length, 0);
  delete f.metadata[KEY]; assert.deepEqual(await f.check(), { allowed: false }); assert.equal((await f.old()).allowed, true);
  f.metadata[KEY] = config(LEGACY_SCOPE); assert.deepEqual(await f.check(), { allowed: false });
  f.metadata[KEY] = config(); delete f.metadata[LEGACY_KEY]; assert.deepEqual(await f.old(), { allowed: false }); assert.equal((await f.check()).allowed, true);
  f.metadata[LEGACY_KEY] = config(); assert.deepEqual(await f.old(), { allowed: false });
  assert.equal((await f.check()).allowed, true);
});

test('every older numeric mapping and any altered projection field/version/order fails before database access', async () => {
  const f = fixture();
  const changes = [p => { delete p.source_projection; }, ...[1, 2, 3, 4, 6, '5', null].map(version => p => { p.source_projection.mapping_version = version; }),
    ...[1, 3, '2', null].map(version => p => { p.source_projection.witness_version = version; }),
    p => { p.source_projection.id = 'cached-sale-scalar-witness-v1'; }, p => { p.source_projection.fields.pop(); },
    p => { p.source_projection.fields.reverse(); }, p => { p.source_projection.fields[0] = 'PrivateRemarks'; },
    p => { p.source_projection.fields[1] = p.source_projection.fields[0]; }, p => { p.source_projection.fields.push('PublicRemarks'); },
    p => { delete p.source_projection.fields[0]; }, p => { p.source_projection.fields.extra = true; },
    p => { p.source_projection.extra = true; }, p => { p.source_classes.push('private.overlays'); },
    p => { p.source_classes.reverse(); }, p => { p.private_assignment_overlays = true; }, p => { p.additional_cadastral_accounts = true; },
    p => { p.association_metadata = 'selected_accounts_only'; }, p => { p.event_date_scope = 'observation_period_only'; },
    p => { p.source_classification['core.sales_source_records'] = 'public_cadastral'; }, p => { p.kind = 'bulk_export'; },
    p => { p.knowledge_cutoff = NOW; }, p => { p.selection_sha256 = 'bad'; }, p => { p.extra = true; },
    p => { p.observation_period.end_date = '2026-09-10'; }, p => { p.observation_period.start_date = '2026-02-30'; },
    p => { p.observation_period.start_date = '2026-09-10'; }];
  for (const change of changes) { const purpose = copy(PURPOSE); change(purpose); assert.deepEqual(await f.check(REQUEST, CONTEXT, purpose), { allowed: false }); }
  assert.equal(f.calls.length, 0);
});

for (const [name, change] of [
  ['inactive organization', (c, s) => { s.active = false; }], ['foreign organization row', (c, s) => { s.organization_id = OTHER; }],
  ['wrong grant organization', c => { c.organization_id = OTHER; }], ['revoked', c => { c.revoked_at = NOW; }],
  ['expired exact microsecond', c => { c.expires_at = NOW; }], ['future validity', c => { c.valid_from = '2026-09-09T12:00:00.123457Z'; }],
  ['future approval', c => { c.rights_basis.approved_at = '2026-09-09T12:00:00.123457Z'; }],
  ['no expiry', c => { c.expires_at = null; }], ['invalid calendar expiry', c => { c.expires_at = '2026-09-31T00:00:00.000000Z'; }],
  ['invalid DB clock', (c, s) => { s.checked_at = '2026-02-30T00:00:00.000000Z'; }], ['missing DB clock', (c, s) => { delete s.checked_at; }],
  ['missing owner basis', c => { c.rights_basis.basis_reference = ''; }], ['unknown basis property', c => { c.rights_basis.waiver = true; }],
  ['unknown config property', c => { c.license_waiver = true; }], ['policy version', c => { c.policy_version = 2; }],
  ['purpose version', c => { c.purpose_version = 2; }], ['old purpose scope', c => { c.purpose_scope = copy(LEGACY_SCOPE); }],
  ['wrong witness version', c => { c.purpose_scope.source_projection.witness_version = 1; }],
  ['partial witness whitelist', c => { c.purpose_scope.source_projection.fields.pop(); }],
  ['revised dataset', c => { c.dataset.revision = 'unapproved'; }], ['unknown dataset', c => { c.dataset.id = 'latest_csv_only'; }],
  ['partial source mix', c => { c.dataset.coverage = 'latest_csv_sha_only'; }], ['changed terms', c => { c.dataset.provider_revisions[0].revision = 'unapproved'; }],
  ['missing provider', c => { c.dataset.provider_revisions.pop(); }], ['new provider', c => { c.dataset.provider_revisions.push({ provider_id: 'new', revision: 'new' }); }],
  ['duplicate provider', c => { c.dataset.provider_revisions[1] = copy(c.dataset.provider_revisions[0]); }],
  ['retention omitted', c => { c.retention = false; }], ['no internal exposure', c => { c.exposures.none = false; }],
  ['missing exposure', c => { delete c.exposures.report_observation_members; }], ['truthy exposure', c => { c.exposures.report_observation_members = 'true'; }],
  ['unknown exposure', c => { c.exposures.export_all = true; }],
]) test(`witness2 denies ${name} without disclosing grant contents`, async () => {
  const f = fixture(); change(f.metadata[KEY], f.state); assert.deepEqual(await f.check(), { allowed: false }); assert.equal(f.calls.length, 1);
});

test('every external exposure is separately granted; exposure cannot change while its query awaits', async () => {
  const f = fixture();
  for (const exposure of ['report_observation_summary', 'report_observation_members', 'report_observation_catalog']) {
    f.metadata[KEY].exposures[exposure] = false;
    assert.deepEqual(await f.check({ retention: true, exposure }), { allowed: false }); assert.equal((await f.check()).allowed, true);
  }
  const requested = { retention: true, exposure: 'report_observation_members' }; let finish;
  const client = { query: () => new Promise(resolve => { finish = resolve; }) };
  const pending = f.policy(client, AUTH, CONTEXT, PURPOSE, requested); requested.exposure = 'none';
  finish({ rows: [{ ...f.state, source_rights: f.metadata[KEY] }] });
  assert.deepEqual(await pending, { allowed: false }, 'the originally requested ungranted exposure cannot become permitted internal access');
});

test('each authorization re-reads current metadata and database wall time; no earlier success is cached', async () => {
  const f = fixture(), original = await f.check();
  assert.deepEqual(await f.check(REQUEST, CONTEXT, { ...PURPOSE, selection_sha256: 'b'.repeat(64) }), original);
  f.metadata[KEY] = Object.fromEntries(Object.entries(f.metadata[KEY]).reverse()); assert.deepEqual(await f.check(), original);
  f.state.checked_at = '2026-09-30T23:59:59.999999Z'; assert.deepEqual(await f.check(), original);
  f.state.checked_at = '2026-10-01T00:00:00.000000Z'; assert.deepEqual(await f.check(), { allowed: false });
  f.state.checked_at = NOW; f.metadata[KEY].revoked_at = NOW; assert.deepEqual(await f.check(), { allowed: false });
  f.metadata[KEY] = config(); assert.deepEqual(await f.check(), original);
  delete f.metadata[KEY]; assert.deepEqual(await f.check(), { allowed: false });
  assert.equal(f.calls.length, 8);
});

test('accepted grant changes alter only the separate revision; profile options are copied and provider comparison is set-based', async () => {
  const f = fixture(), original = await f.check();
  for (const mutate of [c => { c.rights_basis.basis_reference += '-changed'; }, c => { c.rights_basis.approved_by += '-changed'; },
    c => { c.expires_at = '2026-10-02T00:00:00.000000Z'; }, c => { c.exposures.report_observation_members = false; }]) {
    f.metadata[KEY] = config(); mutate(f.metadata[KEY]); const next = await f.check();
    assert.equal(next.allowed, true); assert.notEqual(next.policy_revision, original.policy_revision); assert.deepEqual(await f.check(), next);
  }
  const supplied = copy(PROFILE), policy = create(supplied); supplied.providerRevisions[0].revision = 'mutated'; supplied.datasetRevision = 'changed';
  f.metadata[KEY] = config(); f.metadata[KEY].dataset.provider_revisions.reverse();
  assert.equal((await policy(f.client, AUTH, CONTEXT, PURPOSE, REQUEST)).allowed, true);
  assert.notEqual((await f.check()).policy_revision, original.policy_revision, 'an accepted stored array-order change still changes exact config bytes');
});

test('bad actors, workflows, scopes, requests and provider options cannot reach SQL', async () => {
  const f = fixture();
  for (const auth of [{}, { userId: '' }, { userId: 'bad\nactor' }]) assert.deepEqual(await f.check(REQUEST, CONTEXT, PURPOSE, auth), { allowed: false });
  for (const context of [{ ...CONTEXT, target: { workflow_type: 'uad_3_6' } }, { ...CONTEXT, scope: { organization_id: 'bad' } },
    { ...CONTEXT, effective_date: '2026-02-30' }]) assert.deepEqual(await f.check(REQUEST, context), { allowed: false });
  for (const requested of [null, {}, 'none', { retention: false, exposure: 'none' }, { retention: true, exposure: 'bulk_export' }, { ...REQUEST, waiver: true }]) {
    assert.deepEqual(await f.check(requested), { allowed: false });
  }
  assert.equal(f.calls.length, 0);
  for (const options of [undefined, {}, { ...PROFILE, datasetRevision: '' }, { ...PROFILE, providerRevisions: [] },
    { ...PROFILE, providerRevisions: Array(1) }, { ...PROFILE, providerRevisions: [...PROFILE.providerRevisions, PROFILE.providerRevisions[0]] }]) {
    assert.throws(() => create(options), { message: 'custom_neighborhood_witness2_source_policy_profile_required' });
  }
});

test('projection/config/provider accessors, proxies and decorated arrays are rejected without execution', async () => {
  const f = fixture(); let executed = 0;
  const getter = { enumerable: true, get() { executed++; throw new Error('getter must not run'); } };
  for (const target of ['scope', 'projection', 'fields']) {
    const purpose = copy(PURPOSE);
    Object.defineProperty(target === 'scope' ? purpose : target === 'projection' ? purpose.source_projection : purpose.source_projection.fields,
      target === 'scope' ? 'source_projection' : target === 'projection' ? 'fields' : '0', getter);
    assert.deepEqual(await f.check(REQUEST, CONTEXT, purpose), { allowed: false });
  }
  assert.equal(f.calls.length, 0);
  const handler = Object.fromEntries(['get', 'ownKeys', 'getPrototypeOf', 'getOwnPropertyDescriptor'].map(key => [key, () => { executed++; throw new Error('trap must not run'); }]));
  const revoked = Proxy.revocable({}, handler); revoked.revoke();
  for (const proxy of [new Proxy({}, handler), revoked.proxy]) {
    assert.deepEqual(await f.check(REQUEST, CONTEXT, proxy), { allowed: false });
    const purpose = copy(PURPOSE); purpose.source_projection = proxy; assert.deepEqual(await f.check(REQUEST, CONTEXT, purpose), { allowed: false });
    f.metadata[KEY] = proxy; assert.deepEqual(await f.check(), { allowed: false });
    assert.throws(() => create(proxy), { message: 'custom_neighborhood_witness2_source_policy_profile_required' });
    const fields = copy(PURPOSE); fields.source_projection.fields = proxy;
    assert.deepEqual(await f.check(REQUEST, CONTEXT, fields), { allowed: false });
    assert.throws(() => create({ ...PROFILE, providerRevisions: proxy }), { message: 'custom_neighborhood_witness2_source_policy_profile_required' });
    f.metadata[KEY] = config(); f.metadata[KEY].dataset.provider_revisions = proxy;
    assert.deepEqual(await f.check(), { allowed: false });
  }
  for (const path of [['rights_basis', 'approved_by'], ['dataset', 'revision'], ['purpose_scope', 'source_projection']]) {
    f.metadata[KEY] = config(); Object.defineProperty(f.metadata[KEY][path[0]], path[1], getter);
    assert.deepEqual(await f.check(), { allowed: false });
  }
  const options = copy(PROFILE); Object.defineProperty(options.providerRevisions[0], 'revision', getter);
  assert.throws(() => create(options), { message: 'custom_neighborhood_witness2_source_policy_profile_required' });
  assert.equal(executed, 0);
});

test('SQL overflow sentinel and independent oversized valid-shape metadata refuse; driver errors stay sanitized', async () => {
  const f = fixture(); f.metadata[KEY] = null; assert.deepEqual(await f.check(), { allowed: false });
  const expected = copy(PROFILE); expected.providerRevisions = Array.from({ length: 32 }, (_, i) => ({ provider_id: `${i}`.padEnd(200, 'x'), revision: 'r'.repeat(200) }));
  const policy = create(expected); f.metadata[KEY] = config(); f.metadata[KEY].dataset.provider_revisions = copy(expected.providerRevisions);
  Object.assign(f.metadata[KEY].rights_basis, { owner_id: 'o'.repeat(200), approved_by: 'a'.repeat(200), basis_reference: 'b'.repeat(1000) });
  assert.ok(Buffer.byteLength(canonical(f.metadata[KEY])) > 16_384);
  assert.deepEqual(await policy(f.client, AUTH, CONTEXT, PURPOSE, REQUEST), { allowed: false });
  for (const rows of [[], [null], Array(1), [{ ...f.state, source_rights: config() }, { ...f.state, source_rights: config() }]]) {
    assert.deepEqual(await f.policy({ query: async () => ({ rows }) }, AUTH, CONTEXT, PURPOSE, REQUEST), { allowed: false });
  }
  await assert.rejects(f.policy({ query: async () => { throw Object.assign(new Error('postgres://secret/password'), { secret: true }); } }, AUTH, CONTEXT, PURPOSE, REQUEST),
    error => error.message === 'custom_neighborhood_witness2_source_policy_unavailable'
      && error.code === 'CUSTOM_NEIGHBORHOOD_WITNESS2_SOURCE_POLICY_UNAVAILABLE' && error.cause === undefined && error.secret === undefined);
});
