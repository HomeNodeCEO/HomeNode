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

Run a read-only audit:

```powershell
npm run audit:sales-reconciliation
```

Apply bounded batches:

```powershell
npm run repair:sales-reconciliation
```

The scheduled `sales` and `routine` maintenance jobs run the same idempotent
batch before location and influence enrichment, so newly imported CSV or
Trestle records can be linked before downstream spatial work begins.
