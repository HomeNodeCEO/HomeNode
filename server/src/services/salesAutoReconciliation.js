import {
  normalizePropertyAddress,
  normalizePropertyCity,
  normalizeSearchText,
} from "../util/propertySearch.js";
import {
  ensureSalesReconciliationSchema,
  salesSourceLocationEvidence,
} from "./salesReconciliation.js";
import {
  ensureAccountAddressAliasSchema,
  resolveUniqueAddressAliases,
} from "./accountAddressAliases.js";

const AUTO_MATCH_STATUSES = Object.freeze([
  "exact",
  "normalized",
  "secondary",
  "address",
]);

const SOURCE_CITY_HINTS = Object.freeze([
  "FARMERS BRANCH",
  "UNIVERSITY PARK",
  "HIGHLAND PARK",
  "DUNCANVILLE",
  "RICHARDSON",
  "LANCASTER",
  "COPPELL",
  "GARLAND",
  "IRVING",
  "ROWLETT",
  "WILMER",
  "DALLAS",
]);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function payloadValues(rawPayload) {
  const values = new Map();
  const visit = (record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return;
    for (const [key, value] of Object.entries(record)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        visit(value);
        continue;
      }
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (
        normalizedKey &&
        !values.has(normalizedKey) &&
        value !== null &&
        value !== undefined &&
        String(value).trim()
      ) {
        values.set(normalizedKey, String(value).trim());
      }
    }
  };
  visit(rawPayload);
  return values;
}

function firstValue(values, keys) {
  for (const key of keys) {
    const value = values.get(key);
    if (value) return value;
  }
  return null;
}

function normalizeCounty(value) {
  const normalized = normalizeSearchText(value);
  return normalized.replace(/\s+COUNTY$/, "").trim() || null;
}

function cityFromAddress(address) {
  const parts = String(address || "").split(",").map((part) => part.trim());
  return parts.length > 1 ? parts[1] : null;
}

function postalCode5(value) {
  return String(value || "").match(/\b\d{5}\b/)?.[0] || null;
}

