function boundedMinutes(value, fallback = 15) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(5, Math.min(Math.trunc(parsed), 24 * 60));
}

function boundedInterval(value, fallback = 60_000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(10_000, Math.min(Math.trunc(parsed), 60 * 60_000));
}

export async function recoverStaleUadArtifactGenerations(pool, {
  staleAfterMinutes = process.env.UAD_ARTIFACT_STALE_AFTER_MINUTES,
  logger = console,
} = {}) {
  const minutes = boundedMinutes(staleAfterMinutes);
  const result = await pool.query(
    `UPDATE appraisal.uad_generated_artifacts
        SET generation_status = 'failed',
            metadata = metadata || jsonb_build_object(
              'recovery_error', 'uad_artifact_generation_interrupted',
              'recovered_at', now()
            )
      WHERE generation_status = 'generating'
        AND COALESCE(
          CASE
            WHEN metadata->>'generation_started_at' ~
                 '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
              THEN (metadata->>'generation_started_at')::timestamptz
            ELSE NULL
          END,
          created_at
        ) < now() - ($1::integer * interval '1 minute')
      RETURNING id, artifact_type`,
    [minutes],
  );
  const recovered = Number(result.rowCount || result.rows?.length || 0);
  if (recovered > 0) logger.warn?.(`[uad-artifacts] recovered ${recovered} interrupted generation(s)`);
  return Object.freeze({ recovered, stale_after_minutes: minutes });
}

export function startUadArtifactRecoveryMonitor(pool, {
  intervalMs = process.env.UAD_ARTIFACT_RECOVERY_INTERVAL_MS,
  staleAfterMinutes = process.env.UAD_ARTIFACT_STALE_AFTER_MINUTES,
  logger = console,
  runRecovery = recoverStaleUadArtifactGenerations,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  now = () => new Date().toISOString(),
  runImmediately = true,
  shouldRun = () => true,
} = {}) {
  if (!pool?.query) throw new Error("uad_artifact_recovery_pool_required");
  const interval = boundedInterval(intervalMs);
  let closed = false;
  let running = false;
  let completed = 0;
  let failed = 0;
  let recovered = 0;
  let lastCompletedAt = null;
  let lastError = null;

  function snapshot() {
    return Object.freeze({
      ready: !closed,
      closed,
      running,
      interval_ms: interval,
      completed,
      failed,
      recovered,
      last_completed_at: lastCompletedAt,
      last_error: lastError,
    });
  }

  async function runOnce() {
    if (closed) return Object.freeze({ skipped: "closed" });
    if (running) return Object.freeze({ skipped: "already_running" });
    if (!shouldRun()) return Object.freeze({ skipped: "active_generation" });
    running = true;
    try {
      const result = await runRecovery(pool, { staleAfterMinutes, logger });
      completed += 1;
      recovered += Number(result?.recovered || 0);
      lastCompletedAt = now();
      lastError = null;
      return result;
    } catch {
      failed += 1;
      lastCompletedAt = now();
      lastError = "uad_artifact_recovery_unavailable";
      logger.warn?.("[uad-artifacts] recovery pass unavailable");
      return Object.freeze({ error: lastError });
    } finally {
      running = false;
    }
  }

  const timer = setIntervalImpl(() => { void runOnce(); }, interval);
  timer?.unref?.();
  if (runImmediately) void runOnce();

  return Object.freeze({
    runOnce,
    snapshot,
    dispose() {
      if (closed) return false;
      closed = true;
      clearIntervalImpl(timer);
      return true;
    },
  });
}
