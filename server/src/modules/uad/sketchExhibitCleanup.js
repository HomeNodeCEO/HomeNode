import { normalizeUadWorkfileId } from "./workfiles.js";
import { assertLockedUadWorkfileMutable } from "./workfileLifecycle.js";

// Internal best-effort compensation only. The caller must hold its private
// proof that this invocation created the asset; idempotent:false is NOT proof.
// This is not a general garbage collector or an atomic publication boundary.
// Retained verified renders may still be report-eligible until that boundary
// is implemented. Never delete R2 objects here.
export async function cleanupFailedUadSketchRender(pool, {
  workfileId, assetId, sketchId, expectedRevision,
}) {
  let client;
  let committed = false;
  try {
    workfileId = normalizeUadWorkfileId(workfileId);
    assetId = normalizeUadWorkfileId(assetId);
    sketchId = normalizeUadWorkfileId(sketchId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1
      || !Number.isSafeInteger(expectedRevision + 1)) return false;
    client = await pool.connect();
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL lock_timeout = '500ms'");
    await client.query("SET LOCAL statement_timeout = '2000ms'");
    const locked = await client.query(
      "SELECT id, status, signed_at FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE",
      [workfileId],
    );
    if (!Array.isArray(locked?.rows) || locked.rows.length !== 1 || locked.rows[0]?.id !== workfileId
      || locked.rows[0].status !== "draft") return false;
    await assertLockedUadWorkfileMutable(client, locked.rows[0]);
    const selected = await client.query(
      `SELECT id, workfile_id, status, section_number, capture_metadata, verified_at
         FROM appraisal.uad_assets WHERE id = $1 AND workfile_id = $2 FOR UPDATE`,
      [assetId, workfileId],
    );
    if (!Array.isArray(selected?.rows) || selected.rows.length !== 1 || !selected.rows[0]) return false;
    const asset = selected.rows[0];
    const metadata = asset.capture_metadata;
    if (asset.id !== assetId || asset.workfile_id !== workfileId
      || asset.status !== "verified" || asset.section_number !== 7
      || asset.verified_at == null || !metadata
      || metadata.source !== "homenode_web_sketch_editor"
      || metadata.source_uad_sketch_id !== sketchId
      || metadata.source_uad_sketch_revision !== expectedRevision
      || metadata.uad_sketch_editor_revision !== `${sketchId}:${expectedRevision + 1}`) return false;

    // Check references across all workfiles: inconsistent legacy ownership is
    // reason to retain, not permission to hide another row's exhibit. Refuse
    // ANY validation/artifact history, not a timestamp comparison: PostgreSQL
    // now() reflects transaction start, which can precede a wait on this lock.
    // Report readers can also retain snapshots before an artifact row exists.
    const observed = await client.query(
      `SELECT (
         EXISTS (SELECT 1 FROM appraisal.uad_sketches WHERE rendered_asset_id = $1)
         OR EXISTS (SELECT 1 FROM appraisal.uad_sketch_history WHERE rendered_asset_id = $1)
         OR EXISTS (SELECT 1 FROM appraisal.uad_signatures WHERE signature_asset_id = $1)
         OR EXISTS (SELECT 1 FROM appraisal.uad_validation_runs WHERE workfile_id = $2)
         OR EXISTS (SELECT 1 FROM appraisal.uad_generated_artifacts WHERE workfile_id = $2)
       ) AS has_observers`,
      [assetId, workfileId],
    );
    if (!Array.isArray(observed?.rows) || observed.rows.length !== 1 || observed.rows[0]?.has_observers !== false) return false;
    const retired = await client.query(
      `UPDATE appraisal.uad_assets
          SET status = 'deleted', updated_at = now(),
              capture_metadata = capture_metadata || '{"orphaned_editor_render":true}'::jsonb
        WHERE id = $1 AND workfile_id = $2 AND status = 'verified'
        RETURNING id`,
      [assetId, workfileId],
    );
    if (!Array.isArray(retired?.rows) || retired.rows.length !== 1 || retired.rows[0]?.id !== assetId) return false;
    await client.query("COMMIT");
    committed = true;
    return true;
  } catch {
    // Compensation is never allowed to replace the original canonical error.
    return false;
  } finally {
    if (client) {
      try {
        if (!committed) await client.query("ROLLBACK");
      } catch { /* Even a synchronous rollback error must still release. */ }
      finally {
        try { client.release(); } catch { /* Preserve the original save error. */ }
      }
    }
  }
}
