-- Current, source-labeled physical characteristics for the prepared group index.
-- Null means unreported, not absence. These are not historical appraisal facts.
ALTER TABLE app.neighborhood_group_parcel_facts
  ADD COLUMN bedroom_count numeric,
  ADD COLUMN bath_count numeric,
  ADD COLUMN garage_area_sqft numeric,
  ADD COLUMN outbuilding_area_sqft numeric,
  ADD COLUMN pool boolean;

ALTER TABLE app.neighborhood_group_summary
  ADD COLUMN bedroom_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN median_bedroom_count double precision,
  ADD COLUMN bath_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN median_bath_count double precision,
  ADD COLUMN garage_area_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN median_garage_area_sqft double precision,
  ADD COLUMN outbuilding_area_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN median_outbuilding_area_sqft double precision,
  ADD COLUMN pool_observed_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN pool_present_count bigint NOT NULL DEFAULT 0;
