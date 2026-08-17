WITH main_improvement_present AS (
    SELECT account_id
    FROM core.primary_improvements
    WHERE NULLIF(btrim(construction_type), '') IS NOT NULL
       OR percent_complete IS NOT NULL
       OR year_built IS NOT NULL
       OR effective_year_built IS NOT NULL
       OR actual_age IS NOT NULL
       OR depreciation IS NOT NULL
       OR NULLIF(btrim(desirability), '') IS NOT NULL
       OR NULLIF(btrim(stories), '') IS NOT NULL
       OR living_area_sqft IS NOT NULL
       OR total_living_area IS NOT NULL
       OR bedroom_count IS NOT NULL
       OR bath_count IS NOT NULL
       OR number_units IS NOT NULL
       OR NULLIF(btrim(building_class), '') IS NOT NULL
       OR total_area_sqft IS NOT NULL
), value_only_vacant_land AS (
    SELECT value.account_id
    FROM core.value_summary_current value
    LEFT JOIN main_improvement_present improvement USING (account_id)
    WHERE improvement.account_id IS NULL
      AND value.market_value IS NOT NULL
      AND value.market_value > 0
      AND value.land_value = value.market_value
), adjusted AS (
    SELECT queue.account_id,
           array_remove(queue.requested_fields, 'gla') AS requested_fields,
           array_remove(queue.remaining_fields, 'gla') AS remaining_fields
    FROM app.dcad_field_repair_queue queue
    JOIN value_only_vacant_land USING (account_id)
    WHERE 'gla' = ANY(queue.remaining_fields)
      AND queue.status <> 'leased'
)
UPDATE app.dcad_field_repair_queue queue
SET requested_fields = adjusted.requested_fields,
    remaining_fields = adjusted.remaining_fields,
    status = CASE
        WHEN cardinality(adjusted.remaining_fields) = 0 THEN 'succeeded'
        ELSE queue.status
    END,
    attempts = CASE
        WHEN cardinality(adjusted.remaining_fields) = 0 THEN 0
        ELSE queue.attempts
    END,
    last_success_at = CASE
        WHEN cardinality(adjusted.remaining_fields) = 0 THEN now()
        ELSE queue.last_success_at
    END,
    reason = CASE
        WHEN cardinality(adjusted.remaining_fields) = 0
        THEN 'GLA is not applicable because DCAD reports no Main Improvement and land value equals market value'
        ELSE queue.reason
    END,
    last_error = CASE
        WHEN cardinality(adjusted.remaining_fields) = 0 THEN NULL
        ELSE queue.last_error
    END,
    lease_expires_at = CASE
        WHEN cardinality(adjusted.remaining_fields) = 0 THEN NULL
        ELSE queue.lease_expires_at
    END,
    worker_id = CASE
        WHEN cardinality(adjusted.remaining_fields) = 0 THEN NULL
        ELSE queue.worker_id
    END,
    updated_at = now()
FROM adjusted
WHERE queue.account_id = adjusted.account_id;
