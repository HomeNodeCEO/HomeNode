const DALLAS_ACCOUNT_ID_PATTERN = /^[0-9A-Za-z]{17}$/;
const NATIVE_ACCOUNT_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z ._\/#-]{3,99}$/;
const COLLIN_ACCOUNT_REFERENCE_PATTERN = /^(?=.{4,100}$)(?=.*\d)R[0-9A-Za-z._\/#-]+$/i;
const COLLIN_ACCOUNT_ID_PATTERN = /^(?=.{6,100}$)(?=.*\d)R-[0-9A-Za-z]+(?:-[0-9A-Za-z]+)+$/i;

function normalizedCounty(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+COUNTY$/, "");
}

export function countyFromNativeAccountId(value) {
  const accountId = String(value ?? "").trim();
  return COLLIN_ACCOUNT_REFERENCE_PATTERN.test(accountId) ? "COLLIN" : null;
}

export function normalizedCountyAccountKey(value, county = null) {
  let key = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "");
  if (normalizedCounty(county) === "COLLIN" || /^R/i.test(String(value ?? "").trim())) {
    key = key.replace(/^R/, "");
  }
  return key;
}

export function homeNodeCollinAccountIdFromPropertyId(value) {
  const propertyId = String(value ?? "").trim();
  if (!/^\d{1,17}$/.test(propertyId)) return null;
  return propertyId.padStart(17, "0");
}

export function validateSalesReconciliationAccountId(value, county = null) {
  const accountId = String(value ?? "").trim();
  if (!NATIVE_ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error("invalid_account_id");
  }

  const normalizedAccountCounty = normalizedCounty(county);
  const inferredCounty = countyFromNativeAccountId(accountId);
  if (normalizedAccountCounty === "DALLAS" && !DALLAS_ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error("invalid_dallas_account_id");
  }
  if (normalizedAccountCounty === "COLLIN" && !COLLIN_ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error("invalid_collin_account_id");
  }
  if (inferredCounty === "COLLIN" && normalizedAccountCounty && normalizedAccountCounty !== "COLLIN") {
    throw new Error("account_county_mismatch");
  }
  return accountId;
}

function optionalText(value, maximumLength) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, maximumLength) : null;
}

function normalizedPayloadValues(rawPayload) {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return new Map();
  }
  const values = new Map();
  const visit = (record) => {
    for (const [key, value] of Object.entries(record || {})) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        visit(value);
        continue;
      }
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (normalizedKey && !values.has(normalizedKey)) values.set(normalizedKey, value);
    }
  };
  visit(rawPayload);
  return values;
}

function firstPayloadValue(values, keys) {
  for (const key of keys) {
    const value = values.get(key);
    if (value !== null && value !== undefined && String(value).trim()) return value;
  }
  return null;
}

function coordinate(value, kind) {
  const parsed = Number(String(value ?? "").replace(/,/g, "").trim());
  if (!Number.isFinite(parsed)) return null;
  const withinTexas = kind === "latitude"
    ? parsed >= 25.5 && parsed <= 36.6
    : parsed >= -106.7 && parsed <= -93.4;
  return withinTexas ? parsed : null;
}

export function salesSourceLocationEvidence(rawPayload) {
  const values = normalizedPayloadValues(rawPayload);
  const address = optionalText(firstPayloadValue(values, [
    "unparsedaddress",
    "propertyaddress",
    "fulladdress",
    "streetaddress",
    "address",
    "addressfull",
  ]), 500);
  const latitude = coordinate(firstPayloadValue(values, [
    "latitude",
    "lat",
    "propertylatitude",
    "mlslatitude",
  ]), "latitude");
  const longitude = coordinate(firstPayloadValue(values, [
    "longitude",
    "lon",
    "lng",
    "propertylongitude",
    "mlslongitude",
  ]), "longitude");
  const hasCoordinates = latitude !== null && longitude !== null;
  return {
    address_hint: address,
    source_latitude: hasCoordinates ? latitude : null,
    source_longitude: hasCoordinates ? longitude : null,
    location_evidence_status: hasCoordinates
      ? "coordinate_ready"
      : address
        ? "address_ready"
        : "manual_review",
  };
}

