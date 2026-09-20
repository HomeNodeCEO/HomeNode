BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.location_backfill_queue (
    account_id       varchar(32) PRIMARY KEY
                     REFERENCES core.accounts(account_id) ON DELETE CASCADE,
    address          text,
    county           text,
    priority         smallint NOT NULL DEFAULT 0,
    status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN (
                         'pending', 'processing', 'retry',
                         'completed', 'manual_review'
                     )),
    reason           text NOT NULL DEFAULT 'sales_inventory',
    attempts         integer NOT NULL DEFAULT 0,
    next_attempt_at  timestamptz NOT NULL DEFAULT now(),
    leased_at        timestamptz,
    worker_id        text,
    last_error       text,
    enqueued_at      timestamptz NOT NULL DEFAULT now(),
    completed_at     timestamptz,
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS location_backfill_queue_work_idx
    ON app.location_backfill_queue (
        status, next_attempt_at, priority DESC, enqueued_at
    )
    WHERE status IN ('pending', 'retry');

CREATE INDEX IF NOT EXISTS location_backfill_queue_status_idx
    ON app.location_backfill_queue (status, updated_at DESC);

COMMENT ON TABLE app.location_backfill_queue IS
    'Persistent Dallas County parcel-coordinate work queue. Matched sales remain available while missing locations are retried outside interactive ranking requests.';

COMMIT;
