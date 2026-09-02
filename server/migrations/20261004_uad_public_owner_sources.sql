-- Ensure every deployment tier has the normalized public-record owner sources
-- required by the Section 2 owner backfill. Some legacy/staging databases only
-- contain owner_summary; an empty owner_parties table lets the next migration
-- fall back to that summary without changing existing owner data.

CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE IF NOT EXISTS core.owner_summary (
  account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
  tax_year integer NOT NULL,
  owner_name text,
  mailing_address text,
  PRIMARY KEY (account_id, tax_year)
);

CREATE TABLE IF NOT EXISTS core.owner_parties (
  id bigserial PRIMARY KEY,
  account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
  tax_year integer NOT NULL,
  owner_name text,
  ownership_pct numeric
);

CREATE INDEX IF NOT EXISTS owner_parties_account_year_idx
  ON core.owner_parties (account_id, tax_year DESC);
