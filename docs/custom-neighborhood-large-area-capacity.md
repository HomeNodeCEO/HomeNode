# Complete larger-area Custom neighborhood studies

## Current boundary

The installed capture mode is bounded, not sampled. A study that exceeds an
account, byte, geometry, work, or time ceiling is refused as a whole. Its previous
saved study and accepted boundary/statistics group must remain unchanged.
Single-pass city acquisition improves query work within these bounds; it does
not certify that any particular city or five/ten-mile study fits.

Increasing one limit is unsafe because the same complete study passes through
several independent boundaries:

| Boundary | Current constraints that affect larger complete studies |
| --- | --- |
| Spatial membership | 50k accounts, 100k parcels; new compact16 MiB encoded /32 MiB expanded; legacy16 MiB; full arrays |
| Canonical roster/query evidence | One 1.5 MB JSON roster before page construction; 50k accounts |
| Read capability and transaction closure | 50k accounts; bounded capability lifetime and complete closure |
| Dense source acquisition | 200k records / 128 MB, including selected roster rows, CAD account rows, parcel rows, sales and links |
| Retained graph | 4k blobs / 12k references / 512 MB logical charges; reopen assembles arrays |
| Statistics | 50k accounts; 2m measurement / 500k member work; dense indexed output64 MB |
| Recorded-group catalog | 100k combined CAD account/parcel records; 1,024 groups; ~4 MB public response |
| Map | 500k coordinates, 24 MB GeoJSON, whole-map response27 MB |
| Browser selection | 50k accounts / 100k memberships / 3.9 MB request representation |
| Report publication | 100k combined members / 250k links / 32 MB members / 64 MB retained report |

These are data/operation-specific limits, not interchangeable grants. Missing
source rights, historical stock evidence, known sale prices, units, or housing
classification cannot be remedied by increasing capacity.

The lossless new-capture representation is documented in
`custom-neighborhood-spatial-encoding.md`. It removes repeated field names but
does not remove the full-roster/count/downstream limits described here.

## Implementation sequence

1. Preserve the existing protocol. Add a versioned page-oriented roster and
   evidence manifest with ordered streaming digests, exhaustive membership
   verification and immutable row lineage. Remove dependence on one giant
   roster string; do not call a prefix a complete study.
2. Process complete capture stages in a bounded durable job, with checkpointed
   operation identity, cancellation, timeout recovery and atomic final context
   registration. An unfinished job never replaces an accepted study. Existing
   request/organization/assignment rights still gate each operation.
3. Keep selections server-owned and refer to an exact selection revision/hash.
   Page catalogs, member inspection and geometry independently of the complete
   analytical population. Geometry tiles/pages must preserve the whole source
   geometry; visual simplification cannot become statistical membership.
4. Compute exact complete-population statistics using bounded passes or stored
   order statistics. Never average page medians or silently choose a target
   sale count. Combine overlapping pocket memberships as a true set union.
5. Version and validate publication/consumer budgets together. Continue to
   apply manual boundary, population identity, statistics and provenance as one
   coherent group. Reopening older captures must retain their original version
   and meanings; new capture data must not rewrite old accepted reports.

## Release acceptance

- Compare 3-mile results byte-for-byte with existing retained fixtures.
- Complete synthetic >50k, 5-mile, 10-mile and dated-city studies without
  discarded rows; explicitly disclose records lacking usable observations.
- Verify holes, islands, crossings, duplicate account parcels and overlapping
  groups; final member identities, not just counts, must match.
- Exercise exact caps and one-over, cancellation between pages, changed source
  snapshots, revoked permissions, stale selection, lost commit acknowledgment,
  retries, reload and atomic boundary/statistics Apply.
- Measure peak memory, SQL latency, event-loop responsiveness and HTTP payloads
  on realistic geometry/row sizes; do not infer production capacity from tiny
  rectangles or empty-sale fixtures.
- Prove map paging does not restrict statistics to the currently visible map.
- Preserve the genuine retrospective report; perform live Apply tests only on
  an explicitly designated QA draft. No signing/delivery assertion follows
  merely from successful neighborhood testing.

## Phase 1 streaming primitive (not live capture yet)

`cohortPagedRosterV2.js` stages ordered account pages and verifies the same
selection and query digests as the retained v1 contract without building a
single account-array preimage. It also verifies every original page and the
directory on reload. A 60,000-account test exceeds the old whole-document
ceiling, and tests reject missing, reordered, repeated, altered and cancelled
pages. `cohortPagedRosterV2Store.js` binds that verifier to the existing
organization-scoped immutable evidence-blob repository. It checks each storage
acknowledgment and reloads every original by hash and byte length. The caller
must supply a transaction-bound repository, roll back on any failure, and
commit only after the complete roster, source closure and authorization checks
succeed. This
primitive alone does **not** raise the live 50,000-account ceiling or grant
source access. The remaining capture, storage, statistics, map, and report
budgets in the table above remain enforced until subsequent phases land.

