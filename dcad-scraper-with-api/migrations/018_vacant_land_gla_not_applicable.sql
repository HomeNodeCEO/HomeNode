WITH vacant_land AS (
    SELECT account_id
    FROM core.land_detail
    GROUP BY account_id
    HAVING bool_or(upper(state_code) LIKE '%VACANT%')
       AND NOT bool_or(
           NULLIF(btrim(state_code), '') IS NOT NULL
           AND upper(state_code) NOT LIKE '%VACANT%'
       )
), adjusted AS (
    SELECT queue.account_id,
           array_remove(queue.requested_fields, 'gla') AS requested_fields,
           array_remove(queue.remaining_fields, 'gla') AS remaining_fields
    FROM app.dcad_field_repair_queue queue
    JOIN vacant_land USING (account_id)
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
        THEN 'GLA is not applicable because CAD classifies the account as vacant land'
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
