# Bounded Custom observation presentation

These pure functions consume the **actual** `buildCustomCohortObservationPreview`
result. They do not authorize reading it, load evidence, query sources, acquire a
connection, create an assessment, or enable Apply. The owner must perform fresh
scoped access and licensed-data exposure checks, exact retained loading, and its
final access/material/policy reconfirmation around the projection.

```js
presentCustomCohortPreview({
  preview,
  expected: { context_ref, selection_revision }
});

inspectCustomCohortPreviewMembers({
  preview,
  expected: { context_ref, selection_revision },
  population: { group: 'all', kind: 'transactions' },
  page: { limit: 50, after_member_id: null }
});
```

`group` is `all`, `selected`, or `pocket`; the latter also requires `pocket_id`.
`kind` is `stock`, `transactions`, `omitted_transactions`, or `source_reported`.
Every call requires the exact context reference and positive selection revision.
Wrong/stale context, unknown populations or cursors, unsupported metrics,
inconsistent denominators, and exceeded limits throw. No partial or silently
truncated success is returned. Formatter-owned errors are `TypeError` with code
`CUSTOM_COHORT_PREVIEW_PRESENTATION_INVALID` and a bounded `reason`; existing
context/date primitives may throw their own errors. HTTP owners must sanitize
errors rather than expose arbitrary internal exception text.

## Summary response

The envelope has `presentation_version: 1`, `preview_version: 1`,
`status: 'observations_only'`, `contents: 'population_summaries_only'`,
`members_included: false`, and:

```js
binding: { context_ref, selection_revision, selection_sha256 }
```

`all`, `selected`, and `pockets[].result` retain the three separate stock,
canonical-transaction and all-date source-record populations. All supplied
metrics, units, estimator labels, counts, missing/conflicting/invalid counts,
denominator bases, overlap counts and support caveats are preserved. Members,
large account arrays, target internals, source snapshots/references, raw values,
provider/listing/source-record IDs and authorization extensions are not copied.
Inspection descriptors supply exact population selectors and total counts.

The exact shared selection fingerprint is lowercase SHA-256 of UTF-8:

```js
JSON.stringify({
  pockets: preview.pockets.map(p => ({
    account_ids: [...p.account_ids].sort(),
    id: p.id,
    label: p.label
  })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  revision: preview.selection_revision
})
```

Object key order is deliberately `account_ids,id,label` inside each pocket and
`pockets,revision` outside. Use JavaScript code-unit sorting; no locale sorting,
Unicode normalization, trimming, coercion or JSON whitespace. Numeric preparation
already rejects duplicate pocket/account IDs. This fingerprint is a content
identity, not permission, a signature or an authorization token.

## Member inspection

A page returns `contents: 'member_page'`, the same binding/caveats, an opaque
`population_id`, `members`, and explicit pagination:

```js
{
  total_count, returned_count, start_index, end_index_exclusive,
  is_full_population, has_more, next_after_member_id
}
```

First-page `after_member_id` must be null. For continuation, use the returned
`next_after_member_id` with the **same** context, selection and population.
Unknown/wrong-population/stale cursors fail rather than restart. Changing visible
member content or membership invalidates a cursor as well. `is_full_population`
is true only when that single response contains the entire population, including
the genuinely empty case. A final non-first page does not claim to contain all
rows. Different page sizes may be used without duplicating or skipping members.

Rows are sorted by their exact identity using code-unit order internally. The
browser receives deterministic opaque member IDs based on a population digest
and ordinal. Private source/canonical IDs do **not** enter the public ID preimage;
the population digest uses only the ordered browser-safe row projections. The
context reference already binds immutable original evidence. IDs/cursors are not
secrets or access grants and cannot replace the owner's authorization.

Stock rows expose only their bounded public cadastral account ID, parcel count,
numeric observations and provenance counts. Source/transaction rows do not expose
source names, original private IDs, associated-account arrays, raw values, source
reference tokens or raw projections. They preserve normalized numeric observations,
missingness, unverified-amount semantics, association counts, source-disagreement
flags and provenance status. Omitted-date transactions have a separate population;
they do not enter the in-period sales denominator.

## Display and limits

Numbers remain unchanged alongside display strings. Display uses en-US grouping
with at most two decimal places; years remain ungrouped and an explicitly supplied
per-square-foot unit receives exactly two decimals. Unknown values display
`Unavailable`, never zero. The current preview has no verified currency, so no
dollar symbol or currency is invented. COD stays descriptive dispersion; median
does not become predominant; provider coverage, historical applicability and
authority stay unestablished. Metric `state: ready` means a descriptive calculation,
not report readiness. Apply remains blocked.

Limits are 128 pockets, 100,000 aggregate pocket memberships, 100,000 members in
one inspectable population, 50 members per page, 2,000,000 UTF-8 bytes per summary,
and 256,000 bytes per page. Text has explicit byte limits. All metric keys are
explicitly supported; a new upstream metric requires a corresponding formatter
change rather than silently disappearing. Output bounds do not authorize returning
the underlying private preview or lifting the browser owner's response budgets.

Output is plain JSON data, not HTML. User-authored pocket labels remain text.
Render with escaped text APIs; do not place labels in `innerHTML`, interpolate
JSON into executable script, or treat any value as instructions. No styling,
schema, route, source authorization or lifecycle behavior is owned by this module.
