const DEFAULT_ACCOUNT_SALES_HISTORY_LIMIT = 40;
const MAX_ACCOUNT_SALES_HISTORY_LIMIT = 200;

function normalizeLimit(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_ACCOUNT_SALES_HISTORY_LIMIT;
  }
  return Math.min(parsed, MAX_ACCOUNT_SALES_HISTORY_LIMIT);
}

/**
 * Return the subject's MLS listing/contract/closed-sale activity plus CAD deed
 * transfers. The indexed source lookups include primary and additional-parcel
 * links. A legacy sale is suppressed only when its date and price already
 * match an MLS source record for the same account.
 */
export async function getAccountPropertyActivityHistory(pool, accountId, requestedLimit) {
  const normalizedAccountId = String(accountId || "").trim();
  if (!normalizedAccountId) return [];

  const limit = normalizeLimit(requestedLimit);
  const sql = `
    WITH candidate_source_records AS MATERIALIZED (
      SELECT id AS source_record_id
      FROM core.sales_source_records
      WHERE primary_account_id = $1

      UNION

      SELECT source_record_id
      FROM core.sale_parcels
      WHERE account_id = $1
        AND source_record_id IS NOT NULL
    ),
    source_history AS (
      SELECT
        sale.id AS sale_id,
        source_record.id AS source_record_id,
        source_record.listing_key,
        source_record.listing_id,
        source_record.source_name AS source,
        CASE
          WHEN source_record.record_type = 'closed_sale' THEN 'closed_sale'
          WHEN COALESCE(source_record.mls_status, '') ~* '(pending|contract|option)' THEN 'contract'
          ELSE 'listing'
        END AS record_type,
        CASE
          WHEN source_record.record_type = 'closed_sale'
            THEN COALESCE(sale.closing_date, source_record.close_date)
          ELSE source_record.listing_contract_date
        END AS activity_date,
        source_record.listing_contract_date AS listing_date,
        NULL::date AS contract_date,
        COALESCE(sale.closing_date, source_record.close_date) AS closing_date,
        CASE WHEN source_record.record_type = 'listing'
          THEN source_record.current_price ELSE NULL END AS list_price,
        COALESCE(sale.sale_price, source_record.current_price) AS sale_price,
        COALESCE(sale.days_on_market, source_record.days_on_market) AS days_on_market,
        source_record.buyer_financing,
        COALESCE(sale.concessions, source_record.seller_contributions::text) AS concessions,
        source_record.mls_status,
        source_record.requires_additional_review,
        source_record.data_quality_flags
      FROM candidate_source_records candidate
      JOIN core.sales_source_records source_record
        ON source_record.id = candidate.source_record_id
      LEFT JOIN core.sales sale
        ON sale.source_record_id = source_record.id
    ),
    legacy_history AS (
      SELECT
        sale.id AS sale_id,
        NULL::bigint AS source_record_id,
        NULL::text AS listing_key,
        NULL::text AS listing_id,
        COALESCE(sale.source, 'Legacy sale record') AS source,
        'closed_sale'::text AS record_type,
        sale.closing_date AS activity_date,
        NULL::date AS listing_date,
        NULL::date AS contract_date,
        sale.closing_date,
        NULL::numeric AS list_price,
        sale.sale_price,
        sale.days_on_market,
        NULL::text AS buyer_financing,
        sale.concessions,
        NULL::text AS mls_status,
        false AS requires_additional_review,
        '[]'::jsonb AS data_quality_flags
      FROM core.sales sale
      WHERE sale.account_id = $1
        AND sale.source_record_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM source_history source
          WHERE source.record_type = 'closed_sale'
            AND source.closing_date IS NOT DISTINCT FROM sale.closing_date
            AND source.sale_price IS NOT DISTINCT FROM sale.sale_price
        )
    ),
    cad_transfers AS (
      SELECT DISTINCT ON (deed_transfer_date)
        NULL::bigint AS sale_id,
        NULL::bigint AS source_record_id,
        NULL::text AS listing_key,
        NULL::text AS listing_id,
        'CAD deed record'::text AS source,
        'cad_transfer'::text AS record_type,
        deed_transfer_date AS activity_date,
        NULL::date AS listing_date,
        NULL::date AS contract_date,
        NULL::date AS closing_date,
        NULL::numeric AS list_price,
        NULL::numeric AS sale_price,
        NULL::integer AS days_on_market,
        NULL::text AS buyer_financing,
        NULL::text AS concessions,
        NULL::text AS mls_status,
        false AS requires_additional_review,
        '[]'::jsonb AS data_quality_flags
      FROM (
        SELECT deed_transfer_date
        FROM core.legal_description_current
        WHERE account_id = $1
          AND deed_transfer_date > DATE '1900-01-01'
        UNION ALL
        SELECT deed_transfer_date
        FROM core.legal_description_history
        WHERE account_id = $1
          AND deed_transfer_date > DATE '1900-01-01'
      ) transfers
      ORDER BY deed_transfer_date DESC
    )
    SELECT *
    FROM (
      SELECT * FROM source_history
      UNION ALL
      SELECT * FROM legacy_history
      UNION ALL
      SELECT * FROM cad_transfers
    ) history
    WHERE history.activity_date IS NOT NULL
       OR history.sale_price IS NOT NULL
       OR history.list_price IS NOT NULL
    ORDER BY history.activity_date DESC NULLS LAST,
             history.source_record_id DESC NULLS LAST,
             history.sale_id DESC NULLS LAST
    LIMIT $2
  `;

  const { rows } = await pool.query(sql, [normalizedAccountId, limit]);
  return rows || [];
}

/** Compatibility helper for callers that still need closed sales only. */
export async function getAccountSalesHistory(pool, accountId, requestedLimit) {
  const rows = await getAccountPropertyActivityHistory(pool, accountId, requestedLimit);
  return rows.filter((row) => row.record_type === "closed_sale");
}

export const ACCOUNT_SALES_HISTORY_LIMITS = Object.freeze({
  default: DEFAULT_ACCOUNT_SALES_HISTORY_LIMIT,
  maximum: MAX_ACCOUNT_SALES_HISTORY_LIMIT,
});
