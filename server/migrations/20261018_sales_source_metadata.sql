-- Existing CSV-only databases may predate the scraper's 018 readiness SQL.
-- Neighborhood reads need this shape without starting a Trestle worker or
-- changing listing-identity indexes. Unknown provider facts stay NULL.
-- Installations without the optional sales source retain that absent capability;
-- their CSV/Trestle ingestion owners already add these columns on creation.
ALTER TABLE IF EXISTS core.sales_source_records
  ADD COLUMN IF NOT EXISTS source_modified_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_system_name text;
