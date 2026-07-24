CREATE TABLE IF NOT EXISTS core.account_locations (
  account_id                  varchar(32) PRIMARY KEY
                              REFERENCES core.accounts(account_id) ON DELETE CASCADE,
  latitude                    double precision,
  longitude                   double precision,
  status                      text NOT NULL DEFAULT 'matched'
                              CHECK (status IN ('matched', 'not_found', 'invalid')),
  source                      text NOT NULL,
  precision                   text,
  confidence                  text
                              CHECK (confidence IS NULL OR confidence IN ('high', 'medium', 'low')),
  match_method                text,
  source_parcel_id            text,
  source_site_address         text,
  source_neighborhood_code    text,
  source_living_area_sqft     numeric,
  source_updated_at           timestamptz,
  geocoded_at                 timestamptz NOT NULL DEFAULT now(),
  feature_count               integer NOT NULL DEFAULT 0,
  review_required             boolean NOT NULL DEFAULT false,
  review_reason               text,
  metadata                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (latitude IS NULL AND longitude IS NULL)
    OR (
      latitude BETWEEN -90 AND 90
      AND longitude BETWEEN -180 AND 180
    )
  )
);

CREATE INDEX IF NOT EXISTS account_locations_coordinate_idx
  ON core.account_locations(latitude, longitude)
  WHERE status = 'matched';

CREATE INDEX IF NOT EXISTS account_locations_geocoded_at_idx
  ON core.account_locations(geocoded_at);
