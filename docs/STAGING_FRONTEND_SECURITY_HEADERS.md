# UAD staging frontend security headers

The Render static site `homenode-uad-staging` has `/*` response-header rules
for `Content-Security-Policy` and `X-Frame-Options: DENY`. Render also serves
`Strict-Transport-Security` and `X-Content-Type-Options: nosniff` on this site.

The exact approved CSP is maintained in
`dcad-frontend/scripts/verifyStagingFrontendSecurityHeaders.mjs`. It permits
the staging API and the staging R2 bucket, not the production API or production
R2 bucket. Same-origin scripts and stylesheet elements are required. The
`style-src-attr 'unsafe-inline'` exception matches the current production
frontend compatibility boundary; it does not allow inline scripts or style
elements.

The `Deployed frontend security headers` GitHub workflow checks the live
staging site on pushes to `main`, daily, and on manual dispatch. A local
read-only check is:

```sh
cd dcad-frontend
node scripts/verifyStagingFrontendSecurityHeaders.mjs
```

When either the staging API URL or R2 bucket changes, update the Render rule
and the immutable verifier together. Verify the served root and deep-route
headers, then open the seeded signed-in UAD workfile before treating the
change as complete. Do not substitute production origins or use an R2
wildcard to make a broken policy pass.
