# Saved Custom neighborhood workspace host

`CustomNeighborhoodWorkspaceHost` composes the exact retained-context lifecycle,
checked workfile API adapter, bounded request lane and controlled pocket view.
It is an explicitly injected component, not a production feature flag or route
activation. The production report caller and source-policy factory remain a
separate integration step. No UAD/Mobile/Property Tax workflow is mounted here.

## Required owner inputs

- A verified current account, safe positive assignment-file ID as exact text,
  and a local session/organization generation key. The legacy workfile endpoint
  still responds with numeric IDs, so an unsafe integer is refused, not rounded.
- The `neighborhood_workspace` section from that exact fresh workfile read.
  An absent own property is absent; malformed/null data is not a new file.
- Actual workfile status. Signed/archived files do not create an editable host.
- An optional observation period from the selected report. If supplied for a
  new file, the host starts once. Existing active context reopens exactly;
  pending capture operations are offered for explicit same-UUID recovery.
- An API instance using the established authenticated request/URL boundary and
  editor-credential accessor. It must not substitute a different target or use
  browser-entered reviewer/signing identity.

No source grants, trusted provider profile, effective date or session are
manufactured by this component. A context hash and a syntactically valid saved
section cannot establish authorization.

## Persistence and display ordering

The lifecycle saves pending capture intent before capture, verifies its catalog,
then saves the exact active context and selected group IDs. A group click first
persists the new IDs using the existing section CAS revision. Only that confirmed
selection starts the next preview. Save status is local to this component; it
does not subscribe to or drive page-wide assignment autosave animations.

The map and statistics remain the preceding coherent group, labeled stale,
while selection persistence or preview is pending. Controlled mode never reloads
the catalog or replaces an explicit empty list with all groups. Invalid restored
IDs/context produce a visible refusal. Inspection uses the same request lane but
does not alter inclusion. A preview retry is a read and keeps the selection
revision unchanged.

The lane serializes this session's checkpoint, capture, catalog, main-preview
and inspection HTTP operations. Routine subscriber cancellation does not abort
an active HTTP operation and immediately start a competing one. Its finite
deadline aborts and quarantines the lane. Even then, client cancellation is not
proof that a server transaction released its locks. Recovery requires an
explicit checked read; a busy/stale server can still refuse it. There is no
automatic retry, arbitrary delay window, source recapture, or unbounded queue.
Unrelated existing report autosave/other tabs remain independent and may cause
a genuine CAS conflict; they are never overwritten silently.

## Save Everything and finalization integration

The eventual report mount must register this host's target-bound controls.
Before readiness/signing, call `setReadOnly(true)` and await `flush()`. A false
result means Save Everything/finalization must not claim all changes were saved.
Release read-only mode if finalization fails. A flush succeeds only for the
same live owner with settled operations, no failed last action, no unresolved
recovery, and no pending capture. It is not report acceptance or signing.

Do not key the component on section revision, `updated_at`, transient save state
or object identity. Key only account/file/session identity; context changes are
owned by the lifecycle and inner workspace. An unrelated hydration/autosave echo
must not reset selections. A real file/session change disposes the old owner;
late responses from it cannot update the new workspace.

Request progress and paused editing are separate states. Only an outstanding
owned request says it is saving. A failed/uncertain update says to reload, a
durable pending capture says to resume, and finalization says read-only. A failed
fresh read stays latched even if the previous lifecycle was ready: it cannot
display a saved-success label or accept another selection/capture until recovery.

## Reporting boundary

The entire exploration host/view is excluded from printing. The accepted
`neighborhood_assessment` group, its outline/statistics, immutable acceptance
and signed PDF remain unchanged. An observation preview is not historical
eligibility, a legal subdivision, predominant-value determination, reliability
score or report-ready recommendation. Connecting supported evidence to the
existing assessment/atomic Apply pipeline remains outstanding.

## Verification

The lifecycle, section transport, checked API and request lane have dedicated
tests. Rendered component tests exercise the real lifecycle/API/transport/lane
with synthetic HTTP and a controlled child view, including empty reopen,
uncertain acknowledgements, CAS, flush, file/session changes and StrictMode.
Controlled workspace tests independently exercise its real preview controller.
Neither is a production login/database/map-accuracy test. Browser fixtures use
the actual map component with synthetic geometry and explicitly separate those
results from the native PostgreSQL checkpoint evidence.

The synthetic real-browser pass verified 18 accounts / 38 transactions initially,
12 / 26 after excluding Pine Grove, exact exclusion and empty-selection restore,
lost-ack recovery, a refused conflicting revision, same-UUID pending-capture
recovery, session reopening, independent 4 / 8 pocket inspection, and removal of
editing after a fresh signed-status read. No unhandled browser errors occurred.
It identified the misleading persistent saving label addressed above. Fixture
HTTP storage is process memory, not native persistence or production acceptance.
