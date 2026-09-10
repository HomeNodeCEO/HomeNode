# Custom Appraisal neighborhood report bridge

## Current scope

The Custom Report now has a default-disabled connection to the existing saved
neighborhood exploration workspace. It is not a replacement for accepted report
statistics, a production activation, or a completed supported-assessment Apply
path. UAD, Property Tax, authentication policy, source grants, report calculations
and signing authority are unchanged.

`useCustomNeighborhoodReportBridge` performs a fresh authenticated, no-store read
for the exact account, assignment file and local session generation. It does not
reuse a previous user's in-flight request or infer an observation period. Existing
saved periods/selections reopen; a new workspace has no invented date or automatic
capture. Authentication response object churn does not reload the workspace, but
changed identity/organization permissions, file or status invalidates late results.

The lazy `CustomNeighborhoodWorkspaceHost` is a single print-hidden sibling of the
existing neighborhood report section. It is intentionally outside the report's
print-triggered deferred loader: preparing a PDF must not initiate exploration.
The diagnostic recommendation, pocket selections and same-selection map/statistics
remain distinct from the accepted neighborhood group.

## Save and finalization

Save Everything synchronously pauses the exact workspace and waits for its pending
operations before either the dirty-assignment path or clean-save success. It then
checks the market queue, including changes appended during the assignment save.
Missing controls, uncertain saves and stale file/session completions cannot imply
that everything was saved. No automatic retry loop or background polling is added.

Finalization acquires the same exclusive pause before readiness checks. It checks
current draft/revision, assignment writes, market queue/error and target again
after asynchronous boundaries. A changed report must be saved and reviewed again;
it is not silently signed from an earlier readiness result. Successful finalization
retains read-only mode. Its own busy indicator cannot clear a newer request or
remain stuck solely because an older session was invalidated.

While paused, new map/inspector requests are not admitted. Already admitted reads
and checkpoint operations are allowed to settle. An interrupted preview uses the
existing explicit Retry; an inspector interrupted by the pause may resume after
release, while completed cached results are preserved. The 65-second adapter
deadline is a maximum wait, not a minimum delay. An unsettled operation is
quarantined read-only until it settles and the user explicitly reloads saved state.

## Configuration and activation

Both gates default off. They are separate deployment choices, not permissions:

- Frontend build: `VITE_CUSTOM_NEIGHBORHOOD_WORKSPACE_ENABLED=true`.
- Server: `CUSTOM_NEIGHBORHOOD_WORKSPACE_ENABLED=true` with
  `CUSTOM_NEIGHBORHOOD_SOURCE_PROFILE_JSON` containing exactly `datasetRevision`
  and `providerRevisions`.

The server profile is validated before application resources are created. It is
bounded to 16 KiB and must describe the real integrated source inventory, including
prior merged values. Invalid enabled configuration fails startup with a sanitized
error; an unused profile does not prevent a disabled deployment. No production
profile, grant or environment value is supplied by this change.

`customNeighborhoodComposition` uses the existing source-policy constructor,
capture owner and cohort router, after the existing application boundary and
workfile routes. Disabled requests require a principal before returning a bounded
no-store 503; disabled composition creates no cohort owner or cohort pool queries.
Existing global authentication, CSRF, rate limiting and JSON parser behavior remain
in place, including the upstream 1 MiB body limit. The producer remains mapping2;
this wiring does not silently enable the expanded mapping3 witness scope.

Before enabling either gate, verify additive migrations, real organization and
assignment access, the independently maintained source profile and genuine owner
basis described in [source-rights policy](custom-neighborhood-source-rights-policy.md).
Source inventory and rights in production remain unverified, not presumed absent.
A CSV filename/hash, successful import or application role is not a substitute for
that basis. Do not manufacture provider revisions or approval timestamps. Turning
both gates off is the display/request rollback; saved workspaces are not deleted.

## Verification and limits

New tests execute the actual hook/component and actual PropertyReport handler AST
with synthetic dependencies, plus the actual server composition/boundary/policy
with synthetic SQL and bearer hydration. They cover late responses, concurrent
saves, uncertain acknowledgment, read admission during finalization, changed drafts,
disabled behavior and source-denial boundaries. They do not claim live OIDC,
provider authorization, complete browser-to-production behavior or signing
artifact generation.

The native local run uses the existing guarded PostgreSQL/PostGIS fixture with all
canonical migrations. It additionally invokes the real assignment/section writer
while capture competes: capture refuses the lock, writes no context, and succeeds
only on an explicit retry after rollback. Existing checkpoint lost-ack/reopen,
revision conflict, signed-state, immutable review and source-policy checks remain.

The composition shell gains 355 source bytes; its narrow size budget changes from
21,300 to 21,700 bytes to accommodate the real import/configuration/mount. No other
source limit is raised. Full server/frontend suites, TypeScript, targeted lint,
source budgets and protected production-build/security/migration workflows must
pass before merge.

Remaining feature work: source-backed supported assessment assembly, coherent
Custom boundary/statistics Apply, real-source activation and sample-property QA,
followed by broader city discovery, subdivision/phase overlays and richer pocket
information where supporting data exists. Unknown builder/HOA/amenity facts must
remain unknown rather than inferred from unrelated records.
