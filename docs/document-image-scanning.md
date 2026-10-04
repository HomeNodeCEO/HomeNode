# Document image scanning

Uploaded PDFs keep their original bytes. Searchable pages use native text;
pages with fewer than 40 extracted characters are candidates for image scanning.
Suggestions retain their parser-rule IDs and original page numbers. OCR is not
approval: appraiser confirmation is still required before applying suggestions.

## Runtime

`DOCUMENT_OCR_PROVIDER=local` (the default when unset) uses the packaged English
Tesseract model and PDF.js renderer. No document is sent to another service and
no language assets are downloaded at scan time. Explicit `azure` and `disabled`
settings retain their existing meanings. The worker receives only a minimal OS
environment, not database, storage, or cloud-provider credentials.

Each API process permits one OCR child process. Limits are 25 MiB per PDF,
250 total pages, 64 scanned pages, 6 million rendered pixels per page, 16 million
decoded-image pixels, and 4 million extracted characters. The child has a
512 MiB JavaScript heap limit (not a total native-memory/RSS guarantee).
`DOCUMENT_OCR_LOCAL_TIMEOUT_MS` defaults to 180,000 and is bounded at 300,000.
The deadline terminates the child process. PDF scripting and evaluation are off.

A low-confidence sparse form page may receive one extra pass with long horizontal
form rules removed from a scratch image. Originals remain unchanged. Per-page
confidence, preprocessing, recovered pages, and unresolved pages are recorded in
extraction metadata. Poor or missing text must remain for visual review.

## Queue and review

Initial upload and explicit reprocessing run asynchronously. Reprocessing returns
HTTP 202 with the saved queued document; the existing UI refreshes its status.
A busy scanner queues the document for 15 seconds without consuming a failed
attempt. A bounded foreground wake queue retains at most 32 IDs per database
pool, never PDF bytes. PostgreSQL is authoritative and scheduled document
maintenance resumes pending work after restart or foreground-queue saturation.

Signed Custom workfiles and workfiles with historical signed snapshots are not
eligible for extraction mutations. Review confirmation preserves appraiser edits.
Source originals, source-specific extraction rules, and evidence receipts remain
separate from county identity, user defaults, and explicitly reviewed exceptions.

## Verification

`server/test/localDocumentOcr.test.js` includes a real image-PDF OCR test plus
limits, deadline, isolation, mixed-page, and rule-removal checks. Document router
and processing tests cover asynchronous reprocessing and durable busy retries.
`server/test/documentIntakeLayouts.test.js` uses synthetic layout examples; private
appraisal PDFs and extracted personal data must not be committed as fixtures.

Deployment requires the normal backend-first web release checks. Confirm the
provider setting, installed assets, service memory, and a permitted draft's live
scan before calling the feature production-verified. Native mobile publishing is
not part of this change.
