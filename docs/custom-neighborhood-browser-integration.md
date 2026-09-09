# Custom neighborhood observation transport

The dedicated `createCustomNeighborhoodCohortRouter` factory connects the actual
retained-context owner to compact browser presentation. It is deliberately not
mounted in production yet. Mount it only behind the existing authenticated/CSRF
application boundary, with an explicitly configured market-source policy. This
change does not replace global authentication, rate limiting, parsers, signing,
or the legacy neighborhood/report workflows.

The URL uses the report's exact canonical account ID. The owner verifies that ID
and the exact text assignment-file ID against authorized database rows. There
are no unbounded pre-authorization alias/catalog queries. Numeric assignment IDs
are rejected to avoid rounding PostgreSQL bigint identities.

## Requests

All operations are POST under `/api/accounts/:id/neighborhood-cohort/`, with an
exact JSON object and a four-million-byte body ceiling:

- `capture`: `assignment_file_id`, `operation_id`, `observation_period`.
- `preview`: `assignment_file_id`, `context_ref`, `selection`, `include_map`.
- `members`: `assignment_file_id`, `context_ref`, `selection`, `population`, `page`.

The authenticated principal comes only from existing server middleware. Body
authorization, organization IDs, arbitrary source rows and source grants are not
accepted. Aborted/disconnected requests cancel the coordinator. Responses are
`no-store`; errors disclose fixed public codes, never SQL/provider diagnostics.
An uncertain commit requires retrying the same operation ID, not inventing a
new operation. Parser error handling is scoped to these routes.

## Coherent display and inspection

`.present(input, { includeMap }, options)` uses the same full retained numeric
consumer as internal `.preview`, but returns bounded summaries instead of all
member rows. `.inspect(input, { population, page }, options)` returns a bounded
member page. It never decodes or returns geometry. Both project outside a checked
out database connection and **before** the final current target/material/source
policy check. The source policy receives `retention: true` plus an explicit
`report_observation_summary` or `report_observation_members` exposure purpose.

The returned target, context, selection revision and content fingerprint bind
the display together. On an unchanged context, `include_map: false` skips geometry
decoding/transmission; it is not permission to reuse a map from another context.
An empty selection remains empty. Full-population statistics always use all
retained members; paging changes only what is displayed, not the denominator.

The browser controller cancels superseded work, debounces pocket changes, and
ignores late responses. It retains prior map/statistics only as one visibly stale
group, clears it when target/context changes, and never retries automatically.
The existing generic `fetchJSON` replaces caller AbortSignals, so the dedicated
transport must use the existing authenticated fetch boundary directly instead.

## Verification and limits

The actual PostgreSQL/PostGIS test now traverses HTTP -> exact authorized target
-> retained originals -> compact statistics/member pages. It checks complete
statistics against the internal preview, exact cached geometry, omitted geometry,
exposure denial, no raw-source fields and foreign-context refusal. Separate
router tests cover input limits, bigint identity, cancellation and error handling.

These are current captured observations, not verified individual-property sale
consideration, complete provider coverage or historical fact support. COD is
dispersion, not reliability. No report fields are written or made eligible for
Apply by these endpoints. Production policy configuration, recommendation and
review UI, supported publication/Apply, and real-property acceptance remain
separate implementation work.
