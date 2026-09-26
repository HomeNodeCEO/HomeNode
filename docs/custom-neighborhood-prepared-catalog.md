# Prepared Custom neighborhood catalog

The numeric/map read model makes pocket toggles fast, but reopening a saved
large-area study still rebuilds its recorded-group catalog and recommendation
from every retained source page. This change adds an immutable, compressed
selection-neutral catalog read model keyed by organization and retained context.

- The first authorized v3 catalog read still uses the original evidence path.
  After a successful response, it may write the public catalog and optional
  recommendation. The first read is **not** expected to become instant.
- Later reads with an empty catalog selection recheck the exact assignment,
  retained context metadata, subject, and both current market-data permissions
  before serving the derived row. Private CSV contexts retain the original path.
- A current selection revision is rebound only after the immutable row passes
  its digest and context checks. An opening map and statistics are recomputed
  from the existing prepared numeric/map row for the exact requested group
  union. All groups, recommended area, and explicit group IDs remain distinct.
- No prepared row grants access, changes a report, signs a result, or replaces
  original evidence. Failure to prepare an optional row leaves the first
  authorized response intact; a corrupt row refuses delivery.
- Catalog format version 1 is bound to v3 catalog/recommendation semantics.
  Any incompatible grouping or scoring change must use a new read-model format
  rather than silently reusing an older prepared row.

Production verification should compare the first and subsequent saved opening
for the same file/context/revision, including selected parcel counts, medians,
COD/reliability, selected geometry, and market-observation period. Inspect
both the server time and the browser's end-to-end load. The 4 MB public catalog
and 39 MB combined opening transport ceilings remain in force. The next speed
step, if first-time captures still delay the appraiser, is to prepare the
context-specific catalog ahead of the first browser reopen, separately from the
nightly city/subdivision source index.
