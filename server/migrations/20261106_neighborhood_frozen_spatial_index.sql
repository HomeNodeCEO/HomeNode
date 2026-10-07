-- Fixed-radius reads operate on an immutable nightly version, not live GIS.
-- This exact geography expression preserves spheroid distance semantics. No
-- approximate degree envelope or polygon simplification defines membership.
CREATE INDEX neighborhood_frozen_source_geography_idx
  ON app.neighborhood_frozen_source_rows USING gist((geom::geography))
  WHERE kind='parcels' AND geom IS NOT NULL;
CREATE INDEX neighborhood_frozen_parcel_account_key_idx
  ON app.neighborhood_frozen_source_rows(generation_id,account_id COLLATE "C",(row_key::bigint))
  WHERE kind='parcels' AND account_id IS NOT NULL;
