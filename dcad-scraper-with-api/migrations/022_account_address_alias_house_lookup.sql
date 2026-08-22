BEGIN;

-- The fuzzy candidate audit begins with an exact house-number lookup and then
-- performs typo-tolerant street scoring in application code. This expression
-- index prevents that first step from scanning the complete alias inventory.
CREATE INDEX IF NOT EXISTS account_address_aliases_house_lookup_idx
    ON app.account_address_aliases (
        split_part(address_key, ' ', 1),
        city_key,
        postal_code5,
        source_priority DESC,
        account_id
    )
    WHERE is_current = true;

COMMIT;
