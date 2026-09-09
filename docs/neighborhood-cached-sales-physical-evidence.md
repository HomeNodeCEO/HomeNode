# Cached sales physical evidence, mapping v2

The cached reader now retains existing core.sales_source_records fields for
lot size, year built, bedrooms, total/full/half bathrooms, structural style,
housing type, attachment type, architectural style, garage spaces/presence,
pool presence and days on market. Source living area was already retained.
The column definitions are in dcad-scraper-with-api/migrations/004_sales_ingestion.sql.
No schema migration, provider request or new data-access permission is introduced.

Each field is projected directly from its source record under a source_ alias,
beside the existing source IDs, filenames, hashes and ingestion timestamps.
Numeric database values remain decimal strings; integers, labels, booleans,
SQL NULL and zero remain unchanged. A missing field in older evidence stays
absent, not synthesized as NULL. Unknown/invalid observations are retained for
review without trimming, repairing, classifying or promoting them into facts.
The reader requires the projected columns to exist; an unavailable column
produces an explicit unsupported-schema capture, not a shortened success.

These values live only in raw_projection. They do not establish housing type
at the effective date, lot-area units, construction completion, GLA at sale,
historical applicability, transaction membership/equivalence, verified
allocation, market eligibility or provider coverage. All existing unknown
normalized values and capability gaps remain. There is no curated/latest
housing-profile fallback, enriched-sales fallback, raw payload or private
remarks capture. Existing assignment, public cadastral and separate market
data capability checks are unchanged.

## Version and replay boundary

CACHED_ROW_MAPPING_VERSION is now 2. New row digests and the reader's original
query metadata explicitly contain that version. Row/source digests bind the
additional field values; the query-selection digest binds metadata (including
the mapping version) and account roster, not those observed values. The
local-capture-v3 profile keeps its existing
envelope, account-stream, transaction-closure and hashing semantics. Its
byte-consistency validator admits mapping versions 1 and 2 explicitly and
rejects other values.

Previously retained v1 evidence must be loaded with its original bytes, version
and digests. Do not remap it with today's mapper, relabel it v2, add missing
fields or regenerate metadata from current cache rows. The new mapping version
does not retroactively enrich old captures or establish original acquisition.

Focused tests cover exact values/provenance, hashing, zero/NULL/absence,
unsupported fields, actual reader-output metadata, missing schema columns and
a hash-pinned v1 evidence replay. The two native reader fixtures receive only
the corresponding nullable column definitions; their guards are unchanged.
No database/native verification is performed by this slice.
