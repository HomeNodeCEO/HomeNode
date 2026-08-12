import { randomUUID } from "node:crypto";

import {
  ensureLocationBackfillQueueSchema,
  getLocationBackfillStatus,
  runLocationBackfillBatch,
  seedLocationBackfillQueue,
} from "./locationBackfillQueue.js";
import {
  ensureCensusGeographySchema,
  getCensusGeographyStatus,
  runCensusGeographyBatch,
  seedCensusGeographyQueue,
} from "./censusGeography.js";
import {
  syncDcadPropertyContext,
  syncTigerRoadContext,
} from "./propertyContextSync.js";

const MAINTENANCE_LOCK_A = 48_632_941;
const MAINTENANCE_LOCK_B = 20_260_812;
const TASK_ALIASES = Object.freeze({
  routine: ["census", "locations", "parcels"],
  all: ["census", "locations", "parcels", "roads"],
  census: ["census"],
  locations: ["locations"],
  parcels: ["parcels"],
  roads: ["roads"],
});

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function errorMessage(error) {
  return String(error?.message || error || "scheduled_maintenance_failed").slice(0, 4_000);
}

export function resolveMaintenanceTasks(requestedTask = "routine") {
  const normalized = String(requestedTask || "routine").trim().toLowerCase();
  const tasks = TASK_ALIASES[normalized];
  if (!tasks) {
    throw new Error(`Unknown maintenance task '${normalized}'. Use ${Object.keys(TASK_ALIASES).join(", ")}.`);
  }
  return [...tasks];
}

