# Aikido security triage — 2026-09-04

This record maps the first Aikido review to executable controls and follow-up work. Findings remain visible in Aikido until a rescan confirms the deployed state; this document is not a substitute for scanner evidence.

## Remediated in the security-hardening change

- `43973292`: Vite now loads only `VITE_`-prefixed configuration instead of importing every environment variable into its configuration map.
- `43973269` and `43973272`: `pg` is updated to `8.23.0`, bringing `pg-connection-string` to `2.14.0`. The regenerated lockfile and npm audit are clean.
- `43973399`: R2 file streaming accepts only canonical files beneath the process temporary directory. Upload symlinks are resolved and revalidated; downloads use exclusive file creation.
- `43973406`: the browser red-team verifier accepts only credential-free HTTPS URLs on Cloudflare R2 hosts, rejects redirects, and uses a bounded request timeout.
- `43973397`: `pnpm/action-setup` is pinned to the immutable commit for v6. Every checkout disables persisted Git credentials.
- `43973270`: all three scraper container definitions drop root before running application code. The active API container retains a narrowly writable storage directory.
- `43973295`: the synthetic Basic-auth fuzz input is generated at runtime instead of retaining a credential-shaped Base64 literal. The historical value represented only `synthetic:redteam`, not a live credential.
- `43973407`: the unused 2025 CommonJS server entry point is removed. The active server continues to use the tested `securityHeaders` middleware.

## Production configuration remediated

The `HomeNode-frontend` Render static site now emits these rules for `/*`:

- `Content-Security-Policy: frame-ancestors 'none'; base-uri 'self'; object-src 'none'`
- `X-Frame-Options: DENY`

The live response also emits HSTS and `X-Content-Type-Options: nosniff`. This addresses the CSP and clickjacking DAST findings without restricting the application's existing scripts, styles, API requests, images, or embedded document previews.

## Confirmed controls requiring scanner review

- `43973402`: every dynamic worker schema originates in `WorkerConfig.from_env()` and passes `_identifier`, which permits only unquoted PostgreSQL identifiers matching `[A-Za-z_][A-Za-z0-9_]*`. Request and record values remain bound parameters. A regression test rejects separators, quotes, comments, traversal strings, and qualified names.
- `43973408`: sales-list request values use PostgreSQL bind parameters. Dynamic SQL fragments are selected only from fixed server-owned enums and column expressions; the integration suite verifies the complete parameter list.
- The active Express entry point mounts `securityHeaders` before CORS and routes. Its tests assert CSP, HSTS, `X-Frame-Options`, `X-Content-Type-Options`, referrer policy, permissions policy, and cross-origin resource policy.
- `43973401`: the legacy PDF account identifier is Pydantic-constrained to `[A-Za-z0-9_-]{1,64}`, writes beneath a configured storage root, and is disabled by default. The batch CSV path is a local operator CLI argument rather than an HTTP input.

These findings should be marked false positive or accepted only after the corresponding scanner trace is compared with the cited executable controls.

## Tracked upstream or organizational items

- Mobile Zod and Yargs findings are transitive Expo/Metro build-tool dependencies. The installed application does not import them, and the current Expo CLI line still depends on Zod 3.x. Do not force incompatible major overrides; update through Expo when upstream adopts the patched major.
- `raw-body` is transitive through Express/body-parser. HomeNode supplies fixed, parseable request limits; the published body-parser line still uses raw-body 3.x. Continue tracking the upstream upgrade.
- A GitHub organization IP allowlist is an administrative policy decision, not a repository code fix. It must account for GitHub-hosted runners, Render, mobile release infrastructure, and emergency administrator access before activation.

## Verification completed

- Server: 1,307 passed, 9 skipped.
- Frontend: 126 passed; typecheck, lint/source/bundle budgets, and production build passed.
- Scraper: 44 passed; both Python requirement sets returned no known vulnerabilities.
- Mobile: 48 passed; typecheck and all 21 Expo Doctor checks passed.
- Server and frontend npm audits returned zero vulnerabilities. Mobile audit retained only the two documented, repository-patched advisories.

After merge and deployment, rerun Aikido SAST, dependency, container, secret, and DAST scans. Keep unresolved or upstream-blocked items visible with owner and review dates.
