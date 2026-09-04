import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applicationErrorType,
  applicationRouteCode,
  reportApplicationRenderFailure,
} from '../src/lib/applicationErrorTelemetry.ts';

test('application crash routes are reduced to stable codes without identifiers', () => {
  assert.equal(applicationRouteCode('/'), 'property_search');
  assert.equal(applicationRouteCode('/property/1/26272500060150000'), 'property_details');
  assert.equal(applicationRouteCode('/report/26272500060150000'), 'property_report');
  assert.equal(applicationRouteCode('/uad-3.6/UAD-SECRET-FILE'), 'uad_workspace');
  assert.equal(applicationRouteCode('/unexpected/secret-value'), 'unknown');
});

test('application errors are reduced to a bounded category', () => {
  assert.equal(applicationErrorType(new TypeError('private form value')), 'type_error');
  assert.equal(
    applicationErrorType(new Error('Failed to fetch dynamically imported module: private-url')),
    'chunk_load_error',
  );
  assert.equal(applicationErrorType({ message: 'database password' }), 'generic_error');
});

test('render failure reports contain no raw diagnostics or route identifiers', async () => {
  const requests = [];
  const error = new TypeError('borrower name and database password');
  error.stack = 'token=secret at /report/26272500060150000';
  const reported = await reportApplicationRenderFailure(error, {
    pathname: '/report/26272500060150000?token=secret',
    async fetchImpl(url, init) {
      requests.push({ url, init });
      return { ok: true };
    },
  });

  assert.equal(reported, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/system/client-errors');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.credentials, 'include');
  assert.equal(requests[0].init.keepalive, true);
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    source: 'root_error_boundary',
    route_code: 'property_report',
    error_type: 'type_error',
  });
  assert.doesNotMatch(JSON.stringify(requests), /borrower|password|token|secret|26272500060150000/i);
});

test('render failure reporting never replaces the recovery screen with another failure', async () => {
  const reported = await reportApplicationRenderFailure(new Error('private'), {
    pathname: '/',
    async fetchImpl() { throw new Error('network unavailable'); },
  });
  assert.equal(reported, false);
});
