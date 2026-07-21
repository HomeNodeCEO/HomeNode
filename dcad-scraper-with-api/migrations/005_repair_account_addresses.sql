BEGIN;

-- Repair legacy rows where the scrape snapshot contains a situs address but
-- core.accounts.address was never populated. Existing nonblank addresses are
-- authoritative and are never overwritten.
WITH latest_raw AS MATERIALIZED (
    SELECT DISTINCT ON (r.account_id)
           r.account_id,
           COALESCE(
               NULLIF(BTRIM(r.raw #>> '{detail,property_location,address}'), ''),
               NULLIF(BTRIM(r.raw #>> '{detail,property_location,subject_address}'), '')
           ) AS address
    FROM core.dcad_json_raw r
    WHERE COALESCE(
              NULLIF(BTRIM(r.raw #>> '{detail,property_location,address}'), ''),
              NULLIF(BTRIM(r.raw #>> '{detail,property_location,subject_address}'), '')
          ) IS NOT NULL
    ORDER BY r.account_id, r.tax_year DESC, r.fetched_at DESC
)
UPDATE core.accounts a
SET address = latest_raw.address
FROM latest_raw
WHERE a.account_id = latest_raw.account_id
  AND NULLIF(BTRIM(a.address), '') IS NULL;

COMMIT;
