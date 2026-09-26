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
