const ACCOUNT_ID_PATTERN = /^[0-9A-Za-z]{17}$/;
const MAXIMUM_DOCUMENTS = 100;

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requiredText(value, code, maximumLength) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximumLength) throw codedError(code);
  return normalized;
}

function normalizeDocumentIds(values) {
  const source = Array.isArray(values) ? values : String(values || "").split(",");
  const ids = [...new Set(source.map((value) => Number(String(value).trim())))];
  if (
    ids.length === 0 ||
    ids.length > MAXIMUM_DOCUMENTS ||
    ids.some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    throw codedError("invalid_assignment_document_ids");
  }
  return ids.sort((left, right) => left - right);
}

export async function reconcileLegacyAssignmentDocuments(pool, {
  accountId: accountIdValue,
  fileNumber: fileNumberValue,
  documentIds: documentIdValues,
  actor: actorValue,
  confirm = false,
} = {}) {
  if (!pool?.connect) throw new TypeError("database_pool_required");
  const accountId = requiredText(accountIdValue, "invalid_account_id", 32);
  if (!ACCOUNT_ID_PATTERN.test(accountId)) throw codedError("invalid_account_id");
  const fileNumber = requiredText(fileNumberValue, "invalid_file_number", 120);
  const actor = requiredText(actorValue, "reconciliation_actor_required", 200);
  const documentIds = normalizeDocumentIds(documentIdValues);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const assignmentResult = await client.query(
      `SELECT id, account_id, file_number, organization_id, assigned_appraiser_user_id
         FROM app.assignment_files
        WHERE account_id = $1
          AND lower(file_number) = lower($2)
        ORDER BY id
        LIMIT 2
        FOR UPDATE`,
      [accountId, fileNumber],
    );
    if (assignmentResult.rows.length !== 1) {
      throw codedError("owned_assignment_not_unique");
    }
    const assignment = assignmentResult.rows[0];
    if (!assignment.organization_id || !assignment.assigned_appraiser_user_id) {
      throw codedError("owned_assignment_identity_incomplete");
    }

    const documentResult = await client.query(
      `SELECT id, account_id, assignment_file_id, uad_workfile_id, tax_protest_file_id
         FROM app.assignment_documents
        WHERE id = ANY($1::bigint[])
        ORDER BY id
        FOR UPDATE`,
      [documentIds],
    );
    if (documentResult.rows.length !== documentIds.length) {
      throw codedError("assignment_document_set_incomplete");
    }
    if (documentResult.rows.some((document) => String(document.account_id) !== accountId)) {
      throw codedError("assignment_document_account_mismatch");
    }
    if (documentResult.rows.some((document) =>
      document.assignment_file_id !== null
      || document.uad_workfile_id !== null
      || document.tax_protest_file_id != null)) {
      throw codedError("assignment_document_already_scoped");
    }

    const plan = Object.freeze({
      confirmed: Boolean(confirm),
      account_id: accountId,
      file_number: assignment.file_number,
      assignment_file_id: Number(assignment.id),
      document_ids: Object.freeze(documentIds),
      document_count: documentIds.length,
      reason_code: "legacy_unique_account_file_reconciliation",
    });
    if (!confirm) {
      await client.query("ROLLBACK");
      return plan;
    }

    const historyResult = await client.query(
      `INSERT INTO app.assignment_document_scope_history (
         document_id, account_id, previous_assignment_file_id,
         assignment_file_id, reason_code, actor, metadata
       )
       SELECT document.id, document.account_id, document.assignment_file_id,
              $2, $3, $4, $5::jsonb
         FROM app.assignment_documents document
        WHERE document.id = ANY($1::bigint[])
        ORDER BY document.id`,
      [
        documentIds,
        assignment.id,
        plan.reason_code,
        actor,
        JSON.stringify({ file_number: assignment.file_number }),
      ],
    );
    if (historyResult.rowCount !== documentIds.length) {
      throw codedError("assignment_document_history_incomplete");
    }

    const updateResult = await client.query(
      `UPDATE app.assignment_documents
          SET assignment_file_id = $2,
              updated_at = now()
        WHERE id = ANY($1::bigint[])
          AND account_id = $3
          AND assignment_file_id IS NULL
      RETURNING id`,
      [documentIds, assignment.id, accountId],
    );
    if (updateResult.rowCount !== documentIds.length) {
      throw codedError("assignment_document_reconciliation_incomplete");
    }
    await client.query("COMMIT");
    return plan;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export const ASSIGNMENT_DOCUMENT_RECONCILIATION_LIMIT = MAXIMUM_DOCUMENTS;