## Phase 2 job prerequisites (not a live job runner)

`customCohortJobActor.js` reloads the original actor's *current* active user,
organization membership, and roles from PostgreSQL. A future resumable capture
must use this current identity and the existing assignment and market-source
policy checks before each resumable operation and final registration. It must
not persist an old browser token or treat a queued job row as an authorization
grant. The additive `neighborhood_custom_cohort_capture_jobs` ledger and
`customCohortCaptureJobRepository.js` now provide an exact-request idempotency
key, bounded token-free request payload, fenced leases, retries, cancellation,
bounded checkpoint references, and a success transition that requires the
matching immutable context within the caller's transaction. Neither component
is a source authorization or a complete capture. A worker that performs and
resumes each capture phase, integrates paged evidence, rechecks current rights,
and wires the HTTP status/cancel flow is still required. The installed live
capture route and its 50,000-account limit are unchanged by this slice.

The next internal command surface admits a token-free job request only after
current Custom Appraisal assignment write access is checked. Status reads and
cancellation recheck exact organization/report/assignment/account scope and
current read/write access, respectively. This surface is intentionally not
mounted in HTTP until the stage worker exists; it cannot be mistaken for a
working asynchronous capture. Status responses omit checkpoint references and
internal source errors. A lost cancellation response can be retried against a
terminal job without altering its outcome.

The first worker pass is available through the separate
`maintenance:neighborhood-capture-jobs` command. It claims one due operation,
reloads the actor's *current* active membership/roles, polls cancellation and
renews a fenced lease, then invokes the existing bounded capture. The
capture coordinator reloads that database identity again in each subject,
source-read and registration transaction; worker-start roles are not reused
to authorize a later publication or a committed-context replay. The final
context registration and job success share a transaction; a lost lease or
cancellation rolls back that registration. A committed context whose response
was lost is replayed under current rights before the matching job is completed.
This worker is not yet scheduled or exposed through HTTP and still enforces the
installed 50,000-account ceiling. The remaining phase checkpoints, paged source
capture, larger-area statistics/map/publication contracts and live acceptance
must land before this path can serve a 5- or 10-mile study.

Short job-ledger and actor transactions use `customCohortJobTransaction.js`,
with a five-second checkout bound, six-second driver query bound, five-second
server statement timeout, one-second lock/rollback bounds and checked-out
socket-error ownership. Failed connections are discarded; an uncertain COMMIT
or post-COMMIT release is not described as a successful acknowledgment or a
known rollback. These short transactions do not replace the capture
coordinator's aggregate-budget, source-acquisition transaction owner. Neither
helper widens a source grant or makes a queued request eligible for publication.

The first durable stage checkpoint stores the original subject-stage intent
reference in the same transaction as its immutable subject evidence. A worker
retry reloads that exact intent, subject and recorded point after checking the
current actor and assignment. It refuses changed subject inputs, mismatched
operation/period/profiles, missing originals, cancellation or a lost claim;
it does not silently capture a replacement subject under the same operation.
Checkpoint reads/writes bind organization, report, assignment, account, original
actor, claim token, attempt and unexpired lease. A checkpoint does not renew the
lease or authorize source access. Source policy is checked again before any
new source acquisition and publication. Source/spatial/preparation paging and
their durable checkpoints are still outstanding; this subject-stage slice
does not remove the 50,000-account ceiling or activate the job HTTP flow.

A second worker checkpoint commits the **complete** validated original source,
spatial and preparation graph, its unregistered header and the fenced job
reference in one transaction. Registration is a separate fresh-authorized
transaction. A retry rechecks current assignment, actor and source rights before
loading the complete original graph; it does not rerun spatial/source queries or
mix in a later data sweep. Changed subject inputs or private CSV review, missing
originals, a changed policy, cancellation or a lost claim refuse publication.
Lost staging COMMIT acknowledgments are recovered by reading the actual fenced
checkpoint. A staged header is not a registered context, accepted study or
permission grant. This checkpoints only a whole bounded acquisition, not an
unfinished page stream. Source/spatial page-by-page recovery, >50k contracts,
server-owned selections and the remaining live acceptance still remain pending;
neither the public route nor installed capacity is changed by this slice.

## Phase 3 paged selection representation (not a live selection owner yet)

