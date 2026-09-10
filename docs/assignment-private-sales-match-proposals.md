# Private CSV account-match observations

This is a read-only review aid for **saved, assignment-private** CSV rows. It does
not reconcile shared sales or accept a CSV as neighborhood evidence.

## Flow

1. The appraiser expands a saved import and views a page of its row receipts.
2. **Check account match proposals** requests observations for that exact page.
3. The owner authorizes the exact organization, report UUID, assignment and
   account, then reads the immutable stored page and CAD evidence in one bounded
   PostgreSQL repeatable-read, read-only transaction.
4. Each row displays either proposed account IDs, unresolved identity, or reasons
   for review. No receipt or global account/sale link is modified.

The optional endpoint is
`GET /api/accounts/:id/assignment-files/:assignmentFileId/sales-imports/:batchId/match-proposals`
with `report_file_id`, `after_row` and `limit`. It is authenticated, no-store, and
uses the same exact access policy as private receipt reads. There is no write or
approval endpoint in this slice. Signed files may still be inspected by readers;
these later observations are not added to their signed snapshot.

## Matching rules

- Use indexed exact account IDs, the existing normalized Collin identifier
  bridge, and current address aliases with reported city/county/postal evidence.
- Preserve every supplied parcel reference as a set. A missing, ambiguous or
  contradictory member cannot be silently discarded.
- Require agreement between identifier and address evidence. An empty address
  alias lookup may be corroborated by every supplied parcel's exact canonical
  situs, city, reported county and any reported postal code.
- Unit/building notations and compound address cases that this profile cannot
  interpret remain explicitly review-required. They are not matched by dropping
  the unit. Extending these cases is a separate tested improvement.
- Duplicates, conflicting source identities, empty and rejected rows remain in
  the result with their original preparation disposition and issues.

No sale price, area-unit, currency, housing type, rights, historical membership,
or transaction-eligibility meaning is inferred by identity matching. In particular,
`CurrentPrice` does not become `ClosePrice`, and a current CAD account is not proof
of the property's characteristics or parcel membership at an earlier effective date.

## Bounded database behavior

One page holds at most 100 rows and 4 MiB of stored row data. Its deduplicated
candidate bundle contains at most 600 requests. Candidate acquisition verifies
the installed cache columns and usable indexes, then uses bounded indexed probes;
it never calls an external provider, scans the whole account catalog as a fuzzy
fallback, creates indexes, or initializes cache tables during a request.

A six-row probe sentinel, incompatible/missing cache, hidden source access,
invalid canonical chain, or excessive payload yields unavailable evidence rather
than a clipped unique candidate. Timeout/lock errors preserve the existing fixed
busy response and roll back the owned transaction. No raw source/SQL error is
returned to the browser.

`proposal_page_sha256` identifies the versioned observation: exact target,
batch/source/preparation hashes, original row identities and data, proposed rows,
and all observed candidate evidence are length-framed and hashed. It is not an
approval capability, signature, or claim that an appraiser reviewed the result.
The frontend validates scope and page bindings but does not invent a second
cryptographic authority.

## Following slice

Persist deliberate appraiser match/source-interpretation review separately from
immutable intake. Admit those exact revisions into a new versioned private-source
capture only after eligibility and effective-date checks. Keep existing captures
and hashes unchanged. Boundary and statistics must still apply through the existing
coherent acceptance transaction, never through a separate statistics write.
