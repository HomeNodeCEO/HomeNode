# Future sales-source field preservation

The shared Python CSV importer now retains these optional, exactly named columns in `core.sales_source_records.raw_payload`:

- `ClosePrice`
- `Currency`, `PriceCurrency`, `CurrentPriceCurrency`, `ClosePriceCurrency`
- `LivingAreaUnits`, `LotSizeUnits`

Supplied cells remain literal decoded CSV text, including decimal precision, leading/trailing whitespace, explicit blanks, and unrecognized or conflicting labels. Missing columns and unprovided trailing cells remain absent. Duplicate evidence headers are rejected rather than silently choosing one value. Other unknown columns remain outside this importer's existing allowlist. Required legacy columns, including `CurrentPrice`, are unchanged.

The raw field name identifies the supplied column. Existing source filename, whole-file SHA-256, and logical CSV row number bind that payload to its import; a multiline CSV record still counts as one logical row. The stable source-record hash remains a listing/legacy identity, not a hash of every retained field. This change does not archive the original file or introduce immutable row history.

No new typed measurement, currency, unit conversion, closing-price fallback, source-rights claim, or report mapping is introduced. `ClosePrice` never replaces `CurrentPrice` in existing calculations. Old imports are not backfilled. A future reimport follows the existing upsert rules: its raw payload replaces the previous payload, while some non-null typed values may survive via `COALESCE`. New raw currency or units therefore must not be attached to an older surviving typed price or area. They belong only to the accompanying raw source fields; source compatibility and meaning still require the existing evidence policies.

Trestle already stores the supplied parsed Property object as `raw_payload`, including these fields when present. Regression tests cover this behavior; no feed, authentication, worker, mapping, or persistence change is needed here. This is preservation of parsed JSON values, not a new guarantee of original HTTP bytes or lossless numeric-token parsing. Its existing typed fallback and area calculations remain unchanged and must not be confused with the individual raw fields.

Application migration `20261018_sales_source_metadata.sql` adds only nullable `source_modified_at` and `source_system_name`. It supplies no ClosePrice, currency, or area-unit facts. This slice uses the existing raw payload and provenance columns and requires no schema migration. It does not make these fields available through the installed Custom neighborhood mapping or expand historical source coverage.

Focused tests (synthetic files/mocked persistence only):

```text
python -B -m unittest discover -s dcad-scraper-with-api/tests -p "test_import_sales*.py"
node --test server/test/trestleReplication.test.js server/test/trestleSourceEvidencePreservation.test.js
```
