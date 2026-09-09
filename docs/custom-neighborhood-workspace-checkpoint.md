# Custom neighborhood workspace checkpoint v1

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

Focused verification: `node --test test/customWorkspaceCheckpoint.test.js` from
`server`; no database, route or browser-host integration is exercised here.
