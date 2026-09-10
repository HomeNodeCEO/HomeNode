# Assignment-private sales CSV preparation

## Implemented boundary

`prepareAssignmentSalesCsv(Buffer)` prepares original CSV observations for the future assignment-private importer. It is a pure, bounded parser and classifier: **it does not save anything, match an account, select a sale, or change a report**. No HTTP route, upload control, database table, background job, or retention deletion is activated by this slice.

The result explicitly reports `persisted: false`, `matching_status: not_evaluated`, and `analysis_status: not_evaluated`. "Prepared" means the file could be parsed, not that its rows were imported or accepted as evidence. This result must never be shown as a committed receipt.

This is separate from the existing shared Python sales importer. That importer writes shared sales and updates source provenance. It must not be called unchanged for assignment-private historical uploads. These prepared rows must remain private when persistence is added.

## Original rows and supported input

- Strict UTF-8, with an optional initial UTF-8 BOM; comma-separated columns; LF, CRLF, or CR record endings; quoted commas, doubled quotes, and quoted multiline fields.
- Fixed limits: 8 MiB original bytes, 10,000 data records, 128 columns per record, 16,384 decoded UTF-8 bytes per field, and 250,000 total cells including the header. Limits cannot be raised by request input. Process execution budgets and upload transport limits still need to be enforced by the eventual importer.
- Duplicate or empty headers, invalid UTF-8, NUL bytes, and ambiguous/malformed quoting reject the file. They are not silently repaired. Header mapping trims surrounding whitespace and ignores casing; the original header text is retained.
- Require `CloseDate`, at least one of `CurrentPrice`/`ClosePrice`, and an identity column: `ListingKey`, `ListingId`, `ParcelNumber`, `ParcelNumber2`, `Address`, `UnparsedAddress`, `PropertyAddress`, or `StreetAddress`. A header's presence does not prove the row contains that information.
- Every logical data record is represented, including blank records and records with the wrong number of cells. A final record delimiter does not create a phantom empty record. Logical row numbers and physical starting line numbers are separate when a quoted field contains newlines.

The SHA-256 identifies the exact original file bytes. Each prepared row retains its untrimmed decoded cells and exact original byte span (end exclusive, excluding the record delimiter). Unknown columns remain available through those cells and the header array. Spreadsheet formulas are inert strings; this boundary never evaluates them. Any later spreadsheet export must separately prevent formula injection without modifying stored original evidence.

The caller must retain the original file bytes alongside the eventual batch. A digest, parsed cells, and byte offsets are not a substitute for retaining the uploaded evidence.

## Values and identity review

Ordinary MLS fields use the existing sales schema's snake-case vocabulary. Measurement and money observations are bounded exact decimal strings, not binary floating-point values. Dates must be real calendar dates in explicit `M/D/YYYY` or `YYYY-MM-DD` form. Booleans and structural-style classifications follow the ordinary existing CSV meanings. Safer validation differences from the existing permissive Python importer are intentional; this is not a claim of universal conversion parity.

`CurrentPrice` remains `current_price`; `ClosePrice` remains `close_price`. One is not substituted for the other. Currency, living-area units, and lot-size units are not guessed. `MlsStatus=Closed` identifies a reported closed-sale record; unknown or missing statuses stay unknown. A historical closing date is not proof of historical condition, zoning, geometry, neighborhood stock, or actual closing consideration. The retained-source interpretation and retrospective evidence checks still apply.

Parcel identifiers retain their original punctuation and letters. Preparing a Collin identifier, address, or MLS identifier does not establish a CAD match.

File-local grouping is conservative:

- Identical cell content is identified as duplicate *row content*, not proof of duplicate real-world transactions.
- Different rows sharing an MLS listing key or listing ID are flagged as an identity conflict, including earlier rows and transitive key/ID conflicts. No first-row-wins overwrite occurs.
- The key and ID namespaces remain distinct. Same address alone is not enough to merge records. Repeat sales with distinct identities remain separate.
- A group stores one list of row numbers; each row stores only a group reference. Large conflicts do not create quadratic per-row lists.

The summary accounts for every data record exactly once as prepared, needing review, duplicate, identity conflict, rejected shape, or empty. Original cells remain available for all of them. None of these dispositions deletes an original record.

## Next required integration

1. Assignment/organization-authorized immutable batch storage, original bytes, uploader and provenance; honor signed-file protections.
2. Durable row receipts returned only after commit and readback, including retry/uncertain-commit recovery and explicit rejected/duplicate dispositions.
3. Read-only matching proposals and separate review outcomes, without shared importer mutations.
4. An appraiser-visible upload/receipt view that distinguishes saved, matched, and included, including search/filtering by source row.
5. Explicit private-source admission to a new retained neighborhood capture before any inclusion in statistics. Do not mutate old captures or bypass retrospective historical-stock requirements.

The rolling shared-sales retention proposal does not expire these assignment-private source files or accepted/signed evidence. No evidence deletion is implemented here.
