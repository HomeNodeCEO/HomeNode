# CSV-only neighborhood deployment compatibility

Live verification on 2026-09-10 found an existing CSV-only database without
`core.sales_source_records.source_modified_at` or `source_system_name`.
These fields already exist in scraper migration 018 and Trestle initialization,
but older imports do not establish that either initializer ran. The application
migration runner did not previously install them.

Migration `20261018_sales_source_metadata.sql` adds exactly those two nullable
columns during the existing application pre-deploy step. It does not run a
Trestle worker, alter listing indexes, write source values, or identify an MLS
from a filename. Unknown metadata remains NULL. Existing populated metadata is
preserved. An absent optional sales table stays absent; the ingestion owner
creates its own full schema later. Reader capability checks remain unchanged.

This fixes schema compatibility only. Feature flags, an independently maintained
source inventory/profile, genuine organization source-use rights, effective-date
support and representative live-file acceptance remain separate prerequisites.
Do not use an NTREIS membership or successful CSV import as automatic permission
for unrelated users or future Trestle sources.

Verification: `node --test test/salesSourceMetadataMigration.test.js` and the
guarded `salesSourceMetadataMigration.integration.test.js` in disposable native
PostgreSQL CI. Native checks cover absent sources, legacy CSV values/unknowns,
repeated migration and preservation of existing provider metadata.