`cohortPagedGroupSelectionV1.js` stages complete original recorded-group
memberships and their exact deduplicated account union as independent immutable
pages. Scope, context, original catalog reference, selection revision and every
group's original ordered membership digest/count are bound in the metadata.
Reopening verifies every metadata, membership and union original and recomputes
the complete union. Missing, changed, duplicated or reordered membership is not
a shorter successful selection. Explicit empty selection stays empty. The union
digest matches the existing one-pocket preview identity byte-for-byte for
disjoint catalog groups; overlapping groups count an account only once.

The transaction-bound immutable store checks each acknowledgment and never
updates a current selection head, authorizes a source or publishes a report.
Its caller must derive metadata from the exact freshly authorized original
catalog, own cancellation/deadline and rollback, then atomically register the
selection revision with that context. Browser JSON cannot supply those originals.
A synthetic 90,000-account/120,000-membership test verifies overlap and original
reload; it is not production capacity or realistic geometry/load acceptance.
Live server-owned revision registration, group-only browser requests, paged
catalog/statistics/publication consumers and the greater-than-50k end-to-end
capture remain outstanding. Existing protocol versions and live limits stay
unchanged.

### Context-bound selection head storage (owner/HTTP still outstanding)

The additive `customCohortGroupSelectionRepository.js` stores immutable selection
revisions and one context-scoped current head, in the caller's transaction.
Every head/revision is bound to the exact organization/report/assignment/account
and retained context hash. Registration reopens the complete staged membership
and union originals, reads the original catalog reference, and serializes head
changes on that context. The owner must still derive group metadata from the
authorized original catalog and recheck current actor/assignment/source rights;
neither a stored head nor an integrity check is such a grant. A browser cannot
submit memberships, manifests or catalog evidence through a public endpoint.

The expected predecessor fences competing choices; exact lost-acknowledgment
retries reuse an operation only while that selection is still current. Old
replays never rewind a newer choice. Empty remains empty. The isolated database
fixture exercises competing transactions, rollback after head change,
cancellation, immutable history and complete original reopen. This storage
prerequisite is not yet wired to the live selection service, workspace saves,
preview/statistics consumers or Apply, and does not raise installed capacity.

Checkpoint and selection originals are retained after cancellation/failure.
There is no automatic deletion owner in these slices. Future cleanup must
enumerate all job/context/selection/accepted-report roots, preserve shared
immutable originals and honor the applicable retention policy before deleting
anything; job termination is not evidence that a blob is unreferenced.

### Original recorded-group selection bridge (not installed in the live owner)

`customCohortRecordedGroupSelection.js` derives the selection metadata and a
repeatable ordered membership stream from an owner-authorized JSON-encoded v3
catalog and its independently retained complete roster. Every group, including
unselected groups and unresolved membership, must match that roster exactly.
Existing v3 catalogs are partitions; overlap in this producer is refused rather
than silently given a new meaning. The generic paged selection contract still
supports explicitly versioned overlapping membership.

A small canonical original binds the complete catalog/roster digests, exact
scope/context and per-group ordered membership digests. Selected memberships
are retained separately in their complete original pages. A bounded heap merges
those ordered groups without flattening and sorting every membership into a
second giant array. Explicit empty selection remains empty, and the existing
disjoint-group selection hash is unchanged. A synthetic 60,000-account test
exercises many interleaved groups, and a 120,000-account fixture exceeds both
legacy whole-blob byte/node ceilings; neither is live capacity or load acceptance.

The original catalog identity is explicitly versioned. Retained v1 originals
keep their exact full read-model byte digests and are never rewritten or given
new semantics. New internal-owner selections use v2, which binds the sorted
complete independent roster and every group ID/count/ordered membership digest;
display labels, explanation text, presentation and JSON key/group/roster order
are not population identity. Full catalog completeness, scope/context, coverage,
partition and source-rights validation still apply before deriving either version.
The v2 roster digest is incremental and budget-checked, including the 120k fixture.
Reopening and exact current-head lost-ACK replay use the retained producer version.

The read-model inputs preserve their exact compact JSON round trip under a
separate four-megabyte ceiling. They are not forced through the legacy
1.5-megabyte/100k-node source-blob canonicalizer. Raw source evidence retains
its original existing validation and limits; this bridge does not bypass them.

The bridge does not read a source, authorize a request, save a workspace, move a
selection head or publish statistics. Its strings must come from freshly
authorized originals, never a browser body. An optional closed command original
binds the server-authenticated reviewer, operation, exact predecessor and sorted
group choices inside the same immutable catalog/selection graph. This retained
actor stamp is intent, not a current permission or statistical certification.

