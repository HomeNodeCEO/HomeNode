# Custom Appraisal Document Evidence

Status: production baseline for Custom Appraisal assignment evidence.

## Workflow

1. The appraiser opens or creates the assignment file before uploading evidence.
2. The browser sends the original PDF bytes to the API with the assignment-file ID, document type, title, and uploader.
3. HomeNode stores the original bytes immutably, deduplicated by assignment scope and SHA-256 checksum.
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

The original PDF currently remains in PostgreSQL so the source, extraction, and assignment file are transactional and deployable without another credentialed service. Before high-volume production use, migrate original bytes to the already established private R2 object-storage pattern while retaining checksums, provenance, extraction pages, candidates, and review history in PostgreSQL. The API contract and viewer URL should remain stable during that migration.

## Operations

Immediate extraction starts after upload. The scheduled recovery command is:

```text
npm run maintenance:documents
```

The normal scheduled-maintenance task also includes document recovery. Relevant environment settings are `DATABASE_URL`, `HOMENODE_EDITOR_KEY`, and `MAINTENANCE_DOCUMENT_BATCH_SIZE`.
