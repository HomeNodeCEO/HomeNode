import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCustomNeighborhoodConfiguration, createCustomNeighborhoodApplicationRouter } from '../src/application/customNeighborhoodComposition.js';
import { mountApplicationRouteBoundary } from '../src/security/applicationRouteBoundary.js';
import { createWebSessionAuthenticator, WEB_SESSION_COOKIE } from '../src/security/webAuth.js';
import { jsonErrorHandler } from '../src/security/httpSecurity.js';
import { prepareCustomCohortContextHeader } from '../src/services/neighborhoodAssessment/customCohortContextContract.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';
import { cadEvidenceFixture } from './fixtures/customCohortCadEvidenceFixture.js';
import { saleWitnessMeaningFixture } from './fixtures/customCohortSaleWitnessMeaningFixture.js';
import { getCustomCohortReportedSaleWitnessV2Profile } from '../src/services/neighborhoodAssessment/customCohortReportedSaleWitnessV2.js';
import { createCustomNeighborhoodSourcePolicy, CUSTOM_NEIGHBORHOOD_SOURCE_PURPOSE as LEGACY_PURPOSE,
  CUSTOM_NEIGHBORHOOD_SOURCE_RIGHTS_KEY as LEGACY_KEY, CUSTOM_NEIGHBORHOOD_SOURCE_DATASET as DATASET } from '../src/security/customNeighborhoodSourcePolicy.js';
import { createCustomNeighborhoodWitness2SourcePolicy, CUSTOM_NEIGHBORHOOD_WITNESS2_SOURCE_PURPOSE as WITNESS2_PURPOSE,
  CUSTOM_NEIGHBORHOOD_WITNESS2_SOURCE_RIGHTS_KEY as WITNESS2_KEY } from '../src/security/customNeighborhoodWitness2SourcePolicy.js';

const PROFILE = { datasetRevision: 'synthetic-dataset-1',
  providerRevisions: [{ provider_id: 'synthetic-provider', revision: 'synthetic-revision-1' }] };
const ACTOR = '80000000-0000-4000-8000-000000000001';
const OTHER_ACTOR = '80000000-0000-4000-8000-000000000002';
const ORG = '90000000-0000-4000-8000-000000000001';
const identity = { userId: ACTOR, organizations: [{ organizationId: ORG, roles: ['appraiser'] }] };
const BEARER = { authorization: 'Bearer synthetic-application-token' };
const cookieHeaders = { cookie: `${WEB_SESSION_COOKIE}=synthetic-cookie-token`, origin: 'https://app.example.test' };
const row = value => ({ rows: value ? [structuredClone(value)] : [], rowCount: value ? 1 : 0 });

