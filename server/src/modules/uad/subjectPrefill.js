import { randomUUID } from "node:crypto";
import { normalizeUadWorkfileId } from "./workfiles.js";
import { assertLockedUadWorkfileMutable } from "./workfileLifecycle.js";
import { buildUadSubjectPrefillValues } from "./subjectPrefillValues.js";

// Called after organization/assignment WRITE authorization. Use this file's
// retained snapshot, never today's CAD data or another appraisal's conclusions.
export async function prefillUadSubject(pool, workfileIdValue, actorUserId) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const locked = await client.query(
      `SELECT id, account_id, status, signed_at, current_revision, specification_release_key
         FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE`, [workfileId],
    );
    const workfile = locked.rows[0];
    if (!workfile) throw new Error("uad_workfile_not_found");
    await assertLockedUadWorkfileMutable(client, workfile);
    const snapshotResult = await client.query(
      `SELECT id, subject_data, created_at FROM appraisal.uad_subject_snapshots
        WHERE workfile_id = $1 ORDER BY snapshot_version DESC LIMIT 1`, [workfileId],
    );
    const snapshot = snapshotResult.rows[0];
    if (!snapshot || snapshot.subject_data?.account?.account_id !== workfile.account_id) {
      throw new Error("uad_subject_snapshot_conflict");
    }
    const entityResult = await client.query(
      "SELECT * FROM appraisal.uad_entities WHERE workfile_id = $1 ORDER BY entity_type, ordinal, id", [workfileId],
    );
    const fieldResult = await client.query(
      "SELECT * FROM appraisal.uad_field_values WHERE workfile_id = $1 FOR UPDATE", [workfileId],
    );
    const additions = buildUadSubjectPrefillValues(snapshot.subject_data, entityResult.rows, fieldResult.rows);
    const revision = Number(workfile.current_revision) + (additions.length ? 1 : 0);
    for (const { field, value, entityId, sourceType, sourceReference } of additions) {
      await client.query(
        `INSERT INTO appraisal.uad_field_values (
           id, workfile_id, entity_id, field_context, uad_uid, report_field_id, value,
           source_type, source_reference, source_observed_at, is_appraiser_confirmed, updated_by_user_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, false, $11)`,
        [randomUUID(), workfileId, entityId, field.contextKey, field.uid, field.reportFieldId,
          JSON.stringify(value), sourceType, sourceReference, snapshot.created_at, actorUserId],
      );
    }
    if (additions.length) {
      const allValues = await client.query(
        "SELECT * FROM appraisal.uad_field_values WHERE workfile_id = $1 ORDER BY id", [workfileId],
      );
      const document = {
        entities: entityResult.rows,
        field_values: allValues.rows.map((row) => ({
          entity_id: row.entity_id || null, uid: row.uad_uid, context_key: row.field_context,
          report_field_id: row.report_field_id, value: row.value, source_type: row.source_type,
          source_reference: row.source_reference, is_appraiser_confirmed: row.is_appraiser_confirmed,
        })),
      };
      await client.query(
        `UPDATE appraisal.uad_workfiles SET current_revision = $2, status = 'draft',
           updated_at = now(), updated_by_user_id = $3 WHERE id = $1`, [workfileId, revision, actorUserId],
      );
      await client.query(
        `INSERT INTO appraisal.uad_revisions (
           id, workfile_id, revision_number, specification_release_key, document, change_summary, created_by_user_id
         ) VALUES ($1, $2, $3, $4, $5::jsonb, 'Prefilled missing subject facts from retained HomeNode snapshot', $6)`,
        [randomUUID(), workfileId, revision, workfile.specification_release_key, JSON.stringify(document), actorUserId],
      );
      await client.query(
        `INSERT INTO appraisal.uad_audit_events (
           workfile_id, event_type, entity_type, entity_id, after_data, metadata, actor_user_id
         ) VALUES ($1::uuid, 'uad_subject.prefilled', 'uad_workfile', ($1::uuid)::text, $2::jsonb, $3::jsonb, $4)`,
        [workfileId, JSON.stringify(additions.map(({ field, entityId, value, sourceReference }) => ({
          entity_id: entityId, context_key: field.contextKey, uid: field.uid, value, source_reference: sourceReference,
        }))), JSON.stringify({ subject_snapshot_id: snapshot.id, revision_number: revision, changed_field_count: additions.length }), actorUserId],
      );
    }
    await client.query("COMMIT");
    return { changed_field_count: additions.length, current_revision: revision };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
