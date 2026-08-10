const MAX_FILE_NUMBER_LENGTH = 100;

export function normalizeAssignmentFileNumber(value) {
  const fileNumber = String(value ?? "").trim();
  if (
    !fileNumber ||
    fileNumber.length > MAX_FILE_NUMBER_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(fileNumber)
  ) {
    throw new Error("invalid_file_number");
  }
  return fileNumber;
}

export function normalizeAssignmentFileId(value, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error("invalid_assignment_file_id");
    return null;
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("invalid_assignment_file_id");
  }
  return id;
}

export async function ensureAssignmentFilesSchema(pool) {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS app;

    CREATE TABLE IF NOT EXISTS app.assignment_files (
      id bigserial PRIMARY KEY,
      account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      file_number text NOT NULL,
      assignment_details jsonb NOT NULL DEFAULT '{}'::jsonb,
      inherited_from_file_id bigint REFERENCES app.assignment_files(id) ON DELETE SET NULL,
      reviewer text NOT NULL DEFAULT 'HomeNode editor',
      revision integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (account_id, file_number)
    );
    CREATE INDEX IF NOT EXISTS assignment_files_account_created_idx
      ON app.assignment_files (account_id, created_at DESC, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS assignment_files_account_file_number_ci_uidx
      ON app.assignment_files (account_id, lower(file_number));

    CREATE TABLE IF NOT EXISTS app.assignment_file_history (
      id bigserial PRIMARY KEY,
      assignment_file_id bigint NOT NULL REFERENCES app.assignment_files(id) ON DELETE CASCADE,
      account_id text NOT NULL,
      file_number text NOT NULL,
      assignment_details jsonb NOT NULL,
      reviewer text NOT NULL,
      revision integer NOT NULL,
      changed_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS assignment_file_history_file_idx
      ON app.assignment_file_history (assignment_file_id, revision DESC, changed_at DESC);
  `);
}

export function assignmentFileResponse(row) {
  return {
    id: Number(row.id),
    account_id: row.account_id,
    file_number: row.file_number,
    assignment_details: row.assignment_details || {},
    inherited_from_file_id: row.inherited_from_file_id == null
      ? null
      : Number(row.inherited_from_file_id),
    inherited_from_file_number: row.inherited_from_file_number || null,
    reviewer: row.reviewer || null,
    revision: Number(row.revision || 1),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
