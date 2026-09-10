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

## Recorded evidence in pocket review

Mapping4 recommendations now include an optional `cad_recorded_evidence` summary
for the complete discovery population and every recorded pocket. It is descriptive
context, not an additional similarity factor. Existing mapping2/3 recommendations
and their public presentations retain their original output when the extension is
absent. The producer still defaults to mapping2.

Each of the five fields partitions **all unique accounts** into observed, partial,
missing, and conflicting states. Multiple parcel rows do not inflate an account's
count for a particular literal. The distribution retains exact typed observations,
including blank text, null, and boolean false. An account with multiple different
observations can appear in multiple literal categories; these are not exclusive
housing-type percentages. An account with no parcel observation stays in the
missing denominator rather than disappearing from the population.

Comparison with the subject uses an exact literal only when both accounts have
complete, non-conflicting observations and the same exact recorded county. A
partial subject observation is displayed as partial and does not support a
comparison. Matching codes or descriptions do not establish comparable housing
types, competitive eligibility, historical validity, or report-ready statistics.
The unknown housing-type scoring weight remains unknown. Numeric observations,
weights, scores, rankings, suggestions, selections, and report facts do not change.

The public presenter validates context/capture binding, fixed field meanings,
account/record denominators, every pocket, cross-pocket totals, and complete
distribution totals before exposing the extension. It does not expose account
lists, private subject material, raw MLS witnesses, or source identities. Distinct
literal and byte limits produce an explicit unavailable-details disposition,
never a shortened list presented as complete. If necessary, the overall 512 KB
recommendation budget first omits all distribution details; if the fixed summary
still cannot fit, the whole evidence extension explains its display limit while
the original complete recommendation remains intact.

The experimental pocket inspector presents these details in a collapsed section.
Opening it makes no new request and changes no selection. Missing data and display
limits are distinct states; neither is reported as zero or confirmed absence.

## Remaining integration

The default producer and deployment flags are unchanged. Before selecting this
profile for new Custom captures, the subsequent integration must install explicit
field-meaning and effective-date rules, account for conflicts and unavailable
values, and join automatic baseline evidence with exact reviewer corrections.
Accepted boundaries, selected populations, statistics, and evidence must still
be published and applied together. The optional mapping4 recommendation field is
an additive response extension, not a new route. No schemas, source-policy grants,
report calculations, authentication, signing, or other report workflows change.
