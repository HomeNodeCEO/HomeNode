# One coherent opening after a fresh neighborhood capture

Fresh captures already start with all recorded catalog groups included, including
the nonempty unresolved group. Previously the browser loaded that catalog, saved
its selection, then requested the same retained evidence again for map/statistics.
Saved version-5 workspaces already support one combined catalog/preview response.

## Optional catalog mode

`initial_preview_mode: "all_catalog_groups"` requests a combined opening for the
complete catalog-derived selection. The server derives the group IDs from the
same authorized, validated catalog used in the response. This is not a request
for a recommended subset, a different radius, more source access, or new evidence.

The new fixed mode and `initial_preview_groups` are mutually exclusive. Existing
explicit group lists are unchanged: `[]` still means no selected observations.
Ordinary catalog requests and legacy saved-workspace handling remain available.

The catalog and its initial preview share only the current request's checked
retained evidence. Initial/final assignment, subject and source-policy checks,
all exposure permissions, and the existing independent response limits remain
in force. The combined limit stays 31 MB; catalog and preview sublimits are not
raised. No cross-request evidence cache or authorization reuse is introduced.

## Browser save and admission

After capture, the browser requests the fixed all-groups mode and independently
derives its initial selection from the checked returned catalog. It saves those
same group IDs under the existing revision-checked workspace save. Only after
the exact save acknowledgment may the initial preview reach the controller.

The controller still validates the map, statistics, context, target and selection
bindings together. Missing or invalid opening data is an error, not permission
to silently issue another preview or substitute a different selection. Lost save
acknowledgments, cancellation and pending-capture recovery follow existing rules.
Report Apply, the appraiser's manual boundary and accepted statistics are separate
and are not changed by this opening optimization.

## Measurement and release

A measured complete three-mile QA capture took 91.8 seconds, followed by separate
successful catalog (26.4 seconds) and preview (29.9 seconds) requests. A saved
reload already used one combined request (35.5 seconds). These are observed
baselines, not a guaranteed improvement or proof of broader capacity.

Deploy the backward-compatible backend before the frontend that requests the
new mode. Verify a fresh/resumed capture has one catalog/opening request, no
immediate duplicate preview, unchanged all-population membership, coherent map
and statistics, exact saved reopen and unchanged accepted report data. Tests must
also cover explicit empty lists, unresolved/empty/dense catalogs, private-source
scope, conflicting or invalid modes, late/failed save acknowledgments and byte
limits. No date-applicability, scoring or source-meaning rule changes belong here.

Local native coverage exercises the actual HTTP owner, city studies, private-sale
bindings, empty selection, nonempty unassigned membership and invalid/conflicting
modes. It compares the entire combined response against explicit-all opening and
an independent preview, counts one retained graph read, and checks both initial
and final source exposures. Frontend coverage includes real producer geometry and
fingerprint admission through transport, exact save acknowledgment and the
one-shot preview controller. These checks use synthetic local evidence; live
latency and whole-city capacity still require separate measurement.
