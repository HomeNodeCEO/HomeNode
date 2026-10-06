import test from 'node:test';
import assert from 'node:assert/strict';
import { customCohortCaptureJobPoolOptions }
  from '../src/services/neighborhoodAssessment/customCohortCaptureJobPool.js';

test('remote capture workers verify TLS and strip URL overrides before pg parses them', () => {
  for (const host of ['db.render.com', 'database.internal', 'example.test']) {
    for (const query of ['', '?sslmode=require', '?sslmode=verify-full', '?ssl=true', '?ssl=1']) {
      const options = customCohortCaptureJobPoolOptions(`postgresql://synthetic:password@${host}:5432/test${query}`);
      assert.deepEqual(options.ssl, { rejectUnauthorized: true });
      assert.equal(new URL(options.connectionString).search, '');
      assert.equal(new URL(options.connectionString).hostname, host);
      assert.equal(options.max, 3);
      assert.equal(options.connectionTimeoutMillis, 5000);
      assert.equal(options.application_name, 'homenode-custom-cohort-capture-jobs');
    }
  }
});

test('only literal loopback development hosts may be plaintext, with explicit TLS honored', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    for (const query of ['', '?sslmode=disable', '?ssl=false', '?ssl=0']) {
      assert.equal(customCohortCaptureJobPoolOptions(`postgres://test@${host}/test${query}`).ssl, false);
    }
    for (const query of ['?sslmode=require', '?ssl=true', '?sslmode=verify-full&ssl=1']) {
      assert.deepEqual(customCohortCaptureJobPoolOptions(`postgres://test@${host}/test${query}`).ssl,
        { rejectUnauthorized: true });
    }
  }
});

test('insecure, conflicting, duplicated and driver override options fail with no secret echo', () => {
  for (const input of [undefined, null, 1, '', 'x'.repeat(16_385), 'not a database URL',
    'https://test@example.test/db', 'postgres:///db', 'postgres://example.test/db#fragment',
    ...['sslmode=disable', 'ssl=false', 'ssl=0', 'sslmode=prefer', 'sslmode=no-verify',
      'sslmode=verify-ca', 'sslmode=require&ssl=false', 'sslmode=require&sslmode=require',
      'ssl=true&ssl=true', 'ssl=', 'sslmode=', 'sslmode=require&host=localhost',
      'sslrootcert=anything', 'connect_timeout=0', 'application_name=other',
      'options=-c%20statement_timeout%3D0', 'sslmode=require&%73slmode=disable']
      .map(query => `postgres://synthetic:PRIVATE-PASSWORD@example.test/db?${query}`),
    'postgres://localhost/db?sslmode=disable&ssl=true']) {
    assert.throws(() => customCohortCaptureJobPoolOptions(input), error =>
      error instanceof TypeError && error.message === 'custom_cohort_job_database_configuration_invalid');
  }
  assert.deepEqual(customCohortCaptureJobPoolOptions('postgres://localhost.example.test/db').ssl,
    { rejectUnauthorized: true });
});
