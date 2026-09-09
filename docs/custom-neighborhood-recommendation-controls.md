# Reviewing suggested Custom neighborhood pockets

The Custom pocket catalog may include a compact, current-observation
recommendation when the caller requests `include_recommendation: true`.
Omitting the flag or sending false preserves the earlier catalog response.
The existing owner requires both catalog and summary exposure permission before
opening retained inputs and again before returning the response. No source-policy
key, grant, organization role, or production configuration is added by this change.

The recommendation describes the entire retained discovery roster, independent
of which pockets are currently included. It contains group-level similarity
ranges, known-weight coverage, review order, and the suggested group IDs. It does
not expose retained subject material, per-property scores, source rows, or a
second set of selected-union statistics. The existing catalog carries membership.
Both projections are tied to the same exact context and catalog request binding.
The combined response remains bounded; an oversized response cannot silently
return only the first groups or accounts.

## Appraiser interaction

The workspace shows suggested pockets alongside their current-observation
similarity ranges and missing-data coverage. These are starting review heuristics,
not appraisal reliability, sale eligibility, verified legal subdivision boundaries,
or a reason to choose whichever selection produces the lowest COD.

"Use suggested selection" is an explicit selection action. It uses the same group
selection callback as individual inclusion/exclusion controls. In the saved
workspace that callback saves the checkpoint first; only the confirmed selection
starts the next coherent map/statistics preview. The recommendation does not
automatically replace restored choices, an explicit empty selection, or an
accepted report. Read-only, recovery-required, and pending-save states still
prevent selection changes.

The subject's recorded CAD group remains separately identified for review. Its
score is not increased, and it is not forcibly included. Missing builder, HOA,
phase, amenities, and unsupported historical observations remain unknown.

## Release boundary

This is the recommendation transport and existing-workspace UI integration.
The production report host/router still require composition with verified source
configuration and target-bound Save Everything/finalization controls. Supported
assessment assembly and coherent report Apply are separate outstanding steps.
The diagnostic workspace is excluded from print; accepted report/PDF data is
unchanged. No live-property accuracy or production activation is claimed by
unit, synthetic-browser, or native-fixture verification.
