import "dotenv/config";
import pg from "pg";

import {
  ensureSalesReconciliationSchema,
  homeNodeCollinAccountIdFromPropertyId,
  normalizedCountyAccountKey,
} from "../src/services/salesReconciliation.js";

const DATASET_ID = process.env.COLLIN_CAD_APPRAISAL_DATASET_ID || "nne4-8riu";
const PAGE_SIZE = Math.min(
  Math.max(Number(process.env.COLLIN_CAD_SYNC_PAGE_SIZE || 10_000), 100),
  50_000,
);

function hasFlag(name) {
  return process.argv.includes(name);
}

function numericArgument(name) {
  const prefix = `${name}=`;
  const raw = process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

async function fetchPage(offset, limit) {
  const url = new URL(`https://data.texas.gov/resource/${DATASET_ID}.json`);
  url.searchParams.set("$select", "propid,geoid,situsconcat,propyear");
  url.searchParams.set("$where", "propid is not null and geoid is not null");
  url.searchParams.set("$order", "propid");
  url.searchParams.set("$limit", String(limit));
  url.searchParams.set("$offset", String(offset));
  const headers = {};
  if (process.env.SOCRATA_APP_TOKEN) {
    headers["X-App-Token"] = process.env.SOCRATA_APP_TOKEN;
  }
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`collin_cad_open_data_${response.status}`);
  }
  return response.json();
}

async function loadOfficialCrosswalk(maximumRows = null) {
  const byPropertyId = new Map();
  const geoIdOwners = new Map();
  const conflicts = [];
  let offset = 0;
  while (maximumRows == null || offset < maximumRows) {
    const limit = maximumRows == null
      ? PAGE_SIZE
      : Math.min(PAGE_SIZE, maximumRows - offset);
    const rows = await fetchPage(offset, limit);
    for (const row of rows) {
      const propertyId = String(row.propid || "").trim();
      const geoId = String(row.geoid || "").trim();
      if (!propertyId || !/^R/i.test(geoId)) continue;
      const normalizedGeoId = normalizedCountyAccountKey(geoId, "COLLIN");
      const existingGeoId = byPropertyId.get(propertyId)?.native_account_id;
      const existingPropertyId = geoIdOwners.get(normalizedGeoId);
      if (
        (existingGeoId && existingGeoId !== geoId) ||
        (existingPropertyId && existingPropertyId !== propertyId)
      ) {
        conflicts.push({ property_id: propertyId, geo_id: geoId });
        continue;
      }
      geoIdOwners.set(normalizedGeoId, propertyId);
      byPropertyId.set(propertyId, {
        property_id: propertyId,
        native_account_id: geoId,
        normalized_account_id: normalizedGeoId,
        situs_address: String(row.situsconcat || "").trim() || null,
        property_year: Number(row.propyear) || null,
      });
    }
    offset += rows.length;
    if (rows.length < limit) break;
  }
  return { rows: [...byPropertyId.values()], conflicts };
}

async function matchingHomeNodeAccounts(pool, crosswalk) {
  const accountIds = crosswalk
    .map((row) => homeNodeCollinAccountIdFromPropertyId(row.property_id))
    .filter(Boolean);
  const matched = new Set();
  for (let start = 0; start < accountIds.length; start += 10_000) {
    const { rows } = await pool.query(
      `
        SELECT account_id
        FROM core.accounts
        WHERE county ILIKE '%collin%'
          AND account_id = ANY($1::text[])
      `,
      [accountIds.slice(start, start + 10_000)],
    );
    for (const row of rows) matched.add(String(row.account_id));
  }
  return matched;
}

async function upsertCrosswalk(pool, crosswalk) {
  let written = 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let start = 0; start < crosswalk.length; start += 2_000) {
      const batch = crosswalk.slice(start, start + 2_000);
      const { rowCount } = await client.query(
        `
        INSERT INTO app.county_account_identifiers (
          county, normalized_account_id, native_account_id, account_id,
          verification_source, reviewer, verified_at, updated_at
        )
        SELECT
          'COLLIN', value.normalized_account_id, value.native_account_id,
          value.account_id, 'collin_cad_open_data',
          'Automated Collin CAD Open Data sync', now(), now()
        FROM JSONB_TO_RECORDSET($1::jsonb) AS value(
          account_id text,
          native_account_id text,
          normalized_account_id text
        )
        ON CONFLICT (county, normalized_account_id) DO UPDATE
        SET native_account_id = EXCLUDED.native_account_id,
            account_id = EXCLUDED.account_id,
            verification_source = EXCLUDED.verification_source,
            source_record_id = NULL,
            reviewer = EXCLUDED.reviewer,
            verified_at = now(),
            updated_at = now()
        WHERE app.county_account_identifiers.account_id = EXCLUDED.account_id
      `,
        [JSON.stringify(batch)],
      );
      if (rowCount !== batch.length) {
        throw new Error("collin_cad_existing_identifier_conflict");
      }
      written += rowCount;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return written;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const apply = hasFlag("--apply");
  const maximumRows = numericArgument("--limit");
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    application_name: "homenode-collin-account-id-sync",
  });
  try {
    await ensureSalesReconciliationSchema(pool);
    const official = await loadOfficialCrosswalk(maximumRows);
    if (official.conflicts.length) {
      throw new Error(`collin_cad_crosswalk_conflicts:${official.conflicts.length}`);
    }
    const matchedAccountIds = await matchingHomeNodeAccounts(pool, official.rows);
    const matchedRows = official.rows
      .map((row) => ({
        ...row,
        account_id: homeNodeCollinAccountIdFromPropertyId(row.property_id),
      }))
      .filter((row) => row.account_id && matchedAccountIds.has(row.account_id));
    const summary = {
      mode: apply ? "apply" : "dry_run",
      dataset_id: DATASET_ID,
      official_rows: official.rows.length,
      matched_homenode_accounts: matchedRows.length,
      official_rows_without_homenode_account: official.rows.length - matchedRows.length,
      written: apply ? await upsertCrosswalk(pool, matchedRows) : 0,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
