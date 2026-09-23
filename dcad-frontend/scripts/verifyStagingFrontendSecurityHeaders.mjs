import https from 'node:https'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

export const STAGING_FRONTEND_URL = 'https://homenode-uad-staging.onrender.com/'
export const STAGING_R2_ORIGIN =
  'https://homenode-uad-staging.407656745429dce8902facc0209852d0.r2.cloudflarestorage.com'
export const STAGING_API_ORIGIN = 'https://homenode-api-staging.onrender.com'
export const EXPECTED_STAGING_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; " +
  `img-src 'self' data: blob: https://images.unsplash.com https://tiles.openfreemap.org ${STAGING_R2_ORIGIN}; ` +
  "font-src 'self' data: https://tiles.openfreemap.org; " +
  `connect-src 'self' ${STAGING_API_ORIGIN} https://dcad-scraper-with-api.onrender.com https://tiles.openfreemap.org ${STAGING_R2_ORIGIN}; ` +
  "frame-src 'self' blob:; worker-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"

export function validateStagingFrontendSecurityHeaders(headers) {
  const normalized = Object.fromEntries(
    Object.entries(headers || {}).map(([name, value]) => [
      name.toLowerCase(),
      Array.isArray(value) ? value.join(', ') : String(value || ''),
    ]),
  )
  const errors = []
  if (normalized['content-security-policy'] !== EXPECTED_STAGING_CSP) {
    errors.push('staging_csp_mismatch')
  }
  if ((normalized['x-frame-options'] || '').toUpperCase() !== 'DENY') {
    errors.push('staging_frame_options_mismatch')
  }
  if ((normalized['x-content-type-options'] || '').toLowerCase() !== 'nosniff') {
    errors.push('staging_content_type_options_mismatch')
  }
  const hsts = normalized['strict-transport-security'] || ''
  if (!hsts) {
    errors.push('staging_hsts_missing')
  } else {
    const directives = new Map()
    let malformed = false
    for (const part of hsts.split(';')) {
      const match = part.trim().match(/^([a-z][a-z0-9-]*)(?:\s*=\s*(.*))?$/i)
      const name = match?.[1].toLowerCase()
      if (!name || directives.has(name)) {
        malformed = true
        break
      }
      directives.set(name, match[2])
    }
    const maxAge = directives.get('max-age')
    if (malformed || !/^\d+$/.test(maxAge || '') || Number(maxAge) < 31_536_000 ||
        !directives.has('includesubdomains') || directives.get('includesubdomains') !== undefined) {
      errors.push('staging_hsts_weak')
    }
  }
  return errors
}

export function fetchStagingFrontendHeaders(timeoutMs = 15_000, requestFactory = https.get) {
  return new Promise((resolveRequest, rejectRequest) => {
    let settled = false
    let deadline
    const finish = (error, headers) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (error) rejectRequest(error)
      else resolveRequest(headers)
    }
    const request = requestFactory(
      STAGING_FRONTEND_URL,
      {
        headers: {
          'Cache-Control': 'no-cache',
          'User-Agent': 'HomeNode-staging-security-header-verifier/1.0',
        },
      },
      (response) => {
        response.resume()
        if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
          finish(new Error('staging_frontend_http_error'))
          return
        }
        finish(null, response.headers)
      },
    )
    request.once('error', (error) => finish(error))
    // A wall-clock deadline also covers DNS and connection setup, unlike socket inactivity.
    deadline = setTimeout(() => request.destroy(new Error('staging_frontend_timeout')), timeoutMs)
  })
}

export async function verifyDeployedStagingFrontend() {
  const errors = validateStagingFrontendSecurityHeaders(await fetchStagingFrontendHeaders())
  if (errors.length > 0) throw new Error(errors.join(', '))
  return { url: STAGING_FRONTEND_URL, verified: true }
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isCli) {
  verifyDeployedStagingFrontend()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'staging_frontend_verification_failed')
      process.exitCode = 1
    })
}
