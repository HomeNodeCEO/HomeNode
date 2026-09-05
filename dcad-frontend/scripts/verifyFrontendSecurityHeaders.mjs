import https from 'node:https'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

export const DEFAULT_FRONTEND_URL = 'https://homenode-frontend.onrender.com/'
export const EXPECTED_R2_ORIGIN =
  'https://homenode-shared-production.407656745429dce8902facc0209852d0.r2.cloudflarestorage.com'
export const RETIRED_R2_ORIGIN =
  'https://e407656745429dce8902facc0209852d.r2.cloudflarestorage.com'

export function parseContentSecurityPolicy(policy) {
  const directives = new Map()

  for (const rawDirective of String(policy || '').split(';')) {
    const tokens = rawDirective.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    directives.set(tokens[0], tokens.slice(1))
  }

  return directives
}

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

export function fetchFrontendHeaders(rawUrl, timeoutMs = 15_000) {
  const target = new URL(rawUrl)
  if (target.protocol !== 'https:' || target.username || target.password) {
    throw new Error('Frontend verification URL must be credential-free HTTPS')
  }

  return new Promise((resolveRequest, rejectRequest) => {
    const request = https.get(
      target,
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

export async function verifyDeployedFrontend(rawUrl = DEFAULT_FRONTEND_URL) {
  const headers = await fetchFrontendHeaders(rawUrl)
  const result = validateFrontendSecurityHeaders(headers)
  if (result.errors.length > 0) {
    throw new Error(`Deployed frontend security-header verification failed:\n- ${result.errors.join('\n- ')}`)
  }
  return {
    url: rawUrl,
    contentSecurityPolicy: result.policy,
    verified: true,
  }
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isCli) {
  verifyDeployedFrontend(process.env.FRONTEND_URL || DEFAULT_FRONTEND_URL)
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
