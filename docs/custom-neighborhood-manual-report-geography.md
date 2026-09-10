# Saved manual geometry in Custom report preparation

The appraiser's rough narrative boundary and the analytical discovery/selected
pockets remain different inputs. This slice connects a saved manual outline to
the existing internal report preparer. It does not clip the stock, recalculate
statistics, replace the discovery area or activate report Apply.

## Corrected drawing intent

Previously, Reset to Suggested Area could emit an automatic change while the
generation record was absent or still loading. The handler then fell through to
the manual source marker. The handler now uses the exact origin:

- An explicit drawing event writes `appraiser_defined_area_manual_v2`.
- An automatic reset with its generation record keeps the existing generated
  boundary handler.
- An automatic reset without that record retains the supplied suggestion as
  `neighborhood_boundary_automatic_unverified_v1`, never as manually drawn.
- Clear writes the existing cleared marker and null geometry.

Existing polygons are still viewable. The older manual-v1 marker is not silently
upgraded because its origin could be ambiguous. A new explicit drawing creates
the new marker. Neither a marker nor an old confirmation flag proves licensure,
property/source accuracy or historical applicability; these are saved editor
assertions, not independent evidence of authority.

## Exact saved input, not a property fallback

The existing assignment save endpoint continues to own persistence, revision
comparison and assignment history. No table, route or generic save behavior is
changed. Under its existing exact assignment lock, the neighborhood owner reads
only ten saved boundary fields: geometry, source, label, four cardinal texts,
saved timestamp, confirmation and confirmation timestamp.

The database measures that projection before returning it. At most 262,144 UTF-8
bytes of projected PostgreSQL JSON text cross the boundary, with the exact text
digest, actual assignment revision and root JSON type. Missing keys and explicit
nulls are retained distinctly. Unrelated client, contract and assignment data are
not fetched. There is no account-level latest-boundary fallback.

The pure admission distinguishes absent, cleared, legacy/unverified intent,
malformed representation and capacity limitations. Only the exact new manual
marker with a structurally admissible Polygon reaches the owner's parameterized
PostGIS check. The original coordinates, closure and holes must already be
present. Nothing is coerced, closed, repaired, simplified, snapped or converted
into a hull or circle.

PostGIS checks those exact coordinates for validity. An invalid shape, including
a self-intersection, stays in the saved evidence but is unavailable as report
geometry. The validity result and PostGIS version are retained as diagnostic
observations, not claims of named-road alignment or subject containment.

## Same-state report bundle

The completed geography admission is consumed by the actual report preparer.
It adds a bound, assignment-private evidence source and supplies the exact
admitted outline and usable literal cardinal descriptions. Missing cardinal
names remain missing. The existing stock, transaction membership and computed
statistics are unchanged.

Before returning preparation, the owner rereads the exact projection and actual
assignment revision. A concurrent outline/content/revision change rejects the
already calculated result. This fence is separate from consumed-subject
freshness because narrative boundary edits are not analytical subject changes.

Report geography remains incomplete: named/source-attributed perimeter edges,
source-period support and subject containment have not been established by a
freehand drawing or by `ST_IsValid`. The coherent report group remains blocked
from Apply until its remaining requirements are met. Old callers that do not
supply a saved-geography admission retain their previous result shape.

## Verification boundaries

Focused frontend tests execute the actual change handler, including the reachable
automatic → clear → reset path without a generation record. Pure and owner tests
cover stored intent, malformed and missing fields, exact geometry and cardinal
preservation, and concurrent edits. Native tests separately exercise the actual
bounded projection and PostGIS validity query on an isolated local database.
Synthetic SQL responses or handler execution are not live browser verification,
source rights, appraiser authorization or production readiness.

Local verification on September 9, 2026 passed 5,223 server tests (21 skipped),
1,259 frontend tests, the production build and all bundle/source/lint budgets.
The native run used 79 unchanged canonical migrations and passed all 27
coordinator groups plus the policy, checkpoint, review and source-reader groups.
It confirmed valid holes, an invalid self-intersection without repair, scoped
projection/hash behavior and concurrent assignment changes. Exact owned test
state was restored. Interactive production-browser verification remains
unobserved and protected remote CI remains required before merge.
