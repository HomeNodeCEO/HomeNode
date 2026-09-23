import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  EXPECTED_STAGING_CSP,
  STAGING_API_ORIGIN,
  STAGING_FRONTEND_URL,
  STAGING_R2_ORIGIN,
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
  assert.match(EXPECTED_STAGING_CSP, new RegExp(STAGING_API_ORIGIN.replaceAll('.', '\\.')))
  assert.match(EXPECTED_STAGING_CSP, new RegExp(STAGING_R2_ORIGIN.replaceAll('.', '\\.')))
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
  for (const hsts of ['max-age=0; includeSubDomains', 'max-age=31536000']) {
    assert.deepEqual(
      validateStagingFrontendSecurityHeaders({
        ...secureHeaders,
        'strict-transport-security': hsts,
      }),
      ['staging_hsts_weak'],
    )
  }
});

test('staging verifier has a fixed HTTPS request target', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./verifyStagingFrontendSecurityHeaders.mjs', import.meta.url)),
    'utf8',
  )
  assert.equal(STAGING_FRONTEND_URL, 'https://homenode-uad-staging.onrender.com/')
  assert.doesNotMatch(source, /process\.env\.\w*URL/)
  assert.match(source, /https\.get\(\s*STAGING_FRONTEND_URL,/)
});
