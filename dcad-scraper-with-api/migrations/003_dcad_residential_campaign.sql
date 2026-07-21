CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.dcad_residential_campaign (
    campaign_key                    text PRIMARY KEY,
    source_filename                 text NOT NULL,
    source_sha256                   text NOT NULL,
    total_source_rows               integer NOT NULL,
    total_valid_targets             integer NOT NULL,
    invalid_source_rows             integer NOT NULL DEFAULT 0,
    initial_missing_count           integer NOT NULL,
    phase                           text NOT NULL,
    cycle_number                    integer NOT NULL DEFAULT 0,
    loaded_at                       timestamptz NOT NULL DEFAULT now(),
    phase_started_at                timestamptz NOT NULL DEFAULT now(),
    initial_completed_at            timestamptz,
    current_cycle_started_at        timestamptz,
    last_cycle_completed_at         timestamptz,
    updated_at                      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dcad_residential_campaign_phase_check
        CHECK (phase IN ('initial_missing', 'full_cycle'))
);

CREATE TABLE IF NOT EXISTS app.dcad_residential_targets (
    account_id              text PRIMARY KEY,
    source_position         integer NOT NULL UNIQUE,
    source_filename         text NOT NULL,
    source_sha256           text NOT NULL,
    initial_missing         boolean NOT NULL,
    initial_completed_at    timestamptz,
    last_completed_cycle    integer NOT NULL DEFAULT 0,
    last_cycle_success_at   timestamptz,
    imported_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dcad_residential_targets_initial_idx
    ON app.dcad_residential_targets
    (initial_completed_at, source_position)
    WHERE initial_missing;

CREATE INDEX IF NOT EXISTS dcad_residential_targets_cycle_idx
    ON app.dcad_residential_targets
    (last_completed_cycle, source_position);

CREATE TABLE IF NOT EXISTS app.dcad_campaign_events (
    event_id        bigserial PRIMARY KEY,
    campaign_key    text NOT NULL,
    event_type      text NOT NULL,
    cycle_number    integer NOT NULL DEFAULT 0,
    event_payload   jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    notified_at     timestamptz,
    CONSTRAINT dcad_campaign_events_unique
        UNIQUE (campaign_key, event_type, cycle_number)
);

CREATE INDEX IF NOT EXISTS dcad_campaign_events_created_idx
    ON app.dcad_campaign_events (created_at DESC);
