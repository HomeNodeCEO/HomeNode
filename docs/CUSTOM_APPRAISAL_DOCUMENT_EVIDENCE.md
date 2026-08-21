# Custom Appraisal Document Evidence

Status: production baseline for Custom Appraisal assignment evidence.

## Workflow

1. The appraiser opens or creates the assignment file before uploading evidence.
2. The browser sends the original PDF bytes to the API with the assignment-file ID, document type, title, and uploader.
3. HomeNode stores the original bytes immutably in private R2, deduplicated by assignment scope and SHA-256 checksum. PostgreSQL remains a durable fallback if object storage is temporarily unavailable.
4. Text-layer extraction runs asynchronously. Interrupted or failed work is recovered by the `documents` scheduled-maintenance task.
5. Extracted values are suggestions with a page number, verbatim source excerpt, normalized value, confidence, and extraction method.
6. An appraiser confirms or rejects every suggestion. Confirmation can prefill the corresponding form field, but the assignment section must still be saved explicitly.
7. Review actions are retained in an append-only review history. Reprocessing preserves an exact prior review and never changes the original PDF.

## Current document families

- Purchase contracts
- Engagement letters
- MLS sheets
- Zoning maps and ordinances
- Maps and other appraisal PDFs

The current form mappings include lender/client name and address, assignment type, contract price and date, loan amount, down payment, earnest money, seller concessions, and seller name. Purchase-contract evidence also activates the existing Purchase Transaction and Subject Under Contract E&O workflow after the appraiser confirms it.

## Processing safeguards

- Maximum PDF size: 25 MB
- Maximum page count: 250
- Atomic processing claim prevents duplicate workers from processing the same document concurrently.
- A processing claim older than 15 minutes is recoverable after an interrupted worker.
- Automatic failures use bounded exponential backoff and stop after five attempts.
- Manual retry remains available after automatic attempts are exhausted.
- Assignment-scoped queries do not expose documents from unrelated prior appraisal files.
- Dates and money are normalized before they are offered to the appraisal form.
- Browser-supplied document classifications and extracted values never bypass appraiser review.

## OCR and storage boundary

Machine-readable PDFs are processed locally with `unpdf`. Image-only, scanned, or unreadable PDFs are marked `ocr_required`; HomeNode does not pretend that an empty text layer produced reliable data. A production OCR provider should be added behind the document-intelligence interface before scanned documents are eligible for automatic field suggestions.

New originals use the established private R2 object-storage boundary. The server
verifies object size after upload and verifies both byte size and SHA-256 checksum
after download. Metadata, checksums, provenance, extracted pages, candidates,
and review history remain in PostgreSQL. If R2 is temporarily unavailable, the
upload is retained in PostgreSQL and marked for a bounded maintenance retry;
legacy PostgreSQL originals use the same migration queue. The browser API and
embedded viewer URL remain unchanged.

## Shared photo evidence

Custom Appraisal photos use the existing private R2 evidence contract. Desktop
uploads preserve the selected original and create a bandwidth-friendly JPEG
display derivative in the browser before direct upload. Mobile capture preserves
the original and display derivative in encrypted offline storage, then retries
the short-lived R2 upload and server verification when connectivity returns.

Both channels are scoped to the same canonical report-file ID and appear in one
Property Report gallery. A photo is not report evidence until the server verifies
its object size and content type. Verified originals are retained for five years;
removing one from the report records an exclusion instead of deleting evidence.
R2 credentials are never sent to either client.

## Operations

Immediate extraction starts after upload. The scheduled recovery command is:

```text
npm run maintenance:documents
```

The normal scheduled-maintenance task also includes extraction recovery and
legacy/fallback storage migration. Relevant environment settings are
`DATABASE_URL`, `HOMENODE_EDITOR_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `MAINTENANCE_DOCUMENT_BATCH_SIZE`, and
`MAINTENANCE_DOCUMENT_STORAGE_BATCH_SIZE`.