export async function ensureScheduledMaintenanceSchema(pool) {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS app;
    CREATE TABLE IF NOT EXISTS app.scheduled_maintenance_runs (
      id            bigserial PRIMARY KEY,
      job_name      text NOT NULL,
      worker_id     text NOT NULL,
      status        text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      started_at    timestamptz NOT NULL DEFAULT now(),
      finished_at   timestamptz,
      details       jsonb NOT NULL DEFAULT '{}'::jsonb,
      error_message text
    );
    CREATE INDEX IF NOT EXISTS scheduled_maintenance_runs_started_idx
      ON app.scheduled_maintenance_runs (started_at DESC);
  `);
}

export async function getRecentScheduledMaintenanceRuns(pool, { limit = 10 } = {}) {
  const safeLimit = boundedInteger(limit, 10, 1, 50);
  try {
    const { rows } = await pool.query(
      `SELECT id, job_name, status, started_at, finished_at, details, error_message
       FROM app.scheduled_maintenance_runs
       ORDER BY started_at DESC
       LIMIT $1`,
      [safeLimit],
    );
    return rows;
  } catch (error) {
    if (error?.code === "42P01" || error?.code === "3F000") return [];
    throw error;
  }
}

async function acquireMaintenanceLock(pool) {
  const { rows } = await pool.query(
    "SELECT pg_try_advisory_lock($1, $2) AS acquired",
    [MAINTENANCE_LOCK_A, MAINTENANCE_LOCK_B],
  );
  return Boolean(rows[0]?.acquired);
}

async function releaseMaintenanceLock(pool) {
  await pool.query(
    "SELECT pg_advisory_unlock($1, $2)",
    [MAINTENANCE_LOCK_A, MAINTENANCE_LOCK_B],
  );
}

async function runCensusTask(pool, options) {
  await ensureCensusGeographySchema(pool);
  const maximumBatches = boundedInteger(options.censusMaximumBatches, 3, 1, 100);
  const batchSize = boundedInteger(options.censusBatchSize, 1_000, 1, 10_000);
  const seedLimit = boundedInteger(options.censusSeedLimit, 25_000, 1, 100_000);
  const totals = { seeded: 0, batches: 0, claimed: 0, matched: 0, retry: 0, reviewRequired: 0 };
  for (let batch = 0; batch < maximumBatches && Date.now() < options.deadline; batch += 1) {
    const seed = batch === 0
      ? await seedCensusGeographyQueue(pool, { limit: seedLimit })
      : { queued: 0 };
    const result = await runCensusGeographyBatch(pool, {
      batchSize,
      workerId: `${options.workerId}-census`,
      maximumAttempts: options.maximumAttempts,
    });
    totals.seeded += Number(seed.queued || 0);
    if (result.claimed) totals.batches += 1;
    for (const key of ["claimed", "matched", "retry", "reviewRequired"]) {
      totals[key] += Number(result[key] || 0);
    }
    if (!seed.queued && !result.claimed) break;
  }
  return { ...totals, status: await getCensusGeographyStatus(pool) };
}

async function runLocationTask(pool, options) {
  await ensureLocationBackfillQueueSchema(pool);
  const maximumBatches = boundedInteger(options.locationMaximumBatches, 4, 1, 100);
  const batchSize = boundedInteger(options.locationBatchSize, 50, 1, 100);
  const seedLimit = boundedInteger(options.locationSeedLimit, 1_000, 1, 10_000);
  const totals = { seeded: 0, batches: 0, claimed: 0, completed: 0, retry: 0, manualReview: 0 };
  for (let batch = 0; batch < maximumBatches && Date.now() < options.deadline; batch += 1) {
    const seed = batch === 0
      ? await seedLocationBackfillQueue(pool, { limit: seedLimit })
      : { queued: 0 };
    const result = await runLocationBackfillBatch(pool, {
      batchSize,
      workerId: `${options.workerId}-locations`,
      maximumAttempts: options.maximumAttempts,
    });
    totals.seeded += Number(seed.queued || 0);
    if (result.claimed) totals.batches += 1;
    for (const key of ["claimed", "completed", "retry", "manualReview"]) {
      totals[key] += Number(result[key] || 0);
    }
    if (!seed.queued && !result.claimed) break;
  }
  return { ...totals, status: await getLocationBackfillStatus(pool) };
}

async function runTask(pool, task, options) {
  if (task === "census") return runCensusTask(pool, options);
  if (task === "locations") return runLocationTask(pool, options);
  if (task === "parcels") {
    return syncDcadPropertyContext(pool, {
      mode: "incremental",
      batchSize: options.parcelBatchSize,
      concurrency: options.fetchConcurrency,
    });
  }
  if (task === "roads") {
    return syncTigerRoadContext(pool, {
      batchSize: options.roadBatchSize,
      concurrency: options.fetchConcurrency,
    });
  }
  throw new Error(`Unsupported maintenance task '${task}'.`);
}

export async function runScheduledMaintenance(pool, {
  task = "routine",
  maximumRuntimeMinutes = 45,
  maximumAttempts = 5,
  censusMaximumBatches = 3,
  censusBatchSize = 1_000,
  censusSeedLimit = 25_000,
  locationMaximumBatches = 4,
  locationBatchSize = 50,
  locationSeedLimit = 1_000,
  parcelBatchSize = 2_000,
  roadBatchSize = 5_000,
  fetchConcurrency = 3,
  logger = console,
  taskRunner = runTask,
} = {}) {
  const tasks = resolveMaintenanceTasks(task);
  const workerId = `scheduled-maintenance-${randomUUID()}`;
  const acquired = await acquireMaintenanceLock(pool);
  if (!acquired) {
    logger.info?.("[scheduled-maintenance] another run owns the advisory lock; skipping");
    return { ok: true, skipped: true, reason: "already_running", tasks };
  }

  let runId = null;
  const results = {};
  const failures = [];
  try {
    await ensureScheduledMaintenanceSchema(pool);
    const { rows } = await pool.query(
      `INSERT INTO app.scheduled_maintenance_runs (job_name, worker_id, status, details)
       VALUES ($1, $2, 'running', $3::jsonb)
       RETURNING id`,
      [task, workerId, JSON.stringify({ tasks })],
    );
    runId = rows[0]?.id || null;
    const safeRuntimeMinutes = boundedInteger(maximumRuntimeMinutes, 45, 1, 240);
    const options = {
      workerId,
      deadline: Date.now() + safeRuntimeMinutes * 60_000,
      maximumAttempts: boundedInteger(maximumAttempts, 5, 1, 10),
      censusMaximumBatches,
      censusBatchSize,
      censusSeedLimit,
      locationMaximumBatches,
      locationBatchSize,
      locationSeedLimit,
      parcelBatchSize: boundedInteger(parcelBatchSize, 2_000, 100, 10_000),
      roadBatchSize: boundedInteger(roadBatchSize, 5_000, 100, 10_000),
      fetchConcurrency: boundedInteger(fetchConcurrency, 3, 1, 8),
    };

    for (const taskName of tasks) {
      if (Date.now() >= options.deadline) {
        failures.push({ task: taskName, error: "maximum_runtime_reached" });
        break;
      }
      try {
        logger.info?.(`[scheduled-maintenance] starting ${taskName}`);
        results[taskName] = await taskRunner(pool, taskName, options);
        logger.info?.(`[scheduled-maintenance] completed ${taskName}`);
      } catch (error) {
        const failure = { task: taskName, error: errorMessage(error) };
        failures.push(failure);
        results[taskName] = { ok: false, ...failure };
        logger.warn?.(`[scheduled-maintenance] ${taskName} failed; retained prior data`, failure.error);
      }
    }

    const ok = failures.length === 0;
    if (runId) {
      await pool.query(
        `UPDATE app.scheduled_maintenance_runs
         SET status = $2, finished_at = now(), details = $3::jsonb, error_message = $4
         WHERE id = $1`,
        [
          runId,
          ok ? "completed" : "failed",
          JSON.stringify({ tasks, results, failures }),
          failures.map((failure) => `${failure.task}: ${failure.error}`).join(" | ") || null,
        ],
      );
    }
    return { ok, skipped: false, run_id: runId, tasks, results, failures };
  } catch (error) {
    if (runId) {
      await pool.query(
        `UPDATE app.scheduled_maintenance_runs
         SET status = 'failed', finished_at = now(), details = $2::jsonb, error_message = $3
         WHERE id = $1`,
        [runId, JSON.stringify({ tasks, results, failures }), errorMessage(error)],
      ).catch(() => {});
    }
    throw error;
  } finally {
    await releaseMaintenanceLock(pool).catch((error) => {
      logger.warn?.("[scheduled-maintenance] advisory lock release failed", errorMessage(error));
    });
  }
}
