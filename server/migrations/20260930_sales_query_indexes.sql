-- Subject report history and location-backfill seeding both retrieve legacy
-- sales by account and use closing_date for ordering or recency. The red-team
-- database already provisions this index; register it in the shared
-- application migrations so production and staging have the same query path.
DO $$
BEGIN
  IF to_regclass('core.sales') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS sales_account_closing_date_idx
      ON core.sales (account_id, closing_date DESC);
  END IF;
END
$$;
