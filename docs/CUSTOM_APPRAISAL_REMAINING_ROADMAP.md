# Custom Appraisal Remaining Roadmap

Status: ordered from the production codebase at commit `cbdf1f9`.

The following foundation is complete: persistent and finalizable assignment
files, unique report identity and history, production PDF artifacts, Cost and
Income approaches, final reconciliation, secondary comparable evidence,
document-evidence baseline, E&O checks, and the guarded shared Custom
Appraisal-to-UAD 3.6 completion adapter.

## Next — production document intelligence

Shared photo evidence is now on the production path: mobile capture keeps
original and display files offline until verified private upload succeeds, and
the desktop Property Report can add files to the same report-scoped gallery.
The remaining document-intelligence work below uses the same private-storage
and evidence-retention boundary.

1. Move immutable source-document bytes from PostgreSQL to the existing private
   Cloudflare R2 pattern while retaining metadata, checksums, extracted pages,
   candidates, review decisions, and audit history in PostgreSQL.
2. Add a production OCR adapter for scanned or image-only PDFs currently marked
   `ocr_required`.
3. Expand reviewed extraction/autofill coverage for engagement letters,
   contracts, MLS sheets, zoning maps and ordinances, maps, and other appraisal
   evidence. No extracted value becomes authoritative without appraiser review.
4. Add operational telemetry, bounded retry/recovery, and acceptance fixtures
   for both text-layer and scanned documents.

This is the next feature-development phase. The related real-file checks belong
in `docs/TESTING_PRIORITIES.md` and do not block implementation unless they find
a P0 defect.

## After document intelligence

1. **Live listing/media ingestion:** activate the prepared Trestle/RESO pipeline
   when the contract and credentials exist; retain CSV import as a controlled
   fallback and use stable listing identifiers for idempotent upserts.
2. **Location and neighborhood production coverage:** finish source coverage,
   backfills, freshness monitoring, and cross-market accuracy for roads, flood,
   zoning, parcel geometry, and external influences while retaining last-known
   good data during provider outages.
3. **Production acceptance and release hardening:** complete the queued signed
   report, Custom/UAD bridge, zoning, neighborhood, scraper, and physical-device
   test matrices; promote only material failures into blocking repair work.

Mobile field development and the UAD editor continue as separate workstreams.
They share canonical assignment identity and reviewed evidence, but neither
should stall this Custom Appraisal roadmap.
