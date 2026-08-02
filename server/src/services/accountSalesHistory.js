const DEFAULT_ACCOUNT_SALES_HISTORY_LIMIT = 20;
const MAX_ACCOUNT_SALES_HISTORY_LIMIT = 100;

function normalizeLimit(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_ACCOUNT_SALES_HISTORY_LIMIT;
  }
  return Math.min(parsed, MAX_ACCOUNT_SALES_HISTORY_LIMIT);
}

/**
 * Return sale history for one account without expanding the general-purpose
 * sales view. The three candidate lookups use existing account indexes and
 * include primary, additional-parcel, and legacy sales.
 */
export async function getAccountSalesHistory(pool, accountId, requestedLimit) {
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
        source_record.listing_id,
        COALESCE(sale.closing_date, source_record.close_date) AS closing_date,
        COALESCE(sale.sale_price, source_record.current_price) AS sale_price,
        COALESCE(sale.days_on_market, source_record.days_on_market) AS days_on_market,
        source_record.buyer_financing,
        source_record.mls_status,
        'closed_sale'::text AS record_type
      FROM candidate_source_records candidate
      JOIN core.sales_source_records source_record
        ON source_record.id = candidate.source_record_id
      LEFT JOIN core.sales sale
        ON sale.source_record_id = source_record.id
      WHERE source_record.record_type = 'closed_sale'
    ),
    legacy_history AS (
      SELECT
        sale.id AS sale_id,
        NULL::bigint AS source_record_id,
        NULL::text AS listing_id,
        sale.closing_date,
        sale.sale_price,
        sale.days_on_market,
        NULL::text AS buyer_financing,
        NULL::text AS mls_status,
        'closed_sale'::text AS record_type
      FROM core.sales sale
      WHERE sale.account_id = $1
        AND sale.source_record_id IS NULL
    )
    SELECT *
    FROM (
      SELECT * FROM source_history
      UNION ALL
      SELECT * FROM legacy_history
    ) history
    WHERE history.closing_date IS NOT NULL
       OR history.sale_price IS NOT NULL
    ORDER BY history.closing_date DESC NULLS LAST,
             history.source_record_id DESC NULLS LAST,
             history.sale_id DESC NULLS LAST
    LIMIT $2
  `;

  const { rows } = await pool.query(sql, [normalizedAccountId, limit]);
  return rows || [];
}

export const ACCOUNT_SALES_HISTORY_LIMITS = Object.freeze({
  default: DEFAULT_ACCOUNT_SALES_HISTORY_LIMIT,
  maximum: MAX_ACCOUNT_SALES_HISTORY_LIMIT,
});
