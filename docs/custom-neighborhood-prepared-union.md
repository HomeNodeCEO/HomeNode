# Prepared Custom neighborhood selection

The nightly city/subdivision group index is a discovery aid, not the evidence
for a particular appraisal. Its current-CAD and stored-sale facts cannot replace
the assignment's effective-date-bound retained capture. A selected-area median
or COD must be recomputed from the individual members of the **union** of the
selected groups. Adding two group medians is not equivalent, and a sale linked
to overlapping groups must count only once.

For a successful, authorized report preview or catalog opening, the Custom
owner can now retain a derived immutable numeric index and parcel display map
in `app.neighborhood_custom_cohort_prepared_previews`. The numeric and geometry
payloads are compressed separately and stored without a selected-pocket state.
Subsequent selection previews request only
the numeric payload when the browser already holds the map geometry. The
browser restyles its validated map for the new selection; the server recomputes
Type-7 quantiles and descriptive COD from the underlying selected observations.
An existing prepared row is checked by key before optional write-through; its
large payload is not recompressed on each catalog opening. The repository also
supplies the verified member-table byte length so a pocket click need only
measure its changed response envelope, not serialize all immutable members.

Verified process-cache hits recheck the stored digest/length and PostgreSQL's
current SHA-256 of the compressed bytes, returning only this small metadata
instead of retransmitting the blobs. This preserves detection of damaged bytes
even when their saved text digest has not changed. It removes network copies
and application-side rehashing on hits, not database-side hashing. A mismatch
clears the hot entry and runs the original bounded decode and verification;
a missing row is never replaced by a process-cache value. Numeric-only hits do
not read or hash map bytes. The one-context, five-minute cache, 60 MB numeric /
24 MB map budgets, and 1 GB process-RSS admission guard remain unchanged.

Every read still checks exact assignment access, the immutable context header
and study/profile originals, market-source permission, effective date, and live
subject material. Private supplemental-sale captures currently use the original
full path. A missing prepared row also uses the original full path. Neither a
prepared row nor a low COD grants report Apply or establishes comparable-sale
eligibility, historical housing characteristics, or market reliability.

The first opening of an older file can still be slow: this read model is filled
by the first successful authorized opening or map preview. The catalog's
recommendation and original-evidence validation are not yet prepared for
instant saved-file reopen. Measure both the first load and later pocket clicks
separately before claiming an end-to-end speed target. Future versions must
change the read-model format version rather than reinterpret an existing row.
