# UAD 3.6 deployment and production readiness

This runbook covers HomeNode's isolated UAD domain. It does not migrate,
rewrite, or roll back Custom Appraisal or Property Tax records.

Security verification and destructive-test isolation are defined in
`docs/UAD_SECURITY_TESTING.md` and `docs/UAD_RED_TEAM_ENVIRONMENT.md`. Active
adversarial testing is not authorized against this production runbook's target.
The current official-specification comparison, compliance-by-design controls,
and deliberately unsupported scopes are recorded in
`docs/UAD_SPEC_REFRESH_AUDIT_2026-08-29.md`.

## Readiness definition

`GET /api/uad/readiness` is a read-only operational probe. It returns HTTP 200
only when all local delivery prerequisites are ready:

- the UAD workspace feature flag is enabled;
- the database is reachable;
- every ordered UAD migration is present with the committed checksum;
- the locked UAD specification release is current;
- the required UAD relations exist;
- private object storage is configured; and
- OIDC is configured for the authenticated signature boundary.

The process-level `/ready` probe separately enforces a bounded database probe,
database-pool headroom, artifact-executor capacity, and container memory
headroom. Artifact generation rows interrupted by a process restart are marked
retryable after the configured stale interval; the recovery monitor repeats
without requiring another restart.

The desktop UAD editor provides bounded canonical autosave. Online field edits
are committed as complete PostgreSQL revisions after ten seconds of inactivity
and no later than 55 seconds after the first pending change. Concurrent
same-field edits require an explicit appraiser decision. See
`docs/UAD_DURABILITY_ASSURANCE.md` for the guarantee, limitations, assurance
graph, and recovery evidence.

The response contains booleans, counts, the public UAD release key, and stable
blocker codes. It does not return a database name or URL, storage bucket,
OIDC issuer/audience, provider endpoint, client ID, client secret, or token.

External Compliance API readiness is reported separately. A locally ready
deployment remains useful for editing, validation, PDF/XML generation, and ZIP
delivery even while GSE onboarding is incomplete. Do not represent a disabled
or unverified external provider as production-ready.

## Staging deployment order

1. Confirm the service uses a dedicated staging database containing only the
   deterministic synthetic fixtures. Never point it at `homenodedb`.
2. Keep `UAD_WORKSPACE_ENABLED=false` during the first deployment of a new
   migration set.
3. Take a current, restorable database backup or provider snapshot.
4. Deploy the exact reviewed commit.
5. From `server`, run `npm run migrate:uad`, then `npm run migrate:mobile`.
   The migration runners use advisory locks, are additive, and reject a changed
   checksum for an already-applied migration.
6. In staging only, run `NODE_ENV=staging npm run prepare:staging:uad`. The
   script refuses a database whose name does not contain `staging`.
7. Configure private R2 and OIDC secrets in the deployment secret manager. Set
   `R2_BUCKET` to the shared Custom Appraisal/mobile bucket and
   `UAD_R2_BUCKET` to the environment's dedicated UAD bucket. The UAD override
   never redirects shared documents or mobile photos.
8. Enable `UAD_WORKSPACE_ENABLED=true`, restart, and inspect
   `/api/uad/readiness`.
9. Run the read-only smoke test:

   ```sh
   cd server
   npm run verify:staging:uad -- \
     --base-url=https://your-uad-api.example.com \
     --app-url=https://your-uad-app.example.com
   ```

10. Exercise the SFR fixture in the browser and mobile app: save a field,
    upload and verify the required subject photos, three closed comparable
    photos, and sales-comparison map; run local validation,
    review the PDF, generate XML, sign through OIDC, and generate the delivery
    package. Confirm a new revision makes older artifacts non-current.

The `UAD staging smoke` GitHub Actions workflow exposes the same read-only
verification as a manual `workflow_dispatch`. It does not create workfiles,
upload objects, sign reports, or invoke an external GSE API.

## Production activation order

1. Complete staging acceptance on the commit that will be released.
2. Back up the production database and record the backup identifier outside the
   repository.
3. Deploy with the UAD workspace and both compliance-provider flags disabled.
4. Confirm the Render pre-deploy gate ran `npm run migrate:uad` successfully.
   Apply mobile migrations only as part of the separately controlled mobile
   release. Do not run the staging fixture bootstrap against production.
