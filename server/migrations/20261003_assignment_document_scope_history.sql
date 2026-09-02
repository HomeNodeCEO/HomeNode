CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.assignment_document_scope_history (
  id                          bigserial PRIMARY KEY,
  document_id                 bigint NOT NULL,
  account_id                  text NOT NULL,
  previous_assignment_file_id bigint,
  assignment_file_id          bigint NOT NULL
                                REFERENCES app.assignment_files(id)
                                ON DELETE RESTRICT,
  reason_code                 text NOT NULL,
  actor                       text NOT NULL,
  metadata                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  changed_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assignment_document_scope_history_document_idx
  ON app.assignment_document_scope_history (document_id, changed_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS assignment_document_scope_history_assignment_idx
  ON app.assignment_document_scope_history (assignment_file_id, changed_at DESC, id DESC);
