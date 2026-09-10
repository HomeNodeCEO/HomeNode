# Custom neighborhood CAD evidence projection

The opt-in mapping4 reader retains five additional fields already stored in
`gis.dcad_parcels`: `class_code`, `class_description`, `use_description`,
`structure_type`, and `built_up`. This is an evidence-retention change, not an
automatic classification or a production activation.

## Source and meaning

The existing `propertyContextSync` importer obtains the four text fields from
DCAD `CLASSCD`, `CLASSDSCRP`, `USEDSCRP`, and `RESSTRTYP`. The importer has already
normalized that text; the capture retains the stored values, not original GIS
response bytes. Null, empty text, and boolean false are not interchanged.

The [official DCAD ParcelPublishing layer metadata](https://maps.dcad.org/prdwa/rest/services/Property/ParcelQuery/MapServer/4)
identifies these as property class code, property class, assessing use description,
and residential structure type (checked September 9, 2026). The published field
names alone do not establish a complete housing-code crosswalk.

`built_up` is the application's existing `isDcadParcelBuiltUp` derivation. It is
not a direct provider declaration, completed-home proof, or evidence of a home's
condition at a prior sale. The broader `one_unit` land-use category includes
several housing forms and does not establish a detached single-family home.

Current CAD floor area is still reported floor area, not independently verified
ANSI GLA. Stored parcel area is calculated from parcel geometry, not certified
deed area. Capture/synchronization timestamps do not establish characteristics at
an earlier appraisal effective date. The new fields change none of these limits.

## Compatibility and access

Mapping4 has its own installed reader and runtime access capability. It reuses
the exact mapping2 sales projection and market-data purpose, without mapping3's
MLS scalar witnesses. A mapping2 or mapping3 runtime capability cannot run the
mapping4 reader, or vice versa. The reader checks that the five columns exist
before reading source rows; it does not silently fall back to a narrower capture.

All four mapped roles carry mapping4 identities so the existing single-profile
capture contract stays coherent. Only the parcel raw projection gains fields.
Version-specific mapping and content hashes make this a genuine new capture;
existing mapping2 and mapping3 rows, query bytes, and retained dependency graphs
are not relabeled or rewritten.

Persistence and reopen reconstruct the mapping4 rows from their exact retained
raw projection. Observation, pocket, and decision preparation can read the new
capture, but retain their existing unknown eligibility and blocked-Apply states.
The existing v2 and v3 source-meaning interpreters remain version-specific; a
higher mapping number does not automatically authorize an older interpreter.

## Remaining integration

The default producer and deployment flags are unchanged. Before selecting this
profile for new Custom captures, the subsequent integration must install explicit
field-meaning and effective-date rules, account for conflicts and unavailable
values, and join automatic baseline evidence with exact reviewer corrections.
Accepted boundaries, selected populations, statistics, and evidence must still
be published and applied together. No schema, public API, source-policy grants,
report calculations, authentication, signing, or other report workflows change
in this slice.
