# NeighborhoodAssessment v1 — shared Foundation / UAD contract candidate

Status: acceptance candidate, not frozen or connected to a production route. Runtime schema lives in `server/src/services/neighborhoodAssessment/contract.js`. Consumer acceptance and the coordinated integration/security/pilot gates remain required.

## Entry points and replay fixtures

- `buildNeighborhoodAssessment(input)`: strict, pure runtime schema validation, deterministic input/evidence identities, immutable output.
- `buildNeighborhoodAttachment(assessment, serverResolvedTarget)`: separate report-specific identity/revision binding; does not authorize or apply anything.
- `neighborhoodMappedManifestDigest(serverSuggestions)` and `prepareNeighborhoodApplicationGroup(...)`: canonical mapped-manifest identity and pure all-or-nothing preflight. `buildNeighborhoodApplicationReceipt(prepared, acceptedEditorRevision)` constructs the receipt the owner must persist inside the successful application transaction; constructing it alone does not prove a save.
- `server/test/fixtures/neighborhoodAssessmentFixture.js`: synthetic assessment and exact target fixtures, usable without services by both workflows.
- `node server/scripts/exportNeighborhoodAssessmentFixtures.js`: prints portable JSON containing the built core, Custom attachment, UAD-only attachment, and fixture input. It does not read environment variables, create a database, contact providers, or write files.
- Focused executable oracles: `server/test/neighborhoodAssessment{Contract,ApplicationGroup,Statistics,CellGraph}.test.js`.

## Four distinct objects

| Object | Meaning |
| --- | --- |
| `discovery` | Requested broad search envelope and completeness, not a reported neighborhood conclusion |
| `geographic_neighborhood` | Connected descriptive polygon, source-only perimeter and trusted spatial validation; supports actual land-use accounting |
| `populations` | Exact named stock, transaction, allocated-property-sale or listing members, including disconnected competitive pockets |
| Selected comparables | Separate appraiser selection; never implied by neighborhood membership |

The immutable core belongs to `scope.organization_id`, `scope.appraisal_case_id`, `scope.subject_snapshot_id`, and `scope.account_id`. It contains no target report or private target review decisions. UAD-only generation has no Custom assignment prerequisite. Same-assignment Custom/UAD targets can share the exact core and digest. Another assignment or organization cannot silently reuse private evidence or overrides.

## Time, input identity and source records

`effective_date` and `data_cutoff` are explicit date-only values. No wall-clock default. `observation_period` and each population declare start, end and date basis. Construction year and calendar-year age are separate measures. Historical sale $/sf requires supported GLA at sale; current GLA is not a silent substitute.

Each source snapshot has stable ID/revision, provider, content hash, visibility/scope, `valid_from`/`valid_to`, `observed_at`, and historical availability (`contemporaneous`, `reconstructed`, `unknown`). Retrieval after the effective date is permitted for reconstructed historical evidence; future-valid or historically unsupported facts cannot establish a ready historical result. Optional unresolved builder research does not block independently supported market data.

The request identity includes subject facts (including GLA), assignment/date/cutoff, methodology/configuration/geometry version, source revisions, discovery and selected pockets/overrides. Set-like IDs are normalized; perimeter traversal order is meaningful. Producers normalize measurements to declared numeric units before hashing. Reversing a source line or resampling equivalent geometry is an upstream topology-normalization concern, not justification for mutating an accepted revision.

`input_signature_sha256` identifies the normalized request. `evidence_digest_sha256` additionally binds immutable assessment ID/revision, outputs, memberships and application group. Generation time is excluded so retrieval time cannot invalidate an unchanged analysis. Neither digest replaces signing HMACs, report revision checks or authorization.

## Exact populations and supported measures

Populations carry ID/revision, kind, member unit, exact member-set digest, member resource ID, member/unique-property/property-link counts, period, completeness, reasons and source references. The initial response is a bounded summary: members remain a separate authorized paged resource. Empty known populations differ from unknown coverage. A subset requiring a different denominator needs a separate named population, not an undocumented shortened array.

The runtime `NEIGHBORHOOD_MEASUREMENTS` is the vocabulary authority. Measurement, unit, estimator and denominator basis must agree. Required ready statistics have explicit observed/missing/denominator counts and applicable source support. Available estimators distinguish exact median/quantile, mean, count, ratio and a declared modal interval; unsupported predominant or market trend estimates remain unsupported. Assessed values require tax-year identity and never masquerade as sale prices.

The statistics kernel keeps canonical transaction volume separate from distinct sold-property coverage. Verified multi-parcel price allocations are separate from unallocated package prices; package amounts are not repeated as individual dwelling prices. Tax-year coverage uses every selected stock member. Repartitioning the same transactions into display pockets does not change their exact pooled median. Low price dispersion is not proof of representativeness or appreciation.

## Coherent application — required in both consumers

`application_group` has stable ID/revision, `application_mode: atomic`, geometry revision/hash, population revisions/member digests, required statistic IDs, source refs, effective date/cutoff and report-eligibility status. `ready` is necessary, not sufficient: the workflow must also pass its existing permissions, signed-state, concurrency, catalog and relevant cross-field gates.

