ALTER TABLE app.dcad_residential_campaign
    ADD COLUMN IF NOT EXISTS upstream_failure_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS outage_pause_started_at timestamptz,
    ADD COLUMN IF NOT EXISTS outage_paused_until timestamptz,
    ADD COLUMN IF NOT EXISTS outage_last_error text,
    ADD COLUMN IF NOT EXISTS outage_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS outage_probe_worker_id text,
    ADD COLUMN IF NOT EXISTS outage_probe_lease_expires_at timestamptz;

ALTER TABLE app.dcad_residential_campaign
    DROP CONSTRAINT IF EXISTS dcad_residential_campaign_upstream_failure_count_check;

ALTER TABLE app.dcad_residential_campaign
    ADD CONSTRAINT dcad_residential_campaign_upstream_failure_count_check
        CHECK (upstream_failure_count >= 0);

ALTER TABLE app.dcad_residential_campaign
    DROP CONSTRAINT IF EXISTS dcad_residential_campaign_outage_count_check;

ALTER TABLE app.dcad_residential_campaign
    ADD CONSTRAINT dcad_residential_campaign_outage_count_check
        CHECK (outage_count >= 0);
