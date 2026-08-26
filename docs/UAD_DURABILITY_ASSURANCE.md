# UAD active-file durability and assurance

## Guarantees and boundaries

For an online editor with a healthy API and PostgreSQL connection, HomeNode
targets an active-file recovery point of less than one minute. Field changes
are autosaved after ten seconds of inactivity and no later than 55 seconds
after the first pending edit. Hiding the browser tab, switching sections, or
closing the editor starts an immediate flush.

An autosave is acknowledged only after PostgreSQL commits the field changes,
the incremented workfile revision, the complete revision document, and the
audit event in one transaction. The browser never describes an edit as
protected merely because it exists in React state. Incomplete required values
may be stored by an autosave because the workfile remains a draft. Explicit
section review and whole-workfile validation continue to enforce all required
UAD fields before signing or package generation.

Every autosave uses the workfile revision as an optimistic-concurrency token.
If another session changed unrelated fields, the editor reloads the new
revision while retaining local pending values. If both sessions changed the
same field, autosave pauses and requires the appraiser to choose the local or
newer server value. A stale session never silently overwrites another session.

This target does not claim that an offline browser can reach PostgreSQL. The UI
keeps pending fields visible and reports a failed save; it does not present a
false success. Mobile offline capture continues to use its separate sparse
operation log and conflict protocol.

## Assurance graph

`npm run audit:assurance:uad` builds a read-only logical graph from the
canonical PostgreSQL records. PostgreSQL remains the system of record; no
second graph database or dual-write path is introduced. The audit reports only
aggregate counts and stable finding codes.

The initial graph checks:

- every workfile has a continuous revision chain from 1 through its current
  revision;
- field values and parent entities cannot cross workfile boundaries;
- validation, signature, and generated-artifact revisions exist;
- verified R2 assets and ready artifacts have object identity, size, and SHA-256
  integrity metadata;
- signed/submitted workfiles have a signature for the current revision; and
- delivery attempts remain bound to the same package, revision, workfile, and
  checksum.

The guarded red-team PITR verifier runs this graph after migration and fixture
checks. A database can therefore be reachable and contain the expected number
of rows yet still fail restoration acceptance because its logical lineage is
broken.

## Database account separation

Run `npm run audit:database-privileges` with the exact `DATABASE_URL` used by
the web service. It reports whether that login owns application schemas, can
create schema objects, or has elevated cluster capabilities. It never prints a
role name, database name, host, or URL. The default `report` mode is safe while
the deployment still uses a provider owner credential. Set
`DATABASE_PRIVILEGE_AUDIT_MODE=enforce` only after provisioning separate roles.

The intended production separation is:

1. A non-login owner owns schemas and tables.
2. A migration login can assume the owner role only during a controlled
   pre-deploy migration.
3. The web-service login owns no objects, cannot create schema objects, and has
   only the required table/sequence/function privileges.
4. Backup and monitoring logins are read-only and cannot assume the owner or
   runtime roles.

Role credentials and passwords are provisioned in Render/PostgreSQL, never in
SQL committed to the repository. Row-level security is a later defense-in-depth
step because the current server contains queries outside explicit transactions;
enabling tenant policies before transaction-local organization context is
universal would cause unsafe availability failures.

## Recovery controls outside application code

Repository tests cannot prove provider backup settings. Production operations
must record and periodically verify all of the following:

The current provider-console findings and prioritized follow-through are recorded
in `docs/PRODUCTION_DURABILITY_AUDIT_2026-08-25.md`.

- paid Render PostgreSQL PITR is available and its current recovery window is
  documented;
- a longer-retention encrypted logical backup is stored behind credentials and
  an account boundary independent of the production database;
- a scheduled restore creates a disposable database, runs migrations in verify
  mode, runs `audit:assurance:uad`, and is then destroyed;
- restore failure or missing backup freshness triggers an alert;
- verified evidence, signed reports, XML, manifests, and delivery packages use
  R2 bucket-lock prefixes after HomeNode adopts a written retention schedule;
- temporary upload prefixes remain outside long-term locks and have bounded
  cleanup; and
- R2 object-create/delete notifications are reconciled against PostgreSQL
  object keys and checksums.

Bucket-lock durations must follow the written appraisal retention and legal-
hold policy. They are intentionally not guessed or changed by application
deployment because a wrong lock can either allow premature deletion or prevent
a lawful purge.

## Failure exercises

At least quarterly, and after a material persistence change, the isolated
red-team environment should exercise:

- process termination during autosave, artifact upload, and package assembly;
- simultaneous edits to the same and different fields;
- database connection exhaustion, statement timeout, deadlock, and manual HA
  failover;
- PITR to points immediately before and after a known synthetic revision;
- missing, truncated, checksum-mismatched, and deletion-notified R2 objects;
- application rollback while additive migrations remain applied; and
- a multi-hour editing and artifact-generation soak with connection, memory,
  queue, error-rate, and revision-growth measurements.

The acceptance evidence is the restored revision number and checksum lineage,
not merely a green HTTP health response.
