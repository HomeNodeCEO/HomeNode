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

## What a green HomeNode gate means

HomeNode reports each verification layer separately. A passed local rule run or
XSD run must never be described as Fannie Mae, Freddie Mac, UCDP, or Collateral
Underwriter acceptance.

| Layer | HomeNode can run without GSE credentials | What it proves |
| --- | --- | --- |
| Sales-rich fixture gate | Yes | The synthetic SFR has at least three settled sales, a verified comparable photo for each sale, nonzero adjustments, recomputed net and adjusted prices, comparable weights, an indicated value, and sales/final reconciliation. |
| HomeNode local rules | Yes | The checked-in source catalog contains all 728 active Appendix H-1 v1.5 URAR rule IDs. Local execution is reported separately as `reference_only`, `mapped_unverified`, or `locally_verified`; catalog completeness is never labeled GSE-equivalent execution. |
| Official GSE subschema | Yes | The XML is well formed and valid against the pinned official XSD/subschema. This does not execute every Appendix H rule. |
| Fannie/Freddie Compliance API | No | The applicable GSE evaluated the exact XML for Appendix H completeness, validity, format, and reasonableness in the assigned nonproduction or production environment. |
| UCDP and CU/LCA | No | The lender delivery channel accepted the package and returned its separate submission, eligibility, risk, or appraisal-quality feedback. The Compliance API does not provide those results. |

The CI workflow named `UAD sales-rich pre-submission delivery gate` therefore
sets `gse_acceptance_claimed` to `false`. Its deterministic smoke fixture and
its disposable-database fixture both fail when sales, adjustments,
calculated totals, or reconciliation are missing or inconsistent.

## GSE verification test set

Once Fannie Mae supplies ACPT credentials, verification must use the current
official UCA cases from Fannie's Technology Integration Resources page:

1. URAR: No UAD Findings - the exact expected clean response is a required
   release gate.
2. URAR: UAD Findings - every expected fatal/warning is asserted and safely
   mapped to HomeNode fields without retaining tokens or unbounded payloads.
3. Malformed XML, subschema failure, expired/invalid OAuth, timeout, retry,
   duplicate submission, and provider-unavailable cases - all must fail closed.
4. A HomeNode sales-rich SFR - three or more settled sales, supported positive
   and negative adjustments, server-recomputed totals, comparable weighting,
   sales reconciliation, final reconciliation, photos, XML, PDF, and ZIP.
5. Official Appendix D scenarios - generated output is compared with the
   current published sample XML/PDF behavior for every property type HomeNode
   enables.

The same matrix is repeated for Freddie Mac with separate credentials and
correlation records. Provider success is stored per workfile revision; one GSE
result is not treated as the other GSE's result.

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
