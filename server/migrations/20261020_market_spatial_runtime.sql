-- Runtime market requests must never perform schema maintenance or a full
-- account-location backfill. The application migration runner owns this
-- idempotent schema phase under bounded deployment-time lock and statement
-- budgets. Its post-migration phase commits each bounded data batch and builds
-- the GiST index concurrently before recording this migration as complete.
SELECT set_config('lock_timeout',
    least(CASE WHEN current_setting('lock_timeout')::interval = interval '0'
      THEN 5000 ELSE extract(epoch FROM current_setting('lock_timeout')::interval) * 1000 END, 5000)::text || 'ms', true),
  set_config('statement_timeout',
    least(CASE WHEN current_setting('statement_timeout')::interval = interval '0'
      THEN 120000 ELSE extract(epoch FROM current_setting('statement_timeout')::interval) * 1000 END, 120000)::text || 'ms', true);

CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE core.account_locations
  ADD COLUMN IF NOT EXISTS location_geom geometry(Point, 4326);

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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'account_locations_sync_geom'
      AND tgrelid = 'core.account_locations'::regclass
  ) THEN
    CREATE TRIGGER account_locations_sync_geom
    BEFORE INSERT OR UPDATE OF latitude, longitude
    ON core.account_locations
    FOR EACH ROW
    EXECUTE FUNCTION core.sync_account_location_geom();
  END IF;
END;
$$;
