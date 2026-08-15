# Dallas County Zoning Validation

This checklist keeps municipal zoning validation separate from the location-
influence backfill. Testing a zoning source must not trigger a countywide GIS
refresh or interrupt the scheduled influence worker.

## Source inventory

HomeNode registers every Dallas County municipality exactly once.

- Automated official GIS (20): Balch Springs, Carrollton, Cedar Hill, Coppell,
  Dallas, DeSoto, Duncanville, Farmers Branch, Garland, Grand Prairie,
  Grapevine, Irving, Lancaster, Lewisville, Mesquite, Richardson, Sachse,
  Sunnyvale, Wilmer, and Wylie.
- Manual review with a cacheable official PDF (6): Cockrell Hill, Ferris,
  Glenn Heights, Highland Park, Ovilla, and Seagoville.
- Manual review with an official interactive/reference page and city contact
  (5): Addison, Combine, Hutchins, Rowlett, and University Park.

The runtime registry in `src/services/propertyZoningSources.js` is the source
of truth. A city must not be promoted to `automatic` until its official public
polygon service and zoning fields have been verified.

## Automated GIS test

For at least one subject in every automated jurisdiction:

1. Confirm the account city is correct before reviewing zoning.
2. Open **Review Zoning Evidence** on the Property Report.
3. Verify the provider label names the same municipality as the account city.
4. Compare the returned code and description with the city's official map at
   the subject point.
5. Verify the stored source record, original attributes, source date, and sync
   date are present.
6. Test a subject near a municipal boundary or overlapping planned-development
   polygon. The result must still use only the provider registered for the
   account city.
7. Record pass, mismatch, no coverage, or ambiguous overlay. Do not silently
   replace an ambiguous result with a guessed code.

Initial known sample: `26272500060150000` (1909 Snowmass Ln, Garland).

## PDF/manual-review test

For each of the six cached official PDFs:

1. Confirm the PDF selector, official-source link, cache date, page count, and
   checksum are visible.
2. Confirm the embedded viewer renders the stored PDF without depending on the
   city website being online.
3. Enter a zoning code that is visibly present in the document and run
   **Prefill Exact Wording from PDF**.
4. Verify the suggestion is verbatim, page-cited, and remains unconfirmed.
5. Confirm that a blurry or image-only map returns a review warning instead of
   invented text.
6. Verify the city planning/building contact is displayed.
7. Save a test verification only with a named reviewer, then reopen the report
   and confirm the source type, document, page, wording, and reviewer persist.

Initial known sample: `60003000040090500` (4500 Abbott Ave, Highland Park).

## Interactive/manual test

For Addison, Combine, Hutchins, Rowlett, and University Park:

1. Confirm the report says review is required and does not imply automatic GIS
   coverage.
2. Verify the official resource link and current city contact are visible.
3. Confirm the appraiser can save a city-confirmed or interactive-map result
   with a zoning code, verbatim description, reviewer, and confirmation
   reference.

## Acceptance criteria

- Automated zoning is restricted to the subject municipality's provider.
- No source outage removes the last successfully cached GIS or PDF evidence.
- Machine-extracted wording never becomes appraiser-confirmed automatically.
- Every confirmed value retains its source and reviewer provenance.
- Unsupported, unreadable, uncovered, and conflicting results are visibly
  routed to review.
- Zoning/current-use mismatch flags use the confirmed or correct city-specific
  result, never a neighboring municipality's polygon.

