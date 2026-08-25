function boundedMinutes(value, fallback = 15) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(5, Math.min(Math.trunc(parsed), 24 * 60));
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
