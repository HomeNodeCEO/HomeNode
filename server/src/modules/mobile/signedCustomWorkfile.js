// Mobile evidence writes and desktop signing must serialize on the same
// Custom Appraisal workfile row. Call only inside the caller's transaction.
export async function lockCustomAppraisalInspectionWorkfile(client, session) {
  if (session.workflow_type !== "custom_appraisal") return null;
  if (!session.custom_assignment_file_id) throw new Error("custom_appraisal_workfile_not_found");
  const { rows } = await client.query(
    `SELECT status FROM app.custom_appraisal_workfiles
      WHERE assignment_file_id = $1 FOR UPDATE`,
    [session.custom_assignment_file_id],
  );
  if (!rows.length) throw new Error("custom_appraisal_workfile_not_found");
  return rows[0].status;
}

export async function assertCustomAppraisalInspectionWritable(client, session) {
  const status = await lockCustomAppraisalInspectionWorkfile(client, session);
  if (status === "signed") throw new Error("custom_appraisal_workfile_signed");
}