// Actual application boundary, session authenticator, policy, coordinator and
// cohort router; only bearer verification and SQL results are synthetic here.
// This is not a PostgreSQL isolation/locking or provider-authorization test.
async function start(t, { enabled = false, sourceMode, authenticationRequired = true, principal = identity, cohortPool } = {}) {
  const app = express(), state = {
    sessionQueries: 0,
    preAuthenticationPaths: [],
    ratePaths: [],
    cohortConnections: 0,
  };
  const pool = {
    async query(sql) {
      state.sessionQueries++;
      assert.match(sql, /FROM app_auth\.web_sessions sessions/);
      return row({ session_id: '70000000-0000-4000-8000-000000000001', user_id: principal.userId,
        email: 'synthetic@example.test', display_name: 'Synthetic Appraiser',
        organization_id: principal.organizations[0]?.organizationId, role_code: 'appraiser' });
    },
    async connect() {
      state.cohortConnections++;
      if (cohortPool) return cohortPool.connect();
      throw new Error('synthetic-private-driver-connection-string');
    },
  };
  const configuration = createCustomNeighborhoodConfiguration(enabled ? {
    CUSTOM_NEIGHBORHOOD_WORKSPACE_ENABLED: 'true', CUSTOM_NEIGHBORHOOD_SOURCE_PROFILE_JSON: JSON.stringify(PROFILE),
    ...(sourceMode === undefined ? {} : { CUSTOM_NEIGHBORHOOD_SOURCE_MODE: sourceMode }),
  } : {});
  mountApplicationRouteBoundary(app, {
    authenticationPolicy: { authenticationRequired, mode: authenticationRequired ? 'enforced' : 'development_legacy' },
    webSessionAuthenticator: createWebSessionAuthenticator({ pool, environment: { WEB_APP_URL: 'https://app.example.test' } }),
    uadRouter(req, res) { res.json({ surface: 'uad', parsed: req.body !== undefined }); },
    uadBodyParserErrorHandler(_error, _req, _res, next) { next(); },
    jsonBodyParser: express.json({ limit: '1mb' }),
    mobileRouter(req, res) {
      return res.status(req.get('authorization') === 'Bearer synthetic-mobile-token' ? 200 : 401).json({ surface: 'mobile' });
    },
    optionalApplicationAuthenticator(req, _res, next) {
      if (req.get('authorization') === BEARER.authorization) req.mobileAuth = principal;
      next();
    },
    preAuthenticationRateLimiterOptions: {
      windowMs: 60_000, limit: 1000, standardHeaders: false, legacyHeaders: false,
      skipSuccessfulRequests: true,
      skip(req) { return /^\/api\/(?:uad|mobile)(?:\/|$)/.test(req.originalUrl); },
      keyGenerator(req) {
        state.preAuthenticationPaths.push(req.originalUrl);
        return 'synthetic-pre-authentication-client';
      },
    },
    globalApiRateLimiterOptions: { windowMs: 60_000, limit: 1000, standardHeaders: false, legacyHeaders: false,
      keyGenerator(req) { state.ratePaths.push(req.originalUrl); return `synthetic:${state.ratePaths.length}`; } },
    webAuthRouter(req, res, next) { return req.path === '/status' ? res.json({ configured: true }) : next(); },
    buildSession: auth => ({ user_id: auth.userId }), loadAuthReadiness: async () => ({ activation_ready: true }),
  });
  app.get('/api/accounts/:id/assignment-files/:fileId/workfile', (_req, res) => res.json({ surface: 'workfile' }));
  app.use(createCustomNeighborhoodApplicationRouter({ pool, configuration }));
  app.get('/api/legacy', (_req, res) => res.json({ surface: 'legacy' }));
  app.use(jsonErrorHandler);
  const server = await new Promise((resolve, reject) => {
    const handle = app.listen(0, '127.0.0.1', () => resolve(handle)); handle.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { state, async request(path, { body, headers = BEARER, method = 'POST' } = {}) {
    return fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  } };
}

const base = '/api/accounts/R-001/neighborhood-cohort';
async function responseIs(response, status, error) {
  assert.equal(response.status, status); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error });
}

for (const authenticationRequired of [true, false]) {
  test(`disabled mount denies anonymous before pool, including auth-required=${authenticationRequired}`, async t => {
    const server = await start(t, { authenticationRequired });
    for (const action of ['capture', 'preview', 'members', 'catalog']) {
      await responseIs(await server.request(`${base}/${action}`, { headers: {}, body: {} }), 401, 'authentication_required');
      await responseIs(await server.request(`${base}/${action}`, { body: {} }), 503, 'custom_neighborhood_workspace_disabled');
    }
    assert.equal(server.state.cohortConnections, 0); assert.equal(server.state.sessionQueries, 0);
    assert.equal(server.state.preAuthenticationPaths.length, 8,
      'each request is bounded before authentication dependencies');
    assert.equal(server.state.ratePaths.length, 4,
      'only authenticated requests enter the per-user limiter');
  });
}

