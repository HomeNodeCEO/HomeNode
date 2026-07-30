BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE core.account_locations
  ADD COLUMN IF NOT EXISTS location_geom geometry(Point, 4326);

UPDATE core.account_locations
SET location_geom = ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)
WHERE latitude IS NOT NULL
  AND longitude IS NOT NULL
  AND (
    location_geom IS NULL
    OR ST_X(location_geom) IS DISTINCT FROM longitude
    OR ST_Y(location_geom) IS DISTINCT FROM latitude
  );

CREATE OR REPLACE FUNCTION core.sync_account_location_geom()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.location_geom :=
    CASE
      WHEN NEW.latitude IS NULL OR NEW.longitude IS NULL THEN NULL
      ELSE ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)
    END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS account_locations_sync_geom
  ON core.account_locations;

CREATE TRIGGER account_locations_sync_geom
BEFORE INSERT OR UPDATE OF latitude, longitude
ON core.account_locations
FOR EACH ROW
EXECUTE FUNCTION core.sync_account_location_geom();

CREATE INDEX IF NOT EXISTS account_locations_geom_gist_idx
  ON core.account_locations
  USING GIST (location_geom)
  WHERE status = 'matched' AND location_geom IS NOT NULL;

COMMIT;
