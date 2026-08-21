# UAD 3.6 Compliance API readiness

HomeNode's internal use of its own appraisal application does not require the
software to be sold or endorsed. Production access to a GSE UAD Compliance API
does, however, require the applicable GSE onboarding and verification process.
Credentials are an integration dependency, not a prerequisite for building the
editor, local rules, MISMO XML, subschema validation, or native URAR rendering.

## Delivery sequence

1. Keep Appendix A field mappings and Appendix H rules versioned by UAD release.
2. Require a persisted, passing whole-workfile local validation run for the
   current locked revision (see `UAD_LOCAL_VALIDATION.md`).
3. Generate deterministic MISMO 3.6 XML from that revision.
4. Validate well-formed XML and the current GSE UAD subschema locally.
5. Complete GSE technology-provider onboarding and obtain nonproduction
   application credentials for the assigned ACPT/CLVE test environment.
6. Submit the official scenarios, reconcile Compliance API findings with local
   results, and retain request/response correlation metadata without logging
   access tokens or sensitive report contents.
7. Complete verification before production credentials are enabled.
8. Store production credentials only in the deployment secret manager, rotate
   them independently for each GSE/environment, and keep the integration behind
   a disabled-by-default feature flag.

The Compliance API is a delivery gate. It does not replace HomeNode's local
validation engine, because the editor must give appraisers actionable feedback
before an appraisal is submitted.

## Section 29 signing boundary

`GET /api/uad/workfiles/:workfileId/certification-readiness` and
`POST /api/uad/workfiles/:workfileId/signatures` require the same bearer-token
OIDC verifier and explicit identity mapping used by the HomeNode mobile app.
The signing service also verifies that the authenticated user is the assigned
appraiser or supervisory appraiser, the current revision has a non-stale passing
local validation digest, and the signature date is not before the appraisal
effective date. Company, appraiser, license, execution-date, workfile-digest,
and credential-digest data is then stored as an immutable revision snapshot.

The rest of the UAD editor remains behind its existing feature flag while the
desktop session is being integrated. This narrower authenticated boundary
prevents a feature-flag-only request from creating a legal signature.

## Implemented integration boundary

HomeNode now includes a disabled-by-default provider registry, bounded OAuth 2.0
client-credentials client, authenticated service routes, and durable exchange
history. The Compliance API receives the current schema-valid MISMO XML, not
the UCDP delivery ZIP. HomeNode stores request and response digests,
environment, HTTP status, provider correlation ID, normalized findings, and a
bounded raw response for audit. It never stores an access token, client secret,
or private endpoint in a validation result or audit event.

Provider submission is not enabled merely because credentials are present.
The global flag and the provider-specific flag must both be true, every URL
must be HTTPS, and the onboarding documentation must explicitly identify the
token authentication style (`basic` or `body`). Requiring that explicit value
avoids guessing a provider contract that is available only through the assigned
API Developer Portal.

Authenticated assigned appraisers, supervisory appraisers, organization
administrators, and HomeNode administrators can inspect or start a provider
run through:

- `GET /api/uad/workfiles/:workfileId/compliance`
- `POST /api/uad/workfiles/:workfileId/compliance/fannie`
- `POST /api/uad/workfiles/:workfileId/compliance/freddie`

A run requires the current signed or exported revision and its ready,
schema-valid XML artifact. It does not mark a report as submitted to UCDP.

## Configuration contract

The adapter supports separate Fannie Mae and Freddie Mac credentials.
No endpoint or credential is committed to the repository. The official values
provided during onboarding will populate these deployment secrets:

- `UAD_COMPLIANCE_API_ENABLED`
- `FANNIE_UAD_COMPLIANCE_ENABLED`
- `FANNIE_UAD_COMPLIANCE_ENVIRONMENT`
- `FANNIE_UAD_COMPLIANCE_BASE_URL`
- `FANNIE_UAD_COMPLIANCE_TOKEN_URL`
- `FANNIE_UAD_COMPLIANCE_CLIENT_ID`
- `FANNIE_UAD_COMPLIANCE_CLIENT_SECRET`
- `FANNIE_UAD_COMPLIANCE_SCOPE`
- `FANNIE_UAD_COMPLIANCE_TOKEN_AUTH_STYLE`
- `FREDDIE_UAD_COMPLIANCE_ENABLED`
- `FREDDIE_UAD_COMPLIANCE_ENVIRONMENT`
- `FREDDIE_UAD_COMPLIANCE_BASE_URL`
- `FREDDIE_UAD_COMPLIANCE_TOKEN_URL`
- `FREDDIE_UAD_COMPLIANCE_CLIENT_ID`
- `FREDDIE_UAD_COMPLIANCE_CLIENT_SECRET`
- `FREDDIE_UAD_COMPLIANCE_SCOPE`
- `FREDDIE_UAD_COMPLIANCE_TOKEN_AUTH_STYLE`
- `UAD_COMPLIANCE_API_TIMEOUT_MS`

Each `BASE_URL` value is the exact assigned XML submission URL, not a general
developer-portal origin. HomeNode does not append or guess a resource path.

## Official starting points

- Fannie Mae UAD resources:
  <https://singlefamily.fanniemae.com/delivering/uniform-mortgage-data-program/uniform-appraisal-dataset>
- Fannie Mae technology integration resources:
  <https://singlefamily.fanniemae.com/technology-integration/technology-integration-resources>
- Freddie Mac UAD and Forms Redesign FAQ:
  <https://sf.freddiemac.com/faqs/uad-and-forms-redesign>

The team should re-check the official onboarding instructions and assigned URLs
at credential issuance time; endpoints and portal procedures are external
configuration and may change independently of HomeNode releases.

Deployment sequencing, the credential-safe readiness endpoint, provider
activation/rollback, and the external-gate acceptance matrix are documented in
`UAD_PRODUCTION_READINESS.md`.

As of the August 2026 official materials, the GSEs describe the Compliance API
as a system-to-system XML validation service. Production use still requires the
GSE verification process; ACPT/lower-environment access, credentials, exact
URLs, and the provider contract are supplied through onboarding. The API checks
well-formed XML, the UAD subschema, completeness, type/format, and
reasonableness. It does not return CU or LCA risk findings and is not a UCDP
submission.
