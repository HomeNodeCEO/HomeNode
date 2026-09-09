# Review-only recorded CAD pocket catalog

```js
buildCustomCohortPocketCatalog({ retained_inputs, preview })
```

`retained_inputs` is the exact verified graph returned by the retained loader;
`preview` is the actual numeric `buildCustomCohortObservationPreview` result from
that graph. The function checks the source-snapshot identities, target/date/capture
binding and exact `preview.all.stock`/discovery roster. It does not authorize the
call or revalidate original evidence. The owner still controls source disclosure,
fresh assignment/material checks and any HTTP operation.

## Names and county scope

Only the retained G projections are consumed:

- Account `raw_projection.county` supplies that account's recorded county.
- Account `raw_projection.subdivision` supplies an account-side recorded label.
- Parcel `raw_projection.subdivision_name` supplies parcel-side recorded labels.

Parcel rows have no county field. Missing county is not inferred from the subject,
the `dcad` table name, a neighbor or a provider name. Accounts with unresolved or
conflicting county remain unassigned. Different known counties remain separate.
`Dallas` and `Dallas County` are not silently treated as aliases.

Recorded names and counties are compared using only `trim()`, whitespace-run
collapse and locale-independent `toLowerCase()`. Punctuation, accents and phase
suffixes remain distinct; no substring, fuzzy, builder, HOA or development matching
is performed. Raw string variants are retained; deterministic display labels use
the first code-unit-sorted raw variant with whitespace collapsed. Null/blank values
and the exact normalized placeholders `unknown`, `unassigned`, `n/a`, `none`, and
`not available` supply no usable name/county. A real label such as `Unknown Acres`
is not discarded. Non-string or invalid-control input is invalid evidence, not a
coerced label.

An account with one consistent known county and one consistent recorded name is
assigned once. Missing companion labels are counted as partial observation, not
invented agreement. Conflicting known account/parcel labels or invalid companion
evidence leave the account unassigned. Candidate named groups remain visible, but
their `account_ids` contain **only unambiguous assigned members**. Conflict and
invalid counts are distinct. `unassigned_candidate_account_count` describes blocked
candidates, not additional group members. A candidate group may have zero assigned
members. Unassigned details retain raw label/county variants, reasons and candidate
group references for review.

## Result and honest coverage

The envelope contains `catalog_version: 1`, a context/revision binding, `status`,
`pockets`, `unassigned`, `coverage`, `subject_recorded_group_ids`, and
`subject_membership`. Every pocket is `needs_review` and
`recorded_label_match_only: true`. Its ID hashes only the normalized public county
and recorded label; it is not a legal subdivision ID, source permission or proof.

`status: review_only` / `catalog_complete: true` means the bounded catalog
enumeration finished. It does **not** mean all accounts have labels, county is
authoritative, provider coverage is complete, membership existed at the effective
date, or any property is housing/competitively eligible. Provider coverage and
eligibility stay unestablished. Apply stays blocked.

Coverage always uses the full retained discovery / `preview.all.stock` roster,
never the current selected pocket union. Assigned group accounts plus unassigned
accounts form an exact, disjoint union of that roster. String account identities,
case, punctuation and leading zeros are preserved. Account/parcel source-row
counts, accounts with those rows, known counties, observed labels, conflicts,
invalid evidence and partial observations are reported separately. Reason counts
can overlap and must not be added as mutually exclusive populations.

The subject gets an `assigned_pocket_id` only for an unambiguous recorded-name match.
Missing, invalid, conflicting or out-of-discovery evidence never supplies a default
group. `subject_recorded_group_ids` can contain multiple **candidate** groups in
a conflict; callers must not mistake them for assigned or recommended membership.
Any later manual default should use the explicit assigned ID and preserve these
review-only semantics.

## Limits and output boundaries

There are at most 50,000 accounts, 100,000 CAD rows, 1,000 source chunks, 128 groups,
512 UTF-8 bytes per retained label and 4,096 distinct raw label/county variants.
The output ceiling is 32 MB, including account membership. Oversized text/variant,
group-count or output work returns `status: incomplete` with **no clipped pocket
prefix**. The complete original roster remains under `unassigned.account_ids`;
`unresolved_membership.roster_location` points there with the blocking reason.
Uncomputed conflict/source coverage counts are null, not zero. Membership is
unresolved by the catalog limit, not declared nameless or excluded from discovery.
Malformed or mismatched input throws `CUSTOM_COHORT_POCKET_CATALOG_INVALID`.

This is a bounded internal catalog, not permission to exceed the HTTP/browser
owner's smaller response ceiling. It intentionally supplies public account IDs
for exact map joins, but no provider/source-record IDs, raw projections, source
authorization tokens, legal descriptions or transaction rows. Names are plain
text and must use escaped text rendering. No polygons, hulls, circles, corridors,
cardinal descriptions or other geometry are fabricated. Sales/oldest-sale records
never provide fallback names. Ranking, scoring, historical membership, builder/HOA/
phase identity, report readiness and signing behavior are outside this function.