5. Configure R2 and OIDC secrets. Production must set `UAD_R2_BUCKET` to a
   dedicated private bucket while retaining the existing `R2_BUCKET` for
   Custom Appraisal documents and shared mobile photos. Run
   `npm run verify:uad:object-storage`; it writes, inspects, checksum-verifies,
   reads, and removes an opaque probe without printing credentials, bucket
   names, or object keys. Then enable the UAD workspace and verify the readiness
   endpoint reports `checks.object_storage.isolated=true`.
6. Create a real internal test assignment through the normal search-tile
   workflow. Confirm Custom Appraisal and Property Tax destinations are
   unchanged.
7. Complete an internal end-to-end UAD package and independently inspect its
   PDF, XML schema result, image references, manifest audit artifact, and ZIP.
8. Enable an external provider only after its nonproduction scenarios pass and
   the GSE issues the correct production endpoint, authentication contract, and
   credentials. Enable the global compliance flag and one provider flag at a
   time.

No code path in this release submits a delivery ZIP to UCDP. The Compliance API
accepts the current schema-valid XML and records findings; the lender/UCDP
delivery workflow remains a separate operational step.

## Rollback

The first rollback control is `UAD_WORKSPACE_ENABLED=false`. This immediately
removes access to UAD workfile routes while leaving Custom Appraisal, Property
Tax, database records, R2 objects, and audit history intact.

If application rollback is also required, deploy the last known-good commit
after disabling the feature. Do not run a down migration and do not drop UAD
schemas during an incident. The migrations are additive, and an older build
can ignore newer UAD tables. Restore a database backup only for confirmed data
corruption and only after preserving the affected database for investigation.

External provider rollback is independent: disable the affected
provider-specific flag, then the global compliance flag if necessary. Rotate a
credential in the provider portal and deployment secret manager; never copy it
into an issue, log, readiness response, or repository file.

## Retention and backups

HomeNode does not automatically delete UAD workfiles, revision snapshots,
signatures, audit events, evidence, generated reports, packages, or compliance
history. Automatic deletion is unsafe until the company adopts a written,
jurisdiction-aware retention policy with litigation/administrative hold rules
and verifies that database and R2 backups follow the same policy.

`npm run audit:retention:uad` performs a read-only aggregate review. It reports
counts of old cancelled/revised workfiles, incomplete evidence, failed or
superseded generated artifacts, and retained raw compliance responses. It does
not output file IDs, object keys, response bodies, or personal data, and it has
no deletion mode.

At minimum, production operations must verify:

- automated database backups are enabled and a restore is tested;
- a fresh provider logical export is visible before a material persistence or
  migration release, and its identifier is recorded outside the repository;
- R2 objects are private, credential rotation is documented, and lifecycle
  rules do not delete an object still referenced by PostgreSQL;
- backup and object-retention settings preserve signed revision evidence;
- legal or regulatory holds override ordinary review dates; and
- a human approves any future purge design after comparing database references,
  object checksums, and backup coverage.

Run `npm run audit:assurance:uad` against every disposable restore. Run
`npm run audit:database-privileges` against the web-service login, then switch
that audit to enforce mode only after the runtime login no longer owns or can
create application schema objects.

## Acceptance matrix

| Gate | Automated evidence | Activation requirement |
| --- | --- | --- |
| Code and schema | Server tests, frontend build, PostGIS migration CI | All required checks green |
| Local deployment | `/api/uad/readiness` | HTTP 200 with no blockers |
| Synthetic staging | `npm run verify:staging:uad` | Health, release, storage, readiness, and fixture pass |
| Native delivery | Manual signed fixture/package exercise | PDF, XML, images, manifest audit artifact, and ZIP inspected |
| Fannie compliance | Provider readiness plus persisted test exchanges | Onboarding, ACPT scenarios, verification, production credentials |
| Freddie compliance | Provider readiness plus persisted test exchanges | Onboarding, assigned test scenarios, verification, production credentials |
| UCDP/lender delivery | Outside the Compliance API adapter | Lender-approved delivery procedure |

## Remaining external gates

The repository work is complete without embedding private or guessed provider
contracts. Production Compliance API activation still depends on information
that only the applicable GSE onboarding process can issue:

- accepted technology-provider intake and account ownership;
- assigned nonproduction and production XML submission URLs;
- approved OAuth token URL, scope, and token authentication style;
- nonproduction and production client credentials;
- required verification scenarios and acceptance evidence; and
- lender/UCDP delivery instructions for the completed ZIP.

Until those gates are complete, leave `UAD_COMPLIANCE_API_ENABLED` and both
provider-specific enable flags false.