### Internal recorded-group selection owner (HTTP/consumers not activated)

`customCohortRecordedGroupSelectionOwner.js` supplies additive internal methods
on the existing Custom capture owner. Requests contain only context/group IDs,
an operation UUID and the exact expected prior selection reference. The owner
reloads current database roles and assignment access, then checks the original
shared/private source purposes before reading prepared catalog/roster facts or
original source pages. Shared prepared reads do not transfer parcel geometry;
private captures cannot silently use a shared-only cache. Complete membership,
command original, paged union and head update share one bounded transaction.
The workfile/assignment/batch lock order matches signing and private review.
Read owners take the workfile `FOR UPDATE NOWAIT` at that first parent lock
because their later subject-freshness fence requires the same mode. Read
permission stays read: this does not authorize a write or mutate the report.
Concurrent owner reads therefore refuse one competitor before source facts,
instead of both acquiring SHARE and failing a later NOWAIT lock upgrade.

Before commit/delivery the owner again checks current actor/assignment, subject
and source rights and the exact private CSV review when present. Reopening
re-derives metadata from the freshly authorized original catalog/roster and
verifies every retained membership/union original and the current head. Missing
originals, stale predecessors, changed operations or expired/revoked rights do
not become an empty or broader successful selection. Absent and explicitly
empty selections are distinct. Only selected IDs and their bounded reference
leave these methods; membership arrays, source rows and raw failure details do
not. Existing report/workspace/accepted sections and Apply remain unchanged.

This owner slice alone does not expose HTTP or install browser/statistics/map
consumers. Its guarded database tests require the disposable migrated CI
database; local unit/SQL-double passes are not a substitute for that run or live
load acceptance. Server-owned public commands, exact statistics/publication
consumers, partial acquisition-page recovery and greater-than-50k capture/load
acceptance remain outstanding. Existing installed source limits stay unchanged.

### ID-only HTTP and browser transport (not installed in the workspace UI)

The additive `select-groups` and `group-selection` POST commands are mounted
only when the coordinator supplies both fresh-authorized selection-owner
methods. Their bodies contain assignment/context identity and, for writes,
only the operation, exact predecessor and recorded-group IDs. They accept no
actor stamp, source row, catalog, parcel/member list or statistical input.
Both decoded request and response are capped at 262,144 UTF-8 bytes. The
existing authentication/CSRF composition, execution gate, cancellation and
one-minute operation budget remain in place. Compact output is independently
checked against the exact context/operation/revision/IDs; accidental extra
source fields or report-authority claims are not sent to the browser.

The matching browser transport uses the established authenticated request
helper, copies choices before awaiting, checks the returned receipt, and never
automatically retries a write or expands explicit empty choices. An absent
saved selection is distinct from a saved empty selection. Lost commit
acknowledgments preserve the original operation; stale choices return a conflict
instead of rewinding the current head. The disposable PostgreSQL fixture also
exercises these HTTP commands against the real owner, not only a mock service.

The workspace UI, preview/viewport/member consumers and report Apply still use
their existing protocol. This transport does not activate a second selection
owner in that UI or certify statistics. The next consumers must use the exact
server-owned selection reference, compute the whole selected population and
publish boundary/statistics/provenance coherently. Partial acquisition-page
recovery, greater-than-50k installed capture and live large-area acceptance
remain outstanding; production limits and genuine appraisal choices are not
changed by local transport tests.

### Exact-reference numeric summary (existing capacity)

`previewRecordedGroupSelection` accepts the exact retained context and current
server-owned selection reference, not replacement groups or member arrays. It
re-derives the original catalog/roster binding and verifies every membership and
deduplicated union original before the numeric projection sees any accounts.
An immutable account-page visitor is provisional owner-local work; if any later
original, manifest, budget or rights check fails there is no completed summary.
Absent, stale and explicitly empty selections keep their distinct meanings.

The summary uses the existing exact individual-observation kernel and selection
digest, not averages of group medians. Shared prepared tables avoid source/map
replay; private captures preserve their independently authorized original CSV
and exact review revision. Catalog **and** summary exposure rights are checked
before prepared/original facts and again before delivery, alongside current
database actor, assignment, subject and private-review fences in the same
bounded transaction. No geometry, accepted report or workfile section is changed.

This additive consumer retains the installed 50,000-account numeric
ceiling. It does not activate the workspace UI or claim larger-area
capacity, reliability, historical truth or report readiness. Complete paged
statistics beyond that ceiling, exact-reference viewport/member/Apply consumers,
partial capture-page recovery and live load acceptance remain required.

