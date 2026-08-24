# UAD 3.6 security verification program

This program treats the HomeNode UAD application as a hostile target while
protecting production, shared staging, Custom Appraisal, and Property Tax
workflows. It is based on OWASP ASVS 5.0, the OWASP API Security Top 10, the
OWASP Web Security Testing Guide, NIST SP 800-115, and the current GSE UAD test
materials. It is an engineering acceptance program, not a representation that
HomeNode has received a third-party certification.

## Coverage model

This is one HomeNode security program with product-specific lanes, not three
duplicated penetration tests:

- shared identity, authorization, organization isolation, PostgreSQL, R2,
  property data, frontend, mobile, API, CI/CD, and operational controls are
  tested once and apply to all three report tiles;
- UAD 3.6 receives the deepest format, signing, package, compliance-provider,
  and GSE delivery tests;
- Custom Appraisal receives targeted calculation, comparable, adjustment,
  reconciliation, report-generation, and prior-file replication tests; and
- Property Tax Protest receives targeted workfile, evidence, filing-output,
  deadline/state, and appraisal-data-isolation tests.

A release cannot treat a passing UAD lane as proof that Custom Appraisal or
Property Tax behavior is safe. Conversely, a shared-platform defect blocks all
affected lanes rather than being retested as three unrelated findings.

## Mandatory environment boundary

Active scanning, fuzzing, concurrency testing, parser abuse, and load testing
may run only against a deployment explicitly designated `redteam`. That
deployment must use synthetic data and separate database, R2, OIDC, DNS, and
credentials. No red-team credential may grant staging, production, Cloudflare
account-wide, or GSE production access.

The existing staging and production services are limited to ordinary
functional smoke tests unless a separate written rules of engagement document
names them. Code scanning, dependency analysis, unit tests, and local parser
tests do not send hostile traffic and may run in normal CI.

## Rules of engagement

Before an active test window, record:

- approved hostnames, IPs, repositories, APIs, buckets, and database;
- start/end time, test operator, source IPs, test identities, and roles;
- allowed techniques and explicit exclusions;
- service owner and emergency contact;
- backup/snapshot identifiers and tested restoration procedure;
- log locations, alert expectations, rate/spend limits, and kill command; and
- evidence location and retention requirements.

Stop immediately if traffic reaches an unlisted host, real personal or
appraisal data appears, a test identity reaches production, an external GSE is
contacted unexpectedly, cost or latency alarms trigger, logs fail, or the
environment cannot be restored. Preserve evidence before rebuilding.

Never use destructive production payloads, uncontrolled denial of service,
self-propagating code, persistence, real malware, credential stuffing, social
engineering, or attacks on Cloudflare, Render, WorkOS, a data provider, or a
GSE. File tests use bounded inert fixtures that demonstrate parser behavior.

## Verification levels

1. **White box:** architecture and data-flow review, threat model, source and
   dependency scanning, secret/configuration review, and unit tests.
2. **Gray box:** authenticated tests using known appraiser, supervisor,
   reviewer, organization-admin, HomeNode-admin, disabled-user, and
   unprovisioned-user identities.
3. **Black box:** external discovery and browser/API testing with only the
   deployed URL and issued test credentials.
4. **Independent retest:** a qualified third party receives the final release
   candidate after internal Critical and High findings are closed.

## HomeNode attack matrix

| Area | Required adversarial cases | Required result |
| --- | --- | --- |
| OIDC | missing/malformed bearer token; modified header, payload, or signature; `none`/wrong algorithm; unknown `kid`; wrong issuer/audience/authorized party; expired, future, and replayed token; JWKS outage/rotation | Generic 401/503; no identity or token detail; fail closed |
| Identity mapping | unprovisioned, inactive, suspended, membership-less, duplicate, and cross-issuer identities | No application access; no automatic account linking |
| Workfile objects | enumerate or substitute account, workfile, entity, asset, artifact, signature, compliance, report-file, or previous-appraisal IDs | No cross-organization or cross-assignment disclosure or mutation |
| Functions and fields | reviewer calls write routes; appraiser changes ownership/assignee/organization; hidden or unexpected JSON properties | Server rejects forbidden functions and properties |
| Revision integrity | stale revision/digest, replayed completion suggestion, source change, simultaneous edits, repeated signing/package request | Conflict or idempotent result; never silent overwrite |
| Replication | changed condition, GLA, acreage, parcels, legal description, improvements, effective date, or photos | Material facts remain assignment snapshots and require review |
| Object storage | reused/expired PUT/GET URL; wrong method/type/size/key; overwrite; checksum mismatch; cross-workfile asset ID | Private, scoped, bounded object access; rejected asset remains unusable |
| Files and parsers | malformed XML/PDF/image/ZIP; XXE; entity expansion; path traversal; decompression ratio; MIME spoof; Unicode names; metadata payload | Bounded generic rejection; no outbound request, path escape, or resource spike |
| Injection | SQL, JSON/prototype, XSS in captions/commentary/names, CRLF/header, path/template, and SSRF payloads | Data remains inert; parameterized queries; no internal fetch |
| UAD logic | invalid enum/type/cardinality; missing conditional fields; conflicting totals; multiple parcels/dwellings; maximum lengths; unusual Unicode | Deterministic local findings and schema failure; no invalid package |
| Signing/package | sign stale/invalid report; swap XML/PDF/photos; modify manifest; replay compliance response; skip state | Server-authoritative revision and checksum gates block operation |
| Privacy | errors, readiness, logs, caching, CORS, artifacts, and browser history | No secret, token, PII, bucket/key, SQL, or stack disclosure |
| Resources | request bursts, slow bodies, parallel generation, repeated search/compliance, DB pool and R2 cost pressure | 429/bounded timeout/backpressure; service recovers without corruption |
| Supply chain | lockfiles, vulnerable packages, CI permissions, untrusted PRs, generated artifacts, deployment secrets | Review gate fails; least privilege; no secret available to untrusted code |

