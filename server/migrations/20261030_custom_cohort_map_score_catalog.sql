-- Preserve old immutable catalogs; prepare a new format once so historical
-- workspaces with a v1 cache missing display scores do not remain gray forever.
-- No source data, geometry, context or assignment is changed.
-- The original unnamed check has a PostgreSQL-shortened identifier. Resolve
-- only the single-column format check, rather than guessing that identifier.
DO $$
DECLARE format_check text;
BEGIN
  SELECT conname INTO STRICT format_check FROM pg_constraint
  WHERE conrelid = 'app.neighborhood_custom_cohort_prepared_catalogs'::regclass
    AND contype = 'c' AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
      WHERE attrelid = 'app.neighborhood_custom_cohort_prepared_catalogs'::regclass
        AND attname = 'format_version')]::smallint[];
  EXECUTE format('ALTER TABLE app.neighborhood_custom_cohort_prepared_catalogs DROP CONSTRAINT %I', format_check);
END $$;
ALTER TABLE app.neighborhood_custom_cohort_prepared_catalogs
  ADD CONSTRAINT neighborhood_prepared_catalog_format_check
  CHECK (format_version IN (1, 2));
