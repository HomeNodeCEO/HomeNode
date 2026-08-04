import { randomUUID } from "node:crypto";

import {
  ensureAccountLocationsTable,
  refreshAccountLocations,
} from "./accountLocations.js";

const ACCOUNT_ID_PATTERN = /^[0-9A-Za-z]{17}$/;
const QUEUE_STATUSES = new Set([
  "pending",
  "processing",
  "retry",
  "completed",
  "manual_review",
]);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function normalizeQueueAccount(account) {
  const accountId = String(account?.account_id || "").trim();
  if (!ACCOUNT_ID_PATTERN.test(accountId)) return null;
  return {
    account_id: accountId,
    address: String(account?.address || "").trim() || null,
    county: String(account?.county || "").trim() || null,
  };
}

function isSupportedDallasCounty(county) {
  const normalized = String(county || "").trim().toLowerCase();
  return !normalized || normalized.includes("dallas");
}

export function locationBackfillRetryDelaySeconds(
  attempt,
  { baseSeconds = 30, maximumSeconds = 3600 } = {},
) {
  const safeAttempt = Math.max(1, Math.trunc(Number(attempt) || 1));
  const safeBase = Math.max(1, Math.trunc(Number(baseSeconds) || 30));
  const safeMaximum = Math.max(safeBase, Math.trunc(Number(maximumSeconds) || 3600));
  return Math.min(safeMaximum, safeBase * 2 ** (safeAttempt - 1));
}

