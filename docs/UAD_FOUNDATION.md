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

The editor currently implements Appendix A-1 v1.4 Sections 2 through 21,
Sections 22A-22Q of the Sales Comparison Approach, Section 26 Reconciliation,
and Section 29 Certifications and Scope of Work:

- Assignment Information and Subject Property use isolated, context-aware UIDs.
- Site includes conditional zoning, mixed-use, access, utility, and defect
  questions plus repeatable parcels, influences, views, encumbrances, site
  features, utilities, and defects. A Body of Water influence owns repeatable
  water bodies and permanent waterfront features, including private-access,
  access-depth/right, development-rights, total-frontage, and required-photo
  controls that redisplay in Section 22D.
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
- Functional Obsolescence captures the exact functional-issue enumeration,
  enforces an exclusive `None` selection, requires the 33-character `Other`
  description and issue commentary when applicable, and accepts optional image
  exhibits without treating them as a UAD photo requirement.
- Outbuilding, Vehicle Storage, Subject Property Amenities, Overall Quality and
  Condition, and Highest and Best Use use official conditional fields,
  repeatable records where required, cross-section reconciliation, and verified
  exhibits without duplicating the same appraisal fact.
- Market captures the appraiser's market boundary and search criteria, active,
  pending, and closed-sale metrics, price-trend sources, graph or commentary
  support, supply, marketing time, and optional exhibits. Existing HomeNode
  boundary and market tools remain suggestions behind the shared-data adapter.
- Project Information displays only when Section 3 classifies the subject as a
  PUD or as a condominium, cooperative, or condop. It captures repeatable data
  sources, common amenities, included utilities, project/unit information,
  project factors, incomplete components, up to four ordered cooperative
  blanket-financing liens, commentary, and verified project exhibits. PUD and
  project classifications are mutually exclusive, and calculated or constant
  XML values are registered separately from appraiser-entered fields.
- Subject Listing Information applies a minimum one-year lookback and captures
  either every source used to determine that no relevant listing exists or up
  to six current/relevant listing records. The server reconciles dates with
  per-listing DOM, total DOM with the listing rows, and unique listing IDs.
  Existing HomeNode property activity is exposed only as source-attributed,
  reviewable suggestions and never silently becomes appraiser-confirmed UAD
  data. Optional listing exhibits use the shared private R2/mobile contract.
- Sales Contract captures the active-contract decision, contract review,
  arm's-length conclusion, price/date/transfer terms, personal property, and
  the official financial-concession decision hierarchy. Conditional analysis
  explains unavailable contracts or conveyed personal property. Hidden values
  and verified exhibits cannot survive a conflicting No answer, and the same
  private R2/mobile artifact contract supports optional contract exhibits.
- Prior Sale and Transfer History captures the subject's three-year transfer
  history as repeatable sale/deed records with linked data sources, amount or
  unavailable-reason reconciliation, and required analysis. Comparable
  histories share the reserved `sales_comparable` entities that Section 22 and
  the comparable-search adapter will populate, avoiding duplicate records and
  preserving the official one-year comparable lookback workflow.
- Sales Comparison Approach now captures the official approach indicator and
  repeatable general and project information for each canonical sales
  comparable: address, source relationships, proximity,
  listing/contract/sale facts, financing, concessions, dates, property rights,
  PUD/project classification, project identity, monthly fee, special
  assessment status, common amenities/services, site ownership and size,
  hazard zones, access, restrictions/easements, site characteristics,
  location influences, environmental conditions, views, and applicable
  adjustment columns. Section 22D extends each Body of Water influence with
  repeatable bodies of water, the required private-access decision, conditional
  access depth, optional names, repeatable permanent waterfront features,
  development rights, total linear frontage, and the typed Water Frontage
  adjustment. Section 22E adds repeatable comparable dwellings with their own
  year, design, unit count, noncontinuous area, townhouse attributes, and style.
  Construction methods, heating systems, and cooling systems remain child
  records of the exact dwelling. Property-wide building area, volume, window
  area, functional issues, disaster mitigation, and all sixteen typed dwelling
  adjustments stay on the canonical comparable. Section 22F redisplays the
  subject's canonical Section 6 renewable-component, building-certification,
  and efficiency-rating facts, while storing the corresponding comparable
  indicators and repeatable child records under the canonical comparable. Its
  typed adjustment context deterministically maps to
  `EnergyEfficientAndGreenFeatures`. Section 22G redisplays the subject's
  canonical Section 10 unit facts and adds comparable dwelling/outbuilding
  structures, their living units, accessibility features, bedroom/bath/area
  facts, and thirteen typed adjustment rows. Unit, ADU, dwelling, and
  per-structure counts reconcile against the saved hierarchy; dwelling
  structure identifiers are required for multiple primary units, while unit
  identifiers are required for multiple primary units or any ADU. Sections
  22H-22N capture exterior and interior ratings/components, ADU interiors,
  overall quality and condition, amenities, vehicle storage, outbuildings, and
  typed adjustments on those same records. Section 22O calculates the grid
  summary, Section 22P captures comparable reconciliation, and Section 22Q
  records additional properties analyzed but not used. Each included comparable
  requires a verified entity-linked Property Photo.
