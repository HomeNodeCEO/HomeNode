# Bounded topology query startup

The topology builder now uses `SET LOCAL jit=off` inside its existing repeatable-read, read-only transaction. Geometry SQL, source attribution, result hashes, admission limits, and 5-second statement/6-second client query budgets are unchanged. The setting ends with the transaction; no PostgreSQL server or pooled-session defaults are changed.

## Evidence and limits

PR703's unrelated retention-audit check twice timed out on the pre-existing four-side square fixture. Both CI PostgreSQL logs identify `neighborhood-topology:build` as the timed-out statement. Its test returned `source_query_unavailable`, correctly withholding an incomplete result.

Read-only profiling of the exact generated square statement on the owned synthetic PostgreSQL17 test database measured an estimated plan cost of15,272,434 for only10 result rows. After warmup, actual interpreted execution was approximately2–3ms, with matching result hashes across all four runs. The local Windows database has no JIT provider, so those measurements do **not** directly establish LLVM compilation time on CI or production.

[PostgreSQL documents](https://www.postgresql.org/docs/17/jit-decision.html) that JIT decisions use estimated plan cost, and that compilation overhead can dominate short queries. The local estimate is well above the observed default compilation/optimization thresholds. Transaction-local suppression prevents that startup work for this bounded interactive operation. CI contention may also contribute to prior timings; no universal production speedup is claimed.

The native integration suite verifies the setting on the actual checked-out database connection before geometry work, keeps the normal query deadline, validates the square, and confirms that commit restores an explicitly enabled session JIT setting. All existing curved-road, intersection, source-witness, geometry-integrity, and failure-limit tests remain required.
