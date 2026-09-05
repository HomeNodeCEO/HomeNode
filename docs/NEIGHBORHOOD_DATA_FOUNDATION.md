# Neighborhood data foundation

This additive layer follows the accepted v1 contract at `2d591e46eeff31dfeb263f99f0b2177d3633a61d` (PR #611). It does not replace the contract, activate a provider, start a worker, expose a route, or apply a report field. It requires the existing workflow's organization, assignment, editor, and signing guards.

## Evidence and publication

`assessmentRepository.js` receives an injected database pool. Reads never create tables, queue work, or fetch providers. A published revision is immutable and contains the geographic boundary, population/statistical summary, frozen source snapshots, and exact member rows. The current pointer changes only after a complete publication transaction; incomplete/unsupported evidence retains its explicit status.

Before enqueueing, the worker preparation phase must:

1. Capture authorized, versioned input sources and an explicit effective date/cutoff.
2. Normalize population members into `{ population_id, member_id, member_unit, account_ids, member_data }`. Every member has its real parcel links; member source references must belong to its population's declared source dependencies.
3. For **each population**, include one source payload with `capture_type: "neighborhood_population_members_v1"`, the exact `population_id` and `member_unit`, and `member_content_sha256` computed by `neighborhoodMemberContentDigest` over that population's normalized rows. Add the capture source to the population's source references. Supply real capture metadata; never invent source dates or historical support.
4. Bind these source payload hashes into the assessment before obtaining its input signature and calling `enqueue`. Adding captures only during publication would change the queued input identity and is rejected.

The member-content digest includes stored facts, links, and source references; the member-set digest separately describes exact IDs. This prevents a price/GLA change from silently retaining the original evidence identity. The population capture source itself is not recursively inserted into member-level references. Source JSON hashes identify the retained canonical JSON, not unavailable original provider bytes.

Publication validates source hashes, exact membership counts/units/link counts, source dependency closure, and both member digests. It then locks the assessment head and the active job, writes a staging revision and its children, validates publication, advances the current pointer when appropriate, and finishes the job. A lost final claim rolls back **all** writes. Member inserts are bounded by both row count and serialized bytes; no member is dropped to fit a batch.

The evidence contract's compact canonical JSON ceiling remains 1,500,000 bytes. PostgreSQL `jsonb::text` is a different representation: it adds spaces and expands exponent-form numbers. The new storage preflight separately limits that representation to 2,000,000 bytes, rejects incompatible NUL/unpaired-surrogate text, and counts numeric expansion without allocating it. The SQL ceiling is a matching backstop, not a replacement hash format. Oversized expanded payloads fail before publication/request transactions, without silently dropping data.

## Queue identity and recovery

- `enqueue(scope, request)` requires a caller-retained UUID `operation_id` and deduplicates immutable computation by assessment and input signature. Same signature with changed request content is a conflict. A transport retry must retain its operation ID; only a fresh, intentional selection receives a new ID.
- An immutable request ledger separates command identity from computation identity. Replaying an accepted operation returns its original job/reuse/intent-generation outcome and current job status without changing the requested job or current revision. The same operation with different content conflicts.
- The head's `requested_job_id` is the latest user intent. A fresh A → B → A command reuses A but restores that intent; an already completed A can become current without another calculation. Every fresh command advances `request_generation`, even when it selects the same job. The job's generation remains its immutable creation order.
- `claim` uses bounded `FOR UPDATE SKIP LOCKED` selection, a **fresh token for each attempt**, and a lease. Every heartbeat, failure, and publication update checks job ID, token, attempt, running status, and `clock_timestamp()` expiry.
- Stale work may not overwrite a newer requested result. A still-valid older job may publish its immutable historical revision, but cannot become current unless that exact job is requested again.
- Retries are bounded. Re-enqueueing identical cancelled/failed/exhausted work returns its explicit terminal state and does not reset attempts. An explicit administrative restart policy is a future task, not an implicit infinite retry loop.
- `cancel(scope, jobId, { expected_request_generation })` cancels the shared computation only when both job and generation are still the current intent. A delayed cancellation from an earlier A selection cannot cancel a later return to A. A mismatched generation is an explicit conflict, not an implicit administrative cancellation.
- A failed pending request leaves the last good published revision intact. The consumer must show its saved/current state together with the requested job's status; it must not describe old evidence as a completed new run.
- The job trigger deliberately does not lock the immutable head after locking a job. That would invert publication's head-before-job lock order. Canonical parent integrity checks remain in place.

## Cached and research inputs

`cachedRecords.js` is a pure adapter, not a county-coverage certification or live matcher. Source descriptors distinguish absent, present-empty, populated, and truncated query envelopes. Unknown housing eligibility remains incomplete; geographic same-subdivision visibility cannot turn the wrong housing type into an eligible sale. Future outcomes, unresolved parcel links, conflicting canonical transactions, and unsupported historical characteristics do not silently enter the statistics.

Complete query envelopes do not certify complete canonical-transaction parcel membership: a selected-account query may omit co-parcels. The adapter requires an explicit full-membership declaration or consistent full-transaction count, and an explicit incomplete flag always withholds the transaction. Unknown record kinds remain incomplete; only the local supported `listing` kind is a known non-sale exclusion. Duplicate canonical representations are reconciled before these eligibility filters.

`sourceObservations.js` captures explicit registry-mapped research observations. Builder, developer, contractor, seller, owner, HOA, and manager remain separate roles. Sparse replays cannot overwrite prior rich evidence; corrections are new observations. Zero/false, blank, absent, and not-retained fields remain different. The registry names local concepts, not guessed MLS/provider field definitions. No observation resolves an entity, certifies HOA membership, infers a builder premium, or approves a report conclusion.

Assignment-selected projections of public records are still assignment-scoped evidence. Keep upstream raw hashes/visibility separate from normalized capture hashes/visibility. Source identity and correction references must be authorized before persistence; the hash is not an authorization token.

## Application transactions

UAD owns its existing transaction: exact workfile/report lock order, authorization, immutable/signed-state rejection, current identity/revision, catalog and coherent-group validation, every field/entity write, one accepted UAD revision, audit, and receipt. Persistence helpers use that same client and never commit independently. An attachment and its full mapped suggestions are immutable; same-key/different-content is a conflict. A stable attachment identity is anchored to one organization/report/workflow/account/case/subject snapshot across revisions, while later evidence/assessment revisions remain possible. Receipt lookup never substitutes a latest report or falls back by account/address.

The helpers in `applicationRepository.js` require a checked-out `pg.PoolClient` (including its `release` method, which only the owner calls). `persistNeighborhoodAttachment` stores the complete `mappedSuggestions` array and verifies `neighborhoodMappedManifestDigest`; a receipt's shortened applied/reused rows are not enough to reconstruct the mapper manifest. Exact reads require organization, report registry, workflow, workflow target, and attachment identity/revision or application identity as appropriate.

For UAD acceptance, allocate the new `appraisal.uad_revisions` row and build the receipt before inserting the audit. The agreed audit event is `uad_neighborhood_assessment.applied`, entity type `uad_neighborhood_application`, entity ID the server-generated operation UUID. Its workfile/actor must match the locked target and authenticated actor. Metadata binds operation UUID, UAD revision UUID/number, application identity, receipt digest, mapper digest, and prepared-values digest. After-data binds attachment/assessment/group IDs and revisions plus duplicate-free applied/reused suggestion IDs. `recordNeighborhoodApplicationAcceptance` verifies these exact links and the original immutable mapping before persisting the receipt. Any mismatch must cause the owner to roll back values, revision, audit, and receipt together. No independent transaction or signing authority is introduced.

**Custom application remains gated:** Custom currently has independent section revisions, not a coherent whole-file content revision. `report_files.registry_revision` is not a substitute. Do not enable acceptance until its owner provides a correct concurrency token and atomic section write strategy, with parity and conflict tests.

## Migration and verification gates

The additive `20261010_neighborhood_assessment_persistence.sql` is registered in the existing application/mobile manifest. Existing migrations/checksums are unchanged. It creates only neighborhood-owned tables/functions/triggers/indexes, requires canonical identity tables, and has no GIS/provider dependencies. No implicit migration runs occur on report reads. Canonical scope is revalidated on use because a child-only migration cannot permanently prevent later changes to parent records.

Pure and injected-client tests prove normalization, digest binding, bounded requests, and transaction orchestration—not PostgreSQL concurrency. The guarded integration suite runs only inside the existing ephemeral GitHub Actions PostgreSQL job, with explicit test mode and a verified loopback `_test` parent. It creates one uniquely named test-only database using the existing canonical CI preparation/migration scripts. It never inserts neighborhood fixtures into the parent database used by the later staging safeguard, and never drops or cleans a shared database. The extra database is left to the ephemeral container's normal teardown; there is no fallback to the parent if isolation fails.

Required acceptance includes migration rerun, missing required identity, absent/empty/populated optional sources, exact scope, immutable publication, two-client claim/heartbeat/publication/cancellation races, expired final-fence rollback, old-operation replay versus deliberate new selection, attachment identity races, and actual UAD field/entity/revision/audit/receipt atomicity. Ordinary protected CI must pass before handoff. Passing CI does not override the security task's merge/deployment hold.

Still required before feature completion: real source inventories and mapping registries, scheduled worker wiring, PostGIS topology/overlap validation, bounded performance measurements, Custom/UAD consumer integration, provider licensing/coverage checks, and appraiser pilot testing. No live accuracy or speed claim follows from synthetic fixtures alone.
