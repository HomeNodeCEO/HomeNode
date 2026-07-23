-- Prefix indexes for keystroke-by-keystroke address autocomplete.
-- C collation lets PostgreSQL use the same indexes for LIKE 'prefix%' and
-- for the matching ORDER BY, including one-character searches.
-- Run without an enclosing transaction so CONCURRENTLY does not interrupt
-- scraper upserts.

CREATE INDEX CONCURRENTLY IF NOT EXISTS accounts_address_autocomplete_idx
ON core.accounts (
  (upper(btrim(split_part(address, ',', 1))) COLLATE "C"),
  (upper(COALESCE(city, '')) COLLATE "C"),
  account_id
)
WHERE address IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS accounts_street_autocomplete_idx
ON core.accounts (
  (upper(street_name) COLLATE "C"),
  (upper(COALESCE(city, '')) COLLATE "C"),
  (upper(btrim(split_part(address, ',', 1))) COLLATE "C"),
  account_id
)
WHERE street_name IS NOT NULL;
