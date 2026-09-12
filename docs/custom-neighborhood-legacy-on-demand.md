# One automatic neighborhood workflow

When the captured Custom neighborhood workspace is enabled, opening or scrolling
to the report must not also launch the older boundary, relevance, land-use and
market-profile jobs. Live QA exposed those extra requests and a legacy land-use
parcel-cap rejection while a captured study was running.

The existing workspace feature flag now turns off only those four legacy
automatic effects. Existing saved geometry, pocket overrides, statistics and
review confirmation are not cleared. Manual drawing and explicit legacy
generation/analysis/profile refresh still work; explanatory text no longer
claims a legacy suggestion is loading when none was requested.

Legacy-only deployments retain their original automatic behavior because the
component/hook option defaults to enabled. This is not an authentication switch,
a change to report acceptance, or a new calculation. The captured study's Apply
still saves boundary and statistics together and then disables legacy editing
through the existing accepted-group gate.

Controlled callback/effect regressions verify zero automatic requests in captured
workspace mode (including effect replay), preserved manual requests, saved data,
and unchanged legacy-only behavior. The profile hook separately verifies that
explicit refresh continues preserving pocket statistics. Full frontend tests and
the production build are required before release; live QA follows deployment.
