# Assignment Document Evidence

HomeNode stores appraisal-file PDFs as immutable source evidence and extracts
page-cited suggestions for appraiser review. The same pipeline supports zoning
maps and ordinances, purchase contracts, engagement letters, MLS sheets, maps,
and other assignment documents.

## Evidence model

- `app.assignment_documents` stores the original PDF bytes, SHA-256 checksum,
  assignment/account relationship, processing state, and source provenance.
- `app.assignment_document_pages` stores the text layer by page so every
  suggestion can return to the exact source page.
- `app.assignment_document_field_candidates` stores the verbatim source value,
  a separately normalized value, confidence, excerpt, page number, appraiser
  disposition, confirmed value, reviewer, and review time.

The original PDF and extracted source wording are never overwritten when a
candidate is edited, confirmed, or rejected. A confirmed supported contract or
engagement-letter field prefills the current assignment draft; the appraiser
must still save Assignment Details.

## Processing and review

1. Upload a PDF from the Property Report's Document Evidence Center.
2. The API saves and deduplicates the PDF before extraction begins.
3. Text-bearing PDFs are classified and analyzed page by page.
4. Scanned or unreadable PDFs are marked `ocr_required`; HomeNode does not guess
   values from an unreadable source.
5. The appraiser views the PDF and its suggestions side by side, enters a
   reviewer name, and confirms or rejects each suggestion.

For zoning ordinances, HomeNode can look up a confirmed district code and
prefill the exact matching description from the official page. GIS attributes
retain their original source record and attribute object alongside the
normalized zoning code/description.

## Scheduled maintenance

Pending, interrupted, or failed extractions can be retried outside the web
request process:

```sh
npm run maintenance:documents
```

The routine maintenance task includes a bounded document retry batch before
census, location, parcel, and influence work. `MAINTENANCE_DOCUMENT_BATCH_SIZE`
controls that batch.

## Safeguards and limits

- PDFs only, maximum 25 MB per document.
- Maximum 250 pages per extraction attempt.
- Exact checksum deduplication within the property/assignment file.
- Editor key required for upload, reprocessing, confirmation, and rejection.
- Machine suggestions never become verified data without a named reviewer.
- Manual sale verification remains intentionally separate and is deferred until
  Trestle ingestion is available.
