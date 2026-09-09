# Custom workspace lifecycle controller

`dcad-frontend/src/features/neighborhood/customWorkspaceLifecycle.ts` is a pure,
injected controller. It does not mount React, fetch, change authentication or
source policy, enable Apply, or touch accepted neighborhood/report values.

`createCustomWorkspaceLifecycle` accepts one immutable
`target:{accountId,assignmentFileId,sessionKey}`, the initial workfile **section**,
`save`, `capture`, `catalog`, and `onChange`. Optional `operationId`, `now`, `timer`
and `timeoutMs` dependencies support bounded testing; each logical operation has
a finite timeout (default/max 180 seconds). All adapters receive the operation's
`{signal,deadline}`; deadline is local monotonic time, not a server timestamp or
evidence date. Adapters must honor cancellation and use the existing authenticated
transport. The controller preserves int64 assignment IDs as exact strings.

- `save({target,sectionKey,value,expectedRevision}, options)` returns
  `{accountId,assignmentFileId,section}`. The adapter must validate/normalize the
  actual response identity losslessly; the controller requires exact strings,
  the expected next section revision and the exact validated saved value.
- `capture({target,operationId,observationPeriod}, options)` returns the actual
  registered coordinator response. Capture has no response target; request
  ownership, matching `context_id === operationId`, and subsequent exact catalog
  target/context admission jointly bind it.
- `catalog(previewInput, options)` returns the actual raw catalog response.
  Existing catalog admission verifies the request's account/file/context/revision.
  Catalog requests use an empty analytical selection, never latest-context lookup.

## Methods and ordering

`reopen()` loads only the saved active context's authorized catalog and restores
its exact selected group IDs. Missing initial section is idle; present malformed
data is invalid and cannot default to all groups.

`start(period)` first saves a pending operation by the current **section** revision,
then captures, then validates the returned context's catalog, then saves an active
checkpoint with all catalog groups deliberately selected. The previous active
checkpoint remains saved until that final write. Existing pending intent cannot
be silently replaced. `resumePending()` repeats the exact pending UUID/period;
there are no automatic retries or manufactured replacement operations.

`setGroups(ids)` validates every ID against the checked catalog and saves the
exact intent with section CAS and a separate incremented selection revision.
`[]` stays empty. It never persists roster rows, geometry, statistics or receipts.

`reload({target,section})` is explicit recovery after a host-owned **fresh,
current-generation, target/session-bound** workfile read. A bare `undefined`,
missing `section` property or wrong target is rejected. A confirmed absent section
is represented by an explicit `section:undefined` property in that envelope. The
pure controller cannot prove a caller's network-read provenance; a host must not
feed it old cached starting state to clear an uncertain outcome. The locally
attempted pending UUID survives an uncertain pending-save acknowledgment, even
after a fresh absent read: explicit retry re-saves that same pending UUID before
capture. Such a reload exposes `pending_save_unconfirmed` with `resume_pending`
recovery, not a misleading new-workspace state. Active-save uncertainty requires
reload, not blind recapture.

Every failed save/acknowledgment requires reload. Failed capture or captured-
catalog load allows explicit same-operation resume; active-catalog failure allows
explicit reopen. Revision conflicts preserve the confirmed checkpoint and never
blindly retry a write. Returned errors are bounded codes, not adapter error text.

## Host operation lane and disposal

Actions serialize through one lane; calls while busy reject rather than queue
possibly stale writes. Normal action promises resolve after the owned sequence
settles. State exposes `operation_pending` and `isSettled()` covers both the logical
action and its underlying I/O. If an adapter ignores timeout cancellation, the
logical action rejects promptly, but pending stays true until that actual promise
settles. It cannot trigger a late catalog/save or restore success; `onChange`
signals eventual settled completion without retrying anything.

The future host must coalesce rapid user selection intent or disable controls;
it must not silently drop a rejected busy selection. It must also serialize its
preview/inspection requests with this lane: existing coordinator final checks
take NOWAIT assignment/workfile locks. This controller cannot stop unrelated
requests launched by the currently independent workspace component. Save
Everything/finalize must flush that owned lane or explicitly report pending
exploration, separately from ordinary report autosave.

`dispose()` aborts the operation and suppresses all subsequent callbacks. Create
a new owner for any file/account/session change. Host must gate signed/archived
workfiles and enforce its existing access/readiness state; a standalone checkpoint
section does not contain file status and is never an authorization grant.

Ready state provides the checkpoint, checked catalog and exact reconstructed
selection for a future controlled workspace host. This slice adds no production
mount. Focused test: `node --experimental-strip-types --test
scripts/testCustomWorkspaceLifecycle.mjs` from `dcad-frontend`.