The optional `selection-preview` HTTP command exposes this read-only numeric
consumer when the coordinator provides it. Its closed request contains only
assignment/context identity and the exact current selection reference. It has
the same authentication/CSRF, finite execution gate and cancellation as the
other cohort routes. Missing/stale references never become all or empty choices.
The 262,144-byte request and intent receipt ceilings stay intact. Only this
numeric response has a 4,100,000-byte ceiling, covering the existing 2,000,000-byte
shared and 2MiB private public summaries plus the closed identity envelope.

Transport accepts only actual public presenter projections, with independently
checked target, context, revision, content digest and whole manifest reference.
Process-local projection witnesses are not source permission or report authority;
the current-role/original/source rights fences still execute before delivery.
Geometry, source/member arrays, raw rows and Apply are not admitted. The matching
browser helper verifies the same reference and reuses the existing bounded
shared/private summary checks via an explicit identity binding, without inventing
empty membership arrays. Legacy preview and map-restyling checks remain intact.

The native disposable database fixtures exercise empty/nonempty HTTP summaries,
stale references, injected members, current role and independent summary-purpose
refusal, and actual private CSV projection parity. These are CI assertions, not
live latency or greater-than-50k acceptance. The workspace UI still needs a
coherent exact-reference map/member/save/Apply integration before activation.

### Exact-reference display viewport (existing capacity)

`viewportRecordedGroupSelection` reopens the same complete current selection as
the numeric summary. Only after all membership/union originals and the exact
head verify does it load geometry. A viewport never changes the analytical
population, and a pan does not rerun the numeric kernel. Current actor,
assignment, original source, subject and private CSV review fences repeat before
delivery. Catalog and the existing viewport's summary exposure are both required.

Shared captures prefer the existing complete prepared tile manifest and only
the requested cells. Missing/unsupported tile windows keep the verified complete
prepared-map fallback; private captures preserve their original, independently
authorized source graph. Missing geometry remains unavailable. No hull, sampled
parcel, replacement source snapshot or viewport-limited statistical union is
substituted. The public display projection admits only the closed parcel fields
and exact retained coordinates, preserving the existing browser coordinate cap.
Its frozen public response is detached only after the existing byte and complete
visible-geometry checks, so it cannot freeze or retain mutable legacy identity,
feature or coordinate aliases. The legacy projection path remains unchanged.

The optional `selection-viewport` POST accepts only assignment/context identity,
the exact selection reference and finite viewport bounds. Its request retains
the 262,144-byte reference-only ceiling; its complete decoded response, including
the reference envelope, stays within the existing four-megabyte viewport ceiling.
Authentication/CSRF composition, the execution gate, no-store, cancellation and
the one-minute budget remain unchanged. Existing compression applies to this
new display route too; compressed bytes do not widen decoded capacity.

The browser helper binds the response to the accepted intent receipt, context,
revision, digest, whole manifest, target and requested viewport. Selected flags
must match the receipt's groups in the checked local catalog, not a fabricated
legacy member-array request. Missing/stale/unknown choices refuse, and a deliberate
empty choice keeps every visible parcel unselected. Legacy viewport validation
continues through the same closed geometry decoder. Neither transport activates
the workspace UI, saves an accepted report, changes installed source capacity or
proves live speed. Exact-reference member/workspace/Apply consumers, partial
page capture, >50k exact numeric studies and live acceptance still remain.

### Exact-reference member inspection (existing capacity)

`inspectRecordedGroupSelection` reopens the same complete original selection as
the summary and viewport before producing a member page. A cursor bounds
delivery, never the analytical union. Shared prepared indexed observations and
private retained observations use the existing individual-observation kernel and
closed member presenter; they do not transfer map geometry or raw source rows.
The new consumer inspects the `all` or `selected` populations for stock,
transactions, omitted transactions and source-record observations. Group-specific
detail remains on its existing catalog path; caller-defined pockets cannot be
injected into this route. An explicit empty selection remains an empty selected
page, not a restart at the whole study area.

Catalog and member exposures are independently authorized before any prepared
facts or original selection pages are opened and again before delivery. Current
database actor, assignment, subject and private CSV review fences remain in the
owning transaction. An intent receipt, original digest or prepared cache is not
source permission. The optional private aggregate additionally retains its own
initial/final summary-purpose grant; member permission alone cannot disclose it.
The page presenter retains an in-process receipt for its exact
limit and prior cursor; another genuine page, a serialized clone, or raw rows
cannot be substituted into the transport envelope.

