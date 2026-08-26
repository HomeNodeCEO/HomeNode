# Maintainability optimization audit

Baseline: `f878b6a` (2026-08-26). This pass intentionally avoids authentication,
authorization, signed-snapshot canonicalization, existing migrations, UAD artifact
generation rules, and appraisal calculations.

## Measured improvements

| Measurement | Baseline | Optimized |
| --- | ---: | ---: |
| Initial JavaScript | 1,147,268 bytes | 238,061 bytes |
| Initial JavaScript (gzip) | 290.80 KiB | 76.85 KiB |
| Initial stylesheet | 522,517 bytes | 485,680 bytes |
| Initial stylesheet (gzip) | 69.82 KiB | 60.36 KiB |
| Checked-in archive/backup payload | ~31.1 MiB | 0 |

The frontend now enforces 300 KiB initial-JavaScript and 500 KiB initial-CSS
budgets in CI. Route chunks remain independently cacheable.

## Completed cleanup

- Lazy-load every top-level route instead of shipping all report workflows on the
  property-search landing page.
- Centralize Custom Appraisal file/query loading shared by Cost, Income, and Final
  Reconciliation pages.
- Reuse one typed numeric input component across the Cost and Income approaches.
- Remove unused Quill and Leaflet CSS; neither library or its generated class names
  exists in the current frontend.
- Remove obsolete source backups, `.bak` files, and ad-hoc ZIP archives; ignore them
  in Git and the scraper Docker context going forward.

## Deferred opportunities requiring their own parity work

1. `PropertyReport.tsx`, `ComparableSalesAnalysis.tsx`, `oldServer.js`, and the UAD
   editor remain the largest modules. Split them by domain only with route/component
   behavior tests because they contain substantial stateful workflows.
2. `base44-main.css` remains about 494 KiB of source CSS. Selector-level removal
   needs screenshot/print parity coverage before it is safe.
3. Sales search returns a broad enriched record contract. A summary projection could
   reduce payloads, but must be introduced as a versioned API response and verified
   against every grid, map, analysis, and export consumer.
4. Spatial and market queries should be profiled with `EXPLAIN (ANALYZE, BUFFERS)`
   against a production-shaped PostGIS dataset before adding indexes or rewriting
   joins. Do this in a new migration after the authentication integration settles.
5. The monolithic legacy server can be decomposed further after session middleware
   and organization authorization stop changing, avoiding conflicts in the current
   authentication rollout.

## Validation evidence

- Server: 820 tests, 815 passed, 5 skipped, 0 failed.
- Mobile: TypeScript check passed; 33 tests passed.
- Frontend: production build, bundle budgets, and all five regression scripts passed.
- Scraper: compile check and all 38 regression/security tests passed.
- Targeted ESLint passed for every changed TypeScript/TSX module.

Database integration and migration suites require their PostGIS service and should run
in the pull-request CI before merge. No production deployment or merge is part of this
branch.
