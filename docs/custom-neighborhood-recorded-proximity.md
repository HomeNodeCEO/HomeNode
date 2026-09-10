# Recorded parcel proximity for Custom neighborhood recommendations

This additive recommendation version uses the subject location and parcel geometry
already retained with the exact study. It does not fetch GIS, change the captured
roster, alter accepted report statistics, or select pockets for the appraiser.

## Measurement and interpretation

- PostGIS measures spheroidal straight-line distance from the recorded subject
  centroid to a representative point inside each retained parcel polygon.
- This is not driving distance or a surveyed distance between buildings.
- A single parcel with one polygon component can receive a proximity score.
  Multiple parcels or disconnected components remain unknown for scoring; an
  internal distance range describes their ambiguity without choosing one.
- Invalid geometry and unavailable geometry remain unknown. They are not removed
  from the account denominator or converted to a zero-distance observation.
- The distance curve uses the exact saved 3-, 5-, or 10-mile study radius. Changing
  a pending dropdown, map zoom or viewport cannot change an existing score.

The weights remain GLA 40%, age 30%, housing type 20%, and one third of the
remaining 10% each for site size, proximity and sale price. This version adds
supported recorded proximity only. It does not infer housing type or sale-price
meaning from unrelated CAD fields. Similarity bounds and observed-weight coverage
are review aids, not a reliability certification or an appraisal conclusion.

## Compatibility and ownership

The prior pure scorer remains version 1 when proximity is omitted; complete
previous result hashes are regression-tested. The authenticated Custom catalog
owner explicitly requests the version-2 policy only for a complete current-stock
catalog. Retrospective stock restrictions remain unchanged. Ordinary catalog,
selection preview, member reads and report Apply do not request native distances.

The derivation accepts original retained EWKB, subject geometry and context only.
It validates their existing hashes and bindings, then issues an owner-internal
result. Cloned, cross-context and subsequently mutated inputs cannot reuse that
result. The public catalog carries aggregate coverage and measurement basis, not
per-account distance rows, source identities or private geometry.

The owner keeps authorization before retained loading and after computation. A
separate bounded read-only transaction performs native work in batches of at most
64 parcels and 2.1 MB encoded parameters. Existing request deadlines, statement
timeouts and capacity limits still apply. SQL failure aborts the request, rolls
back the transaction and publishes no partial recommendation. A subsequent
explicit retry can recover without modifying accepted report content.

## Verification and remaining work

Tests cover legacy output parity, the three saved radii, ambiguous and invalid
locations, zero and out-of-radius distances, complete denominators, bounded
batches, stale results, checked frontend coverage, and the displayed explanation.
The native integration test uses a fresh synthetic database and real PostGIS to
check a four-mile parcel, authorized catalog composition, post-computation rights
revocation, genuine statement-timeout recovery and unchanged accepted reports.
It is explicitly registered in the migration CI suite.

This change does not activate production source grants or configuration. Citywide
analytical capture, fine housing-type evidence, historical stock coverage and
live-property acceptance remain separate work. Recorded names are not legal
subdivision or phase boundaries; city reference outlines do not enlarge a study.