The optional `selection-members` route accepts only assignment/context identity,
an exact current selection reference, a closed population descriptor and bounded
page request. The request remains capped at 262,144 bytes, each public page at
256,000 bytes and 50 members, and each optional private summary at its existing
2MiB ceiling. The complete decoded envelope is capped separately at 2,360,000
bytes. Neither declared nor compressed wire sizes widen these limits. Existing
authentication/CSRF, no-store, cancellation, execution gate and deadline remain
in place. No automatic retry or cursor reset is introduced.

The browser reuses the closed legacy member-page decoder through explicit
identity rather than fabricated legacy member arrays. Its expected total comes
from the checked summary; stock membership additionally matches the accepted
receipt's whole population in the checked catalog. Subsequent pages require the
actual checked page or compact continuation, as well as the same exact selection
reference. Foreign context, changed headers/private capture, totals, duplicates,
replayed cursors and unknown accounts refuse instead of replacing a population.
Legacy decoding and private-summary checks remain unchanged in meaning.

Small synthetic and disposable PostgreSQL assertions are not live capacity,
speed, historical-stock or report-readiness claims. The workspace UI remains on
its legacy path until exact-reference workspace save and coherent Apply are
implemented together. Partial source paging, complete >50k numeric studies and
realistic live acceptance remain separate unfinished roadmap items.

### Exact-reference workspace save (internal, not UI activation)

`selectAndSaveRecordedGroups` introduces an explicit owner transaction for the
selection head and workspace checkpoint. It freshly reloads the current actor,
assignment and source grants, locks the writable workfile before its assignment
and context, and verifies the saved study and expected workspace revision before
opening prepared catalog/roster facts. The complete original selection is staged
and reopened before a version-7 checkpoint is written through the existing
quota, revision-CAS and immutable-history writer. Cancellation, history failure
or a final source/current-role refusal rolls back pages, head, checkpoint and
history together. Nothing is saved to the accepted neighborhood section.

V7 contains only the exact context, period, retained discovery and selection
reference. It contains no parcel/member array, computed statistic, source grant,
or acceptance. V1-v6 canonical meanings and browser defaults remain unchanged;
there is no implicit upgrade. The new original command version 2 binds the
expected workspace section revision as well as its exact selection predecessor,
operation, current reviewer and group IDs. A lost COMMIT acknowledgment can reuse
only that exact operation while its exact checkpoint is the immediate saved
successor and the same selection remains current. Replay adds neither another
history row nor a new head and never rewinds later choices.

Ordinary/manual/autosave entry points cannot write V7, including through a
caller-supplied owner-looking field. Their locked stored-version check also
prevents an older browser from downgrading an existing V7 checkpoint. Independent
legacy head writes are refused once a file has V7, so the two cannot drift apart.
The dedicated internal transaction helper is a structural writer only, not an
authorization, registration or COMMIT capability. There is no new public route,
browser activation, source-capacity increase or live SLA in this slice.

Native assertions run only in a separate synthetic organization/actor/report
inside the existing migrated disposable database, preserving the coordinator's
independent cold-start checkpoint fixture: actual
post-section cancellation, history-write failure, final source/current-role
refusal, lost COMMIT acknowledgment, downgrade refusal, explicit empty selection
and two concurrent CAS operations. Accepted sections/receipts, report content and
assignment geography remain unchanged. These assertions must pass in CI before
merge; local recording doubles are not claimed as PostgreSQL proof. Coherent
exact-reference report proposal/Apply and its browser consumer still have to
land together before any genuine file transitions to V7. Partial source pages,
complete >50k numeric studies and realistic live acceptance remain unfinished.

## Exact-reference workspace proposal and coherent Apply (not browser activation)

V7 report proposal/Apply and reviewed-input preparation now share the same
original-selection verifier as the exact-reference numeric/map/member owners.
After reloading the actor's current database roles and separately checking
catalog and report/source purposes, the owner reconstructs the exact catalog
and independent roster from verified prepared facts or the retained originals.
It verifies the complete original command, metadata, membership and union pages
against the current reference before deriving any owner-local group IDs for
the existing report calculation kernels. A viewport or a member-page prefix
cannot become the analytical selection. Shared prepared facts do not stand in
for private CSV rights or their original review state.

The exact selection reference is also part of the proposal's immutable fences.
Before publication and before/after atomic Apply, the owner checks the current
head under the existing workfile-before-target/context lock order, alongside
the workspace/editor/boundary, current subject, source/private-review and report
policy fences. Current actor roles are reloaded again at these final fences.
The existing one-group boundary/population/statistics/provenance acceptance,
history and lost-COMMIT-acknowledgment replay remain the publication mechanism;
the new reference does not grant access or independently accept statistics.
V1-v6 fingerprints and current browser defaults remain unchanged.