export function normalizeSalesReconciliationUpdate(input = {}) {
  const accountId = validateSalesReconciliationAccountId(input.account_id);
  const linkedAccountId = input.linked_account_id == null
    ? null
    : validateSalesReconciliationAccountId(input.linked_account_id);
  return {
    accountId,
    linkedAccountId,
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
            'address', 'manual_verified'
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
            'concatenated_full_ids', 'unmatched', 'address_fallback',
            'manual_verified'
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

    ALTER TABLE app.sales_reconciliation_history
      ADD COLUMN IF NOT EXISTS verified_parcel_id text,
      ADD COLUMN IF NOT EXISTS verified_county text;

    UPDATE app.sales_reconciliation_history
    SET verified_parcel_id = verified_account_id
    WHERE verified_parcel_id IS NULL;

    ALTER TABLE app.sales_reconciliation_history
      ALTER COLUMN verified_parcel_id SET NOT NULL;

    CREATE TABLE IF NOT EXISTS app.county_account_identifiers (
      county                  text NOT NULL,
      normalized_account_id   text NOT NULL,
      native_account_id       text NOT NULL,
      account_id              text NOT NULL
                                REFERENCES core.accounts(account_id)
                                ON DELETE CASCADE,
      verification_source     text NOT NULL DEFAULT 'manual_sales_reconciliation',
      source_record_id        bigint
                                REFERENCES core.sales_source_records(id)
                                ON DELETE SET NULL,
      reviewer                text,
      verified_at             timestamptz NOT NULL DEFAULT now(),
      updated_at              timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (county, normalized_account_id)
    );

    CREATE INDEX IF NOT EXISTS county_account_identifiers_account_idx
      ON app.county_account_identifiers (account_id, county);

    CREATE INDEX IF NOT EXISTS sales_reconciliation_history_source_idx
      ON app.sales_reconciliation_history (source_record_id, verified_at DESC);

    CREATE TABLE IF NOT EXISTS app.sales_auto_reconciliation_history (
      id                    bigserial PRIMARY KEY,
      source_record_id      bigint NOT NULL
                                REFERENCES core.sales_source_records(id)
                                ON DELETE CASCADE,
      account_id            text NOT NULL
                                REFERENCES core.accounts(account_id),
      resolution_method     text NOT NULL CHECK (
                                resolution_method IN (
                                  'trusted_existing_link',
                                  'unique_exact_address'
                                )
                              ),
      address_key           text,
      city_key              text,
      previous_match_status text,
      raw_parcel_number     text,
      resolved_at           timestamptz NOT NULL DEFAULT now(),
      UNIQUE (source_record_id, resolution_method)
    );

    CREATE INDEX IF NOT EXISTS sales_auto_reconciliation_history_resolved_idx
      ON app.sales_auto_reconciliation_history (resolved_at DESC);
  `);
}

async function loadCanonicalAccount(queryable, requestedAccountId) {
  const { rows } = await queryable.query(
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
    [requestedAccountId],
  );
  return rows[0] || null;
}

/**
 * Resolve a reviewer-entered native county identifier to HomeNode's existing
 * account row. Collin imports historically omitted the leading R and/or
 * punctuation, so a normalized bridge is used while the verified native value
 * remains unchanged for audit and display purposes.
 */
export async function findAccountByCountyIdentifier(queryable, requestedAccountId) {
  const accountId = validateSalesReconciliationAccountId(requestedAccountId);
  const exact = await loadCanonicalAccount(queryable, accountId);
  if (exact) {
    validateSalesReconciliationAccountId(accountId, exact.county);
    return exact;
  }

  if (countyFromNativeAccountId(accountId) !== "COLLIN") return null;
  const normalizedKey = normalizedCountyAccountKey(accountId, "COLLIN");
  const aliasResult = await queryable.query(
    `
      SELECT account_id
      FROM app.county_account_identifiers
      WHERE county = 'COLLIN'
        AND normalized_account_id = $1
      LIMIT 2
    `,
    [normalizedKey],
  );
  if (aliasResult.rowCount > 1) throw new Error("ambiguous_collin_account_id");
  if (aliasResult.rowCount === 1) {
    const aliased = await loadCanonicalAccount(queryable, aliasResult.rows[0].account_id);
    if (aliased) return aliased;
  }

  const candidateResult = await queryable.query(
    `
      SELECT account_id
      FROM core.accounts
      WHERE county ILIKE '%collin%'
        AND REGEXP_REPLACE(
              UPPER(REGEXP_REPLACE(BTRIM(account_id), '^R', '', 'i')),
              '[^0-9A-Z]',
              '',
              'g'
            ) = $1
      ORDER BY account_id
      LIMIT 2
    `,
    [normalizedKey],
  );
  if (candidateResult.rowCount > 1) throw new Error("ambiguous_collin_account_id");
  if (!candidateResult.rowCount) return null;
  return loadCanonicalAccount(queryable, candidateResult.rows[0].account_id);
}

function identifiersMatch(verifiedAccountId, account, linkedAccountId = null) {
  const county = normalizedCounty(account?.county);
  // Collin's short numeric propID and authoritative R-prefixed geoID are
  // different key systems, not merely differently punctuated versions. A
  // reviewer-selected Collin account is therefore the deliberate bridge; the
  // verified geoID is persisted as the authoritative native identifier.
  if (county === "COLLIN" && linkedAccountId) return true;
  const verifiedKey = normalizedCountyAccountKey(verifiedAccountId, county);
  const candidates = [
    linkedAccountId,
    account?.requested_account_id,
    account?.account_id,
  ].filter(Boolean);
  return candidates.some(
    (candidate) => normalizedCountyAccountKey(candidate, county) === verifiedKey,
  );
}

async function saveCountyAccountIdentifier(
  queryable,
  { account, nativeAccountId, sourceRecordId, reviewer },
) {
  const county = normalizedCounty(account?.county);
  if (county !== "COLLIN") return;
  const normalizedAccountId = normalizedCountyAccountKey(nativeAccountId, county);
  const result = await queryable.query(
    `
      INSERT INTO app.county_account_identifiers (
        county, normalized_account_id, native_account_id, account_id,
        verification_source, source_record_id, reviewer
      ) VALUES ($1, $2, $3, $4, 'manual_sales_reconciliation', $5, $6)
      ON CONFLICT (county, normalized_account_id) DO UPDATE
      SET native_account_id = EXCLUDED.native_account_id,
          account_id = EXCLUDED.account_id,
          verification_source = EXCLUDED.verification_source,
          source_record_id = EXCLUDED.source_record_id,
          reviewer = EXCLUDED.reviewer,
          verified_at = now(),
          updated_at = now()
      WHERE app.county_account_identifiers.account_id = EXCLUDED.account_id
      RETURNING account_id
    `,
    [
      county,
      normalizedAccountId,
      nativeAccountId,
      account.account_id,
      sourceRecordId,
      reviewer,
    ],
  );
  if (!result.rowCount) throw new Error("county_account_identifier_conflict");
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
      ...salesSourceLocationEvidence(rawPayload),
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

    const account = update.linkedAccountId
      ? await loadCanonicalAccount(client, update.linkedAccountId)
      : await findAccountByCountyIdentifier(client, update.accountId);
    if (!account) throw new Error("account_not_found");
    validateSalesReconciliationAccountId(update.accountId, account.county);
    if (
      update.linkedAccountId &&
      !identifiersMatch(update.accountId, account, update.linkedAccountId)
    ) {
      throw new Error("account_identifier_mismatch");
    }

    await saveCountyAccountIdentifier(client, {
      account,
      nativeAccountId: update.accountId,
      sourceRecordId: id,
      reviewer: update.reviewer,
    });

    const parcelResult = await client.query(
      `
        UPDATE core.sale_parcels
        SET parcel_number_raw = $2,
            account_id = $3,
            parcel_number_normalized = $3,
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
      [id, update.accountId, account.account_id],
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
        [id, update.accountId, account.account_id],
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
          verified_account_id, verified_parcel_id, verified_county,
          notes, reviewer
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        id,
        source.listing_id,
        source.primary_account_id,
        account.account_id,
        update.accountId,
        normalizedCounty(account.county) || null,
        update.notes,
        update.reviewer,
      ],
    );
    await client.query("COMMIT");
    return {
      source_record: updatedSourceResult.rows[0],
      sale_id: saleResult.rows[0].id,
      account,
      verified_parcel_id: update.accountId,
      unresolved_parcel_count: unresolvedCount,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