for (const enabled of [false, true]) {
  test(`actual session CSRF denial runs before parser/cohort dependencies when enabled=${enabled}`, async t => {
    const server = await start(t, { enabled });
    await responseIs(await server.request(`${base}/catalog`, {
      headers: { ...cookieHeaders, origin: 'https://hostile.example.test' }, body: '{',
    }), 403, 'csrf_origin_denied');
    assert.equal(server.state.sessionQueries, 0); assert.equal(server.state.cohortConnections, 0);
    assert.deepEqual(server.state.preAuthenticationPaths, [`${base}/catalog`]);
    assert.deepEqual(server.state.ratePaths, []);
  });

  test(`route-local JSON parser retains authentication and its 4 MB limit when enabled=${enabled}`, async t => {
    const server = await start(t, { enabled });
    await responseIs(await server.request(`${base}/catalog`, { body: '{' }),
      enabled ? 400 : 503, enabled ? 'invalid_neighborhood_request' : 'custom_neighborhood_workspace_disabled');
    await responseIs(await server.request(`${base}/catalog`, { body: { payload: 'x'.repeat(1_100_000) } }),
      enabled ? 400 : 503, enabled ? 'invalid_neighborhood_request' : 'custom_neighborhood_workspace_disabled');
    await responseIs(await server.request(`${base}/catalog`, { body: { payload: 'x'.repeat(4_000_000) } }),
      enabled ? 413 : 503, enabled ? 'neighborhood_request_too_large' : 'custom_neighborhood_workspace_disabled');
    await responseIs(await server.request(`${base}/catalog`, {
      body: '{}', headers: { ...BEARER, 'content-type': 'application/json; charset=unsupported-charset' },
    }), 415, 'unsupported_request_encoding');
    assert.equal(server.state.cohortConnections, 0); assert.equal(server.state.sessionQueries, 0);
    assert.deepEqual(server.state.ratePaths, [
      `${base}/catalog`, `${base}/catalog`, `${base}/catalog`, `${base}/catalog`,
    ], 'global limiter must run before malformed, oversized, or unsupported JSON parsing');
  });
}

test('valid same-origin session is hydrated by the real authenticator before disabled gate', async t => {
  const server = await start(t);
  await responseIs(await server.request(`${base}/catalog`, { headers: cookieHeaders, body: {} }),
    503, 'custom_neighborhood_workspace_disabled');
  assert.equal(server.state.sessionQueries, 1); assert.equal(server.state.cohortConnections, 0);
});

test('mount does not intercept existing UAD, mobile, auth, workfile, legacy or sibling routes', async t => {
  const server = await start(t);
  const uad = await server.request('/api/uad/binary', { headers: {}, body: '{' });
  assert.equal(uad.status, 200); assert.deepEqual(await uad.json(), { surface: 'uad', parsed: false });
  const mobile = await server.request('/api/mobile/me', { method: 'GET', headers: { authorization: 'Bearer synthetic-mobile-token' } });
  assert.equal(mobile.status, 200);
  assert.equal((await server.request('/api/auth/status', { method: 'GET', headers: {} })).status, 200);
  const workfile = await server.request('/api/accounts/R-001/assignment-files/10/workfile', { method: 'GET' });
  assert.deepEqual(await workfile.json(), { surface: 'workfile' });
  const legacy = await server.request('/api/legacy', { method: 'GET' });
  assert.deepEqual(await legacy.json(), { surface: 'legacy' });
  assert.equal((await server.request('/api/accounts/R-001/neighborhood-cohort-other/catalog', { body: {} })).status, 404);
  assert.deepEqual(server.state.ratePaths, ['/api/accounts/R-001/assignment-files/10/workfile', '/api/legacy',
    '/api/accounts/R-001/neighborhood-cohort-other/catalog']);
  assert.equal(server.state.cohortConnections, 0);
});

test('enabled mount authenticates before route validation and sanitizes real owner connection failure', async t => {
  const server = await start(t, { enabled: true, authenticationRequired: false });
  await responseIs(await server.request(`${base}/capture`, { headers: {}, body: {} }), 401, 'authentication_required');
  await responseIs(await server.request(`${base}/capture`, { body: {} }), 400, 'invalid_neighborhood_request');
  await responseIs(await server.request(`${base}/capture`, { body: {
    assignment_file_id: '10', operation_id: '60000000-0000-4000-8000-000000000001',
    observation_period: { start_date: '2024-01-01', end_date: '2024-12-31' },
  } }), 500, 'neighborhood_request_failed');
  assert.equal(server.state.cohortConnections, 1);
});