An additional native test uses its own newly migrated disposable database and
an actual preselected effective day, real retained captures, two registered
selection originals, and an owner-saved V7 checkpoint. It exercises current-role
and independent catalog denial, post-write refusal, a changed current-head
pointer with identical workspace bytes, reviewed-input reopening, coherent
proposal/Apply and lost-acknowledgment replay without changing original evidence
or history. These assertions must pass actual CI; local SQL recording tests are
not PostgreSQL proof. This slice does not add a public atomic save route, switch
the browser, implement V7 context/period transitions, raise source/publication
capacity, schedule partial source capture or establish a production speed SLA.

## Exact-reference study transitions (internal, not browser activation)

`startRecordedGroupCapture` and `cancelRecordedGroupCapture` change only V7's
pending intent through the existing quota/CAS/history writer. They require an
exact prior checkpoint and section revision, freshly reload current database
actor/assignment write permission before and after the write, and retain the
workfile-before-assignment/context lock order and draft/signed protections.
The old active context and registered selection remain untouched. A scoped
metadata-only head check refuses a detached active selection; it opens no old
catalog/source facts and is not a license grant. An expired old source grant
does not prevent an authorized appraiser from setting aside unfinished intent.
Exact immediate-successor retries add no history and cannot rewind later edits.
For a genuinely new file, start may bootstrap revision zero only with explicit
empty V7 intent and an actually absent workspace row. A present/invalid/legacy
checkpoint cannot be overwritten by that bootstrap; no default population or
implicit upgrade is inferred. The same current-role, draft, quota and final
transaction fences apply to its initial pending write.

`completeRecordedGroupCapture` requires the new capture to be fully registered
and independently authorized. Its context UUID must equal the pending capture
operation, and its immutable observation period, discovery and optional private
CSV batch/review must exactly match that pending intent. It derives the explicit
chosen group IDs from that new study's complete catalog and independent roster,
then registers a fresh selection and replaces active/pending in one transaction.
No automatic recommendation, partial capture or viewport/member-page prefix is
substituted. On any failure the old active selection and pending study remain.
The existing current subject, final source/private-review, current actor and
workspace/history rollback fences still apply; no accepted report is changed.

New selection command version 3 binds the tiny exact prior V7 checkpoint and its
section revision, along with the operation, current reviewer and explicit group
IDs. It starts the new context's selection with a null predecessor. The shared
original verifier can reopen these receipts; v1/v2 command meanings and retained
v1/v2 catalog identity semantics are unchanged. An exact lost COMMIT
acknowledgment reuses only the current new head and immediate exact checkpoint
successor; it cannot erase a subsequent empty selection or replay changed study
intent under the same operation.

Additional native assertions run within the selection owner's separate
synthetic organization/report in the migrated disposable fixture. They perform
real old/new captures, start/cancel/complete writes, changed period/discovery/
private-purpose refusals, actual post-section cancellation/history failure,
initial/final role and source refusal, lost acknowledgments and v3 original
reopening. They retain the coordinator's cold-start assignment and accepted
sections, receipts, report and geography unchanged. These assertions must pass
actual CI; local recording doubles are not claimed as PostgreSQL proof.
An additional isolated report fixture bootstraps an actually absent V7
workspace, performs a second real start/capture/complete transition, and passes
its current command-v3 selection directly to reviewed
inputs, report proposal and coherent Apply/replay. The existing two-revision V7
fixture still checks actual stale-head swaps with identical checkpoint bytes;
the fresh one-revision transition case does not fabricate a predecessor for it.
Public save/transition HTTP routes and the complete V7 browser lifecycle are
still unactivated. Installed source/numerical limits, release policy, background
schedules and production speed claims are unchanged; partial source paging,
complete >50k studies and 5-/10-mile/retrospective live acceptance remain open.

## Opt-in atomic workspace HTTP and browser transport (not UI activation)

The dedicated cohort router can now explicitly opt into the four closed V7
commands: `save-groups`, `start-group-capture`, `cancel-group-capture`, and
`complete-group-capture`. The default is off, and opting in requires all four
actual owner methods. No production composition enables it in this slice. The
existing authenticated/CSRF mount, finite execution gate, disconnect signal,
int64 assignment identity and 262,144-byte decoded request/response ceilings
remain. Each route maps only middleware identity and admitted intent to the
same transaction owners; request roles, source rows, member arrays, accepted
statistics and generic section-writer capabilities are rejected.

