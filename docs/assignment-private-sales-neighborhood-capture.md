# Reviewed private CSVs in Custom neighborhood exploration

This is an additive observations path. It does not rewrite shared sales, infer
canonical sale-event equivalence, or replace the accepted appraisal report.

## User workflow

1. Save a private CSV in the exact Custom assignment; inspect retained row receipts.
2. Save the source interpretation and account-match decisions. Missing units or
   price-field meaning stay unknown; uploaded or confirmed does not mean eligible.
3. Choose **Use saved CSV review in neighborhood analysis**. The displayed study
   period and the exact batch/review revision are saved before capture starts.
4. Review private-source observations alongside the same context and selected
   pockets as the map. Explicitly empty selections produce no selected sales.

If a pending capture can no longer use its original review, **Reload saved
choices** first, then **Set aside pending capture**. This clears only the saved
pending choice using its exact section revision; it does not delete evidence or
the previous active study. A lost acknowledgement requires a fresh saved-state
read before a new capture. A signed file retains the existing subject-protection
rules, including replay protection.

The CSV's closing dates, not upload dates, determine period inclusion. A past
sale may contribute a reported observation but does not establish the historical
unsold-property roster, subject condition, subdivision phase or housing stock.
Package totals retain every confirmed account; prices are not allocated across
parcels. Source-record summaries are separate from shared canonical transactions,
so this path does not silently double-count them as one combined sale population.

## Retention and compatibility

Existing capture selection-input v1 and workspace checkpoint v1 remain readable
without changing their bytes or hashes. An explicit private capture uses v2
directories/checkpoints and retains a separately paged private supplement in the
existing organization-scoped blob graph. No additional database tables are needed
beyond the previously installed CSV intake/review migrations.

All original rows are retained, including excluded, duplicate, empty, unresolved
and rejected rows. Every original ordinal and preparation digest is verified.
The final registration transaction locks the workfile before the batch, checks
draft/signing state, subject identity, current review revision and source rights,
then registers the coherent context. Replay uses the same operation and exact
batch/review reference; it never selects the latest upload implicitly.

## Independent private-source permission

The existing integrated-cache source grant explicitly excludes private uploads.
Private observations therefore have their own server-side organization metadata
key, `custom_neighborhood_private_sales_rights`, checked before row acquisition
and exposure and again before returning or committing. No environment-variable,
WorkOS, role, session, or existing shared-source grant is changed by this feature.

An independently approved installation supplies the exact following shape:

```text
policy_version: 1
organization_id: exact owning organization UUID
grant_id: stable grant identifier
purpose: assignment_private_sales_observations_v1
rights_basis: { owner_id, basis_reference, approved_by, approved_at }
valid_from / expires_at: UTC timestamps with six fractional digits
revoked_at: null (non-null denies access)
retention: immutable_originals_without_automated_deletion
exposures: { none, report_observation_summary,
             report_observation_members, report_observation_catalog }
```

`none` must explicitly permit immutable retention; other exposures are explicit
booleans. Private summary delivery also requires summary permission when the
request is for a catalog or member view. The review's source-use checkbox is not
a substitute for an installed purpose or independent provider permission.
Missing, expired, revoked, foreign or changed grants deny access. Source rights
are never installed automatically from a browser request or a CSV header.

Public summaries omit raw rows, per-row account IDs, reviewer notes and provenance
notes. Decimal order statistics retain exact values; display formatting is separate.
Unknown currency/units, field conflicts and unsupported cumulative DOM are shown
as unavailable, not silently reinterpreted.

The browser checks the source batch/review and observation period when activating
a requested private capture. Later previews keep private summaries, the existing
statistics, and parcel geometry in one exact context/selection-bound response.
While a selection is updating, the previous coherent group is explicitly stale;
an invalid response cannot replace just one part of it.

## Verification

Unit and component tests cover original-row digests, exact decimal medians,
source/selection mismatch, permission changes, old-v1 compatibility, pending-save
recovery, and explicit empty selections. The migrated PostgreSQL coordinator
fixture additionally exercises real import/review/capture/reopen, transaction
isolation, batch locks, stale review rejection, independent exposure grants,
signed/read-only denials, and durable-COMMIT acknowledgement loss. These use
synthetic data; they do not establish production provider coverage or rights.

## Remaining admission boundary

These are reported observations, not yet an accepted neighborhood assessment.
Report-ready statistics require the separately versioned supported/adoption
profile, economic-event/eligibility review and temporal support. Boundary and
statistics must still be applied together through the existing atomic acceptance
path; this feature must not hydrate report fields independently.

Sales retention remains audit-only. No scheduled deletion or five-year purge is
enabled here, and referenced appraisal evidence is not deleted.