The producer declares `required_population_ids` explicitly. Duplicate/unknown IDs are rejected, and the population of every required statistic must be included. Group population references and readiness use only this dependency set. Group source references are the exact union of perimeter, required population and required statistic sources. An unused exploratory population or unresolved builder/amenity source remains available for review without becoming a mandatory mapper dependency or blocking a supported market group.

The server resolves the exact report registry UUID and exact workflow ID (numeric Custom assignment or UAD workfile UUID), organization, case, snapshot, effective date and cutoff. The attachment binds these identities, assessment/group hashes, attachment/editor revisions, mapper version, pinned UAD specification release and the canonical FULL mapped-suggestion manifest. Report-file UUID and UAD workfile UUID are never substitutes. A caller cannot declare the authoritative group, target mapping or source selection.

`application_identity_sha256` binds that same evidence and exact target, including the stable attachment ID, source digest and mapped manifest; only mutable editor and attachment revisions are excluded. `binding_digest_sha256` still includes both revisions and the application identity. The shared evidence digest is intentionally reusable between authorized same-case workflows; target application provenance is not.

`source_digest_sha256` fingerprints the versioned evidence/mapper inputs, not a whole mutable target workfile containing the applied output fields. The owner's self-save must not change that source digest; genuine source changes must. Editor concurrency and current value/provenance checks separately detect target edits. Receipt validation reconstructs the original binding using its saved base editor and attachment revisions rather than trusting an arbitrary historical hash.

Format-specific mapped suggestions use stable canonical IDs/target keys, values, dependency IDs, `application_group_id`, and semantic `evidence_refs`: `geographic_neighborhood`, `statistic:<id>`, `population:<id>`, and `source:<id>`. The complete mapper-produced manifest is independently bound in the attachment. The UI cannot prune a boundary/source/statistic and retain only convenient fields. Required semantic evidence coverage is validated in addition to the exact manifest hash.

Before any write, the target owner locks/resolves the current authorized target, recreates its expected binding, and supplies `current_application_identity_sha256`, `current_editor_revision`, and `expected_binding_digest` from that current state. These values and `accepted_application` must not come from the request body. The owner looks up a persisted accepted receipt for the exact stable application identity. Preflight checks this receipt before ordinary stale-binding rejection, because the successful first save advances the editor revision itself. A receipt can replay only if its accepted editor revision equals the current editor revision, its exact manifest/target provenance still matches, and every current value and its provenance remain intact. The replay returns the original acceptance manifest and zero writes. Any later edit, even to an unrelated report field, requires conflict/review. Without a receipt, full current binding/editor checks apply; matching text/provenance alone is not proof of an accepted application.

Reject the WHOLE selected atomic operation for duplicate IDs/targets, missing dependencies/targets, changed date/source/attachment/spec/editor revision, incompatible existing values, missing source entities, catalog bounds or relevant cross-field violations. A request mixing atomic and independent suggestions must reject transaction-wide when an atomic group fails; unrelated unfinished sections need not be complete.

Identical existing text is reusable only with compatible assessment/group/population/source and exact target-application provenance (report registration, workflow/workfile, stable attachment, mapper manifest and source digest). Preserve incompatible manual values and expose a conflict; no automatic replacement path. Accepted revision/audit records must persist the complete manifest of applied AND reused targets, provenance, original binding/attachment/base editor revision, exact prepared-values digest and newly accepted editor revision. The receipt digest detects accidental corruption, not authenticity: only trusted owner persistence establishes acceptance. New research creates a new proposal; it cannot mutate signed/exported or previously accepted evidence.

The pure preflight's `writes` are a PLAN, not executed writes. Authorized workflow adapters retain ownership of transaction locks, complete-group catalog/cross-field validation, revision persistence, audit events, and immutable signing/history. Existing legacy partial-skip apply behavior must not be used for atomic neighborhood groups.

## Geometry trust and limitations

The cell graph kernel uses only supplied verified shared edges and reports unknown/truncated input. It preserves separate competitive components and never draws fabricated connectors. Its `ready` means graph-selection completion only: `geometry` remains null and `geometry_validity` remains `not_evaluated`.

The contract validates bounded polygon coordinate/ring structure and a connected cited perimeter; it does not perform PostGIS topology proof. Trusted preprocessing must node source linework, dissolve selected cells, verify geometry validity/connectivity/subject containment, retain source provenance and atomically publish the validated revision. Travel graph connectivity, overpasses and access rights remain separate from planar boundary geometry. Manual drawing stays available when a supported enclosure cannot be produced.

No route, GET side effect, schema migration, provider, worker/scheduler, feature flag, frontend consumer or live data has been activated by this contract slice. Actual parcel/source coverage, land-use overlap partitioning, builder/HOA evidence, durable publication, UAD/Custom application, production latency and appraiser acceptance remain integration/pilot work. Synthetic tests are not a production accuracy certificate.
