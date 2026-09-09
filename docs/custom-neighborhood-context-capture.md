# Custom neighborhood context capture

`createCustomCohortContextCapture({pool, authorizeMarketData}).capture(...)`
connects the existing retained-subject, three-mile spatial discovery, cached
identity/source reader and immutable context repositories. It is an internal
Custom Appraisal service, not an HTTP endpoint or report Apply operation.

## Inputs and ownership

The request contains trusted middleware `auth`, exact `accountId`, canonical
bigint-text `assignmentFileId`, lowercase UUID `operationId`, and an inclusive
`observationPeriod: {start_date, end_date}`. No organization, report identifier,
source roster, geometry, query hash or browser-provided authority is accepted.
The assignment/report relationship and source subject snapshot are resolved in
the database. Existing workflow and exact-assignment write authorization remain
in force. Dates cannot extend beyond the retained subject effective date.

`authorizeMarketData` is a required server policy, with no permissive default.
It receives the bounded transaction client, principal, exact context, declared
read purpose and `{retention: true}`. A grant must identify a policy revision and
decision and cover cached market rows, all-date one-hop transaction identities,
and immutable retention. Assignment permission or a hash is not such a grant.
Production source licensing/entitlement wiring is not provided by this service.

## Three transactions, one retained result

1. **Read committed intent:** lock the exact assignment, authorize it, resolve
   its Custom report, retain the consumed subject inputs and recorded subject
   point, and persist the operation intent with a database timestamp. Commit
   before acquisition. An existing operation instead follows the authorized
   replay path described below.
2. **Repeatable-read, read-only acquisition:** recheck the target, authorize
   public CAD access, discover all parcel intersections within **4,828.032
   metres (three miles)** of the recorded subject point, and prepare the actual
   complete account roster. After explicit market permission, resolve the
   one-hop transaction identity closure and execute the cached source reader on
   that same client/snapshot. No desired-sale-count or first-30 limit determines
   discovery. Bounded overflow fails explicitly rather than truncating rows.
3. **Read committed retention:** lock/re-authorize the assignment, compare
   current consumed subject material, and recheck the original market-policy
   revision/decision. Consume the original process-local acquisition handoff,
   preflight and retain every original dependency, and register the immutable
   context. Only a successful COMMIT returns `status: registered`.

The four context dependencies retain the original snapshot, subject inputs,
complete selection/source evidence graph, and study inputs. See
`custom-neighborhood-original-input-retention.md` for paging, byte limits and
complete descendant verification. A count/digest does not replace original data.

## Replay, cancellation and failure

An operation UUID is scoped through the exact organization and target. Replay
loads only bounded request metadata before current market permission; row-level
market evidence is not loaded on a denied replay. The original actor, study,
current material and policy decision must match. The verified original graph
then establishes durable registration without rereading mutable source rows or
writing a second context. Replay returns the same descriptive result with
`reused: true`; it does not create a new acquisition handle or assert freshness
of the source cache.

The whole operation has a 60-second monotonic budget with cleanup reserved,
bounded connection acquisition and queries, server statement/lock/idle limits,
and optional cancellation. Late acquired clients are released once. SQL-failed
connections are discarded. A failed COMMIT acknowledgment reports
`outcome_unknown: true`: callers must retry the **same** operation identifier
through authorized replay rather than assume the commit rolled back.

## Explicit limits of this result

`source_query_complete` means the bounded retained query completed, not that the
provider has every property or sale. `provider_coverage` stays
`not_established`; source unsupported capabilities remain attached. Current
mutable CAD/MLS observations are not promoted into historical facts, complete
economic-property membership, verified sale consideration, eligible housing or
a supported appraisal cohort. The three-mile search extent is not the
appraiser's geographic neighborhood boundary.

This service does not change report sections, assessment current heads, PDF
content, signing, authentication policy or database schema. The next consumer
must calculate an honest retained-observation preview and separately establish
the supported facts/decisions required by publication and atomic report Apply.

## Executable observation preview

The same owner exposes an internal `preview({auth, accountId, assignmentFileId,
contextRef, selection}, options)` operation for a draft Custom file. Selection is
`{revision, pockets: [{id, label, account_ids}]}` and is detached before awaiting
any database work. Exact assignment **read** access is checked; this does not
give a reviewer write/sign permission or let the caller choose another tenant.

The first bounded transaction authorizes the exact stored context, checks the
current market policy before loading source rows, and loads the complete retained
graph. It releases its client before numeric/geometry processing. The pure numeric
consumer calculates the full captured population, each selected pocket, and
their deduplicated union. The pure map consumer decodes the original discovered
parcel EWKB, preserving holes and disconnected parts without fetching or
repairing geometry. Excluded parcels remain visible with `selected: false`.

A short final transaction rechecks the assignment, consumed subject material and
market policy before returning **one** `context_ref`/`selection_revision` group
containing `preview` and `parcel_map`. A client must replace this group together
and reject late responses for an older selection. This result does not persist
the selection, certify recommendation/reliability, change report fields or enable
Apply. An explicit empty pocket list means zero selected members, not a fallback
to the whole discovery. If exact geometry cannot be shown, the map result is
explicitly unavailable, never a misleading partial outline.

This is an internal service response, not a public route. Its observation members
carry assignment-private retained references/raw numeric evidence; a production
HTTP presentation owner must provide bounded summary/member paging and its
licensed exposure policy rather than forward the full graph to every browser.

## Verification

- Focused admission tests cover malformed inputs, cancellation/deadline
  admission, late pool acquisition and failed transaction cleanup.
- `customCohortContextCapture.integration.test.js` is listed in the existing
  migration CI runner. It uses the genuine database helper, not a mocked
  transaction or spoofed CI environment.
- The database helper proves actual spatial + identity + source composition,
  same-snapshot consistency during a concurrent source-price update, full
  original retention, no report writes, exact replay without rereading sources,
  denied licensing/foreign organization, cancelled policy work, policy changes,
  concurrent consumed-subject changes, and recovery after an actual durable
  COMMIT with simulated acknowledgment loss.

Local native verification on 2026-09-09 passed all six groups against a fresh
synthetic PostgreSQL 17.11 / PostGIS 3.6.2 database with all 78 genuine migration
checksums verified. It did not use production data, service controls or a
provider-coverage claim. Live-property accuracy, production policy wiring and
end-to-end appraiser Apply remain separate acceptance work.

The composed preview native run subsequently passed seven groups, including
actual retained source price after the live cache changed, matching numeric/map
selection, empty selection, excluded-but-visible parcels, no cache rereads or
writes during preview, and rejection after a subject-material change. This run
caught and fixed the distinct original parcel reader (`parcel:<id>`) and mapper
(`gis.dcad_parcels:<id>`) identity join; neither original identity was relabeled.

A final eight-group run additionally verifies revoked/changed policy and actual
assignment-owner/subject-material changes after the retained-read transaction
commits, before the response transaction. Each refuses the stale/unauthorized
preview. Admission uses the same 128-pocket work limit as the numeric consumer.
