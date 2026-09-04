import { assertNonDallasEnrichmentCounty } from "../util/nonDallasEnrichment.js";

export async function getNonDallasAccount(client, accountId) {
  const { rows } = await client.query(
    "SELECT account_id, county FROM core.accounts WHERE account_id = $1",
    [accountId],
  );
  if (!rows.length) return null;
  return {
    ...rows[0],
    normalized_county: assertNonDallasEnrichmentCounty(rows[0].county),
  };
}

export async function ensurePropertyEnrichmentSchema(pool) {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS app;

    CREATE TABLE IF NOT EXISTS app.property_attribute_manual_values (
      account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      attribute_key text NOT NULL,
      attribute_value jsonb NOT NULL,
      notes text,
      reviewer text NOT NULL DEFAULT 'HomeNode editor',
      revision integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (account_id, attribute_key)
    );

    CREATE TABLE IF NOT EXISTS app.property_attribute_manual_history (
      id bigserial PRIMARY KEY,
      account_id text NOT NULL,
      attribute_key text NOT NULL,
      attribute_value jsonb NOT NULL,
      notes text,
      reviewer text NOT NULL,
      revision integer NOT NULL,
      changed_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS property_manual_history_idx
      ON app.property_attribute_manual_history
        (account_id, attribute_key, changed_at DESC);

    CREATE TABLE IF NOT EXISTS app.property_attribute_observations (
      id bigserial PRIMARY KEY,
      account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      county text NOT NULL,
      attribute_key text NOT NULL,
      attribute_value jsonb,
      source_type text NOT NULL,
      source_reference text,
      source_observed_at timestamptz,
      confidence numeric(5,4),
      raw_payload jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT property_observation_source_valid CHECK
        (source_type IN ('trestle','cad','gis','manual'))
    );
    CREATE INDEX IF NOT EXISTS property_observation_account_idx
      ON app.property_attribute_observations
        (account_id, attribute_key, created_at DESC);

    CREATE TABLE IF NOT EXISTS app.enrichment_review_queue (
      account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      county text NOT NULL,
      attribute_key text NOT NULL,
      reason text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
      first_flagged_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz,
      PRIMARY KEY (account_id, attribute_key),
      CONSTRAINT enrichment_review_status_valid CHECK
        (status IN ('pending','approved','rejected','resolved'))
    );

    CREATE TABLE IF NOT EXISTS app.parcel_geometry_suggestions (
      id bigserial PRIMARY KEY,
      account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      county text NOT NULL,
      source_url text NOT NULL,
      geometry jsonb NOT NULL,
      area_square_feet numeric,
      area_acres numeric,
      source_attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'pending',
      reviewed_by text,
      reviewed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT parcel_suggestion_status_valid CHECK
        (status IN ('pending','approved','rejected'))
    );
    CREATE INDEX IF NOT EXISTS parcel_suggestion_account_idx
      ON app.parcel_geometry_suggestions (account_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS app.enrichment_runs (
      id bigserial PRIMARY KEY,
      county text NOT NULL,
      provider text NOT NULL,
      status text NOT NULL DEFAULT 'queued',
      processed_count integer NOT NULL DEFAULT 0,
      resolved_count integer NOT NULL DEFAULT 0,
      review_count integer NOT NULL DEFAULT 0,
      error_count integer NOT NULL DEFAULT 0,
      started_at timestamptz,
      completed_at timestamptz,
      details jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

