const ACCOUNT_ID_PATTERN = /^[0-9A-Za-z]{17}$/;

function optionalText(value, maximumLength) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, maximumLength) : null;
}

export function normalizeSalesReconciliationUpdate(input = {}) {
  const accountId = String(input.account_id ?? "").trim();
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error("invalid_account_id");
  }
  return {
    accountId,
    notes: optionalText(input.notes, 2000),
    reviewer: optionalText(input.reviewer, 200) || "HomeNode editor",
  };
}

export async function ensureSalesReconciliationSchema(pool) {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS app;

    ALTER TABLE core.sales_source_records
      DROP CONSTRAINT IF EXISTS sales_source_records_match_status_check;
    ALTER TABLE core.sales_source_records
      ADD CONSTRAINT sales_source_records_match_status_check
      CHECK (
        match_status = ANY (
          ARRAY[
            'exact', 'normalized', 'secondary', 'multiple', 'unmatched',
            'manual_verified'
          ]::text[]
        )
      );

    ALTER TABLE core.sale_parcels
      DROP CONSTRAINT IF EXISTS sale_parcels_match_method_check;
    ALTER TABLE core.sale_parcels
      ADD CONSTRAINT sale_parcels_match_method_check
      CHECK (
        match_method = ANY (
          ARRAY[
            'exact', 'punctuation_normalized', 'embedded_full_id',
            'concatenated_full_ids', 'unmatched', 'manual_verified'
          ]::text[]
        )
      );

    CREATE TABLE IF NOT EXISTS app.sales_reconciliation_history (
      id                  bigserial PRIMARY KEY,
      source_record_id    bigint NOT NULL
                            REFERENCES core.sales_source_records(id)
                            ON DELETE CASCADE,
      listing_id          text,
      previous_account_id text,
      verified_account_id text NOT NULL
                            REFERENCES core.accounts(account_id),
      notes               text,
      reviewer            text NOT NULL DEFAULT 'HomeNode editor',
      verified_at         timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS sales_reconciliation_history_source_idx
      ON app.sales_reconciliation_history (source_record_id, verified_at DESC);
  `);
}

function queueReasons(row) {
  const reasons = [];
  if (!row.primary_account_id) reasons.push("No CAD account matched");
  if (row.match_status === "multiple") reasons.push("Multiple CAD matches");
  if (row.has_unresolved_parcel) reasons.push("Unresolved parcel number");
  if (row.canonical_sale_id == null) reasons.push("Not yet available as a canonical sale");
  return reasons;
}

export async function listSalesReconciliationQueue(
  pool,
  { limit = 20, offset = 0 } = {},
) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const { rows } = await pool.query(
    `
      SELECT
        COUNT(*) OVER ()::integer AS queue_total,
        source.id AS source_record_id,
        source.listing_id,
        source.source_name,
        source.source_filename,
        source.source_row_number,
        source.record_type,
        source.mls_status,
        source.close_date AS closing_date,
        source.current_price AS sale_price,
        source.days_on_market,
        source.listing_contract_date,
        source.bedrooms_total,
        source.bathrooms_total_integer,
        source.bathrooms_full,
        source.bathrooms_half,
        source.living_area,
        source.year_built,
        source.structural_style,
        source.architectural_style,
        source.attachment_type,
        source.parcel_number_raw,
        source.parcel_number2_raw,
        source.primary_account_id,
        source.match_status,
        source.multi_parcel_status,
        source.has_unresolved_parcel,
        source.requires_additional_review,
        source.data_quality_flags,
        source.raw_payload,
        canonical.id AS canonical_sale_id
      FROM core.sales_source_records source
      LEFT JOIN core.sales canonical
        ON canonical.source_record_id = source.id
      WHERE source.record_type = 'closed_sale'
        AND source.match_status <> 'manual_verified'
        AND (
          source.primary_account_id IS NULL
          OR source.match_status IN ('unmatched', 'multiple')
          OR source.has_unresolved_parcel
        )
      ORDER BY source.close_date DESC NULLS LAST,
               source.current_price DESC NULLS LAST,
               source.id DESC
      LIMIT $1 OFFSET $2
    `,
    [safeLimit, safeOffset],
  );
  return {
    total: Number(rows[0]?.queue_total || 0),
    limit: safeLimit,
    offset: safeOffset,
    items: rows.map(({ queue_total: _queueTotal, raw_payload: rawPayload, ...row }) => ({
      ...row,
      address_hint:
        rawPayload?.UnparsedAddress ||
        rawPayload?.Address ||
        rawPayload?.StreetAddress ||
        null,
      queue_reasons: queueReasons(row),
    })),
  };
}

export async function reconcileSalesSourceRecord(
  pool,
  sourceRecordId,
  input,
) {
  const id = String(sourceRecordId ?? "").trim();
  if (!/^\d+$/.test(id)) throw new Error("invalid_source_record_id");
  const update = normalizeSalesReconciliationUpdate(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sourceResult = await client.query(
      `
        SELECT *
        FROM core.sales_source_records
        WHERE id = $1
        FOR UPDATE
      `,
      [id],
    );
    if (!sourceResult.rowCount) throw new Error("source_record_not_found");
    const source = sourceResult.rows[0];
    if (source.record_type !== "closed_sale") {
      throw new Error("source_record_not_closed_sale");
    }

    const accountResult = await client.query(
      `
        SELECT
          requested.account_id AS requested_account_id,
          COALESCE(
            NULLIF(BTRIM(requested.canonical_account_id), ''),
            requested.account_id
          ) AS account_id,
          canonical.address,
          canonical.city,
          canonical.postal_code,
          canonical.county
        FROM core.accounts requested
        JOIN core.accounts canonical
          ON canonical.account_id = COALESCE(
            NULLIF(BTRIM(requested.canonical_account_id), ''),
            requested.account_id
          )
        WHERE requested.account_id = $1
      `,
      [update.accountId],
    );
    if (!accountResult.rowCount) throw new Error("account_not_found");
    const account = accountResult.rows[0];

    const parcelResult = await client.query(
      `
        UPDATE core.sale_parcels
        SET account_id = $2,
            parcel_number_normalized = $2,
            match_method = 'manual_verified',
            is_resolved = true
        WHERE id = (
          SELECT id
          FROM core.sale_parcels
          WHERE source_record_id = $1
          ORDER BY source_position, parcel_sequence
          LIMIT 1
        )
        RETURNING id
      `,
      [id, account.account_id],
    );
    if (!parcelResult.rowCount) {
      await client.query(
        `
          INSERT INTO core.sale_parcels (
            source_record_id, source_position, parcel_sequence, parcel_role,
            parcel_number_raw, parcel_number_normalized, account_id,
            match_method, is_resolved
          ) VALUES ($1, 1, 1, 'primary', $2, $3, $3, 'manual_verified', true)
        `,
        [id, source.parcel_number_raw, account.account_id],
      );
    }

    const parcelCoverageResult = await client.query(
      `
        SELECT COUNT(*) FILTER (WHERE NOT is_resolved)::integer AS unresolved_count
        FROM core.sale_parcels
        WHERE source_record_id = $1
      `,
      [id],
    );
    const unresolvedCount = Number(
      parcelCoverageResult.rows[0]?.unresolved_count || 0,
    );

    const updatedSourceResult = await client.query(
      `
        WITH remaining_flags AS (
          SELECT COALESCE(JSONB_AGG(flag), '[]'::jsonb) AS flags
          FROM JSONB_ARRAY_ELEMENTS_TEXT(
            COALESCE($3::jsonb, '[]'::jsonb)
          ) AS item(flag)
          WHERE flag <> 'unresolved_parcel_number'
        )
        UPDATE core.sales_source_records
        SET primary_account_id = $2,
            match_status = 'manual_verified',
            has_unresolved_parcel = $4,
            data_quality_flags = remaining_flags.flags,
            requires_additional_review = (
              $4
              OR JSONB_ARRAY_LENGTH(remaining_flags.flags) > 0
            ),
            updated_at = now()
        FROM remaining_flags
        WHERE id = $1
        RETURNING core.sales_source_records.*
      `,
      [
        id,
        account.account_id,
        JSON.stringify(source.data_quality_flags || []),
        unresolvedCount > 0,
      ],
    );

    let saleResult = await client.query(
      `
        UPDATE core.sales
        SET account_id = $2,
            address = COALESCE($3, address),
            city = COALESCE($4, city),
            state = COALESCE(state, 'TX'),
            zip = COALESCE($5, zip),
            closing_date = COALESCE($6, closing_date),
            sale_price = COALESCE($7, sale_price),
            days_on_market = COALESCE($8, days_on_market),
            concessions = COALESCE($9, concessions),
            source = COALESCE($10, source),
            loaded_at = now()
        WHERE source_record_id = $1
        RETURNING id
      `,
      [
        id,
        account.account_id,
        account.address,
        account.city,
        account.postal_code,
        source.close_date,
        source.current_price,
        source.days_on_market,
        source.seller_contributions == null
          ? null
          : String(source.seller_contributions),
        source.source_name,
      ],
    );
    if (!saleResult.rowCount) {
      saleResult = await client.query(
        `
          INSERT INTO core.sales (
            account_id, address, city, state, zip, closing_date, sale_price,
            days_on_market, concessions, source, source_record_id
          ) VALUES ($1, $2, $3, 'TX', $4, $5, $6, $7, $8, $9, $10)
          RETURNING id
        `,
        [
          account.account_id,
          account.address,
          account.city,
          account.postal_code,
          source.close_date,
          source.current_price,
          source.days_on_market,
          source.seller_contributions == null
            ? null
            : String(source.seller_contributions),
          source.source_name,
          id,
        ],
      );
    }

    await client.query(
      `
        INSERT INTO app.sales_reconciliation_history (
          source_record_id, listing_id, previous_account_id,
          verified_account_id, notes, reviewer
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        id,
        source.listing_id,
        source.primary_account_id,
        account.account_id,
        update.notes,
        update.reviewer,
      ],
    );
    await client.query("COMMIT");
    return {
      source_record: updatedSourceResult.rows[0],
      sale_id: saleResult.rows[0].id,
      account,
      unresolved_parcel_count: unresolvedCount,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
