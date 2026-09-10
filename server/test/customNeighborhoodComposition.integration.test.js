import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCustomNeighborhoodConfiguration, createCustomNeighborhoodApplicationRouter } from '../src/application/customNeighborhoodComposition.js';
import { mountApplicationRouteBoundary } from '../src/security/applicationRouteBoundary.js';
import { createWebSessionAuthenticator, WEB_SESSION_COOKIE } from '../src/security/webAuth.js';
import { jsonErrorHandler } from '../src/security/httpSecurity.js';
import { prepareCustomCohortContextHeader } from '../src/services/neighborhoodAssessment/customCohortContextContract.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';

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
async function start(t, { enabled = false, authenticationRequired = true, principal = identity, cohortPool } = {}) {
  const app = express(), state = { sessionQueries: 0, ratePaths: [], cohortConnections: 0 };
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
    assert.equal(server.state.ratePaths.length, 8, 'each request traverses the original global limiter exactly once');
  });
}

for (const enabled of [false, true]) {
  test(`actual session CSRF denial runs before parser/cohort dependencies when enabled=${enabled}`, async t => {
    const server = await start(t, { enabled });
    await responseIs(await server.request(`${base}/catalog`, {
      headers: { ...cookieHeaders, origin: 'https://hostile.example.test' }, body: '{',
    }), 403, 'csrf_origin_denied');
    assert.equal(server.state.sessionQueries, 0); assert.equal(server.state.cohortConnections, 0);
    assert.deepEqual(server.state.ratePaths, []);
  });

  test(`upstream JSON statuses and 1 MiB limit remain unchanged when enabled=${enabled}`, async t => {
    const server = await start(t, { enabled });
    await responseIs(await server.request(`${base}/catalog`, { body: '{' }), 400, 'invalid_json_body');
    await responseIs(await server.request(`${base}/catalog`, { body: { payload: 'x'.repeat(1_048_576) } }), 413, 'request_body_too_large');
    await responseIs(await server.request(`${base}/catalog`, {
      body: '{}', headers: { ...BEARER, 'content-type': 'application/json; charset=unsupported-charset' },
    }), 415, 'unsupported_request_encoding');
    assert.equal(server.state.cohortConnections, 0); assert.equal(server.state.sessionQueries, 0);
    assert.deepEqual(server.state.ratePaths, [], 'existing global parser still precedes bearer hydration/limiter');
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

async function retainedPolicyFixture() {
  const fixture = await decisionEvidenceFixture();
  const header = prepareCustomCohortContextHeader(fixture.input.context_header_json);
  await fixture.store.put(fixture.input.context_header_json);
  const scope = fixture.input.expected.target, target = fixture.f.state.input.target;
  const context = { ...header.context_ref, header_content_sha256: header.header_blob.ref.content_sha256,
    header_canonical_utf8_bytes: header.header_blob.ref.canonical_utf8_bytes };
  const payloads = new Set(fixture.input.retained_inputs.acquisition.capture_result.source_capture.source_snapshots.map(source => source.content_sha256));
  const state = { calls: [], policyChecks: 0, sourceReads: 0, releases: [], rollbacks: 0, assigned: ACTOR,
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
    if (sql.includes('custom-neighborhood-source-policy:organization')) {
      state.policyChecks++; assert.deepEqual(params, [scope.organization_id, 'custom_neighborhood_source_rights', 16_384]);
      if (state.policyThrows) throw new Error('synthetic-private-source-rights-driver-secret');
      return row({ organization_id: scope.organization_id, active: true, source_rights: null,
        checked_at: '2026-09-09T12:00:00.000000Z' });
    }
    if (sql.includes('neighborhood-cohort-blob:read') && payloads.has(params[1])) state.sourceReads++;
    return fixture.client.query(sql, params);
  }, release(error) { state.releases.push(error); } };
  return { state, principal, pool: { async connect() { return client; } },
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

test('body principal/profile/target fields cannot substitute for trusted middleware and path identity', async t => {
  const server = await start(t, { enabled: true });
  const body = { assignment_file_id: '10', operation_id: '60000000-0000-4000-8000-000000000001',
    observation_period: { start_date: '2024-01-01', end_date: '2024-12-31' } };
  for (const extra of [{ auth: identity }, { accountId: 'other' }, { sourceProfile: PROFILE }, { allowed: true }]) {
    await responseIs(await server.request(`${base}/capture`, { body: { ...body, ...extra } }), 400, 'invalid_neighborhood_request');
  }
  assert.equal(server.state.cohortConnections, 0);
});