test('enabled mount does not expose internal raw preview, review or accepted Apply owners', async t => {
  const server = await start(t, { enabled: true });
  for (const action of ['raw-preview', 'review', 'apply']) {
    const response = await server.request(`${base}/${action}`, { body: {} });
    assert.equal(response.status, 404); assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(server.state.cohortConnections, 0);
});

function installedGrant(organizationId, purpose) {
  return { policy_version: 1, organization_id: organizationId, grant_id: 'synthetic-composition-grant',
    dataset: { id: DATASET, revision: PROFILE.datasetRevision,
      coverage: 'entire_integrated_source_mix_including_prior_merged_values', provider_revisions: structuredClone(PROFILE.providerRevisions) },
    purpose_version: 1, purpose_scope: structuredClone(purpose),
    rights_basis: { owner_id: 'synthetic-rights-owner', basis_reference: 'test-fixture-not-a-provider-grant',
      approved_by: 'synthetic-approver', approved_at: '2026-09-01T00:00:00.000000Z' },
    valid_from: '2026-09-02T00:00:00.000000Z', expires_at: '2026-10-01T00:00:00.000000Z', revoked_at: null,
    retention: 'immutable_originals_without_automated_deletion',
    exposures: { none: true, report_observation_summary: true, report_observation_members: true, report_observation_catalog: true } };
}

async function retainedPolicyFixture({ mappingVersion = 2, marked = false, installedRights = false } = {}) {
  const metadata = {}, acquisitionPolicyCalls = [], originalPolicy = mappingVersion === 5
    ? createCustomNeighborhoodWitness2SourcePolicy(PROFILE) : createCustomNeighborhoodSourcePolicy(PROFILE);
  const capture = mappingVersion === 2 ? await decisionEvidenceFixture()
    : mappingVersion === 3 ? await saleWitnessMeaningFixture()
    : await cadEvidenceFixture({ mappingVersion,
      ...(marked ? { reportedSaleInterpretation: getCustomCohortReportedSaleWitnessV2Profile().profile_ref } : {}),
      ...(installedRights ? { authorizeMarketData: async (auth, context, purpose) => {
        metadata[LEGACY_KEY] = installedGrant(context.scope.organization_id, LEGACY_PURPOSE);
        metadata[WITNESS2_KEY] = installedGrant(context.scope.organization_id, WITNESS2_PURPOSE);
        return originalPolicy({ async query(sql, params) {
          acquisitionPolicyCalls.push({ sql, params, purpose: structuredClone(purpose) });
          return row({ organization_id: context.scope.organization_id, active: true,
            source_rights: metadata[params[1]], checked_at: '2026-09-09T12:00:00.000000Z' });
        } }, auth, context, purpose, { retention: true, exposure: 'none' });
      } } : {}) });
  const fixture = capture.base ?? capture, input = capture.input;
  const header = prepareCustomCohortContextHeader(input.context_header_json);
  await fixture.store.put(input.context_header_json);
  const scope = input.expected.target, target = fixture.f.state.input.target;
  const context = { ...header.context_ref, header_content_sha256: header.header_blob.ref.content_sha256,
    header_canonical_utf8_bytes: header.header_blob.ref.canonical_utf8_bytes };
  const payloads = new Set(input.retained_inputs.acquisition.capture_result.source_capture.source_snapshots.map(source => source.content_sha256));
  const state = { calls: [], policyChecks: 0, policyNamespaces: [], blobReads: [], sourceReads: 0, sourceReadCalls: [], releases: [], rollbacks: 0, assigned: ACTOR,
    policyThrows: false, missingTarget: false };
  const principal = { userId: ACTOR, organizations: [{ organizationId: scope.organization_id, roles: ['appraiser'] }] };
  const client = { async query(config) {
    const sql = config.text, params = config.values ?? []; state.calls.push(sql);
    if (sql.startsWith('BEGIN ') || sql.startsWith('SET LOCAL ') || sql === 'COMMIT') return row();
    if (sql === 'ROLLBACK') { state.rollbacks++; return row(); }
    const ownerTag = sql.match(/custom-cohort-capture:([a-z-]+)/)?.[1];
    if (ownerTag === 'assignment') {
      assert.deepEqual(params, [scope.assignment_file_id, scope.account_id]);
      return row(state.missingTarget ? null : { assignment_file_id: scope.assignment_file_id, account_id: scope.account_id,
        organization_id: scope.organization_id, assigned_appraiser_user_id: state.assigned, supervisory_appraiser_user_id: null });
    }
    if (ownerTag === 'report') return row({ report_file_id: scope.report_file_id,
      appraisal_case_id: target.appraisal_case_id, subject_snapshot_id: target.subject_snapshot_id });
    const tag = sql.match(/custom-cohort-context:([a-z-]+)/)?.[1];
    if (tag === 'transaction') return row({ transaction_id: '123456789' });
    if (tag === 'target') return row({ id: scope.report_file_id });
    if (tag === 'read') return row(params[4] === context.context_id ? context : null);
    if (sql.includes('custom-neighborhood-source-policy:organization') || sql.includes('custom-neighborhood-witness2-source-policy:organization')) {
      const key = sql.includes('custom-neighborhood-witness2-source-policy:organization') ? WITNESS2_KEY : LEGACY_KEY;
      state.policyChecks++; state.policyNamespaces.push(key); assert.deepEqual(params, [scope.organization_id, key, 16_384]);
      if (state.policyThrows) throw new Error('synthetic-private-source-rights-driver-secret');
      return row({ organization_id: scope.organization_id, active: true, source_rights: metadata[key] ?? null,
        checked_at: '2026-09-09T12:00:00.000000Z' });
    }
    if (sql.includes('neighborhood-cohort-blob:read')) {
      const requested = Array.isArray(params[1]) ? params[1] : [params[1]];
      state.blobReads.push(...requested.map(hash => ({ hash, index: state.calls.length - 1 })));
      const hashes = requested.filter(hash => payloads.has(hash));
      state.sourceReads += hashes.length;
      if (hashes.length) state.sourceReadCalls.push({ index: state.calls.length - 1, hashes, batch: Array.isArray(params[1]) });
    }
    return fixture.client.query(sql, params);
  }, release(error) { state.releases.push(error); } };
  return { state, principal, metadata, acquisitionPolicyCalls, input, fixture, pool: { async connect() { return client; } },
    path: `/api/accounts/${scope.account_id}/neighborhood-cohort/catalog`,
    body: { assignment_file_id: scope.assignment_file_id, context_ref: header.context_ref,
      selection: { revision: 1, pockets: [] }, include_recommendation: true } };
}

for (const mode of ['no_grant', 'policy_failure', 'assignment_denied', 'workflow_denied', 'target_missing']) {
  test(`actual enabled factory chain ${mode} is scoped, sanitized and never reads retained market records`, async t => {
    const fixture = await retainedPolicyFixture();
    fixture.state.policyThrows = mode === 'policy_failure';
    fixture.state.assigned = mode === 'assignment_denied' ? OTHER_ACTOR : ACTOR;
    fixture.state.missingTarget = mode === 'target_missing';
    if (mode === 'workflow_denied') fixture.principal.organizations = [];
    const server = await start(t, { enabled: true, principal: fixture.principal, cohortPool: fixture.pool });
    const status = mode === 'policy_failure' ? 500 : mode === 'target_missing' ? 404 : 403;
    const error = mode === 'policy_failure' ? 'neighborhood_request_failed'
      : mode === 'target_missing' ? 'neighborhood_context_unavailable' : 'neighborhood_access_denied';
    await responseIs(await server.request(`${fixture.path}?accountId=untrusted&assignmentFileId=999&userId=${OTHER_ACTOR}`,
      { body: fixture.body }), status, error);
    assert.equal(fixture.state.policyChecks, ['no_grant', 'policy_failure'].includes(mode) ? 1 : 0);
    assert.equal(fixture.state.sourceReads, 0);
    // Existing owner discards query-failed clients instead of attempting more
    // statements on an uncertain connection; ordinary access denial rolls back.
    assert.equal(fixture.state.rollbacks, mode === 'policy_failure' ? 0 : 1);
    assert.equal(fixture.state.releases.length, 1); assert.equal(server.state.cohortConnections, 1);
    assert.equal(fixture.state.releases[0] instanceof Error, mode === 'policy_failure');
    assert.ok(!fixture.state.calls.some(sql => /\b(?:INSERT\s+INTO|UPDATE\s+(?:app|core)\.|DELETE\s+FROM)/i.test(sql)));
    assert.ok(!fixture.state.calls.some(sql => /neighborhood-(cache|membership|closure):/.test(sql)));
  });
}

for (const sourceMode of ['cad4', 'combined-witness2-v1']) {
  for (const [mappingVersion, marked] of [[4, false], [5, false], [5, true]]) {
    test(`composed ${sourceMode} reopens original mapping${mappingVersion} marked=${marked} with its own real policy namespace`, async t => {
      const f = await retainedPolicyFixture({ mappingVersion, marked, installedRights: true });
      const key = mappingVersion === 5 ? WITNESS2_KEY : LEGACY_KEY;
      assert.equal(f.acquisitionPolicyCalls.length, 1);
      assert.deepEqual(f.acquisitionPolicyCalls[0].params, [f.input.expected.target.organization_id, key, 16_384]);
      const originalPurpose = f.acquisitionPolicyCalls[0].purpose;
      assert.deepEqual(Object.fromEntries(Object.keys(mappingVersion === 5 ? WITNESS2_PURPOSE : LEGACY_PURPOSE)
        .map(name => [name, originalPurpose[name]])), mappingVersion === 5 ? WITNESS2_PURPOSE : LEGACY_PURPOSE);
      // The unrelated subtree is deliberately absent. Current capture mode
      // cannot require a different source grant to reopen these originals.
      delete f.metadata[key === LEGACY_KEY ? WITNESS2_KEY : LEGACY_KEY];
      const server = await start(t, { enabled: true, sourceMode, principal: f.principal, cohortPool: f.pool });
      const response = await server.request(f.path, { body: { ...f.body, include_recommendation: false } });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify({ body, tail: f.state.calls.slice(-5) }));
      assert.equal(body.status, 'catalog'); assert.deepEqual(body.context_ref, f.body.context_ref);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(f.state.policyNamespaces, [key, key], 'fresh final check uses the identical original purpose');
      assert.ok(f.state.sourceReads > 0); assert.ok(f.state.sourceReadCalls.some(call => call.batch), 'batched source reads are counted');
      const sourceHashes = f.input.retained_inputs.acquisition.capture_result.source_capture.source_snapshots.map(source => source.content_sha256).sort();
      assert.deepEqual([...new Set(f.state.sourceReadCalls.flatMap(call => call.hashes))].sort(), sourceHashes);
      const firstPolicy = f.state.calls.findIndex(sql => sql.includes('source-policy:organization'));
      assert.ok(firstPolicy >= 0 && firstPolicy < f.state.sourceReadCalls[0].index);
      if (marked) {
        const original = f.state.blobReads.find(call => call.hash === getCustomCohortReportedSaleWitnessV2Profile().profile_ref.content_sha256);
        assert.ok(original && original.index < f.state.sourceReadCalls[0].index, 'the actual profile original gates full source reads');
      }
      assert.equal(f.state.rollbacks, 0); assert.ok(f.state.releases.every(error => error === undefined));
      assert.ok(!f.state.calls.some(sql => /neighborhood-(cache|membership|closure):/.test(sql)), 'reopen performs no replacement source acquisition');
      assert.ok(!f.state.calls.some(sql => /\b(?:INSERT\s+INTO|UPDATE\s+(?:app|core)\.|DELETE\s+FROM)/i.test(sql)));
    });
  }

  for (const mappingVersion of [4, 5]) test(`composed ${sourceMode} cannot substitute the other namespace for mapping${mappingVersion}`, async t => {
    const f = await retainedPolicyFixture({ mappingVersion, marked: mappingVersion === 5, installedRights: true });
    const key = mappingVersion === 5 ? WITNESS2_KEY : LEGACY_KEY;
    delete f.metadata[key];
    const server = await start(t, { enabled: true, sourceMode, principal: f.principal, cohortPool: f.pool });
    await responseIs(await server.request(f.path, { body: f.body }), 403, 'neighborhood_access_denied');
    assert.deepEqual(f.state.policyNamespaces, [key]); assert.equal(f.state.sourceReads, 0);
  });

  test(`composed ${sourceMode} routes old mapping3 projection only to witness2 denial without legacy fallback`, async t => {
    const f = await retainedPolicyFixture({ mappingVersion: 3 });
    f.metadata[LEGACY_KEY] = installedGrant(f.input.expected.target.organization_id, LEGACY_PURPOSE);
    f.metadata[WITNESS2_KEY] = installedGrant(f.input.expected.target.organization_id, WITNESS2_PURPOSE);
    const server = await start(t, { enabled: true, sourceMode, principal: f.principal, cohortPool: f.pool });
    await responseIs(await server.request(f.path, { body: f.body }), 403, 'neighborhood_access_denied');
    assert.equal(f.state.policyChecks, 0, 'fixed witness2 evaluator rejects wrong projection before SQL');
    assert.equal(f.state.sourceReads, 0);
  });
}

