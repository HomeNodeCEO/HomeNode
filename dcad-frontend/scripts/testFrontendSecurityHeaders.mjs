import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXPECTED_R2_ORIGIN,
  RETIRED_R2_ORIGIN,
  validateFrontendSecurityHeaders,
} from './verifyFrontendSecurityHeaders.mjs'

const secureHeaders = {
  'content-security-policy': `default-src 'self'; img-src 'self' data: ${EXPECTED_R2_ORIGIN}; connect-src 'self' ${EXPECTED_R2_ORIGIN}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`,
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
}

test('accepts the exact production R2 origin in both required directives', () => {
  assert.deepEqual(validateFrontendSecurityHeaders(secureHeaders).errors, [])
})

test('rejects the retired R2 origin and a missing exact origin', () => {
  const headers = {
    ...secureHeaders,
    'content-security-policy': secureHeaders['content-security-policy'].replaceAll(
      EXPECTED_R2_ORIGIN,
      RETIRED_R2_ORIGIN,
    ),
  }
  const errors = validateFrontendSecurityHeaders(headers).errors.join('\n')
  assert.match(errors, /img-src does not allow the exact production R2 origin/)
  assert.match(errors, /connect-src does not allow the exact production R2 origin/)
  assert.match(errors, /retired R2 origin/)
})

test('rejects attacker origins that merely contain the trusted hostname text', () => {
  for (const attackerOrigin of [
    `${EXPECTED_R2_ORIGIN}.attacker.example`,
    `https://attacker.example/${EXPECTED_R2_ORIGIN}`,
  ]) {
    const headers = {
      ...secureHeaders,
      'content-security-policy': secureHeaders['content-security-policy'].replaceAll(
        EXPECTED_R2_ORIGIN,
        attackerOrigin,
      ),
    }
    const errors = validateFrontendSecurityHeaders(headers).errors.join('\n')
    assert.match(errors, /img-src does not allow the exact production R2 origin/)
    assert.match(errors, /connect-src does not allow the exact production R2 origin/)
  }
})

test('rejects wildcard storage access and weakened framing directives', () => {
  const headers = {
    ...secureHeaders,
    'content-security-policy': secureHeaders['content-security-policy']
      .replace(`img-src 'self' data:`, "img-src 'self' data: *")
      .replace("frame-ancestors 'none'", "frame-ancestors 'self'"),
  }
  const errors = validateFrontendSecurityHeaders(headers).errors.join('\n')
  assert.match(errors, /img-src contains a wildcard source/)
  assert.match(errors, /frame-ancestors must remain exactly 'none'/)
})

test('rejects missing platform security headers', () => {
  const errors = validateFrontendSecurityHeaders({
    'content-security-policy': secureHeaders['content-security-policy'],
  }).errors.join('\n')
  assert.match(errors, /X-Frame-Options must remain DENY/)
  assert.match(errors, /X-Content-Type-Options must remain nosniff/)
  assert.match(errors, /Strict-Transport-Security is missing/)
})