export function cityHintFromSalesSource(sourceName, sourceFiles = []) {
  const evidence = normalizeSearchText([
    sourceName,
    ...(Array.isArray(sourceFiles) ? sourceFiles : []),
  ].filter(Boolean).join(" ")).replace(/[#/-]+/g, " ");
  return SOURCE_CITY_HINTS.find((city) =>
    new RegExp(`(^| )${city.replace(/ /g, " ")}( |$)`).test(evidence)
  ) || null;
}

export function salesAddressMatchEvidence(rawPayload, { fallbackCity = null } = {}) {
  const location = salesSourceLocationEvidence(rawPayload);
  const values = payloadValues(rawPayload);
  const addressHint = location.address_hint;
  const cityHint = firstValue(values, [
    "propertycity",
    "city",
    "municipality",
  ]) || cityFromAddress(addressHint) || fallbackCity;
  const countyHint = firstValue(values, [
    "countyorparish",
    "propertycounty",
    "county",
  ]);
  const postalHint = firstValue(values, [
    "postalcode",
    "propertypostalcode",
    "zipcode",
    "zip",
  ]) || addressHint;
  const addressKey = normalizePropertyAddress(
    String(addressHint || "").split(",", 1)[0],
  );
  const cityKey = normalizePropertyCity(cityHint);
  return {
    address_hint: addressHint,
    address_key: addressKey || null,
    city_key: cityKey || null,
    county_key: normalizeCounty(countyHint),
    postal_code5: postalCode5(postalHint),
  };
}

function resolutionRecord(row, method, evidence = {}) {
  return {
    source_record_id: Number(row.source_record_id),
    account_id: row.account_id || row.primary_account_id,
    resolution_method: method,
    previous_match_status: row.match_status,
    raw_parcel_number: row.parcel_number_raw || null,
    address_key: evidence.address_key || null,
    city_key: evidence.city_key || null,
    postal_code5: evidence.postal_code5 || null,
  };
}

async function loadTrustedExistingLinks(queryable, limit) {
  const { rows } = await queryable.query(
    `
      SELECT
        source.id AS source_record_id,
        source.primary_account_id,
        source.match_status,
        source.parcel_number_raw
      FROM core.sales_source_records source
      JOIN core.accounts account
        ON account.account_id = source.primary_account_id
      WHERE source.record_type = 'closed_sale'
        AND source.match_status = ANY($1::text[])
        AND source.primary_account_id IS NOT NULL
        AND source.has_unresolved_parcel = true
        AND COALESCE(source.has_multiple_parcel_numbers, false) = false
        AND COALESCE(source.multi_parcel_status, 'single') = 'single'
        AND NOT EXISTS (
          SELECT 1
          FROM core.sale_parcels parcel
          WHERE parcel.source_record_id = source.id
            AND parcel.is_resolved = true
            AND parcel.account_id IS DISTINCT FROM source.primary_account_id
        )
      ORDER BY source.id
      LIMIT $2
    `,
    [AUTO_MATCH_STATUSES, limit],
  );
  return rows.map((row) => resolutionRecord(row, "trusted_existing_link"));
}

async function loadUnmatchedAddressCandidates(queryable, limit) {
  const { rows } = await queryable.query(
    `
      SELECT
        source.id AS source_record_id,
        source.match_status,
        source.parcel_number_raw,
        source.raw_payload,
        source.source_name,
        source.source_files
      FROM core.sales_source_records source
      WHERE source.record_type = 'closed_sale'
        AND source.match_status = 'unmatched'
        AND source.primary_account_id IS NULL
        AND COALESCE(source.has_multiple_parcel_numbers, false) = false
        AND COALESCE(source.multi_parcel_status, 'single') = 'single'
      ORDER BY source.close_date DESC NULLS LAST, source.id
      LIMIT $1
    `,
    [Math.min(limit * 5, 10_000)],
  );
  return rows
    .map((row) => ({
      row,
      evidence: salesAddressMatchEvidence(row.raw_payload, {
        fallbackCity: cityHintFromSalesSource(row.source_name, row.source_files),
      }),
    }))
    .filter(({ evidence }) => evidence.address_key && evidence.city_key)
    .slice(0, limit);
}

async function resolveUniqueExactAddresses(queryable, candidates) {
  if (!candidates.length) return [];
  const requested = candidates.map(({ row, evidence }) => ({
    request_id: String(row.source_record_id),
    address_key: evidence.address_key,
    city_key: evidence.city_key,
    county_key: evidence.county_key,
    postal_code5: evidence.postal_code5,
  }));
  const matches = await resolveUniqueAddressAliases(queryable, requested);
  return candidates
    .filter(({ row }) => matches.has(String(row.source_record_id)))
    .map(({ row, evidence }) => resolutionRecord(
      { ...row, account_id: matches.get(String(row.source_record_id)) },
      "unique_exact_address",
      evidence,
    ));
}

async function applyResolutions(client, resolutions) {
  if (!resolutions.length) return 0;
  const lockResult = await client.query(
    `
      WITH requested AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS item(
          source_record_id bigint,
          account_id text
        )
      )
      SELECT source.id
      FROM core.sales_source_records source
      JOIN requested ON requested.source_record_id = source.id
      WHERE source.match_status <> 'manual_verified'
        AND (
          source.primary_account_id IS NULL
          OR source.primary_account_id = requested.account_id
        )
      FOR UPDATE OF source
    `,
    [JSON.stringify(resolutions)],
  );
  const eligibleIds = new Set(lockResult.rows.map((row) => String(row.id)));
  const eligible = resolutions.filter((row) =>
    eligibleIds.has(String(row.source_record_id))
  );
  if (!eligible.length) return 0;
  const serialized = JSON.stringify(eligible);
  await client.query(
    `
      WITH resolved AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS item(
          source_record_id bigint,
          account_id text,
          resolution_method text,
          previous_match_status text,
          raw_parcel_number text,
          address_key text,
          city_key text
        )
      )
      UPDATE core.sale_parcels parcel
      SET account_id = resolved.account_id,
          parcel_number_normalized = resolved.account_id,
          match_method = 'address_fallback',
          is_resolved = true
      FROM resolved
      WHERE parcel.source_record_id = resolved.source_record_id
        AND parcel.is_resolved = false
    `,
    [serialized],
  );
  await client.query(
    `
      WITH resolved AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS item(
          source_record_id bigint,
          account_id text,
          resolution_method text,
          previous_match_status text,
          raw_parcel_number text,
          address_key text,
          city_key text
        )
      )
      INSERT INTO core.sale_parcels (
        source_record_id, source_position, parcel_sequence, parcel_role,
        parcel_number_raw, parcel_number_normalized, account_id,
        match_method, is_resolved
      )
      SELECT
        resolved.source_record_id, 1, 1, 'primary',
        resolved.raw_parcel_number, resolved.account_id, resolved.account_id,
        'address_fallback', true
      FROM resolved
      WHERE NOT EXISTS (
        SELECT 1 FROM core.sale_parcels parcel
        WHERE parcel.source_record_id = resolved.source_record_id
      )
    `,
    [serialized],
  );
  const updated = await client.query(
    `
      WITH resolved AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS item(
          source_record_id bigint,
          account_id text,
          resolution_method text,
          previous_match_status text,
          raw_parcel_number text,
          address_key text,
          city_key text
        )
      ), remaining_flags AS (
        SELECT
          source.id,
          COALESCE(JSONB_AGG(flag) FILTER (
            WHERE flag NOT IN ('unresolved_parcel_number', 'ambiguous_address_match')
          ), '[]'::jsonb) AS flags
        FROM core.sales_source_records source
        JOIN resolved ON resolved.source_record_id = source.id
        LEFT JOIN LATERAL JSONB_ARRAY_ELEMENTS_TEXT(
          COALESCE(source.data_quality_flags, '[]'::jsonb)
        ) AS item(flag) ON true
        GROUP BY source.id
      )
      UPDATE core.sales_source_records source
      SET primary_account_id = resolved.account_id,
          match_status = CASE
            WHEN resolved.resolution_method = 'unique_exact_address' THEN 'address'
            ELSE source.match_status
          END,
          has_unresolved_parcel = false,
          data_quality_flags = remaining_flags.flags,
          requires_additional_review = JSONB_ARRAY_LENGTH(remaining_flags.flags) > 0,
          updated_at = now()
      FROM resolved
      JOIN remaining_flags ON remaining_flags.id = resolved.source_record_id
      WHERE source.id = resolved.source_record_id
        AND source.match_status <> 'manual_verified'
      RETURNING source.id
    `,
    [serialized],
  );
  await client.query(
    `
      WITH resolved AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS item(
          source_record_id bigint,
          account_id text,
          resolution_method text,
          previous_match_status text,
          raw_parcel_number text,
          address_key text,
          city_key text
        )
      )
      UPDATE core.sales sale
      SET account_id = resolved.account_id,
          address = COALESCE(account.address, sale.address),
          city = COALESCE(account.city, sale.city),
          zip = COALESCE(account.postal_code, sale.zip),
          loaded_at = now()
      FROM resolved
      JOIN core.accounts account ON account.account_id = resolved.account_id
      WHERE sale.source_record_id = resolved.source_record_id
    `,
    [serialized],
  );
  await client.query(
    `
      WITH resolved AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS item(
          source_record_id bigint,
          account_id text,
          resolution_method text,
          previous_match_status text,
          raw_parcel_number text,
          address_key text,
          city_key text
        )
      )
      INSERT INTO core.sales (
        account_id, address, city, state, zip, closing_date, sale_price,
        days_on_market, concessions, source, source_record_id
      )
      SELECT
        resolved.account_id, account.address, account.city, 'TX',
        account.postal_code, source.close_date, source.current_price,
        source.days_on_market,
        CASE WHEN source.seller_contributions IS NULL THEN NULL
             ELSE source.seller_contributions::text END,
        source.source_name, source.id
      FROM resolved
      JOIN core.sales_source_records source ON source.id = resolved.source_record_id
      JOIN core.accounts account ON account.account_id = resolved.account_id
      WHERE source.close_date IS NOT NULL
        AND source.current_price > 0
        AND NOT EXISTS (
          SELECT 1 FROM core.sales sale
          WHERE sale.source_record_id = source.id
        )
    `,
    [serialized],
  );
  await client.query(
    `
      WITH resolved AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS item(
          source_record_id bigint,
          account_id text,
          resolution_method text,
          previous_match_status text,
          raw_parcel_number text,
          address_key text,
          city_key text
        )
      )
      INSERT INTO app.sales_auto_reconciliation_history (
        source_record_id, account_id, resolution_method, address_key,
        city_key, previous_match_status, raw_parcel_number
      )
      SELECT
        source_record_id, account_id, resolution_method, address_key,
        city_key, previous_match_status, raw_parcel_number
      FROM resolved
      ON CONFLICT (source_record_id, resolution_method) DO NOTHING
    `,
    [serialized],
  );
  return Number(updated.rowCount || 0);
}

export async function auditSalesAutoReconciliation(pool, {
  batchSize = 500,
} = {}) {
  const safeBatchSize = boundedInteger(batchSize, 500, 1, 2_000);
  await ensureSalesReconciliationSchema(pool);
  await ensureAccountAddressAliasSchema(pool);
  const linked = await loadTrustedExistingLinks(pool, safeBatchSize);
  const candidates = await loadUnmatchedAddressCandidates(pool, safeBatchSize);
  const address = await resolveUniqueExactAddresses(pool, candidates);
  return {
    dry_run: true,
    trusted_existing_links: linked.length,
    unique_exact_addresses: address.length,
    inspected_unmatched_addresses: candidates.length,
    total_auto_resolvable: linked.length + address.length,
    sample: [...linked, ...address].slice(0, 25),
  };
}

export async function runSalesAutoReconciliationBatch(pool, {
  batchSize = 500,
  dryRun = false,
} = {}) {
  const safeBatchSize = boundedInteger(batchSize, 500, 1, 2_000);
  await ensureSalesReconciliationSchema(pool);
  await ensureAccountAddressAliasSchema(pool);
  const linked = await loadTrustedExistingLinks(pool, safeBatchSize);
  const candidates = await loadUnmatchedAddressCandidates(pool, safeBatchSize);
  const address = await resolveUniqueExactAddresses(pool, candidates);
  const resolutions = [...linked, ...address];
  if (dryRun || !resolutions.length) {
    return {
      dry_run: Boolean(dryRun),
      trusted_existing_links: linked.length,
      unique_exact_addresses: address.length,
      inspected_unmatched_addresses: candidates.length,
      resolved: 0,
      remaining_candidate_count: resolutions.length,
      sample: resolutions.slice(0, 25),
    };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const resolved = await applyResolutions(client, resolutions);
    await client.query("COMMIT");
    return {
      dry_run: false,
      trusted_existing_links: linked.length,
      unique_exact_addresses: address.length,
      inspected_unmatched_addresses: candidates.length,
      resolved,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