export async function ensureLocationBackfillQueueSchema(pool) {
  await ensureAccountLocationsTable(pool);
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS app;

    CREATE TABLE IF NOT EXISTS app.location_backfill_queue (
      account_id       varchar(32) PRIMARY KEY
                       REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      address          text,
      county           text,
      priority         smallint NOT NULL DEFAULT 0,
      status           text NOT NULL DEFAULT 'pending'
                       CHECK (status IN (
                         'pending', 'processing', 'retry',
                         'completed', 'manual_review'
                       )),
      reason           text NOT NULL DEFAULT 'sales_inventory',
      attempts         integer NOT NULL DEFAULT 0,
      next_attempt_at  timestamptz NOT NULL DEFAULT now(),
      leased_at        timestamptz,
      worker_id        text,
      last_error       text,
      enqueued_at      timestamptz NOT NULL DEFAULT now(),
      completed_at     timestamptz,
      updated_at       timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS location_backfill_queue_work_idx
      ON app.location_backfill_queue (
        status, next_attempt_at, priority DESC, enqueued_at
      )
      WHERE status IN ('pending', 'retry');

    CREATE INDEX IF NOT EXISTS location_backfill_queue_status_idx
      ON app.location_backfill_queue (status, updated_at DESC);
  `);
}

/**
 * Queue matched Dallas CAD accounts only when their cached parcel location is
 * missing. Existing processing leases and terminal manual-review decisions are
 * preserved so repeated inventory sweeps cannot create a hot retry loop.
 */
export async function enqueueLocationBackfillAccounts(
  pool,
  accounts,
  {
    reason = "sales_inventory",
    priority = 0,
  } = {},
) {
  const normalized = [
    ...new Map(
      (Array.isArray(accounts) ? accounts : [])
        .map(normalizeQueueAccount)
        .filter(Boolean)
        .filter((account) => isSupportedDallasCounty(account.county))
        .map((account) => [account.account_id, account]),
    ).values(),
  ];
  if (!normalized.length) return { requested: 0, queued: 0, accountIds: [] };

  const safePriority = boundedInteger(priority, 0, -100, 1000);
  const safeReason = String(reason || "sales_inventory").trim().slice(0, 120);
  const { rows } = await pool.query(
    `
      WITH requested AS (
        SELECT *
        FROM JSONB_TO_RECORDSET($1::jsonb) AS item(
          account_id text,
          address text,
          county text
        )
      ), eligible AS (
        SELECT
          account.account_id,
          COALESCE(NULLIF(BTRIM(requested.address), ''), account.address) AS address,
          COALESCE(NULLIF(BTRIM(requested.county), ''), account.county) AS county
        FROM requested
        JOIN core.accounts account
          ON account.account_id = requested.account_id
        LEFT JOIN core.account_locations location
          ON location.account_id = account.account_id
        WHERE (
          COALESCE(NULLIF(BTRIM(account.county), ''), requested.county) IS NULL
          OR COALESCE(NULLIF(BTRIM(account.county), ''), requested.county)
               ILIKE '%dallas%'
        )
          AND (
            location.account_id IS NULL
            OR location.status <> 'matched'
            OR location.latitude IS NULL
            OR location.longitude IS NULL
          )
      )
      INSERT INTO app.location_backfill_queue (
        account_id, address, county, priority, status, reason,
        attempts, next_attempt_at, leased_at, worker_id, last_error,
        completed_at, updated_at
      )
      SELECT
        eligible.account_id,
        eligible.address,
        eligible.county,
        $2,
        'pending',
        $3,
        0,
        now(),
        NULL,
        NULL,
        NULL,
        NULL,
        now()
      FROM eligible
      ON CONFLICT (account_id) DO UPDATE SET
        address = COALESCE(EXCLUDED.address, app.location_backfill_queue.address),
        county = COALESCE(EXCLUDED.county, app.location_backfill_queue.county),
        priority = GREATEST(
          app.location_backfill_queue.priority,
          EXCLUDED.priority
        ),
        status = CASE
          WHEN app.location_backfill_queue.status IN ('processing', 'manual_review')
            THEN app.location_backfill_queue.status
          ELSE 'pending'
        END,
        reason = EXCLUDED.reason,
        next_attempt_at = CASE
          WHEN app.location_backfill_queue.status IN ('processing', 'manual_review')
            THEN app.location_backfill_queue.next_attempt_at
          ELSE now()
        END,
        leased_at = CASE
          WHEN app.location_backfill_queue.status = 'processing'
            THEN app.location_backfill_queue.leased_at
          ELSE NULL
        END,
        worker_id = CASE
          WHEN app.location_backfill_queue.status = 'processing'
            THEN app.location_backfill_queue.worker_id
          ELSE NULL
        END,
        completed_at = CASE
          WHEN app.location_backfill_queue.status = 'manual_review'
            THEN app.location_backfill_queue.completed_at
          ELSE NULL
        END,
        updated_at = now()
      RETURNING account_id
    `,
    [JSON.stringify(normalized), safePriority, safeReason],
  );
  return {
    requested: normalized.length,
    queued: rows.length,
    accountIds: rows.map((row) => row.account_id),
  };
}

/** Seed the queue directly from matched closed-sale/listing account IDs. */
export async function seedLocationBackfillQueue(
  pool,
  { limit = 1000 } = {},
) {
  const safeLimit = boundedInteger(limit, 1000, 1, 10_000);
  const { rows } = await pool.query(
    `
      WITH sale_accounts AS (
        SELECT
          source.primary_account_id AS account_id,
          MAX(COALESCE(source.close_date, source.listing_contract_date)) AS activity_date
        FROM core.sales_source_records source
        WHERE source.primary_account_id IS NOT NULL
        GROUP BY source.primary_account_id

        UNION ALL

        SELECT
          sale.account_id,
          MAX(sale.closing_date) AS activity_date
        FROM core.sales sale
        WHERE NULLIF(BTRIM(sale.account_id), '') IS NOT NULL
        GROUP BY sale.account_id
      ), candidates AS (
        SELECT
          account.account_id,
          account.address,
          account.county,
          MAX(sale_accounts.activity_date) AS activity_date
        FROM sale_accounts
        JOIN core.accounts account
          ON account.account_id = sale_accounts.account_id
        LEFT JOIN core.account_locations location
          ON location.account_id = account.account_id
        LEFT JOIN app.location_backfill_queue queue
          ON queue.account_id = account.account_id
        WHERE (
          account.county IS NULL
          OR account.county ILIKE '%dallas%'
        )
          AND (
            location.account_id IS NULL
            OR location.status <> 'matched'
            OR location.latitude IS NULL
            OR location.longitude IS NULL
          )
          AND COALESCE(queue.status, 'pending') <> 'manual_review'
        GROUP BY account.account_id, account.address, account.county
        ORDER BY MAX(sale_accounts.activity_date) DESC NULLS LAST,
                 account.account_id
        LIMIT $1
      )
      INSERT INTO app.location_backfill_queue (
        account_id, address, county, priority, status, reason,
        next_attempt_at, completed_at, updated_at
      )
      SELECT
        account_id,
        address,
        county,
        CASE
          WHEN activity_date >= CURRENT_DATE - interval '1 year' THEN 50
          ELSE 10
        END,
        'pending',
        'sales_inventory_sweep',
        now(),
        NULL,
        now()
      FROM candidates
      ON CONFLICT (account_id) DO UPDATE SET
        address = COALESCE(EXCLUDED.address, app.location_backfill_queue.address),
        county = COALESCE(EXCLUDED.county, app.location_backfill_queue.county),
        priority = GREATEST(
          app.location_backfill_queue.priority,
          EXCLUDED.priority
        ),
        status = CASE
          WHEN app.location_backfill_queue.status IN (
            'processing', 'retry', 'manual_review'
          ) THEN app.location_backfill_queue.status
          ELSE 'pending'
        END,
        reason = EXCLUDED.reason,
        next_attempt_at = CASE
          WHEN app.location_backfill_queue.status IN (
            'processing', 'retry', 'manual_review'
          ) THEN app.location_backfill_queue.next_attempt_at
          ELSE now()
        END,
        completed_at = CASE
          WHEN app.location_backfill_queue.status = 'completed' THEN NULL
          ELSE app.location_backfill_queue.completed_at
        END,
        updated_at = now()
      RETURNING account_id
    `,
    [safeLimit],
  );
  return { scannedLimit: safeLimit, queued: rows.length };
}

async function claimLocationBackfillBatch(
  pool,
  { batchSize = 50, workerId = randomUUID() } = {},
) {
  const safeBatchSize = boundedInteger(batchSize, 50, 1, 100);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      UPDATE app.location_backfill_queue
      SET status = 'retry',
          worker_id = NULL,
          leased_at = NULL,
          next_attempt_at = now(),
          last_error = COALESCE(last_error, 'stale_worker_lease'),
          updated_at = now()
      WHERE status = 'processing'
        AND leased_at < now() - interval '15 minutes'
    `);
    const { rows } = await client.query(
      `
        WITH next_items AS (
          SELECT account_id
          FROM app.location_backfill_queue
          WHERE status IN ('pending', 'retry')
            AND next_attempt_at <= now()
          ORDER BY priority DESC, next_attempt_at, enqueued_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE app.location_backfill_queue queue
        SET status = 'processing',
            leased_at = now(),
            worker_id = $2,
            updated_at = now()
        FROM next_items
        WHERE queue.account_id = next_items.account_id
        RETURNING
          queue.account_id,
          queue.address,
          queue.county,
          queue.attempts,
          queue.reason,
          queue.priority,
          queue.worker_id
      `,
      [safeBatchSize, workerId],
    );
    await client.query("COMMIT");
    return rows;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function markLocationBackfillOutcome(
  pool,
  item,
  {
    locationStatus,
    reviewReason = null,
    error = null,
    maximumAttempts = 5,
  },
) {
  if (locationStatus === "matched") {
    await pool.query(
      `
        UPDATE app.location_backfill_queue
        SET status = 'completed',
            completed_at = now(),
            worker_id = NULL,
            leased_at = NULL,
            last_error = NULL,
            updated_at = now()
        WHERE account_id = $1
          AND worker_id = $2
      `,
      [item.account_id, item.worker_id],
    );
    return "completed";
  }

  const nextAttempt = Number(item.attempts || 0) + 1;
  const terminal = nextAttempt >= maximumAttempts;
  const delaySeconds = locationBackfillRetryDelaySeconds(nextAttempt);
  const message = String(
    error?.message ||
    error ||
    reviewReason ||
    locationStatus ||
    "location_unavailable",
  ).slice(0, 1000);
  await pool.query(
    `
      UPDATE app.location_backfill_queue
      SET status = $2,
          attempts = $3,
          next_attempt_at = CASE
            WHEN $2 = 'manual_review' THEN next_attempt_at
            ELSE now() + ($4::integer * interval '1 second')
          END,
          worker_id = NULL,
          leased_at = NULL,
          last_error = $5,
          completed_at = CASE
            WHEN $2 = 'manual_review' THEN now()
            ELSE NULL
          END,
          updated_at = now()
      WHERE account_id = $1
        AND worker_id = $6
    `,
    [
      item.account_id,
      terminal ? "manual_review" : "retry",
      nextAttempt,
      delaySeconds,
      message,
      item.worker_id,
    ],
  );
  return terminal ? "manual_review" : "retry";
}

/** Process one leased batch. Network failures never affect an API response. */
export async function runLocationBackfillBatch(
  pool,
  {
    batchSize = 50,
    workerId = randomUUID(),
    maximumAttempts = 5,
    fetchImpl = fetch,
  } = {},
) {
  const claimed = await claimLocationBackfillBatch(pool, {
    batchSize,
    workerId,
  });
  if (!claimed.length) {
    return { claimed: 0, completed: 0, retry: 0, manualReview: 0 };
  }

  try {
    await refreshAccountLocations(pool, claimed, {
      fetchImpl,
      batchSize: Math.min(50, claimed.length),
      maximumAttempts: 2,
      retryDelayMs: 500,
    });
  } catch (error) {
    const outcomes = await Promise.all(
      claimed.map((item) => markLocationBackfillOutcome(pool, item, {
        locationStatus: null,
        error,
        maximumAttempts,
      })),
    );
    return {
      claimed: claimed.length,
      completed: 0,
      retry: outcomes.filter((outcome) => outcome === "retry").length,
      manualReview: outcomes.filter((outcome) => outcome === "manual_review").length,
      error: error?.message || String(error),
    };
  }

  const { rows: locations } = await pool.query(
    `
      SELECT account_id, status, review_reason
      FROM core.account_locations
      WHERE account_id = ANY($1::text[])
    `,
    [claimed.map((item) => item.account_id)],
  );
  const locationsByAccount = new Map(
    locations.map((location) => [location.account_id, location]),
  );
  const outcomes = await Promise.all(
    claimed.map((item) => {
      const location = locationsByAccount.get(item.account_id);
      return markLocationBackfillOutcome(pool, item, {
        locationStatus: location?.status || null,
        reviewReason: location?.review_reason || "location_row_missing",
        maximumAttempts,
      });
    }),
  );
  return {
    claimed: claimed.length,
    completed: outcomes.filter((outcome) => outcome === "completed").length,
    retry: outcomes.filter((outcome) => outcome === "retry").length,
    manualReview: outcomes.filter((outcome) => outcome === "manual_review").length,
  };
}

export async function getLocationBackfillStatus(pool) {
  const [{ rows: queueRows }, { rows: coverageRows }] = await Promise.all([
    pool.query(`
      SELECT status, COUNT(*)::integer AS count
      FROM app.location_backfill_queue
      GROUP BY status
    `),
    pool.query(`
      WITH sale_accounts AS (
        SELECT DISTINCT primary_account_id AS account_id
        FROM core.sales_source_records
        WHERE primary_account_id IS NOT NULL
        UNION
        SELECT DISTINCT account_id
        FROM core.sales
        WHERE NULLIF(BTRIM(account_id), '') IS NOT NULL
      )
      SELECT
        COUNT(*)::integer AS sale_account_count,
        COUNT(*) FILTER (
          WHERE location.status = 'matched'
            AND location.latitude IS NOT NULL
            AND location.longitude IS NOT NULL
        )::integer AS located_sale_account_count,
        COUNT(*) FILTER (
          WHERE location.account_id IS NULL
            OR location.status <> 'matched'
            OR location.latitude IS NULL
            OR location.longitude IS NULL
        )::integer AS missing_sale_account_count
      FROM sale_accounts
      JOIN core.accounts account
        ON account.account_id = sale_accounts.account_id
      LEFT JOIN core.account_locations location
        ON location.account_id = sale_accounts.account_id
      WHERE account.county IS NULL OR account.county ILIKE '%dallas%'
    `),
  ]);
  const queue = Object.fromEntries(
    [...QUEUE_STATUSES].map((status) => [status, 0]),
  );
  for (const row of queueRows) {
    if (QUEUE_STATUSES.has(row.status)) queue[row.status] = Number(row.count || 0);
  }
  const coverage = coverageRows[0] || {};
  const total = Number(coverage.sale_account_count || 0);
  const located = Number(coverage.located_sale_account_count || 0);
  return {
    queue,
    coverage: {
      sale_account_count: total,
      located_sale_account_count: located,
      missing_sale_account_count: Number(coverage.missing_sale_account_count || 0),
      coverage_percent: total ? Math.round((located / total) * 10_000) / 100 : 100,
    },
  };
}

/**
 * Start an idempotent background loop. PostgreSQL SKIP LOCKED leases keep it
 * safe if Render briefly runs more than one application instance.
 */
export function startLocationBackfillWorker(
  pool,
  {
    intervalMs = 30_000,
    seedIntervalMs = 300_000,
    initialDelayMs = 3_000,
    batchSize = 50,
    seedLimit = 1000,
    maximumAttempts = 5,
    logger = console,
  } = {},
) {
  const workerId = `location-backfill-${randomUUID()}`;
  const safeInterval = boundedInteger(intervalMs, 30_000, 5_000, 3_600_000);
  const safeSeedInterval = boundedInteger(
    seedIntervalMs,
    300_000,
    safeInterval,
    86_400_000,
  );
  const safeInitialDelay = boundedInteger(initialDelayMs, 3_000, 0, 300_000);
  let stopped = false;
  let running = false;
  let timer = null;
  let lastSeededAt = 0;

  const schedule = (delayMs) => {
    if (stopped) return;
    timer = setTimeout(() => void cycle(), delayMs);
    timer.unref?.();
  };
  const cycle = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const seedDue = Date.now() - lastSeededAt >= safeSeedInterval;
      const seed = seedDue
        ? await seedLocationBackfillQueue(pool, { limit: seedLimit })
        : { queued: 0 };
      if (seedDue) lastSeededAt = Date.now();
      const result = await runLocationBackfillBatch(pool, {
        batchSize,
        workerId,
        maximumAttempts,
      });
      if (result.claimed || seed.queued) {
        logger.info?.("[location-backfill] cycle", {
          workerId,
          seeded: seed.queued,
          ...result,
        });
      }
    } catch (error) {
      logger.warn?.(
        "[location-backfill] cycle failed; will retry",
        error?.message || error,
      );
    } finally {
      running = false;
      schedule(safeInterval);
    }
  };

  schedule(safeInitialDelay);
  return {
    workerId,
    runNow: cycle,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
