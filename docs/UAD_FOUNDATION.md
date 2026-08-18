# HomeNode UAD 3.6 foundation

HomeNode's UAD implementation is an isolated domain inside the existing React,
Node, and PostgreSQL application. It does not reuse or mutate the Custom
Appraisal `app.assignment_files` records, and it does not change Property Tax
Protest data.

## Compliance position

HomeNode may build and use its own appraisal software without selling it to
other appraisers. Fannie Mae and Freddie Mac do not endorse appraisal software.
The report data, XML, native PDF, images, and delivery package must comply with
the current UAD 3.6 specification and the lender's delivery workflow.

Production access to a GSE UAD Compliance API is a separate integration. The
GSE verification and credential process applies to production API access even
when the software is used internally. Local schema and Appendix H validation
remain part of HomeNode's application so work does not depend on a remote API
for every edit.

## Isolation

- `app_auth`: organizations, users, memberships, roles, appraiser credentials,
  and future supervisory relationships.
- `uad_ref`: immutable specification releases, fields, enumerations, and
  compliance rules.
- `appraisal`: UAD workfiles, snapshots, repeatable entities, field provenance,
  revisions, validation, assets, sketches, signatures, and audit events.
- `/api/uad`: modular API mounted from the existing Node service.
- `dcad-frontend/src/features/uad`: UAD-only frontend code.

The UAD API is off by default. Apply the migration and set
`UAD_WORKSPACE_ENABLED=true` only in the target environment after validation.

## Current editor scope

The editor currently implements Appendix A-1 v1.4 Sections 2 through 10:

- Assignment Information and Subject Property use isolated, context-aware UIDs.
- Site includes conditional zoning, mixed-use, access, utility, and defect
  questions plus repeatable parcels, influences, views, encumbrances, site
  features, utilities, and defects.
- Cross-record rules enforce parcel-count consistency and agreement between the
  site-defect indicator and defect records.
- Disaster Mitigation captures the official multi-select feature list, enforces
  the exclusive `None` state and `Other` description, and requires commentary
  whenever Section 5 displays.
- Energy Efficient and Green Features captures the three required known-feature
  indicators, repeatable renewable components, building certifications and
  efficiency ratings, impact to value/marketability, commentary, and Appendix
  H conditional rules.
- Sketch captures whether a sketch or floor plan is provided, the official
  ANSI/AMS/Other measurement standard, conditional commentary, verified report
  images, and private supporting measurement sources.
- All HomeNode-prefilled or automated values retain source provenance and stay
  unconfirmed until the appraiser saves them.

The Site migration expands the generic `appraisal.uad_entities` model rather
than creating one table per report grid. The same model supports the later
sales, rental, land, GRM, and analyzed-not-used comparable sections.

`GET /api/uad/workfiles/:id/shared-data` is the compatibility boundary with
the existing HomeNode services. It reads stored property context, official
zoning evidence, location influences, and neighborhood boundaries without
running a new analysis or changing a Custom Appraisal. Comparable search,
market conditions, and neighborhood automation remain disabled in the UAD UI
until their corresponding URAR sections and appraiser-review flow are ready.

## Staging strategy

The first staging gate is the `UAD foundation` GitHub Actions workflow. It
creates a disposable PostgreSQL 17/PostGIS database, installs a minimal
non-sensitive `core` contract, applies the UAD migration, verifies required
tables and roles, and applies the migration again to prove idempotency.

After the workflow is stable, create a separate Render `Staging` environment
with its own database and only sanitized fixture properties. Never connect a
staging service to `homenodedb`, and never copy owner/contact rows into staging.
Render preview databases are not the default because they require a Pro
workspace and incur per-preview resource charges.

The guarded staging bootstrap also creates empty compatibility relations used
by the shared HomeNode search tile and two synthetic value-summary rows. The
site-built SFR fixture includes a deterministic UAD workfile with a
representative Section 10 unit, area source, level, rooms, and interior
features while verifying that Section 9 remains hidden; the separate
manufactured-home fixture includes a deterministic UAD workfile whose Section 8
Construction Method is `Manufactured`, allowing Section 9 to be exercised
without changing the SFR or copying production tax, owner, or sales data. CI
runs the bootstrap twice and executes the same search joins to verify
idempotency and schema compatibility.

The Render UAD staging service must use `npm run start:staging:uad` as its
start command. This intentionally applies all additive UAD migrations before
seeding the deterministic fixtures, then starts the API. Reversing that order
can make a new fixture entity type fail against the previous release's database
constraint during a rolling deployment.

## Mobile photos and artifacts

Cloudflare R2 is the initial private object store. The Node API issues a
short-lived, single-object presigned `PUT` URL. A mobile client uploads directly
to R2 with the required content type and then asks the API to verify the object.
R2 credentials are never sent to the mobile client.

The web editor now uses the same upload contract planned for mobile: request a
URL, upload directly, then verify. Uploads are limited to 50 MiB, must match the
requested byte size and content type, and are rejected if object-store
verification does not match. Official Site image categories include property
access, property photo, influence, view, boundary, encroachment, waterfront,
and site exhibit. Sections 5 and 6 use their official
`DisasterMitigationExhibit` and `EnergyEfficientAndGreenFeaturesExhibit`
categories. Section 7 accepts UAD-compatible sketch or floor-plan images and
  keeps optional source JSON, PDF, or SVG files separate from the report image.
- Dwelling Exterior repeats by dwelling and captures structure/design,
  construction, exterior quality and condition, required feature details,
  noncontinuous finished rooms, mechanical systems, exterior defects,
  commentary, and verified front/rear/exhibit images. Child records retain the
  dwelling parent identifier needed for future multi-dwelling reports.
- Manufactured Home displays only for a dwelling whose Section 8 Construction
  Method is `Manufactured`. It captures installation and foundation details,
  skirting, structural modifications, HUD data-plate and certification-label
  information, eligible financing programs, new-construction invoices, and
  commentary. Required Section 9 images are private, verified R2 assets linked
  to the exact dwelling, HUD label, or program record.
- Unit Interior always displays and repeats by living unit or ADU. It captures
  the official area breakdown and sources, unit/ADU characteristics, levels,
  rooms, quality and condition, flooring, walls and ceilings, accessibility,
  defects, and commentary. Server validation reconciles level areas and room
  counts, requires the official feature rows, and requires verified images for
  each kitchen, bathroom, and reported physical interior defect. General,
  room, feature, and defect images use the same private R2/mobile contract and
  remain linked to their exact Section 10 entity.

Object keys are scoped by organization, UAD workfile, and asset UUID. PostgreSQL
stores the UAD section, entity, caption, capture metadata, checksum, byte size,
and verification state. It does not store the image bytes.

Sketch geometry, wall segments, dimensions, calculated areas, and appraiser
overrides are structured JSON in `appraisal.uad_sketches`. Web and future
mobile clients share `GET/PUT /api/uad/workfiles/:id/sketches`; payloads are
bounded, source-labelled, and may reference only a verified Section 7 rendered
asset in the same workfile. Report images and supporting measurement files are
private R2 assets, and obsolete asset records can be removed without touching
other appraisal workflows.

Required server variables are documented in `server/.env.example`.
Compliance credential ownership and onboarding gates are documented in
`docs/UAD_COMPLIANCE_API.md`; credentials are never committed to the repository.

## Applying the migration

Run only after it succeeds in CI and the target has a current backup:

```sh
cd server
npm run migrate:uad
```

The runner uses an advisory lock and records the migration checksum in
`app.schema_migrations`. A changed migration that was already applied is
rejected instead of silently rerun.