Responses contain only a checked immediate workspace CAS successor and, for
save/completion, the same exact registered selection receipt. Active context and
selection references must agree; completion must preserve the exact pending
observation period/discovery and clear pending intent. Start/cancel retain the
exact prior active selection. Conflicts, current access denial, signed locks,
interruption and unknown COMMIT outcomes remain distinct sanitized responses.
Neither a receipt nor a pending operation establishes report authority.

The new browser transport uses existing authenticated cancellation-aware I/O,
closed action names and the same decoded byte ceilings. It admits immutable V7
references and the unchanged date/discovery/private-review component grammar,
checks the entire response against the request, and never allocates operations,
retries automatically or infers all groups. Its section reader distinguishes
actual absence from present corrupt/legacy/future data; old V1-v6 readers and
defaults stay unchanged and still do not silently activate/reset V7. Local
syntax/HTTP/transport doubles are not additional PostgreSQL proof. Actual owner
transactions and coherent report Apply remain covered by their separate migrated
native fixtures; full current-head CI must pass before merge.

The complete browser lifecycle and coherent public composition must land before
this opt-in is enabled. No genuine saved file, accepted report, source/numeric
capacity, background schedule, release policy or production SLA changes here.
Partial source-page recovery and realistic complete >50k/5-/10-mile/retrospective
acceptance remain unfinished.

## Opt-in browser lifecycle for atomic V7 selections (not activation)

`customCohortGroupWorkspaceLifecycle.ts` now owns the small V7 checkpoint and
exact current server selection receipt independently of the legacy V1–6 host.
It uses only the four atomic group-workspace commands for pending capture,
completion, cancellation and group changes. It does not save flattened account
arrays through the generic workfile writer. New-study completion retains the
old completed area until the server acknowledges the coherent new checkpoint
and selection head. Reopening verifies the current head against that exact
checkpoint before making its group IDs available to a consumer.

The owner requires an explicit initial-group policy; it does not silently
select all groups or infer a recommendation. Empty selection remains empty.
One file/session owns a finite, serial operation lane. A timed-out adapter that
ignores cancellation remains quarantined until it actually settles. Unknown
write acknowledgments require an authoritative current-file reload. If that
read still shows the exact predecessor, only the original immutable command
may be explicitly retried; a later checkpoint takes precedence and cannot be
rewound by the old intent. An acknowledged command followed by a failed catalog
read is reopened, not written again. Current roles, source rights, signed locks,
CAS, immutable membership and final report authority remain server-owned.

The existing production host, map/statistics/member/report consumers and legacy
readers are unchanged. Catalog display still uses the bounded installed v3
catalog, so this browser owner is not a paged greater-than-50k catalog or a live
capacity increase. Production composition must connect all V7 consumers and
the fresh section-read boundary as one coherent path before enabling the
opt-in HTTP routes. No schedule, deployment, genuine appraisal choice or
accepted report is changed by this slice.

## Opt-in V7 API composition ports (not a production host)

`customCohortGroupWorkspaceApi.ts` connects the independent V7 owner to current
authenticated boundaries. A fresh workfile GET returns only a checked V7 section,
its exact file/session target and actual draft/signed/archived status; present
legacy/corrupt/future data is refused rather than reset. The existing generic GET
still represents assignment IDs as safe JS numbers, so this adapter refuses an
unsafe int64 read instead of rounding it. Exact cohort command and projection
ports retain their independent int64-string grammar. No broader read contract is
claimed.

Only the four atomic mutation ports are exposed; there is no generic section
writer or uncoordinated `select-groups` mutation. Exact-reference numeric summary,
viewport and member ports reuse the retained-producer transport validation and
keep their original population/continuation and byte bounds. The viewport cannot
shrink the analytical population. Current authentication, access denial, signed
locks, workspace conflict, interruption and unknown COMMIT responses stay
sanitized and distinguishable, with no automatic retry. Existing capture/catalog
and proposal/Apply adapters are reused without changing their legacy behavior.

The production API/host remains unchanged. A complete V7 consumer composition
must still bind all map/statistics/member/report views to the same active receipt
and pass live acceptance before opting in. These ports do not remove full-catalog
membership bounds, activate durable job HTTP/scheduling, increase installed caps,
alter a genuine appraisal or establish an instant map SLA.

The worker CLI validates its database URL before constructing the pool and
requires certificate-verified TLS for every non-loopback host, including internal
hosts. Only literal localhost/127.0.0.1/::1 development connections may be
plaintext. Admitted TLS query options are stripped before pg receives the URL;
duplicate, conflicting, insecure remote, and driver-setting overrides are refused.
The runtime trust store must contain the provider's trusted certificate chain.
There is no fallback that disables verification, no raw driver error logging,
and no automatic worker schedule or production environment change from this fix.
