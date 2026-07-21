# Sales imports

Sales CSV imports preserve the complete source row while linking only verified
parcel IDs to existing CAD accounts.

## Tables and view

- `core.sales_source_records` stores every imported row, all typed MLS fields,
  the exact raw payload, match status, and quality flags.
- `core.sale_parcels` stores every supplied parcel field and its optional
  `core.accounts` match. A sale can link to multiple accounts without copying
  the full transaction price to each account.
- `core.sales` remains the canonical transaction table for rows with a verified
  primary account. `source_record_id` links it back to the preserved source.
- `core.v_sales_enriched` exposes legacy sales, matched imports, unmatched
  imports, parcel flags, MLS snapshots, and current CAD characteristics as one
  row per transaction.

The transaction price belongs to the complete sale. Do not sum it once per row
from `core.sale_parcels` for multi-parcel transactions.

## Import command

Run from `dcad-scraper-with-api/scraper` with `DATABASE_URL` configured:

```powershell
python -m dcad.import_sales "C:\path\to\sales.csv" `
  --source-name "Garland MLS two-year sales" `
  --dry-run

python -m dcad.import_sales "C:\path\to\sales.csv" `
  --source-name "Garland MLS two-year sales"
```

The importer is idempotent. It hashes the complete source row, upserts the
preserved source record, rebuilds its parcel relationships, and reuses the
existing canonical sale on subsequent runs.

## Parcel behavior

- Exact 17-character IDs are matched first.
- Punctuation is removed only when the resulting 17-character ID already
  exists in `core.accounts`.
- Embedded or concatenated 17-character IDs are accepted only when the exact
  candidate exists in `core.accounts`.
- Unmatched values remain in `parcel_number_raw` and `raw_payload`.
- Two distinct matched accounts set `multi_parcel_status = 'confirmed'`.
- A second supplied parcel value without two distinct matches sets
  `multi_parcel_status = 'possible'`.

## Application flags

Use these columns from `core.v_sales_enriched`:

- `match_status`
- `has_multiple_parcel_numbers`
- `multi_parcel_status`
- `has_unresolved_parcel`
- `requires_additional_review`
- `data_quality_flags`
- `linked_parcels`

Unmatched sales intentionally remain in the view with a null `sale_id` and
null `primary_account_id`, so they are available for broad market analysis.

## Application API

The Node application API exposes the enriched view through `GET /api/sales`.
It returns one row per transaction and supports these optional query filters:

- `q` (address, city, source, or exact 17-character account ID)
- `account_id` (primary or additional linked parcel)
- `exclude_account_id` (exclude sales linked to the subject parcel)
- `neighborhood_code` (matched CAD-account neighborhood)
- `date_from` and `date_to` (`YYYY-MM-DD`)
- `min_price` and `max_price`
- `matched` and `review` (boolean)
- `multi_parcel` (`single`, `possible`, or `confirmed`)
- `limit` (maximum 200) and `offset`

The frontend client is `searchSales()` in `dcad-frontend/src/lib/api.ts`.
