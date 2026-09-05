const MUTABLE_WORKFILE_STATUSES = new Set([
  "draft",
  "validating",
  "ready",
  "revised",
]);

export function isUadWorkfileMutable(status) {
  return MUTABLE_WORKFILE_STATUSES.has(String(status || "").trim());
}

export function assertUadWorkfileMutable(status, errorCode = "uad_workfile_status_locked") {
  if (!isUadWorkfileMutable(status)) throw new Error(errorCode);
}

// Caller must already hold this workfile's FOR UPDATE lock in a READ COMMITTED
// transaction. An older repeatable-read snapshot is not sufficient evidence.
// Query signatures AFTER acquiring the lock: signing uses the same lock but
// does not advance current_revision, and partial quorum can leave status ready.
// No writer may infer permission to reopen from the revised enum alone.
export async function assertLockedUadWorkfileMutable(client, workfile) {
  if (typeof workfile?.status !== "string") throw new Error("uad_workfile_status_locked");
  assertUadWorkfileMutable(workfile?.status);
  if (workfile.signed_at !== null) throw new Error("uad_workfile_status_locked");
  const signatures = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM appraisal.uad_signatures WHERE workfile_id = $1
     ) AS has_signatures`,
    [workfile.id],
  );
  if (!Array.isArray(signatures?.rows) || signatures.rows.length !== 1 || signatures.rows[0]?.has_signatures !== false) {
    throw new Error("uad_workfile_status_locked");
  }
}
