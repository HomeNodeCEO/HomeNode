# Custom Appraisal signed-photo coverage preflight

`npm run audit:custom-signed-photo-coverage` from `server` is an opt-in,
aggregate-only, read-only preflight for the existing signed-report PDF's
100-photo cap. Run it first on a staging restore, then during an approved
audit window in each intended environment. The command requires a
certificate-verified remote PostgreSQL connection (literal loopback is
permitted for local tests), uses one connection, caps each statement at five
seconds, and prints only counts after clean pool shutdown. It never changes
application rows or emits organization, assignment, report, photo or object
identifiers, URLs, binary content, or raw database diagnostics.

The counts cover signed Custom Appraisal files with no linked report file,
currently verified photos, files with more than 100 verified photos, the
minimum number beyond that cap, currently verified photos with no verified
JPEG/PNG object metadata, and photo rows whose organization or workflow
differs from their report file. A nonzero exit or timeout is not permission to delete,
regenerate, or silently omit signed evidence. Investigate exact files through
a separately authorized, assignment-scoped workflow if any count is nonzero.

This is a **current database state** check, not a reconstruction of what
existed at each signature time. Photo/object rows can change afterward; an
object row marked verified does not prove its R2 bytes still exist or can be
decoded, and the audit cannot see which photos a historical PDF actually
rendered. Run the signed-snapshot/artifact parity and stored-PDF byte audits
separately before any R2 migration. Do not change the signing limit or its
E&O exception policy based on a zero count alone.
