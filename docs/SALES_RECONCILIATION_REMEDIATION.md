# Sales reconciliation remediation

The manual-review queue contains only closed MLS source records that still
need a trustworthy CAD relationship. The automated pass is deliberately
conservative:

- An existing non-ambiguous HomeNode account link may resolve a malformed raw
  MLS parcel value. The raw value is retained for provenance.
- An unlinked sale may match automatically only when its canonical address and
  city produce exactly one current CAD account.
- Multi-parcel, conflicting, duplicate-address, and fuzzy matches remain in
  manual review.
- Every automated change is recorded in
  `app.sales_auto_reconciliation_history`.

## Indexed address evidence

`app.account_address_aliases` is the shared address-to-account lookup used by
the repair worker and Trestle replication. It is materialized from current,
canonical `core.accounts` rows outside the live property-search request path.
The index retains the raw address and source while matching on normalized
address, city, optional county, and optional ZIP evidence. An automatic match
is allowed only when those safeguards identify one account.

The seed is resumable and idempotent. A completed whole-inventory pass is
refreshed weekly, while scheduled sales maintenance seeds any unfinished pass
before reconciling new records. Seed or refresh the index without changing a
sale:

```powershell
npm run backfill:account-address-aliases
```

Run a read-only audit:

```powershell
npm run audit:sales-reconciliation
```

Run a non-mutating 20-sale fuzzy candidate study:

```powershell
npm run audit:sales-fuzzy-addresses
```

The fuzzy study first requires the same house number, then compares normalized
street text and structured secondary-address identifiers. `Suite`, `Ste`,
`Unit`, `Apartment`, `Apt`, `Number`, `No.`, and `#` are presentation variants
of the same unit label. Building, tower, and floor identifiers remain separate
so a repeated apartment number in different buildings cannot be silently
conflated. Small street-name typos can produce review candidates, but the
study never writes a sale-to-account relationship. It reports the top five
candidates, component scores, the score margin, and incomplete unit/building
evidence for appraiser validation before any future automatic threshold is
enabled.

Apply bounded batches:

```powershell
npm run repair:sales-reconciliation
```

The scheduled `sales` and `routine` maintenance jobs run the same idempotent
batch before location and influence enrichment, so newly imported CSV or
Trestle records can be linked before downstream spatial work begins.

Raw MLS/Trestle parcel values remain unchanged. Verified account identity is
stored separately on the source record, parcel relationship, canonical sale,
and audit history. Historical or external CSV aliases may be retained as
review evidence, but they must not be promoted to `is_current = true` unless
their CAD relationship has been verified.

