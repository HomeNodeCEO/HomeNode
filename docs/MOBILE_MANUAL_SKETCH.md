# Mobile manual sketch workspace

Status: Phase 6 implements manual measurement, durable offline drafts, server
revision history, room markers, and room-derived photo labels. LiDAR capture and
final sketch image/PDF rendering remain deferred.

## Field workflow

1. Open an inspection session for an existing typed report file.
2. Create one or more measured areas by entering each wall length and bearing.
   Lengths are entered and displayed to 0.1 foot.
3. Close each outline. HomeNode calculates closure, self-intersection, perimeter,
   centroid, exact area, and reported whole-square-foot area.
4. Classify each area independently. Above-grade finished, nonstandard finished,
   noncontinuous finished, unfinished, below-grade, garage, porch, patio, deck,
   outbuilding, and other areas never collapse into one total.
5. Add stable room markers inside a closed area. Selecting a marker makes its
   room name the automatic label for newly captured photos.
6. Save to encrypted SQLite at any time. A network connection is not required.
7. Confirm appraiser review only after every area is closed and valid. Confirmation
   records the reviewing HomeNode user and time; it is not inferred from geometry.

The standard selector defaults to ANSI Z765-2021. When a jurisdiction requires
another standard, the appraiser must select that option and name the standard.
HomeNode does not represent a closed polygon as proof of ANSI compliance. Grade,
access, ceiling height, finish, stairs/openings, declarations, and exceptional
property treatment remain professional judgments documented by the appraiser.

Current policy references:

- Fannie Mae Selling Guide B4-1.3-05:
  <https://guide-selling.fanniemae.com/sel/b4-1.3-05/improvements-section-appraisal-report>
- Fannie Mae Standardized Property Measuring Guidelines FAQ:
  <https://singlefamily.fanniemae.com/media/30266/display>
- Fannie Mae UAD 3.6 Selling Guide Supplement:
  <https://singlefamily.fanniemae.com/media/42571/display>

## Persistence and version safety

`app.inspection_sketches` stores the current sketch for one inspection session.
It belongs to the session's existing report file and workflow; sketching cannot
create, replace, or cross-link a Custom Appraisal, UAD 3.6, or Property Tax
Protest file.

Every accepted save:

- requires the device's base sketch revision;
- uses a client operation UUID for idempotent retry;
- appends an immutable row to `app.inspection_sketch_history`;
- appends sketch, inspection-session, and report-file audit events;
- increments the report-file registry revision; and
- leaves the inspection field-edit revision stream unchanged.

If HomeNode changed after the device's base revision, the local draft is
preserved in an explicit conflict state. The appraiser can adopt the server
version or deliberately retry the device version against the newly observed
revision. There is no last-write-wins overwrite.

The mobile SQLite database stores one sketch draft per user/session with
pending, synchronizing, synchronized, failed, and conflict states. Interrupted
synchronization is recoverable after restart and retry uses bounded backoff.

## Room and photo linkage

Room references have the stable form `sketch-room:<room UUID>`. The photo API
accepts a sketch-room reference only when that active room belongs to the same
inspection session. It ignores a stale device label and uses the authoritative
server room label.

Renaming a room updates the category, room label, and room-generated caption of
its linked active photos. A caption manually edited by the appraiser is retained.
Deleting a marker soft-deletes the room record for history and prevents new
photos from using that marker; retained appraisal-file photo evidence is not
deleted.

## API

- `GET /api/mobile/inspection-sessions/:id/sketch` returns the current sketch,
  calculated summary, active room markers, and linked photo counts.
- `PUT /api/mobile/inspection-sessions/:id/sketch` validates and saves a full
  manual-sketch document with `client_operation_id`, `client_sketch_id`, and
  `base_revision`.
- `POST /api/mobile/sketches/calculate` remains available as a stateless polygon
  calculator.

The existing Custom Appraisal property report exposes the latest mobile sketch
as a read-only review card. Accepting mobile property observations and editing a
sketch are separate operations.

## Deferred work

- Render a report-ready sketch image/PDF with full dimension and area labeling.
- Add desktop relabel/reorder and geometry review tools.
- Run physical-device usability testing on representative simple, irregular,
  multi-level, below-grade, and nonstandard properties.
- Add LiDAR as an optional measurement source without making it authoritative.
- Complete the separate UAD 3.6 credential, certification, and submission work
  before any production UAD delivery.
