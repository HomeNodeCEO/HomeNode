CREATE TABLE IF NOT EXISTS app.dcad_owner_recovery_queue (
    account_id       text PRIMARY KEY,
    status           text NOT NULL DEFAULT 'pending',
    attempts         integer NOT NULL DEFAULT 0,
    next_attempt_at  timestamptz NOT NULL DEFAULT now(),
    last_attempt_at  timestamptz,
    last_success_at  timestamptz,
    lease_expires_at timestamptz,
    worker_id        text,
    reason           text,
    last_error       text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dcad_owner_recovery_queue_status_check CHECK (
        status IN ('pending', 'leased', 'retry', 'succeeded')
    )
);

CREATE INDEX IF NOT EXISTS dcad_owner_recovery_queue_due_idx
    ON app.dcad_owner_recovery_queue (next_attempt_at, account_id)
    WHERE status IN ('pending', 'retry');

CREATE INDEX IF NOT EXISTS dcad_owner_recovery_queue_status_idx
    ON app.dcad_owner_recovery_queue (status);
