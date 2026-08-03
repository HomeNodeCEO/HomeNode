import {
  assertNonDallasEnrichmentCounty,
  hasSourceValue,
  PROPERTY_ATTRIBUTE_KEYS,
  resolveNonDallasAttribute,
} from "../util/nonDallasEnrichment.js";

async function loadAccountInputs(pool, accountId) {
  const { rows } = await pool.query(
    `SELECT
       a.account_id,
       a.county,
       pi.bedroom_count AS bedrooms,
       pi.baths_full AS bathrooms_full,
       pi.baths_half AS bathrooms_half,
       COALESCE(pi.living_area_sqft, pi.total_living_area) AS living_area_sqft,
       pi.year_built,
       pi.fireplaces,
       pi.air_conditioning,
       pi.heating,
       pi.stories,
       pi.construction_type,
       pi.exterior_material,
       pi.pool,
       housing.attachment_type,
       housing.housing_type,
       housing.architectural_style,
       land.site_size_sqft,
       source.listing_key,
       source.listing_id
     FROM core.accounts a
     LEFT JOIN core.primary_improvements pi ON pi.account_id = a.account_id
     LEFT JOIN core.v_account_housing_profiles housing ON housing.account_id = a.account_id
     LEFT JOIN LATERAL (
       SELECT SUM(area_sqft)::numeric AS site_size_sqft
       FROM core.land_detail land
       WHERE land.account_id = a.account_id
         AND land.tax_year = (
           SELECT MAX(latest.tax_year) FROM core.land_detail latest
           WHERE latest.account_id = a.account_id
         )
     ) land ON TRUE
     LEFT JOIN LATERAL (
       SELECT listing_key, listing_id
       FROM core.sales_source_records source
       WHERE source.primary_account_id = a.account_id
         AND (source.listing_key IS NOT NULL OR source.listing_id IS NOT NULL)
       ORDER BY COALESCE(source.close_date, source.listing_contract_date) DESC NULLS LAST,
                source.updated_at DESC, source.id DESC
       LIMIT 1
     ) source ON TRUE
     WHERE a.account_id = $1`,
    [accountId],
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    accountId: row.account_id,
    county: assertNonDallasEnrichmentCounty(row.county),
    listingKey: row.listing_key,
    listingId: row.listing_id,
    cad: Object.fromEntries(
      PROPERTY_ATTRIBUTE_KEYS.map((key) => [key, row[key] ?? null]),
    ),
  };
}

async function loadManualValues(pool, accountId) {
  const { rows } = await pool.query(
    `SELECT attribute_key, attribute_value
     FROM app.property_attribute_manual_values
     WHERE account_id = $1`,
    [accountId],
  );
  return Object.fromEntries(rows.map((row) => [row.attribute_key, row.attribute_value]));
}

export async function enrichNonDallasAccount({ pool, trestleClient, accountId }) {
  const input = await loadAccountInputs(pool, accountId);
  if (!input) throw new Error("account_not_found");
  if (!input.listingKey && !input.listingId) throw new Error("trestle_listing_identifier_missing");
  const manual = await loadManualValues(pool, accountId);
  const trestleResult = await trestleClient.findProperty({
    listingKey: input.listingKey,
    listingId: input.listingId,
  });
  const trestle = trestleResult?.attributes || {};
  const sourceReference = String(
    trestleResult?.raw?.ListingKey || input.listingKey || input.listingId,
  );
  const client = await pool.connect();
  const resolved = {};
  try {
    await client.query("BEGIN");
    for (const key of PROPERTY_ATTRIBUTE_KEYS) {
      if (hasSourceValue(trestle[key])) {
        await client.query(
          `INSERT INTO app.property_attribute_observations (
             account_id, county, attribute_key, attribute_value, source_type,
             source_reference, source_observed_at, confidence, raw_payload
           ) VALUES ($1,$2,$3,$4::jsonb,'trestle',$5,$6,1.000,$7::jsonb)`,
          [
            accountId,
            input.county,
            key,
            JSON.stringify(trestle[key]),
            sourceReference,
            trestleResult?.raw?.ModificationTimestamp || null,
            JSON.stringify({
              ListingKey: trestleResult?.raw?.ListingKey || null,
              ListingId: trestleResult?.raw?.ListingId || input.listingId || null,
              OriginatingSystemName: trestleResult?.raw?.OriginatingSystemName || null,
            }),
          ],
        );
      }
      const resolution = resolveNonDallasAttribute({
        manual: manual[key],
        trestle: trestle[key],
        cad: input.cad[key],
      });
      resolved[key] = resolution;
      if (resolution.review_required) {
        await client.query(
          `INSERT INTO app.enrichment_review_queue (
             account_id, county, attribute_key, reason, evidence
           ) VALUES ($1,$2,$3,$4,$5::jsonb)
           ON CONFLICT (account_id, attribute_key) DO UPDATE SET
             county = EXCLUDED.county,
             reason = EXCLUDED.reason,
             status = 'pending',
             evidence = EXCLUDED.evidence,
             resolved_at = NULL,
             updated_at = now()`,
          [
            accountId,
            input.county,
            key,
            resolution.review_reason,
            JSON.stringify({ source_reference: sourceReference }),
          ],
        );
      } else {
        await client.query(
          `UPDATE app.enrichment_review_queue
           SET status = 'resolved', resolved_at = now(), updated_at = now()
           WHERE account_id = $1 AND attribute_key = $2 AND status = 'pending'`,
          [accountId, key],
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return { account_id: accountId, county: input.county, source_reference: sourceReference, resolved };
}

export async function listEnrichmentCandidates(pool, { county, limit = 25 }) {
  const normalizedCounty = assertNonDallasEnrichmentCounty(county);
  const boundedLimit = Math.min(200, Math.max(1, Number(limit) || 25));
  const { rows } = await pool.query(
    `SELECT a.account_id
     FROM core.accounts a
     WHERE UPPER(REGEXP_REPLACE(BTRIM(a.county), '\\s+COUNTY$', '', 'i')) = $1
       AND EXISTS (
         SELECT 1 FROM core.sales_source_records source
         WHERE source.primary_account_id = a.account_id
           AND (source.listing_key IS NOT NULL OR source.listing_id IS NOT NULL)
       )
     ORDER BY a.account_id
     LIMIT $2`,
    [normalizedCounty, boundedLimit],
  );
  return rows.map((row) => row.account_id);
}

