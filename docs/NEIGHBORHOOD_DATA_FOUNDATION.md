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

## Queue identity and recovery

- `enqueue(scope, request)` deduplicates immutable work by assessment and input signature. Same signature with changed request content is a conflict.
- The head's `requested_job_id` is the latest user intent. A → B → A reuses A but restores that intent; an already completed A can become current without another calculation. `request_generation` records intent ordering, while the job's generation remains its immutable creation order.
- `claim` uses bounded `FOR UPDATE SKIP LOCKED` selection, a **fresh token for each attempt**, and a lease. Every heartbeat, failure, and publication update checks job ID, token, attempt, running status, and `clock_timestamp()` expiry.
- Stale work may not overwrite a newer requested result. A still-valid older job may publish its immutable historical revision, but cannot become current unless that exact job is requested again.
- Retries are bounded. Re-enqueueing identical cancelled/failed/exhausted work returns its explicit terminal state and does not reset attempts. An explicit administrative restart policy is a future task, not an implicit infinite retry loop.
- A failed pending request leaves the last good published revision intact. The consumer must show its saved/current state together with the requested job's status; it must not describe old evidence as a completed new run.
- The job trigger deliberately does not lock the immutable head after locking a job. That would invert publication's head-before-job lock order. Canonical parent integrity checks remain in place.

## Cached and research inputs

`cachedRecords.js` is a pure adapter, not a county-coverage certification or live matcher. Source descriptors distinguish absent, present-empty, populated, and truncated query envelopes. Unknown housing eligibility remains incomplete; geographic same-subdivision visibility cannot turn the wrong housing type into an eligible sale. Future outcomes, unresolved parcel links, conflicting canonical transactions, and unsupported historical characteristics do not silently enter the statistics.

`sourceObservations.js` captures explicit registry-mapped research observations. Builder, developer, contractor, seller, owner, HOA, and manager remain separate roles. Sparse replays cannot overwrite prior rich evidence; corrections are new observations. Zero/false, blank, absent, and not-retained fields remain different. The registry names local concepts, not guessed MLS/provider field definitions. No observation resolves an entity, certifies HOA membership, infers a builder premium, or approves a report conclusion.

Assignment-selected projections of public records are still assignment-scoped evidence. Keep upstream raw hashes/visibility separate from normalized capture hashes/visibility. Source identity and correction references must be authorized before persistence; the hash is not an authorization token.

## Application transactions

UAD owns its existing transaction: exact workfile/report lock order, authorization, immutable/signed-state rejection, current identity/revision, catalog and coherent-group validation, every field/entity write, one accepted UAD revision, audit, and receipt. Persistence helpers use that same client and never commit independently. An attachment and its full mapped suggestions are immutable; same-key/different-content is a conflict. Receipt lookup never substitutes a latest report or falls back by account/address.

**Custom application remains gated:** Custom currently has independent section revisions, not a coherent whole-file content revision. `report_files.registry_revision` is not a substitute. Do not enable acceptance until its owner provides a correct concurrency token and atomic section write strategy, with parity and conflict tests.

## Migration and verification gates

The additive `20261010_neighborhood_assessment_persistence.sql` is registered in the existing application/mobile manifest. Existing migrations/checksums are unchanged. It creates only neighborhood-owned tables/functions/triggers/indexes, requires canonical identity tables, and has no GIS/provider dependencies. No implicit migration runs occur on report reads. Canonical scope is revalidated on use because a child-only migration cannot permanently prevent later changes to parent records.

Pure and injected-client tests prove normalization, digest binding, bounded requests, and transaction orchestration—not PostgreSQL concurrency. The separate guarded integration suite runs only with `NODE_ENV=test`, a loopback connection, and a dedicated `_test` database. Required acceptance includes migration rerun, missing required identity, absent/empty/populated optional sources, exact scope, immutable publication, two-client claim/heartbeat/publication/cancellation races, expired final-fence rollback, and out-of-order intent. Ordinary protected CI must pass before handoff. Passing CI does not override the security task's merge/deployment hold.

Still required before feature completion: real source inventories and mapping registries, scheduled worker wiring, PostGIS topology/overlap validation, bounded performance measurements, Custom/UAD consumer integration, provider licensing/coverage checks, and appraiser pilot testing. No live accuracy or speed claim follows from synthetic fixtures alone.