## Authorized catalog transport

The existing coordinator now exposes `catalog(input, options)` where `input` is
exactly `{ auth, accountId, assignmentFileId, contextRef, selection }` and `options`
uses the existing aggregate monotonic deadline / AbortSignal contract. The owner
loads the exact immutable retained context, builds the complete numeric observation
preview, then calls this module's internal builder and public presentation:

```js
presentCustomCohortPocketCatalog({ catalog, preview, expected })
// expected = { context_ref, selection_revision }
```

This presenter consumes the trusted builder output; it is not an alternate route
for browser-supplied source facts or a new evidence validator. Source policy must
explicitly permit `report_observation_catalog` with `retention: true`, both before
the full retained graph is opened and after transformation. The existing final
scoped assignment, subject/material, report state and policy-revision checks still
gate the response. Nothing rereads mutable CAD/MLS observations, writes report
sections, accepts an assessment, changes signing, or grants provider permission.
An empty selection still enumerates the full retained discovery roster.

The dedicated, deliberately unmounted router adds:

```text
POST /api/accounts/:id/neighborhood-cohort/catalog
body: { assignment_file_id, context_ref, selection }
```

`assignment_file_id` is an exact positive bigint string. The account comes from the
exact URL path and principal only from authenticated middleware. Unknown body
fields, source facts and identity overrides are refused. Mounting still requires
the application's existing authenticated/CSRF owner and an explicitly licensed
coordinator; this endpoint does not install either.

Successful responses are `no-store` and have this shape:

```js
{
  status: 'catalog',
  target: { account_id, assignment_file_id },
  context_ref, selection_revision, subject_freshness: 'matched',
  catalog: {
    catalog_version: 1,
    binding: { context_ref, selection_revision, selection_sha256 },
    status: 'review_only', // or 'incomplete'
    catalog_complete, discovered_group_count, reasons,
    basis, authority: 'not_established', geography: null,
    pockets, unassigned, unresolved_membership, coverage,
    subject_recorded_group_ids, subject_membership, limitations,
    apply: { status: 'blocked', reasons },
    presentation: {
      raw_variants_omitted: true,
      unassigned_details_omitted: true,
      membership_complete: true
    }
  },
  apply: { status: 'blocked', reasons: ['observation_preview_only'] }
}
```

Public `pockets` preserve `id`, full recorded `label` and `county` (up to 512 UTF-8
bytes each), every exact `account_ids` membership, `member_count`, conflict/invalid/
unassigned-candidate/partial counts, and all review-only disposition, boundary and
eligibility flags. `unassigned` preserves every account, its member count and reason
counts, with `details_complete: false`. Raw variants, normalized label copies and
verbose per-account conflicting-evidence details are omitted, not fabricated or
silently declared complete. Full details remain in the internal catalog. Source
row IDs, raw projections, transaction rows, authorization tokens and map geometry
are never part of the public projection.

`selection_sha256` uses the identical canonical JSON key order and code-unit
sorting as the numeric summary/browser controller: SHA256 UTF-8 of
`JSON.stringify({ pockets, revision })`, where selected pockets are sorted by ID
and each has keys `{ account_ids, id, label }` with sorted unique account IDs. It
binds the selection used for the numeric calculation, not catalog membership or
permission. Catalog groups are independent of that selected union. A recorded
label is not automatically usable as a manual preview label: the latter has its
own smaller input limit; callers must preserve identity while using a bounded
display label or a constant aggregate-selection label.

The compact catalog is limited to 3,990,000 UTF-8 JSON bytes, reserving headroom
for its owner envelope. The router checks and sends the exact encoded response
with a hard 4,000,000-byte ceiling. Public-size overflow first returns `incomplete`
with no groups and **all** original accounts under `unassigned.account_ids`, with
`unresolved_membership.reason: 'catalog_response_byte_limit'`. Such membership is
unresolved due to presentation limits, not asserted nameless. Unavailable conflict
and source-row counts become null, never invented zero. `membership_complete`
means the entire discovery roster is present, not that label assignment is complete.
If even that complete unresolved roster cannot fit, HTTP 422 returns only:

```js
{ error: 'neighborhood_catalog_incomplete',
  reason: 'catalog_response_byte_limit', membership_returned: false }
```

No account prefix or partial group list is ever returned as a successful catalog.
Access, missing-context, freshness and cancellation failures retain the existing
sanitized 403/404/409/503 contract. Malformed retained catalog data is a sanitized
server failure, not a browser input error.

Focused tests cover actual mapping/capture-builder projections, summary-fingerprint
parity, exact zero/missing counts, full labels, private-field omission, explicit
37,500-member whole-roster overflow and 40,000-member transport refusal. Large
capacity cases use trusted builder-shaped projection fixtures, not claimed native
acquisition. Native helper additions cover real retained labels after live-cache
mutation, exact full membership, policy checks/revocation, assignment/material
changes, no source reread/report writes, and actual HTTP. These added native cases
remain pending until run against a genuine migrated disposable test database.
