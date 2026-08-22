BEGIN;

-- Supports background sales-address reconciliation against Dallas County
-- residential targets that have not completed their first CAD scrape yet.
-- The fuzzy scorer still requires exact house-number and city evidence and
-- never treats an incomplete target as an automatic match.
CREATE INDEX IF NOT EXISTS dcad_residential_targets_address_lookup_idx
    ON app.dcad_residential_targets (
        upper(btrim(source_city)),
        split_part(upper(btrim(source_address)), ' ', 1),
        account_id
    )
    WHERE NULLIF(btrim(source_address), '') IS NOT NULL
      AND NULLIF(btrim(source_city), '') IS NOT NULL;

COMMIT;
