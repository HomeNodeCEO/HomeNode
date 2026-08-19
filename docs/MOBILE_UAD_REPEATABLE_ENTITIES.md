# Mobile UAD repeatable entities

Status: Phase 10 adds offline creation/removal proposals for repeatable entity
types already defined by HomeNode's locked UAD 3.6 field catalog. It does not
change Custom Appraisal, Property Tax Protest, or UAD submission credentials.

## Workflow and authority

PostgreSQL remains authoritative. The mobile application caches the current UAD
entity catalog and workfile entities in SQLCipher-encrypted SQLite. A mobile
addition or removal first receives a client operation UUID and enters a durable
device queue. Connectivity submits an idempotent proposal; it does not directly
change the workfile.

The appraiser must explicitly accept or reject each server proposal. Acceptance
locks the selected inspection session and UAD workfile, applies the official
entity rules, creates a full UAD revision, appends UAD and report-file audit
events, and increments the selected report file registry revision.

Deletion proposals contain the complete entity snapshot visible on the device.
Acceptance compares that snapshot to the current PostgreSQL record. A missing or
changed entity becomes a visible conflict and is never silently deleted. A
conflict may be rejected; a new deletion must be captured from refreshed data.

## Supported catalog

The API publishes JSON-safe metadata derived directly from
`UAD_REPEATABLE_ENTITY_GROUPS`; it does not maintain a second list of invented
mobile entity types. This includes site details, energy/green components,
dwelling child records, units, levels, rooms, interior/exterior defects,
outbuildings, vehicle storage, amenities, and market price-trend sources.

Parent relationships, minimum/maximum counts, amenity categories, and disabled
creation rules are revalidated inside the acceptance transaction. The existing
initial dwelling cannot be added from mobile because its canonical group has
`createEnabled: false`.

The mobile catalog automatically exposes the official sales-comparable creation
variant and its repeatable child groups from the shared UAD field catalog. New
comparables receive the same calculated ordinal initialization used by the web
workflow. The capability response advertises
`comparable_creation: "official_catalog"`; comparable selection and analysis
continue to use the shared report data and review workflow.

## Persistence

Migration `20260831_mobile_uad_entities.sql` adds:

- `app.mobile_uad_entity_proposals` for idempotent create/delete intent, base
  revision, exact deletion snapshot, status, conflict, and applied revision;
- `app.mobile_uad_entity_review_operations` for retry-safe acceptance/rejection;
  and
- `app.mobile_uad_entity_events` for proposal lifecycle history.

The device database adds `uad_entity_review_cache` and
`uad_entity_proposal_queue`. Interrupted uploads return to a retryable failed
state on startup and use the same bounded backoff policy as other inspection
operations. Successfully submitted local requests leave the queue only after
the server returns an idempotent proposal result.

## API

Authenticated UAD-session routes:

- `GET /api/mobile/inspection-sessions/:id/uad-entities`
- `POST /api/mobile/inspection-sessions/:id/uad-entities/proposals`
- `POST /api/mobile/inspection-sessions/:id/uad-entities/proposals/:proposalId/review`

All routes require managed OIDC, active HomeNode organization membership, and
ownership of the selected UAD inspection session. Mutations additionally
require an appraiser-capable role. Managed identity may remain disabled while
the migration and application code deploy; activation is a separate staging
configuration step.
