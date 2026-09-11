# Custom neighborhood workspace checkpoint v1

**Current compatibility note:** this document specifies the preserved v1
format. New dense catalogs use checkpoint v5 (1,024 named groups plus unresolved,
128 KiB), with a CAS-verified upgrade that preserves old whole-roster choices.
Versions 1–4 retain their original bounds and semantics. See
[dense catalog compatibility](custom-neighborhood-dense-capture-preparation.md#versioned-dense-recorded-name-catalog)
for migration, report-owner resolution and rollback requirements.

`server/src/services/neighborhoodAssessment/customWorkspaceCheckpoint.js` defines
compact editor intent for the **existing** `neighborhood_workspace` workfile
section. It adds no table, route, database access, write, source-policy change or
production activation. It does not replace `neighborhood_assessment`, which
remains the atomic accepted report group.

## Exact saved value

```text
{
  workspace_version: 1,
  active: {
    context_ref: { context_id, context_revision: "1", context_sha256 },
    observation_period: { start_date, end_date },
    selection: { revision, included_recorded_group_ids: [...] }
  } | null,
  pending_capture: {
    operation_id,
    observation_period: { start_date, end_date }
  } | null
}
```

All fields are required at their level; all objects are closed. `active` and
`pending_capture` are explicitly nullable, but `active.selection` is not.
`{workspace_version:1,active:null,pending_capture:null}` is a valid intentionally
cleared checkpoint, distinct from an absent section. `[]` is an explicit empty
selection, never missing data or a request to include all groups.

`context_ref` uses the existing retained-context reference validator: lowercase
RFC-shaped UUID, revision **string** `"1"`, and lowercase 64-character SHA-256.
`operation_id` is a lowercase UUID using the same version/variant pattern. Dates
must be actual `YYYY-MM-DD` calendar dates with `start_date <= end_date`.
The pure contract does not infer the effective date or source freshness; the
authorized coordinator must compare study and context before using them.

Selection revision is a positive safe JavaScript integer, distinct from the
database section's positive int32 revision. Group identifiers are exactly
`recorded-cad:<64 lowercase hex characters>` or `discovery:unassigned`: at most
128 recorded identifiers plus one unresolved identifier, 129 total. Duplicates,
sparse arrays, invented labels/account IDs and malformed identifiers reject.
Input order and every identifier are preserved; nothing is truncated or repaired.
The entire canonical value is capped at 32,768 UTF-8 bytes and rehearsed through
the existing 850,000-byte section-value normalizer without raising its limit.

No account roster, raw source values, geometry, statistics, receipt, source grant,
caller target identity or purported accepted analysis fits this closed shape.
References/group hashes are navigation intent, not evidence or authority.

## APIs and missing versus invalid

`prepareCustomNeighborhoodWorkspaceCheckpoint(value)` returns a deeply frozen,
independent copy of the exact admitted value. It never mutates/freezes the caller's
input or generates/changes an operation ID. Invalid values throw a `TypeError`
with code `CUSTOM_NEIGHBORHOOD_WORKSPACE_CHECKPOINT_INVALID`, bounded `reason`,
and message prefix `invalid_custom_neighborhood_workspace_checkpoint:`.

`readCustomNeighborhoodWorkspaceCheckpoint(section)` accepts the existing
workfile API section envelope `{value, revision}` with optional `key`,
`updated_by` and `updated_at` strings. If `key` is supplied it must equal
`neighborhood_workspace`. All envelope fields are closed own data properties.

| Input | Result |
| --- | --- |
| Only `undefined` | `{status:"absent", section_revision:0, checkpoint:null}` |
| Valid present section | `{status:"restored", section_revision, checkpoint}` |
| Null/malformed section or value | `{status:"invalid", section_revision:null, checkpoint:null, reason}` |

“Restored” means structurally valid saved intent, **not** an authorized, current
or durable source-context confirmation. Invalid must remain an error state;
do not substitute revision zero or broad default membership and autosave it.

## Host persistence/reopen sequence

Use the existing section save API with its current `expected_revision`, history,
assignment authorization and protected-file behavior; no second persistence
system is needed. These functions do not themselves perform any save or access check.

1. Preserve any old `active` checkpoint while saving `pending_capture` before
   starting an explicit new acquisition. Reuse that exact operation UUID after
   an uncertain response or page reopen, rather than manufacturing a new attempt.
2. The actual coordinator sets `context_id = operationId` and compares study on
   replay. An active/pending UUID overlap is consequently allowed only with the
   same observation period. A **different** pending UUID may have a new period
   while the previous active workspace remains available.
3. Keep pending until capture plus catalog validation succeeds, then save the
   returned context and deliberate initial selected groups. Replay also checks
   the original actor; this checkpoint does not bypass that identity condition.
4. Reopen the exact saved context through current coordinator authorization and
   source policy, rebuild its retained catalog, validate every saved identifier,
   then expand membership using `selectionFromRecordedGroups`. Unknown, foreign,
   stale or missing context/groups must fail visibly, never broaden selection.
5. Request coherent preview statistics anew; never cache them in the checkpoint.
   A section-revision conflict must preserve local intent and require resolution.
   File/session changes cancel outstanding acquisition, preview and saves.

The immutable retained context/query repositories still own source evidence;
this section merely points to it. Report publication, supported cohort decisions
and `saveCustomNeighborhoodAcceptanceInTransaction` remain separate. This
checkpoint cannot make an observation-only preview eligible for Apply.

## Persistence and verification

The existing generic workfile writer invokes the checkpoint validator for the
normalized `neighborhood_workspace` key in both pool-owned and caller-owned
transaction paths. It retains the ordinary expected-section-revision check,
workfile lock, complete section/history write and signed-state guard. The pure
contract does not create a separate persistence or authorization mechanism.

Focused verification from `server`:

```text
node --test test/customWorkspaceCheckpoint.test.js test/customWorkspaceCheckpointPersistence.test.js
```

Those tests cover structural admission and the query-level writer composition;
they do not by themselves prove PostgreSQL concurrency or durable COMMIT.

The ordinary `test/customCohortContextCapture.integration.test.js` wrapper, already
included in `npm run test:uad-migration`, now runs these real helpers sequentially:

1. Coordinator capture/retention/preview/catalog checks create the exact synthetic
   assignment and retained source fixture.
2. Source-policy checks use a separately checked connection to that same child
   database and roll back their synthetic organization rights fixtures.
3. Checkpoint checks require the exact preceding coordinator fixture and exercise
   actual generic save transactions and separate workfile reads.

The existing `prepareNeighborhoodCiDatabase` guards, canonical migrations,
loopback socket/database checks and unique disposable child database remain
unchanged. No shared-database fallback, CI flag spoof, DROP, service control,
workflow modification or new schema is introduced. With no `DATABASE_URL`, the
native wrapper remains explicitly skipped; a skip is not native success.

On 2026-09-09 the retained local native runner passed **13 coordinator, 8
source-policy and 6 checkpoint check groups**, recorded in workspace artifact
`outputs/custom-neighborhood-context-native-v1/e7c8dbd5ec424dbba173cbfbf96d0d5f.json`.
Its runner SHA-256 was
`7e7655384f5fcca09cff4f224d709bf37971382c36fd59b2c10ac9b99b0d6bbf`;
the artifact also pins source files and canonical migration checksums. This is
local migrated PostgreSQL/PostGIS evidence, not a claim that the newly extended
ordinary CI wrapper or an entire remote CI job has already passed.

The six checkpoint groups verify:

- Pending operation UUID/period COMMIT and separate reopen before capture.
- Actual capture plus exact-operation replay and context/catalog intent reopen.
- Explicit empty selection and a real retained `compareCurrent` check staying
  matched after assignment/workfile `updated_at` changes; source caches are not
  reread and all-population statistics remain identical.
- Two concurrent saves at one expected revision yield one COMMIT and one CAS
  conflict, with exact consecutive section history.
- Caller-owned rollback removes tentative section/history; wrong-account and
  malformed saves leave durable state untouched.
- A persisted signed workfile state rejects further checkpoint saves without
  changing report sections, histories or acceptance records.

Limits: all identities/source grants are synthetic. The signed case tests the
writer's persisted-state guard, not actual signing, HMAC or PDF artifact creation.
Acceptance remains absent in this fixture; it proves the checkpoint does not
create acceptance, not that an existing accepted group was mutated or replayed.
These checks do not prove browser-host save ordering, production source rights,
report-ready assessment, recommendation quality or Apply behavior.
