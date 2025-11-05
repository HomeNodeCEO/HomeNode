-- (same schema as before, abridged header)
CREATE TABLE IF NOT EXISTS parcels (
  account_id VARCHAR(32) PRIMARY KEY,
  situs_address TEXT, legal_desc TEXT, neighborhood TEXT, geo_id TEXT,
  first_seen TIMESTAMP NOT NULL DEFAULT NOW(), last_seen TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS main_improvements (
  id BIGSERIAL PRIMARY KEY, account_id VARCHAR(32) REFERENCES parcels(account_id),
  building_class TEXT, year_built INT, effective_year_built INT, actual_age INT, desirability TEXT,
  living_area_sqft NUMERIC, total_area_sqft NUMERIC, percent_complete NUMERIC, stories NUMERIC,
  depreciation_pct NUMERIC, construction_type TEXT, foundation TEXT, roof_type TEXT, roof_material TEXT,
  fence_type TEXT, exterior_material TEXT, basement BOOLEAN, heating TEXT, air_conditioning TEXT,
  baths_full INT, baths_half INT, kitchens INT, wet_bars INT, fireplaces INT,
  sprinkler BOOLEAN, deck BOOLEAN, spa BOOLEAN, pool BOOLEAN, sauna BOOLEAN,
  scraped_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS additional_improvements (
  id BIGSERIAL PRIMARY KEY, account_id VARCHAR(32) REFERENCES parcels(account_id),
  improvement_type TEXT, construction TEXT, floor TEXT, exterior_wall TEXT, area_sqft NUMERIC,
  scraped_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS land_lines (
  id BIGSERIAL PRIMARY KEY, account_id VARCHAR(32) REFERENCES parcels(account_id),
  state_code TEXT, zoning TEXT, frontage NUMERIC, depth NUMERIC, area_sqft NUMERIC,
  pricing_method TEXT, unit_price NUMERIC, market_adjustment NUMERIC, adjusted_price NUMERIC, ag_land BOOLEAN,
  scraped_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS owner_history (
  id BIGSERIAL PRIMARY KEY, account_id VARCHAR(32) REFERENCES parcels(account_id),
  owner_name TEXT, mail_address TEXT, mail_city TEXT, mail_state TEXT, mail_zip TEXT,
  observed_year INT, observed_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_owner_hist_acct ON owner_history(account_id);
CREATE TABLE IF NOT EXISTS value_history (
  account_id VARCHAR(32) REFERENCES parcels(account_id), tax_year INT,
  land_value NUMERIC, improvement_value NUMERIC, market_value NUMERIC, taxable_value NUMERIC,
  PRIMARY KEY (account_id, tax_year)
);
CREATE TABLE IF NOT EXISTS exemption_history (
  account_id VARCHAR(32) REFERENCES parcels(account_id), tax_year INT,
  code TEXT, description TEXT, amount NUMERIC, PRIMARY KEY (account_id, tax_year, code)
);
CREATE TABLE IF NOT EXISTS exemption_summary (
  account_id VARCHAR(32) REFERENCES parcels(account_id), tax_year INT,
  jurisdiction TEXT, taxing_unit TEXT, homestead_exemption NUMERIC, taxable_value NUMERIC,
  PRIMARY KEY (account_id, tax_year, jurisdiction)
);
CREATE TABLE IF NOT EXISTS estimated_taxes (
  account_id VARCHAR(32) REFERENCES parcels(account_id), tax_year INT,
  jurisdiction TEXT, taxing_unit TEXT, tax_rate_per_100 NUMERIC, taxable_value NUMERIC,
  estimated_taxes NUMERIC, tax_ceiling TEXT, PRIMARY KEY (account_id, tax_year, jurisdiction)
);
CREATE TABLE IF NOT EXISTS estimated_taxes_total (
  account_id VARCHAR(32) REFERENCES parcels(account_id), tax_year INT, total_estimated NUMERIC,
  PRIMARY KEY (account_id, tax_year)
);
CREATE TABLE IF NOT EXISTS scrape_log (
  id BIGSERIAL PRIMARY KEY, account_id VARCHAR(32), fetched_at TIMESTAMP NOT NULL DEFAULT NOW(),
  status TEXT, latency_ms INT, changed_fields JSONB
);
CREATE INDEX IF NOT EXISTS idx_scrape_log_acct ON scrape_log(account_id);
