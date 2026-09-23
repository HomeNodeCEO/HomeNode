import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  EXPECTED_STAGING_CSP,
  STAGING_API_ORIGIN,
  STAGING_FRONTEND_URL,
  STAGING_R2_ORIGIN,
  fetchStagingFrontendHeaders,
  validateStagingFrontendSecurityHeaders,
} from './verifyStagingFrontendSecurityHeaders.mjs'

const secureHeaders = {
  'content-security-policy': EXPECTED_STAGING_CSP,
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=315360000; includeSubdomains; preload',
}

test('accepts exact staging CSP and platform security headers', () => {
  assert.deepEqual(validateStagingFrontendSecurityHeaders(secureHeaders), [])
  assert.ok(EXPECTED_STAGING_CSP.includes(STAGING_API_ORIGIN))
  assert.ok(EXPECTED_STAGING_CSP.includes(STAGING_R2_ORIGIN))
});

test('rejects omitted, weakened, or production-origin CSP', () => {
  for (const policy of [
    '',
    EXPECTED_STAGING_CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
    EXPECTED_STAGING_CSP.replace(STAGING_API_ORIGIN, 'https://homenode.onrender.com'),
    EXPECTED_STAGING_CSP.replace(STAGING_R2_ORIGIN, 'https://other-bucket.example.com'),
  ]) {
    assert.deepEqual(
      validateStagingFrontendSecurityHeaders({ ...secureHeaders, 'content-security-policy': policy }),
      ['staging_csp_mismatch'],
    )
  }
});

test('rejects missing framing, MIME, or transport safeguards', () => {
  assert.deepEqual(
    validateStagingFrontendSecurityHeaders({ 'content-security-policy': EXPECTED_STAGING_CSP }),
    ['staging_frame_options_mismatch', 'staging_content_type_options_mismatch', 'staging_hsts_missing'],
  )
  for (const hsts of [
    'max-age=0; includeSubDomains',
    'max-age=31536000',
    'max-age=31536000; includeSubDomains; max-age=0',
    'max-age=31536000; includeSubDomains; includeSubDomains',
  ]) {
    assert.deepEqual(
      validateStagingFrontendSecurityHeaders({
        ...secureHeaders,
        'strict-transport-security': hsts,
      }),
      ['staging_hsts_weak'],
    )
  }
});

test('total request deadline also fires before a socket connects', async () => {
  const request = new EventEmitter()
  request.destroy = (error) => request.emit('error', error)
  const requestFactory = (url, options, onResponse) => {
    assert.equal(url, STAGING_FRONTEND_URL)
    assert.ok(options.headers['User-Agent'])
    assert.equal(typeof onResponse, 'function')
    return request
  }
  await assert.rejects(
    fetchStagingFrontendHeaders(10, requestFactory),
    { message: 'staging_frontend_timeout' },
  )
});

test('closes the response after headers even if the body never ends', async () => {
  for (const statusCode of [200, 503]) {
    const request = new EventEmitter()
    let destroyed = false
    const response = {
      statusCode,
      headers: secureHeaders,
      destroy() { destroyed = true },
    }
    const requestFactory = (_url, _options, onResponse) => {
      queueMicrotask(() => onResponse(response))
      return request
    }
    if (statusCode === 200) {
      assert.deepEqual(await fetchStagingFrontendHeaders(100, requestFactory), secureHeaders)
    } else {
      await assert.rejects(fetchStagingFrontendHeaders(100, requestFactory), {
        message: 'staging_frontend_http_error',
      })
    }
    assert.equal(destroyed, true)
  }
});

test('staging verifier has a fixed HTTPS request target', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./verifyStagingFrontendSecurityHeaders.mjs', import.meta.url)),
    'utf8',
  )
  assert.equal(STAGING_FRONTEND_URL, 'https://homenode-uad-staging.onrender.com/')
  assert.doesNotMatch(source, /process\.env\.\w*URL/)
  assert.match(source, /requestFactory\(\s*STAGING_FRONTEND_URL,/)
  assert.doesNotMatch(source, /request\.setTimeout\(/)
});
