# HomeNode platform threat model and control matrix

Status: working security baseline for Custom Appraisal, UAD 3.6, Property Tax
Protest, and the shared property-data platform. Revisit this document for every
material trust-boundary, identity, provider, parser, or delivery-format change.

## Scope and security objective

HomeNode uses one platform and three report workflows. Security testing is
therefore platform-wide, with deeper UAD tests for GSE delivery. A separate,
duplicated penetration-test program for each tile is unnecessary; omitting a
tile is also unsafe because all three depend on shared identities, APIs,
PostgreSQL records, private object storage, and property data.

The primary objective is to prevent an unauthenticated, cross-organization,
wrong-role, stale-client, or compromised integration request from reading or
changing an appraisal assignment, protest file, evidence object, signed report,
submission package, user identity, or credential. Public property facts must
not become a path into private assignment data.

## System and trust boundaries

1. Browser and mobile clients are untrusted. Hidden fields, disabled buttons,
   local databases, editor state, IDs, totals, and calculated values are never
   authorization or integrity controls.
2. The Node API is the authoritative business boundary for all report files.
   It authenticates identities, authorizes organization and assignment access,
   calculates material results, validates revisions, and writes audit records.
3. PostgreSQL stores shared property identity separately from assignment-time
   snapshots. A later appraisal never silently inherits changed condition,
   GLA, acreage, parcels, improvements, legal descriptions, or exhibits.
4. Cloudflare R2 is private evidence and artifact storage. Clients receive only
   short-lived, method/content/size/scoped URLs; the API verifies the object
   before it becomes report evidence.
5. The scraper/API boundary supplies public property-source data. It has no
   authority to edit report files, impersonate users, or receive report secrets.
6. OIDC, mail, OCR, MLS/data providers, Render, Cloudflare, and future GSE
   compliance services are separate trust boundaries. Provider success never
   replaces HomeNode authorization or local UAD validation.
7. GitHub Actions and package registries are a software-supply boundary.
   Untrusted pull requests receive no deployment, cloud, GSE, or production
   database credential.

## Protected assets

| Class | Examples | Required protection |
| --- | --- | --- |
| Identity | OIDC subject mapping, memberships, roles, appraiser profile | MFA/provider controls, explicit mapping, fail-closed authorization, audit |
| Assignment facts | effective-date snapshot, inspection facts, condition, GLA, parcels, legal description | assignment scope, revision checks, provenance, immutable history |
| Analysis | comparables, adjustments, market conditions, approaches, reconciliation | server calculation, source/version binding, stale-write rejection |
| Evidence | photos, sketches, measurements, contracts, PDFs, signatures | private storage, bounded parsing, checksum, MIME/content verification |
| Deliverables | Custom/PTR reports, UAD XML/PDF/ZIP, manifests, compliance results | revision/signature binding, deterministic generation, integrity checks |
| Secrets | database, R2, OIDC, SMTP, OCR, MLS, GSE credentials | secret manager only, least privilege, rotation, no client/log persistence |
| Availability | API, database pool, scraper, storage and paid providers | bounds, timeouts, rate/cost limits, queues, restore and incident exercises |

## Threat actors

- anonymous internet client or automated scanner;
- authenticated user without a HomeNode mapping;
- inactive user or user without an active organization membership;
- appraiser, supervisor, reviewer, organization admin, or HomeNode admin acting
  outside the assigned role or organization;
- malicious/compromised browser, mobile device, dependency, CI job, provider,
  or uploaded file; and
- operator error, stale client, concurrent edit, or incorrect replication
  request without malicious intent.

## Non-negotiable invariants

- Every private object is authorized by server-loaded organization and
  assignment relationships; possession or substitution of a UUID is not access.
- User, organization, role, actor, ownership, assignee, revision, digest, total,
  signature, object key, and artifact state are server authoritative.
- "Replicate results" is an explicit, audited proposal. Material assignment
  facts and inspection evidence remain new-file snapshots requiring review.
- Custom and UAD may share one completion methodology only when the source and
  target belong to the same assignment and immutable subject snapshot.
- Property Tax Protest never gains appraisal-file access merely because it uses
  the same property identity.
