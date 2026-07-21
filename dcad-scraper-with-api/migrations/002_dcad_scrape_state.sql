CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.dcad_scrape_state (
    account_id       text PRIMARY KEY,
    status           text NOT NULL DEFAULT 'pending',
    attempts         integer NOT NULL DEFAULT 0,
    last_attempt_at  timestamptz,
    last_success_at  timestamptz,
    next_attempt_at  timestamptz NOT NULL DEFAULT now(),
    lease_expires_at timestamptz,
    worker_id        text,
    last_error       text,
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dcad_scrape_state_due_idx
    ON app.dcad_scrape_state (next_attempt_at, last_success_at);

CREATE INDEX IF NOT EXISTS dcad_scrape_state_status_idx
    ON app.dcad_scrape_state (status);
