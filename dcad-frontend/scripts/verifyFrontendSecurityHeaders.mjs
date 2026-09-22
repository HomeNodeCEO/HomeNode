import https from 'node:https'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

export const DEFAULT_FRONTEND_URL = 'https://homenode-frontend.onrender.com/'
export const EXPECTED_R2_ORIGIN =
  'https://homenode-shared-production.407656745429dce8902facc0209852d0.r2.cloudflarestorage.com'
export const RETIRED_R2_ORIGIN =
  'https://e407656745429dce8902facc0209852d.r2.cloudflarestorage.com'
export const EXPECTED_STYLE_SOURCES = Object.freeze(["'self'", 'https://unpkg.com'])
export const EXPECTED_STYLE_ATTRIBUTE_SOURCES = Object.freeze(["'unsafe-inline'"])

/** Parse a Content-Security-Policy header into directive/source entries. */
export function parseContentSecurityPolicy(policy) {
  const directives = new Map()

  for (const rawDirective of String(policy || '').split(';')) {
    const tokens = rawDirective.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    const name = tokens[0].toLowerCase()
    if (!directives.has(name)) directives.set(name, tokens.slice(1))
  }

  return directives
}

/** Return all security-header policy violations without mutating the input. */
export function validateFrontendSecurityHeaders(headers) {
  const normalized = Object.fromEntries(
    Object.entries(headers || {}).map(([name, value]) => [
      name.toLowerCase(),
      Array.isArray(value) ? value.join(', ') : String(value || ''),
    ]),
  )
  const policy = normalized['content-security-policy'] || ''
  const directives = parseContentSecurityPolicy(policy)
  const allSources = new Set([...directives.values()].flat())
  const errors = []

  if (!policy) errors.push('Content-Security-Policy is missing')

  for (const directive of ['img-src', 'connect-src']) {
    const sources = directives.get(directive) || []
    const sourceSet = new Set(sources)
    if (!sourceSet.has(EXPECTED_R2_ORIGIN)) {
      errors.push(`${directive} does not allow the exact production R2 origin`)
    }
    if (sourceSet.has('*') || sources.some((source) => /^https:\/\/\*\.r2\.cloudflarestorage\.com\/?$/i.test(source))) {
      errors.push(`${directive} contains a wildcard source`)
    }
  }

  if (allSources.has(RETIRED_R2_ORIGIN)) {
    errors.push('CSP still contains the retired R2 origin')
  }

  const exactDirectives = new Map([
    ['default-src', ["'self'"]],
    ['style-src', EXPECTED_STYLE_SOURCES],
    ['style-src-elem', EXPECTED_STYLE_SOURCES],
    ['style-src-attr', EXPECTED_STYLE_ATTRIBUTE_SOURCES],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
    ['form-action', ["'self'"]],
  ])
  for (const [directive, expected] of exactDirectives) {
    const actual = directives.get(directive) || []
    if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
      errors.push(`${directive} must remain exactly ${expected.join(' ')}`)
    }
  }

  for (const directive of ['script-src', 'style-src', 'style-src-elem']) {
    if ((directives.get(directive) || []).includes("'unsafe-inline'")) {
      errors.push(`${directive} must not allow 'unsafe-inline'`)
    }
  }

  if ((normalized['x-frame-options'] || '').toUpperCase() !== 'DENY') {
    errors.push('X-Frame-Options must remain DENY')
  }
  if ((normalized['x-content-type-options'] || '').toLowerCase() !== 'nosniff') {
    errors.push('X-Content-Type-Options must remain nosniff')
  }
  if (!normalized['strict-transport-security']) {
    errors.push('Strict-Transport-Security is missing')
  }

  return { errors, policy }
}

/** Read headers only from the immutable production frontend target. */
export function fetchFrontendHeaders(timeoutMs = 15_000) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = https.get(
      DEFAULT_FRONTEND_URL,
      {
        headers: {
          'Cache-Control': 'no-cache',
          'User-Agent': 'HomeNode-deployed-security-header-verifier/1.0',
        },
      },
      (response) => {
        response.resume()
        if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
          rejectRequest(new Error(`Frontend returned HTTP ${response.statusCode || 'unknown'}`))
          return
        }
        resolveRequest(response.headers)
      },
    )
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Frontend header request timed out')))
    request.on('error', rejectRequest)
  })
}

/** Verify the security headers served by the production frontend. */
export async function verifyDeployedFrontend() {
  const headers = await fetchFrontendHeaders()
  const result = validateFrontendSecurityHeaders(headers)
  if (result.errors.length > 0) {
    throw new Error(`Deployed frontend security-header verification failed:\n- ${result.errors.join('\n- ')}`)
  }
  return {
    url: DEFAULT_FRONTEND_URL,
    contentSecurityPolicy: result.policy,
    verified: true,
  }
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isCli) {
  verifyDeployedFrontend()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