- Unverified uploads, stale validations, changed source data, incomplete signer
  profiles, or provider failures cannot produce a valid signed UAD package.
- Logs and errors contain bounded codes, not tokens, SQL, stack traces, object
  keys, credentials, raw provider responses, or personal report content.

## Control and verification matrix

| ID | Threat/control | Automated evidence | Release gate |
| --- | --- | --- | --- |
| HN-AUTH-01 | Missing, malformed, forged, expired, wrong-issuer/audience/algorithm OIDC token fails closed | OIDC adversarial unit tests; CodeQL | Required |
| HN-AUTH-02 | Active identity must map explicitly to one active user, membership, and permitted role | identity and membership tests | Required |
| HN-TENANT-01 | Account/workfile/entity/asset/artifact/report ID substitution cannot cross organization or assignment | UAD access matrix; route integration tests | Required |
| HN-ROLE-01 | Appraiser, supervisor, reviewer, org admin, and HomeNode admin have endpoint/field-specific permissions | role matrix tests | Required before production identities |
| HN-STATE-01 | Stale revision, digest, source, selection, or simultaneous edit cannot overwrite newer work | revision/concurrency tests | Required |
| HN-REPL-01 | Prior-file replication preserves lineage and does not copy changed physical facts silently | appraisal history/replication tests | Required |
| HN-FILE-01 | Upload type, byte size, checksum, key, workfile, and status are verified server-side | R2/document/photo/asset tests | Required |
| HN-FILE-02 | PDF/XML/image/ZIP parsers reject malformed, external-entity, traversal, spoofed, and resource-exhaustion inputs | bounded fixture fuzz corpus | Required before red-team sign-off |
| HN-UAD-01 | Official types, enums, cardinality, conditions, cross-record rules, XSD, signatures, and package state are enforced | UAD catalog/validation/XML/PDF/package suites | Required |
| HN-CUSTOM-01 | Comparable, adjustment, approach, market, and reconciliation results are rebuilt from canonical server inputs | Custom calculation/report tests | Required |
| HN-TAX-01 | Protest workfiles and evidence require assignment/editor authorization and cannot reach appraisal records | property-tax route tests | Required |
| HN-DATA-01 | Scraper/provider URLs, redirects, response sizes, timeouts, and database writes are bounded and source-labelled | provider and parser tests | Required |
| HN-WEB-01 | Explicit CORS, security headers, body bounds, and recognized UAD rate limiting | HTTP security and live router tests | Required |
| HN-SUPPLY-01 | CodeQL, dependency review, npm/pnpm/pip audit, lockfiles, Dependabot, and secret scanning | required GitHub checks | Required |
| HN-OPS-01 | Separate red-team data/identity/storage, backup/restore, alerting, spend limits, and kill switch | exercise evidence | Required before active DAST |
| HN-GSE-01 | Compliance credentials are server-only and red-team tests cannot call production GSE endpoints | readiness/config tests and egress review | Required before onboarding tests |

## Current disposition

- The shared JavaScript security gates, explicit API CORS policy, security
  headers, UAD object authorization, recognized rate limiting, strict readiness,
  and adversarial OIDC cases are implemented.
- Python CodeQL, pip audit, Dependabot coverage, source compilation, explicit
  scraper CORS, and disabled-by-default legacy PDF processing are implemented.
- The isolated Render API, web, PostgreSQL, R2, and synthetic identity boundary
  are provisioned. Baseline, UAD role/tenant matrix, protocol fuzz, private-
  storage integrity, artifact parsing, sales-rich delivery, and point-in-time
  recovery gates have credential-safe evidence. Shared staging remains limited
  to functional smoke tests and non-invasive scanners.
- Role coverage outside UAD, broader browser scanning, bounded load/cost and
  kill-switch/monitoring exercises, official GSE nonproduction cases, and an
  independent external penetration test remain open.

No Critical or High finding, tenant/authorization defect, secret/PII exposure,
unverified remediation, or failed official GSE case may be accepted for a
submission release. See `UAD_SECURITY_TESTING.md` and
`UAD_RED_TEAM_ENVIRONMENT.md` for execution and evidence requirements.
