CREATE TABLE IF NOT EXISTS app.dcad_parser_canaries (
    account_id           text PRIMARY KEY,
    status               text NOT NULL DEFAULT 'pending',
    consecutive_failures integer NOT NULL DEFAULT 0,
    last_run_at          timestamptz,
    last_success_at      timestamptz,
    next_run_at          timestamptz NOT NULL DEFAULT now(),
    lease_expires_at     timestamptz,
    worker_id            text,
    last_error           text,
    last_result          jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dcad_parser_canaries_status_check CHECK (
        status IN ('pending', 'leased', 'passed', 'failed')
    ),
    CONSTRAINT dcad_parser_canaries_failure_count_check CHECK (
        consecutive_failures >= 0
    )
);

CREATE INDEX IF NOT EXISTS dcad_parser_canaries_due_idx
    ON app.dcad_parser_canaries (next_run_at, account_id)
    WHERE status IN ('pending', 'passed', 'failed');

CREATE INDEX IF NOT EXISTS dcad_parser_canaries_failed_idx
    ON app.dcad_parser_canaries (updated_at DESC, account_id)
    WHERE status = 'failed';