## Automated gates

Every pull request runs the existing application suites plus:

- CodeQL JavaScript/TypeScript and Python `security-extended` analysis;
- dependency review for newly introduced High/Critical vulnerabilities;
- `npm audit --audit-level=high` for server/web, `pnpm audit` for mobile, and
  `pip-audit` for both Python dependency manifests;
- Python source compilation and scraper regression tests;
- UAD authentication/authorization matrix tests;
- strict CORS, header, rate-limit, and readiness tests; and
- existing UAD schema, migration, validation, revision, PDF, XML, package,
  signature, compliance, storage, and smoke tests.

The manual `UAD red-team artifact boundaries` workflow adds a bounded,
credential-free parser lane. It rejects MIME-spoofed images, unreasonable image
dimensions, active PDF actions, XML DTD/entity and processing-instruction
payloads, ZIP traversal/device/control-character paths, and portable filename
collisions. The live integrity workflow separately verifies that draft artifact
generation fails closed and that artifact routes cannot cross organizations.

Successful asset verification downloads and inspects the object, calculates a
SHA-256 digest, copies the reviewed bytes to a checksum-addressed private key,
updates PostgreSQL to the immutable key, and removes the temporary upload key.
An unexpired client PUT URL can therefore affect only an unreferenced temporary
key after verification; PDF and package generation recheck payload structure
and the saved checksum before using verified bytes.

Later red-team workflows must be manual dispatches, accept only an allowlisted
red-team base URL, use environment-protected secrets, cap concurrency, upload
sanitized evidence, and refuse any hostname containing the production or shared
staging service name.

The bounded protocol-fuzz workflow adds signed JWT negative cases, parser and
content-encoding failures, media-type enforcement, route/method confusion, a
64 KiB response cap, secret/stack/SQL response screening, and a post-run health,
readiness, and unchanged-revision proof. It is sequential and non-mutating; it
is not a load test. The sales-rich pre-submission workflow remains the separate
functional gate for settled comparable sales, adjustments, reconciliation,
signed XML/PDF/package output, and negative missing-sales coverage.

The bounded endpoint-fuzz workflow extends that lane across hostile identifier
shapes, encoded and doubled paths, unsupported methods, JSON root/prototype/
depth cases, forwarding-header confusion, hostile CORS origins, and bounded
header pressure. It is likewise fixed to the synthetic red-team service,
non-mutating, response-capped, and followed by health/readiness/revision checks.
Local integration tests assert the same response contracts and prove rate
limiting occurs before request-body parsing.

### Temporary dependency exception

`GHSA-w3rx-r6r6-pgpr` and `GHSA-5p2g-fcmc-qvqq` affect `image-size` through
Expo/Metro's local build toolchain. Every published package version is affected;
the advisory's proposed `2.0.3` fix was not available from npm on 2026-08-21.
CI ignores only these two identifiers, while every other High/Critical finding
still blocks the change. HomeNode does not run Metro or `image-size` in the
deployed API, and untrusted appraisal images must never be processed through the
mobile build toolchain. Recheck the registry and Expo dependency graph by
2026-09-21 and remove the exception immediately when a maintained fix is
available.

## Finding lifecycle

Each finding records a stable identifier, control reference, severity,
affected release and endpoint, sanitized reproduction, impact, evidence,
owner, corrective change, regression-test identifier, and independent retest.
Secrets and personal data are never copied into issues or test reports.

Submission is blocked by any open Critical or High finding, any unresolved
authentication/authorization/tenant/secret/PII finding, a failed GSE test case,
or an unverified remediation. Medium and Low findings require an owner,
documented treatment, and deadline; risk acceptance cannot override a broken
security boundary.

## Evidence package

Retain the final architecture/data-flow diagram, threat model, ASVS/API control
matrix, authorization matrix, software bill of materials, scan reports,
sanitized request/response evidence, file-fuzz corpus manifest, load-test
parameters, findings register, remediation commits, clean retests, backup and
restore evidence, key-rotation exercise, monitoring/incident-response exercise,
independent penetration-test report, and official GSE test-case results.
