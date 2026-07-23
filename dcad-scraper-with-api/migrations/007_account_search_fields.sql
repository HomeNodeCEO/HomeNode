-- Search metadata from the DCAD account export. Keeping the house number in
-- accounts.address and the street/city in separate fields lets property search
-- return same-street, same-city results without scanning every account.

ALTER TABLE core.accounts
    ADD COLUMN IF NOT EXISTS street_name text,
    ADD COLUMN IF NOT EXISTS city text,
    ADD COLUMN IF NOT EXISTS postal_code text;

CREATE INDEX IF NOT EXISTS accounts_address_upper_idx
    ON core.accounts (upper(btrim(address)));

CREATE INDEX IF NOT EXISTS accounts_address_line_upper_idx
    ON core.accounts (upper(btrim(split_part(address, ',', 1))))
    WHERE address IS NOT NULL;

CREATE INDEX IF NOT EXISTS accounts_street_name_upper_pattern_idx
    ON core.accounts (upper(street_name) text_pattern_ops)
    WHERE street_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS accounts_city_street_upper_idx
    ON core.accounts (upper(city), upper(street_name) text_pattern_ops)
    WHERE city IS NOT NULL AND street_name IS NOT NULL;