- Reconciliation reads the same canonical Sales, Income, Cost, and defect
  records used by their owning sections. It captures final value, effective
  date, value conditions, exposure time, optional client-requested conditions,
  and server-calculated itemized repair totals without duplicating analysis.
- Certifications and Scope of Work captures only assignment-specific additions
  to the predefined URAR language, prior services, intended users, and the
  inspection certification. Appendix H inspection inconsistencies are warnings;
  missing required certification data remains fatal. Signing uses the existing
  OIDC identity mapping and freezes company, license, appraiser, execution date,
  workfile digest, and credential digest per revision. Later profile changes do
  not mutate a signed report.
- System and package metadata is generated server-side from a locked HomeNode
  software profile plus the immutable workfile revision. The 12 required
  software, service, document-classification, appraisal-version, and embedded
  PDF-reference data points are cataloged as `system_package`, never exposed as
  appraiser-editable facts, and bring the delivery mapping to 857 unique IDs.
- All HomeNode-prefilled or automated values retain source provenance and stay
  unconfirmed until the appraiser saves them.

The Site migration expands the generic `appraisal.uad_entities` model rather
than creating one table per report grid. The same model supports the later
sales, rental, land, GRM, and analyzed-not-used comparable sections.

`GET /api/uad/workfiles/:id/shared-data` is the compatibility boundary with
the existing HomeNode services. It reads stored property context, official
zoning evidence, location influences, and neighborhood boundaries without
running a new analysis or changing a Custom Appraisal. Comparable search and
influence-driven automation remain disabled in the UAD UI until their
corresponding URAR sections and appraiser-review flow are ready. Sections 17
through 22G now expose the manual market, subject-listing, sales-contract,
prior-transfer, comparable-general-information, comparable-project, Site,
private-water-frontage, comparable-dwelling, and comparable energy/green
workflows behind that boundary.
Existing HomeNode sale
and deed activity is available through a
review-only Section 21 adapter. Automatic comparable searches and imports stay
disabled until the explicit appraiser-review interaction is implemented; they
will target the canonical Section 22 records and source children already in
place.

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
features, a deterministic Section 11 `None` answer, Sections 12-17 fixtures,
a deterministic Section 18 PUD with data source, amenity, utility, dues, and
project-factor answers, a deterministic Section 19 MLS listing with date/DOM
reconciliation, a deterministic Section 20 arm's-length purchase contract with
known concessions, a deterministic Section 21 subject prior sale with a linked
  deed source, and one Section 22A-22G settled PUD comparable with MLS provenance,
monthly dues, special-assessment status, a common amenity, deterministic
site/access/influence/view records, private lake frontage with a dock, and one
site-built dwelling with construction, heating, cooling, functional-issue, and
  disaster-mitigation records, renewable component, green certification,
  efficiency rating, one reconciled primary living unit with accessibility and
  area details, and representative typed adjustments. The comparable
intentionally lacks its required verified photo so staging exercises
the web/mobile upload gate rather than representing a nonexistent R2 object as
verified. Section 9 remains hidden; the separate
manufactured-home fixture includes a deterministic UAD workfile whose Section 8
Construction Method is `Manufactured`, allowing Section 9 to be exercised
without changing the SFR or copying production tax, owner, or sales data. CI
runs the bootstrap twice and executes the same search joins to verify
idempotency and schema compatibility.

The Render UAD staging service must use `npm run start:staging:uad` as its
start command. This intentionally applies all additive UAD migrations, then all
additive mobile migrations, before seeding the deterministic fixtures and
synthetic mobile appraiser. It then preflights OIDC discovery/JWKS when mobile
inspection is enabled and starts the API. Reversing the migration order can make
a new fixture entity type fail against the previous release's database
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
- Functional Obsolescence always displays as a property-level Section 11. Its
  controlled issue selections and commentary map directly to the UAD 3.6
  `FUNCTIONAL_ISSUE` and `PROPERTY_DETAIL` paths. Optional exhibits use the
  same verified private R2/mobile contract but do not affect completion.
- Project Information uses `ProjectAmenity`, `ProjectDeficiency`, and
  `ProjectExhibit` image categories. Amenity images remain linked to the exact
  repeatable amenity; deficiency and general project exhibits remain at the
  workfile level. An observed physical project deficiency requires a verified
  image before Section 18 can be saved.
- Subject Listing Information uses the optional `SubjectListingExhibit` image
  category at the workfile level. Listing evidence is image-only in the report
  asset contract and cannot be linked to a different section or entity.
- Sales Contract uses the optional `SalesContractExhibit` image category at the
  workfile level. Uploads require an active contract and a caption; saved images
  remain visible for removal when the contract answer is changed to No.
- Prior Sale and Transfer History uses the optional
  `PriorSaleAndTransferHistoryExhibit` image category at the workfile level.
  Uploads are image-only and require a descriptive caption.
- Sales Comparison Approach requires one verified `PropertyPhoto` linked to
  each canonical sales comparable and permits optional workfile-level
  `SalesComparisonApproachExhibit` images. Both use the same private R2 upload
  and verification contract that the mobile capture client will call.
- Section 29 accepts only verified PNG, JPEG, or WebP signature assets. The
  image is optional for MISMO execution-date delivery and reserved for the
  native report renderer; signing itself requires an authenticated assigned
  appraiser or supervisory-appraiser session.

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
