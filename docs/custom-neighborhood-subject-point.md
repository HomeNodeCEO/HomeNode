# Retained Custom subject search point

`createCustomCohortSubjectRepository(client, scopeJson).loadRecordedPoint(ref)`
loads and verifies the same tenant/file-scoped immutable original subject blobs
as `load(ref)`. It does not query current account locations or accept an editor's
replacement coordinates. Existing caller-owned transaction, access, deadline
and final freshness requirements remain in effect.

The point is represented only for an exact single-parcel, high-confidence DCAD
centroid with positive address agreement, no outstanding review flags, matching
account/snapshot identities, supported unchanged coordinates and consistent
recorded capture/geocode/source chronology. Unsupported or missing data returns
`review_required` with a reason and no geometry. Null source update time remains
explicitly unknown. No point is rounded, geocoded, axis-swapped or silently
substituted. The point's `source_sha256` identifies the retained original snapshot
row wrapper, not a reconstructed source document. Explicit PostgreSQL timezone
offsets are interpreted as UTC for chronology comparisons while preserving the
original text and all six microsecond digits; no host timezone is assumed.

This is a **recorded centroid**, not a newly verified original provider polygon.
The legacy location row does not retain the provider's rings/digest. The result
always states `authority: not_established` and
`provider_geometry_verified: false`. A private discovery/context issuer must
still establish current access, source admission, the complete three-mile parcel
roster, and coherent cohort, boundary and statistics application. This adapter
adds no HTTP route or live issuer and makes no existing report or map change by
itself.

Tests cover coordinate/identity/source/chronology failures, exact retained hashes,
native PostgreSQL capture/load, cross-organization denial and preservation after
a newer snapshot. Production acceptance and the private issuer remain separate.
