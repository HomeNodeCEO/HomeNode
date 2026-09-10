# Assignment-private sales CSV storage

## Scope

The Custom Appraisal importer retains original CSV bytes and an immutable receipt for every logical data row. It is separate from the shared MLS importer. It does not create CAD accounts, overwrite shared sales, change an accepted neighborhood, bypass source-use review, or certify historical housing stock. Preparing, saving, matching, and including a row are separate states.

Migration `20261015_assignment_sales_csv_imports.sql` runs through the existing application migration runner, not inside HTTP requests. The batch references the exact organization/report/assignment/account tuple. Actor and original bytes are mandatory. PostgreSQL checks the source byte count and SHA-256. Batches and rows reject updates, deletes and truncation. A deferred commit constraint requires every row from ordinal 2 through the declared final ordinal; an immediate range guard and primary key prevent later appends. Zero-row files retain their original source but do not represent any saved sales.

No retention deletion, scheduler, production backfill, shared import, account reconciliation or storage credential changes are introduced. These private sources have no automatic expiration. They are not part of a signed evidence manifest merely because they are saved; future analysis admission must bind the exact retained source and receipts before signing can rely on them.

## Access and transactions

Both workflow permission and exact assignment access are required, including when mandatory authentication is disabled elsewhere during rollout. No organization, actor or role is taken from upload metadata. Reads reauthorize the same scope. The optional target lookup resolves the existing canonical report for the explicitly requested assignment; it never creates or selects a newer file.

A new upload requires a draft workfile, no signature timestamp and no retained signed snapshot. The importer locks the workfile used by signing, then the exact assignment/report owner rows. Permissions and draft state are checked again under those locks. Existing same-operation receipts can be reopened after signing, but new uploads cannot be inserted into signed or archived files.

Each database operation owns a fresh checked-out idle connection. Statement, lock, idle-transaction and application deadlines are bounded. Inherited transactions are never committed. Failed or uncertain connections are discarded. Original bytes are snapshotted before asynchronous authorization so a caller cannot change the bytes between hashing and saving.

The operation UUID is scoped to the report and bound to the original actor, file name, source digest/size and installed preparation result. Retrying identical input returns the same batch; changed input conflicts. Source and all rows commit together. A successful save response is issued only after a fresh committed readback. Lost commit acknowledgments are recovered using the same operation ID; if readback is unavailable, the result remains explicitly uncertain. Clients must not manufacture a new ID to recover a timeout.

Save and operation-recovery readback recompute the canonical, length-framed preparation digest from the stored header and every stored row, in bounded pages. Counts alone cannot verify changed row content. Batch lists show count-checked summaries without rereading all source payloads for every file; opening a saved operation verifies its full preparation digest. SQL meters a maximum 4 MiB payload prefix before transferring row content to Node, rather than loading 100 large rows and discarding them afterward.

## HTTP interface

Base: `/api/accounts/:id/assignment-files/:assignmentFileId/sales-imports`.

- `GET /target` resolves the existing exact target and upload eligibility.
- `GET` lists bounded receipt summaries. All endpoints below require `report_file_id` in the query.
- `POST` accepts raw UTF-8 `text/csv` bytes (8 MiB maximum), `Idempotency-Key`, and the existing CORS-allowed percent-encoded `X-Document-File-Name` header. Exact assignment authorization precedes body parsing. Compressed bodies are not accepted. No base64 expansion or global parser-limit increase is required.
- `GET /operations/:operationId` reopens one committed receipt, or returns 404. A 404 while a request is still in flight is not permission to retry under a new ID.
- `GET /:batchId/rows` pages rows with `after_row` and a maximum `limit` of 100. Original row numbers, dispositions, issues and literal cells remain inspectable. No formula is executed.

All responses are `no-store`. Fixed error codes omit SQL, source rows, connection strings and provider details. The upload and receipt interface must display `matching_status: not_evaluated` and `analysis_status: not_evaluated` honestly until their separate review and admission stages exist.

## Verification

Focused tests cover parsing, migration replay/checksums, transaction ownership and sanitization, HTTP authorization-before-parser, metadata validation and fixed errors. The native integration suite uses a new disposable test database and canonical migrations to exercise exact tenant/file scope, full row accounting, original bytes, retries, concurrent operations, mid-batch rollback, lost acknowledgments, immutability, deferred constraints and signing locks. It is included in the migration CI command. These synthetic tests do not establish production data coverage or retrospective evidence eligibility.