for (const failure of ['missing_profile', 'corrupt_profile', 'no_catalog_exposure', 'revoked', 'policy_failure']) {
  test(`composed witness2 ${failure} refuses before any full source page read`, async t => {
    const f = await retainedPolicyFixture({ mappingVersion: 5, marked: true, installedRights: true });
    const profile = getCustomCohortReportedSaleWitnessV2Profile();
    const key = `${f.input.expected.target.organization_id}:${profile.profile_ref.content_sha256}`;
    if (failure === 'missing_profile') f.fixture.f.state.db.delete(key);
    if (failure === 'corrupt_profile') f.fixture.f.state.db.set(key, { ...f.fixture.f.state.db.get(key), canonical_utf8: '{}' });
    if (failure === 'no_catalog_exposure') f.metadata[WITNESS2_KEY].exposures.report_observation_catalog = false;
    if (failure === 'revoked') f.metadata[WITNESS2_KEY].revoked_at = '2026-09-09T00:00:00.000000Z';
    f.state.policyThrows = failure === 'policy_failure';
    const server = await start(t, { enabled: true, sourceMode: 'combined-witness2-v1', principal: f.principal, cohortPool: f.pool });
    const [status, error] = failure === 'missing_profile' ? [409, 'neighborhood_operation_conflict']
      : ['corrupt_profile', 'policy_failure'].includes(failure) ? [500, 'neighborhood_request_failed']
      : [403, 'neighborhood_access_denied'];
    await responseIs(await server.request(f.path, { body: f.body }), status, error);
    assert.equal(f.state.sourceReads, 0);
    assert.equal(f.state.policyChecks, failure.endsWith('_profile') ? 0 : 1);
    assert.ok(!f.state.calls.some(sql => /\b(?:INSERT\s+INTO|UPDATE\s+(?:app|core)\.|DELETE\s+FROM)/i.test(sql)));
  });
}

test('body principal/profile/target fields cannot substitute for trusted middleware and path identity', async t => {
  const server = await start(t, { enabled: true });
  const body = { assignment_file_id: '10', operation_id: '60000000-0000-4000-8000-000000000001',
    observation_period: { start_date: '2024-01-01', end_date: '2024-12-31' } };
  for (const extra of [{ auth: identity }, { accountId: 'other' }, { sourceProfile: PROFILE }, { allowed: true },
    { sourceMode: 'combined-witness2-v1' }, { source_mode: 'combined-witness2-v1' }, { reported_sale_interpretation: getCustomCohortReportedSaleWitnessV2Profile().profile_ref }]) {
    await responseIs(await server.request(`${base}/capture`, { body: { ...body, ...extra } }), 400, 'invalid_neighborhood_request');
  }
  assert.equal(server.state.cohortConnections, 0);
});
