-- Support subject history and legacy-sale recency lookups by their leading
-- account predicate. This migration runs after core.sales is provisioned.
CREATE INDEX IF NOT EXISTS sales_account_closing_date_idx
  ON core.sales (account_id, closing_date DESC);
